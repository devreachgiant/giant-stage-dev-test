# Getting set up on Giant

Giant is ReachGiant's internal app: chat, clients, projects, onboarding, billing, reporting.
It is a static frontend plus Netlify functions, backed by Supabase. This gets you running
locally and tells you the handful of things about this codebase that will otherwise bite you.

Read [README.md](README.md) first for the stack and the full environment-variable list. This
document is the rest — the parts that are not obvious from the code.

---

## 1. Get the code

```bash
git clone git@github.com:devreachgiant/giant-web-app.git
cd giant-web-app
git log --oneline -1
```

That last line should show a commit from within the last day or so.

**Do not download a tag or a ZIP.** The repo has tags called `v0.0.20` and `v0.0.21` that
look like the latest version and are not — they point at July, roughly 270 commits behind
`main`. There are no GitHub Releases. `main` is the only thing that is current; clone it.

If you ever suspect you are on something old:

```bash
git rev-parse --abbrev-ref HEAD   # should say: main
git fetch origin && git status    # should say: up to date with origin/main
```

`HEAD detached at v0.0.21` means you checked out a tag. `git checkout main && git pull`.

## 2. Environment

```bash
npm install -g netlify-cli
```

Create `.env` in the project root with the variables listed in the README. Ask Nishchay for
the values — they are live keys, including a Supabase **service role** key, which bypasses
every row-level security rule in the database. `.env` is gitignored. Never commit it, never
paste it into a chat, never put it in a screenshot.

```bash
netlify dev
```

The app serves at **http://localhost:8888**. Everything routes through `index.html` via
`_redirects`, so deep links like `/onboard/...` work locally too.

`config.js` holds the Supabase URL and the **anon** key. That one is public by design and is
already in the repo — it is safe in the browser because row-level security decides what it
can actually read. Do not "fix" it by moving it into `.env`.

## 3. The one thing to understand about this codebase

**The entire frontend is one file: `index.html`, around 86,000 lines, with a dozen inline
`<script>` blocks.** That is unusual, it is deliberate, and it shapes how you work here.

Each screen is a module inside its own script block, with a prefix on every id and class it
owns:

| Prefix | Module |
|---|---|
| `nc_` | Chat (the current one) |
| `c3` | Chat 3.0 internals |
| `p2_` | Projects 2.0 |
| `pods_` | Pod System |

**The prefix is not a style preference, it is the isolation boundary.** A bare `getElementById('clientName')`
from inside a module will find some other screen's element and silently operate on the wrong
screen. Two of the nastier bugs in this repo's history were exactly that.

### Editing rules

**Never replace a span of lines. Always anchor on exact text.**

Working in a file this large, the natural instinct is "replace lines 84200–84350". Do not.
Line numbers move under you, and a range that is off by a few silently deletes working code.
This has destroyed working functions here **four separate times** — each recovered from git,
each avoidable. Match on a unique string and replace that:

```python
old = "  function renderThing(){"
assert s.count(old) == 1        # if this fails, your anchor is not unique — find a better one
s = s.replace(old, new)
```

And if you do restructure something large, diff the function list against git before you
commit:

```bash
git show HEAD:index.html > /tmp/before.html
fnlist(){ grep -oE "^  (async )?function [a-zA-Z0-9_]+" "$1" | sort; }
comm -23 <(fnlist /tmp/before.html) <(fnlist index.html)    # anything printed here is LOST
```

**One edit at a time.** A script making five edits with five assertions, where the fourth
fails, leaves you with three applied and no error — silently half-done. Make one change,
verify, make the next.

## 4. Verify before you commit

Four checks. All four must pass. They take about ten minutes together, almost all of it the
last one.

```bash
python3 tools_newchat_parse.py        # every inline <script> parses
python3 tools_newchat_audit.py        # cross-screen leaks, dead references, scope errors
python3 tools_newchat_isolation.py    # the original Chat screen is untouched
node tools_newchat_clickthrough.mjs   # ~260 real browser checks against a mock Supabase
```

The click-through needs Playwright:

```bash
npm install -g playwright && npx playwright install chromium
```

It drives a real headless browser against `tools_newchat_mock_supabase.js` — no network, no
touching the real database. Expect roughly `260/260 checks passed`.

Why these exist, in one sentence each:

- **parse** — an unbalanced paren inside a module leaves the block count right, the audit
  clean, and the entire module dead at runtime.
- **audit** — catches a module reaching into another screen's DOM, which is the failure mode
  a single-file app invites.
- **isolation** — the original Chat screen is pinned to a known-good commit. If you changed
  it, that was either a mistake or a decision somebody should have made on purpose.
- **click-through** — the only one that proves a feature actually works when clicked.

**When you add a feature, add checks for it.** And make a check fail on purpose once before
you trust it. Several checks here have passed while measuring nothing at all: a hidden
element measured instead of the visible one, a cumulative count read as a delta, a selector
matching the button's own tooltip. A check that cannot fail is worse than no check, because
it is believed.

