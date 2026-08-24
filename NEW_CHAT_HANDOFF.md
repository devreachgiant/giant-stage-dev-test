# New Chat — handoff

Branch: `feature/new-chat-from-chat3` · 41 commits ahead of `main` · **nothing pushed**

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

The original chat is three regions of `index.html`. **After every change**, confirm they are
byte-identical to `main`:

| region | lines |
|---|---|
| chat screen markup | 7198–7707 |
| chat engine | 41674–47173 |
| per-channel sub-tabs | 67519–67870 |

```python
old = subprocess.run(['git','show','main:index.html'],capture_output=True,text=True).stdout.split('\n')
for a,b in [(7198,7707),(41674,47173),(67519,67870)]:
    assert '\n'.join(old[a-1:b]) in open('index.html').read()
```

This has caught a real leak once: a global string replace renaming a tab renamed the
original's tab too. Run it every time, not at the end.

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
checks the five failure modes below and should print `RESULT: clean`.

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
- **The audit checks names and wiring, not structure.** Neither of the two traps above
  would trip it. Check the DOM as well as the text.

## Left to do

1. **Click-through test** — nothing past the sign-in gate has been verified by machine
2. **Push the branch** — nothing is on the remote
3. Retire `feature/chat3-management-panels` — its panels were ported here, so it is superseded
4. `version.json` is stale at `20260724u3`, three releases behind; desktop clients are not
   being told to update
5. Old chat still cannot be retired: access is manager/owner/inhouse_dev only, so members
   and clients have no other chat surface until that decision changes

## Verifying

There are no test credentials, so nothing past the sign-in gate can be checked automatically.
What is checkable: `node --check` on all 10 inline script blocks, the byte-identical check
above, and a headless load for console errors.

When screenshots cannot be sent (a conversation exhausts its image budget and then rejects
every image regardless of size), measuring them with PIL through the shell genuinely works —
it found the accordion (card boundaries 234px vs 362px) and the duplicate badges (three red
blobs on one row, 82px apart).
