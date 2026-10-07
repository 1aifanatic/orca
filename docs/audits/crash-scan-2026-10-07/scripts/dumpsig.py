import sys
from minidump.minidumpfile import MinidumpFile
md = MinidumpFile.parse(sys.argv[1])
exc = md.exception.exception_records[0]
rec = exc.ExceptionRecord
addr = rec.ExceptionAddress
print("code", hex(rec.ExceptionCode_raw if hasattr(rec,'ExceptionCode_raw') else int(rec.ExceptionCode.value) if hasattr(rec.ExceptionCode,'value') else rec.ExceptionCode), "addr", hex(addr), "params", [hex(p) for p in rec.ExceptionInformation[:rec.NumberParameters]])
for m in md.modules.modules:
    if m.baseaddress <= addr < m.baseaddress + m.size:
        print("module", m.name, "rva", hex(addr - m.baseaddress))
