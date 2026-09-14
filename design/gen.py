#!/usr/bin/env python3
"""Generates the Instant Wallet design artboards (.dc.html) from shared snippets."""
import os, random, json
OUT = os.path.dirname(os.path.abspath(__file__))

# ---------- palette ----------
BG="#f4f4f1"; CARD="#ffffff"; INK="#1a1b1a"; MUTED="#767a76"; LINE="#e6e6e2"
GREEN="#22c452"; GREEN_D="#169a3d"; GREEN_L="#e6f8ec"; RED="#e3312c"; RED_L="#fdecec"
SCREEN="#131413"; SGREEN="#3ee36c"; YEL="#f5d24a"; AMBER="#f2b233"
SHADOW="0 1px 2px rgba(20,20,20,.05), 0 10px 28px rgba(20,20,20,.07)"
CLAY="inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(20,20,20,.06), 0 8px 22px rgba(20,20,20,.07)"

HEAD = """<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Silkscreen:wght@400;700&amp;display=swap">
  <style>
    body { margin: 0; font-family: 'Outfit', 'Avenir Next', 'Segoe UI', system-ui, sans-serif; background: %s; color: %s; -webkit-font-smoothing: antialiased; }
    a { color: %s; } a:hover { color: #0f7a2e; }
    .mono { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; }
    .px { font-family: 'Silkscreen', 'Courier New', monospace; }
  </style>
</helmet>
""" % (BG, INK, GREEN_D)
FOOT = """</x-dc>
</body>
</html>
"""

def write(name, body):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(HEAD + body + FOOT)
    print("wrote", name)

# ---------- shared pieces ----------
def fake_qr(size_px, modules=25, seed=7, dark="#131413", light="#ffffff", pad=1):
    """Deterministic pseudo-QR as inline SVG (finder patterns + noise). Mockup only."""
    rnd = random.Random(seed)
    n = modules
    cell = size_px / (n + 2*pad)
    rects = []
    def finder(x0, y0):
        for r in range(7):
            for c in range(7):
                on = r in (0,6) or c in (0,6) or (2<=r<=4 and 2<=c<=4)
                if on: rects.append((x0+c, y0+r))
    finder(0,0); finder(n-7,0); finder(0,n-7)
    for r in range(n):
        for c in range(n):
            infinder = (r<8 and c<8) or (r<8 and c>=n-8) or (r>=n-8 and c<8)
            if infinder: continue
            if rnd.random() < 0.45: rects.append((c, r))
    parts = ['<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg">' % (size_px, size_px, size_px, size_px),
             '<rect width="%d" height="%d" fill="%s" rx="6"></rect>' % (size_px, size_px, light)]
    for (c, r) in rects:
        parts.append('<rect x="%.2f" y="%.2f" width="%.2f" height="%.2f" fill="%s"></rect>' % ((c+pad)*cell, (r+pad)*cell, cell+0.3, cell+0.3, dark))
    parts.append('</svg>')
    return "".join(parts)

def sparkline(w, h, color=SGREEN, stroke=3, seed=3, up=True, fill=True):
    rnd = random.Random(seed)
    pts=[]; n=14; y=h*0.75
    for i in range(n):
        x = i*(w/(n-1))
        y = max(h*0.12, min(h*0.92, y + rnd.uniform(-h*0.22, h*0.16 if up else h*0.3)))
        pts.append((x,y))
    if up: pts[-1]=(w, h*0.18)
    poly = " ".join("%.1f,%.1f"%p for p in pts)
    area = ""
    if fill:
        area = '<polygon points="0,%d %s %d,%d" fill="%s" opacity="0.12"></polygon>' % (h, poly, w, h, color)
    return ('<svg width="%d" height="%d" viewBox="0 0 %d %d" xmlns="http://www.w3.org/2000/svg" style="display:block">%s'
            '<polyline points="%s" fill="none" stroke="%s" stroke-width="%d" stroke-linejoin="round" stroke-linecap="round"></polyline></svg>') % (w,h,w,h,area,poly,color,stroke)

def device_svg(w=220, screen_html=None, glow=False):
    """The Instant Wallet hardware device, front view. Joystick left, screen, 4 buttons right (green, grey, grey, red)."""
    h = int(w*0.52)
    s = w/220.0
    def px(v): return "%.1f" % (v*s)
    screen = screen_html or ('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"></rect>' % (px(70), px(22), px(96), px(70), px(7), SCREEN))
    return ('<svg width="%d" height="%d" viewBox="0 0 %s %s" xmlns="http://www.w3.org/2000/svg" style="display:block">'
      '<defs><linearGradient id="iwbody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"></stop><stop offset="1" stop-color="#eeeeeb"></stop></linearGradient></defs>'
      '%s'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="#2a2b2a"></rect>'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="url(#iwbody)" stroke="#dddcd8" stroke-width="1"></rect>'
      '<circle cx="%s" cy="%s" r="%s" fill="#e9e9e6" stroke="#d4d4d0"></circle>'
      '<circle cx="%s" cy="%s" r="%s" fill="#5e5f5e"></circle><circle cx="%s" cy="%s" r="%s" fill="#7a7b7a"></circle>'
      '%s'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"></rect>'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="#8d8e8c"></rect>'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="#8d8e8c"></rect>'
      '<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"></rect>'
      '</svg>') % (w, h, px(220), px(114),
        ('<ellipse cx="%s" cy="%s" rx="%s" ry="%s" fill="%s" opacity="0.25"></ellipse>' % (px(110), px(100), px(90), px(10), GREEN)) if glow else '',
        px(6), px(8), px(212), px(102), px(20),
        px(2), px(2), px(212), px(102), px(20),
        px(38), px(55), px(19),
        px(38), px(55), px(13), px(38), px(52), px(9),
        screen,
        px(180), px(20), px(20), px(16), px(5), GREEN,
        px(180), px(41), px(20), px(16), px(5),
        px(180), px(62), px(20), px(16), px(5),
        px(180), px(83), px(20), px(16), px(5), RED)

