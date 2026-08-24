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
print("\nRESULT:", "clean" if not fail else f"{fail} problem(s)")
sys.exit(1 if fail else 0)
