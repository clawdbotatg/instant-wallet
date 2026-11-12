# micropython tools/wedgie/serve.py <wedgie-safe dir> <wedgie-dev/firmware dir>: clawdbotatg/wedgie-safe's safe.py on MicroPython, hardware
# stubbed, speaking its USB protocol on stdin/stdout. A is pressed on every page; the chip's signature is a dummy.
# The pages it showed go to stderr. Used by tools/wedgie-app-check.mts.
import sys, json
sys.path.insert(0, sys.argv[1])
sys.path.append(sys.argv[2])  # the wedgie's firmware folder: p256.py checks the simulator's signature
class M: pass
W = M()
W.send = lambda m: (sys.stdout.write(json.dumps(m) + "\n"), sys.stdout.flush())
W.hello = lambda mid=None, **k: dict(k, type="hello", id=mid)
L = M(); ui = M(); save = M()
IN = sys.stdin.buffer
class Lines:  # raw bytes follow some requests (safe_clear, safe_data): read them straight into the wedgie's block
    intr = False
    def raw(self, buf, poll=None):
        n = 0
        while n < len(buf):
            got = IN.readinto(memoryview(buf)[n:])
            if not got:
                raise OSError("stdin closed")
            n += got
R = Lines()
W.lines = lambda: R
for c in ("WHITE", "INK", "MUTED", "GREY", "GREEN_D", "RED"): setattr(ui, c, c)
ui.progress = lambda *a: None
save.load = lambda k, d=None: d
save.store = lambda *a: None
save.delete = lambda *a: None
class K:
    def pressed(self): return []
L.Keys = lambda physical=True: K()
sys.modules["wedgie"] = W; sys.modules["lcd"] = L; sys.modules["ui"] = ui; sys.modules["save"] = save
import safe as S
def screen(head, lines, yes, k, *a, **kw):  # safe.py also passes a foot, the safe, nav
    sys.stderr.write("-- %s\n" % head)
    for l in lines:
        s, c, k = l[0], l[1], (l[2] if len(l) > 2 else "")
        sys.stderr.write(("!! " if c == "RED" else "   ") + ("[blockie] " if k in ("addr", "pic") else "") + s + ("  (big)" if k == "big" else "") + "\n")
    return True
S._screen = screen
S.key = {"x": "0x" + "11" * 32, "y": "0x" + "22" * 32}
S.state = "ok"
S.sign = lambda dg: (1, 2)
while True:
    line = IN.readline()
    if not line:
        break
    if len(line) > 6144:
        W.send({"type": "error", "error": "line too long"})
        continue
    S.handle(json.loads(line))