def icon(name, size=20, color=INK, sw=2):
    paths = {
      "send": '<path d="M4 12 20 4l-4 16-4-7z"></path><path d="M12 13 20 4"></path>',
      "receive": '<rect x="4" y="4" width="6" height="6" rx="1"></rect><rect x="14" y="4" width="6" height="6" rx="1"></rect><rect x="4" y="14" width="6" height="6" rx="1"></rect><path d="M14 14h3v3M20 14v6h-6"></path>',
      "home": '<path d="M4 11 12 4l8 7v9H4z"></path><path d="M10 20v-6h4v6"></path>',
      "clock": '<circle cx="12" cy="12" r="8"></circle><path d="M12 8v4l3 2"></path>',
      "key": '<circle cx="8" cy="14" r="4"></circle><path d="M11 11 20 2M16 6l3 3M14 8l2 2"></path>',
      "gear": '<circle cx="12" cy="12" r="3"></circle><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4"></path>',
      "back": '<path d="M14 5l-7 7 7 7"></path>',
      "scan": '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"></path><path d="M4 12h16"></path>',
      "face": '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M9 9v1M15 9v1M12 9v4h-1"></path><path d="M9 15c1 1.2 2 1.5 3 1.5s2-.3 3-1.5"></path>',
      "finger": '<path d="M7 12a5 5 0 0 1 10 0v2M9 12a3 3 0 0 1 6 0v4M12 12v8M5 9a8 8 0 0 1 14 0M14 20v-3"></path>',
      "check": '<path d="M5 12l4 4 10-10"></path>',
      "chip": '<rect x="7" y="7" width="10" height="10" rx="2"></rect><path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4"></path>',
      "phone": '<rect x="7" y="3" width="10" height="18" rx="2"></rect><path d="M11 18h2"></path>',
      "laptop": '<rect x="4" y="5" width="16" height="11" rx="1.5"></rect><path d="M2 19h20"></path>',
      "shield": '<path d="M12 3l8 3v6c0 4.5-3.5 7.8-8 9-4.5-1.2-8-4.5-8-9V6z"></path><path d="M9 12l2 2 4-4"></path>',
      "copy": '<rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V6a1 1 0 0 1 1-1h9"></path>',
      "arrowr": '<path d="M5 12h14M13 6l6 6-6 6"></path>',
      "arrowdl": '<path d="M18 6 6 18M6 8v10h10"></path>',
      "arrowur": '<path d="M6 18 18 6M8 6h10v10"></path>',
      "x": '<path d="M6 6l12 12M18 6 6 18"></path>',
      "plus": '<path d="M12 5v14M5 12h14"></path>',
      "dots": '<circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle>',
      "lock": '<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>',
      "wifi": '<path d="M3 9a14 14 0 0 1 18 0M6.5 12.5a9 9 0 0 1 11 0M10 16a4 4 0 0 1 4 0"></path><circle cx="12" cy="19" r="1"></circle>',
      "wallet": '<path d="M3 7a2 2 0 0 1 2-2h13v4H5a2 2 0 0 1-2-2z"></path><path d="M3 7v11a2 2 0 0 0 2 2h15V9H5"></path><circle cx="16" cy="14.5" r="1.5"></circle>',
    }
    return ('<svg width="%d" height="%d" viewBox="0 0 24 24" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0">%s</svg>') % (size, size, color, sw, paths[name])

def wordmark(size=22, color=INK):
    mark = ('<svg width="%d" height="%d" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" style="display:block">'
      '<rect x="6" y="9" width="28" height="24" rx="7" fill="#ffffff" stroke="#d9d9d5"></rect>'
      '<path d="M12 9c0-3 2-5 5-5h9l7 6H11z" fill="%s"></path>'
      '<rect x="23" y="18" width="11" height="8" rx="3" fill="#ffffff" stroke="#d9d9d5"></rect><circle cx="29" cy="22" r="2" fill="#6b6b69"></circle>'
      '<rect x="0" y="16" width="6" height="3" rx="1.5" fill="%s"></rect><rect x="-2" y="21" width="8" height="3" rx="1.5" fill="%s"></rect><rect x="0" y="26" width="6" height="3" rx="1.5" fill="%s"></rect>'
      '</svg>') % (int(size*1.6), int(size*1.6), GREEN, GREEN, GREEN, GREEN)
    return ('<div style="display:flex;align-items:center;gap:8px"><div>%s</div><div style="font-weight:800;font-size:%dpx;letter-spacing:-0.03em;color:%s;line-height:1">Instant Wallet</div></div>') % (mark, size, color)

def card(inner, style=""):
    return '<div style="background:%s;border-radius:24px;box-shadow:%s;border:1px solid %s;%s">%s</div>' % (CARD, CLAY, LINE, style, inner)

def pill_btn(label, bg=INK, fg="#fff", ic=None, h=56, style="", shadow=True):
    sh = "box-shadow:0 1px 0 rgba(255,255,255,.25) inset, 0 8px 18px rgba(20,20,20,.14);" if shadow else ""
    i = ('<div>%s</div>' % icon(ic, 20, fg)) if ic else ""
    return ('<div style="display:flex;align-items:center;justify-content:center;gap:10px;height:%dpx;border-radius:999px;background:%s;color:%s;font-weight:600;font-size:17px;%s%s">%s<div>%s</div></div>') % (h, bg, fg, sh, style, i, label)

def tab_bar(active):
    items=[("home","Home"),("send","Send"),("receive","Receive"),("clock","Activity")]
    cells=[]
    for k,l in items:
        on = k==active
        cells.append('<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 0;border-radius:16px;background:%s;color:%s;font-size:12px;font-weight:600"><div>%s</div><div>%s</div></div>' % (GREEN_L if on else "transparent", GREEN_D if on else MUTED, icon(k,22,GREEN_D if on else MUTED), l))
    return card('<div style="display:flex;gap:4px;padding:6px">%s</div>' % "".join(cells), "border-radius:28px;")

def phone(inner, bg=BG):
    return ('<div style="width:390px;height:844px;background:%s;position:relative;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box">%s</div>') % (bg, inner)

def topbar(title, left="back", right=None):
    l = '<div style="width:44px;height:44px;border-radius:999px;background:#fff;border:1px solid %s;display:flex;align-items:center;justify-content:center;box-shadow:%s">%s</div>' % (LINE, SHADOW, icon(left,22))
    r = ('<div style="width:44px;height:44px;border-radius:999px;background:#fff;border:1px solid %s;display:flex;align-items:center;justify-content:center;box-shadow:%s">%s</div>' % (LINE, SHADOW, icon(right,22))) if right else '<div style="width:44px;height:44px"></div>'
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:0 20px;height:44px">%s<div style="font-weight:700;font-size:18px">%s</div>%s</div>' % (l, title, r)

def row(ic, title, sub, right, right_sub="", ic_bg=GREEN_L, ic_color=GREEN_D, chevron=True):
    return ('<div style="display:flex;align-items:center;gap:14px;padding:14px 16px;min-height:44px">'
            '<div style="width:44px;height:44px;border-radius:14px;background:%s;display:flex;align-items:center;justify-content:center">%s</div>'
            '<div style="flex:1;display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:16px">%s</div><div style="font-size:13px;color:%s">%s</div></div>'
            '%s%s</div>') % (
            ic_bg, icon(ic,22,ic_color), title, MUTED, sub,
            ('<div style="display:flex;flex-direction:column;align-items:flex-end;gap:2px"><div style="font-weight:600;font-size:16px">%s</div>%s</div>' % (right, ('<div style="font-size:13px;color:%s">%s</div>' % (MUTED, right_sub)) if right_sub else "")) if right else "",
            ('<div>%s</div>' % icon("arrowr",18,"#b7b7b3")) if chevron else "")

def divider():
    return '<div style="height:1px;background:%s;margin:0 16px"></div>' % LINE

def match_code(words="amber fox 42", size=18):
    return ('<div style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:#fff8e1;border:1px solid #f1e2a6;color:#7a5a00;font-weight:700;font-size:%dpx;letter-spacing:0.02em" class="mono">%s</div>') % (size, words)

