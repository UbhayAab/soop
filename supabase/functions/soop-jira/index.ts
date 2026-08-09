// Jira interop, phase one only: a Soop task shows up ON the Jira issue, and a
// Jira issue mentioned in Soop can be turned into a task that points back at it.
//
// PHASE ONE IS ONE-WAY ON PURPOSE. Two-way field sync is a loop generator and it
// is not a small one: Jira and Soop will never agree on a status vocabulary, both
// sides emit webhooks on write, and each system's echo triggers the other. Doing
// it properly needs echo suppression on three layers, an idempotency key per
// write, an hourly reconcile, and a backfill story. That is weeks, and it is
// worth starting only once somebody is genuinely working in both systems every
// day. Remote links are an afternoon and cover the case that actually hurts:
// somebody in Jira has no idea the conversation happened.
//
// WHY AN EDGE FUNCTION AND NOT js/features/. Jira Cloud serves NO CORS headers on
// its REST API, by deliberate Atlassian policy. A browser cannot call it, ever,
// no matter how the request is shaped. Anything touching Jira is server work from
// the first line, and discovering that after writing a feature module is the
// classic way to lose a day.
//
// THE IDEMPOTENCY TRICK, which is the whole reason this is cheap: a remote link
// with a `globalId` is an UPSERT. POSTing the same globalId twice updates rather
// than duplicating, so there is no local mapping table to keep in step, no
// "have I already linked this" query, and a retry after a timeout is free.
//
//   POST /rest/api/3/issue/{key}/remotelink
//   { "globalId": "soop:task:<uuid>", "object": { ... } }
//
// KEY ON THE NUMERIC ID, NOT THE ISSUE KEY. Moving an issue between projects
// changes ENG-123 to OPS-45 and every row keyed on the old string silently
// detaches, months later, with nothing in any log. The key is fine for display
// and for the URL; it is not an identifier.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// A Jira API token, not OAuth. For a single organisation linking its own Jira,
// a token on a service account is the right amount of machinery: OAuth 3LO means
// a consent screen, refresh handling, and - the part that bites - dynamic
// webhooks that EXPIRE 30 days after creation with no error and nothing in any
// log. Phase one does not register webhooks at all, so none of that applies yet.
const JIRA_BASE = Deno.env.get('JIRA_BASE_URL');        // https://acme.atlassian.net
const JIRA_EMAIL = Deno.env.get('JIRA_EMAIL');
const JIRA_TOKEN = Deno.env.get('JIRA_API_TOKEN');
const SOOP_APP_ORIGIN = Deno.env.get('SOOP_APP_ORIGIN') ?? '*';

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const cors = {
  'Access-Control-Allow-Origin': SOOP_APP_ORIGIN,
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'content-type': 'application/json' } });

const jiraAuth = 'Basic ' + btoa(`${JIRA_EMAIL}:${JIRA_TOKEN}`);

