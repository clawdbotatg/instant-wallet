# Instant Wallet device: the loop. Talks to the app, shows what is being asked, signs only on a
# button press. Protocol: docs/PROTOCOL.md sections 2-5.
#
# One 50 ms Timer (a scheduled, soft callback) so main.py can return to the REPL and the WiFi
# console keeps working. Every tick polls keys and redraws; every 20th tick talks to the app.
# Why one timer: the rp2 scheduler queue holds 8 callbacks. A second fast timer fills it while an
# HTTP call blocks, and then the console's socket-accept callback gets dropped for good.
# Signing + relaying can take seconds, so approve() stops the timer and restarts it after.
import time, machine, network, gc
import requests
import lcd as L
import net
import eip712
import qr
import words
import signer as S
import secrets

FIRMWARE = "iw-0.1.0"
APP = secrets.APP_URL
NAME = getattr(secrets, "DEVICE_NAME", "instant")

d = None
keys = None
sig = None            # the signer backend
state = "boot"        # boot | pair | home | receive | keys | confirm | working | done | error
manual_pair = False   # the user opened the pair screen (hold B) while already paired
page = 0              # confirm: 0 = summary, n = details, lines from (n-1)*DETAIL_LINES
req = None            # request on screen
info = {}             # last /api/state
msg = ""              # status line / result text
msg_until = 0
seen = set()          # request ids already handled
last_announce = 0     # 0 = never; the first tick announces right away
last_fetch = 0
STATE_EVERY_MS = 12000
ANNOUNCE_EVERY_MS = 30000
paired = False
wallet_addr = ""      # from the announce reply
signer_id = ""
chain_id = None
qx = qy = ""
hist = []             # last balances seen, for the sparkline
HIST_N = 24
dirty = True
_busy = False
_hold_b = 0
done_until = 0
log = []


msg_prio = False


def say(s, secs=4, prio=False):
    """Flash a line on the status bar. A priority message (a refusal) is not overwritten by
    routine ones (a balance delta) while it is up."""
    global msg, msg_until, dirty, msg_prio
    if msg_prio and not prio and time.ticks_diff(msg_until, time.ticks_ms()) > 0:
        _log(s)
        return
    msg = s
    msg_prio = prio
    msg_until = time.ticks_add(time.ticks_ms(), secs * 1000)
    dirty = True
    _log(s)


def _log(s):
    log.append(s)
    if len(log) > 30:
        log.pop(0)


# ----------------------------------------------------------------------------- formatting
def short(a):
    a = a or ""
    return a[:6] + ".." + a[-4:] if len(a) > 14 else a


def hex32(n):
    return "0x%064x" % n


def hexstr(b):
    return "0x" + "".join("%02x" % c for c in b)


def commas(whole):
    out = ""
    while len(whole) > 3:
        out = "," + whole[-3:] + out
        whole = whole[:-3]
    return whole + out


def money(s, cents=True):
    """'2847.1' -> '$2,847.10' (a formatted decimal string in, a display string out)."""
    s = str(s)
    neg = s.startswith("-")
    if neg:
        s = s[1:]
    whole, _, frac = s.partition(".")
    whole = commas(whole or "0")
    if cents:
        return ("-" if neg else "") + "$" + whole + "." + (frac + "00")[:2]
    return ("-" if neg else "") + "$" + whole + ("." + frac.rstrip("0") if frac.rstrip("0") else "")


def units(raw, decimals):
    """Base units -> decimal string, from the RAW integer (never the app's formatted hint)."""
    n = int(raw)
    if decimals <= 0:
        return str(n)
    p = 10 ** decimals
    whole, frac = n // p, n % p
    if not frac:
        return str(whole)
    fs = ("%0" + str(decimals) + "d") % frac
    return "%d.%s" % (whole, fs.rstrip("0"))


def eth_amount(wei):
    return units(wei, 18)


def token_decimals(addr=None):
    tok = info.get("token", {}) or {}
    if addr is None or (tok.get("address") or "").lower() == (addr or "").lower():
        try:
            return int(tok.get("decimals", 6))
        except (TypeError, ValueError):
            return 6
    return None


def token_symbol(addr=None):
    tok = info.get("token", {}) or {}
    if addr is None or (tok.get("address") or "").lower() == (addr or "").lower():
        return tok.get("symbol", "")
    return ""


DOLLAR_TOKENS = ("USDC", "USDS", "USDT", "DAI", "USD")


def amount_label(raw, decimals, symbol):
    """Big number for the confirm screen. '$2,000' for dollar tokens, '2,000 XYZ' otherwise."""
    s = units(raw, decimals)
    if symbol.upper() in DOLLAR_TOKENS:
        return money(s, cents=("." in s))
    whole, _, frac = s.partition(".")
    return commas(whole) + ("." + frac if frac else "")


