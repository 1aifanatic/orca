import sys, pefile, hashlib
for p in sys.argv[1:]:
    pe = pefile.PE(p, fast_load=True)
    t = [s for s in pe.sections if s.Name.startswith(b'.text')][0]
    print(hashlib.sha256(t.get_data()).hexdigest(), p)
