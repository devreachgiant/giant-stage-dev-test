# Handover — Giant

Written for whoever picks this project up next: a new Claude Code session, a new account, or
a person. It assumes nothing carried over. Everything an assistant was told over months of
work that is **not** recoverable from the code or `git log` is written down here.

Read [ONBOARDING.md](ONBOARDING.md) first for how the codebase works and how to get running.
This file is the rest: the state of play, the working agreements, and the method — what
access exists, how a release actually gets out and verified, how migrations are applied
safely, how the team gets told, and the small things that have each cost an afternoon.
Enough to do the job without being told any of it again.

Accurate as of **2026-09-21**.

---

## 1. Working agreements

These were established one at a time, usually after something went wrong. They are not
preferences to be re-derived — treat them as standing instructions.

**Ask before pushing. Every time.** Approval is per-push, not standing. Approval given
earlier in the same conversation does not carry to the next push. `main` deploys to
production on push, so a push is a release.

**Never post into Giant's own chat without explicit approval.** Not a release note, not a
Giant Bot message, nothing. Draft the exact text, show it, wait for a yes. Approval to ship
code is not approval to announce it. A posted message is seen company-wide immediately and
editing it afterwards leaves an "(edited)" marker on an announcement.

**Announcements never mention Old Chat.** Not as reassurance, not as "fixed there too", not
as a fallback. Fix bugs in Old Chat where it is cheap and right, and say so in the commit —
but leave it out of what the team reads. Pointing people back at the archived chat keeps it
alive in their heads as a place to work.

**"Run the app" is ambiguous — ask which.** There is a web app and an Electron desktop app,
developed in parallel. Never default silently to one.

**Always `git fetch origin` before branching or pushing.** A second developer works in this
repo. Branch off `origin/main`, not a possibly-stale local `main`.

**Match existing UI conventions.** Reuse the established classes — `.btn-red`, the
`.modal-overlay`/`.modal` pattern, the existing FAB. Never introduce ad-hoc styles; new
features should look native, not bolted on.

**Understand before building.** Restate the request and confirm scope before writing code,
rather than guessing at an ambiguity.

**Commit messages explain why, in prose.** Read `git log` before writing one. The house style
is plain English that tells someone in six months what problem this solved and what was
rejected — not a list of what changed.

### Two rules specific to this codebase

**Never edit `index.html` by line range.** Anchor on unique text, one edit at a time, verify
after each. Range replacement has silently destroyed working functions here four separate
times. ONBOARDING.md §3 has the method and the function-list diff that catches it.

**All four verification tools must pass before anything is called done.** Not three.

## 2. Where the project stands

### Live

`main` is deployed to production automatically on push, via a GitHub Action calling a Netlify
build hook (Netlify's own auto-deploy is gated on this site — see the workflow's comment).

**Pod System** — live as of 2026-09-15, restricted to owner, manager and in-house dev. It is
a preview for Luke, not a general release.

- Revert with `git revert -m 1 dd1f2ba` and push. Tested clean; leaves the database untouched.
- To open it to the whole team: remove `data-role-min="manager"` from its nav item and its
  screen. The specialist view — which shows a person only their own accounts and never
  fetches anybody else's money — is already built, checked, and enforced in RLS. It is only
  unreachable.
- Its module must stay in its **own `<script>` block**. Sharing New Chat's block makes
  `tools_newchat_audit.py` read it as part of New Chat, and it will fail.

### Not merged

- **`feature/projects-rework`** — the Projects 2.0 redesign. 28 commits. One task pool seen as
  table, board or timeline; time tracking on the table; resizable and sortable columns; a task
  detail panel.
  **Stays on the branch. Do not merge it.** Nishchay's call, 2026-09-16: the feature is not
  finished. An earlier version of this document called it "complete and tested" — that was
  wrong, and wrong in the direction that invites somebody to merge it. The checks passing is
  not the same as the feature being done, and only Nishchay decides which it is. Work on it
  when asked; leave it alone otherwise.
- **`feature/pod-system`** — the full pod branch, including the team-member view that `main`
  gates off.
- **`pod-system-live`** — what was actually extracted to `main`. `pod-preview-backup` pins the
  full branch.

### No known open security holes

