"""The isolation check for the original Chat & Huddles screen.

For 44 commits the rule was "the three original-chat regions are byte-identical to
`main`", and a bare `assert ... in open('index.html').read()` was enough. That rule has
now been broken once, on purpose: the channel header's member count was the workspace
profile count in BOTH chats, and the decision was to fix both rather than let the two
screens disagree. See "Known, not fixed" history in NEW_CHAT_HANDOFF.md.

So the check cannot be "unchanged" any more, and "I'll remember" is not a check. Instead:
take main's region, apply the one approved change to it, and require THAT to appear
verbatim. Anything else that touches the original chat -- a global rename leaking across,
which has happened once already -- still fails, because the approved patch is pinned to
exact text on both sides.

To approve a further change: add an entry to ALLOWED with the exact before/after text and
a reason. Nothing else in this file should need editing.

    python3 tools_newchat_isolation.py     ->  RESULT: clean
"""

BEFORE_HEAD_MEMBERS = '      const container = document.getElementById(\'chatHeadMembers\');\n        if (container) container.innerHTML = \'\';\n      }\n      // Focus input\n      setTimeout(() => chatInput && chatInput.focus(), 100);\n    }\n\n    async function renderChatHeadMembers() {\n      const container = document.getElementById(\'chatHeadMembers\');\n      if (!container) return;\n      // OPTIMIZATION: use the chatProfilesCache that hydrateAllWorkspaceProfiles populated at boot.\n      // Avoids 2 DB queries on every channel switch.\n      const cachedProfiles = Object.values(chatProfilesCache || {}).filter(p => p && p.id);\n      const data = cachedProfiles.length >= 1 ? cachedProfiles.slice(0, 5) : null;\n      if (!data || !data.length) {\n        container.innerHTML = \'\';\n        return;\n      }\n      container.innerHTML = data.map(p => {\n        const initial = (p.full_name || p.email || \'?\').charAt(0).toUpperCase();\n        if (p.avatar_url) {\n          return `<div class="m" style="background-image:url(${chatEsc(p.avatar_url)});background-size:cover;"></div>`;\n        }\n        return `<div class="m" style="background:${chatEsc(p.avatar_bg||\'#4A2424\')};color:${chatEsc(p.avatar_fg||\'#F0A0A0\')};">${chatEsc(initial)}</div>`;\n      }).join(\'\');\n      // Use cached count instead of a second DB query\n      const headTopic = document.getElementById(\'chatHeadTopic\');\n      if (headTopic) {\n        const c = chatChannels.find(x => x.id === activeChannelId);\n        const baseTopic = c?.description || (c?.is_private ? \'Private channel\' : \'Public channel\');\n        const count = cachedProfiles.length;\n        headTopic.textContent = `${baseTopic} · ${count} member${count===1?\'\':\'s\'}`;\n      }\n    }\n'

AFTER_HEAD_MEMBERS = '      const container = document.getElementById(\'chatHeadMembers\');\n        if (container) container.innerHTML = \'\';\n      }\n      // Focus input\n      setTimeout(() => chatInput && chatInput.focus(), 100);\n    }\n\n    async function renderChatHeadMembers() {\n      const container = document.getElementById(\'chatHeadMembers\');\n      if (!container) return;\n      const channelId = activeChannelId;\n      // chatProfilesCache holds every profile hydrateAllWorkspaceProfiles loaded at boot,\n      // so counting it reported the whole workspace on every non-DM channel regardless of\n      // who was actually in it — a channel with one member read "81 members". The\n      // membership has to be asked for; the avatars still come out of the cache, so this\n      // is one extra query per channel switch rather than the two the old comment avoided.\n      let memberIds = null;\n      if (channelId) {\n        const { data: mem, error: memErr } = await supabase\n          .from(\'channel_members\').select(\'profile_id\').eq(\'channel_id\', channelId);\n        if (!memErr && Array.isArray(mem)) memberIds = mem.map(m => m.profile_id);\n      }\n      if (channelId !== activeChannelId) return;   // switched channel while that was in flight\n      const cachedProfiles = Object.values(chatProfilesCache || {}).filter(p => p && p.id);\n      // A failed query falls back to the old behaviour, so this is never worse than before.\n      const known = memberIds\n        ? memberIds.map(id => chatProfilesCache[id]).filter(p => p && p.id)\n        : cachedProfiles;\n      const count = memberIds ? memberIds.length : cachedProfiles.length;\n      // The count is written before the avatars, and outside their empty-list early\n      // return, so a channel whose members are not all in the profile cache still shows\n      // the right number instead of silently keeping the previous channel\'s.\n      const headTopic = document.getElementById(\'chatHeadTopic\');\n      if (headTopic) {\n        const c = chatChannels.find(x => x.id === activeChannelId);\n        const baseTopic = c?.description || (c?.is_private ? \'Private channel\' : \'Public channel\');\n        headTopic.textContent = `${baseTopic} · ${count} member${count===1?\'\':\'s\'}`;\n      }\n      const data = known.slice(0, 5);\n      if (!data.length) {\n        container.innerHTML = \'\';\n        return;\n      }\n      container.innerHTML = data.map(p => {\n        const initial = (p.full_name || p.email || \'?\').charAt(0).toUpperCase();\n        if (p.avatar_url) {\n          return `<div class="m" style="background-image:url(${chatEsc(p.avatar_url)});background-size:cover;"></div>`;\n        }\n        return `<div class="m" style="background:${chatEsc(p.avatar_bg||\'#4A2424\')};color:${chatEsc(p.avatar_fg||\'#F0A0A0\')};">${chatEsc(initial)}</div>`;\n      }).join(\'\');\n    }\n'

