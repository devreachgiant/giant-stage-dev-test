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

ALLOWED = [(1, BEFORE_SCHED_FOR, AFTER_SCHED_FOR,
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
            'one of them in a sidebar that has never had them; hidden by explicit decision')]

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
