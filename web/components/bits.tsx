"use client";

/* eslint-disable @next/next/no-img-element */
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { blo } from "blo";
import QRCode from "qrcode";
import { type Address, getAddress, isAddress } from "viem";
import { chainById } from "@/lib/chains";
import { amount as fmtAmount, short, usd as fmtUsd } from "@/lib/format";
import { parse } from "@/lib/parse";
import { bio } from "@/lib/passkey";
import { Scanner } from "./Scanner";

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

// ENS names and avatars, kept in this browser a day (a reload paints them at once); a failed read keeps the last one
type Named = { name: string | null; avatar: string | null; at: number };
const NAMES = "iws.ens";
const asked = new Map<string, Promise<Named | null>>();
function named(a: string, chain?: number): Promise<Named | null> {
  const k = `${chain ?? 1}:${a.toLowerCase()}`;
  let kept: Record<string, Named> = {};
  try {
    kept = JSON.parse(localStorage.getItem(NAMES) || "{}");
  } catch {}
  if (kept[k] && Date.now() - kept[k].at < 86_400_000) return Promise.resolve(kept[k]);
  if (!asked.has(k))
    asked.set(
      k,
      fetch(`/api/ens?address=${a}${chain ? `&chain=${chain}` : ""}`)
        .then(r => (r.ok ? r.json() : Promise.reject()))
        .then(j => {
          const v = { name: j.name ?? null, avatar: j.avatar ?? null, at: Date.now() };
          try {
            const all = { ...JSON.parse(localStorage.getItem(NAMES) || "{}"), [k]: v };
            const keys = Object.keys(all).sort((x, y) => all[y].at - all[x].at);
            for (const x of keys.slice(400)) delete all[x];
            localStorage.setItem(NAMES, JSON.stringify(all));
          } catch {}
          return v;
        })
        .catch(() => {
          asked.delete(k);
          return kept[k] ?? null;
        }),
    );
  return asked.get(k)!;
}

/** An address's ENS name and avatar (that chain's name first, e.g. .base.eth), or nulls while unknown / none. */
export function useName(a?: string | null, chain?: number) {
  const [n, setN] = useState<Named | null>(null);
  useEffect(() => {
    let live = true;
    setN(null);
    if (a && isAddress(a)) named(a, chain).then(v => live && setN(v));
    return () => {
      live = false;
    };
  }, [a, chain]);
  return { name: n?.name ?? null, avatar: n?.avatar ?? null };
}

/**
 * An address, the same everywhere: its ENS avatar (else its blockie), its name over the short address. plain: the
 * blockie only, never an avatar (a wedgie: the picture must match its screen). label: a word over it instead of the
 * name (the name then sits beside the short address).
 */
export function Who({ address, chain, size = 22, plain, label, link, inline }: { address: string; chain?: number; size?: number; plain?: boolean; label?: string; link?: string; inline?: boolean }) {
  const { name, avatar } = useName(plain ? null : address, chain);
  const [bad, setBad] = useState(false);
  const pic = avatar && !bad ? (
    <img className="blockie" src={avatar} width={size} height={size} alt="" style={{ objectFit: "cover" }} onError={() => setBad(true)} />
  ) : (
    <Blockie address={address} size={size} />
  );
  const top = label ?? name;
  const under = label && name ? `${name} · ${short(address)}` : short(address);
  const sub = link ? (
    <a className="mono fine" style={{ fontSize: 12 }} href={link} target="_blank" rel="noopener noreferrer">
      {under}
    </a>
  ) : (
    <span className="mono fine" style={{ fontSize: 12 }}>
      {under}
    </span>
  );
  return (
    <span className="row" style={inline ? { display: "inline-flex", gap: 6, minWidth: 0, verticalAlign: "middle" } : { gap: 8, minWidth: 0 }}>
      {pic}
      {top ? (
        <span className="stack" style={{ gap: 0, minWidth: 0 }}>
          <span style={{ fontSize: 15, fontWeight: 600 }}>{top}</span>
          {sub}
        </span>
      ) : (
        sub
      )}
    </span>
  );
}

export function ChainChip({ chainId }: { chainId: number }) {
  const c = chainById(chainId);
  return (
    <span className="chip" style={{ background: c?.color ?? "#787b78" }}>
      <ChainIcon chainId={chainId} size={14} />
      {c?.name ?? chainId}
    </span>
  );
}