import subprocess, sys

REGIONS = [(7198, 7707, 'chat screen markup'),
           (41674, 47173, 'chat engine'),
           (67519, 67870, 'per-channel sub-tabs')]

# (region index, before, after, why) -- before must occur exactly once in main's region.
BEFORE_CLIENT_CHANNELS = (
    "      .select('id, name, slug, description, is_private, is_dm, dm_pair, emoji, position, section_id')\n")
AFTER_CLIENT_CHANNELS = (
    "      .select('id, name, slug, description, is_private, is_dm, dm_pair, emoji, position, section_id, kind')\n")

BEFORE_SPLIT = (
    "      // Separate regular channels and DMs\n"
    "      const allChannels = data || [];\n")
AFTER_SPLIT = (
    "      // Separate regular channels and DMs\n"
    "      // New Chat's client conversations are excluded. They are public so the whole team\n"
    "      // can read them there, and public means this screen would otherwise list all of\n"
    "      // them -- one per client, plus a row per department -- in a sidebar that has never\n"
    "      // had them and where they mean nothing. Approved exception to the isolation rule,\n"
    "      // pinned in tools_newchat_isolation.py; the only other one is the member count.\n"
    "      const allChannels = (data || []).filter(c => c.kind !== 'client_dept');\n")

BEFORE_SCHED_FOR = "    async function scheduleFor(date){\n"
AFTER_SCHED_FOR = (
    "    async function scheduleFor(date){\n"
    "      // Shared with New Chat: one modal, one Save button, two modules listening. Without\n"
    "      // this, scheduling from either screen wrote two rows into two different channels.\n"
    "      if (!document.querySelector('.screen[data-screen=\"chat\"].on')) return;\n")

BEFORE_SCHED_SAVE = "    async function saveCustomSchedule(date){\n"
AFTER_SCHED_SAVE = (
    "    async function saveCustomSchedule(date){\n"
    "      if (!document.querySelector('.screen[data-screen=\"chat\"].on')) return;\n")

# "Load earlier messages" scrolled you to the newest message -- the opposite of the button
# -- because every render ended by scrolling to the bottom, paging included. Fixed in both
# chats by explicit decision: people are told Old Chat is still there during the beta, so
# leaving the same bug in it would be leaving it for whoever took that advice.
BEFORE_PAGE_RENDER = '''    async function renderMessages(msgs) {
      // Mark as bulk render so the CSS animation rule is bypassed during this bulk insertion'''
AFTER_PAGE_RENDER = '''    // opts.preserveScroll -- older messages being added ABOVE what you are reading, so
    // this render must not touch the scroll. Same fix as Chat: every render scrolled to
    // the newest message unconditionally, so "Load earlier messages" sent you to the
    // bottom, the opposite of what the button says.
    async function renderMessages(msgs, opts) {
      const preserveScroll = !!(opts && opts.preserveScroll);
      // Mark as bulk render so the CSS animation rule is bypassed during this bulk insertion'''

BEFORE_PAGE_TRUNC = '''      if (msgs.length > 500) {'''
AFTER_PAGE_TRUNC = '''      if (!preserveScroll && msgs.length > 500) {'''

BEFORE_PAGE_SCROLL = '''      requestAnimationFrame(() => requestAnimationFrame(doScroll));
      // Also retry after 100ms in case avatars load late
      setTimeout(doScroll, 120);'''
AFTER_PAGE_SCROLL = '''      if (!preserveScroll) {
        requestAnimationFrame(() => requestAnimationFrame(doScroll));
        // Also retry after 100ms in case avatars load late
        setTimeout(doScroll, 120);
      }'''

