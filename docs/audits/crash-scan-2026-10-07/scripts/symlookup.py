import sys
sym, rva = sys.argv[1], int(sys.argv[2], 16)
files = {}; best=None; lines=[]; inl=[]; inlorig={}
cur=None
with open(sym, encoding='utf-8', errors='replace') as f:
    for ln in f:
        if ln.startswith('FILE '):
            _, i, p = ln.rstrip('\n').split(' ', 2); files[i]=p
        elif ln.startswith('INLINE_ORIGIN '):
            _, i, n = ln.rstrip('\n').split(' ', 2); inlorig[i]=n
        elif ln.startswith('FUNC '):
            parts = ln.rstrip('\n').split(' ')
            if parts[1]=='m': parts.pop(1)
            a, sz = int(parts[1],16), int(parts[2],16)
            cur = (a, sz, ' '.join(parts[4:])) if a <= rva < a+sz else None
            if cur: best=cur
        elif ln.startswith('INLINE ') and cur:
            inl.append(ln.strip())
        elif cur and ln[0] in '0123456789abcdef':
            p = ln.split()
            a, sz = int(p[0],16), int(p[1],16)
            if a <= rva < a+sz: lines.append((p[2], files.get(p[3]), hex(a)))
print("FUNC", best and (hex(best[0]), hex(best[1]), best[2]))
print("LINE", lines)
for l in inl:
    p=l.split(); # INLINE depth call_line call_file origin [addr size]+
    rs=list(zip(p[5::2],p[6::2]))
    if any(int(a,16)<=rva<int(a,16)+int(s,16) for a,s in rs):
        print("INLINED depth",p[1],"origin",inlorig.get(p[4]),"called at",files.get(p[3]),p[2])