# ============ MOBILE ============
def m_home():
    bal = ('<div style="background:%s;border-radius:24px;padding:22px 22px 0;color:#fff;box-shadow:0 14px 34px rgba(20,20,20,.18);overflow:hidden">'
           '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
           '<div style="display:flex;flex-direction:column;gap:6px"><div style="font-size:14px;color:#9a9d9a;font-weight:500">Total balance</div>'
           '<div style="font-size:40px;font-weight:700;letter-spacing:-0.03em;line-height:1" class="mono">$2,847.13</div>'
           '<div style="display:flex;align-items:center;gap:6px;color:%s;font-size:14px;font-weight:600"><div>%s</div><div>+$14.02 today · 4.1%% APY</div></div></div>'
           '<div style="display:flex;align-items:center;gap:6px;background:rgba(255,255,255,.08);border-radius:999px;padding:6px 10px;font-size:12px;font-weight:600;color:#cfd2cf"><div style="width:8px;height:8px;border-radius:999px;background:%s"></div><div>Base · USDC</div></div>'
           '</div><div style="margin:14px -22px 0">%s</div></div>') % (SCREEN, SGREEN, icon("arrowur",14,SGREEN), SGREEN, sparkline(390, 96, seed=5))
    actions = ('<div style="display:flex;gap:12px">'
               '<div style="flex:1">%s</div><div style="flex:1">%s</div></div>') % (
               pill_btn("Send", GREEN, "#fff", "send"), pill_btn("Receive", "#fff", INK, "receive", style="border:1px solid %s;" % LINE, shadow=False))
    keys = card(('<div style="display:flex;align-items:center;gap:12px;padding:14px 16px">'
                 '<div style="display:flex;gap:-6px"><div style="width:36px;height:36px;border-radius:999px;background:%s;display:flex;align-items:center;justify-content:center">%s</div>'
                 '<div style="width:36px;height:36px;border-radius:999px;background:%s;display:flex;align-items:center;justify-content:center;margin-left:-8px;border:2px solid #fff">%s</div></div>'
                 '<div style="flex:1;display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:15px">Face ID + your device</div><div style="font-size:13px;color:%s">Face ID up to $500/day · device for the rest</div></div>'
                 '<div>%s</div></div>') % (GREEN_L, icon("face",20,GREEN_D), "#eeeeeb", icon("chip",20,INK), MUTED, icon("arrowr",18,"#b7b7b3")))
    act = card(('<div style="display:flex;justify-content:space-between;align-items:center;padding:16px 16px 6px"><div style="font-weight:700;font-size:16px">Activity</div><div style="font-size:14px;color:%s;font-weight:600">See all</div></div>' % GREEN_D)
               + row("arrowdl","Received","from coinbase · 1h ago","+$250.00","",GREEN_L,GREEN_D,False)
               + divider()
               + row("arrowur","Sent","to vault.atg.eth · device · 1d ago","−$2,000.00","",'#eeeeeb',INK,False))
    inner = ('<div style="padding:60px 20px 0;display:flex;justify-content:space-between;align-items:center">%s'
             '<div style="width:44px;height:44px;border-radius:999px;background:#fff;border:1px solid %s;display:flex;align-items:center;justify-content:center;box-shadow:%s">%s</div></div>'
             '<div style="padding:18px 20px 0;display:flex;flex-direction:column;gap:14px">%s%s%s%s</div>'
             '<div style="margin-top:auto;padding:12px 16px 24px">%s</div>') % (wordmark(20), LINE, SHADOW, icon("gear",22), bal, actions, keys, act, tab_bar("home"))
    return phone(inner)

def m_send():
    amount = ('<div style="background:%s;border-radius:24px;padding:22px;color:#fff;box-shadow:0 14px 34px rgba(20,20,20,.18);display:flex;flex-direction:column;gap:8px">'
              '<div style="font-size:13px;color:#9a9d9a;font-weight:500">Amount</div>'
              '<div style="display:flex;align-items:baseline;gap:6px"><div style="font-size:52px;font-weight:700;letter-spacing:-0.03em;line-height:1" class="mono">$45</div><div style="font-size:18px;color:#9a9d9a">.00</div></div>'
              '<div style="font-size:13px;color:#9a9d9a">USDC on Base · fee $0.02</div></div>') % SCREEN
    to = card(('<div style="display:flex;align-items:center;gap:12px;padding:12px 16px">'
               '<div style="width:44px;height:44px;border-radius:999px;background:linear-gradient(135deg,#8ee27a,#2ea3ff);"></div>'
               '<div style="flex:1;display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:16px">kev.eth</div><div style="font-size:13px;color:%s" class="mono">0x34aA3F…7732c</div></div>'
               '<div>%s</div></div>') % (MUTED, icon("scan",22)))
    quick = '<div style="display:flex;gap:8px">%s</div>' % "".join('<div style="flex:1;height:44px;border-radius:999px;background:#fff;border:1px solid %s;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15px">%s</div>' % (LINE, v) for v in ("$20","$45","$100","Max"))
    keys = '<div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:8px">%s</div>' % "".join(
        '<div style="height:52px;border-radius:16px;background:#fff;border:1px solid %s;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;box-shadow:0 1px 0 #fff inset,0 2px 6px rgba(20,20,20,.05)">%s</div>' % (LINE, k) for k in ("1","2","3","4","5","6","7","8","9",".","0","⌫"))
    sheet = ('<div style="position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:32px 32px 0 0;box-shadow:0 -12px 40px rgba(20,20,20,.16);padding:14px 20px 28px;display:flex;flex-direction:column;gap:16px;align-items:center">'
             '<div style="width:44px;height:5px;border-radius:999px;background:#e3e3df"></div>'
             '<div style="width:88px;height:88px;border-radius:999px;background:%s;display:flex;align-items:center;justify-content:center">%s</div>'
             '<div style="display:flex;flex-direction:column;align-items:center;gap:4px"><div style="font-weight:700;font-size:22px">Send $45.00 to kev.eth</div><div style="font-size:14px;color:%s">Face ID confirms it. Under your $500 daily limit.</div></div>'
             '<div style="width:100%%;display:flex;flex-direction:column;gap:10px">%s%s</div></div>') % (GREEN_L, icon("face",44,GREEN_D,1.6), MUTED,
             pill_btn("Confirm with Face ID", INK, "#fff", "face"), pill_btn("Cancel", "#fff", INK, style="border:1px solid %s;" % LINE, shadow=False))
    inner = ('<div style="padding-top:60px">%s</div><div style="padding:18px 20px 0;display:flex;flex-direction:column;gap:14px">%s%s%s%s</div>%s') % (topbar("Send","back","scan"), amount, to, quick, keys, sheet)
    return phone(inner)

