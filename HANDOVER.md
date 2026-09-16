# Handover — Giant

Written for whoever picks this project up next: a new Claude Code session, a new account, or
a person. It assumes nothing carried over. Everything an assistant was told over months of
work that is **not** recoverable from the code or `git log` is written down here.

Read [ONBOARDING.md](ONBOARDING.md) first for how the codebase works and how to get running.
This file is about the state of play and the working agreements.

Accurate as of **2026-09-16**.

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
  detail panel. Complete and tested, never merged.
- **`feature/pod-system`** — the full pod branch, including the team-member view that `main`
  gates off.
- **`pod-system-live`** — what was actually extracted to `main`. `pod-preview-backup` pins the
  full branch.

### Migrations written and deliberately NOT applied

Do not apply these casually and never via `supabase db push` — that would apply all three.

- `20260908120000_project_visibility` — three-level public/team/private projects, plus a
  read-only window for the in-house dev into private lists. **This is the one that closes the
  hole where every signed-in user can read every project and task.**
- `20260908140000_project_delete` — the delete fix.
- `20260915150000_clients_not_public` — **a security finding.** `clients_select_all` is
  `USING (true)`, so any signed-in account, *including client users*, can read every client
  row — names, status, MRR, contact email, Stripe customer id. Dry-run against production: a
  client account goes from 51 readable rows to 1; a team member is unaffected. Written at
  Nishchay's request to be reviewed before applying, and still waiting on that.

### Open questions nobody has answered

- **Pod payroll scope.** The board's payroll counts everyone with a base or an account,
  whether or not they are in a pod. It was read as a business-wide figure. If it should be
  per-pod, that is a small change nobody has asked for yet.
- **`version.json` says `20260902u1`** and has not been bumped since 2 September, though
  `main` has moved several times. The web app does not read it; the desktop app does.

## 3. Things to tidy

- **7 commits exist only on this laptop**, on three branches with no remote at all:
  `feature/chat3-management-panels` (3), `feature/sop-detail-view-and-recording` (2),
  `feature/sop-form-side-panel` (2). Push them as backup or accept the risk knowingly.
- **Adrien still has `push` access** to this private repo despite having left the team.
  Raised twice; not yet acted on.
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
