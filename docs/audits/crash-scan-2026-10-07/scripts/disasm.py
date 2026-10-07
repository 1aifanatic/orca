import sys, pefile, capstone
pe = pefile.PE(sys.argv[1], fast_load=True)
start, end = int(sys.argv[2],16), int(sys.argv[3],16)
data = pe.get_data(start, end-start)
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
for i in md.disasm(data, start):
    print(hex(i.address), i.mnemonic, i.op_str)
