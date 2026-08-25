"""Full audit of newChatModule. Catches the three things that each shipped a runtime
error: calls (incl. inside ${...}), bare CONSTANT references, and methods called on a
shim object. Scope-aware enough to spot names visible only inside the nested IIFE."""
import re, sys
S=open('/Users/nischaypandya/Desktop/AI/Projects/giant/index.html').read()
nc=S[S.index('(function newChatModule(){'):]; nc=nc[:nc.index('\n})();\n</script>')]
c3=S[S.index('(function chat3Module(){'):]; c3=c3[:c3.index('\n})();\n</script>')]

def calls_in(t):
    t=re.sub(r'//[^\n]*','',t); t=re.sub(r'/\*.*?\*/','',t,flags=re.S)
    interp=' ; '.join(re.findall(r'\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}', t))
    plain=re.sub(r'`(?:[^`\\]|\\.)*`',' ',t)
    both=plain+' ; '+interp
    both=re.sub(r"'(?:[^'\\]|\\.)*'","''",both); both=re.sub(r'"(?:[^"\\]|\\.)*"','""',both)
    return both

body=calls_in(nc)
defined=set(re.findall(r'\b(?:async\s+)?function\s+(\w+)', nc))|set(re.findall(r'\b(?:const|let|var)\s+(\w+)', nc))
BUILT={'if','for','while','switch','catch','return','typeof','await','new','Math','Object','Array','String','Number','Date','JSON','Promise','setTimeout','setInterval','clearTimeout','parseInt','parseFloat','Set','Map','encodeURIComponent','decodeURIComponent','confirm','alert','RegExp','Error','fetch','isNaN','navigator','console','document','window','toast','var','function','async','URL','Blob','FormData','atob','btoa','requestAnimationFrame','MutationObserver','crypto','Intl','Boolean'}
GLOB={'openModal','closeModal','openTaskDetailPanel','loadProjectTasks','loadFocusTasks','navigateToScreen','queryWithRetry'}
CSSNOISE={'big','minmax','mix','repeat','rgba','translateX','translateY','scale','var','calc','url'}
# Browser globals, and words that only appear inside prose or as parameters -- the
# regex cannot tell a call from `reject(` in a Promise body or `$&` in a regex escape.
BUILT|={'AbortController','Image','IntersectionObserver','ResizeObserver','FileReader','AudioContext','MediaRecorder','Notification','reject','resolve'}
CSSNOISE|={'$','Ended','responses','unavailable','promiseFactory'}
fail=0

calls=set(re.findall(r'(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(', body))
miss=sorted(calls-defined-BUILT-GLOB-CSSNOISE)
print("1. undefined calls:", miss or "none"); fail+= len(miss)

consts=set(re.findall(r'(?<![\w.$])([A-Z][A-Z0-9_]{3,})(?![\w$])', body))
cdecl=set(re.findall(r'\b(?:const|let|var)\s+([A-Z][A-Z0-9_]{3,})', nc))
CONST_NOISE={'SCOPE','CLIENTS','TIME','LOGGED','NOTES'}   # appear only inside template prose
cmiss=[c for c in sorted(consts-cdecl-CONST_NOISE) if re.search(r'\b(?:const|let|var)\s+'+c+r'\b', c3)]
print("2. undefined constants (exist in chat3):", cmiss or "none"); fail+=len(cmiss)

for shim in ['ncIcon']:
    used=set(re.findall(shim+r'\.(\w+)\s*\(', nc))
    i=nc.find('const '+shim+' =')
    have=set()
    if i>=0:
        d=0
        for k in range(i,len(nc)):
            if nc[k]=='{': d+=1
            elif nc[k]=='}':
                d-=1
                if d==0: have=set(re.findall(r'(\w+)\s*:', nc[i:k])); break
    m=sorted(used-have)
    print("3. %s methods missing:" % shim, m or "none"); fail+=len(m)

