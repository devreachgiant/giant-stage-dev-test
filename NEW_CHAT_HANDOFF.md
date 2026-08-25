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

**Six shared namespaces** had to be separated, and only two were visible in the markup:
DOM ids, CSS classes, `window.*` globals, localStorage keys, **Supabase realtime channel
names**, and **DOM data attributes**. The last one is invisible at the schema level and cost a debugging round: asking for
a channel name the original already subscribed returns *its* channel, and attaching
`postgres_changes` to a subscribed channel throws. Everything in the copy is `nc_`-prefixed.

The sixth leaks in a direction the others do not, and it was found by looking at a
screenshot. The original chat's unread painter runs
`document.querySelectorAll('[data-channel-id], [data-dm-channel-id]')` — **document-wide,
with no id or class in front of it** — so it reached into New Chat's sidebar and stamped a
second `.ch-unread-badge` beside this module's own. Two red badges on one row, written by a
module nobody had touched. This module's painter had the identical selector, so it ran both
ways. New Chat's rows now use `data-nc-channel-id` / `data-nc-dm-channel-id`.

**Audit check 8** catches it, and only bare selectors count: `#chatMsgsList [data-msg-id]`
cannot escape its own list, so `data-msg-id` is shared and harmless. It reports both
attributes on the commit before the fix.

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
| Vault (card canvas) | thread → repointed to `channel_canvas.cards` | done, and now the **only** thing the Vault tab renders |
| Media gallery | needed an adapter (`message_attachments` table → jsonb shape) | done |
| Client library | `client_id` | done — moved out of the Vault tab into **Management > Library** |
| Client tasks | `client_id` | done |
| Magnus | nothing — posts to `/.netlify/functions/claude-api` | done |
| Master Inbox | repointed to `messages` / `channel_members` / new `inbox_actions` | done |

**All ports are complete.** Run `python3 tools_newchat_audit.py` after every change — it
checks the nine failure modes below and should print `RESULT: clean`.

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

## The namespacing pass missed JS class assignments

`class="..."` in the markup was rewritten. **`el.className = '...'` and `classList.add()` in
the JS were not** — seventeen classes were created unprefixed while the same module looked
them up as `.nc_…`. Each is two bugs at once:

- **The de-dupe guard never matches**, so every re-render appends another copy. That is the
  duplicated reply badge *and* the duplicated unread badge in the sidebar — two red "1"s on
  one row. The `_boot`-runs-twice fix in the traps list was a different cause of the same
  symptom, which is why it looked like a regression.
- **The element picks up the ORIGINAL chat's CSS** for that class, which is exactly the leak
  this branch exists to prevent.

**Audit check 7** catches it: a class assigned unprefixed while `nc_<name>` is looked up
somewhere in the module. It reports all seventeen on the commit before the fix. The six
deliberately shared classes (`screen`, `fullbleed`, `on`, `active`, `badge`, `ico`) are
excluded.

Four more are assigned unprefixed but never looked up prefixed — `mention-picker-pop`,
`msg-attachments-uploading`, `reaction-tooltip`, `schedule-preset`. Two of those have bare
CSS in the original chat and no `nc_` rule, so **prefixing them would remove their styling**.
Left alone deliberately; they are a style leak, not a duplication bug.

## One Vault, everywhere

The Vault tab used to render **two different screens**: `libraryTabHtml()` on a client
thread and `vaultTabHtml()` everywhere else. What "Vault" meant depended on which
conversation you happened to be in.

It is the card Vault now, in every chat — channel-scoped, on `channel_canvas.cards`. The
client library is client-scoped, so it moved to **Management > Library**, alongside every
other client-scoped panel. `wireLibrary`'s handlers repaint `renderMgmt()` rather than
`renderVault()`, and the tab loads lazily on first open (guarded inside
`loadClientLibrary`, so reopening is free).

One hazard went with it: `renderVault` used to set `mg.selectedId` to a **channel** id for
non-client channels, and every other reader in the module treats that field as a **client**
id. The card Vault reads neither `selectedId` nor `selectedKind` — only `mg.vaultCards` —
so the assignment is simply gone.

## Group DMs were all filed under Direct

`is_group` **was not in the `channels` select**, so `c.is_group` was `undefined` on every
channel in the module. Two consequences, and the first hid the second:

- A two-person group conversation read as a one-to-one — the other person's name and face
  instead of the group's — because `renderDmChannelList` falls back to counting members
  (`is_group === true || others.length > 1`) and two people is one other.
- `renderNavCards` routed the card off `c.is_group` **alone**, with no member-count
  fallback, so **every** group DM landed under DIRECT and GROUP DMS was empty. Measured on
  the fixture before the fix: `direct=80, groups=0`.

Both fixed by selecting the column. The card now routes on `data-nc-dm-group`, stamped by
the list when it decides — so the two cannot disagree again, which is how they got here.

On the real account that moves 11 of 25 conversations out of DIRECT and into GROUP DMS.

## The DM list, and a filter with no control

DIRECT and GROUP DMS were empty on an account with 25 DM channels — 14 one-to-one, 11 group,
counterparties all staff. Three separate ways that list could come up empty in silence, all
now closed:

- **A scope filter that outlived its switch.** `renderDmChannelList` filtered on
  `window.nc__chatScope`, persisted in `giant_nc_chat_scope`. The Team/Clients toggle it
  belonged to is not part of this sidebar any more — CLIENTS, TEAMS and DIRECT are separate
  cards — but the value it last wrote still applied, and `'clients'` hides every group DM
  *and* every DM whose other person is not a client, which for a staff account is all of
  them. Reproduced: with that value set, the old build lists **zero** DMs. A filter nothing
  on screen can change is a switch someone can be stuck behind forever.
- **An unresolved profile dropped the whole conversation.** `if (!p) return` meant one
  profile that had not hydrated removed a DM from the sidebar with nothing said. It renders
  as "Unknown member" now.
