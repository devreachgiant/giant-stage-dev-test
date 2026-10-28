# Giant — working rules

ReachGiant's internal app. Read this before touching anything. [ONBOARDING.md](ONBOARDING.md)
has setup and environment; this file is how to *work* here without breaking something.

---

## 0. More than one person works on this. Start by syncing.

**Every session, before you write a line:**

```bash
git checkout main && git pull origin main
git checkout -b <type>/<short-name>      # branch off the main you just pulled
```

**Every time you finish something:** commit it and push the branch. Work that exists only on
one laptop is work that can disappear. Push the branch even if it is not ready to merge —
branches do not deploy, so pushing one is free.

**Before editing a file you did not just read in this session, read it again.** Somebody else
may have changed it since. `index.html` is one 90,000-line file that everybody edits; it is the
single most likely place for two people to collide.

If `git pull` gives you a conflict in `index.html`, stop and get a human. A bad merge there has
previously interleaved two `<script>` blocks into something that parsed and ran wrong.

---

## 1. What this codebase is

- **One file.** `index.html`, ~90k lines, 14 inline `<script>` blocks, ~31 screens. No build
  step, no bundler, no framework. What you edit is what ships.
- **Netlify functions** in `netlify/functions/` for anything needing a secret.
- **Supabase** for database, auth, storage and realtime.
- Modules are kept apart by **id and class prefix**, not by files: `nc_` (Chat), `c3`, `p2_`
  (Projects 2.0), `pods_`. Treat a prefix as a wall.

### The duplication trap

Chat exists twice: the old one (~line 45000, now the **Archive** screen, visible only to
in-house dev) and New Chat (~line 73000+). **Many functions, ids and even whole markup blocks
appear in both, byte-identical.**

A `grep` that finds two hits and a replace that assumes one will edit the wrong chat, silently.
Before any replace, count:

```bash
grep -c 'the exact text' index.html
```

If the count is 2, find something that differs nearby, or locate the New Chat copy by position
(index of the second occurrence) rather than by text.

---

## 2. Editing `index.html`

- **Never edit by line number or line range.** The file shifts constantly.
- Anchor on **unique surrounding text**. One edit at a time. Verify after each.
- If you are scripting an edit, assert the match count first and let it fail loudly:

```python
assert s.count(old) == 1, s.count(old)
```

- A multi-replacement script should write the file **once at the end**, so a failed assertion
  leaves the file untouched rather than half-edited.
- Watch range-based replacements: a start/end pair can silently swallow a function that sits
  between them.

---

## 3. Verify before you commit

```bash
python3 tools_newchat_parse.py          # syntax of all 14 script blocks     ~1s
python3 tools_newchat_audit.py          # cross-screen id leaks             ~7s
python3 tools_newchat_isolation.py      # old chat vs New Chat separation   <1s
node tools_newchat_clickthrough.mjs     # ~355 checks, drives a real browser ~3m
node tools_growth_check.mjs             # ~218 checks, Growth only          ~2m
```

**The first three are eight seconds together. Never skip them.**

**The clickthrough is the expensive one, and it is the only check that would notice you
breaking a screen you were not working on.** Run it:

- before any push to `main`;
- whenever a change touches shared code — `window.giant*`, anything without a module
  prefix, or a file outside the module you are in;
- when you have changed a screen the module checks do not cover.

Skip it while iterating on one module's CSS and copy, and lean on that module's own check
instead. That is the common case: skipped twenty times a day, run once. The module checks
only cover their own screens, so they cannot tell you that Chat still works.

The clickthrough serves the repo, replaces supabase-js with
`tools_newchat_mock_supabase.js`, and clicks through the app. It is the only one that opens a
page.

One clickthrough check fails on `main` and has for some time —
`a Needs you row lands on the message that put it there`. 354/355 is the clean result; a
different number is yours.

**The first three can all be clean on a visibly broken screen.** None of them renders anything.
If you changed something a person looks at, look at it — screenshot it or drive it — before
saying it works.

### Add a check for what you fixed

A bug that had no check is a bug that comes back. When you fix something, add a check that
fails on the old behaviour. Then make sure it *would* have failed: a check that passes against
the bug is worse than no check, because it is reassuring.

Real examples from this repo:
- A check asserted a colour dot *existed*. It existed the whole time, at `0px` wide. Assert the
  measurement, not the presence.
- A check set a flag on the **database row** while the code read an **in-memory cache**. It
  measured nothing and passed.
- A check proved a collapse worked by counting rows. Collapsing hides the container; the rows
  stay in the DOM. Count what is *visible*.

---

## 4. The database

**There is no staging. `supabase db query --linked` is production.**

- **Never run `supabase db push`.**
- Migrations live in `supabase/migrations/` and are applied **by hand**. A committed migration
  file has not necessarily run. Check before assuming.