The last one closed on 2026-09-21. `projects_all` was `USING (true)`, so every signed-in
account — **client accounts included** — could read every project and every task. Both
migrations are applied and on `main`:

- `20260908120000_project_visibility` — public / team / private, plus a read-only window
  for the in-house dev into private lists.
- `20260908140000_project_delete` — the delete fix that goes with it.

Measured in production after applying: a client account went from 10 projects and their
tasks to **zero**; a member sees the 2 shared lists and 321 of 544 tasks; the four
oversight accounts (Nishchay, Matthew, Luke, Kristina, via `profiles.can_see_all_projects`)
still see all 10 and all 544.

Checked before applying, and worth repeating if anything like it is done again: the only
person who lost sight of a task they were assigned was Adrien, who is deactivated and
banned. Everything else people lost was in projects they were not on.

Everything is backfilled to `team` except ReachGiant Master List and Master List, which
stay `public` because they are what the workspace reads together. Access is granted by
adding somebody to a project — the button exists on the Projects screen.

### Shipped 2026-09-18 (afternoon), all live on main

- **The realtime crash.** "Maximum call stack size exceeded" ended Luke's sessions for
  three days. The notifications channel handled CHANNEL_ERROR / TIMED_OUT / CLOSED by
  removing the channel — but removing a channel unsubscribes it, which leaves the topic,
  which supabase-js reports back through the *same* callback as CLOSED. So the removal
  asked for the removal. Guarded against re-entry; a regression check drives it.
  **The lesson worth keeping:** for a stack overflow the top frames are just where it ran
  out. Three reports showed three unrelated-looking traces and sent me down the wrong path
  twice. The error banner now reports the frame that REPEATS, the deepest frame that is
  ours, and the depth — that is what made it findable.
- **One address.** `giant.reachgiant.com` is canonical. The raw Netlify deploy URL
  redirects to it — in the page, on all four entry points, because Netlify does not honour
  a full-URL `from` against its own `*.netlify.app` subdomain (tried, measured, returns 200
  with no Location; see the note in netlify.toml). 23 shared links and two Netlify
  functions now build from the canonical origin instead of whatever host loaded the page.
  Auth and OAuth redirects are deliberately left dynamic — they must match what the
  provider has registered.
- **Internal links open in the app**, not a second copy of it in a new tab. External links,
  standalone pages (onboarding, meet, booking, share, public recordings) and modified
  clicks are deliberately untouched.
- **Nav**: the NEW badge is off Chat; Archive is `data-role-only="inhouse_dev"`. That
  attribute exists because `data-role-min` is a floor and an owner outranks the in-house
  dev. **Consequence to know: members and clients no longer have any route to Old Chat.**
- `version.json` is `20260918u1`.

### Shipped 2026-09-17/18, all live on main

- **Renewals** (Pod System tab): each client's next charge and last day, a red flag when a
  charge lands after the last day, and a tick recording who confirmed the Stripe payment was
  turned off. Dates are typed in — Stripe is not connected (`STRIPE_WEBHOOK_SECRET` unset, no
  client carries a `stripe_customer_id`, zero invoice rows), so nothing is cross-checked
  against it. The fields are shaped to be what Stripe would fill in later.
  Matthew was told by DM; WonderPark and Paul Davis still have no dates set.
- **DM naming**: `channels.name` on a DM names everyone except its creator, so it is right
  only for whoever opened the conversation. Needs you showed the viewer their own name as the
  person messaging them. Names are resolved per viewer from members now, in New Chat and Old
  Chat both; the two Old Chat changes are registered in the isolation check.
- `version.json` is `20260917u1`; the in-app changelog is at `0.0.25`. **These are two
  independent schemes** — the first is the desktop app's build stamp, the second the in-app
  Version & Changelog list. Both need bumping on a release.

### Recently closed

`20260915150000_clients_not_public` was applied on 2026-09-16. Until then any signed-in
account, **including client users**, could read every client row — names, status, MRR,
contact emails, Stripe customer ids — because `clients_select_all` was `USING (true)`. It is
now two policies: the team reads every client as before, a client account reads only the one
client its profile is linked to. Anonymous access was unaffected (the old policy was
`to authenticated`), and the public onboarding form was exercised end to end before and
after, since it runs through a SECURITY DEFINER function that never consulted the policy.

