# Runs once after the interpreter boots, before any sketch. Fills the gaps between the
# WebAssembly build and the rp2 build so firmware written for the Pico imports unchanged.
import builtins, micropython, os, sys, _emu


def _ident(f):
    return f


# @micropython.viper / @micropython.native: no native code generator in WebAssembly, so the
# function runs as plain bytecode. Same result, slower. The builtin module is read-only, so a
# wrapper with the same names takes its place in sys.modules.
class _Wrap:
    pass


_mp = _Wrap()
for _k in dir(micropython):
    if not _k.startswith("__"):
        setattr(_mp, _k, getattr(micropython, _k))
_mp.viper = _ident
_mp.native = _ident
sys.modules["micropython"] = _mp


class _ptr:
    """viper pointer types on a plain buffer: ptr8 is the buffer itself, ptr16/ptr32 do
    little-endian multi-byte access. Slow, but the output matches."""

    def __init__(self, buf, size):
        self.b = buf
        self.s = size

    def __getitem__(self, i):
        o = i * self.s
        return int.from_bytes(self.b[o:o + self.s], "little")

    def __setitem__(self, i, v):
        o = i * self.s
        self.b[o:o + self.s] = int(v).to_bytes(self.s, "little")


builtins.__emu_plain__ = _ident
builtins.ptr8 = lambda b: b
builtins.ptr16 = lambda b: _ptr(b, 2)
builtins.ptr32 = lambda b: _ptr(b, 4)
builtins.uint = int


def _urandom(n):
    return bytes(_emu.random(n))


os.urandom = _urandom
os.dupterm = lambda *a, **k: None
os.uname = lambda: ("rp2", "instant-emu", sys.version.split(";")[0], sys.version, "Raspberry Pi Pico 2 W (emulated)")

# Pico's `time` has these; the wasm build has the ticks ones already.
import time
if not hasattr(time, "sleep_us"):
    time.sleep_us = lambda us: time.sleep_ms(us // 1000)

del _ident, _urandom, _k