BEFORE_PAGE_ANCHOR = '''      const prevTop = msgsContainer ? msgsContainer.scrollTop : 0;'''
AFTER_PAGE_ANCHOR = '''      const prevTop = msgsContainer ? msgsContainer.scrollTop : 0;
      window._chatStickToBottom = false;
      // Anchored on the message at the top of the view rather than a height difference,
      // which is still settling while avatars and images load.
      const firstEl = chatMsgsList ? chatMsgsList.querySelector('.msg[data-msg-id]') : null;
      const anchorId = firstEl ? firstEl.dataset.msgId : null;
      const anchorTop = (firstEl && msgsContainer)
        ? firstEl.getBoundingClientRect().top - msgsContainer.getBoundingClientRect().top
        : 0;'''

BEFORE_PAGE_CALL = '''      await renderMessages(cache.msgs);'''
AFTER_PAGE_CALL = '''      await renderMessages(cache.msgs, { preserveScroll: true });'''

BEFORE_PAGE_RESTORE = '''      // Preserve scroll position so the view doesn't jump
      requestAnimationFrame(() => {
        if (!msgsContainer) return;
        const newHeight = msgsContainer.scrollHeight;
        msgsContainer.scrollTop = newHeight - prevHeight + prevTop;
      });'''
AFTER_PAGE_RESTORE = '''      // Put the message you were reading back where it was, and keep putting it back as
      // avatars and images above it finish loading.
      const keepPlace = () => {
        if (!msgsContainer) return;
        window._chatStickToBottom = false;
        const el = anchorId ? chatMsgsList.querySelector(`.msg[data-msg-id="${anchorId}"]`) : null;
        if (!el) { msgsContainer.scrollTop = msgsContainer.scrollHeight - prevHeight + prevTop; return; }
        const delta = (el.getBoundingClientRect().top - msgsContainer.getBoundingClientRect().top) - anchorTop;
        if (Math.abs(delta) > 1) msgsContainer.scrollTop += delta;
      };
      keepPlace();
      requestAnimationFrame(keepPlace);
      [60, 160, 320, 600].forEach(ms => setTimeout(keepPlace, ms));'''

_PAGING_WHY = ('"Load earlier messages" scrolled to the newest message, the opposite of '
               'the button; fixed in both chats by explicit decision, since Old Chat is '
               'what people were told to fall back to during the beta')

# A message's text node carries data-msg-id as well as the message itself, so
# '#chatMsgsList [data-msg-id]' matched both and attached a second reaction bar INSIDE the
# text. Double-clicking to edit then read the bar as part of the message and typed
# 👍❤️🔥😂🎉 into the edit box. Fixed in both chats by explicit decision.
BEFORE_BAR_SELECTOR = '''    function reattachReactBarsForChannel(channelId) {
      const msgEls = document.querySelectorAll('#chatMsgsList [data-msg-id]');'''
AFTER_BAR_SELECTOR = '''    function reattachReactBarsForChannel(channelId) {
      // .msg, not any [data-msg-id]: the message's text node carries data-msg-id too, so
      // a bare selector attached a SECOND reaction bar inside the text, and double-clicking
      // to edit then typed \U0001F44D\u2764\uFE0F\U0001F525\U0001F602\U0001F389 into the edit box.
      const msgEls = document.querySelectorAll('#chatMsgsList .msg[data-msg-id]');'''

BEFORE_BAR_GUARD = '''    function attachReactBarToMsg(msgEl, messageId, isMine) {
      if (msgEl.querySelector('.msg-react-bar')) return;'''
AFTER_BAR_GUARD = '''    function attachReactBarToMsg(msgEl, messageId, isMine) {
      // Never inside the text of a message: anything in the body element becomes part of
      // what the message says as far as innerText, editing and copying are concerned.
      if (!msgEl || msgEl.hasAttribute('data-msg-body')) return;
      if (msgEl.querySelector('.msg-react-bar')) return;'''

BEFORE_ATT_SELECTOR = '''        // Load attachments + render
        const msgEls = document.querySelectorAll('#chatMsgsList [data-msg-id]');'''
AFTER_ATT_SELECTOR = '''        // Load attachments + render. .msg, not any [data-msg-id]: the text node carries
        // the id too, so this rendered every attachment a second time inside the text.
        const msgEls = document.querySelectorAll('#chatMsgsList .msg[data-msg-id]');'''

_BAR_WHY = ('a bare [data-msg-id] selector also matched the message text node, so a second '
            'reaction bar was attached inside the message body and double-clicking to edit '
            'typed the emoji bar into the edit box; fixed in both chats by explicit decision')