What this did **not** fix: `mrr_cents` is still readable by every team member, specialists
included. RLS is row-level and PostgREST talks to the database as a single `authenticated`
role for everybody, so hiding one column from one audience needs a view with the money left
out and the table closed behind it. Nobody has asked for that.

### Open questions nobody has answered

- **Pod payroll scope.** The board's payroll counts everyone with a base or an account,
  whether or not they are in a pod. It was read as a business-wide figure. If it should be
  per-pod, that is a small change nobody has asked for yet.
- **Nobody has set a renewal date yet** (0 clients). The feature cannot flag anything until
  the dates are in; Matthew was told by DM on the 17th and is sending them.
- **No reply to any Giant Bot DM**, from anyone. The bot account is unmonitored, so a reply
  would sit unread — worth knowing before sending anything that expects an answer.
- **The in-app changelog is at 0.0.27**, `version.json` at `20260918u1`. Two separate
  schemes; both need bumping on a release.

## 3. Access: what exists, and what it reaches

Everything below is on **this machine**, not tied to any account you log in with. A new
session here inherits all of it; a different laptop has none of it.

| What | Where it comes from | What it reaches |
|---|---|---|
| Supabase (Giant) | `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in `.env`, and the CLI link in `supabase/.temp/` | **Everything.** Queries run as `postgres`, which bypasses RLS entirely — every private DM, every client, every row |
| GitHub | `gh` CLI, and an SSH alias `github.com-giant` in `~/.ssh/config` | `devreachgiant/giant-web-app` and the other two repos |
| Netlify | `netlify` CLI | Local `netlify dev`. Reading the site's env vars needs an interactive login |
| Yunio | **nothing** | A separate Supabase project (`dmijxverypcas…`). Not linked, no codebase here. Do not go looking for its keys |

Nishchay alone holds these credentials — he did all the infrastructure setup — so
offboarding a person never needs a key rotation.

**There is no staging.** `supabase db query --linked` is production. Every migration and
every write lands on live data, which is why the dry-run below is not optional.

## 4. Shipping: the whole runbook

### Before you write anything

```bash
git fetch origin
git checkout -b feature/<name> origin/main      # branch off origin, never a stale local main
```

### Verify — all four, every time

```bash
python3 tools_newchat_parse.py        # every inline <script> parses
python3 tools_newchat_audit.py        # cross-screen leaks, dead references, scope errors
python3 tools_newchat_isolation.py    # the original Chat screen still matches its baseline
node tools_newchat_clickthrough.mjs   # ~210 real browser checks against a mock Supabase
```

The first three take seconds. The click-through takes **about nine minutes** — run it in the
background and do something else. Expect `210/210 checks passed` and `uncaught page errors (0)`.

Three habits that have each caught something real:

- **Add checks with the feature**, and **make one fail on purpose** before trusting it.
  Several here have passed while measuring nothing — a hidden element instead of the
  visible one, a cumulative count read as a delta, a selector matching a button's own
  tooltip, a test that set state directly and so never noticed the button was missing.
- **When a check fails, ask whether the check or the code is wrong.** Roughly half the
  failures in this repo have been checks asserting behaviour that was deliberately changed.
  Update them to the new rule; do not loosen them.
- **Diff the function list** after any large edit to `index.html`:
  ```bash
  git show HEAD:index.html > /tmp/before.html
  fnlist(){ grep -oE "^  (async )?function [a-zA-Z0-9_]+" "$1" | sort; }
  comm -23 <(fnlist /tmp/before.html) <(fnlist index.html)   # anything printed is LOST
  ```

### Push

**Ask first. Every time.** Approval is per-push and never carries over. A push to `main` is
a release to the whole company.

```bash
git push origin main
```

A GitHub Action calls a Netlify build hook — Netlify's own auto-deploy is gated on this
site, which is why the workflow exists. Feature branches deploy nothing and are safe.

### Verify the deploy — do not skip this

```bash
gh run list --repo devreachgiant/giant-web-app --workflow netlify-deploy.yml --limit 1 \
  --json conclusion,headSha
