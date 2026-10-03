"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Camera QR scanner (html5-qrcode): back camera, remembered once picked; closes on the first read.
 * From stupid-simple-api-wallet's scanner, trimmed.
 */
export function Scanner({ onResult }: { onResult: (text: string) => void }) {
  const id = useRef(`qr-${Math.random().toString(36).slice(2)}`);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let scanner: any;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5Qrcode(id.current, { verbose: false });
        let camera: string | { facingMode: string } = { facingMode: "environment" };
        try {
          const saved = localStorage.getItem("iw3.camera");
          if (saved) camera = saved;
        } catch {}
        const start = (cam: typeof camera) =>
          scanner.start(cam, { fps: 10, qrbox: (w: number, h: number) => ({ width: Math.min(w, h) * 0.72, height: Math.min(w, h) * 0.72 }) }, (text: string) => {
            if (done.current) return;
            done.current = true;
            cb.current(text);
          }, () => {});
        try {
          await start(camera);
        } catch {
          await start({ facingMode: "environment" });
        }
        try {
          const track = scanner.getRunningTrackSettings?.();
          if (track?.deviceId) localStorage.setItem("iw3.camera", track.deviceId);
        } catch {}
      } catch (e: any) {
        setError(/permission|denied|notallowed/i.test(String(e?.message || e)) ? "Camera blocked. Allow it in your browser settings." : "No camera available");
      }
    })();
    return () => {
      cancelled = true;
      if (!scanner) return;
      // stop() throws synchronously when the camera never started
      try {
        Promise.resolve(scanner.stop()).catch(() => {}).finally(() => scanner.clear?.());
      } catch {
        try {
          scanner.clear?.();
        } catch {}
      }
    };
  }, []);

  return (
    <div className="scanner">
      <div id={id.current} style={{ position: "absolute", inset: 0 }} />
      <div className="frame" />
      <div className="cap">{error ?? "Scan a QR code"}</div>
    </div>
  );
}