def m_send_device():
    """Over the passkey limit: the request goes to the hardware device."""
    header = ('<div style="display:flex;flex-direction:column;align-items:center;gap:6px;text-align:center;padding:0 12px">'
              '<div style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:999px;background:%s;color:#8a5a00;font-size:13px;font-weight:600;border:1px solid #f1e2a6"><div>%s</div><div>Over your $500 Face ID limit</div></div>'
              '<div style="font-size:26px;font-weight:700;letter-spacing:-0.02em;margin-top:6px">Confirm on your device</div>'
              '<div style="font-size:15px;color:%s;line-height:1.4">Press the green button on your Instant Wallet. Check the amount, the name and the code match.</div></div>') % ("#fff8e1", icon("shield",16,"#8a5a00"), MUTED)
    screen = ('<g><rect x="70" y="22" width="96" height="70" rx="7" fill="%s"></rect>'
              '<rect x="70" y="22" width="96" height="16" rx="7" fill="%s"></rect><rect x="70" y="30" width="96" height="8" fill="%s"></rect>'
              '<text x="118" y="34" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">SIGN</text>'
              '<text x="118" y="58" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">$2,000</text>'
              '<text x="118" y="70" text-anchor="middle" font-size="7" fill="%s" font-family="Silkscreen, monospace">to vault.atg.eth</text>'
              '<rect x="70" y="80" width="96" height="12" rx="7" fill="%s"></rect><rect x="70" y="80" width="96" height="6" fill="%s"></rect>'
              '<text x="118" y="89" text-anchor="middle" font-size="7" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">REJECT</text></g>') % (SCREEN, GREEN, GREEN, YEL, RED, RED)
    dev = '<div style="display:flex;justify-content:center;padding:6px 0">%s</div>' % device_svg(300, screen, glow=True)
    summary = card(('<div style="display:flex;flex-direction:column;gap:0">'
                    '<div style="display:flex;justify-content:space-between;padding:14px 16px"><div style="color:%s">Amount</div><div style="font-weight:700" class="mono">$2,000.00</div></div>%s'
                    '<div style="display:flex;justify-content:space-between;padding:14px 16px"><div style="color:%s">To</div><div style="font-weight:600">vault.atg.eth</div></div>%s'
                    '<div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px"><div style="color:%s">Match code</div><div>%s</div></div></div>') % (MUTED, divider(), MUTED, divider(), MUTED, match_code()))
    waiting = ('<div style="display:flex;align-items:center;justify-content:center;gap:10px;color:%s;font-size:14px;font-weight:500">'
               '<div style="width:10px;height:10px;border-radius:999px;background:%s;box-shadow:0 0 0 6px %s"></div><div>Waiting for the green button… device is online</div></div>') % (MUTED, GREEN, GREEN_L)
    inner = ('<div style="padding-top:60px">%s</div><div style="padding:14px 20px 0;display:flex;flex-direction:column;gap:14px">%s%s%s%s</div>'
             '<div style="margin-top:auto;padding:0 20px 28px">%s</div>') % (topbar("Send","back"), header, dev, summary, waiting, pill_btn("Cancel", "#fff", RED, style="border:1px solid %s;" % LINE, shadow=False))
    return phone(inner)

def m_pair():
    step = lambda n, t, s, done=False: ('<div style="display:flex;gap:14px;align-items:flex-start"><div style="width:32px;height:32px;border-radius:999px;background:%s;color:%s;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;flex-shrink:0">%s</div>'
        '<div style="display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:16px">%s</div><div style="font-size:14px;color:%s;line-height:1.4">%s</div></div></div>') % (GREEN if done else "#fff", "#fff" if done else INK, icon("check",16,"#fff") if done else n, t, MUTED, s)
    screen = ('<g><rect x="70" y="22" width="96" height="70" rx="7" fill="%s"></rect>'
              '<rect x="86" y="27" width="46" height="46" rx="3" fill="#fff"></rect>'
              '<rect x="90" y="31" width="10" height="10" fill="%s"></rect><rect x="118" y="31" width="10" height="10" fill="%s"></rect><rect x="90" y="59" width="10" height="10" fill="%s"></rect>'
              '<rect x="104" y="33" width="3" height="3" fill="%s"></rect><rect x="110" y="37" width="3" height="3" fill="%s"></rect><rect x="104" y="44" width="3" height="3" fill="%s"></rect><rect x="112" y="48" width="3" height="3" fill="%s"></rect><rect x="118" y="46" width="3" height="3" fill="%s"></rect><rect x="122" y="56" width="3" height="3" fill="%s"></rect><rect x="108" y="60" width="3" height="3" fill="%s"></rect><rect x="116" y="64" width="3" height="3" fill="%s"></rect>'
              '<text x="118" y="84" text-anchor="middle" font-size="6.5" fill="%s" font-family="Silkscreen, monospace">SCAN TO PAIR</text></g>') % ((SCREEN,) + (SCREEN,)*11 + (YEL,))
    view = ('<div style="position:relative;border-radius:24px;overflow:hidden;background:#2b2c2b;height:300px;display:flex;align-items:center;justify-content:center">'
            '<div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, rgba(0,0,0,0) 40%%, rgba(0,0,0,.55) 100%%)"></div>'
            '%s'
            '<div style="position:absolute;left:36px;right:36px;top:36px;bottom:36px;border:3px solid %s;border-radius:22px;opacity:.9"></div>'
            '<div style="position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#fff;font-size:13px;font-weight:600;opacity:.9">Point at the device screen</div></div>') % (device_svg(300, screen), GREEN)
    steps = card('<div style="display:flex;flex-direction:column;gap:16px;padding:18px 16px">%s%s%s</div>' % (
        step("1","Turn on your device","Hold the green button. It shows a code on screen."),
        step("2","Scan it with this phone","That tells your account the device's public key. Nothing leaves the chip."),
        step("3","Confirm with Face ID","Your account adds the device as a signer. Same address, one more key.")))
    inner = ('<div style="padding-top:60px">%s</div><div style="padding:14px 20px 0;display:flex;flex-direction:column;gap:14px">'
             '<div style="display:flex;flex-direction:column;gap:4px"><div style="font-size:26px;font-weight:700;letter-spacing:-0.02em">Add your device</div><div style="font-size:15px;color:%s;line-height:1.4">A $35 signer you build yourself. It becomes the key for anything over your Face ID limit.</div></div>%s%s</div>'
             '<div style="margin-top:auto;padding:0 20px 28px">%s</div>') % (topbar("Add your device","back"), MUTED, view, steps, pill_btn("Confirm with Face ID", INK, "#fff", "face"))
    return phone(inner)

def m_keys():
    def keyrow(ic, title, sub, badge, badge_bg, badge_fg, ic_bg=GREEN_L, ic_fg=GREEN_D):
        return ('<div style="display:flex;align-items:center;gap:14px;padding:14px 16px">'
                '<div style="width:44px;height:44px;border-radius:14px;background:%s;display:flex;align-items:center;justify-content:center">%s</div>'
                '<div style="flex:1;display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:16px">%s</div><div style="font-size:13px;color:%s">%s</div></div>'
                '<div style="padding:5px 10px;border-radius:999px;background:%s;color:%s;font-size:12px;font-weight:700">%s</div></div>') % (ic_bg, icon(ic,22,ic_fg), title, MUTED, sub, badge_bg, badge_fg, badge)
    keys = card(('<div style="padding:14px 16px 2px;font-weight:700;font-size:16px">Your keys</div>'
                 + keyrow("face","iPhone · Face ID","this phone · added Sep 2","$500 / day", GREEN_L, GREEN_D)
                 + divider()
                 + keyrow("finger","MacBook · Touch ID","added Sep 4","$500 / day", GREEN_L, GREEN_D)
                 + divider()
                 + keyrow("chip","Instant Wallet device","key 04a1…c7f2 · online","No limit", INK, "#fff", "#eeeeeb", INK)
                 + divider()
                 + '<div style="display:flex;align-items:center;gap:10px;padding:14px 16px;color:%s;font-weight:600;font-size:15px"><div>%s</div><div>Add a key</div></div>' % (GREEN_D, icon("plus",20,GREEN_D))))
    limit = card(('<div style="display:flex;flex-direction:column;gap:12px;padding:16px">'
                  '<div style="display:flex;justify-content:space-between;align-items:baseline"><div style="font-weight:700;font-size:16px">Face ID daily limit</div><div style="font-weight:700;font-size:18px" class="mono">$500</div></div>'
                  '<div style="position:relative;height:8px;border-radius:999px;background:#e9e9e5"><div style="position:absolute;left:0;top:0;bottom:0;width:38%%;border-radius:999px;background:%s"></div><div style="position:absolute;left:38%%;top:50%%;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:999px;background:#fff;box-shadow:0 2px 8px rgba(20,20,20,.25);border:1px solid %s"></div></div>'
                  '<div style="font-size:13px;color:%s;line-height:1.4">Above this, your device signs. Raising it asks the device too.</div></div>') % (GREEN, LINE, MUTED))
    recovery = card(('<div style="display:flex;flex-direction:column;gap:0">'
                     '<div style="padding:16px 16px 4px;font-weight:700;font-size:16px">If something goes wrong</div>'
                     + row("shield","Lost this phone?","Green button on the device adds a new one","","",GREEN_L,GREEN_D,True)
                     + divider()
                     + row("wallet","Recovery address","coinbase · 1-day delay","","","#eeeeeb",INK,True)
                     + divider()
                     + row("lock","Guardian","the app, until you set your own","","","#eeeeeb",INK,True) + '</div>'))
    inner = ('<div style="padding-top:60px">%s</div><div style="padding:14px 20px 24px;display:flex;flex-direction:column;gap:14px;overflow:hidden">%s%s%s</div>') % (topbar("Keys & limits","back"), keys, limit, recovery)
    return phone(inner)