curl -s -o /tmp/live.html -w '%{http_code}\n' https://giant.reachgiant.com
wc -c /tmp/live.html index.html          # must match byte for byte
```

Then grep the served file for the thing you actually changed. A green deploy only means
the build ran. **Make the grep specific** — a loose pattern once matched other nav items
and reported a badge as still present when it had gone.

### Version, and the changelog

Two separate schemes. Both, on a release:

```bash
echo '{"version": "2026MMDDu1"}' > version.json     # the desktop app's build stamp
```

The in-app Version & Changelog list is a **database table**, not a file:

```sql
insert into public.changelog_entries (version, released_at, items, created_by)
values ('0.0.NN', current_date, jsonb_build_array('…', '…'),
        'a38ce649-d810-411d-8259-ecf47bef8884');
```

`version` is unique, and reading a truncated result once made me propose a number that
already existed. Get the real latest first:

```sql
select version from public.changelog_entries
 order by string_to_array(regexp_replace(version,'[^0-9.]','','g'),'.')::int[] desc limit 1;
```

**Draft the wording and confirm it before saving. Never add an entry silently.**

## 5. Migrations

**Never `supabase db push`.** It applies everything pending, including files left
deliberately unapplied.

```bash
# 1. dry run against production, rolled back
{ echo "begin;"; cat supabase/migrations/<file>.sql; echo "select …;"; echo "rollback;"; } > /tmp/dry.sql
supabase db query --linked --file /tmp/dry.sql

# 2. apply the one file
supabase db query --linked --file supabase/migrations/<file>.sql
supabase migration repair --linked --status applied <version>
```

**Act as a real user to check what a policy does.** Hiding a column in the page is not the
same as not sending it — anyone can retype a PostgREST query:

```sql
set local role authenticated;
set local request.jwt.claims = '{"sub":"<profile id>","role":"authenticated"}';
select count(*) from public.clients;
```

**Before any migration that RESTRICTS access, list who loses something they are using.**
This is the check that made the projects change safe, and without it the migration quietly
takes work off people's screens:

```sql
-- everyone holding a task in a soon-to-be-restricted project who is not its creator,
-- not a member, and not an oversight account
```

RLS facts that have each cost real time:

- **Policies are OR'd.** One permissive `USING (true)` makes every other policy on the
  table irrelevant. `AS RESTRICTIVE` is AND'ed and is how you actually narrow.
- **`deactivated_at` is a UI flag.** No policy consults it. Banning the Supabase auth user
  is what removes access.
- **NULLs are distinct in unique indexes** — a unique index on `(client_id, service)` does
  not constrain rows where `client_id` is null.
- **`ON DELETE SET NULL` + an "exactly one of these" CHECK** makes the parent undeletable,
  and the error names a table the user has never heard of. Cascade instead.

## 6. Messaging the team as Giant Bot

**Draft the exact text, show it, wait for a yes.** Approval to ship is not approval to
announce. A posted message cannot be unsent, and an edit leaves "(edited)" on a
company-wide announcement.

Bot profile id: `a38ce649-d810-411d-8259-ecf47bef8884`.

A DM has to be created the way the app creates one — `ensure_dm_channel` keys off
`auth.uid()` and there is no session here, so mirror it rather than inventing a second
convention:

```sql
do $$
DECLARE bot uuid := 'a38ce649-d810-411d-8259-ecf47bef8884';
        who uuid := '<recipient profile id>';
        pair text; ch uuid; bot_name text;
BEGIN
  pair := public.dm_pair_key(bot, who);
  SELECT id INTO ch FROM public.channels WHERE dm_pair = pair LIMIT 1;
  IF ch IS NULL THEN
    SELECT COALESCE(full_name, email) INTO bot_name FROM public.profiles WHERE id = bot;
    INSERT INTO public.channels (name, slug, is_private, is_dm, dm_pair, created_by)
    VALUES (bot_name, 'dm-' || substring(pair,1,12) || '-' || substring(md5(random()::text),1,5),
            true, true, pair, bot) RETURNING id INTO ch;
  END IF;
  INSERT INTO public.channel_members (channel_id, profile_id) VALUES (ch, bot) ON CONFLICT DO NOTHING;
  INSERT INTO public.channel_members (channel_id, profile_id) VALUES (ch, who) ON CONFLICT DO NOTHING;
  INSERT INTO public.messages (channel_id, author_id, body) VALUES (ch, bot, '…');
