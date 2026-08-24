# Resume New Chat — paste the block below into a fresh conversation

Everything between the lines is the prompt. Nothing else is needed; it points at the
two files that hold the detail.

---

Continue the **New Chat** work in this repo. Branch `feature/new-chat-from-chat3` —
44 commits ahead of `main`, **nothing pushed**, working tree clean.

**Read `NEW_CHAT_HANDOFF.md` first.** It has the decisions, the data model, how each port
went, and a "traps hit" section that will save you repeating seven separate bugs.

**What it is:** old *Chat & Huddles* duplicated as *New Chat* and converted to the approved
Chat 3.0 design, running on old chat's real data (10,363 messages). Old chat stays usable
and untouched. New Chat is manager/owner/inhouse_dev only.

**Three rules that are not negotiable:**

1. **The original chat must stay byte-identical to `main`** — regions 7198–7707,
   41674–47173, 67519–67870 of `index.html`. Check after *every* change, not at the end.
   It has caught a real leak (a global string replace renamed the original's tab too).
   ```python
   import subprocess
   old = subprocess.run(['git','show','main:index.html'],capture_output=True,text=True).stdout.split('\n')
   s = open('index.html').read()
   for a,b in [(7198,7707),(41674,47173),(67519,67870)]:
       assert '\n'.join(old[a-1:b]) in s
   ```
2. **Run both checks after every change**, not at the end:
   ```
   python3 tools_newchat_audit.py            # six static checks; expect RESULT: clean
   node tools_newchat_clickthrough.mjs       # 39 checks in a headless browser, ~40s
   ```
   The audit covers six failure modes that all shipped as a clean parse and a broken
   screen: undefined calls including inside `${...}`, bare CONSTANT references, methods on
   a shim object, names visible only inside the nested IIFE, emitted `data-c3-*` actions
   with no listener, and calls to a name that is declared in the module but not in scope
   where it is called. `node --check` on the 10 inline script blocks is necessary and
   nowhere near sufficient — so is the audit, which is why the click-through exists.
3. **Never move messages between channels** to tidy the data model. Duplicate client
   channels are unioned on read via `ncChannelScope()`.

**The click-through is what catches structure.** Two bugs broke three tabs at once and
neither is visible to any static check: a pane parented to the wrong element (all four
ported panes ended up nested inside `.nc_tabstrip`, a flex row, and rendered squeezed into
the tab bar), and a renderer painting the wrong pane (`adapt()` rewrites chat3's `render()`
to `renderMgmt()`, so Tasks and Magnus were repainting the hidden Management pane).
`tools_newchat_clickthrough.mjs` now asserts both — it stands up the app against a mock
Supabase, so it needs no credentials and cannot touch production.

**State:** all ports done — Management, Vault, Media, Client library, Tasks, Magnus,
Master Inbox. Sidebar is Chat 3.0's accordion with all 53 clients listed. One-line tab
strip. Audit clean, click-through 39/39 with no uncaught errors.

**Left to do, in order:**
1. **Push** — 44 commits and 10 migrations. The migrations are already applied to
   production; the code is not. `main` auto-deploys via Netlify, so ask before pushing.
2. **Sign in as a real manager and click through once.** The harness proves the wiring and
   the structure against stand-in data; it proves nothing about production rows — Maribou's
   two Generals unioning, the `-seo` channels landing in SEO, 10,363 messages paginating.
3. Retire `feature/chat3-management-panels` (3 commits, superseded — its panels are ported).
4. `version.json` is `20260724u3`, three releases stale; desktop clients are not being
   told to update.
5. Old chat cannot be retired while New Chat is manager-only — members and clients have no
   other chat surface.

**One known defect, deliberately not fixed:** the channel header's member count is the
workspace profile count, not the channel's. It is pre-existing — the original chat does the
same thing in the same function — so fixing it only in New Chat is a product call. See
"Known, not fixed" in the handoff.

**On screenshots:** a long conversation exhausts its image budget, after which the API
rejects *every* image and reports it as "exceeds 2000 pixels" even for a 334×664 file. That
is misleading — it is not a size problem and resizing does not help. Starting a fresh
conversation (which this is) resets it, so images work again. If it ever recurs, measuring
screenshots with PIL through the shell genuinely works: it found the accordion (card
boundaries 234px vs 362px) and the duplicated reply badges (three red blobs, one row, 82px
apart) without seeing either image.

---

## Where the detail lives

| file | what |
|---|---|
| `NEW_CHAT_HANDOFF.md` | decisions, data model, ports, traps — read first |
| `tools_newchat_audit.py` | the six static checks; run it after every change |
| `tools_newchat_clickthrough.mjs` | 39-check headless click-through; the real gate |
| `tools_newchat_mock_supabase.js` | the stand-in Supabase and its fixtures |
| `git log main..HEAD` | 44 commits, each explaining one decision |

## If you would rather not paste anything

Say "continue the New Chat branch". A project memory points at this file and at the
handoff, so the branch and its rules should surface on their own.