def m_welcome():
    hero = ('<div style="display:flex;flex-direction:column;align-items:center;gap:22px;padding:0 24px;text-align:center">'
            '<div style="width:200px;height:200px;border-radius:48px;background:#fff;border:1px solid %s;box-shadow:%s;display:flex;align-items:center;justify-content:center">'
            '<svg width="140" height="140" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="9" width="28" height="24" rx="7" fill="#ffffff" stroke="#d9d9d5"></rect><path d="M12 9c0-3 2-5 5-5h9l7 6H11z" fill="%s"></path><rect x="23" y="18" width="11" height="8" rx="3" fill="#ffffff" stroke="#d9d9d5"></rect><circle cx="29" cy="22" r="2" fill="#6b6b69"></circle><rect x="0" y="16" width="6" height="3" rx="1.5" fill="%s"></rect><rect x="-2" y="21" width="8" height="3" rx="1.5" fill="%s"></rect><rect x="0" y="26" width="6" height="3" rx="1.5" fill="%s"></rect></svg></div>'
            '<div style="display:flex;flex-direction:column;gap:10px"><div style="font-size:44px;font-weight:800;letter-spacing:-0.04em;line-height:1">Instant<br>Wallet</div><div style="font-size:18px;color:%s">Your money, instantly.</div></div></div>') % (LINE, CLAY, GREEN, GREEN, GREEN, GREEN, MUTED)
    tiny = '<div style="text-align:center;font-size:13px;color:%s;line-height:1.5">No seed phrase. No gas. Face ID makes the key,<br>a $35 device you build guards the big money.</div>' % MUTED
    inner = ('<div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding-top:40px">%s</div>'
             '<div style="padding:0 20px 36px;display:flex;flex-direction:column;gap:12px">%s%s%s</div>') % (hero, pill_btn("Get started", INK, "#fff", "arrowr"), pill_btn("I already have a key", "#fff", INK, "face", style="border:1px solid %s;" % LINE, shadow=False), tiny)
    return phone(inner)

# ============ DEVICE SCREENS (240x240 at 2x) ============
def dev(inner, chain="base", dot=GREEN):
    return ('<div style="width:480px;height:480px;background:%s;position:relative;overflow:hidden;color:#fff" class="px">'
            '<div style="position:absolute;left:8px;top:8px;font-size:16px;color:%s">%s</div>'
            '<div style="position:absolute;right:12px;top:8px;width:16px;height:16px;background:%s"></div>%s</div>') % (SCREEN, GREEN if chain=="base" else YEL, chain, dot, inner)

def dev_home():
    inner = ('<div style="position:absolute;left:0;right:0;top:56px;text-align:center;font-size:56px;font-weight:700;line-height:1">$2,847.13</div>'
             '<div style="position:absolute;left:0;right:0;top:120px;text-align:center;font-size:16px;color:%s">+$14.02  USDC</div>'
             '<div style="position:absolute;left:0;right:0;top:160px">%s</div>'
             '<div style="position:absolute;left:0;right:0;top:396px;text-align:center;font-size:18px;color:%s">atg.eth</div>'
             '<div style="position:absolute;left:0;right:0;bottom:0;height:32px;background:#2a2b2a;text-align:center;font-size:16px;line-height:32px;color:#9a9d9a">A: receive   Y: keys</div>') % (SGREEN, sparkline(480, 220, seed=5, stroke=6), YEL)
    return dev(inner)

def dev_sign():
    inner = ('<div style="position:absolute;left:0;top:0;right:0;height:120px;background:%s;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700">SIGN<div style="position:absolute;right:20px;top:44px;width:0;height:0;border-top:16px solid transparent;border-bottom:16px solid transparent;border-left:20px solid #fff"></div></div>'
             '<div style="position:absolute;left:0;right:0;top:136px;text-align:center;font-size:56px;font-weight:700;line-height:1">$2,000</div>'
             '<div style="position:absolute;left:0;right:0;top:200px;text-align:center;font-size:16px;color:#9a9d9a">USDC   to</div>'
             '<div style="position:absolute;left:0;right:0;top:232px;text-align:center;font-size:32px;color:%s">vault.atg.eth</div>'
             '<div style="position:absolute;left:0;right:0;top:272px;text-align:center;font-size:16px;color:#9a9d9a">0x9C1a…4f2E</div>'
             '<div style="position:absolute;left:0;right:0;top:312px;text-align:center;font-size:22px;color:#fff;background:#3a3100;line-height:44px;margin:0 60px;border:2px solid %s">amber fox 42</div>'
             '<div style="position:absolute;left:0;right:0;bottom:0;height:100px;background:%s;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700">REJECT<div style="position:absolute;right:20px;top:34px;width:0;height:0;border-top:16px solid transparent;border-bottom:16px solid transparent;border-left:20px solid #fff"></div></div>') % (GREEN, YEL, YEL, RED)
    return ('<div style="width:480px;height:480px;background:%s;position:relative;overflow:hidden;color:#fff" class="px">%s</div>') % (SCREEN, inner)

def dev_pair():
    inner = ('<div style="position:absolute;left:0;right:0;top:36px;text-align:center;font-size:24px;color:#fff">PAIR THIS DEVICE</div>'
             '<div style="position:absolute;left:96px;top:80px">%s</div>'
             '<div style="position:absolute;left:0;right:0;top:384px;text-align:center;font-size:16px;color:%s">scan with your phone</div>'
             '<div style="position:absolute;left:0;right:0;top:412px;text-align:center;font-size:14px;color:#9a9d9a">key 04a1…c7f2  never leaves chip</div>'
             '<div style="position:absolute;left:0;right:0;bottom:0;height:32px;background:%s;text-align:center;font-size:16px;line-height:32px;color:#fff">Y: cancel</div>') % (fake_qr(288, modules=25, seed=11), YEL, RED)
    return dev(inner, dot=RED)