END $$;
```

**Nobody monitors the bot account.** A reply sits unread forever. If an answer is wanted,
say to reply to a person, not to the bot.

Reading what the bot has sent, and anything sent back — Nishchay cannot see these in the
app, because DMs are private channels and he is not a member:

```sql
select p.full_name, m.created_at, m.body
  from public.messages m
  join public.channels c on c.id = m.channel_id
  join public.channel_members cm on cm.channel_id = c.id and cm.profile_id <> m.author_id
  join public.profiles p on p.id = cm.profile_id
 where m.author_id = 'a38ce649-d810-411d-8259-ecf47bef8884' and c.is_dm
 order by m.created_at desc;
```

## 7. Small things that cost an afternoon each

- **`supabase db query` returns rows from the LAST statement only.** Collect into a temp
  table and select from it at the end. If you then `set local role authenticated`, the temp
  table needs `grant insert, select on <table> to authenticated` first.
- **`\set` and other psql meta-commands do not work** through `db query`. Inline the values.
- **`window.prompt` and `window.alert` do nothing in the Electron desktop build.** Use
  `window.giantPrompt(message, default)` and
  `window.giantConfirmWarn(title, body, label, tone)`; both return promises.
- **Old Chat is pinned.** Editing it fails `tools_newchat_isolation.py` unless the change is
  registered in that file's `ALLOWED` list. Each entry's `before` must occur exactly once —
  anchor it to a line start with a leading `\n`, or a ten-space pattern will also match
  inside a twelve-space line.
- **Old and New Chat contain byte-identical code in places.** A `replace()` with
  `count == 1` can still land in the wrong module. Check which line number it hit.
- **A stack overflow's top frames are meaningless** — they are where the stack ran out.
  Report the frame that REPEATS. Three days were lost to this.
- **Links that get shared must use `window.GIANT_ORIGIN`**, never `window.location.origin`.
  Auth and OAuth redirects are the exception and stay dynamic.
- **`screenshots/` is gitignored** and must stay that way; the exports are large.
- **"Run the app" is ambiguous** — web or desktop. Ask.

## 8. Things to tidy

- Every branch's work is on the remote as of 2026-09-18; nothing exists only on this laptop.
- Adrien is fully offboarded: removed from GitHub, profile deactivated, auth user banned.
  **Note for the next person who leaves:** no RLS policy consults `deactivated_at`, so
  deactivating a profile removes nothing. Banning the Supabase auth user is the step that
  actually cuts access. Both are needed.
- Nishchay alone holds the Supabase/Netlify/`.env` credentials, so offboarding never needs a
  key rotation.
- The repo has **48 branches** and tags (`v0.0.20`, `v0.0.21`) that look current and point at
  July. See ONBOARDING.md §1 — this already cost a new developer a confusing first clone.

## 9. Where the knowledge lives

- **[ONBOARDING.md](ONBOARDING.md)** — how the codebase works, how to run it, the editing
  rules, the four checks, the database workflow, the traps.
- **[NEW_CHAT_HANDOFF.md](NEW_CHAT_HANDOFF.md)** — the deepest written record in this repo:
  how the chat rebuild was done and why, including a "Known, not fixed" list.
- **[README.md](README.md)** — stack and environment variables.
- **`git log`** — the commit messages are long on purpose and carry most of the reasoning.

There is also assistant memory at
`~/.claude/projects/-Users-nischaypandya-Desktop-AI-Projects-giant/memory/`. It is on disk and
keyed by project path, so it should survive an account change — but do not rely on it. Every
standing instruction it holds is reproduced in §1 above, which is why §1 exists.

## 10. The shape of the work, if it helps

A pattern worth knowing: on this project the reported symptom has usually had a deeper cause
than the report suggested, and fixing the symptom would have been wrong.

"Jumping to a message after search is not accurate" was a 1000-message ceiling. Inbox cards
saying "Someone" was an unfilled profile cache. "Filter is not working" was markup with no
listener behind it. "I can't resize columns" was a 9px invisible target that passed every
automated check. "The team tab is hard to manage" was that *who is in a pod* had never been
written down anywhere.

Look for that before building what was literally asked for — and say what you found.
