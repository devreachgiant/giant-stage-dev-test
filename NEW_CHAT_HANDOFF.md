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
node tools_newchat_clickthrough.mjs      # 59 checks in a headless browser, ~80s
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

When screenshots cannot be sent (a conversation exhausts its image budget and then rejects
every image regardless of size), measuring them with PIL through the shell genuinely works —
it found the accordion (card boundaries 234px vs 362px) and the duplicate badges (three red
blobs on one row, 82px apart).