k=nc.find('// -- per-channel sub-tabs')
if k>0:
    outer,inner=nc[:k],nc[k:]
    inner_fns=set(re.findall(r'\b(?:async\s+)?function\s+(\w+)', inner))
    outer_names=set(re.findall(r'\b(?:async\s+)?function\s+(\w+)', outer))|set(re.findall(r'\b(?:const|let|var)\s+(\w+)', outer))
    leak=[f for f in sorted(inner_fns-outer_names) if re.search(r'(?<![\w.$])'+f+r'\s*\(', calls_in(outer))]
    print("4. called outside the nested IIFE but defined only inside:", leak or "none"); fail+=len(leak)

emit=set(re.findall(r'data-(c3-[\w-]+)="', nc)); listen=set(re.findall(r"\[data-(c3-[\w-]+)\]", nc))
print("5. emitted actions with no listener:", sorted(emit-listen) or "none"); fail+=len(emit-listen)

# ---------------------------------------------------------------------------
# 6. Declared in this module, but not in scope where it is called.
#
# Check 4 only guards one hard-coded boundary, the sub-tabs IIFE, so it missed
# fmtTime: the Master Inbox called it, the name WAS declared in the module -- nested
# inside the scheduled-message code, taking a Date -- and checks 1 and 4 both passed
# while the pane threw a ReferenceError the moment it opened. Grep finds a name;
# only a scope check finds whether the call site can see it.
#
# Deliberately narrow: only names check 1 already proved are declared somewhere. A
# name that is declared nowhere is check 1's business, and restricting to
# declared-somewhere names is what keeps this quiet enough to be worth running --
# object-literal method shorthand and the like read as calls to the regex, but almost
# never collide with a real declaration in a sibling scope.
def sanitize(t):
    """Same-length copy with comments, strings and regex literals blanked -- but the
    inside of `${...}` kept verbatim, since calls live in there. Length is preserved
    so brace depth still lines up with offsets in the original."""
    out=list(t); i=0; n=len(t); stack=[]; prev=''
    while i<n:
        c=t[i]
        if stack and stack[-1][0]=='tmpl':
            if c=='\\': out[i]=' '; out[i+1]=' '; i+=2; continue
            if c=='`': stack.pop(); i+=1; continue
            if c=='$' and i+1<n and t[i+1]=='{': stack.append(['interp',0]); i+=2; continue
            out[i]=' '; i+=1; continue
        if c=='/' and i+1<n and t[i+1]=='/':
            while i<n and t[i]!='\n': out[i]=' '; i+=1
            continue
        if c=='/' and i+1<n and t[i+1]=='*':
            while i<n and not (t[i]=='*' and i+1<n and t[i+1]=='/'):
                if t[i]!='\n': out[i]=' '
                i+=1
            out[i]=' '; out[i+1]=' '; i+=2; continue
        if c in '"\'':
            q=c; out[i]=' '; i+=1
            while i<n:
                if t[i]=='\\': out[i]=' '; out[i+1]=' '; i+=2; continue
                if t[i]==q: out[i]=' '; i+=1; break
                if t[i]!='\n': out[i]=' '
                i+=1
            continue
        if c=='`': stack.append(('tmpl',)); i+=1; continue
        if c=='/' and prev and not re.match(r'[\w$)\]]', prev):
            out[i]=' '; i+=1                      # regex literal, not division
            while i<n:
                if t[i]=='\\': out[i]=' '; out[i+1]=' '; i+=2; continue
                if t[i]=='/': out[i]=' '; i+=1; break
                if t[i]=='\n': break              # unterminated: it was division
                out[i]=' '; i+=1
            while i<n and t[i] in 'gimsuyd': out[i]=' '; i+=1
            prev=')'; continue
        if stack and stack[-1][0]=='interp':
            if c=='{': stack[-1][1]+=1
            elif c=='}':
                if stack[-1][1]==0: stack.pop(); i+=1; continue
                stack[-1][1]-=1
        if not c.isspace(): prev=c
        i+=1
    return ''.join(out)

src=sanitize(nc)
paths=[]; cur=[]; sid=0
for ch in src:
    if ch=='{': sid+=1; cur.append(sid)
    elif ch=='}' and cur: cur.pop()
    paths.append(tuple(cur))

scoped={}
def declare(name, off): scoped.setdefault(name,set()).add(paths[off])
for pat in (r'\b(?:async\s+)?function\s*\*?\s+(\w+)', r'\b(?:const|let|var)\s+(\w+)', r'\bclass\s+(\w+)'):
    for m in re.finditer(pat, src): declare(m.group(1), m.start())
