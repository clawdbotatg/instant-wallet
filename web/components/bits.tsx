"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { blo } from "blo";
import QRCode from "qrcode";
import { type Address, getAddress, isAddress } from "viem";
import { chainById } from "@/lib/chains";
import { short } from "@/lib/format";

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

/**
 * A bottom sheet. Closes on Escape, a tap outside, or a swipe down (grab anywhere while it's scrolled to the
 * top and pull it down, like an iOS sheet).
 */
export function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; t0: number; dy: number; on: boolean } | null>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = (e: TouchEvent) => {
      // only when the sheet is at its top, so scrolling its content still works
      drag.current = el.scrollTop <= 0 ? { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, on: false } : null;
    };
    const move = (e: TouchEvent) => {
      const d = drag.current;
      if (!d) return;
      const dy = e.touches[0].clientY - d.y0;
      if (!d.on && dy < 6) return; // a scroll up, or a tap
      d.on = true;
      d.dy = Math.max(0, dy);
      e.preventDefault(); // the sheet moves, not the page
      el.style.transition = "none";
      el.style.transform = `translateY(${d.dy}px)`;
    };
    const end = () => {
      const d = drag.current;
      drag.current = null;
      if (!d?.on) return;
      const fast = d.dy / Math.max(1, Date.now() - d.t0) > 0.6; // a flick
      el.style.transition = "transform .2s ease-out";
      if (d.dy > el.offsetHeight * 0.25 || (fast && d.dy > 40)) {
        el.style.transform = "translateY(100%)";
        setTimeout(onClose, 180);
      } else el.style.transform = "translateY(0)";
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [onClose]);
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" ref={ref} onClick={e => e.stopPropagation()}>
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

export function SendIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 3 10 14M21 3l-7 18-4-7-7-4 18-7z" />
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
/** A network's logo, round. */
export function ChainIcon({ chainId, size = 20 }: { chainId: number; size?: number }) {
  return CHAIN_ICON[chainId] ? <img src={CHAIN_ICON[chainId]} alt="" width={size} height={size} style={{ borderRadius: "50%", display: "block" }} /> : null;
}
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

/**
 * An address field: the blockie + its ENS name (or 0x12ab…cdef) while idle, the full text while editing.
 * Takes 0x… or name.eth; `onChange` gets the address it resolves to, or null.
 */
export function AddressInput({ initial, onChange, placeholder = "0x… or name.eth" }: { initial?: Address; onChange: (a: Address | null) => void; placeholder?: string }) {
  const [text, setText] = useState<string>(initial ?? "");
  const [addr, setAddr] = useState<Address | null>(initial ?? null);
  const [name, setName] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  const [looking, setLooking] = useState(false);
  // a guardian read from chain arrives after the first paint: take it while the field is untouched
  const touched = useRef(false);
  useEffect(() => {
    if (initial && !touched.current) setText(initial);
  }, [initial]);
  useEffect(() => {
    const v = text.trim();
    let live = true; // a late answer for older text must never land on newer text
    setName(null);
    if (isAddress(v)) {
      const a = getAddress(v);
      setAddr(a);
      onChange(a);
      fetch(`/api/ens?address=${a}`)
        .then(r => r.json())
        .then(j => live && j?.name && setName(j.name))
        .catch(() => {});
      return () => {
        live = false;
      };
    }
    setAddr(null);
    onChange(null);
    if (!/\.[a-z]{2,}$/i.test(v)) return;
    setLooking(true);
    const t = setTimeout(async () => {
      const j = await fetch(`/api/ens?name=${encodeURIComponent(v.toLowerCase())}`).then(r => r.json()).catch(() => null);
      if (!live) return;
      setLooking(false);
      if (j?.address) {
        const a = getAddress(j.address);
        setAddr(a);
        setName(v.toLowerCase());
        onChange(a);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
      setLooking(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const idle = !focus && !!addr;
  return (
    <div className="input">
      {addr && <Blockie address={addr} size={30} />}
      <input
        className={idle && !name ? "mono" : undefined}
        value={idle ? (name ?? short(addr)) : text}
        onChange={e => {
          touched.current = true;
          setText(e.target.value);
        }}
        onFocus={e => {
          setFocus(true);
          // the full address replaces the short one on focus: select it all, so a paste replaces it
          const el = e.currentTarget;
          requestAnimationFrame(() => el.select());
        }}
        onBlur={() => setFocus(false)}
        placeholder={looking ? "Looking it up…" : placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
    </div>
  );
}
