"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { blo } from "blo";
import QRCode from "qrcode";
import { type Address, getAddress } from "viem";
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

const CHAIN_ICON: Record<number, string> = { 8453: "/tokens/base.webp", 1: "/tokens/ethereum.webp" };
const TW_CHAIN: Record<number, string> = { 8453: "base", 1: "ethereum" };
const LOCAL_TOKEN: Record<string, string> = { ETH: "/tokens/eth.png", WETH: "/tokens/eth.png", USDC: "/tokens/usdc.png" };

/**
 * A token's logo with its network as a small badge in the corner (talk-to-your-wallet's look). Sources, in
 * order: our own copy (ETH, USDC), the logo Alchemy returned, Trust Wallet's assets repo by chain + address,
 * then the first letter.
 */
export function TokenIcon({
  symbol,
  asset,
  chainId,
  logo,
  size = 40,
}: {
  symbol: string;
  asset: string;
  chainId: number;
  logo?: string;
  size?: number;
}) {
  const sources = [
    LOCAL_TOKEN[symbol.toUpperCase()],
    logo,
    TW_CHAIN[chainId] && !/^0x0+$/.test(asset)
      ? `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${TW_CHAIN[chainId]}/assets/${getAddress(asset)}/logo.png`
      : undefined,
  ].filter((s): s is string => !!s);
  const [i, setI] = useState(0);
  const badge = Math.round(size * 0.42);
  return (
    <span className="token" style={{ width: size, height: size }}>
      {i < sources.length ? (
        <img src={sources[i]} alt="" width={size} height={size} onError={() => setI(i + 1)} />
      ) : (
        <span className="letter" style={{ fontSize: size * 0.42 }}>
          {symbol.slice(0, 1)}
        </span>
      )}
      {CHAIN_ICON[chainId] && (
        <img className="badge" src={CHAIN_ICON[chainId]} alt={chainById(chainId)?.name} width={badge} height={badge} />
      )}
    </span>
  );
}