ALLOWED = [(1, BEFORE_BAR_SELECTOR, AFTER_BAR_SELECTOR, _BAR_WHY),
           (1, BEFORE_BAR_GUARD, AFTER_BAR_GUARD, _BAR_WHY),
           (1, BEFORE_ATT_SELECTOR, AFTER_ATT_SELECTOR, _BAR_WHY + ' (same selector, attachments)'),
           (1, BEFORE_PAGE_RENDER, AFTER_PAGE_RENDER, _PAGING_WHY),
           (1, BEFORE_PAGE_TRUNC, AFTER_PAGE_TRUNC, _PAGING_WHY + ' (the cap drops the oldest, which is what paging just fetched)'),
           (1, BEFORE_PAGE_SCROLL, AFTER_PAGE_SCROLL, _PAGING_WHY),
           (1, BEFORE_PAGE_ANCHOR, AFTER_PAGE_ANCHOR, _PAGING_WHY),
           (1, BEFORE_PAGE_CALL, AFTER_PAGE_CALL, _PAGING_WHY),
           (1, BEFORE_PAGE_RESTORE, AFTER_PAGE_RESTORE, _PAGING_WHY),
           (1, BEFORE_SCHED_FOR, AFTER_SCHED_FOR,
            'the schedule modal is one set of elements shared by both chats and both '
            'modules listen to it, so one click scheduled the message twice, into two '
            'different channels; each module now acts only while its own screen is on'),
           (1, BEFORE_SCHED_SAVE, AFTER_SCHED_SAVE,
            'the same double-send through the custom Save button'),
           (1, BEFORE_HEAD_MEMBERS, AFTER_HEAD_MEMBERS,
            'the channel header counted every workspace profile instead of the channel\'s '
            'members; fixed in both chats by explicit decision, not a leak'),
           (1, BEFORE_CLIENT_CHANNELS, AFTER_CLIENT_CHANNELS,
            'old chat reads `kind` so it can skip New Chat\'s client conversations'),
           (1, BEFORE_SPLIT, AFTER_SPLIT,
            'client conversations are public now, so old chat would otherwise list every '
            'one of them in a sidebar that has never had them; hidden by explicit decision'),
           # A group DM was labelled with channels.name, which names everyone EXCEPT the
           # creator -- so the viewer saw their own name and never the person who had
           # written to them. Fixed in New Chat first; Nishchay asked for both, since a
           # wrong name is wrong on whichever screen somebody happens to be reading.
           # Two copies, told apart by their indentation: the sidebar list and the picker.
           (1,
            "\n          const label = (c.name && c.name.trim()) ? c.name : (names.join(', ') || 'Group');",
            "\n          const label = names.join(', ') || (c.name && c.name.trim()) || 'Group';",
            'a group DM was named from channels.name, which lists everyone but its creator, '
            'so the viewer was shown their own name as the conversation; fixed in both chats '
            'by explicit decision (sidebar list)'),
           (1,
            "\n            const label = (c.name && c.name.trim()) ? c.name : (names.join(', ') || 'Group');",
            "\n            const label = names.join(', ') || (c.name && c.name.trim()) || 'Group';",
            'the same wrong name in the other copy (the picker)')]

# The baseline is the last commit BEFORE New Chat was merged into main, not main itself.
# Once the branch landed, "main:index.html" became the file this tool is checking, so it
# was comparing the file against itself -- and the line ranges below, which are positions
# in the pre-merge file, then pointed at entirely different code. Pinned, so the question
# it answers stays "is the original chat still as approved".
BASELINE = '5acfd19'
main = subprocess.run(['git', 'show', BASELINE + ':index.html'],
                      capture_output=True, text=True).stdout.split('\n')
cur = open('index.html').read()

fail = 0
for idx, (a, b, label) in enumerate(REGIONS):
    want = '\n'.join(main[a - 1:b])
    notes = []
    for r, before, after, why in ALLOWED:
        if r != idx:
            continue
        n = want.count(before)
        if n != 1:
            print('  !! approved patch %d does not apply cleanly to %s: '
                  'its "before" text occurs %d times in main (expected 1)' % (r, label, n))
            fail += 1
            continue
        want = want.replace(before, after)
        notes.append(why)
    ok = want in cur
    print('%-22s lines %5d-%-5d  %s' % (label, a, b, 'ok' if ok else 'CHANGED UNEXPECTEDLY'))
    for why in notes:
        print('%-22s   + one approved change: %s' % ('', why))
    if not ok:
        fail += 1

print('\nRESULT:', 'clean' if not fail else '%d region(s) not as expected' % fail)
sys.exit(1 if fail else 0)