def dev_addkey():
    inner = ('<div style="position:absolute;left:0;top:0;right:0;height:120px;background:%s;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:700">ADD KEY<div style="position:absolute;right:20px;top:44px;width:0;height:0;border-top:16px solid transparent;border-bottom:16px solid transparent;border-left:20px solid #fff"></div></div>'
             '<div style="position:absolute;left:0;right:0;top:140px;text-align:center;font-size:16px;color:#9a9d9a">new phone wants to join</div>'
             '<div style="position:absolute;left:0;right:0;top:176px;text-align:center;font-size:32px;color:%s">iPhone  Face ID</div>'
             '<div style="position:absolute;left:0;right:0;top:224px;text-align:center;font-size:16px;color:#fff">limit $500 / day</div>'
             '<div style="position:absolute;left:0;right:0;top:256px;text-align:center;font-size:16px;color:#9a9d9a">replaces: iPhone (lost)</div>'
             '<div style="position:absolute;left:0;right:0;top:300px;text-align:center;font-size:22px;color:#fff;background:#3a3100;line-height:44px;margin:0 60px;border:2px solid %s">cobalt owl 17</div>'
             '<div style="position:absolute;left:0;right:0;bottom:0;height:100px;background:%s;display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700">REJECT<div style="position:absolute;right:20px;top:34px;width:0;height:0;border-top:16px solid transparent;border-bottom:16px solid transparent;border-left:20px solid #fff"></div></div>') % (GREEN, YEL, YEL, RED)
    return ('<div style="width:480px;height:480px;background:%s;position:relative;overflow:hidden;color:#fff" class="px">%s</div>') % (SCREEN, inner)

# ============ DESKTOP ============
def d_shell(main, right, modal=""):
    nav_items=[("home","Home",True),("send","Send",False),("receive","Receive",False),("clock","Activity",False),("key","Keys & limits",False),("gear","Settings",False)]
    nav = "".join('<div style="display:flex;align-items:center;gap:12px;height:44px;padding:0 14px;border-radius:14px;background:%s;color:%s;font-weight:600;font-size:15px"><div>%s</div><div>%s</div></div>' % (GREEN_L if on else "transparent", GREEN_D if on else INK, icon(ic,20,GREEN_D if on else MUTED), l) for ic,l,on in nav_items)
    side = ('<div style="width:248px;padding:28px 18px;display:flex;flex-direction:column;gap:28px;border-right:1px solid %s;background:#fbfbf9;box-sizing:border-box">'
            '<div style="padding:0 8px">%s</div><div style="display:flex;flex-direction:column;gap:4px">%s</div>'
            '<div style="margin-top:auto">%s</div></div>') % (LINE, wordmark(18), nav,
            card('<div style="display:flex;align-items:center;gap:10px;padding:12px"><div style="width:36px;height:36px;border-radius:999px;background:linear-gradient(135deg,#8ee27a,#2ea3ff)"></div><div style="display:flex;flex-direction:column;gap:2px"><div style="font-weight:700;font-size:14px">atg.eth</div><div style="font-size:12px;color:%s" class="mono">0x8B2f…19aC</div></div><div style="margin-left:auto">%s</div></div>' % (MUTED, icon("copy",18,MUTED)), "border-radius:18px;"))
    return ('<div style="width:1440px;height:900px;background:%s;display:flex;overflow:hidden;position:relative;box-sizing:border-box">%s'
            '<div style="flex:1;padding:28px 32px;display:flex;flex-direction:column;gap:20px;min-width:0;box-sizing:border-box">%s</div>'
            '<div style="width:400px;padding:28px 32px 28px 0;display:flex;flex-direction:column;gap:20px;box-sizing:border-box">%s</div>%s</div>') % (BG, side, main, right, modal)

def d_main():
    top = ('<div style="display:flex;align-items:center;justify-content:space-between"><div style="font-size:28px;font-weight:700;letter-spacing:-0.02em">Good morning, Austin</div>'
           '<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:#fff;border:1px solid %s;font-size:13px;font-weight:600;color:%s"><div style="width:8px;height:8px;border-radius:999px;background:%s"></div><div>Device online · Base</div></div></div>') % (LINE, INK, GREEN)
    bal = ('<div style="background:%s;border-radius:28px;padding:26px 28px 0;color:#fff;box-shadow:0 18px 44px rgba(20,20,20,.16);overflow:hidden;display:flex;flex-direction:column">'
           '<div style="display:flex;justify-content:space-between;align-items:flex-start">'
           '<div style="display:flex;flex-direction:column;gap:8px"><div style="font-size:14px;color:#9a9d9a;font-weight:500">Total balance</div>'
           '<div style="font-size:52px;font-weight:700;letter-spacing:-0.03em;line-height:1" class="mono">$2,847.13</div>'
           '<div style="display:flex;align-items:center;gap:6px;color:%s;font-size:15px;font-weight:600"><div>%s</div><div>+$14.02 today · earning 4.1%% APY</div></div></div>'
           '<div style="display:flex;gap:6px">%s</div></div>'
           '<div style="margin:10px -28px 0">%s</div></div>') % (SCREEN, SGREEN, icon("arrowur",16,SGREEN),
           "".join('<div style="padding:6px 12px;border-radius:999px;background:%s;color:%s;font-size:13px;font-weight:600">%s</div>' % ("#fff" if r=="1M" else "rgba(255,255,255,.08)", INK if r=="1M" else "#cfd2cf", r) for r in ("1D","1W","1M","1Y","All")),
           sparkline(760, 150, seed=9, stroke=4))
    act = card(('<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 8px"><div style="font-weight:700;font-size:17px">Activity</div><div style="font-size:14px;color:%s;font-weight:600">See all</div></div>' % GREEN_D)
               + row("arrowdl","Received $250.00","from coinbase · 1h ago","+$250.00","confirmed",GREEN_L,GREEN_D,False) + divider()
               + row("arrowur","Sent $120.00 to kev.eth","signed with Touch ID · 1d ago","−$120.00","confirmed","#eeeeeb",INK,False) + divider()
               + row("arrowur","Sent $2,000.00 to vault.atg.eth","signed on the device · 1d ago","−$2,000.00","confirmed","#eeeeeb",INK,False) + divider()
               + row("key","Added key: MacBook · Touch ID","approved on the device · Sep 4","","","#eeeeeb",INK,False))
    return top + bal + act

def d_right(over_limit=False):
    amt = "$2,000" if over_limit else "$45"
    to = "vault.atg.eth" if over_limit else "kev.eth"
    note = (('<div style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border-radius:16px;background:#fff8e1;border:1px solid #f1e2a6;color:#7a5a00;font-size:13px;line-height:1.4"><div>%s</div><div><b>Over your $500 Touch ID limit.</b> This one will ask for the green button on your device.</div></div>' % icon("shield",18,"#8a5a00"))
            if over_limit else
            ('<div style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-radius:16px;background:%s;color:%s;font-size:13px"><div>%s</div><div>Under your $500 daily limit · Touch ID is enough</div></div>' % (GREEN_L, GREEN_D, icon("finger",18,GREEN_D))))
    form = card(('<div style="display:flex;flex-direction:column;gap:14px;padding:20px">'
                 '<div style="font-weight:700;font-size:17px">Send</div>'
                 '<div style="display:flex;flex-direction:column;gap:6px"><div style="font-size:13px;color:%s;font-weight:500">To</div>'
                 '<div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 12px;border-radius:14px;border:1px solid %s;background:#fbfbf9"><div style="width:26px;height:26px;border-radius:999px;background:linear-gradient(135deg,#8ee27a,#2ea3ff)"></div><div style="font-weight:600;flex:1">%s</div><div style="font-size:12px;color:%s" class="mono">%s</div></div></div>'
                 '<div style="display:flex;flex-direction:column;gap:6px"><div style="font-size:13px;color:%s;font-weight:500">Amount</div>'
                 '<div style="display:flex;align-items:center;height:64px;padding:0 16px;border-radius:14px;border:1px solid %s;background:#fbfbf9;font-size:32px;font-weight:700" class="mono">%s<span style="font-size:14px;color:%s;margin-left:auto;font-family:Outfit,sans-serif;font-weight:500">USDC · fee $0.02</span></div></div>'
                 '%s%s</div>') % (MUTED, LINE, to, MUTED, "0x9C1a…4f2E" if over_limit else "0x34aA3F…7732c", MUTED, LINE, amt, MUTED, note,
                 pill_btn("Confirm on device" if over_limit else "Send with Touch ID", INK, "#fff", "chip" if over_limit else "finger", h=52)))
    keys = card(('<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px 6px"><div style="font-weight:700;font-size:17px">Keys</div><div style="font-size:14px;color:%s;font-weight:600">Manage</div></div>' % GREEN_D)
                + row("finger","This Mac · Touch ID","$500 / day","","",GREEN_L,GREEN_D,False) + divider()
                + row("face","iPhone · Face ID","$500 / day","","",GREEN_L,GREEN_D,False) + divider()
                + row("chip","Instant Wallet device","no limit · adds and removes keys","","","#eeeeeb",INK,False))
    return form + keys

