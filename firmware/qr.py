# A small QR code encoder in pure Python (MicroPython-compatible, no imports).
# Byte mode, error correction level L, versions 1-10 (up to 271 bytes). Enough for the pairing
# text `iw1:<qx>:<qy>:<name>` (~145 bytes -> version 7, 45x45) and an address (version 3, 29x29).
#
#   n, rows = qr.encode("iw1:...")     # rows[r][c] == 1 -> dark module, n modules per side
#
# The whole thing is a few thousand Python operations plus the mask search; it runs once per key
# on the RP2350 (well under a second) and the result is cached by the caller.

# version -> (data codewords, ec codewords per block, (blocks, data per block) group 1, group 2)
_VER = {
    1: (19, 7, (1, 19), (0, 0)),
    2: (34, 10, (1, 34), (0, 0)),
    3: (55, 15, (1, 55), (0, 0)),
    4: (80, 20, (1, 80), (0, 0)),
    5: (108, 26, (1, 108), (0, 0)),
    6: (136, 18, (2, 68), (0, 0)),
    7: (156, 20, (2, 78), (0, 0)),
    8: (194, 24, (2, 97), (0, 0)),
    9: (232, 30, (2, 116), (0, 0)),
    10: (274, 18, (2, 68), (2, 69)),
}
_ALIGN = {1: (), 2: (6, 18), 3: (6, 22), 4: (6, 26), 5: (6, 30), 6: (6, 34), 7: (6, 22, 38), 8: (6, 24, 42), 9: (6, 26, 46), 10: (6, 28, 50)}
_REMAINDER = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0}

# GF(256) with the QR prime polynomial x^8 + x^4 + x^3 + x^2 + 1
_EXP = bytearray(512)
_LOG = bytearray(256)


def _gf_init():
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_gf_init()


def _gf_mul(a, b):
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _rs_generator(n):
    g = [1]
    for i in range(n):
        ng = [0] * (len(g) + 1)
        for j in range(len(g)):
            ng[j] ^= g[j]
            ng[j + 1] ^= _gf_mul(g[j], _EXP[i])
        g = ng
    return g


def _rs_encode(data, n):
    g = _rs_generator(n)
    rem = bytearray(n)
    for d in data:
        f = d ^ rem[0]
        rem = rem[1:] + b"\x00"
        if f:
            for j in range(n):
                rem[j] ^= _gf_mul(g[j + 1], f)
    return bytes(rem)


def _bch(data, poly, deg):
    """BCH remainder used by the format and version information (poly has degree deg)."""
    v = data << deg
    for i in range(_bits(v) - 1, deg - 1, -1):
        if v >> i & 1:
            v ^= poly << (i - deg)
    return v


def _bits(n):
    b = 0
    while n:
        n >>= 1
        b += 1
    return b


def _format_info(mask):
    data = (1 << 3) | mask            # EC level L = 01
    rem = _bch(data, 0x537, 10)
    return ((data << 10) | rem) ^ 0x5412


def _version_info(v):
    return (v << 12) | _bch(v, 0x1F25, 12)


def _pick_version(nbytes):
    for v in range(1, 11):
        cap = _VER[v][0] * 8 - 4 - (16 if v >= 10 else 8)
        if nbytes * 8 <= cap:
            return v
    raise ValueError("too long for a version 10 QR (%d bytes)" % nbytes)


def _codewords(data, v):
    ndata, nec, g1, g2 = _VER[v]
    bits = []
    ccbits = 16 if v >= 10 else 8

    def put(val, n):
        for i in range(n - 1, -1, -1):
            bits.append(val >> i & 1)

    put(4, 4)
    put(len(data), ccbits)
    for b in data:
        put(b, 8)
    put(0, min(4, ndata * 8 - len(bits)))
    while len(bits) % 8:
        bits.append(0)
    cw = bytearray()
    for i in range(0, len(bits), 8):
        x = 0
        for b in bits[i:i + 8]:
            x = (x << 1) | b
        cw.append(x)
    pad = (0xEC, 0x11)
    i = 0
    while len(cw) < ndata:
        cw.append(pad[i & 1])
        i += 1
    # split into blocks, compute EC, interleave
    blocks = []
    off = 0
    for cnt, k in (g1, g2):
        for _ in range(cnt):
            blocks.append(bytes(cw[off:off + k]))
            off += k
    ecs = [_rs_encode(b, nec) for b in blocks]
    out = bytearray()
    maxk = max(len(b) for b in blocks)
    for i in range(maxk):
        for b in blocks:
            if i < len(b):
                out.append(b[i])
    for i in range(nec):
        for e in ecs:
            out.append(e[i])
    return out


