# Where Soop lives, and how to move the front end

## Where you are right now

Soop is two separate things in two separate places, and only one of them moves.

| | what it is | where it lives now | moving? |
| --- | --- | --- | --- |
| **Front end** | this repo. HTML, CSS, JS. No build step, no server, no Node. | **GitHub Pages**, `https://ubhayaab.github.io/soop/`, served straight off the `main` branch | **yes** |
| **Back end** | Postgres, sign-in, realtime, file storage, Edge Functions | **Supabase**, project `ybddogqphinruyunnuwx` | **no. Nothing to do.** |

Supabase is already a hosted platform run by somebody else. It has nothing to do
with GitHub Pages and it does not care where the front end is served from. You
will not touch it during the move.

## Why the front end has to move

One reason, and it is narrow but it is real.

Soop is becoming embeddable, which means it will run inside an iframe on other
people's dashboards. The browser needs to be told **which pages are allowed to
put Soop in a frame**. There is exactly one way to say that: a response header
called `Content-Security-Policy: frame-ancestors`.

GitHub Pages cannot send custom response headers. At all. There is no setting, no
file, no workaround. And the header is deliberately **ignored** when you try to
put it in a `<meta>` tag, so the usual static-site trick does not apply either.

Without it, any page on the internet can load a logged-in Soop in an invisible
iframe and steer somebody's clicks into it. There is a script-level refusal in
`js/embed.js` that catches this, and it works, but it is script running inside
the frame. The header stops the frame from being drawn at all. You want both.

Cloudflare Pages, Netlify and Vercel all send headers from a plain text file with
no build step. The recommendation is Cloudflare Pages for two reasons: the free
tier has no bandwidth cap, and custom domains are trivial, which matters for the
second thing below.

### The bonus reason: same-site framing

If your dashboard is at `dash.jarurat.care` and Soop is at `soop.pages.dev`,
those are different **sites**, and every browser now partitions storage between
them. It works, but the panel gets its own isolated storage per dashboard and
Safari wipes it between launches.

If Soop is at `soop.jarurat.care` instead, it is the **same site** as the
dashboard, and that entire class of problem disappears. That is a custom domain,
which is a DNS record, which is why it is worth having Cloudflare in the picture.
You do not have to do it on day one.

---

## The move, step by step

Budget fifteen minutes. Nothing is destructive and the GitHub Pages site keeps
working the whole time.

### 1. Push what is in your working tree

Cloudflare deploys from GitHub, so it can only deploy what is on GitHub.

```bash
git add -A
git commit -m "Plugin mode, task intake, forecasting, security fixes"
git push
```

### 2. Create the Cloudflare Pages project

1. Sign up or log in at **dash.cloudflare.com**. Free account is enough.
2. Left sidebar: **Compute (Workers & Pages)**.
3. Button: **Create** -> tab **Pages** -> **Connect to Git**.
4. Authorise Cloudflare on GitHub. When it asks which repositories, you can pick
   **Only select repositories** and choose just `soop`.
5. Pick the `soop` repository. **Begin setup**.

### 3. The build settings (this is the part people get wrong)

This repo has **no build step**. The files in it are already the website. So:

| field | value |
| --- | --- |
| Project name | `soop` (this becomes `soop.pages.dev`) |
| Production branch | `main` |
| Framework preset | **None** |
| Build command | **leave completely empty** |
| Build output directory | `/` |
| Root directory | `/` |

If you pick a framework preset it will try to run `npm install` and fail, because
there is no `package.json`. There is nothing to install and nothing to build.

Press **Save and Deploy**. It takes about thirty seconds.

### 4. Check it worked

Open `https://soop.pages.dev` (or whatever name it gave you).

You should see the Soop sign-in card. Sign in with your normal account. It talks
to the same Supabase, the same messages, the same everything, because the back
end did not move.

Then check the header actually arrived. In the browser, press F12 -> **Network**
tab -> reload -> click the top row (`soop.pages.dev`) -> **Headers**. Under
Response Headers you should see:

```
content-security-policy: frame-ancestors 'self' http://localhost:8098 ...
referrer-policy: strict-origin-when-cross-origin
x-content-type-options: nosniff
```

If those are there, the whole reason for the move is done. The `_headers` file in
this repo is what produces them.

### 5. Tell Supabase about the new address

Not strictly required today, but it will bite later if you skip it.

Supabase dashboard -> your project -> **Authentication** -> **URL Configuration**:

- **Site URL**: `https://soop.pages.dev`
- **Redirect URLs**: add `https://soop.pages.dev/**`

Keep the old `https://ubhayaab.github.io/soop/**` in the list until you are sure
nobody is using the old address.

### 6. A custom domain (optional, do it when you have a domain)

