#!/usr/bin/env python3
# qr.py parity: byte-identical to the `qrcode` library at every mask for versions 1-10 (EC L),
# and the auto-masked symbol decodes with OpenCV. Needs `pip install qrcode opencv-python-headless numpy`.
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import qr  # noqa: E402

try:
    import qrcode, numpy as np, cv2
except ImportError as e:
    print("skipped: %s (pip install qrcode opencv-python-headless numpy)" % e)
    sys.exit(0)

TEXTS = ["hi", "0x7a3F9C0e4b12D8A6F5e3c1B0d9a8e7F6C5B4a391", "q" * 120,
         "iw1:" + "ab" * 32 + ":" + "cd" * 32 + ":instant-emu", "x" * 150, "y" * 190, "z" * 230, "w" * 271]
det = cv2.QRCodeDetector()
ok = True
for t in TEXTS:
    t0 = time.time()
    n, rows = qr.encode(t)
    ms = (time.time() - t0) * 1000
    v = qr.version_of(n)
    for mask in range(8):
        _, mine = qr.encode(t, version=v, mask=mask)
        q = qrcode.QRCode(version=v, error_correction=qrcode.constants.ERROR_CORRECT_L, mask_pattern=mask, border=0)
        q.add_data(qrcode.util.QRData(t.encode(), mode=qrcode.util.MODE_8BIT_BYTE))
        q.make(fit=False)
        ref = q.get_matrix()
        if not all(bool(mine[r][c]) == bool(ref[r][c]) for r in range(n) for c in range(n)):
            ok = False
            print("FAIL  len %d v%d mask %d differs from the qrcode library" % (len(t), v, mask))
    scale, pad = 8, 4
    img = np.full(((n + 2 * pad) * scale, (n + 2 * pad) * scale), 255, np.uint8)
    for r in range(n):
        for c in range(n):
            if rows[r][c]:
                img[(r + pad) * scale:(r + pad + 1) * scale, (c + pad) * scale:(c + pad + 1) * scale] = 0
    data, _, _ = det.detectAndDecode(img)
    good = data == t
    ok = ok and good
    print("%s  len %3d -> v%-2d %dx%d  all 8 masks match the library, opencv decodes: %s  (%.0f ms)" % ("PASS" if good else "FAIL", len(t), v, n, n, good, ms))
print("ALL OK" if ok else "FAILURES")
sys.exit(0 if ok else 1)