/** QR code (error correction H) with the recipient's blockie in the middle, like punk wallet; `children` sit under it, in the same card. */
export function Qr({ value, center, top, children }: { value: string; center?: string; top?: React.ReactNode; children?: React.ReactNode }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    QRCode.toDataURL(value, { errorCorrectionLevel: "H", margin: 1, width: 600, color: { dark: "#1a1b1a", light: "#ffffff" } })
      .then(setSrc)
      .catch(() => setSrc(undefined));
  }, [value]);
  return (
    <div className="qr">
      {top}
      <div style={{ position: "relative", width: "100%", maxWidth: 300 }}>
        {src && <img className="code" src={src} alt="QR code" />}
        {center && (
          <div className="mid">
            <span style={{ background: "#fff", padding: 6, borderRadius: "50%" }}>
              <Blockie address={center} size={58} />
            </span>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

let sheetsOpen = 0;
/** A sheet is up (the iOS app's pull-down skips its reload then). */
export const sheetOpen = () => sheetsOpen > 0;

const SheetBack = createContext<React.MutableRefObject<(() => void) | null> | null>(null);

/** While `back` is set, dismissing the sheet (swipe down, Escape, tap outside) runs it instead: one step back, not all the way out. */
export function useSheetBack(back: (() => void) | null) {
  const ref = useContext(SheetBack);
  useEffect(() => {
    if (!ref) return;
    ref.current = back;
    return () => {
      if (ref.current === back) ref.current = null;
    };
  }, [ref, back]);
}

/**
 * A bottom sheet. Closes on Escape, a click outside (only if the press started outside too, so a text-select
 * drag that ends past the edge doesn't close it), or a pull down (touch: grab anywhere while it's scrolled to
 * the top, like an iOS sheet; mouse: drag the grab bar). A screen inside can make those go one step back
 * (useSheetBack).
 */
export function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y0: number; t0: number; dy: number; on: boolean } | null>(null);
  const back = useRef<(() => void) | null>(null);
  const downOnBg = useRef(false);
  const dismissRef = useRef(onClose);
  dismissRef.current = () => (back.current ? back.current() : onClose());
  const dismiss = () => dismissRef.current();
  useEffect(() => {
    // the page behind can't scroll while a sheet is up: on iOS a swipe past the sheet's end would latch onto
    // the hidden page, and the sheet stops scrolling back up
    const h = document.documentElement;
    if (sheetsOpen++ === 0) h.style.overflow = "hidden";
    return () => {
      if (--sheetsOpen === 0) h.style.overflow = "";
    };
  }, []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && dismissRef.current();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const pull = (y: number, e?: Event) => {
    const d = drag.current;
    const el = ref.current;
    if (!d || !el) return;
    const dy = y - d.y0;
    if (!d.on && dy < 6) return; // a scroll up, or a tap
    d.on = true;
    d.dy = Math.max(0, dy);
    e?.preventDefault(); // the sheet moves, not the page
    el.style.transition = "none";
    el.style.transform = `translateY(${d.dy}px)`;
  };
  const release = () => {
    const d = drag.current;
    const el = ref.current;
    drag.current = null;
    if (!d?.on || !el) return;
    const fast = d.dy / Math.max(1, Date.now() - d.t0) > 0.6; // a flick
    el.style.transition = "transform .2s ease-out";
    if (d.dy > el.offsetHeight * 0.25 || (fast && d.dy > 40)) {
      if (back.current) {
        // one step back: the sheet springs up again on the screen before
        el.style.transform = "translateY(0)";
        dismissRef.current();
      } else {
        el.style.transform = "translateY(100%)";
        setTimeout(() => dismissRef.current(), 180);
      }
    } else el.style.transform = "translateY(0)";
  };
  const pullRef = useRef(pull);
  pullRef.current = pull;
  const releaseRef = useRef(release);
  releaseRef.current = release;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = (e: TouchEvent) => {
      // only when the sheet is at its top, so scrolling its content still works
      drag.current = el.scrollTop <= 0 ? { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, on: false } : null;
    };
    const move = (e: TouchEvent) => {
      // the iOS app's page bounces (its pull-down reload): a swipe the sheet doesn't scroll itself must never
      // start that bounce, or the page and the dimmed backdrop slide down with the sheet
      const d = drag.current;
      if (e.cancelable && ((d && e.touches[0].clientY > d.y0) || el.scrollHeight <= el.clientHeight)) e.preventDefault();
      pullRef.current(e.touches[0].clientY, e);
    };
    const end = () => releaseRef.current();
    const bg = bgRef.current;
    const still = (e: TouchEvent) => e.target === bg && e.cancelable && e.preventDefault(); // the backdrop never scrolls
    bg?.addEventListener("touchmove", still, { passive: false });
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      bg?.removeEventListener("touchmove", still);
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, []);
  // mouse/pen drag on the grab bar (touch is handled above, anywhere on the sheet)
  const grabDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    e.preventDefault(); // no text selection while pulling
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y0: e.clientY, t0: Date.now(), dy: 0, on: false };
  };
  const grabMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") pull(e.clientY);
  };
  const grabUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") release();
  };
  return (
    <SheetBack.Provider value={back}>
      <div
        className="sheet-bg"
        ref={bgRef}
        onPointerDown={e => (downOnBg.current = e.target === e.currentTarget)}
        onClick={e => {
          if (e.target === e.currentTarget && downOnBg.current) dismiss();
          downOnBg.current = false;
        }}
      >
        <div className="sheet" ref={ref}>
          <div className="grab" onPointerDown={grabDown} onPointerMove={grabMove} onPointerUp={grabUp} onPointerCancel={grabUp} />
          {children}
        </div>
      </div>
    </SheetBack.Provider>
  );
}

