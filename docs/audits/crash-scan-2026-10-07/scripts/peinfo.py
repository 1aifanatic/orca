import sys, pefile, struct
pe = pefile.PE(sys.argv[1], fast_load=False)
rva = int(sys.argv[2], 16)
print("ImageBase", hex(pe.OPTIONAL_HEADER.ImageBase), "TimeDateStamp", hex(pe.FILE_HEADER.TimeDateStamp), "SizeOfImage", hex(pe.OPTIONAL_HEADER.SizeOfImage))
for s in pe.sections:
    print(s.Name.rstrip(b'\0'), hex(s.VirtualAddress), hex(s.Misc_VirtualSize))
for d in getattr(pe, 'DIRECTORY_ENTRY_DEBUG', []):
    e = d.entry
    if e and hasattr(e, 'Signature_String'):
        print("PDB", e.PdbFileName, e.Signature_String, e.Age)
# find function via .pdata
for rf in pe.DIRECTORY_ENTRY_EXCEPTION:
    s = rf.struct
    if s.BeginAddress <= rva < s.EndAddress:
        print("RUNTIME_FUNCTION", hex(s.BeginAddress), hex(s.EndAddress))
        break
