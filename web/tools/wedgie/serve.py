# micropython tools/wedgie/serve.py <wedgie-safe dir>: clawdbotatg/wedgie-safe's safe.py on MicroPython, hardware
# stubbed, speaking its USB protocol on stdin/stdout. A is pressed on every page; the chip's signature is a dummy.
# The pages it showed go to stderr. Used by tools/wedgie-app-check.mts.
import sys, json
sys.path.insert(0, sys.argv[1])
class M: pass
W = M()
W.send = lambda m: (sys.stdout.write(json.dumps(m) + "\n"), sys.stdout.flush())
W.hello = lambda mid=None, **k: dict(k, type="hello", id=mid)
L = M(); ui = M(); save = M()
for c in ("WHITE", "INK", "MUTED", "GREEN_D", "RED"): setattr(ui, c, c)
ui.progress = lambda *a: None
class K:
    def pressed(self): return []
L.Keys = lambda physical=True: K()
sys.modules["wedgie"] = W; sys.modules["lcd"] = L; sys.modules["ui"] = ui; sys.modules["save"] = save
import safe as S
def screen(head, lines, yes, k):
    sys.stderr.write("-- %s\n" % head)
    for l in lines:
        s, c, k = l[0], l[1], (l[2] if len(l) > 2 else "")
        sys.stderr.write(("!! " if c == "RED" else "   ") + ("[blockie] " if k in ("addr", "pic") else "") + s + ("  (big)" if k == "big" else "") + "\n")
    return True
S._screen = screen
S.key = {"x": "0x" + "11" * 32, "y": "0x" + "22" * 32}
S.sign = lambda dg: (1, 2)
while True:
    line = sys.stdin.readline()
    if not line:
        break
    if len(line) > 6144:
        W.send({"type": "error", "error": "line too long"})
        continue
    S.handle(json.loads(line))
