"""Where the ORIGINAL chat lives in index.html, found by text rather than by line.

Two checks need to read only the old chat's code: the audit's document-wide data
attribute test, and the isolation test. Both used to carry hardcoded line numbers.
index.html grows near the top constantly -- adding CSS at line 6600 slides every one of
those numbers down, and the checks then read the wrong region and report on code nobody
asked about. That happened: 402 lines of Growth CSS moved the ranges by 76 lines and the
audit started flagging a leak that was not there.

So the boundaries are the exact text of the first and last line instead. If a boundary
stops being unique -- somebody duplicates it, or edits it away -- this raises rather than
silently measuring the wrong half of the file.
"""

BOUNDS = [
    (".gr_qabl{border-top:1px solid var(--line);padding-top:12px;}",
     "    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';",
     "chat screen markup"),
    ("      if (savedScreen) {",
     "                        : s && s.status === 'paused' ? 'away'",
     "chat engine"),
    ("                <div class=\"shared-packs-item-main\">",
     "            const res = await fetch('/.netlify/functions/share-pack-create', {",
     "per-channel sub-tabs"),
]


def regions(source):
    """[(start_line, end_line, name)], 1-based and inclusive, for this exact file."""
    lines = source.split('\n')
    out = []
    for first, last, name in BOUNDS:
        a = [i + 1 for i, l in enumerate(lines) if l == first]
        b = [i + 1 for i, l in enumerate(lines) if l == last]
        if len(a) != 1 or len(b) != 1:
            raise SystemExit(
                'tools_newchat_regions: the %s boundary is no longer unique '
                '(%d starts, %d ends). Fix the anchor in tools_newchat_regions.py.'
                % (name, len(a), len(b)))
        if b[0] < a[0]:
            raise SystemExit('tools_newchat_regions: %s ends before it starts.' % name)
        out.append((a[0], b[0], name))
    return out


def text(source):
    """The old chat's code, the three regions joined."""
    lines = source.split('\n')
    return '\n'.join('\n'.join(lines[a - 1:b]) for a, b, _ in regions(source))
