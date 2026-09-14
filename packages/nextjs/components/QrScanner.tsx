"use client";

import { useEffect, useRef, useState } from "react";

/** Camera QR scanner (html5-qrcode). Renders a green viewfinder frame like the pairing mockup. */
export function QrScanner({
  onResult,
  caption = "Point at the QR code",
}: {
  onResult: (text: string) => void;
  caption?: string;
}) {
  const id = useRef(`qr-${Math.random().toString(36).slice(2)}`);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    let scanner: any;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        scanner = new Html5Qrcode(id.current, { verbose: false });
        await scanner.start(
          { facingMode: "environment" },
          { fps: 10, qrbox: (w: number, h: number) => ({ width: Math.min(w, h) * 0.8, height: Math.min(w, h) * 0.8 }) },
          (text: string) => {
            if (done.current) return;
            done.current = true;
            onResult(text);
          },
          () => {},
        );
      } catch (e: any) {
        setError(e?.message || "Camera not available");
      }
    })();
    return () => {
      cancelled = true;
      if (scanner)
        scanner
          .stop()
          .catch(() => {})
          .finally(() => scanner.clear?.());
    };
  }, [onResult]);

  return (
    <div className="relative rounded-[24px] overflow-hidden bg-ink-2 aspect-[4/3]">
      <div id={id.current} className="absolute inset-0 [&>video]:object-cover [&>video]:w-full [&>video]:h-full" />
      <div className="pointer-events-none absolute inset-[9%] rounded-[22px] border-[3px] border-mint" />
      <div className="pointer-events-none absolute bottom-3 inset-x-0 text-center text-white text-sm font-semibold">
        {error ?? caption}
      </div>
    </div>
  );
}