def d_modal():
    screen = ('<g><rect x="70" y="22" width="96" height="70" rx="7" fill="%s"></rect>'
              '<rect x="70" y="22" width="96" height="16" rx="7" fill="%s"></rect><rect x="70" y="30" width="96" height="8" fill="%s"></rect>'
              '<text x="118" y="34" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">SIGN</text>'
              '<text x="118" y="58" text-anchor="middle" font-size="15" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">$2,000</text>'
              '<text x="118" y="70" text-anchor="middle" font-size="7" fill="%s" font-family="Silkscreen, monospace">to vault.atg.eth</text>'
              '<rect x="70" y="80" width="96" height="12" rx="7" fill="%s"></rect><rect x="70" y="80" width="96" height="6" fill="%s"></rect>'
              '<text x="118" y="89" text-anchor="middle" font-size="7" font-weight="700" fill="#fff" font-family="Silkscreen, monospace">REJECT</text></g>') % (SCREEN, GREEN, GREEN, YEL, RED, RED)
    box = ('<div style="width:560px;background:#fff;border-radius:32px;box-shadow:0 30px 80px rgba(20,20,20,.3);padding:32px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box">'
           '<div style="display:flex;justify-content:space-between;align-items:flex-start"><div style="display:flex;flex-direction:column;gap:6px"><div style="font-size:26px;font-weight:700;letter-spacing:-0.02em">Confirm on your device</div><div style="font-size:15px;color:%s;line-height:1.45">Press the green button. Make sure the amount, the name and the code on the little screen match this.</div></div><div>%s</div></div>'
           '<div style="display:flex;justify-content:center;padding:6px 0 0">%s</div>'
           '<div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:12px">'
           '<div style="padding:14px;border-radius:18px;background:%s;display:flex;flex-direction:column;gap:4px"><div style="font-size:12px;color:%s">Amount</div><div style="font-weight:700;font-size:20px" class="mono">$2,000.00</div></div>'
           '<div style="padding:14px;border-radius:18px;background:%s;display:flex;flex-direction:column;gap:4px"><div style="font-size:12px;color:%s">To</div><div style="font-weight:700;font-size:20px">vault.atg.eth</div></div>'
           '<div style="padding:14px;border-radius:18px;background:#fff8e1;border:1px solid #f1e2a6;display:flex;flex-direction:column;gap:4px"><div style="font-size:12px;color:#7a5a00">Match code</div><div style="font-weight:700;font-size:17px;color:#7a5a00;white-space:nowrap" class="mono">amber fox 42</div></div></div>'
           '<div style="display:flex;align-items:center;justify-content:space-between">'
           '<div style="display:flex;align-items:center;gap:10px;color:%s;font-size:14px"><div style="width:10px;height:10px;border-radius:999px;background:%s;box-shadow:0 0 0 6px %s"></div><div>Waiting for the green button… device online</div></div>'
           '<div style="padding:10px 18px;border-radius:999px;border:1px solid %s;font-weight:600;color:%s">Cancel</div></div></div>') % (MUTED, icon("x",22,MUTED), device_svg(320, screen, glow=True), BG, MUTED, BG, MUTED, MUTED, GREEN, GREEN_L, LINE, RED)
    return '<div style="position:absolute;inset:0;background:rgba(20,21,20,.45);display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)">%s</div>' % box

