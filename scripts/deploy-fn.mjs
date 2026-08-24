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
  verify_jwt: name !== 'soop-handoff',
})], { type: 'application/json' }), 'metadata.json');
for (const p of files) {
  form.append('file', new Blob([readFileSync(p)]), p.replaceAll('\\', '/').split(`functions/${name}/`)[1]);
}

const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions/deploy`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  body: form,
});
const text = await r.text();
console.log(r.ok ? `DEPLOYED ${name}` : `FAILED ${r.status}: ${text.slice(0, 400)}`);