- Dry-run every write inside a transaction you roll back:

```sql
begin;
  -- the change
  -- then SELECT something that proves it did what you meant
rollback;
```

- Make the dry run prove the *outcome*, not just that it ran. `0 rows` is ambiguous — it can
  mean "blocked correctly" or "there was nothing there". Seed a row and measure both sides.

### RLS refuses by returning zero rows, not by erroring

This is the single most common source of silent bugs here.

```js
// WRONG — reports success when RLS refused
await sb.from('messages').update({ ... }).eq('id', id);

// RIGHT
const { data, error } = await sb.from('messages').update({ ... }).eq('id', id).select('id');
if (error) { /* real error */ }
if (!data || !data.length) { /* refused — tell the user */ }
```

Every insert/update/delete needs `.select()` and a zero-rows branch. Bugs shipped from this
exact omission: task delete (3 paths), client field saves, channel rename, and attachments not
copying on forward.

### Check the policy before writing the code

If an insert has a `WITH CHECK`, your insert must satisfy it. `message_attachments` requires
`uploader_id = auth.uid()`; omitting it made every forwarded attachment silently vanish.

```sql
select polname, polcmd, pg_get_expr(polqual, polrelid), pg_get_expr(polwithcheck, polrelid)
  from pg_policy p join pg_class c on c.oid = p.polrelid
 where c.relname = 'your_table';
```

### Views

A view without `security_invoker` runs as its **owner** and bypasses RLS entirely. Five views
here once exposed every client row to anonymous callers, writable. If you add a view:
`alter view ... set (security_invoker = true);` and revoke `anon`.

---

## 5. Shipping

1. Branch off freshly-pulled `main`.
2. All four checks green.
3. **Ask before pushing to `main`.** A push to `main` is live for the whole company —
   it auto-deploys via Netlify. Approval is per-push and never carries over.
4. Bump `version.json` (format `YYYYMMDDuN`).
5. Verify the deploy **against the live URL**, not the build log:

```bash
curl -s https://giant.reachgiant.com/version.json
curl -s https://giant.reachgiant.com/ | grep -c 'something your change added'
```

6. Changelog lives in the `changelog_entries` table, not in a file. Add an entry for anything
   user-visible.

### Two push modes, and Nishchay picks per push

- **Silent** — merge, version bump, nothing announced.
- **With notification** — the same, plus a Giant Bot post in `#giant-app`. **Draft the exact
  wording and wait for approval before posting.** Never post to the app's chat unprompted.

---

## 6. Secrets

- `.env` holds a Supabase **service-role key**. Never commit it, paste it into chat, or put it
  in a screenshot.
- `config.js` holds the **publishable** key. That one is public by design — which is exactly
  why RLS has to be right.
- **Yunio** is a different Supabase project. Do not go looking for its keys.

---

## 7. Things that waste an afternoon

- `window.prompt`, `window.alert` and `window.confirm` are **no-ops in the desktop (Electron)
  build**. Use `window.giantPrompt` / `window.giantConfirmWarn`. A `confirm()` guard means the
  action silently does nothing for desktop users.
- `new Date('2026-10-01')` is **UTC midnight** — the previous day for anyone west of
  Greenwich. Parse plain `yyyy-mm-dd` by hand for dates.
- The HTML `download` attribute is **ignored cross-origin**. Supabase storage needs
  `?download=<name>` to send `Content-Disposition`.
- Browsers block **multiple downloads** not inside the original click gesture. One zip beats
  N downloads.
- Setting `el.style.display = ''` **deletes** an inline display, it does not reset it. This
  silently turned flex containers into blocks and made child elements collapse to zero width.
- Inline styles beat any stylesheet rule, however specific. If a CSS change "does nothing",
  check whether JS sets it inline.
- `clientWidth` **includes** the element's own padding.
- Work hung off a nav-item click handler breaks on reload. Several screens had this. Use a
  `MutationObserver` on the screen's `class`, and note screens use `.on`, not `.active`.

---

## 8. Commit messages

Prose explaining **why**, what was rejected, and what was measured — not a list of changed
files. Read `git log` before writing your first one; matching the house style matters here.
Include real numbers when you have them (row counts from a dry run, check counts, measured
values). End with the attribution line your tooling specifies.

---

## 9. Where things stand

- `main` is live and current.
- **Projects 2.0**, **Pod System** and the **Archive** (old Chat) are gated to
  owner / manager / inhouse_dev.
- Unmerged and worth knowing about: `feature/project-columns` (custom columns for Projects
  2.0 — green, never tested against real data) and `feature/meetings-turn-screenshare`
  (needs `TURN_KEY_ID` / `TURN_API_TOKEN` in Netlify before it is useful).
- There are ~60 old local branches. Most are dead. Do not assume a branch name means it is
  live.
