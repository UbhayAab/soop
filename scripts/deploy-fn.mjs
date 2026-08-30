// Deploy an edge function to Supabase via the Management API (no CLI needed).
// Usage: node scripts/deploy-fn.mjs <function-name>
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const name = process.argv[2];
if (!name) { console.error('usage: node scripts/deploy-fn.mjs <fn-name>'); process.exit(1); }

const env = Object.fromEntries(
  readFileSync('C:/Users/abhay/Desktop/claude/hearth/.env.local', 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
const REF = env.SUPABASE_PROJECT_REF, TOKEN = env.SUPABASE_ACCESS_TOKEN;

const dir = `supabase/functions/${name}`;
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (!f.endsWith('.md')) files.push(p);
  }
};
walk(dir);

const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({
  entrypoint_path: 'index.ts',
  name,
  // dek-app is deliberately open: a cron job on a factory PC has no Supabase JWT,
  // and the function is its own security boundary via private.app_ctx.
  verify_jwt: !['soop-handoff', 'dek-app'].includes(name),
})], { type: 'application/json' }), 'metadata.json');
for (const p of files) {
  form.append('file', new Blob([readFileSync(p)]), p.replaceAll('\\', '/').split(`functions/${name}/`)[1]);
}

// The slug MUST be in the query string. Without it the API mints a UUID slug and
// still answers 200, so the deploy "succeeds" and the function is unreachable at
// the name you deployed it under. That had already happened to an earlier deploy
// here, which is why a function with a UUID for a name is sitting in the project.
const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions/deploy?slug=${encodeURIComponent(name)}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
const text = await r.text();
console.log(r.ok ? `DEPLOYED ${name}` : `FAILED ${r.status}: ${text.slice(0, 400)}`);
