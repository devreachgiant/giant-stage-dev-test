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

### Say who you are, before your first commit

The GitHub account is shared across the team. That is deliberate, and it means `git log`
cannot tell who wrote what unless you set it yourself. Do this once, in the repo, before
you commit anything:

```bash
git config user.name "Your Name"
git config user.email "you@reachgiant.com"
git config user.name    # check it took
```

Repo-local on purpose (no `--global`), so it cannot leak into your own projects. It costs
ten seconds and it is the only thing that makes `git blame` worth running here. A commit
authored by the shared account tells whoever is debugging at 2am precisely nothing.

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

### Put new work in its own `<script>` block

The single biggest cost of more than one developer here is that **almost every commit
touches `index.html`** — 152 of the last 153 did, in a file of 109,000 lines. Two people
editing the middle of it at once is how you get a merge conflict in a file where a bad
merge once interleaved two `<script>` blocks into something that parsed and ran wrong.

So: a new feature is a new `<style>` block and a new `<script>` block **appended at the
end**, with its own id and class prefix, injecting whatever markup it needs at runtime.
Workshop is the worked example — about 3,400 lines added that way, and when it merged it
produced no conflict in `index.html` at all.

Editing existing code is of course still necessary. Just do not grow a feature by
inserting it into the middle of somebody else's screen.

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

**The first three take eight seconds together. Never skip them.**

```bash
python3 tools_newchat_parse.py        # every inline <script> parses          ~1s
python3 tools_newchat_audit.py        # cross-screen leaks, scope errors      ~7s
python3 tools_newchat_isolation.py    # the original Chat screen is untouched <1s
```

Then the suite for whatever you touched. These need no browser and no network — they
replace `fetch` and drive the function directly, so they see things no screen can show:

```bash
node tools_growth_check.mjs             # Growth, the biggest one              ~3m
node tools_growth_zoom_check.mjs        # the Zoom connector
node tools_growth_calendly_check.mjs    # the Calendly sync
node tools_growth_gmail_check.mjs       # mail -> deal matching
node tools_workshop_ahrefs_check.mjs    # the Ahrefs connector
node tools_workshop_connect_check.mjs   # per-client connectors
```

And the expensive one, which is the only check that notices you breaking a screen you
were not working on:

```bash
node tools_newchat_clickthrough.mjs     # ~410 checks, a real browser          ~6m
```

Run the click-through before any push to `main`, whenever you touch shared code
(`window.giant*`, anything without a module prefix), and when you have changed a screen
the module suites do not cover. Skip it while iterating on one module's CSS and lean on
that module's own suite instead — that is the common case.

**One click-through check fails on `main` and has for months:**
`a Needs you row lands on the message that put it there`. So **409/410 is the clean
result**. A different number is yours. Do not spend your first afternoon on that one.

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

**More than one person works on this now. Pull before you branch, and push what you finish.**

```bash
git checkout main && git pull origin main
git checkout -b fix/the-thing
```

Push your branch as soon as you have something, even if it is not ready to merge — branches do
not deploy, so pushing one costs nothing, and work that only exists on your laptop can vanish.
Before editing a file you did not read this session, read it again: `index.html` is one file
that everybody edits, and it is where two people collide.

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

> Updated 2026-11-14. This section ages fast — trust `git log` over it.

- **`main`** is live, current, and safe to branch from. It auto-deploys: a push to `main`
  is in front of the whole company within a couple of minutes. There is no staging site.
- **Nothing verifies a push.** The one GitHub workflow triggers the Netlify deploy and runs
  no checks at all. The suites in §4 are run by hand, by whoever is pushing. That is you.
- Gated to owner / manager / in-house dev: **Projects 2.0**, **Pod System**, and the
  **Archive** screen (the old Chat, in-house dev only).
- **Workshop** — a second workspace beside Operations, for SEO and AI search work. On
  `feature/workshop-tab`, not merged, and gated to in-house dev only while it is built.
  Roughly 5,600 lines. Its Ahrefs connector is live in production; its WordPress and
  Calendly connectors are built and wired but no client credential has been stored yet.
- **Growth** is the sales pipeline, live and in daily use. Recently: call transcripts on a
  deal, summaries written automatically as a transcript arrives, dictation in the notes,
  and a fix to the address outgoing mail is sent as.
- There are around **100 branches**, local and remote. Most are dead. A branch name is not
  evidence that anything is live — check `git log origin/main..<branch>` before believing one.
- **Migrations are applied by hand.** A file in `supabase/migrations/` has not necessarily
  run, and one that has run may have no file. This is the one place a second developer can
  silently diverge from production. Ask before you apply anything.
- **There is no staging database.** `supabase db query --linked` is production, for
  everybody, always. Dry-run every write inside a transaction you roll back, and make the
  dry run prove the outcome rather than just that it ran.

## 9. How a release actually goes out

[HANDOVER.md](HANDOVER.md) has the full runbook — §4 shipping and verifying a deploy, §5
migrations, §6 messaging the team, §7 the traps. Read it before your first push. The short
version: branch off `origin/main`, all four checks green, ask before pushing, verify the
deploy against the live URL, bump `version.json` and add a changelog entry.

## 10. If you use Claude Code

[CLAUDE.md](CLAUDE.md) is loaded automatically at the start of every Claude Code session in
this repo. It is the operating guide: the editing rules for a 90,000-line single file, the four
checks that must pass, how migrations are applied by hand against production, and the traps
that have each cost a day here at least once. Worth reading yourself, not just letting the
model read it.

## 11. If you get stuck

`NEW_CHAT_HANDOFF.md` is the deepest written record of how the chat rebuild was done and why,
including a "Known, not fixed" list. It is long and it is honest.

Otherwise ask Nishchay. Asking early is cheaper than a day spent on a detail that was already
decided once.