- **The start-a-DM fallback never reached the card.** With no DM channels,
  `renderDmChannelList` lists teammates as `data-start-dm` rows; the DIRECT card cloned only
  `[data-nc-dm-channel-id]`, so it said "No direct messages." over a list full of people you
  could message.

`renderChannelList` had the same filter and it was removed earlier — but **two live
references to `scope` remain** there (the switch button and an empty-state branch), so
deleting the declaration breaks the channel list outright. It is left in place with a note.

## The row menu

Every sidebar row — team channel, client thread, group DM and one-to-one — carries a
**permanently visible** `···` chip and the same menu. It shipped at `opacity:0` until hover,
which made it finished and undiscoverable at once: nothing on the row said a menu was there,
so there was no reason to hover looking for one. The chip is ordered last with
`order:99` — it lives in the row template, but the unread badge, the star and the needs-dot
are appended afterwards by `renderNavCards`, so in source order it lands mid-row. Items are gated to match `channels_delete_owner_mgr`, which the
database already enforces, rather than to a guess:

| item | who |
|---|---|
| Mark as unread, Mute, **Leave** | everyone |
| Invite, Rename, Delete | the creator, or owner / manager / inhouse_dev / admin |

A **one-to-one** gets Mark unread, Mute and Delete only: there is nothing to rename, nobody
to invite, and leaving a two-person conversation is deleting it.

Three things this needed that were not there:

- **`created_by` was not in the channels select**, so "the person who created it" could not
  be evaluated at all — the creator gate existed on the server and was invisible to the client.
- **The trigger lives in the row markup**, not attached per element. `renderNavCards` clones
  rows into the sidebar cards and `cloneNode` carries no listeners, so anything attached
  afterwards works in the hidden source list and nowhere the user can see. The click is
  delegated for the same reason.
- **Group-ness is read from `data-nc-dm-group`**, the flag the list already stamps. The first
  version derived it again from `mg.threadMembers` — which is the Media adapter's attachment
  array, not members — so every group DM presented as a one-to-one and lost Leave, Rename and
  Invite.

**Leave** deletes only your own `channel_members` row. On a private channel that ends your
access, since `channels_select` requires membership there, so the confirmation says so
instead of letting it be discovered afterwards. **Delete** is unchanged and still cascades:
`messages_channel_id_fkey` is `ON DELETE CASCADE`, and `channels` is shared with the original
Chat, so deleting removes the conversation and its whole history for everyone, in both chats.

## Dialogs

Clicking a department tab used to ask `Start the Google Ads conversation for A X E?` in a
native browser dialog. **It does not ask any more.** That tab looks like a tab and sits in a
row of tabs, so clicking it is navigation; interrupting that with browser chrome to create
one empty private channel — which the channel menu can delete — was the wrong trade. It
creates it and says so with a toast.

Everything genuinely destructive still confirms, but through **`ncConfirm`**, which wraps
the app's own `window.giantConfirmWarn` and falls back to `window.confirm` only if the
helper is missing, so a missing dialog can never silently approve a deletion. Remove member,
archive client and delete channel all go through it. The Vault's library delete already did;
the rest of the module had not caught up.

Testing note: the click-through **auto-accepts native dialogs**, which is how a stray
`window.confirm` survived unnoticed — it counts them now, and the department-tab check fails
if the click raises one. In-page confirmations need a poller that presses the overlay's
button; a native handler will not settle them.

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

## Chat 2.0 and Chat 3.0 are archived

Both moved out of Communication into an **Archive** nav group at the bottom of the sidebar.
Moved, not deleted: the screens, their code and their data are untouched, both items still
open, and putting either back is one line. Communication now reads as Chat and New Chat
rather than four chats to choose between.

Two things a new rail needs, and one that surprised me:

- **`setupRail('railArchive','pillArchive')`.** `setupRail` binds click handlers per element
  and only to the rails it is handed, so a new rail's items render and do nothing without it.
- **Its own `.nav-pill`**, like every other rail.
- **Chat 2.0 is behind a private-review allowlist** of four profile ids in `initApp` — anyone
  else gets `style.display = 'none'` on the nav item outright. Pre-existing and deliberate;
  it is why Chat 2.0 does not appear in the click-through, whose fixture user is not on the
  list. The check asserts placement for it and visibility on Chat 3.0.

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

### Management > Overview

Rebuilt to the approved design: one hero card (avatar, name, industry, MRR, state pills,
contact columns, service leads, working notes, keywords), then Services & ad spend as a
boxed list, then Account access / Active work / Conversations collapsed.

- The status pill is a real `<select>` over `CLIENT_STATUS` — `setClientStatus()`. Archiving
  keeps its confirmation; the other four transitions go straight through.
- Paid and Onboarding **report** rather than set. There is no billing-status column, so they
  open the tab that owns them. Down chevron means a menu, right chevron means another tab.
- Chevrons are drawn inline. `C3_ICON` has none, and a rotated `arrowRight` reads as a
  download arrow.
- Service leads follow the **active** services, falling back to every billable department
  when nothing is active — otherwise the control is unreachable on the clients that need it.
- The department jump list survives as a collapsed row. It is not in the mock, but removing a
  working control to match a picture is a regression.
- **The sub-tab strip is full-bleed and not sticky.** Its rule runs the whole width of the
  pane, hard against the sidebar, while its labels sit on the same 44px gutter as the cards.
  That needs the padding on the strip itself, inside its border box — `nc_mgmtPane` used to
  carry `18px 22px` and the strip's wrapper added another `22px`, so the rule could never
  reach the edge. The pane's padding is now `0` and one place owns the gutter.

**`client_onboarding` is keyed by the client's own id.** It is the restricted projection of
`clients` and shares its primary key, so the panel selects it with `.eq('id', clientId)`. The
click-through fixture had invented a separate id, and the panel rendered its "no client
record" state for a whole run while still passing — "the pane has content" is too weak an
assertion, which is why there are now three specific Overview checks.

### The department strip and the tool tabs are two different selections

