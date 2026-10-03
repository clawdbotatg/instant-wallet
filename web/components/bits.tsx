"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { blo } from "blo";
import QRCode from "qrcode";
import type { Address } from "viem";
import { chainById } from "@/lib/chains";

export function Band() {
  return (
    <div className="band" aria-hidden>
      <i />
      <i />
      <i />
    </div>
  );
}

export function Blockie({ address, size = 32 }: { address: string; size?: number }) {
  return <img className="blockie" src={blo(address as Address)} width={size} height={size} alt="" />;
}

export function ChainChip({ chainId }: { chainId: number }) {
  const c = chainById(chainId);
  return (
    <span className="chip" style={{ background: c?.color ?? "#787b78" }}>
      {c?.name ?? chainId}
    </span>
  );
}

/** QR code (error correction H) with the recipient's blockie in the middle, like punk wallet. */
export function Qr({ value, center }: { value: string; center?: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    QRCode.toDataURL(value, { errorCorrectionLevel: "H", margin: 1, width: 600, color: { dark: "#1a1b1a", light: "#ffffff" } })
      .then(setSrc)
      .catch(() => setSrc(undefined));
  }, [value]);
  return (
    <div className="qr">
      {src && <img className="code" src={src} alt="QR code" />}
      {center && (
        <div className="mid">
          <span style={{ background: "#fff", padding: 6, borderRadius: "50%" }}>
            <Blockie address={center} size={58} />
          </span>
        </div>
      )}
    </div>
  );
}

export function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()}>
        <div className="grab" />
        {children}
      </div>
    </div>
  );
}

export function ScanIcon({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M7 12h10" />
    </svg>
  );
}

export function useToast(): [string | null, (m: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 1800);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg];
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