In the Pages project -> **Custom domains** -> **Set up a custom domain** ->
type `soop.jarurat.care` (or whatever). Cloudflare will tell you the DNS record.
If the domain's DNS is already at Cloudflare, it adds it for you in one click.

Then update `Site URL` in Supabase, and `SOOP_APP_ORIGIN` in the Edge Function
secrets (step 3 of the checklist below).

---

## The two loose ends after the move

### Old links keep pointing at GitHub Pages

Every invite link you have already sent looks like
`https://ubhayaab.github.io/soop/#/join/<token>`. Those keep working as long as
GitHub Pages stays up, and they break the moment you turn it off.

Also, anybody who added Soop to their home screen installed it from that address.
Their PWA points at GitHub Pages, has its own service worker, and will happily go
on serving the old code forever.

Three choices, in increasing order of effort:

1. **Nobody real is using it yet.** Turn Pages off: GitHub repo -> Settings ->
   Pages -> Source -> **None**. Old links 404, everyone uses the new address.
2. **Leave both up.** They both work, both talk to the same back end. Fine for a
   while. The risk is that the two versions drift, because GitHub Pages deploys
   on push and so does Cloudflare, so actually they will not drift at all. This
   is the lazy option and it is not bad.
3. **Redirect the old one.** Replace `index.html` on a `gh-pages` branch with a
   one-line redirect to the new address. Ask me and I will write it.

Say which and I will do it.

### The `_headers` file needs your real dashboard origins

Open `_headers` and find the line marked `>>> EDIT THIS LINE`. Every dashboard
that will embed Soop needs its origin listed there, **and** in `EMBED_ORIGINS` in
`js/config.js`, **and** in the `allowed_origins` column when you register it.

Three lists on purpose. They fail differently, which is how you tell which one
you forgot:

| missing from | what you see |
| --- | --- |
| `_headers` | blank panel; browser refuses to draw the frame |
| `js/config.js` | panel loads, spins 15 seconds, then asks for a password |
| `allowed_origins` | the Edge Function log says `origin not registered` |

---

## The back-end checklist (separate from the move)

None of this is affected by where the front end lives. It is the work that makes
credential passthrough and the new task features actually function. It has
**never been run against your live project**, so go carefully.

### 1. Check the table names before running anything

The migrations were written by reading the client code, because the database
schema is not in this repository. Run this first in the Supabase SQL editor:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('organizations','workspaces','workspace_members','channels','tasks');
```

You should get five rows. If any name differs, tell me and I will correct the
migrations rather than you editing SQL you did not write.

### 2. Run the migrations

Supabase dashboard -> **SQL Editor** -> paste and run, one at a time:

- `supabase/migrations/0100_embed_registry.sql` - the dashboard registry and the
  one call that makes a team's server exist
- `supabase/migrations/0101_tasks_v2.sql` - progress log, blockers, triage,
  started_at, priority

Both are written to be safe to run twice.

### 3. Deploy the Edge Functions

```bash
supabase login
supabase link --project-ref ybddogqphinruyunnuwx

supabase secrets set SOOP_APP_ORIGIN='https://soop.pages.dev'
supabase functions deploy soop-handoff --no-verify-jwt
```

`--no-verify-jwt` is required and is not a hole: the whole point of that function
is that the caller does not have a Supabase login yet. An HMAC signature is what
authenticates it.

Jira is optional and only if you actually use Jira:

```bash
supabase secrets set JIRA_BASE_URL='https://yourcompany.atlassian.net'
supabase secrets set JIRA_EMAIL='you@yourcompany.com'
supabase secrets set JIRA_API_TOKEN='<from id.atlassian.com/manage/api-tokens>'
supabase functions deploy soop-jira
```

### 4. One edit to a function that is not in this repo

`list_tasks` lives in your database, not here. For the new task columns to reach
the client, add these to its select list:

```sql
started_at, priority, origin, due_precision, due_string,
task_category(state, done_at) as category
```

Everything degrades gracefully without this - the forecast falls back to
`created_at`, the priority glyph does not draw - so it is not urgent, but the
numbers get better with it.

### 5. Revoke the old demo token

`js/config.js` used to export a live open-invite token for a 1770-member Space,
served to every visitor. The export is gone, but the value is in git history and
in every copy of that file ever served, so it has to be revoked server-side.
Rotating it does not help for the same reason.

### 6. Register your first dashboard

Only once you actually have a dashboard to embed into:

```sql
select * from public.register_embed_host(
  'tech-dashboard', 'Tech dashboard', '<your org uuid>', 'Tech',
  array['https://dash.jarurat.care']);
```

It prints a secret **once**. Put it in the Edge Function and in the dashboard's
backend:

```bash
supabase secrets set EMBED_SECRET_TECH_DASHBOARD='<the secret>'
```

The rest of that flow, including the ten lines the dashboard's backend needs, is
in `EMBED.md`.
