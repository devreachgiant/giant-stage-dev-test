# New Chat — handoff

Branch: `feature/new-chat-from-chat3` · **nothing pushed**, by decision — the branch
stays local. `git rev-list --count main..HEAD` for the commit count.

To resume in a new conversation, see `RESUME_NEW_CHAT.md`.

## What this is

Old **Chat & Huddles** duplicated as **New Chat** and converted to the approved Chat 3.0
design, running on old chat's real data (10,363 messages). Old chat is untouched and stays
usable; New Chat is manager/owner/inhouse_dev only for now.

Decisions taken up front, all still in force:

- **Access**: manager/owner/inhouse_dev only, hidden from clients. Consequence worth
  remembering: old chat therefore **cannot be retired yet** — members and clients have no
  other chat surface.
- **Tab model**: only client channels get department tabs. Team channels stay plain.
- **Existing messages**: land in the client's General tab, except the four `-seo` channels,
  which land in SEO because their names say so and they carry 486 messages of SEO work.

## The isolation rule

The original chat is three regions of `index.html`, and for every commit on this branch
up to the member-count fix the rule was that they stay byte-identical to `main`. **That rule has now been broken exactly once, on
purpose** — see "the member count" below — so it is no longer a containment check you can
write inline. Run the tool instead, after every change:

```
python3 tools_newchat_isolation.py     # expect RESULT: clean
```

| region | lines |
|---|---|
| chat screen markup | 7198–7707 |
| chat engine | 41674–47173 |
| per-channel sub-tabs | 67519–67870 |

It takes each region from `main`, applies the approved changes listed in its `ALLOWED`
table, and requires the result to appear verbatim in the current file. So a stray edit
still fails — the approved patch is pinned to exact text on both sides — while the
intentional one is recorded rather than remembered. Approving another change means adding
a before/after pair and a reason to `ALLOWED`, which is deliberately more friction than
editing the original by hand.

Why it matters: this check has caught a real leak, a global string replace renaming a tab
that renamed the original's tab too. Do not skip it because a change "only touched New
Chat" — that is exactly what the leak looked like.

**Five shared namespaces** had to be separated, and only two were visible in the markup:
DOM ids, CSS classes, `window.*` globals, localStorage keys, and **Supabase realtime channel
names**. The last one is invisible at the schema level and cost a debugging round: asking for
a channel name the original already subscribed returns *its* channel, and attaching
`postgres_changes` to a subscribed channel throws. Everything in the copy is `nc_`-prefixed.

Six classes are deliberately **not** prefixed, because the app's own screen/nav machinery
keys on them: `screen`, `fullbleed`, `on`, `active`, `badge`, `ico`.

## Data model

The triage put Chat 3.0's shape onto old chat's tables (additive only; old chat selects none
of these columns):

- `channels`: `kind` (home | team_channel | client_dept | dm), `client_id`, `department`, `color`
- `messages.flagged`, `channel_canvas.cards`
- new: `channel_stars(profile_id, channel_id)`, `inbox_actions(profile_id, message_id|task_id, done, saved)`

The Clients card lists **all 53 active clients**, not only the 11 with channels. Ones with
no conversation render dimmed and create their General channel on first click. Pre-creating
all 265 does not work: `channels` is shared with old chat, so public rows would flood its
sidebar with 247 empty channels, and private rows are invisible to managers because
`channels_select` requires membership for private rows.

Result: 80 DMs · 11 team channels · 1 home · 14 client channels → **11 client threads**.

Known and deliberate: **Maribou has two channels that both mean General** (61 and 12
messages). They are unioned on read via `ncChannelScope()`, not merged, because merging means
moving messages between channels and this branch does not write to old chat's data. Limits:
realtime is still filtered to the primary channel, and sending always writes to the primary.

## Ports — how they went

| feature | keyed on | status |
|---|---|---|
| Management (5 tabs) | `client_id` | done |
| Vault (card canvas) | thread → repointed to `channel_canvas.cards` | done |
| Media gallery | needed an adapter (`message_attachments` table → jsonb shape) | done |
| Client library | `client_id` | done |
| Client tasks | `client_id` | done |
| Magnus | nothing — posts to `/.netlify/functions/claude-api` | done |
| Master Inbox | repointed to `messages` / `channel_members` / new `inbox_actions` | done |