# Parameters, attributed to the scope holding the signature rather than the body. Too
# permissive by one level on purpose: a parameter is never the sibling-scope name this
# check exists to find, and missing them would flag every `cb()` in a callback.
for pat in (r'\bfunction\s*\*?\s*\w*\s*\(([^()]*)\)', r'\(([^()]*)\)\s*=>',
            r'\b(?:const|let|var)\s*[\{\[]([^{}\[\]]*)[\}\]]'):
    for m in re.finditer(pat, src):
        for p in re.findall(r'\w+', m.group(1)): declare(p, m.start())
for pat in (r'(?<![\w.$])(\w+)\s*=>', r'\bcatch\s*\(\s*(\w+)'):
    for m in re.finditer(pat, src): declare(m.group(1), m.start())

KEYWORDS={'if','for','while','switch','catch','return','typeof','await','new','function','async',
          'var','let','const','do','else','case','delete','void','in','of','yield','throw','class',
          'try','finally','instanceof','super','this'}
oos=[]
for m in re.finditer(r'(?<![\w.$])([A-Za-z_$][\w$]*)\s*\(', src):
    name, off = m.group(1), m.start()
    if name in KEYWORDS|BUILT|GLOB|CSSNOISE or name not in scoped: continue
    if re.search(r'window\.'+name+r'\s*=', S): continue          # a page-level global resolves
    if 'typeof '+name in src[max(0,off-90):off]: continue        # guarded optional global
    here=paths[off]
    if any(here[:len(p)]==p for p in scoped[name]): continue
    oos.append(f"{name} (line {nc[:off].count(chr(10))+1} of the module)")
print("6. called out of scope (declared, but not where it is called):", sorted(set(oos)) or "none")
fail+=len(set(oos))

# ---------------------------------------------------------------------------
# 7. A class this module ASSIGNS unprefixed while looking the same name up WITH nc_.
#
# The namespacing pass rewrote class="..." in the markup and missed JS assignments, so
# sixteen classes were created unprefixed and searched for prefixed. Each one is two bugs
# at once: the de-dupe guard that looks for '.nc_x' never matches, so every re-render
# appends another copy -- that is the duplicated reply badge AND the duplicated unread
# badge -- and the element silently picks up the ORIGINAL chat's '.x' CSS, which is the
# leak this branch exists to prevent.
#
# Mechanical, and worth a check precisely because it looks like a cosmetic detail.
assigned = set()
for m in re.finditer(r"\.className\s*=\s*'([^']+)'", nc):
    assigned.update(m.group(1).split())
for m in re.finditer(r"classList\.add\(([^)]*)\)", nc):
    for q in re.findall(r"'([^']+)'", m.group(1)):
        assigned.update(q.split())
looked = set()
for m in re.finditer(r"querySelector(?:All)?\('([^']+)'\)", nc):
    looked.update(re.findall(r"\.([A-Za-z0-9_-]+)", m.group(1)))
for m in re.finditer(r"classList\.(?:contains|toggle|remove)\(([^),]*)", nc):
    looked.update(re.findall(r"'([^']+)'", m.group(1)))
# Six are deliberately shared with the app's own screen/nav machinery.
SHARED = {'screen', 'fullbleed', 'on', 'active', 'badge', 'ico'}
mismatch = sorted(a for a in assigned
                  if not a.startswith('nc_') and a not in SHARED and ('nc_' + a) in looked)
print("7. classes assigned unprefixed but looked up as nc_:", mismatch or "none")
fail += len(mismatch)

