"""Every inline <script> in index.html must parse. `node --check` cannot be pointed at an
HTML file, and counting the blocks -- which is what was being done -- says nothing about
whether they parse: an unbalanced paren inside newChatModule left the audit clean, the
block count right, and the entire module dead at runtime, which the click-through then
reported as fifty unrelated failures."""
import re, subprocess, sys, tempfile, os
S = open('/Users/nischaypandya/Desktop/AI/Projects/giant/index.html').read()
blocks = re.findall(r'<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>', S, re.S)
bad = 0
for i, b in enumerate(blocks):
    with tempfile.NamedTemporaryFile('w', suffix='.js', delete=False) as f:
        f.write(b); path = f.name
    r = subprocess.run(['node', '--check', path], capture_output=True, text=True)
    os.unlink(path)
    if r.returncode:
        bad += 1
        print(f'block {i}: SYNTAX ERROR')
        print('   ' + '\n   '.join(r.stderr.strip().splitlines()[:6]))
print(f'\n{len(blocks)} inline blocks, {bad} with syntax errors')
print('RESULT:', 'clean' if not bad else f'{bad} problem(s)')
sys.exit(1 if bad else 0)