**All ports are complete.** Run `python3 tools_newchat_audit.py` after every change — it
checks the six failure modes below and should print `RESULT: clean`.

The extraction pipeline is `scratchpad/port.py` (regenerate if gone). Three lessons in it:

1. **Do not walk brace depth** to find where a declaration ends. Template literals carry
   `${...}` and unbalanced brackets inside strings, so spans run long and silently swallow
   the declarations that follow. A top-level declaration simply runs until the next one
   starts.
2. **Name-prefix extraction misses `const` arrows, writers and constants.** `onboardingUrl`
   threw a ReferenceError; `saveLibItem`/`toggleLibPin`/`removeLibItem` were missed and the
   panel rendered but could not save; `C3_TASK_COLS`, `C3_PRIO`, `MAGNUS_BLUE` and
   `MAGNUS_SYSTEM` were never extracted at all.
3. **Do not hand-write a shim for something chat3 already defines.** `ncIcon` was a stub
   with three methods against twelve the panels call. Extract the real `C3_ICON` (29
   methods). Rename by dot *and* bracket access — `C3_ICON[d.icon](…)` survived a rename
   that only matched `C3_ICON.`.
4. **Helpers may live in `chat2Module`, not `chat3Module`.** `renderMd`, `fmtBytes` and
   `hexToRgbC3` did, so the extractor was never pointed at them.
5. **A text search is not a scope check.** `fetchAttachments` and `pubUrl` are declared
   inside the nested sub-tabs IIFE; the Media port could not see them even though grep
   found them. They are published through the `ncShared` bridge.

Chat 3.0 is state-and-render; New Chat is imperative. Ported panels run against a local `mg`
state object plus shims (`NCSB`, `ncMyId`, `ncIsStaff`, `ncIcon`, `renderMgmt`, …).

## Traps hit, so they are not hit again

- **`_boot` must run exactly once.** It re-wraps six engine functions (`loadMessages`,
  `appendMessage` ×2, `switchChannel`, `sendChatMessage`, `attachReactBarToMsg`). A second
  run wraps the wrapper and every side effect fires twice — that is what duplicated the reply
  badges. `_inited` deliberately stays set after a throw; the screen says to reload.
- **Removing a control means grepping for what reads it.** Deleting the Team/Clients toggle
  produced three separate bugs over three rounds: the scope filter hid every sectioned
  channel, `_scope` tagging went stale, and an empty-state message kept pointing at the
  deleted tab.
- **The sidebar clones rows, never moves them.** Moving emptied the engine's source lists, so
  the next render found nothing and blanked the sidebar. Cloning is idempotent, which it must
  be — a MutationObserver re-runs it on every change to either list.
- **Chat 3.0's sidebar is an accordion**, one card open at a time filling the column. Six
  equally-expanded cards is what made it look wrong.
- **Check where a pane actually ended up in the DOM.** All four ported panes were inserted
  "before `nc_chatSubTabs`" while that was a sibling of the message list; wrapping the
  departments and sub-tabs in `.nc_tabstrip` later swallowed them, and a pane shown inside
  that flex row renders squeezed into the tab bar. Broke Tasks, Magnus and Management at
  once. They belong beside `nc_chatMediaPane` / `nc_chatCanvasPane`.
- **Each pane has its own renderer.** `adapt()` rewrites chat3's `render()` to
  `renderMgmt()` everywhere, so Tasks and Magnus repainted the hidden Management pane
  instead of themselves and never showed loading or optimistic updates.
- **A name being declared in the module does not mean the call site can see it.** The
  Master Inbox called `fmtTime`, checks 1–5 all passed, and the pane threw a
  ReferenceError the moment it opened: the only `fmtTime` in the module was nested inside
  the scheduled-message code and took a `Date`. Chat 3.0 declares `fmtTime` twice at its
  own top level, so the second one wins there and that is the one now copied in. Audit
  check 6 exists because of this and catches it; the click-through catches it too.
- **The audit checks names and wiring, not structure.** Neither of the two traps above
  would trip it. Check the DOM as well as the text.

## Left to do

1. **Nothing is pushed, and that is the current decision** — the branch stays local. The
   10 migrations are already applied to production; the code is not, and `main`
   auto-deploys via Netlify, so do not push without asking again.
