# Handover — Giant

Written for whoever picks this project up next: a new Claude Code session, a new account, or
a person. It assumes nothing carried over. Everything an assistant was told over months of
work that is **not** recoverable from the code or `git log` is written down here.

Read [ONBOARDING.md](ONBOARDING.md) first for how the codebase works and how to get running.
This file is about the state of play and the working agreements.

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

### The one open security hole

**Every signed-in user can read every project and every task.** `projects_all` on
public.projects is `USING (true)`, and RLS policies are OR'd, so the sensible member-based
policies sitting beside it are irrelevant. Verified still open on 2026-09-18.

The fix is written and dry-run clean — but **it is not on `main`**, so
`supabase migration list` run from `main` reports nothing pending and a new session would
never learn it exists. Both files live on `feature/pod-system`:

- `20260908120000_project_visibility` — three-level public/team/private projects, plus a
  read-only window for the in-house dev into private lists. This is the one that closes it.
- `20260908140000_project_delete` — the delete fix that goes with it.

To see them: `git show feature/pod-system:supabase/migrations/20260908120000_project_visibility.sql`

Not applied because it changes who can see what across the whole Projects screen, and that
was Nishchay's call to make rather than a tidy-up. It is the last known open item.

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
- **The in-app changelog is at 0.0.25** and does not cover the 18th's work. Drafted and
  offered; no wording confirmed, so nothing was saved — entries are never added silently.
- **Nobody has set a renewal date yet** (0 clients). The feature cannot flag anything until
  Matthew fills WonderPark and Paul Davis in; he was told by DM on the 17th.
- **No reply to any Giant Bot DM**, from anyone. The bot account is unmonitored, so a reply
  would sit unread — worth knowing before sending anything that expects an answer.

## 3. Things to tidy

- Every branch's work is on the remote as of 2026-09-18; nothing exists only on this laptop.
- Adrien is fully offboarded: removed from GitHub, profile deactivated, auth user banned.
  **Note for the next person who leaves:** no RLS policy consults `deactivated_at`, so
  deactivating a profile removes nothing. Banning the Supabase auth user is the step that
  actually cuts access. Both are needed.
- Nishchay alone holds the Supabase/Netlify/`.env` credentials, so offboarding never needs a
  key rotation.
- The repo has **48 branches** and tags (`v0.0.20`, `v0.0.21`) that look current and point at
  July. See ONBOARDING.md §1 — this already cost a new developer a confusing first clone.

## 4. Where the knowledge lives

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

## 5. The shape of the work, if it helps

A pattern worth knowing: on this project the reported symptom has usually had a deeper cause
than the report suggested, and fixing the symptom would have been wrong.

"Jumping to a message after search is not accurate" was a 1000-message ceiling. Inbox cards
saying "Someone" was an unfilled profile cache. "Filter is not working" was markup with no
listener behind it. "I can't resize columns" was a 9px invisible target that passed every
automated check. "The team tab is hard to manage" was that *who is in a pod* had never been
written down anywhere.

Look for that before building what was literally asked for — and say what you found.