def _new_matrix(v):
    n = 17 + 4 * v
    m = [bytearray(n) for _ in range(n)]     # 1 = dark
    res = [bytearray(n) for _ in range(n)]   # 1 = function pattern / reserved

    def finder(r0, c0):
        for r in range(-1, 8):
            for c in range(-1, 8):
                rr, cc = r0 + r, c0 + c
                if 0 <= rr < n and 0 <= cc < n:
                    res[rr][cc] = 1
                    inside = 0 <= r <= 6 and 0 <= c <= 6
                    ring = r in (0, 6) or c in (0, 6)
                    core = 2 <= r <= 4 and 2 <= c <= 4
                    m[rr][cc] = 1 if inside and (ring or core) else 0

    finder(0, 0)
    finder(0, n - 7)
    finder(n - 7, 0)
    # timing
    for i in range(8, n - 8):
        m[6][i] = m[i][6] = 1 - (i & 1)
        res[6][i] = res[i][6] = 1
    # alignment
    al = _ALIGN[v]
    for r0 in al:
        for c0 in al:
            if (r0 < 9 and c0 < 9) or (r0 < 9 and c0 > n - 10) or (r0 > n - 10 and c0 < 9):
                continue  # would overlap a finder
            for r in range(-2, 3):
                for c in range(-2, 3):
                    m[r0 + r][c0 + c] = 1 if (abs(r) == 2 or abs(c) == 2 or (r == 0 and c == 0)) else 0
                    res[r0 + r][c0 + c] = 1
    # format areas
    for i in range(9):
        res[8][i] = res[i][8] = 1
    for i in range(8):
        res[8][n - 1 - i] = res[n - 1 - i][8] = 1
    m[n - 8][8] = 1  # dark module
    # version areas
    if v >= 7:
        for i in range(6):
            for j in range(3):
                res[i][n - 11 + j] = res[n - 11 + j][i] = 1
    return n, m, res


def _place(m, res, cw, n):
    bits = []
    for b in cw:
        for i in range(7, -1, -1):
            bits.append(b >> i & 1)
    idx = 0
    total = len(bits)
    x = n - 1
    up = True
    while x > 0:
        if x == 6:
            x -= 1
        rows = range(n - 1, -1, -1) if up else range(n)
        for y in rows:
            for dx in (0, 1):
                xx = x - dx
                if not res[y][xx]:
                    m[y][xx] = bits[idx] if idx < total else 0
                    idx += 1
        x -= 2
        up = not up


def _masked(m, res, n, mask):
    out = [bytearray(row) for row in m]
    for i in range(n):
        ri = out[i]
        rr = res[i]
        for j in range(n):
            if rr[j]:
                continue
            if mask == 0:
                f = (i + j) % 2 == 0
            elif mask == 1:
                f = i % 2 == 0
            elif mask == 2:
                f = j % 3 == 0
            elif mask == 3:
                f = (i + j) % 3 == 0
            elif mask == 4:
                f = (i // 2 + j // 3) % 2 == 0
            elif mask == 5:
                f = (i * j) % 2 + (i * j) % 3 == 0
            elif mask == 6:
                f = ((i * j) % 2 + (i * j) % 3) % 2 == 0
            else:
                f = ((i + j) % 2 + (i * j) % 3) % 2 == 0
            if f:
                ri[j] ^= 1
    return out


def _write_format(m, n, mask):
    f = _format_info(mask)
    for k in range(15):
        bit = f >> k & 1
        # copy 1, around the top-left finder
        if k >= 9:
            m[8][14 - k] = bit
        elif k == 8:
            m[8][7] = bit
        elif k == 7:
            m[8][8] = bit
        elif k == 6:
            m[7][8] = bit
        else:
            m[k][8] = bit
        # copy 2, split between the bottom-left and top-right finders
        if k >= 8:
            m[n - 15 + k][8] = bit
        else:
            m[8][n - 1 - k] = bit


def _write_version(m, n, v):
    if v < 7:
        return
    info = _version_info(v)
    for i in range(18):
        bit = info >> i & 1
        m[i // 3][n - 11 + i % 3] = bit
        m[n - 11 + i % 3][i // 3] = bit


def _penalty(m, n):
    score = 0
    # rule 1: runs of 5+ in rows and columns
    for i in range(n):
        row = m[i]
        run = 1
        crun = 1
        for j in range(1, n):
            if row[j] == row[j - 1]:
                run += 1
            else:
                if run >= 5:
                    score += run - 2
                run = 1
            if m[j][i] == m[j - 1][i]:
                crun += 1
            else:
                if crun >= 5:
                    score += crun - 2
                crun = 1
        if run >= 5:
            score += run - 2
        if crun >= 5:
            score += crun - 2
    # rule 2: 2x2 blocks
    for i in range(n - 1):
        a = m[i]
        b = m[i + 1]
        for j in range(n - 1):
            if a[j] == a[j + 1] == b[j] == b[j + 1]:
                score += 3
    # rule 3: finder-like pattern 1011101 with 4 light modules on one side
    p1 = (1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0)
    p2 = (0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1)
    for i in range(n):
        for j in range(n - 10):
            r = tuple(m[i][j:j + 11])
            if r == p1 or r == p2:
                score += 40
            c = tuple(m[j + k][i] for k in range(11))
            if c == p1 or c == p2:
                score += 40
    # rule 4: dark proportion
    dark = 0
    for row in m:
        dark += sum(row)
    pct = dark * 100 // (n * n)
    prev = pct - pct % 5
    score += min(abs(prev - 50), abs(prev + 5 - 50)) // 5 * 10
    return score


def encode(text, version=None, mask=None):
    """text: str or bytes. Returns (n, rows): n modules per side, rows[r][c] = 1 for dark."""
    data = text.encode() if isinstance(text, str) else bytes(text)
    v = version or _pick_version(len(data))
    if v < _pick_version(len(data)):
        raise ValueError("version %d too small" % v)
    cw = _codewords(data, v)
    n, m, res = _new_matrix(v)
    _place(m, res, cw, n)
    if mask is None:
        best = None
        for k in range(8):
            cand = _masked(m, res, n, k)
            _write_format(cand, n, k)
            _write_version(cand, n, v)
            p = _penalty(cand, n)
            if best is None or p < best[0]:
                best = (p, cand)
        out = best[1]
    else:
        out = _masked(m, res, n, mask)
        _write_format(out, n, mask)
        _write_version(out, n, v)
    return n, out


def version_of(n):
    return (n - 17) // 4