# ---------------------------------------------------------------------------
# 8. A DOM data attribute the ORIGINAL chat selects document-wide -- the sixth namespace.
#
# The handoff lists five: DOM ids, CSS classes, window.*, localStorage keys and realtime
# channel names. Data attributes are the sixth, and they leak in a direction none of the
# others do. The original chat's unread painter runs
#   document.querySelectorAll('[data-channel-id], [data-dm-channel-id]')
# -- document-wide, with no id or class in front of it -- so it reached into New Chat's
# sidebar and stamped a second '.ch-unread-badge' beside this module's own. Two red
# badges on one row, written by a module nobody had touched. This module's painter had
# the same selector, so it ran both ways.
#
# Only BARE attribute selectors count. '#chatMsgsList [data-msg-id]' cannot escape its
# own list, and '.msg[data-msg-id]' stopped matching once this module's rows became
# '.nc_msg' -- so data-msg-id is shared and harmless, and flagging it would make this
# check noise. Comments are stripped first, or the paragraph above trips it.
def strip_comments(t):
    t = re.sub(r'//[^\n]*', '', t)
    return re.sub(r'/\*.*?\*/', '', t, flags=re.S)

orig = '\n'.join('\n'.join(S.split('\n')[a - 1:b])
                 for a, b in [(7198, 7707), (41674, 47173), (67519, 67870)])
reach = set()
for m in re.finditer(r"document\.querySelectorAll\(\s*'([^']+)'", strip_comments(orig)):
    for part in m.group(1).split(','):
        part = part.strip()
        if re.fullmatch(r'\[data-([a-z][\w-]*)(?:[^\]]*)\]', part):
            reach.add(re.match(r'\[data-([a-z][\w-]*)', part).group(1))
used = set(re.findall(r'data-([a-z][\w-]*)', strip_comments(nc)))
shared = sorted(a for a in reach & used if not a.startswith('nc-') and not a.startswith('c3-'))
print("8. data attributes the original selects document-wide:", shared or "none")
fail += len(shared)

# ---------------------------------------------------------------------------
# 9. The inverse of check 7: a class this module RENDERS as nc_X but SELECTS as bare .X.
#
# Four places looked up `.msg[data-msg-id="…"]` while every message this module renders is
# `.nc_msg`. That does not fail loudly -- it silently matches the ORIGINAL chat's messages,
# which are `.msg` and sit in the DOM on a hidden screen, so "jump to this message"
# scrolled and highlighted an element nobody could see. Same family as checks 7 and 8:
# two modules, one namespace, and the wrong one answering.
rendered = set(re.findall(r'class="(nc_[\w-]+)', nc)) | set(re.findall(r"className\s*=\s*'(nc_[\w-]+)", nc))
bare = set()
for m in re.finditer(r"querySelector(?:All)?\(\s*[`'\"]([^`'\"]+)", nc):
    bare.update(re.findall(r'\.([A-Za-z][\w-]*)', m.group(1)))
wrong = sorted(c for c in bare if not c.startswith('nc_') and ('nc_' + c) in rendered)
print("9. classes rendered as nc_ but selected bare:", wrong or "none")
fail += len(wrong)

# ---------------------------------------------------------------------------
# 10. A modal opened by id that does not live in New Chat's own screen.
#
# openModal() just adds a class. It cannot tell that `newChannelModal` sits inside
# `<div class="screen" data-screen="chat">`, which is display:none whenever New Chat is
# the active screen -- so the modal "opened" into a hidden subtree and the user saw
# nothing at all. Create channel, New DM, Members, Invite and Pinned were all like this,
# while seven correctly-prefixed modals sat unused in New Chat's own screen.
#
# The same crossing hides in `data-close="X"`: every one of those seven closed the OLD
# chat's copy. Check 8 could not see it -- it matches attribute NAMES the original
# selects, and this is an attribute VALUE naming a foreign id.
def screen_of(mid):
    m = re.search(r'id="%s"' % re.escape(mid), S)
    if not m:
        return None
    depth, i, cur = 0, 0, None
    stack = []
    for tag in re.finditer(r'<(/?)div\b([^>]*)>', S[:m.start()]):
        if tag.group(1):
            if stack: stack.pop()
        elif not tag.group(0).rstrip().endswith('/>'):
            sc = re.search(r'data-screen="([\w-]+)"', tag.group(2))
            stack.append(sc.group(1) if sc else None)
    for name in reversed(stack):
        if name: return name
    return None