/** What a tx was for, in clear signing's words ("Swap 2 USDC for … on Uniswap"): bold, dark, above its coins. Activity and
 * signing both lead with it. */
export function WhatFor({ children }: { children: React.ReactNode }) {
  return <span style={{ fontSize: 17, fontWeight: 700 }}>{children}</span>;
}

/**
 * Money moving, the same everywhere: out is red with −, in is green with +, dollars after it in grey. `least`: a
 * minimum (a swap's "at least"), shown as "or more". Every screen that shows what a transaction pays or gets uses this.
 */
export function Money({ amount: a, symbol, usd: u, get, least, size = 20 }: { amount: string; symbol: string; usd?: number | null; get?: boolean; least?: boolean; size?: number }) {
  return (
    <span style={{ fontSize: size, fontWeight: 700, color: get ? "var(--mint-d)" : "var(--coral)" }}>
      {get ? "+" : "−"}
      {fmtAmount(a)} {symbol}
      {least ? " or more" : ""}
      {u !== undefined && u !== null && <span className="fine" style={{ fontWeight: 400 }}> ({fmtUsd(u)})</span>}
    </span>
  );
}

/**
 * The one way out to another page: a small pill that always opens a NEW window (the wallet stays where it was).
 * Use it everywhere something "ejects" — a tx's own page, Safe{Wallet}, an explorer — so it looks and acts the same.
 * No children: the eject icon. With children: that text and ↗.
 */
export function Eject({ href, title, children }: { href: string; title: string; children?: React.ReactNode }) {
  return (
    <a className="pill" href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} style={{ height: 32, padding: "0 10px", fontSize: 13, flex: "none" }}>
      {children ? (
        <>{children} ↗</>
      ) : (
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      )}
    </a>
  );
}

/**
 * Copy a link: dark gray (the other likely thing to do), never a pop-out. Alone it's a small icon button (a tx's link
 * for the other signers); with `label` a pill with the words. `message`: what the toast says once copied.
 */
export function CopyLink({ link, message = "Link copied. Share it with the other signers.", label }: { link: string; message?: string; label?: React.ReactNode }) {
  const [toast, setToast] = useToast();
  const go = async () => setToast((await copy(link)) ? message : "Couldn't copy");
  return (
    <>
      {label ? (
        <button className="pill dark" onClick={go}>
          <CopyIcon size={16} /> {label}
        </button>
      ) : (
        <button className="btn btn-dark" title="Copy a link to it" aria-label="Copy a link to it" style={{ width: 32, height: 32, padding: 0, flex: "none" }} onClick={go}>
          <CopyIcon size={16} />
        </button>
      )}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/** Copy an address: one pill, one message ("Address copied"). `label`: what the pill says after the icon (none = icon only). */
export function CopyAddress({ address, label = "Copy address", style }: { address: string; label?: React.ReactNode; style?: React.CSSProperties }) {
  const [toast, setToast] = useToast();
  return (
    <>
      <button className="pill" style={style} aria-label="Copy the address" onClick={async () => setToast((await copy(address)) ? "Address copied" : "Couldn't copy")}>
        <CopyIcon size={16} />
        {label}
      </button>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

/** Share a link: the phone's share sheet where there is one, else copy it. Returns what to toast (null: shared). */
export async function shareOrCopy(url: string, title: string): Promise<string | null> {
  if (navigator.share) return navigator.share({ url, title }).then(() => null, () => null);
  return (await copy(url)) ? "Link copied" : "Couldn't copy";
}

/** Remove / delete / end: the small red ✕ (EXPECTATIONS #2): far left when a green button follows it, else on the right. */
export function RemoveX({ onClick, disabled, label = "Remove", busy }: { onClick: () => void; disabled?: boolean; label?: string; busy?: boolean }) {
  return (
    <button className="pill stop" style={{ width: 38, padding: 0, justifyContent: "center", flex: "none" }} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {busy ? "…" : "✕"}
    </button>
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

export function TrashIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" />
    </svg>
  );
}

export function ReceiveIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12M7 10l5 5 5-5M4 20h16" />
    </svg>
  );
}

export function SwitchIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4" />
    </svg>
  );
}

