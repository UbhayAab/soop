// The Dek app platform's public surface.
//
// WHY THIS EXISTS: the only thing an app author should need is a token and one
// URL. A Task Scheduler job on a dispatch PC in Bhiwandi has no Supabase JWT and
// no apikey, and making it carry both is the difference between forty lines of
// Python and a support call. So this function sets verify_jwt = false and is its
// own security boundary: it does nothing at all before private.app_ctx returns.
//
//   POST /dek-app/messages  { channel, text, thread?, client_msg_id?, attachments? }
//   POST /dek-app/tasks     { channel, title, assignee?, due? }
//   GET  /dek-app/whoami
//   Authorization: Bearer dek_at_...
//
// Every error body is written to be read by a person who is stuck, because the
// product this replaces answered a wrong header with nothing at all. Nothing
// here ever logs the token, not even its hint.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_BODY = 64 * 1024;

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body, null, 2) + '\n', {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });
}

// A malformed Authorization header is the single most common first failure, so
// the answer names the header and shows one line that works.
const HEADER_HELP = {
  error: 'missing_token',
  message: 'This call needs an app token in the Authorization header.',
  example: 'Authorization: Bearer dek_at_xxxxxxxx',
  where_to_get_one: 'Dek -> Organisation settings -> Apps -> your app -> Create token',
};

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

// Postgres speaks in errcodes; an app author needs an HTTP status and a sentence.
function mapError(msg: string) {
  if (msg.startsWith('invalid_app_token')) {
    return {
      status: 401,
      body: {
        error: 'invalid_app_token',
        message:
          'That token is not valid. It may have been revoked, rotated past its grace period, ' +
          'or the app may have been uninstalled from this Space.',
      },
    };
  }
  if (msg.startsWith('app_scope_denied')) {
    const scope = msg.split(':').slice(1).join(':').trim();
    return {
      status: 403,
      body: {
        error: 'app_scope_denied',
        missing_scope: scope,
        message: `This token cannot do that. Tick "${scope}" on the app's install screen in Dek and try again.`,
      },
    };
  }
  if (msg.startsWith('channel_not_available')) {
    return {
      status: 404,
      body: {
        error: 'channel_not_available',
        message:
          'No channel by that name is available to this app. Either it does not exist in this ' +
          'Space, or the app was not given access to it. Call /whoami to list the channels it can use.',
      },
    };
  }
  if (msg.startsWith('assignee_not_found')) {
    return {
      status: 404,
      body: {
        error: 'assignee_not_found',
        message: `${msg}. Use the person's Dek username or their email address.`,
      },
    };
  }
  if (msg.startsWith('empty_body') || msg.startsWith('empty_title')) {
    return { status: 400, body: { error: 'empty', message: 'The message text cannot be empty.' } };
  }
  if (msg.startsWith('body_too_long') || msg.startsWith('title_too_long')) {
    return { status: 400, body: { error: 'too_long', message: 'That text is too long for one message.' } };
  }
  if (msg.startsWith('channel_archived')) {
    return { status: 409, body: { error: 'channel_archived', message: 'That channel is archived.' } };
  }
  if (msg.includes('rate') || msg.includes('too_many')) {
    return { status: 429, body: { error: 'rate_limited', message: 'Too many calls. Slow down and retry.' } };
  }
  return { status: 400, body: { error: 'request_failed', message: msg } };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get('content-length') || '0');
  if (len > MAX_BODY) throw new Error('body_too_large');
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new Error('body_too_large');
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v as Record<string, unknown> : {};
  } catch {
    throw new Error('bad_json');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const path = new URL(req.url).pathname.replace(/^\/dek-app\/?/, '').replace(/\/+$/, '');
  const token = bearer(req);
  if (!token) return json(401, HEADER_HELP);

  try {
    if (path === 'whoami') {
      const { data, error } = await db.rpc('app_whoami', { p_token: token });
      if (error) throw new Error(error.message);
      return json(200, data);
    }

    if (req.method !== 'POST') {
      return json(405, {
        error: 'method_not_allowed',
        message: `Use POST for /${path}.`,
      });
    }

    const body = await readBody(req);

    if (path === 'messages') {
      const { data, error } = await db.rpc('app_post_message', {
        p_token: token,
        p_channel: String(body.channel ?? ''),
        p_text: String(body.text ?? ''),
        p_thread: body.thread ?? null,
        p_client_msg_id: body.client_msg_id ?? null,
        p_attachments: body.attachments ?? [],
      });
      if (error) throw new Error(error.message);
      // A permalink so the author's own script can log something clickable.
      return json(200, {
        ok: true,
        message_id: data.message_id,
        channel_id: data.channel_id,
        permalink: `https://dek-7o4.pages.dev/#/c/${data.channel_id}/${data.message_id}`,
      });
    }

    if (path === 'tasks') {
      const { data, error } = await db.rpc('app_create_task', {
        p_token: token,
        p_channel: String(body.channel ?? ''),
        p_title: String(body.title ?? ''),
        p_assignee: body.assignee ?? null,
        p_due: body.due ?? null,
      });
      if (error) throw new Error(error.message);
      return json(200, {
        ok: true,
        task_id: data.task_id,
        message_id: data.message_id,
        channel_id: data.channel_id,
        assignee_id: data.assignee_id,
        permalink: `https://dek-7o4.pages.dev/#/c/${data.channel_id}/${data.message_id}`,
      });
    }

    return json(404, {
      error: 'no_such_endpoint',
      message: `There is no /${path} here.`,
      endpoints: ['POST /dek-app/messages', 'POST /dek-app/tasks', 'GET /dek-app/whoami'],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'body_too_large') {
      return json(413, { error: 'body_too_large', message: 'Request bodies are capped at 64 KB.' });
    }
    if (msg === 'bad_json') {
      return json(400, { error: 'bad_json', message: 'The request body is not valid JSON.' });
    }
    const { status, body } = mapError(msg);
    return json(status, body);
  }
});