Only one of them is about a department. `Media` and `Vault` are per-channel, so they keep
the department highlighted. **Tasks, Magnus, Management and the Master Inbox are keyed on
`client_id`** — each shows the whole client — so they clear it. Before this, every tab left
the department pill lit, which put two things in the strip looking selected at once and
claimed a client-wide panel was scoped to one department.

`renderDeptStrip` reads `window.nc__chatSubtab` and the Inbox pane's computed display, so
it has to be redrawn when the *tab* changes and not only when the channel does —
`nc_switchChatSubtab` and `openInbox` both call it now.

### Avatars: everyone with a photo was showing an empty circle

`c3AvatarStyle` takes `(bg, fg)`. `c3ProfileMarkHtml` called it with **three** arguments,
passing `avatar_url` as a third the function never had. JavaScript dropped it silently, and
the caller had already decided not to draw initials on the assumption the photo would be
there — so every person with a profile picture got a blank coloured circle. That mark is
shared by the Members table, the Activity feed, the Master Inbox and the service leads, so
it was all of them at once.

The photo is now an `<img>`, matching how every other avatar in the module is drawn. That
is not a style preference: in `url("…")` inside a `style` attribute the URL needs a CSS
escape *and* an HTML one, and the obvious `encodeURI` **double-encodes any percent already
in the path** — which is every storage URL with an encoded filename, and every `data:` URI.
It renders as a black circle, which reads as a design choice rather than a broken image.
In `src`, `chatEsc` is correct and sufficient.

**The first version of the click-through check for this passed while the image was
broken**, because it asserted a `background-image` had been set. A screenshot caught it.
It now asserts `naturalWidth > 0` — that the image actually decoded.

### Staff are on by default in Members, but only where that is true

Managers, owners and in-house devs no longer have to be ticked into every client by hand.
The two column groups are **not** the same, and the difference is not cosmetic:

- The four **areas** are gated by `ncCanArea`, which passes all three roles. Genuinely on.
- A **department** tick is a `channel_members` row, and `channels_select` grants blanket
  read on non-DM channels to `inhouse_dev` **only** — migration `20260821110000` turned
  that down for managers and owners deliberately, with a note saying why. A manager shown
  as ticked would open the channel and find nothing, so their department ticks stay theirs
  to set.

So an in-house dev is locked on all nine columns; a manager or owner on four. The
click-through pins exactly that asymmetry.

Role-granted ticks are drawn dimmer and carry no click handler — unticking one would delete
a row that was granting nothing. `Remove` becomes **By role** for anyone whose access is
entirely their role, since there are no rows to clear.