def checksum(addr):
    """EIP-55 mixed-case, so the receive QR scans into any wallet without a warning."""
    a = addr[2:].lower()
    h = eip712.keccak256(a.encode())
    out = ""
    for i in range(40):
        nib = (h[i // 2] >> (4 if i % 2 == 0 else 0)) & 0xF
        c = a[i]
        out += c.upper() if (nib >= 8 and c > "9") else c
    return "0x" + out


def chain_label():
    c = info.get("chain")
    cid = chain_id
    name = None
    if isinstance(c, dict):
        cid = c.get("id", cid)
        name = c.get("name")
    elif isinstance(c, str):
        name = c
    elif isinstance(c, int):
        cid = c
    if not name:
        name = {8453: "base", 1: "mainnet", 84532: "base sepolia", 31337: "anvil"}.get(cid, "chain %s" % cid if cid else "")
    real = cid in (1, 8453)
    return name.upper()[:12], (L.GREEN if real else L.YELLOW)


# ----------------------------------------------------------------------------- QR
_pair_qr = None     # (text, n, rows)
_recv_qr = None


def pair_text():
    return "iw1:%s:%s:%s" % (qx[2:], qy[2:], NAME)


def get_pair_qr():
    global _pair_qr
    if not qx:
        return None
    t = pair_text()
    if _pair_qr is None or _pair_qr[0] != t:
        t0 = time.ticks_ms()
        n, rows = qr.encode(t)
        _pair_qr = (t, n, rows)
        _log("pair qr v%d built in %d ms" % (qr.version_of(n), time.ticks_diff(time.ticks_ms(), t0)))
    return _pair_qr


def get_recv_qr():
    global _recv_qr
    if not wallet_addr:
        return None
    t = checksum(wallet_addr)
    if _recv_qr is None or _recv_qr[0] != t:
        n, rows = qr.encode(t)
        _recv_qr = (t, n, rows)
    return _recv_qr


def draw_qr(code, y0, size, pad, x0=None):
    """Black on white, `size` px per module, `pad` px quiet zone. Returns the box size."""
    _, n, rows = code
    box = n * size + 2 * pad
    if x0 is None:
        x0 = (240 - box) // 2
    d.fill_rect(x0, y0, box, box, L.WHITE)
    for r in range(n):
        row = rows[r]
        y = y0 + pad + r * size
        for c in range(n):
            if row[c]:
                d.fill_rect(x0 + pad + c * size, y, size, size, L.BLACK)
    return box


# ----------------------------------------------------------------------------- drawing bits
DKGREEN = L.color(20, 70, 40)
PANEL = L.color(24, 26, 34)
BRIGHT = L.color(50, 210, 90)
SIGN_GREEN = L.color(34, 197, 94)
REJECT_RED = L.color(220, 50, 47)
BOXFILL = L.color(40, 36, 20)


def tri_right(x, y, h, c):
    """Solid triangle pointing right, tip at (x+h//2, y), height h."""
    for i in range(h // 2):
        d.vline(x + i, y - (h // 2 - i), h - 2 * i, c)


def bar(y, h, label, color, scale):
    """Full-width bar with a label and an arrow at the right edge pointing at the physical button."""
    d.fill_rect(0, y, 240, h, color)
    while scale > 1 and 8 * scale * len(label) > 200:
        scale -= 1
    d.center_text(label, y + (h - 8 * scale) // 2, L.WHITE, scale)
    tri_right(222, y + h // 2, 16, L.WHITE)


def code_box(y, text):
    """The match code: yellow-bordered box, the same three tokens the phone shows."""
    d.fill_rect(30, y, 180, 24, BOXFILL)
    d.rect(30, y, 180, 24, L.YELLOW)
    d.center_text(text.upper()[:20], y + 8, L.WHITE)


def status_line(default=None):
    """Bottom line on the home-ish screens: a flash message beats a warning beats the hint."""
    warn = None
    try:
        if float((info.get("relayer", {}) or {}).get("balanceFormatted", "1")) < 0.0005:
            warn = "relay gas low"
    except ValueError:
        pass
    age = time.ticks_diff(time.ticks_ms(), last_fetch) // 1000 if last_fetch else 0
    if age > 45:
        warn = "no app for %ds" % age
    if not paired:
        warn = "not paired" if qx else "no key"
    if time.ticks_diff(msg_until, time.ticks_ms()) > 0:
        d.fill_rect(0, 224, 240, 16, L.DARK)
        d.center_text(msg[:30], 228, L.YELLOW)
    elif warn:
        d.fill_rect(0, 224, 240, 16, L.DARK)
        d.center_text(warn, 228, L.RED)
    elif default:
        d.center_text(default, 228, L.GREY)


def header():
    name, col = chain_label()
    d.text(name, 4, 4, col)
    d.fill_rect(226, 4, 8, 8, L.GREEN if paired else L.RED)


# ----------------------------------------------------------------------------- screens
def draw_sparkline(x0, y0, w, h):
    if len(hist) < 1:
        return
    pts = hist if len(hist) > 1 else [hist[0], hist[0]]
    lo, hi = min(pts), max(pts)
    span = hi - lo
    if span <= 0:
        span = max(abs(hi) * 0.02, 1.0)
        lo = lo - span / 2
    n = len(pts)
    xy = []
    for i, v in enumerate(pts):
        x = x0 + i * (w - 1) // (n - 1)
        y = y0 + h - 1 - int((v - lo) * (h - 8) / span) - 4
        xy.append((x, y))
    for (xa, ya), (xb, yb) in zip(xy, xy[1:]):
        for x in range(xa, xb + 1):
            y = ya + (yb - ya) * (x - xa) // max(1, xb - xa)
            d.vline(x, y, y0 + h - y, DKGREEN)
    for (xa, ya), (xb, yb) in zip(xy, xy[1:]):
        d.line(xa, ya, xb, yb, BRIGHT)
        d.line(xa, ya + 1, xb, yb + 1, BRIGHT)
        d.line(xa, ya + 2, xb, yb + 2, BRIGHT)


def draw_home():
    d.fill(L.BLACK)
    header()
    w = info.get("wallet", {}) or {}
    bal = w.get("balanceFormatted")
    ens_name = w.get("ensName")
    sym = token_symbol() or ""
    if bal is None:
        d.center_text("connecting...", 40, L.GREY, 2)
    else:
        s = money(bal)
        d.center_text(s, 28, L.WHITE, 3 if len(s) <= 10 else 2)
        if len(hist) >= 2:
            delta = hist[-1] - hist[0]
            ds = ("+" if delta >= 0 else "-") + money("%.2f" % abs(delta))
            d.center_text(ds + " " + sym, 60, BRIGHT if delta > 0 else (L.RED if delta < 0 else L.GREY))
        else:
            d.center_text(sym, 60, L.GREY)
    draw_sparkline(0, 84, 240, 104)
    d.fill_rect(0, 190, 240, 50, PANEL)
    if ens_name:
        d.center_text(ens_name.upper()[:14], 198, L.YELLOW, 2 if len(ens_name) <= 14 else 1)
    elif wallet_addr:
        d.center_text(short(wallet_addr), 200, L.GREY)
    status_line("A:RECEIVE  B:PAIR  Y:KEYS")
    d.show()


def draw_pair():
    d.fill(L.BLACK)
    header()
    d.center_text("PAIR THIS DEVICE", 4, L.WHITE)
    code = get_pair_qr()
    if code:
        draw_qr(code, 16, 4, 8)          # 45 modules * 4 px + 2 * 8 px quiet zone = 196 px
        d.center_text("SCAN WITH YOUR PHONE", 214, L.YELLOW)
        d.center_text("key " + qx[2:6] + ".." + qx[-4:] + " stays on chip", 226, L.GREY)
    else:
        d.center_text("no key", 100, L.RED, 2)
    d.show()


def draw_receive():
    d.fill(L.BLACK)
    code = get_recv_qr()
    if code:
        draw_qr(code, 0, 6, 6)           # 29 modules * 6 px + 12 = 186 px
        addr = code[0]
        ens_name = (info.get("wallet", {}) or {}).get("ensName")
        if ens_name:
            d.center_text(ens_name[:26], 190, L.YELLOW)
            d.center_text(addr[:21], 204, L.GREY)
            d.center_text(addr[21:], 214, L.GREY)
        else:
            d.center_text(addr[:21], 196, L.GREY)
            d.center_text(addr[21:], 208, L.GREY)
    else:
        d.center_text("no wallet yet", 100, L.GREY, 2)
    d.center_text("Y: BACK", 228, L.GREY)
    d.show()


def draw_keys():
    d.fill(L.BLACK)
    d.text("KEYS", 4, 4, L.YELLOW)
    signers = info.get("signers", []) or []
    d.text("%d" % len(signers), 228, 4, L.GREY)
    d.hline(0, 16, 240, L.DARK)
    y = 22
    for s in signers[:7]:
        sid = s.get("signerId") or s.get("id") or ""
        mine = sid.lower() == signer_id.lower() if sid and signer_id else False
        role = "owner" if int(s.get("role", 0) or 0) == 1 else "spender"
        kind = "chip" if int(s.get("kind", 0) or 0) == 1 else "passkey"
        label = s.get("label") or short(sid)
        d.text(("*" if mine else " ") + label[:26], 4, y, L.WHITE if mine else L.GREY)
        if role == "owner":
            lim = "no limit"
        else:
            lim = "$" + units(s.get("dailyLimit", 0) or 0, token_decimals() or 6) + "/day"
        d.text("%s %s %s" % (kind, role, lim), 12, y + 10, L.YELLOW if role == "owner" else L.GREY)
        y += 26
    if not signers:
        d.center_text("no signers listed", 100, L.GREY)
    rec = info.get("pendingRecovery")
    if rec:
        d.fill_rect(0, 206, 240, 16, L.DARK)
        d.center_text("RECOVERY PENDING", 210, L.RED)
    d.center_text("Y: BACK", 232, L.GREY)
    d.show()


# The A/B/X/Y column sits along the right edge of the screen: A near the top, Y at the bottom.
# SIGN lives in a green bar in line with A, REJECT in a red bar in line with Y.
SIGN_BAR = (0, 60)
REJECT_BAR = (190, 50)
CODE_Y = 154
DETAIL_LINES = 13

SELECTORS = {
    "0xa9059cbb": "transfer", "0x095ea7b3": "approve", "0x23b872dd": "transferFrom",
    "0x2e1a7d4d": "withdraw", "0xd0e30db0": "deposit", "0x42842e0e": "safeTransferFrom",
}


def selector_of(data_hex):
    return data_hex[:10].lower() if len(data_hex) >= 10 else "0x00000000"


def draw_summary():
    kind = req.get("kind")
    code = words.match_code(req["_digest"])
    if kind == "transfer":
        bar(SIGN_BAR[0], SIGN_BAR[1], "SIGN", SIGN_GREEN, 3)
        dec = token_decimals(req["token"])
        sym = token_symbol(req["token"]) or req.get("tokenSymbol", "")
        if dec is None:
            dec = int(req.get("tokenDecimals", 18))   # a foreign token: decimals are a hint, raw is on the details page
        amt = amount_label(req["amount"], dec, sym)
        d.center_text(amt, 68, L.WHITE, 4 if len(amt) <= 7 else (3 if len(amt) <= 10 else 2))
        d.center_text((sym + " TO").strip()[:20], 102, L.GREY)
        name = req.get("toName") or short(req["to"])
        d.center_text(name.upper()[:14], 116, L.YELLOW, 2)
        d.center_text(short(req["to"]).upper(), 136, L.GREY)
    elif kind == "execute":
        bar(SIGN_BAR[0], SIGN_BAR[1], "SIGN", SIGN_GREEN, 3)
        calls = req.get("calls", [])
        sel = selector_of(calls[0]["data"]) if calls else "0x00000000"
        known = SELECTORS.get(sel)
        if len(calls) > 1:
            title = "BATCH: %d CALLS" % len(calls)
        elif sel == "0xa9059cbb":
            title = "TOKEN TRANSFER"
        elif sel == "0x095ea7b3":
            title = "TOKEN APPROVAL"
        else:
            title = "GENERAL CALL"
        d.center_text(title, 66, L.YELLOW, 2)
        if calls:
            d.center_text(short(calls[0]["target"]).upper(), 88, L.WHITE, 2)
            total = 0
            for c in calls:
                total += int(c.get("value", 0) or 0)
            eth = eth_amount(total) + " ETH"
            if len(calls) > 1:
                eth += "  %d targets" % len(set(c["target"].lower() for c in calls))
            d.center_text(eth, 108, L.WHITE if total else L.GREY)
            if len(calls[0]["data"]) <= 2:
                d.center_text("no calldata", 120, L.GREY)
            elif known:
                d.center_text(sel + " " + known, 120, L.GREY)
            else:
                d.center_text("UNKNOWN CALL " + sel, 120, L.RED)
            unknown_more = sum(1 for c in calls[1:] if len(c["data"]) > 2 and selector_of(c["data"]) not in SELECTORS)
            if unknown_more:
                d.center_text("+%d more unknown" % unknown_more, 132, L.RED)
            else:
                d.center_text("calls " + hexstr(req["_calls_hash"])[:10] + ".." + hexstr(req["_calls_hash"])[-4:], 132, L.GREY)
        else:
            d.center_text("NO CALLS", 96, L.RED, 2)
    elif kind == "addSigner":
        bar(SIGN_BAR[0], SIGN_BAR[1], "ADD KEY", SIGN_GREEN, 3)
        d.center_text("NEW KEY WANTS TO JOIN", 68, L.GREY)
        label = (req.get("label") or short(eip712.signer_id(req["qx"], req["qy"]))).upper()
        d.center_text(label[:14], 84, L.YELLOW, 2 if len(label) <= 14 else 1)
        role = int(req.get("role", 0))
        skind = int(req.get("signerKind", 0))
        if role == 1:
            d.center_text("OWNER: NO LIMIT", 108, L.WHITE)
        else:
            d.center_text(("LIMIT $" + units(req.get("dailyLimit", 0), token_decimals() or 6) + " / DAY")[:28], 108, L.WHITE)
        d.center_text(("PASSKEY" if skind == 0 else "CHIP KEY") + "  " + ("OWNER" if role == 1 else "SPENDER"), 124, L.GREY)
    elif kind == "updateSigner":
        bar(SIGN_BAR[0], SIGN_BAR[1], "UPDATE KEY", SIGN_GREEN, 3)
        d.center_text(short(req["targetSignerId"]).upper(), 68, L.YELLOW, 2)
        role = int(req.get("role", 0))
        if role == 1:
            d.center_text("BECOMES OWNER", 96, L.WHITE, 2)
            d.center_text("no limit", 120, L.GREY)
        else:
            d.center_text("SPENDER", 96, L.WHITE, 2)
            d.center_text(("limit $" + units(req.get("dailyLimit", 0), token_decimals() or 6) + " / day")[:28], 120, L.WHITE)
    elif kind == "removeSigner":
        bar(SIGN_BAR[0], SIGN_BAR[1], "REMOVE KEY", REJECT_RED, 3)
        d.center_text(short(req["targetSignerId"]).upper(), 72, L.YELLOW, 2)
        d.center_text("loses all access", 100, L.WHITE)
        d.center_text("to this wallet", 112, L.WHITE)
    elif kind == "setRecovery":
        bar(SIGN_BAR[0], SIGN_BAR[1], "SET RECOVERY", SIGN_GREEN, 2)
        d.center_text(short(req["recoveryAddress"]).upper(), 70, L.YELLOW, 2)
        delay = int(req.get("recoveryDelay", 0))
        if delay % 86400 == 0:
            ds = "%d day delay" % (delay // 86400)
        else:
            ds = "%d hour delay" % (delay // 3600)
        d.center_text(ds, 98, L.WHITE, 2)
        d.center_text("can add an owner key", 122, L.GREY)
    elif kind == "cancelRecovery":
        bar(SIGN_BAR[0], SIGN_BAR[1], "CANCEL", SIGN_GREEN, 3)
        d.center_text("CANCEL RECOVERY", 70, L.YELLOW)
        d.center_text("KEEP MY KEYS", 88, L.WHITE, 2)
        d.center_text("the pending key is dropped", 114, L.GREY)
        rec = info.get("pendingRecovery") or {}
        if isinstance(rec, dict) and rec.get("qx"):
            d.center_text("pending " + short(eip712.signer_id(rec["qx"], rec["qy"])), 126, L.GREY)
    code_box(CODE_Y, code)
    bar(REJECT_BAR[0], REJECT_BAR[1], "REJECT", REJECT_RED, 3)


def detail_lines():
    r = req
    hx = hexstr(r["_digest"])
    common = (
        "nonce %s  chain %s" % (r["nonce"], r["chainId"]),
        "deadline " + str(r["deadline"]),
        "wallet " + r["wallet"][:20], "       " + r["wallet"][20:],
        "digest (device)", hx[2:24], hx[24:46], hx[46:],
        "match " + words.match_code(r["_digest"]),
    )
    kind = r.get("kind")
    if kind == "transfer":
        lines = (
            "to " + r["to"][:22], "   " + r["to"][22:],
            "amount " + str(r["amount"]),
            "fee " + str(r.get("fee", 0)),
            "token " + r["token"][:22], "      " + r["token"][22:],
        )
    elif kind == "execute":
        lines = []
        for i, c in enumerate(r.get("calls", [])):
            raw = bytes.fromhex(c["data"][2:]) if len(c["data"]) > 2 else b""
            lines += [
                "call %d target" % i, "  " + c["target"][:22], "  " + c["target"][22:],
                "  value %s wei" % c.get("value", "0"),
                ("  sel " + selector_of(c["data"]) + (" " + SELECTORS[selector_of(c["data"])] if selector_of(c["data"]) in SELECTORS else " UNKNOWN")) if raw else "  no calldata",
                "  data %d bytes" % len(raw),
            ]
        ch = hexstr(r["_calls_hash"])
        lines += ["callsHash (device)", ch[2:24], ch[24:46], ch[46:]]
    elif kind == "addSigner":
        lines = (
            "qx " + r["qx"][2:34], "   " + r["qx"][34:],
            "qy " + r["qy"][2:34], "   " + r["qy"][34:],
            "id " + eip712.signer_id(r["qx"], r["qy"]),
            "kind %s  role %s" % (r.get("signerKind", 0), r.get("role", 0)),
            "dailyLimit " + str(r.get("dailyLimit", 0)),
            "credIdHash " + str(r.get("credentialIdHash", hex32(0)))[2:22] + "..",
        )
    elif kind == "updateSigner":
        lines = (
            "signer " + r["targetSignerId"][:20], "       " + r["targetSignerId"][20:],
            "role %s" % r.get("role", 0),
            "dailyLimit " + str(r.get("dailyLimit", 0)),
        )
    elif kind == "removeSigner":
        lines = ("signer " + r["targetSignerId"][:20], "       " + r["targetSignerId"][20:])
    elif kind == "setRecovery":
        lines = (
            "recovery " + r["recoveryAddress"][:18], "         " + r["recoveryAddress"][18:],
            "delay %s s" % r.get("recoveryDelay", 0),
        )
    else:
        lines = ("cancel pending recovery",)
    return tuple(lines) + common


def draw_confirm():
    d.fill(L.BLACK)
    if page == 0:
        draw_summary()
    else:
        lines = detail_lines()
        off = (page - 1) * DETAIL_LINES
        bar(0, 22, "SIGN", SIGN_GREEN, 1)
        d.text("%d/%d" % (page, (len(lines) + DETAIL_LINES - 1) // DETAIL_LINES), 4, 7, L.WHITE)
        y = 28
        for line in lines[off:off + DETAIL_LINES]:
            col = L.GREEN if (line.startswith("digest") or line.startswith("callsHash") or line.startswith("match")) else (L.RED if "UNKNOWN" in line else L.WHITE)
            d.text(line[:30], 4, y, col)
            y += 14
        bar(218, 22, "REJECT", REJECT_RED, 1)
    d.show()


def draw_msg(title, color):
    d.fill(L.BLACK)
    d.fill_rect(0, 0, 240, 26, color)
    d.center_text(title, 5, L.WHITE, 2)
    y = 60
    for i in range(0, len(msg), 28):
        d.text(msg[i:i + 28], 6, y, L.WHITE)
        y += 14
    d.center_text("A = ok", 210, L.GREY)
    d.show()


def draw():
    if state in ("boot", "home"):
        draw_home()
    elif state == "pair":
        draw_pair()
    elif state == "receive":
        draw_receive()
    elif state == "keys":
        draw_keys()
    elif state == "confirm":
        draw_confirm()
    elif state == "working":
        draw_msg("SIGNING", L.BLUE)
    elif state == "done":
        draw_msg("SENT", SIGN_GREEN)
    elif state == "error":
        draw_msg("ERROR", REJECT_RED)


# ----------------------------------------------------------------------------- ui tick
_n = 0


def goto(s):
    global state, dirty
    state = s
    dirty = True


def tick(t):
    global dirty, page, state, _busy, _n, _hold_b, manual_pair
    if _busy:
        return
    _busy = True
    try:
        _n += 1
        net.poll_accept()
        if _n % 20 == 0:
            timer.deinit()      # no timer events pile up while HTTP blocks (mainnet: 0.5-3 s)
            try:
                net_work()
            finally:
                start_timer()
        # hold B on the home screen: show the pairing QR again
        if state in ("home", "keys", "receive") and keys.held("B"):
            _hold_b += 1
            if _hold_b == 10:
                manual_pair = True
                goto("pair")
        else:
            _hold_b = 0
        for k in keys.pressed():
            if state == "confirm":
                if k == "A":
                    approve(True)
                elif k == "Y":
                    approve(False)
                elif k == "down":
                    if page == 0 or page * DETAIL_LINES < len(detail_lines()):
                        page += 1
                        dirty = True
                elif k == "up":
                    if page > 0:
                        page -= 1
                        dirty = True
            elif state == "home":
                if k in ("A", "right"):
                    goto("receive")
                elif k == "Y":
                    goto("keys")
            elif state in ("receive", "keys"):
                if k in ("Y", "left", "B", "A"):
                    goto("home")
            elif state == "pair":
                if k in ("Y", "left", "B") and paired:
                    manual_pair = False
                    goto("home")
            elif state in ("done", "error") and k == "A":
                goto("home")
        if state == "done" and time.ticks_diff(done_until, time.ticks_ms()) < 0:
            goto("home")
        if state == "home" and (time.ticks_diff(msg_until, time.ticks_ms()) > 0 or _n % 100 == 0):
            dirty = True  # keep the status line fresh
        if dirty:
            draw()
            dirty = False
    except Exception as e:
        _log("ui: %r" % e)
    finally:
        _busy = False


# ----------------------------------------------------------------------------- app protocol
def chip_serial():
    try:
        return sig.status().get("serial", sig.name)
    except Exception:
        return sig.name


def announce():
    global paired, qx, qy, last_announce, wallet_addr, signer_id, chain_id, dirty
    if not qx:
        x, y = sig.pubkey()
        qx, qy = hex32(x), hex32(y)
    body = {"name": NAME, "qx": qx, "qy": qy, "chipSerial": chip_serial(), "firmware": FIRMWARE}
    r = requests.post(APP + "/api/device", json=body, timeout=5)
    try:
        j = r.json()
    finally:
        r.close()
    was = paired
    paired = bool(j.get("paired"))
    if j.get("wallet"):
        wallet_addr = j["wallet"]
    if j.get("signerId"):
        signer_id = j["signerId"]
    else:
        signer_id = eip712.signer_id(qx, qy)
    if j.get("chainId") is not None:
        try:
            chain_id = int(j["chainId"])
        except (TypeError, ValueError):
            pass
    last_announce = time.ticks_ms()
    if paired != was:
        dirty = True


def fetch_state():
    global info, dirty, last_fetch
    r = requests.get(APP + "/api/state?wallet=" + wallet_addr, timeout=8)
    try:
        info = r.json()
    finally:
        r.close()
    last_fetch = time.ticks_ms()
    bal = (info.get("wallet", {}) or {}).get("balanceFormatted")
    if bal is not None:
        try:
            v = float(bal)
        except ValueError:
            v = None
        if v is not None:
            if hist and v != hist[-1]:
                delta = v - hist[-1]
                say(("+$%.2f" if delta >= 0 else "-$%.2f") % abs(delta), 8)
            if not hist or v != hist[-1]:
                hist.append(v)
                if len(hist) > HIST_N:
                    hist.pop(0)
    dirty = True


def _same(a, b):
    return (a or "").lower() == (b or "").lower()


def check_request(r):
    """Rebuild the EIP-712 digest from the raw fields the screen shows. Returns None when the
    request is exactly what it claims to be, else the reason to refuse it. Sets r['_digest']."""
    try:
        cid = int(r["chainId"])
        wallet = r["wallet"]
        nonce = int(r["nonce"])
        deadline = int(r["deadline"])
    except (KeyError, TypeError, ValueError):
        return "missing envelope fields"
    exp_chain = getattr(secrets, "EXPECTED_CHAIN_ID", None)
    exp_wallet = getattr(secrets, "EXPECTED_WALLET", None)
    exp_token = getattr(secrets, "EXPECTED_TOKEN", None)
    if exp_chain is not None and cid != int(exp_chain):
        return "chain %d is not the pinned chain" % cid
    if chain_id is not None and cid != chain_id:
        return "chain %d differs from the announced chain" % cid
    if exp_wallet and not _same(wallet, exp_wallet):
        return "wallet is not the pinned wallet"
    if wallet_addr and not _same(wallet, wallet_addr):
        return "wallet differs from the paired wallet"
    if r.get("signerId") and signer_id and not _same(r["signerId"], signer_id):
        return "request is for another signer"
    kind = r.get("kind")
    try:
        if kind == "transfer":
            if exp_token and not _same(r["token"], exp_token):
                return "token is not the pinned token"
            mine = eip712.transfer_digest(cid, wallet, r["token"], r["to"], int(r["amount"]), int(r.get("fee", 0)), nonce, deadline)
        elif kind == "execute":
            calls = []
            for c in r.get("calls", []):
                data = bytes.fromhex(c["data"][2:]) if len(c.get("data", "0x")) > 2 else b""
                calls.append((c["target"], int(c.get("value", 0) or 0), data))
            r["_calls_hash"] = eip712.calls_hash(calls)
            if r.get("callsHash") and not _same(r["callsHash"], hexstr(r["_calls_hash"])):
                return "callsHash does not match the calls"
            mine = eip712.execute_digest(cid, wallet, calls, nonce, deadline)
        elif kind == "addSigner":
            mine = eip712.add_signer_digest(cid, wallet, r["qx"], r["qy"], int(r.get("signerKind", 0)), int(r.get("role", 0)),
                                            int(r.get("dailyLimit", 0)), r.get("credentialIdHash") or hex32(0), nonce, deadline)
        elif kind == "updateSigner":
            mine = eip712.update_signer_digest(cid, wallet, r["targetSignerId"], int(r.get("role", 0)), int(r.get("dailyLimit", 0)), nonce, deadline)
        elif kind == "removeSigner":
            mine = eip712.remove_signer_digest(cid, wallet, r["targetSignerId"], nonce, deadline)
        elif kind == "setRecovery":
            mine = eip712.set_recovery_digest(cid, wallet, r["recoveryAddress"], int(r["recoveryDelay"]), nonce, deadline)
        elif kind == "cancelRecovery":
            mine = eip712.cancel_recovery_digest(cid, wallet, nonce, deadline)
        else:
            return "unknown kind %s" % kind
    except (KeyError, TypeError, ValueError) as e:
        return "bad %s fields: %r" % (kind, e)
    r["_digest"] = mine
    if not _same(hexstr(mine), r.get("digest", "")):
        return "digest mismatch: device %s app %s" % (hexstr(mine)[:10], str(r.get("digest", ""))[:10])
    if r.get("matchCode") and r["matchCode"].lower() != words.match_code(mine):
        return "match code differs from the digest"
    return None


def reject(rid, error=None):
    body = {"by": NAME}
    if error:
        body["error"] = error
    try:
        requests.post(APP + "/api/requests/%s/reject" % rid, json=body, timeout=8).close()
    except Exception as e:
        _log("reject post failed: %r" % e)


def poll_requests():
    global req, state, page, dirty
    r = requests.get(APP + "/api/requests?status=pending&signerId=" + signer_id, timeout=5)
    try:
        j = r.json()
    finally:
        r.close()
    pending = j.get("requests", []) if isinstance(j, dict) else j
    for p in pending:
        if p["id"] in seen:
            continue
        seen.add(p["id"])
        err = check_request(p)
        if err:
            say("REFUSED: " + err[:40], 10, prio=True)
            _log("REFUSED %s: %s" % (p["id"], err))
            reject(p["id"], err)
            continue
        req, page = p, 0
        goto("confirm")
        _log("request %s: %s  match %s" % (p["id"], p.get("kind"), words.match_code(p["_digest"])))
        return


def approve(yes):
    global state, dirty, msg, done_until
    if not yes:
        _log("rejected " + req["id"])
        say("rejected", 3)
        goto("home")
        draw()
        reject(req["id"])
        return
    state, msg, dirty = "working", "signing on " + sig.name, True
    draw()
    timer.deinit()  # long blocking work ahead; keep the scheduler queue empty
    try:
        digest = req["_digest"]    # the digest THIS device computed, never the app's copy
        t0 = time.ticks_ms()
        r_, s_ = sig.sign(digest)
        _log("signed in %d ms" % time.ticks_diff(time.ticks_ms(), t0))
        msg = "relaying..."
        draw()
        body = {"r": hex32(r_), "s": hex32(s_)}
        resp = requests.post(APP + "/api/requests/%s/signature" % req["id"], json=body, timeout=120)
        try:
            out = resp.json()
        finally:
            resp.close()
        if isinstance(out, dict) and isinstance(out.get("request"), dict):
            out = out["request"]
        status = out.get("status") if isinstance(out, dict) else None
        if status in ("signed", "relaying", "confirmed"):
            tx = short(out.get("txHash") or "")
            kind = req.get("kind")
            if kind == "transfer":
                dec = token_decimals(req["token"])
                if dec is None:
                    dec = int(req.get("tokenDecimals", 18))
                msg = "%s to %s" % (amount_label(req["amount"], dec, token_symbol(req["token"]) or req.get("tokenSymbol", "")), req.get("toName") or short(req["to"]))
            else:
                msg = kind
            msg += "  " + (status if status != "confirmed" else "confirmed") + (("  tx " + tx) if tx else "")
            state = "done"
            done_until = time.ticks_add(time.ticks_ms(), 8000)
        else:
            msg = ("%s: %s" % (status, out.get("error", "") if isinstance(out, dict) else out))[:100]
            state = "error"
    except Exception as e:
        msg, state = "sign/post failed: %r" % e, "error"
    _log(msg)
    dirty = True
    start_timer()


def net_work():
    global state, dirty, last_announce, last_fetch
    if state in ("confirm", "working"):
        return
    try:
        if not network.WLAN(network.STA_IF).isconnected():
            return
        now = time.ticks_ms()
        every = ANNOUNCE_EVERY_MS if paired else 5000
        if last_announce == 0 or time.ticks_diff(now, last_announce) > every:
            announce()
            _log("announced, paired=%s wallet=%s" % (paired, short(wallet_addr)))
        if not paired:
            if state != "pair":
                goto("pair")
            return
        if state == "pair" and not manual_pair:
            goto("home")
        if last_fetch == 0 or time.ticks_diff(now, last_fetch) > STATE_EVERY_MS:
            fetch_state()
            if state == "boot":
                goto("home")
        poll_requests()
    except Exception as e:
        _log("net: %r" % e)
        say("net: %r" % e, 5)
    gc.collect()


# ----------------------------------------------------------------------------- entry
timer = None


def start_timer():
    global timer
    timer = machine.Timer(period=50, mode=machine.Timer.PERIODIC, callback=tick)


def start():
    global d, keys, sig, dirty
    d = L.LCD()
    keys = L.Keys()
    draw()
    sig = S.load()
    dirty = True
    start_timer()


def decide(yes=True):
    """Dev hook from the console: same as pressing A (True) or Y (False)."""
    if state == "confirm":
        approve(yes)


def snap(path="shot.bin"):
    """Save the framebuffer so a computer can pull it (tools/shot)."""
    with open(path, "wb") as f:
        f.write(d.buffer)


def stop():
    timer.deinit()