# ============ SYSTEM ============
def system():
    def box(title, lines, accent=INK, w="auto"):
        return ('<div style="background:#fff;border:1px solid %s;border-radius:22px;box-shadow:%s;padding:18px 20px;display:flex;flex-direction:column;gap:8px;min-width:0">'
                '<div style="font-weight:700;font-size:17px;color:%s">%s</div>%s</div>') % (LINE, CLAY, accent, title, "".join('<div style="font-size:14px;color:%s;line-height:1.45">%s</div>' % (INK, l) for l in lines))
    def signer(ic, title, sub, tag, tag_bg, tag_fg):
        return ('<div style="display:flex;align-items:center;gap:12px;background:#fff;border:1px solid %s;border-radius:18px;padding:12px 14px;box-shadow:%s">'
                '<div style="width:40px;height:40px;border-radius:12px;background:%s;display:flex;align-items:center;justify-content:center">%s</div>'
                '<div style="flex:1;display:flex;flex-direction:column;gap:2px"><div style="font-weight:600;font-size:15px">%s</div><div style="font-size:12px;color:%s">%s</div></div>'
                '<div style="padding:4px 10px;border-radius:999px;background:%s;color:%s;font-size:12px;font-weight:700;white-space:nowrap">%s</div></div>') % (LINE, SHADOW, GREEN_L if tag_bg==GREEN_L else "#eeeeeb", icon(ic,22,GREEN_D if tag_bg==GREEN_L else INK), title, MUTED, sub, tag_bg, tag_fg, tag)
    arrow = '<div style="display:flex;align-items:center;justify-content:center;color:#b7b7b3">%s</div>' % icon("arrowr",28,"#b7b7b3",1.8)
    col_signers = ('<div style="display:flex;flex-direction:column;gap:10px">'
                   '<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:%s;text-transform:uppercase">Signers · all P-256</div>%s%s%s'
                   '<div style="font-size:13px;color:%s;line-height:1.45;padding:4px 2px">Passkeys sign WebAuthn assertions. The chip signs a raw EIP-712 digest. Same curve, one verifier each, one account.</div></div>') % (MUTED,
                   signer("face","Phone passkey","Secure Enclave · Face ID","spender · $500/day", GREEN_L, GREEN_D),
                   signer("finger","Laptop passkey","Touch ID / Windows Hello","spender · $500/day", GREEN_L, GREEN_D),
                   signer("chip","Instant Wallet device","ATECC608 · $35 · you build it","owner · no limit", INK, "#fff"), MUTED)
    col_contract = ('<div style="display:flex;flex-direction:column;gap:10px">'
                    '<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:%s;text-transform:uppercase">On chain · Base</div>%s%s</div>') % (MUTED,
                    box("InstantWallet.sol (one address, CREATE2 from the first passkey)", [
                        "<b>signers[]</b> · qx, qy, kind (webauthn | raw), role, daily limit",
                        "<b>metaExec(calls, signerId, deadline, sig)</b> · batch, nonce, chain id",
                        "<b>Policy</b> · a spender may move ≤ its limit per 24h; anything else needs an owner signature",
                        "<b>Owner-only</b> · add / remove signers, raise a limit, set recovery",
                        "<b>Recovery</b> · recovery address proposes a new owner key; 1-day delay by default (owner-set); any owner action cancels",
                        "No admin. No upgrade. No unsigned path."], INK),
                    box("Bootstrap", ["Day 1 the passkey is the only signer, so it is the owner. Pairing the device hands ownership to the chip and demotes the passkey to a spender. The address never changes."], GREEN_D))
    col_relay = ('<div style="display:flex;flex-direction:column;gap:10px">'
                 '<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:%s;text-transform:uppercase">Off chain</div>%s%s</div>') % (MUTED,
                 box("Facilitator", ["Relays signed bundles, pays gas, takes a USDC fee inside the bundle.", "Holds the device's request queue (the device polls over WiFi, like picowallet).", "No contract privilege. If it dies, anyone can relay."], INK),
                 box("Match code", ["3 words derived from the digest, shown on the phone <i>and</i> the device. A relay that swaps the request can't fake the code."], "#7a5a00"))
    flow = ('<div style="display:grid;grid-template-columns:minmax(0,1.05fr) 48px minmax(0,1.4fr) 48px minmax(0,1fr);gap:0;align-items:start">%s%s%s%s%s</div>') % (col_signers, arrow, col_contract, arrow, col_relay)
    steps = [("1","Instant","Face ID makes a key. Address exists before any deposit. Good for the first $50."),
             ("2","Guarded","Set a recovery address. Lost phone → the guardian adds a new key after a 1-day delay."),
             ("3","Hardened","Build the $35 device, scan it, done. It owns the account; Face ID keeps a $500/day allowance."),
             ("4","Vault","Limit to $0 for a cold vault, or add a second device. Same address the whole way.")]
    ladder = '<div style="display:grid;grid-template-columns:repeat(4, minmax(0, 1fr));gap:14px">%s</div>' % "".join(
        ('<div style="background:%s;border:1px solid %s;border-radius:22px;padding:18px;display:flex;flex-direction:column;gap:8px;color:%s">'
         '<div style="display:flex;align-items:center;gap:10px"><div style="width:30px;height:30px;border-radius:999px;background:%s;color:%s;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:14px">%s</div><div style="font-weight:700;font-size:17px">%s</div></div>'
         '<div style="font-size:14px;line-height:1.45;color:%s">%s</div></div>') % (
            SCREEN if i==2 else "#fff", LINE, "#fff" if i==2 else INK, GREEN if i==2 else GREEN_L, "#fff" if i==2 else GREEN_D, n, t, "#cfd2cf" if i==2 else MUTED, s)
        for i,(n,t,s) in enumerate(steps))
    inner = ('<div style="width:1440px;min-height:980px;background:%s;padding:40px 44px;box-sizing:border-box;display:flex;flex-direction:column;gap:28px">'
             '<div style="display:flex;justify-content:space-between;align-items:flex-end"><div style="display:flex;flex-direction:column;gap:6px">%s<div style="font-size:30px;font-weight:700;letter-spacing:-0.02em;margin-top:8px">How it fits together</div><div style="font-size:16px;color:%s">progressive-self-custody + picowallet = one account, many P-256 keys, tiered by trust</div></div></div>'
             '%s'
             '<div style="display:flex;flex-direction:column;gap:12px"><div style="font-size:12px;font-weight:700;letter-spacing:0.08em;color:%s;text-transform:uppercase">The ladder · progressive self-custody</div>%s</div></div>') % (BG, wordmark(18), MUTED, flow, MUTED, ladder)
    return inner

# ---------- write everything ----------
write("Main.dc.html", m_home())
write("Welcome.dc.html", m_welcome())
write("Send.dc.html", m_send())
write("SendOnDevice.dc.html", m_send_device())
write("PairDevice.dc.html", m_pair())
write("KeysAndLimits.dc.html", m_keys())
write("Desktop.dc.html", d_shell(d_main(), d_right(False)))
write("DesktopConfirmOnDevice.dc.html", d_shell(d_main(), d_right(True), d_modal()))
write("DeviceHome.dc.html", dev_home())
write("DeviceSign.dc.html", dev_sign())
write("DevicePair.dc.html", dev_pair())
write("DeviceAddKey.dc.html", dev_addkey())
write("System.dc.html", system())

PH=390; PHH=844; G=90
canvas = {
  "pages": [{"id":"mobile","name":"Mobile"},{"id":"desktop","name":"Desktop"},{"id":"device","name":"Device screens"},{"id":"system","name":"How it works"}],
  "artboards": [
    {"file":"Welcome.dc.html","x":0,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Welcome"},
    {"file":"Main.dc.html","x":(PH+G)*1,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Home"},
    {"file":"Send.dc.html","x":(PH+G)*2,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Send · under the limit"},
    {"file":"SendOnDevice.dc.html","x":(PH+G)*3,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Send · over the limit"},
    {"file":"PairDevice.dc.html","x":(PH+G)*4,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Pair the device"},
    {"file":"KeysAndLimits.dc.html","x":(PH+G)*5,"y":0,"w":PH,"h":PHH,"page":"mobile","title":"Keys & limits"},
    {"file":"Desktop.dc.html","x":0,"y":0,"w":1440,"h":900,"page":"desktop","title":"Desktop · home + send"},
    {"file":"DesktopConfirmOnDevice.dc.html","x":0,"y":1040,"w":1440,"h":900,"page":"desktop","title":"Desktop · confirm on device"},
    {"file":"DeviceHome.dc.html","x":0,"y":0,"w":480,"h":480,"page":"device","title":"Device · home (240×240 at 2×)"},
    {"file":"DeviceSign.dc.html","x":570,"y":0,"w":480,"h":480,"page":"device","title":"Device · sign"},
    {"file":"DevicePair.dc.html","x":1140,"y":0,"w":480,"h":480,"page":"device","title":"Device · pair"},
    {"file":"DeviceAddKey.dc.html","x":1710,"y":0,"w":480,"h":480,"page":"device","title":"Device · add a phone key"},
    {"file":"System.dc.html","x":0,"y":0,"w":1440,"h":980,"page":"system","title":"How it fits together"}
  ],
  "annotations": [
    {"id":"note-mobile","x":0,"y":-150,"w":760,"page":"mobile","text":"Mobile flow. Face ID signs anything under the daily limit. Over it, the request goes to the device and both screens show the same 3-word match code. Pairing = scan the device's screen, then Face ID."},
    {"id":"note-desktop","x":0,"y":-150,"w":760,"page":"desktop","text":"Desktop is the same account through a laptop passkey (Touch ID / Windows Hello). Second board: the over-limit modal mirrors what the device shows so the user compares by eye."},
    {"id":"note-device","x":0,"y":-150,"w":760,"page":"device","text":"240×240 screens shown at 2×. Button column on the right: green A = SIGN, red Y = REJECT, same as picowallet. Home matches the concept renders: balance, delta, chart."},
    {"id":"note-system","x":1530,"y":0,"w":300,"page":"system","text":"Both signers are P-256, so one contract verifies both: WebAuthn wrapper for passkeys, raw digest for the chip. Roles, not separate wallets."}
  ],
  "launch": {"view":"canvas","page":"mobile"}
}
with open(os.path.join(OUT,"canvas.json"),"w") as f: json.dump(canvas, f, indent=2)
print("wrote canvas.json")