export function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

export function SwapIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 4v14M3 14l4 4 4-4M17 20V6M13 10l4-4 4 4" />
    </svg>
  );
}

export function AppsIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6" />
    </svg>
  );
}

export function CopyIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2.5" />
      <path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
    </svg>
  );
}

/** This device's passkey check, drawn: a face scan for Face ID, else a fingerprint (Touch ID, Windows Hello, …). */
export function BioIcon({ size = 22 }: { size?: number }) {
  if (bio() === "Face ID")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16" />
        <path d="M8.5 9v1.5M15.5 9v1.5M12 9v4h-1M9 16c1.8 1.4 4.2 1.4 6 0" />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4M14 13.12c0 2.38 0 6.38-1 8.88M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6M2 16h.01M21.8 16c.2-2 .131-5.354 0-6M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  );
}

/** This device's passkey as a signer: its icon and name (Touch ID on a Mac), never the address (that's at the
 * bottom of Settings). */
export function BioSigner() {
  return (
    <span className="row" style={{ gap: 8, minWidth: 0 }}>
      <BioIcon />
      <span style={{ fontSize: 15, fontWeight: 600 }}>{bio()}</span>
    </span>
  );
}

export function PencilIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M13.5 6.5l4 4" />
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

/** A network's logo, round. */
export function ChainIcon({ chainId, size = 20 }: { chainId: number; size?: number }) {
  const src = chainById(chainId)?.icon;
  return src ? <img src={src} alt="" width={size} height={size} style={{ borderRadius: "50%", display: "block", flexShrink: 0 }} /> : null;
}
const TW_CHAIN: Record<number, string> = { 8453: "base", 1: "ethereum", 42161: "arbitrum", 10: "optimism", 137: "polygon", 43114: "avalanchec", 56: "smartchain", 100: "xdai", 42220: "celo", 146: "sonic" };
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
      {chainById(chainId)?.icon && <img className="badge" src={chainById(chainId)!.icon} alt={chainById(chainId)?.name} width={badge} height={badge} />}
    </span>
  );
}

/**
 * The scan button for an address field: `pill` goes inside the `.input`, `camera` right under it.
 * A read QR (0x…, name.eth, a payment link) hands its recipient to `onAddress`.
 */
export function useAddressScan(onAddress: (to: string) => void) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pill = (
    <button type="button" className="pill" onClick={() => (setError(null), setOpen(!open))} aria-label="Scan">
      <ScanIcon size={20} />
    </button>
  );
  const camera = (
    <>
      {open && (
        <Scanner
          onResult={text => {
            setOpen(false);
            const r = parse(text);
            if (r.kind !== "pay") return setError("That QR isn't an address.");
            onAddress(r.to);
          }}
        />
      )}
      {error && <span className="err">{error}</span>}
    </>
  );
  return { pill, camera };
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
  const scan = useAddressScan(to => {
    touched.current = true;
    setText(to);
  });
  const idle = !focus && !!addr;
  return (
    <>
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
        {scan.pill}
      </div>
      {scan.camera}
    </>
  );
}

/** The wedgie's green button, drawn inline in text. Never name the buttons A/B/X/Y: people see green and red. */
export function GreenButton() {
  return <span className="green-key" role="img" aria-label="the green button" />;
}

export function GearIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function ConnectIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  );
}

export function DepositIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Fills toward the end over about `ms`, then creeps; the step replaces it when the change shows up. */
export function TimedBar({ ms }: { ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setGo(true));
    return () => cancelAnimationFrame(t);
  }, []);
  return (
    <div className="progress">
      <div style={{ width: go ? "95%" : "2%", transitionDuration: `${ms}ms` }} />
    </div>
  );
}