## 5. Branches and deploying

- Branch off `main`. Feature branches are safe to push — nothing deploys from them.
- **`main` deploys to production automatically** on push, via a GitHub Action that calls a
  Netlify build hook. Treat a push to `main` as "this is live for the whole company now."
- Ask before pushing to `main`.
- `screenshots/` is gitignored — design exports are large and change constantly. Keep them on
  disk, out of the repo.

Commit messages here explain **why**, in prose, not what changed. Look at `git log` before
writing your first one — the house style is a plain-English paragraph that would tell someone
in six months what problem this solved and what was rejected. It is worth matching.

## 6. Database

Supabase, with migrations in `supabase/migrations/`.

**Not every migration in that folder is applied, and they are not applied in order.** Some are
written and deliberately left pending. Check before assuming:

```bash
supabase migration list --linked
```

A row with a `local` version and an empty `remote` is not applied.

**Do not run `supabase db push`.** It applies every pending migration at once, including the
ones that were deliberately left alone. Apply one deliberately:

```bash
supabase db query --linked --file supabase/migrations/<the one you want>.sql
supabase migration repair --linked --status applied <version>
```

**Always dry-run against production first.** Wrap it in a transaction that rolls back, and
check the result — this is how every migration here has been verified before it was real:

```sql
begin;
\i supabase/migrations/20260915170000_pod_members.sql
select count(*) from public.pod_members;   -- only the LAST statement returns rows
rollback;
```

### Row-level security, the one rule that matters

**Policies are OR'd.** A single permissive `USING (true)` makes every other policy on that
table irrelevant, no matter how carefully written. `AS RESTRICTIVE` policies are AND'ed and
are how you actually narrow access.

And: **hiding a column in the page is not the same as not sending it.** Anyone can retype a
PostgREST query. If a number should not reach somebody, it must not be in the query, and the
database must refuse it independently. To check what a given role really sees, act as them in
a rolled-back transaction:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub":"<their profile id>","role":"authenticated"}';
select count(*) from public.clients;
```

## 7. Things that will waste your afternoon

- **`window.prompt` and `window.alert` do nothing in the desktop (Electron) build.** Use
  `window.giantPrompt(message, default)` and `window.giantConfirmWarn(title, body, label, tone)`.
  Both return promises.
- **`supabase db query` only returns rows from the last statement.** Collect intermediate
  results into a temp table and select from it at the end.
- **NULLs are distinct in unique indexes.** A unique index on `(client_id, service)` does not
  constrain rows where `client_id` is null at all.
- **`ON DELETE SET NULL` paired with a "exactly one of these is set" CHECK** makes the parent
  row undeletable, and the error names a table the user has never heard of. Twenty tasks were
  undeletable here for exactly this reason. Cascade instead.
- **"Run the app" is ambiguous** — there is a web build and a desktop build. Say which.

## 8. Where things stand right now

- **`main`** is live and current.
- **Pod System** is live but restricted to owner/manager/in-house-dev — a preview for Luke.
  Removing `data-role-min="manager"` from its nav item and screen opens it to everyone.
- **Projects 2.0 is live**, merged on 2026-09-22 and restricted to owner/manager/in-house-dev
  (`data-role-min="manager"` on its nav item and screen). It opens on the rebuilt screen; the
  Clone/Rebuild switch in the bottom-right corner still shows the old screen for comparison,
  and a choice already made wins over that default. `feature/projects-rework` is merged and
  kept only for history — earlier copies of this file said it must never be merged.
- **`feature/pod-system`** is the full pod branch including work not on `main`.
- Migration status, checked against production on 2026-09-22 with `supabase migration list --linked`:
  project visibility (`20260908120000`) **is applied**, and so are the task pipeline
  (`20260922130000`) and task delete (`20260922120000`, applied 2026-09-22 — a task belongs
  to whoever created it, plus owner/manager/in-house dev).
  Restricting `clients` so a client account reads only its own row was applied on 2026-09-16.
  The three `readonly_report.sql` files sharing versions with `20260826*` are queries, not
  migrations, and are never meant to apply — `migration list` shows them as pending forever.

## 9. How a release actually goes out

[HANDOVER.md](HANDOVER.md) has the full runbook — §4 shipping and verifying a deploy, §5
migrations, §6 messaging the team, §7 the traps. Read it before your first push. The short
version: branch off `origin/main`, all four checks green, ask before pushing, verify the
deploy against the live URL, bump `version.json` and add a changelog entry.

## 10. If you get stuck

`NEW_CHAT_HANDOFF.md` is the deepest written record of how the chat rebuild was done and why,
including a "Known, not fixed" list. It is long and it is honest.

Otherwise ask Nishchay. Asking early is cheaper than a day spent on a detail that was already
decided once.
