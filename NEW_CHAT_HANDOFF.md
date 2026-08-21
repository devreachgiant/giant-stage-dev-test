# New Chat — handoff

Branch: `feature/new-chat-from-chat3` · 32 commits ahead of `main` · **nothing pushed**

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
- new: `channel_stars(profile_id, channel_id)`

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
| **Magnus** | `client_id` | **TODO** (~184 lines) |
| **Master Inbox** | reads `chat2_messages`/`chat2_threads` → **needs repointing** | **TODO** (~197 lines) |

The extraction pipeline is `scratchpad/port.py` (regenerate if gone). Three lessons in it:

1. **Do not walk brace depth** to find where a declaration ends. Template literals carry
   `${...}` and unbalanced brackets inside strings, so spans run long and silently swallow
   the declarations that follow. A top-level declaration simply runs until the next one
   starts.
2. **Name-prefix extraction misses `const` arrows and writers.** `onboardingUrl` was missed
   that way and threw a ReferenceError; `saveLibItem`/`toggleLibPin`/`removeLibItem` were
   missed and the panel rendered but could not save.
3. **The scope check proves what is referenced resolves — not that everything needed came
   across.** It was silent for both of the above. Cross-check writers explicitly.

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

## Left to do

1. Port **Magnus** (~184 lines, `client_id`-keyed — should go like Tasks did)
2. Port **Master Inbox** (~197 lines, repoint `chat2_messages`→`messages`,
   `chat2_threads`→`channels`)
3. Push the branch — nothing is on the remote
4. Retire `feature/chat3-management-panels` — its panels were ported here, so it is superseded
5. `version.json` is stale at `20260724u3`, three releases behind; desktop clients are not
   being told to update

## Verifying

There are no test credentials, so nothing past the sign-in gate can be checked automatically.
What is checkable: `node --check` on all 10 inline script blocks, the byte-identical check
above, and a headless load for console errors.

When screenshots cannot be sent (a conversation exhausts its image budget and then rejects
every image regardless of size), measuring them with PIL through the shell genuinely works —
it found the accordion (card boundaries 234px vs 362px) and the duplicate badges (three red
blobs on one row, 82px apart).
