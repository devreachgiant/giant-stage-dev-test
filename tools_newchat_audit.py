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

print("\nRESULT:", "clean" if not fail else f"{fail} problem(s)")
sys.exit(1 if fail else 0)