opened = sorted(set(re.findall(r"(?:open|close)Modal\(\s*'([^']+)'", strip_comments(nc))))
stray = []
for mid in opened:
    # An id that is in no markup at all is the same failure with the volume turned up:
    # openModal is a no-op, so the click does nothing and says nothing. This is reachable
    # by deleting a modal's markup and leaving the call, which happened once.
    if not re.search(r'id="%s"' % re.escape(mid), S):
        stray.append(f"{mid} (no element with that id exists)")
        continue
    sc = screen_of(mid)
    if sc is not None and sc != 'newchat':
        stray.append(f"{mid} (lives in screen '{sc}')")
print("10. modals opened that live in another screen:", stray or "none")
fail += len(stray)

# ...and the close targets inside New Chat's own modals
crossing = []
for m in re.finditer(r'<div class="nc_modal-overlay" id="(nc_\w+)"', S):
    start = m.start()
    nxt = S.find('<div class="nc_modal-overlay" id="', start + 10)
    seg = S[start:nxt if nxt > 0 else start + 12000]
    for v in set(re.findall(r'data-close="([^"]+)"', seg)):
        if v != m.group(1):
            crossing.append(f"{m.group(1)} closes '{v}'")
print("11. nc_ modals whose close button targets another modal:", crossing or "none")
fail += len(crossing)

# ---------------------------------------------------------------------------
# 12. THE BIG ONE: any element New Chat looks up by an id that belongs to another
# screen. This is the same fault as check 10, which only knew about modals, and it is
# how "Schedule message doesn't work" happened: the whole feature came across with
# unprefixed ids, so its chevrons and pills wired the ORIGINAL chat's composer, which
# sits on a hidden screen. The buttons did nothing and said nothing.
#
# An id outside every screen is fine and deliberate -- the schedule modal and popover
# live at the top of the body and both chats share one.
def owner_screen(mid):
    m = re.search(r'id="%s"' % re.escape(mid), S)
    if not m:
        return None
    stack = []
    for tag in re.finditer(r'<(/?)div\b([^>]*)>', S[:m.start()]):
        if tag.group(1):
            if stack: stack.pop()
        elif not tag.group(0).rstrip().endswith('/>'):
            sc = re.search(r'data-screen="([\w-]+)"', tag.group(2))
            stack.append(sc.group(1) if sc else None)
    for n in reversed(stack):
        if n:
            return n
    return 'global'

body = strip_comments(nc)
looked_up = set()
for pat in (r"getElementById\(\s*'([^']+)'",
            r"\$\(\s*'([^']+)'\s*\)",
            r"querySelector(?:All)?\(\s*'#([\w-]+)"):
    looked_up.update(re.findall(pat, body))
foreign = []
for mid in sorted(looked_up):
    if mid.startswith('nc_') or mid.startswith('c3'):
        continue
    sc = owner_screen(mid)
    if sc and sc != 'global' and sc != 'newchat':
        # is there an nc_ twin sitting unused? then it is certainly the wrong one
        twin = ' [nc_%s exists]' % mid if ('id="nc_%s"' % mid) in S else ''
        foreign.append("%s (in screen '%s')%s" % (mid, sc, twin))
print("12. elements looked up by an id owned by another screen:", foreign or "none")
fail += len(foreign)

# ---------------------------------------------------------------------------
# 13. Check 12 can only see an id written inside getElementById/$/querySelector. The
# schedule chevrons passed theirs as an argument -- wireScheduleChevron('chatScheduleBtn')
# -- and no scan of lookup calls will ever find that.
#
# So: any bare string literal in this module that names an id owned by another screen,
# WHEN an nc_ twin of that id exists. The twin is what makes it high signal: someone
# built New Chat its own element and the code is still naming the other one.
literals = set(re.findall(r"'([A-Za-z][\w-]{2,})'", body))
twinned = []
for lit in sorted(literals):
    if lit.startswith('nc_'):
        continue
    if ('id="nc_%s"' % lit) not in S or ('id="%s"' % lit) not in S:
        continue
    sc = owner_screen(lit)
    if sc and sc not in ('global', 'newchat'):
        twinned.append("'%s' (nc_%s exists, this one is in screen '%s')" % (lit, lit, sc))
print("13. ids named as plain strings while an nc_ twin exists:", twinned or "none")
fail += len(twinned)

print("\nRESULT:", "clean" if not fail else f"{fail} problem(s)")
sys.exit(1 if fail else 0)
