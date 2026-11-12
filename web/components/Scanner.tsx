"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Camera QR scanner. Built to read codes far away, small, blurry or on a screen across the room.
 * - Asks the camera for a sharp stream (1920×1080, continuous focus), back camera, remembered once picked.
 * - Each frame tries a different view: the whole picture, then the middle half at full sharpness (2× zoom),
 *   then the middle third (3× zoom). A small code far away fills a crop; the whole picture catches a close one.
 * - Decoders: the phone's own BarcodeDetector when it has one (fast), and ZXing-C++ (WASM, tries harder,
 *   inverted and downscaled) on every frame without one, and every other frame with one.
 * - The green square is only a guide. Closes on the first read.
 */

const WASM = "/zxing/zxing_reader-3.1.6.wasm"; // copied from zxing-wasm/dist/reader; bump the name with the package
const VIEWS = [1, 0.5, 0.34]; // share of the frame's short side each try looks at
const MAX_SIDE = 1280; // a bigger region is scaled down to this before decoding (speed)

type Decode = (img: ImageData | HTMLCanvasElement, hard?: boolean) => Promise<string | null>;

async function zxingDecoder(): Promise<Decode> {
  const z = await import("zxing-wasm/reader");
  z.prepareZXingModule({ overrides: { locateFile: (p: string) => (p.endsWith(".wasm") ? WASM : p) } });
  return async (img, hard) => {
    if (!(img instanceof ImageData)) return null;
    const r = await z.readBarcodes(img, { formats: ["QRCode"], tryHarder: true, tryInvert: true, tryDownscale: true, tryDenoise: !!hard, maxNumberOfSymbols: 1 });
    return r.find(x => x.isValid && x.text)?.text ?? null;
  };
}

async function nativeDecoder(): Promise<Decode | null> {
  const BD = (globalThis as any).BarcodeDetector;
  if (!BD) return null;
  try {
    const formats: string[] = await BD.getSupportedFormats?.();
    if (formats && !formats.includes("qr_code")) return null;
    const d = new BD({ formats: ["qr_code"] });
    return async img => {
      const r = await d.detect(img);
      return r.find((x: any) => x.rawValue)?.rawValue ?? null;
    };
  } catch {
    return null;
  }
}

/** short: less tall (the top and bottom cropped), for a screen that has more under it. */
export function Scanner({ onResult, short }: { onResult: (text: string) => void; short?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const cb = useRef(onResult);
  cb.current = onResult;

  useEffect(() => {
    let stopped = false;
    let stream: MediaStream | null = null;
    const zx = zxingDecoder().catch(() => null); // load the WASM while the camera starts
    const nat = nativeDecoder();

    const open = async () => {
      const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      let saved: string | null = null;
      try {
        saved = localStorage.getItem("iw3.camera");
      } catch {}
      if (saved) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: saved }, ...size } });
        } catch {}
      }
      return navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, ...size } });
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
        stream = await open();
        if (stopped) return stream.getTracks().forEach(t => t.stop());
        const track = stream.getVideoTracks()[0];
        try {
          const caps: any = track.getCapabilities?.() ?? {};
          if (caps.focusMode?.includes("continuous")) await track.applyConstraints({ advanced: [{ focusMode: "continuous" } as any] });
        } catch {}
        try {
          const id = track.getSettings().deviceId;
          if (id) localStorage.setItem("iw3.camera", id);
        } catch {}
        const v = video.current!;
        v.srcObject = stream;
        await v.play().catch(() => {});
      } catch (e: any) {
        if (!stopped) setError(/permission|denied|notallowed/i.test(String(e?.name || e?.message || e)) ? "Camera blocked. Allow it in your browser settings." : "No camera available");
        return;
      }

      const native = await nat;
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      let tick = 0;

      while (!stopped) {
        const v = video.current;
        if (!v || v.readyState < 2 || !v.videoWidth) {
          await new Promise(r => setTimeout(r, 50));
          continue;
        }
        const W = v.videoWidth, H = v.videoHeight;
        const share = VIEWS[tick % VIEWS.length];
        const sw = share === 1 ? W : Math.round(Math.min(W, H) * share);
        const sh = share === 1 ? H : sw;
        const sx = Math.round((W - sw) / 2), sy = Math.round((H - sh) / 2);
        const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
        canvas.width = Math.round(sw * scale);
        canvas.height = Math.round(sh * scale);
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

        let text: string | null = null;
        try {
          if (native) text = await native(canvas);
          if (!text && (!native || tick % 2 === 1)) {
            const z = await zx;
            if (z) text = await z(ctx.getImageData(0, 0, canvas.width, canvas.height), tick % 4 === 3); // every 4th: denoise too (very blurry)
          }
        } catch {}
        if (stopped) return;
        if (text) {
          stopped = true;
          cb.current(text);
          break;
        }
        tick++;
        await new Promise(r => requestAnimationFrame(() => r(null)));
      }
    })();

    return () => {
      stopped = true;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, []);

  return (
    <div className={short ? "scanner short" : "scanner"}>
      <div>
        <video ref={video} playsInline muted autoPlay />
      </div>
      <div className="frame" />
      <div className="cap">{error ?? "Scan a QR code"}</div>
    </div>
  );
}