**Still open:** giving managers and owners the same default on *departments* needs either an
RLS widening (which `20260821110000` declined, and which would widen the original Chat too —
RLS is per-table, not per-module) or real membership rows on every client channel (which
puts those channels in old chat's sidebar for every manager). Both are decisions, not edits.

### A migration that is written but not applied (now applied — keep the fallback)

`client_member_areas` shipped as code before it shipped as a table, and the gap looked like
a bug: a red `Could not load area access: Could not find the table 'public.client_member_areas'
in the schema cache` toast on every open, and four columns whose ticks could never persist.

That is a deployment state, not a runtime failure. `loadClientMemberMatrix` now recognises
PostgREST's `PGRST205`, sets `mg.areasMissing`, and the Members table drops to the five
department columns with a line naming the migration. Nothing to toast, nothing to click that
cannot work, and the columns come back on their own once it is applied.

Worth keeping the shape in mind for the next one: **code that needs a migration has to work
before the migration lands**, because on this branch it always will for a while.

`window.__mock.hideTable(name)` / `showTable(name)` make the mock answer PGRST205, which is
how the click-through reaches this state. That check runs **last** and switches client on
purpose: `loadClientMemberMatrix` is guarded by `mgmtMatrixFor` and will not reload for a
client it has already seen, so a mid-run toggle proved nothing — the first version of the
check passed with all nine columns still on screen.

### Members: deactivated accounts, and the Add member popover

**Deactivated accounts are filtered out of the Members list, not out of the profile cache.**
`profiles.deactivated_at` (migration `20260720120000`) is how the rest of the app blocks a
login; New Chat never selected the column, so blocked accounts were still being offered
access. They stay in `chatProfilesCache` deliberately — their name and face belong on every
message they ever wrote, and dropping them would turn all of that into "Someone".

**+ Add member** is a searchable popover, not a `<select>`: avatar, name, email and role per
row, click to add. The search filters **in the DOM** rather than through `renderMgmt` — a
re-render rebuilds the pane and drops focus and the caret on every keystroke, which is
tolerable for the notes textarea and useless for a search box.

Below it, an invite path for people with no account to tick: same `invitations` row, same
token shape and same `/accept-invite?token=` link the rest of the app writes, duplicated
rather than shared because these modules only ever share tables. The email is best effort —
the row exists either way, so the link is copied regardless. It does **not** grant access to
this client: they are not a profile yet, so there is no `profile_id` to write.

`copyLibText` was fixed on the way: `navigator.clipboard.writeText` returns a promise, so its
`try/catch` never saw a denied clipboard. The rejection escaped, this module's own
`unhandledrejection` listener caught it, and the screen grew a red "New Chat — async error"
banner over a copy that simply had not happened — after toasting "Copied", because the
synchronous call had not thrown.

### Only one tab in the strip is ever active

Media and the Vault are per-channel, so a lit department was arguably true there — but the
strip is one row of tabs and two of them looking selected reads as a bug whatever the
justification. Only the messages view lights a department now.

That relies on the header naming the department, which it did not: `switchChannel` wrote
"Fortess DG" over "SEO", and then `renderChatHeadMembers` overwrote the second line with
"Private channel · N members" when the member count landed a round trip later. `ncHeadTopicBase`
is now the single source for that line and both call it.

### Needs you and the Master Inbox answer the same question

`computeNeedsYou` used to pull the 600 newest messages across every channel and work out
what was unread in the browser. That loses things, and the arithmetic is easy to miss: the
limit applies to the whole result set, so **one chatty channel drags the cutoff forward for
every other channel**. Measured on the fixture — 106 channels, one busy — the effective
window collapsed from fourteen days to **three**, and a twelve-day-old unread DM never
appeared. On the one list whose entire job is to not lose things, a cap is the wrong shape
of answer.

Unread now comes from the **`unread_counts` view**, which the database already computes per
(channel, member) against `last_read_at`, with no window and no cap. Mentions and flags
still need message rows, but they ask for exactly the matching ones (`.eq('flagged', true)`,
`.ilike('body', '%@first%')`) rather than scanning and filtering — so the result set no
longer grows with how talkative the team has been, and the window widened to 30 days for
free.

The mock **computes `unread_counts` on read** now, the way the view does. It was six
hand-written rows, which meant a screen reading it could not be checked against anything.

**The card is the entry point to the Inbox, so it has to count what the Inbox holds — and
it did not.** The Inbox keeps a mention or a flag until you clear it; the card required
every kind to be *unread*, so opening a channel emptied the card while the Inbox still
listed seventeen mentions. "Nothing needs you" above a pane reading "All 37" was the two of
them disagreeing, not a count going stale. `computeNeedsYou` now matches `loadInboxItems`:
mentions and flags count regardless of read state and drop out when marked done, only
"unread" depends on reading, and both use the same reach (a client thread is visible to an
owner or in-house dev whether or not anyone added them to it).

**It keeps up with new messages.** `computeNeedsYou` runs **once, at boot**, so before this
the card described the moment you loaded the page: a message in ReachGiant Home or a DM lit
its unread badge in the sidebar while the Needs you list one card above it did not move
until a reload. `ncNoteNeed(m)` is called from both realtime paths — the `appendMessage`
wrapper and the global message subscription — and places the message incrementally using the
same rules as `computeNeedsYou`, so it costs no query. It never downgrades an existing
reason, and it ignores the channel you are currently reading.

**It refreshes when you come back to it.** `ncNoteNeed` keeps the card current while the
app is open, but realtime cannot tell you what you *missed*: a subscription dropped by a
backgrounded tab, a sleeping laptop or a network blip reconnects with **no replay**, and
anything that arrived in the gap stays invisible until a reload. So `computeNeedsYou` runs
again on three signals:

- **the screen becoming active** — forced, because opening it is deliberate and rare, and
  throttling that means the one moment someone looks is the moment it is allowed to be stale
- **`visibilitychange` and `focus`** — throttled to 15s, since a single alt-tab fires both
- **a five-minute tick**, only while the screen is on top and the tab visible — for the case
  none of the above catches: the screen never left while the socket silently reconnects

`_needsBusy` guards overlap, because `computeNeedsYou` is several awaits long and a second
pass would race the first. Watched via a MutationObserver on the screen's own class rather
than by hooking `navigateToScreen`, which is shared with every other module.

**Thread replies count.** The realtime handler hit `return` on "thread reply, not
involved" — one exit that left the whole handler, so a reply never reached the unread badge
*or* this card. It also fired **before** the @mention check below it, so being mentioned
inside a thread was dropped without ever being looked at, which is the case people actually
notice. It sets `quietReply` now: the notification is suppressed, everything else runs.

**Clicking a row lands on the message.** `ncNeedMsg` records which message put the channel
on the list, so the row jumps to it, scrolls it into view and flashes it — the same
treatment the search jump uses. A **thread reply opens its thread first**: replies are never
in the main list, so scrolling to one there finds nothing; it falls back to the parent,
which at least is on screen.

That jump was also broken by four selectors reading `.msg[data-msg-id="…"]` while every
message this module renders is `.nc_msg`. Bare, they matched the ORIGINAL chat's messages —
in the DOM on a hidden screen — so "jump to message" scrolled and lit an element nobody
could see. **Audit check 9** is the inverse of check 7 and catches exactly that; it found a
fifth, `.ch-item`, that I had not spotted.

**Newest first.** It used to sort by reason — every mention, then every flag, then every
unread — which buried a message that had just arrived under a fortnight-old mention. The
reason is still on the row as the coloured dot; it no longer decides the order, and only
breaks ties.

Ordering needs a time per row and `unread_counts` has none, so one query asks for it once
the list is known — covering exactly the listed channels, **in chunks of 12 against a limit
of 300**. One query for "the newest 400 across all of them" is the sampling trap again: a
single busy channel eats the whole result and every quieter one comes back untimed, which
puts it at the bottom of a list sorted by time. The click-through caught precisely that,
because the fixture injects 1,400 noise messages mid-run to defeat sampling.

**Reading one clears it.** The card is a queue you work through, so a row that survives
opening it is the list failing at its only job. `ncClearNeeds` hangs off `switchChannel`, so
it fires however you reached the channel. Unread would clear itself — opening writes
`last_read_at` — but a mention or a flag would not, so reading the channel marks those
`inbox_actions` done, or the row returns on the next recompute.

Consequence worth knowing: **opening a channel clears its mentions from the Master Inbox
too.** The two are one list now, and a queue that empties in one place and not the other is
the bug this all came from. The write reads the existing rows first and merges, because a
blind upsert would put `saved:false` over anything saved from the Inbox — losing that is
worse than leaving a row on the card. A failed write puts the row back rather than let the
card claim something was handled.

**The Inbox had the same sampling bug.** It scanned the 400 newest messages across
everything and filtered afterwards, so a mention older than that did not exist as far as it
was concerned. Measured against production: the card found 32 channels with an open mention
where the Inbox listed 17. It asks for mentions and flags by name now — they are rare enough
to query directly — and only "new activity" stays a recent window, because that one
genuinely is. Results are merged and de-duplicated by id, or a recent mention would come
back from two queries and become two rows.


### Management > Activity — what it can and cannot record

The trail is `chat2_client_activity`, written by `logC3Activity`. **Three of the kinds
declared in `ACT_COLOR` are never written**: `message`, `payment` and `vault_view`. Nothing
posts a message *through this panel*, nobody takes a payment in it, and opening the Vault
was never wired to log. So the caption's old promise — "Full history for this client —
messages, uploads, views, tasks, onboarding and billing" — was false by construction, not
by accident.

Worse, the reconstruction that *could* supply messages and payments was rendered only when
the trail was empty. One logged action hid it, which for a client with any history is
immediately: a client with 40 messages, three tasks, a paid invoice and completed
onboarding showed **one row**.

Now: the trail renders as the trail, and beneath it a labelled *Messages and payments ·
reconstructed* section always renders, because those two can never be in the trail. Same
client, 1 real row + 41 reconstructed.

`buildMgmtActivity` also read three pieces of state owned by other tabs —
`mg.clientTasks`, `mg.libraryItems` and `mg.threadMessages`. Open Management without
visiting Tasks, the Vault and Media first and all three are empty. **`threadMessages` is
not messages at all**: `loadNcMedia` overwrites it with *attachments* shaped like messages,
so every "posted a message" row was really a file upload, and only after someone had opened
the Media tab. Messages now come from `loadMgmtInferred`, which queries them.

Still true and worth knowing: `vault_view` is declared but never logged, so "who opened the
Vault" is not recorded — only `vault_reveal` is. The footnote no longer claims otherwise.

### Management > Members

Rebuilt to the approved design: caption and **+ Add member** on one row, then the matrix in
a bordered card — elevated header, avatar and name per row, one red tick per department,
**Remove** on the right.

- **Rows are the client's members, not the workspace.** The old table listed every profile,
  which at eighty-odd people is a wall of empty checkboxes you scroll past to find the four
  that matter. Adding is now an explicit act: `addClientMember` puts them in General — the
  client's base conversation — and the ticks take it from there. `removeClientMember` clears
  every department in one delete, behind a confirmation, because doing it a tick at a time is
  five confirmations and four chances to stop half way.
- Ticks are one colour. The column header already says which department it is, so colouring
  the box per department spent the app's only "this is on" signal on information already
  present.
- Sized against the real pane rather than by eye. Eleven flex children at `gap:8` spent 80px
  on gaps alone, which pushed Tasks and Billing off the right edge — the worst place to hide
  a column in a permissions grid. The click-through measures it now.
- **Nine columns, two stores.** The five departments are `channel_members` rows against the
  client's department channels — a department *is* a channel. Onboarding, Deliverables, Tasks
  and Billing are not; they are areas of the client record, and live in
  `client_member_areas` (migration `20260824120000`, **applied to production 2026-08-24**).
  `supabase migration list` now reports nothing unapplied. The fallback below stays in the
  code anyway — it is what makes the next code-before-migration gap harmless. A grant on any of
  the nine makes someone a member of the client: billing-only access is still access, and a
  row you cannot see is a row you cannot revoke. Remove clears both stores.
- `ncCanArea(area, profileId)` is the gate, published as `window.nc_canArea`. Managers, owners
  and in-house devs always pass — the ticks widen access for everyone else rather than
  restricting the people who administer it, or the first manager to open a client with no
  grants would lock themselves out.
- **Deliverables has no surface in New Chat.** The grant is recorded so it exists when one
  arrives. A tick that persists and gates nothing is honest; a tick that does not persist is
  not.

**Creating a department channel invalidates the Members matrix.** `loadClientMemberMatrix`
is guarded by `mgmtMatrixFor` and never reloads for the same client, so a department created
after that load stayed invisible to it — the column read "no conversation here" and everyone
read as not a member, however many membership rows were written. `ensureClientDeptThread`
now clears the guard, and `toggleMemberDept` re-renders the department strip, which had the
same staleness.

## Verifying

```
node tools_newchat_clickthrough.mjs      # 75 checks in a headless browser, ~120s
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
- that Management > Overview renders the client record rather than its empty state, that a
  collapsed section opens, that the status pill offers all five statuses, and that the
  sub-tab strip stays full-bleed and scrolls away instead of pinning
- that only department-scoped tabs highlight a department, across all seven panes
- that Activity reconstructs the messages and payments the trail cannot hold, and that
  its caption does not promise what is never recorded
- that Members shows all nine permission columns, that they fit without scrolling, and
  that the department reads "Web" rather than "Web Projects"
- that Members lists only the client's members, and that a tick writes one membership row
  while an area tick writes one `client_member_areas` row and flips `nc_canArea`, and Remove
  clears both stores. That last one **writes**, so it runs last — placed earlier it
  moved the ground under the checks after it, which is how the matrix staleness surfaced
- that the header counts the channel's members, not the workspace (the fixture gives a
  team channel 5 members against 81 profiles, which is what makes the two distinguishable)
- uncaught exceptions and `console.error`, which is how `fmtTime` was found

Two things worth knowing before extending it. Playwright dismisses dialogs by default, so
every `confirm()` reads as "no" and the guarded path never runs — that looked exactly like
a broken control until the dialog handler went in. And the mock lists any table it was not
given under `mock gaps`, so a path quietly reading an empty table is visible rather than
silent.

**The mock delivers realtime events now** — `window.__mock.emit(table, event, row)` calls
whatever subscribed via `.on('postgres_changes', …)`. It used to accept `.on()` and drop it,
which meant every realtime path in the app was untested: a check that recomputed instead
passed on a build where the realtime branch was broken, and said nothing.

When screenshots cannot be sent (a conversation exhausts its image budget and then rejects
every image regardless of size), measuring them with PIL through the shell genuinely works —
it found the accordion (card boundaries 234px vs 362px) and the duplicate badges (three red
blobs on one row, 82px apart).

### The "+" on a nav card (2026-08-24)

Reported as *"+ icon not working on all channels"*. The button was fine: it opened the
modal, the modal wrote the channel and the membership row. What never happened was the
sidebar redrawing, so the channel you had just made was invisible until a reload.

The cause is one line that was never written. `nc_channel-members-changes` carried the
comment *"membership change may add/remove channels"* and then called `loadUnreadCounts()`
only -- badges, not the list. It now also calls `loadChannels()`, debounced 350ms because
creating a channel writes the member row and then updates it. This also fixes being invited
to, or removed from, a channel while the app is open.

The click-through could not have caught this before: the mock only delivered realtime when
a test called `__mock.emit` by hand, so the app's own write-then-refresh path was never
exercised. `tools_newchat_mock_supabase.js` now delivers a `postgres_changes` event on every
insert, update, upsert and delete, asynchronously, the way replication does. Worth knowing
when reading the suite: realtime handlers now fire during ordinary writes.

The star-order check was rewritten at the same time. It asserted a pixel gap and failed at
31px against a threshold of 24 -- it was measuring mid-animation while the card opened. It
now waits for the card body's height to settle and asserts the property actually claimed:
no other child of the row sits between the star and the chip.

### The "+" really was dead — five modals opened into a hidden screen (2026-08-25)

The earlier sidebar-reload fix was real but was not what the user was hitting. The actual
fault: `newChannelModal` lives inside `<div class="screen" data-screen="chat">`. That screen
is `display:none` whenever New Chat is active, so `openModal('newChannelModal')` added the
class to a node in a hidden subtree and nothing appeared. Clicking "+" looked completely
dead.

Five modals were like this -- Create channel, New DM, Members, Invite, Pinned -- while seven
correctly `nc_`-prefixed modals sat unused in New Chat's own screen. Worse, all seven of
those had `data-close="<unprefixed id>"`, so their close buttons targeted the old chat's
copies, and `nc_newChannelSubmit` appeared exactly once in the file: in markup, wired to
nothing. New Chat rendered members and pinned lists into its own modals and then opened the
other one.

Fixed by repointing the open/close calls at the `nc_` modals, correcting all 17 `data-close`
values, wiring `nc_newChannelSubmit` (name, description, parent, privacy, creator
membership, reload, switch), giving the description input the id the handler already looked
for, and binding backdrop-click on `.nc_modal-overlay`.

Two traps worth remembering, both of which made a check pass on broken code:

- `classList.contains('on')` and `getComputedStyle(el).display` describe the ELEMENT and say
  nothing about a hidden ancestor. Neither can see this bug.
- `offsetParent` is null for `position:fixed` by spec, and every one of these overlays is
  fixed -- so it reports every modal invisible. The suite now uses
  `el.checkVisibility({checkVisibilityCSS:true})` with an ancestor walk as fallback.

Audit checks 10 and 11 now guard the class: a modal opened by id that lives in another
screen, and an `nc_` modal whose close button targets a foreign id. Both report all 13
crossings on the previous commit.

Known limit, stated plainly: the "every modal is on screen" check opens the five by adding
`.on` directly, so for four of them it really only proves the close target. The `"+"` check
is the one that drives a real app path end to end. Driving Members/Invite/Pinned/DM the way
a user does is still to do.

### Needs you dropped channels, and badges vanished on every repaint (2026-08-25)

Two separate faults behind "the old chat says 20 unread, the card shows 3".

**1. The card was built from the DOM, not from the data.** `renderNavCards` cloned rows
already painted in `#nc_chatChannelList`, so a channel with no painted row could not appear
however loudly it was asking for you. With the Clients scope the sidebar deliberately keeps
ONE row per client -- its General, or its busiest department -- so unread on any other
department of that client pointed at a channel id with no row, and the need was dropped in
silence. In the real data that lost `maribou` and `mango-vans-seo`; `burrus-seo` survived
only because it happened to be its client's chosen row.

The in-app diagnostic settled it: both missing channels came back `iAmMember: yes`,
`inChatChannels: yes`, `reachedNcNeeds: mention`, `paintedRow: NO`. `computeNeedsYou` was
right all along; the render threw the answer away.

Needs you now falls back to synthesising a row from the channel record whenever nothing was
painted, labelled as the sidebar labels it (client name, plus `· department` so two needy
departments of one client stay tellable apart). The painted rows are now only an
optimisation for the common case. This also removes the standing fragility around
`reachgiant-home`, which is filtered out of that list by name.

**2. Every repaint stripped the unread badges.** `renderOne` emits no badge -- badges are
stamped on afterwards by `updateUnreadBadges` -- and `loadChannels` never called it. So any
list rebuild removed every badge until the 30s unread poll or a reload. That is the "red
badges disappear by themselves" report, and the 2026-08-24 sidebar-reload fix made it far
more visible by running `loadChannels` on every membership change. One call at the end of
`loadChannels`, reading `chatUnreadCounts` already in memory.

Trap worth keeping: the first version of the badge check compared the count after a rebuild
with the count before it, and PASSED on the broken build -- the "before" figure was itself
taken after an earlier rebuild had already stripped them. It now counts rows that SHOULD
carry a badge and requires every one of them to have it: 8 of 8 after, 0 of 8 before.

### Create a channel: the invite field, and two fields that should not be there (2026-08-25)

Three things on `nc_newChannelModal`, all reported from real use.

**Invite members did nothing.** It was markup only: a chips container, an input, and an
empty suggestion box, with no listener anywhere and nothing read at submit. Worth noting
the ORIGINAL chat's copy is decorative too -- its suggestions are six hardcoded
`.invite-suggest-item` rows and the chips it builds are never read when the channel is
created -- so there was nothing to port and this is written fresh.

It now filters the same `dmTeammatesCache` the DM modal uses (loaded on open, and again on
first keystroke in case someone types before that lands), excludes deactivated accounts and
anyone already picked, adds a chip on click, removes on × or Backspace, and writes the
picked ids as `channel_members` rows in the same insert as the creator. `.nc_invite-chip`
and `.nc_invite-chip-x` had no CSS at all -- the namespacing pass carried the markup over
and left the styles behind -- so those were added too.

**Parent channel is gone.** Removed on request, with its helper line. `parent_id` is still
honoured everywhere else; nothing sets it from this modal any more.

**The "extra empty line"** was `.nc_invite-suggest`, which carries a border, padding and a
background unconditionally, so an empty box drew a grey bar under the field.
`.nc_invite-suggest:empty{display:none}` -- which fixes the invite modal's copy as well.

**The suggestion rows themselves.** First cut drew the avatar as
`background-image:url(...)` on a style attribute, which is the trap
`c3ProfileMarkHtml` already documents: a storage URL carries an encoded filename and does
not survive being put inside `url(...)` in an attribute, so everyone WITH a photo rendered
as an empty circle and everyone without one showed their initial -- the exact inverse of
what it looks like. Now an `<img>`, and the check asserts the image actually loaded rather
than that a row exists.

Rows also carry the email under the name and the role on the right, so a bot or a
client-role account is recognisable before you invite it. Deactivation is checked through
`ncIsDeactivated`, which accepts `deactivated_at`, `is_active === false` and
`deactivated === true` -- the cache is shared with other screens and offering a disabled
account is worse than missing one. The fixture has two deactivated profiles and the check
requires none of them to be offered.

### Deactivated accounts in the pickers, and DM vs group selection (2026-08-25)

**Deactivated accounts were offered everywhere except the create-channel invite field.**
`ncIsDeactivated` now gates three more places: the New DM / group picker, the sidebar's
"start a DM" fallback list, and the "add someone" half of the channel members modal.

Deliberately NOT filtered: `hydrateProfiles`, `hydrateAllWorkspaceProfiles` and
`switchChannel`. Those resolve names for messages and memberships that already exist --
filtering there would blank the author on every message a since-deactivated person wrote.
Nor is the existing-members half of the members modal filtered: a deactivated account that
is already in a channel stays listed, or the channel understates its membership and there
is no way to remove them.

**A DM now takes one person.** The picker was multi-select in both directions and decided
afterwards, by count, whether to call `ensure_dm_channel` or `create_group_dm`. Picking a
second person from the Direct card now replaces the first; the Group DMs card keeps adding.
`window.nc__dmModalMode` carries which card was clicked, since both open the same modal, and
the modal's title, subtitle and submit label follow it. This also closes the older gap where
the Group DMs "+" opened a one-to-one picker and could not create a group at all.

Note when editing `loadDmModalList`: the original chat has a byte-identical copy of the
filter line, so a blind string replace hits both. Scope edits to the `newChatModule` slice.

### The Clients "+", and why Delete looked dead on a client row (2026-08-25)

**Delete worked, and changed nothing on screen.** A client row is a CONVERSATION, not a
channel: duplicate channels for the same client and department are unioned on read, and
never merged, because moving messages to tidy the data model is the one thing this branch
does not do. Deleting the row's own channel deleted something real and left the row
standing, backed by its duplicate -- `deleted: 1, remaining: ["ch-cd-gen-1b"]`. Delete now
takes everything the row unions (same client, same department), says how many channels that
is in the confirm, and drops them from `chatChannels` locally so a re-render cannot restore
the row from a stale copy before `loadChannels` returns.

Note what correct looks like here: the client row REMAINS after the delete, as the dimmed
"No conversation yet" row. Deleting a conversation does not delete the client. The check
asserts the row is that empty-state row -- `rowIsEmptyState` -- rather than asserting it
disappeared, which was the first (wrong) assertion and would have forced the wrong fix.

**The Clients "+"** opens its own modal rather than the create-channel one, because there is
nothing useful to type: a client channel is a client and a department, and its name, slug
and privacy all follow from those. It is a picker in front of `ensureClientDeptThread` --
the same call an empty department tab makes -- so there is only one way a `client_dept` row
is ever inserted. Picking a pair that already exists says so and opens it instead of
creating a duplicate.

**The invite row blew up (2026-08-25).** The `<img>` fix above left the box to
`.nc_dot-ava`, which is defined three times over and, in the rule that reaches this row,
sets no width or height at all. An image at `width:100%` inside a box that resolves against
nothing paints at the file's own dimensions, so a full-width photograph shoved the name and
role off the row. Sizes are now stated on the element itself.

The check had passed on this, and it is worth understanding why: it asserted the image
LOADED (`complete && naturalWidth > 0`), which was true -- gloriously true, at 64x64 in a
row meant to be 24. It now also asserts the painted box is between 8 and 40px, that no child
overflows its row, and that no row exceeds 60px tall. Putting the unsized version back
reports `photoBoxes: ["64x64","64x64"], photosSized: 0, tallestRow: 76`.

Fixed a flaky check in the same pass: "every modal New Chat opens is actually on screen"
measured 120ms after adding `.on`, while `.nc_modal-overlay` fades in over 280ms, and
`seen()` checks opacity -- so a perfectly good modal reported hidden at random. It now waits
for opacity to settle. A check that fails at random is worse than no check: it trains you to
re-run until it is green.

**The client picker was removed the same day.** It shipped as a client + department
picker, then grew a "Client not in this list…" escape hatch, and was then asked for as
simply "the same thing the Teams card has". The Clients "+" is now one more entry in
`wireCardActions`, opening `nc_newChannelModal` exactly as the Teams "+" does.

That first shipped with the channel landing under **Teams**, since it has no `client_id`,
and it was reported straight back: a channel created under Clients appearing under Teams is
the sidebar disagreeing with the click that made it. It now carries `kind = 'client_dept'`
and is placed in the Clients card.

`client_id` stays null on purpose. Creating a `clients` row from a typed channel name would
put a half-made client into Management, Billing and the Members matrix, none of which asked
for one. `kind` is what the sidebar groups on, and that is all this needs. The consequence
is that such a channel has no Management tabs -- `isClient` requires a `client_id` -- which
is right: there is no client record to manage.

Placement needed its own pass in `renderNavCards`. The channel loop skips `client_dept`
rows (they are not team channels) and the client loop walks `ncClients`, so a client
conversation with no client record was reachable by neither and would have fallen out of
the sidebar entirely.

Audit check 10 grew a leg while doing this. Removing the picker's markup and leaving its
`openModal` call behind produced a button that did nothing and said nothing, and nothing
caught it: check 10 only compared SCREENS, so an id in no markup at all was skipped rather
than flagged. It now reports "no element with that id exists".

**Where it belongs is now a field, not a flag (2026-08-25).** Deciding the destination from
which card was pressed worked, but it was invisible: the form looked identical either way
and you found out where the channel went afterwards. `nc_newChannelModal` now has a
Team/Client row above Privacy, pre-selected from the card that opened it and changeable, so
one form serves both and says which it is doing.

Watch the option grids: both rows are `.nc_m-role` inside the same modal, and the original
click handler cleared every `.nc_m-role` in the modal -- so picking Client also cleared
Public and the channel came out private. Selection is scoped to `el.parentElement` now, and
the check asserts privacy is untouched by a type click. Same for the reads at submit:
`[data-priv].nc_sel` and `[data-ctype].nc_sel`, never the bare class.

### A client channel needs a client — the database says so (2026-08-25)

Marking a Clients-card channel `kind = 'client_dept'` with a null `client_id` failed in
production with `channels_client_dept_needs_client`. That constraint is in
`20260821100000_channels_chat3_shape.sql`, written on this branch, with the reason stated:
*a client_dept thread without a client is meaningless, and would render as a department tab
strip attached to nothing.* The design was wrong, not the constraint.

Choosing Client in the create form now reveals a **Client** and a **Department** select and
requires the client, which is exactly what the row needs to be legal. Nothing invents a
`clients` record.

**The mock now enforces the channels CHECK constraints** — `channels_kind_check`,
`channels_department_check`, `channels_client_dept_needs_client` — and returns PostgREST's
`23514`. It previously stored whatever it was given, so the click-through went green on a
build that failed against the real database the moment a person pressed the button. The
check inserts a deliberately illegal row and requires the refusal.

### Clients with no conversation are no longer listed

They used to appear as a dimmed "No conversation yet" row that started one on click. After
delete that read as the delete having failed -- the client sat there looking undeleted --
and with 53 client records, most without a channel, the card was mostly rows for
conversations that do not exist. Starting one goes through the "+" now, which asks for the
client and the department.

Two checks encoded the old rule and were rewritten rather than dropped: "all 53 clients are
listed" became "only clients with a conversation are listed" (counted from the fixture, not
hardcoded), and "clients without a channel render dimmed" became "no client is listed
without a conversation".