2. **Sign in as a real manager and click through once.** The harness below covers the
   wiring and the structure against stand-in data; it says nothing about production rows —
   Maribou's two Generals unioning, the four `-seo` channels landing in SEO, 10,363 real
   messages paginating. That is the part still unverified.
3. Retire `feature/chat3-management-panels` — its panels were ported here, so it is superseded
4. `version.json` is stale at `20260724u3`, three releases behind; desktop clients are not
   being told to update
5. Old chat still cannot be retired: access is manager/owner/inhouse_dev only, so members
   and clients have no other chat surface until that decision changes

### The member count — fixed in both chats

The channel header's member count was `chatProfilesCache.length` — every profile
`hydrateAllWorkspaceProfiles` loaded at boot — so every non-DM channel reported the whole
workspace regardless of who was in it. The click-through screenshot is what surfaced it: a
freshly created channel with one member read "81 members".

It was **pre-existing and identical in both chats**, inherited by the duplication rather
than introduced here. Fixing only New Chat would have left the two screens disagreeing, so
the decision was to fix both — which is the one approved exception in
`tools_newchat_isolation.py`. `renderChatHeadMembers` now asks `channel_members` for the
active channel; avatars still come from the profile cache, so it is one extra query per
channel switch, not the two the old comment was avoiding. Three details that matter:

- a failed query falls back to the old behaviour, so it is never worse than before
- the channel id is captured up front and rechecked after the await, or a fast channel
  switch paints the previous channel's count
- the count is written before the avatars and outside their empty-list early return, so a
  channel whose members are not all in the profile cache still shows the right number

## Verifying

```
node tools_newchat_clickthrough.mjs      # 40 checks in a headless browser, ~40s
python3 tools_newchat_audit.py           # the six static checks
python3 tools_newchat_isolation.py       # the original chat is as approved
```

**The click-through is the one that matters.** `node --check` and the audit both pass on a
build whose screen is broken, which is how every bug in the traps list shipped.

There are no credentials for the real project, so the harness replaces the CDN's
supabase-js at request time with `tools_newchat_mock_supabase.js`. Serving the mock in
place of that `<script>` is what makes the timing work — `window.supabase` exists before
the app's own code runs — and every `*.supabase.co` request is aborted as a backstop, so a
run cannot touch production. The mock is a small PostgREST implementation (filters, order,
limit, single/maybeSingle, insert/upsert/update/delete, the three embedded selects, storage,
realtime, auth) over fixtures shaped like the real thing: 53 active clients, 1 home + 11
team + 14 client channels across 11 client threads with Maribou holding two Generals, 80
DMs, 486 messages in the four `-seo` channels.

It then does what a person would: waits for the gate to resolve, clicks the New Chat nav
item, opens a team channel, opens a client thread, clicks all five tabs, opens the Master
Inbox, sends a message, and starts an empty department. What it asserts that nothing else
can:

- **which element each pane is parented to** — sibling of `nc_chatMsgs`, never inside
  `.nc_tabstrip` — and that each pane has room to render (the squeezed-into-the-tab-bar bug)
- **that a tab paints its own pane and no other** — every pane is fingerprinted before the
  click and compared after, which is the `adapt()`/`renderMgmt()` bug
- the layout claims that were previously only ever checked by eye: accordion sidebar with
  exactly one card open, one-line tab strip (compare vertical *centres*, not `top` — the
  department tabs are shorter than the sub-tabs and the strip centres them), 53 clients
  listed with 42 dimmed, no duplicated reply badge
- that the header counts the channel's members, not the workspace (the fixture gives a
  team channel 5 members against 81 profiles, which is what makes the two distinguishable)
- uncaught exceptions and `console.error`, which is how `fmtTime` was found

Two things worth knowing before extending it. Playwright dismisses dialogs by default, so
every `confirm()` reads as "no" and the guarded path never runs — that looked exactly like
a broken control until the dialog handler went in. And the mock lists any table it was not
given under `mock gaps`, so a path quietly reading an empty table is visible rather than
silent.

When screenshots cannot be sent (a conversation exhausts its image budget and then rejects
every image regardless of size), measuring them with PIL through the shell genuinely works —
it found the accordion (card boundaries 234px vs 362px) and the duplicate badges (three red
blobs on one row, 82px apart).
