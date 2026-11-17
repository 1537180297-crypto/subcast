#!/usr/bin/env python3
"""Prints the DLLs a Windows PE file imports. With --forbid NAME..., exits 1 if any of them is imported.
Used in CI so subcast.exe never again needs the Visual C++ Redistributable."""
import struct, sys

def imports(path):
    b = open(path, "rb").read()
    pe = struct.unpack_from("<I", b, 0x3C)[0]
    nsec, optsz = struct.unpack_from("<H", b, pe + 6)[0], struct.unpack_from("<H", b, pe + 20)[0]
    opt = pe + 24
    dd = opt + (112 if struct.unpack_from("<H", b, opt)[0] == 0x20B else 96)
    rva = struct.unpack_from("<I", b, dd + 8)[0]
    secs = [struct.unpack_from("<8sIIII", b, opt + optsz + i * 40) for i in range(nsec)]
    def off(r):
        for _, vs, va, rs, ro in secs:
            if va <= r < va + max(vs, rs): return r - va + ro
        raise ValueError("bad rva")
    out, o = [], off(rva)
    while (name := struct.unpack_from("<I", b, o + 12)[0]):
        n = off(name); out.append(b[n:b.index(b"\0", n)].decode()); o += 20
    return out

if __name__ == "__main__":
    args = sys.argv[1:]
    forbid = [x.lower() for x in args[args.index("--forbid") + 1:]] if "--forbid" in args else []
    files = args[:args.index("--forbid")] if "--forbid" in args else args
    bad = False
    for f in files:
        dlls = imports(f)
        print(f, ", ".join(dlls))
        hit = [d for d in dlls if d.lower() in forbid]
        if hit: print(f"::error::{f} imports {', '.join(hit)}"); bad = True
    sys.exit(1 if bad else 0)