### The id-mismatch sweep (2026-08-25)

"Schedule message not working" turned out to be the same fault as the modals: the whole
feature came across with the ORIGINAL chat's ids, so its chevrons and pills wired that
chat's composer, which sits on a hidden screen. The modal, popover and body are outside
every screen and deliberately shared; only the triggers were wrong.

Two audit checks now cover the class, and both were verified against the previous commit:

- **12** — any id looked up through `getElementById` / `$()` / `querySelector('#…')` that
  belongs to another screen. Ids outside every screen are fine and expected.
- **13** — any bare string literal naming an id that has an `nc_` twin. Check 12 cannot see
  an id passed as an argument (`wireScheduleChevron('chatScheduleBtn')`), and 13 is what
  catches those. The twin is what makes it high signal: New Chat was given its own element
  and the code still names the other one.

Check 13 found **twelve** more on its first run, all real: the entire formatting toolbar,
both composers. Bold, italic, underline, strike and code were bound to the other chat's
buttons, the Cmd-B/I/U/E shortcuts listened on the other chat's inputs, and worst of all
`applyChatFormat` compared `activeElement.id` against `'chatInput'`/`'threadInput'` -- ids
nothing on this screen can ever have -- so it fell through to the channel composer every
time and formatting pressed inside a THREAD wrote into the channel box.