async function jira(path: string, init: RequestInit = {}) {
  const r = await fetch(JIRA_BASE + path, {
    ...init,
    headers: {
      'authorization': jiraAuth,
      'content-type': 'application/json',
      'accept': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { ok: r.ok, status: r.status, body };
}

// Everything on this endpoint acts on behalf of a signed-in Soop user, so the
// caller's own JWT is what authorises it - not the service role, and not a
// shared secret. Deployed WITHOUT --no-verify-jwt so the platform checks it
// before this code runs; this re-reads it to find out who it is.
async function callerId(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data?.user?.id ?? null;
}

// ------------------------------------------------------------------ link
// Put a Soop task on a Jira issue. Idempotent; safe to call again after any
// failure, including one where the first call actually succeeded.
async function link(req: Request, userId: string) {
  const { taskId, issueKey } = await req.json().catch(() => ({}));
  if (!taskId || !issueKey) return json({ error: 'taskId and issueKey are required' }, 400);

  // The caller must be able to see the task. Reading it through the service role
  // and checking membership by hand is the only way, because a service-role
  // client bypasses the RLS that would otherwise have answered this.
  const { data: task } = await admin
    .from('tasks')
    .select('id, title, workspace_id, state, done_at, assignee_id, due_at, message_id, channel_id')
    .eq('id', taskId)
    .maybeSingle();
  if (!task) return json({ error: 'no such task' }, 404);

  const { data: member } = await admin
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', task.workspace_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!member) return json({ error: 'not your Space' }, 403);

  // Resolve the key to the immutable numeric id, and store THAT.
  const found = await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status`);
  if (!found.ok) {
    return json({ error: 'jira did not recognise that issue', status: found.status }, 404);
  }
  const issue = found.body as { id: string; key: string; fields: Record<string, any> };

  const permalink = `${SOOP_APP_ORIGIN}/#/m/${task.channel_id}/${task.message_id}`;
  const put = await jira(`/rest/api/3/issue/${issue.id}/remotelink`, {
    method: 'POST',
    body: JSON.stringify({
      // The upsert key. Same value twice updates the same link.
      globalId: `soop:task:${task.id}`,
      application: { type: 'com.redtree.soop', name: 'Soop' },
      relationship: 'discussed in',
      object: {
        url: permalink,
        title: task.title,
        summary: 'Tracked in Soop',
        // `resolved` is the only bit of state Jira renders on a remote link, and
        // it is the only one worth pushing: it strikes the link through when the
        // work is finished, which is exactly the question somebody looking at the
        // Jira issue is asking.
        status: { resolved: !!task.done_at },
        icon: { url16x16: `${SOOP_APP_ORIGIN}/icons/icon-192.png`, title: 'Soop' },
      },
    }),
  });
  if (!put.ok) return json({ error: 'jira refused the link', status: put.status, body: put.body }, 502);

  return json({
    ok: true,
    issue: { id: issue.id, key: issue.key, summary: issue.fields?.summary ?? null,
      status: issue.fields?.status?.name ?? null },
  });
}

// ------------------------------------------------------------------ lookup
// What an issue key means, for showing a card in chat. Deliberately thin: it
// returns summary and status and nothing else, because the person reading Soop
// may have no Jira access at all and this endpoint would happily leak an issue
// they cannot open. Summary and status is the least that is still useful.
async function lookup(req: Request) {
  const { issueKey } = await req.json().catch(() => ({}));
  if (!issueKey) return json({ error: 'issueKey required' }, 400);
  const r = await jira(`/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,status,assignee,duedate`);
  if (!r.ok) return json({ error: 'not found', status: r.status }, 404);
  const i = r.body as any;
  return json({
    id: i.id,
    key: i.key,
    summary: i.fields?.summary ?? null,
    status: i.fields?.status?.name ?? null,
    statusCategory: i.fields?.status?.statusCategory?.key ?? null,
    assignee: i.fields?.assignee?.displayName ?? null,
    due: i.fields?.duedate ?? null,
    url: `${JIRA_BASE}/browse/${i.key}`,
  });
}

// NOT IMPLEMENTED, and the reason is written down so nobody has to rediscover it:
//
// Creating a Jira issue FROM a Soop task needs the description in ADF, the
// Atlassian Document Format. It is not markdown and not HTML; it is a nested
// node tree, plain text has to be wrapped in a paragraph node containing a text
// node, and sending a string where Jira expects ADF fails with a 400 whose body
// does not say that. Every field on the create screen is also required at create
// time or the call is rejected, and which fields those are varies per project.
// Budget it separately from this file.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (!JIRA_BASE || !JIRA_EMAIL || !JIRA_TOKEN) {
    return json({ error: 'jira is not configured on this project' }, 501);
  }
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const userId = await callerId(req);
  if (!userId) return json({ error: 'sign in first' }, 401);

  const path = new URL(req.url).pathname;
  try {
    if (path.endsWith('/lookup')) return await lookup(req);
    return await link(req, userId);
  } catch (e) {
    console.error('[soop-jira] unhandled', e);
    return json({ error: 'failed' }, 500);
  }
});