Two mock fidelity gaps closed alongside: column DEFAULTs (`scheduled_messages.status` is
`'pending'`, and without it a freshly scheduled message was invisible to the pill's own
query, so the count sat at zero on a feature that works), and the channels CHECK
constraints.

**Check 14 — does New Chat have everything Chat has?** Asked structurally: every id on the
original chat screen must have an `nc_` twin on New Chat's. It reports the answer as of
2026-08-25: 133 controls on the old screen, 157 on the new, and the only one without a twin
is `newChannelParent`, removed on request and pinned in a `DROPPED` map with its reason.

The three id checks now cover the shapes this branch actually shipped:
- **14** a control that never came across at all,
- **12** a control that exists but is looked up by the other screen's id,
- **13** an id handed around as a string argument.

None of them proves a control DOES the right thing — that is the click-through's job, and it
is at 86 checks. What they do is make "did we miss a feature" a question with an answer
rather than a hope.

### The Client/Department selects came out again (2026-08-25)

Asked for, then asked away. What is left is the smallest form that answers the only
question it needs to: Team or Client. A client channel created there has no `client_id` and
no `department`.

That required dropping `channels_client_dept_needs_client`
(migration `20260825120000_client_channel_without_record.sql`). The reason that constraint
was written -- "a department tab strip attached to nothing" -- is handled in the client:
`isClient` requires a `client_id`, so a client_dept channel without one renders as a plain
conversation in the Clients card with no department strip and no Management panel. The
constraint was blocking something the UI gets right.

Half of it was kept and made explicit: `channels_department_needs_client` -- a department
still implies a client, because a department tab means nothing without one. The mock
enforces the new pair, and the check inserts a client_dept row WITH a department and no
client and requires the refusal.

**This migration must be applied for the feature to work in production.** Until it is,
pressing Create with Client selected fails with the old constraint. It only relaxes, so no
existing row can be invalidated; reverting means restoring the CHECK from 20260821100000.
