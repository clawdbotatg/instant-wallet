"use client";

/* eslint-disable @next/next/no-img-element */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { blo } from "blo";
import QRCode from "qrcode";
import { type Address, getAddress, isAddress } from "viem";
import { chainById } from "@/lib/chains";
import { amount as fmtAmount, short, usd as fmtUsd, addressIn, nameIn } from "@/lib/format";
import { movedFrom, nameTyped } from "@/lib/names";
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
/** One read per address for the whole page: every caller shares it. */
export function named(a: string, chain?: number, fresh = false): Promise<Named | null> {
  const k = `${chain ?? 1}:${a.toLowerCase()}`;
  let kept: Record<string, Named> = {};
  try {
    kept = JSON.parse(localStorage.getItem(NAMES) || "{}");
  } catch {}
  if (!fresh && kept[k] && Date.now() - kept[k].at < 86_400_000) return Promise.resolve(kept[k]);
  if (fresh) asked.delete(k);
  if (!asked.has(k))
    asked.set(
      k,
      // fresh: a new URL, so the CDN's copy is skipped too
      fetch(`/api/ens?address=${a}${chain ? `&chain=${chain}` : ""}${fresh ? `&fresh=${Date.now()}` : ""}`)
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
    // a tx from this wallet landed (it may have set its ENS name): read it again now and once more in 20 s
    const timers: ReturnType<typeof setTimeout>[] = [];
    const landed = (e: Event) => {
      if (!a || (e as CustomEvent).detail?.toLowerCase?.() !== a.toLowerCase()) return;
      for (const ms of [2000, 20000]) timers.push(setTimeout(() => named(a, chain, true).then(v => live && v && setN(v)), ms));
    };
    window.addEventListener("iws:landed", landed);
    return () => {
      live = false;
      window.removeEventListener("iws:landed", landed);
      timers.forEach(clearTimeout);
    };
  }, [a, chain]);
  // the picture always comes through us, never from its own host (which would see who you look at): an answer
  // kept from before /api/avatar still names the host
  const pic = n?.avatar && n.name && !n.avatar.startsWith("/") ? `/api/avatar?name=${encodeURIComponent(n.name)}` : n?.avatar;
  return { name: n?.name ?? null, avatar: pic ?? null };
}

/**
 * An address, the same everywhere: its ENS avatar (else its blockie), its name over the short address. plain: the
 * blockie only, never an avatar (a wedgie: the picture must match its screen). label: a word over it instead of the
 * name (the name then sits beside the short address). flat: one line at the size of the words around it (a headline,
 * a button, under a QR code): the picture, then the name, else the short address. signer: someone else's passkey is
 * shown as its Instant Wallet (`passkeyHome`); the signer contract that really signs is the small blockie on its corner.
 */
export function Who({ address, chain, size = 22, plain, label, link, inline, flat, signer }: { address: string; chain?: number; size?: number; plain?: boolean; label?: string; link?: string; inline?: boolean; flat?: boolean; signer?: string }) {
  const { name, avatar } = useName(plain ? null : address, chain);
  const [bad, setBad] = useState(false);
  const face = avatar && !bad ? (
    <img className="blockie" src={avatar} width={size} height={size} alt="" style={{ objectFit: "cover" }} onError={() => setBad(true)} />
  ) : (
    <Blockie address={address} size={size} />
  );
  const pic = signer ? (
    <span style={{ position: "relative", display: "inline-flex", flex: "none" }} title={`Signs as ${signer}`}>
      {face}
      <span style={{ position: "absolute", right: -5, bottom: -5 }}>
        <Blockie address={signer} size={Math.max(12, Math.round(size * 0.5))} />
      </span>
    </span>
  ) : (
    face
  );
  const top = label ?? name;
  if (flat)
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35em", minWidth: 0, maxWidth: "100%", verticalAlign: "middle", whiteSpace: "nowrap" }}>
        {pic}
        <span className={top ? undefined : "mono"} style={{ overflow: "hidden", textOverflow: "ellipsis", wordBreak: "normal" }}>{top ?? short(address)}</span>
      </span>
    );
  const under = label && name && name !== label ? `${name} · ${short(address)}` : short(address);
  const sub = link ? (
    <a className="mono fine" style={{ fontSize: 12 }} href={link} target="_blank" rel="noopener noreferrer">
      {under} ↗
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
          <span style={{ fontSize: 15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{top}</span>
          {sub}
        </span>
      ) : (
        sub
      )}
    </span>
  );
}

/**
 * A name that points somewhere new since this browser last paid it (lib/names.ts): said in red, with where it was.
 * A name's owner can repoint it, and so could whoever breaks into the server that answers for it.
 */
export function NameMoved({ name, address }: { name: string; address: string }) {
  const [was, setWas] = useState<Address | null>(null);
  useEffect(() => setWas(isAddress(address) ? movedFrom(name, address) : null), [name, address]);
  if (!was) return null;
  return (
    <span className="err">
      Last time {name.toLowerCase()} was <Who flat address={was} />
    </span>
  );
}

/** Words about a transaction: every full address in them drawn as <Who> (blockie, name), never as bare hex. */
export function Words({ text, chain }: { text: string; chain?: number }) {
  const parts = text.split(/(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/);
  return <>{parts.map((p, i) => (i % 2 ? <Who key={i} address={p} chain={chain} size={18} inline /> : p))}</>;
}

/**
 * A network, wherever one is named: its logo, then its name (Austin 11-12: Activity had the logo, a waiting tx
 * didn't). Sits in a sentence like a word. The one place without it: an asset row, whose token icon has the badge.
 */
export function Net({ chainId }: { chainId: number }) {
  const c = chainById(chainId);
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      {c?.icon && <img src={c.icon} alt="" style={{ width: "1.05em", height: "1.05em", borderRadius: "50%", verticalAlign: "-0.17em", marginRight: "0.3em" }} />}
      {c?.name ?? `network ${chainId}`}
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
    let inner = false; // the touch began in a list that scrolls by itself (a select's options): it's that list's swipe
    const start = (e: TouchEvent) => {
      inner = false;
      for (let n = e.target as HTMLElement | null; n && n !== el; n = n.parentElement)
        if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) inner = true;
      // only when the sheet is at its top, so scrolling its content still works
      drag.current = !inner && el.scrollTop <= 0 ? { y0: e.touches[0].clientY, t0: Date.now(), dy: 0, on: false } : null;
    };
    const move = (e: TouchEvent) => {
      if (inner) return;
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
 * The amount box, the same everywhere a coin amount is typed (Send, Swap, Share, Request, Limits): you type dollars,
 * and the pill on its right switches to the coin and back. `value` is always the coin amount. A coin with no price
 * takes the coin only. Under it: the other unit on the left, `right` (what you have, what's left) on the right.
 * Give it a `key` per coin, so a new coin starts empty and in dollars. `startCoin`: open on the coin (a payment
 * request names a coin amount).
 */
export function AmountBox({
  value,
  onChange,
  symbol,
  decimals,
  price,
  onMax,
  maxing,
  disabled,
  right,
  startCoin,
  autoFocus,
}: {
  value: string;
  onChange: (coinAmount: string) => void;
  symbol: string;
  decimals: number;
  price?: number | null;
  onMax?: () => void;
  maxing?: boolean;
  disabled?: boolean;
  right?: React.ReactNode;
  startCoin?: boolean;
  autoFocus?: boolean;
}) {
  const [inUsd, setInUsd] = useState(!startCoin);
  const [usdIn, setUsdIn] = useState("");
  const dollars = inUsd && !!price; // no price: only the coin amount makes sense
  const toUsd = (t: string) => (t && price && isFinite(Number(t)) ? (Math.floor(Number(t) * price * 100 + 1e-6) / 100).toFixed(2) : "");
  const toCoin = (u: string) => (u && price && isFinite(Number(u)) ? (Number(u) / price).toFixed(Math.min(decimals, 8)).replace(/\.?0+$/, "") : "");
  // an amount this box didn't type (Max, a filled-in request, a limit as it stands): its dollars follow it
  const own = useRef<string | null>(null);
  useEffect(() => {
    if (value === own.current) return;
    own.current = value;
    setUsdIn(toUsd(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, !!price]);
  const set = (coin: string) => ((own.current = coin), onChange(coin));
  return (
    <>
      <div className="input">
        {dollars && <span className="amount-cur">$</span>}
        <input
          className="amount"
          inputMode="decimal"
          autoFocus={autoFocus}
          value={dollars ? usdIn : value}
          disabled={disabled}
          onChange={e => {
            const v = e.target.value.replace(",", ".").replace(/[^0-9.]/g, "");
            if (dollars) (setUsdIn(v), set(toCoin(v)));
            else set(v);
          }}
          placeholder="0"
        />
        {onMax && (
          <button className="pill" onClick={onMax} disabled={disabled || maxing}>
            {maxing ? "…" : "Max"}
          </button>
        )}
        {price ? (
          <button className="pill" disabled={disabled} onClick={() => (dollars || setUsdIn(toUsd(value)), setInUsd(!dollars))} aria-label={dollars ? `Type ${symbol} instead` : "Type dollars instead"}>
            {dollars ? "USD" : symbol} ⇅
          </button>
        ) : (
          <span className="unit">{symbol}</span>
        )}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="fine">{!value || !price || !(Number(value) > 0) ? "" : dollars ? `= ${fmtAmount(value)} ${symbol}` : `≈ ${fmtUsd(Number(value) * price)}`}</span>
        <span className="fine" style={{ whiteSpace: "nowrap" }}>
          {right}
        </span>
      </div>
    </>
  );
}

/**
 * Money moving, the same everywhere: out is red with −, in is green with +, dollars after it in grey. `least`: a
 * minimum (a swap's "at least"), shown as "or more". Every screen that shows what a transaction pays or gets uses this.
 */
export function Money({ amount: a, symbol, usd: u, get, least, unknown, size = 20 }: { amount: string; symbol: string; usd?: number | null; get?: boolean; least?: boolean; unknown?: boolean; size?: number }) {
  // unknown: no number we can read (a router's "all of it" flag): the coin, and that we don't know how much
  if (unknown)
    return (
      <span style={{ fontSize: size, fontWeight: 700, color: get ? "var(--mint-d)" : "var(--coral)" }}>
        {get ? "+" : "−"} {symbol} <span className="fine" style={{ fontWeight: 400 }}>(amount not known)</span>
      </span>
    );
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
export function Eject({ href, title = "See it on the explorer", children }: { href: string; title?: string; children?: React.ReactNode }) {
  // never stretched: as wide as its words, on the right. A block explorer is the bare icon, never the word (11-12)
  return (
    <a className="pill" href={href} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} style={{ flex: "none", justifySelf: "end", ...(children ? {} : { width: 38, padding: 0, justifyContent: "center" }) }}>
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

/** The end of a finished screen: Done (white, the only button) and, when there's a tx to see, the small ⏏ in the sheet's top right. */
export function DoneBar({ onDone, href }: { onDone: () => void; href?: string | false | null }) {
  return (
    <>
      {href && (
        <div style={{ position: "absolute", top: 20, right: 20 }}>
          <Eject href={href} />
        </div>
      )}
      <button className="btn wide" onClick={onDone}>
        Done
      </button>
    </>
  );
}

/** A tx that ran, said in a card or a row: ✓ Executed, and the explorer icon on the right. The same line everywhere. */
export function ExecutedLine({ href }: { href?: string | false | null }) {
  return (
    <p className="row" style={{ gap: 8, justifyContent: "space-between" }}>
      <b>✓ Executed</b> {href && <Eject href={href} />}
    </p>
  );
}

/**
 * Copy a link: dark gray (the other likely thing to do), never a pop-out. Alone it's a small icon button (a tx's link
 * for the other signers); with `label` a pill with the words. `message`: what the toast says once copied.
 * `green`: copying is the one thing left to do (the first page inside a wallet app's browser, where passkeys can't work).
 */
export function CopyLink({ link, message = "Link copied. Send it to the other signers.", label, green }: { link: string; message?: string; label?: React.ReactNode; green?: boolean }) {
  const [toast, setToast] = useToast();
  const go = async () => setToast((await copy(link)) ? message : "Couldn't copy");
  return (
    <>
      {label ? (
        <button className={green ? "pill go" : "pill dark"} onClick={go}>
          <CopyIcon size={16} /> {label}
        </button>
      ) : (
        <button className="pill dark" title="Copy a link to it" aria-label="Copy a link to it" style={{ width: 38, padding: 0, justifyContent: "center", flex: "none" }} onClick={go}>
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

/** The home screen's green button: send, and it opens on the scanner. A filled paper plane with the scan mark inside, dead center of the button. */
export function SendScanIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: "visible" }}>
      <path d="M44 6.5 3 21.5l13 8 6 17z" fill="currentColor" stroke="currentColor" strokeWidth="4" />
      <g fill="none" stroke="var(--mint-d)" strokeWidth="2.7" transform="translate(18.75 18.75) scale(.75)">
        <path d="M0 4V1.5A1.5 1.5 0 0 1 1.5 0H4M10 0h2.5A1.5 1.5 0 0 1 14 1.5V4M14 10v2.5a1.5 1.5 0 0 1-1.5 1.5H10M4 14H1.5A1.5 1.5 0 0 1 0 12.5V10" />
        <path d="M3.5 7h7" />
      </g>
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
 * The scanner for an address box: its own sheet over the page, the same look as Send's scan screen (title, the short
 * camera, Paste address), with no WalletConnect. It closes itself on a scan or a paste. Inside another sheet, a
 * swipe down or Escape closes only the scanner.
 */
function ScanSheet({ onText, onClose }: { onText: (text: string) => void; onClose: () => void }) {
  useSheetBack(onClose);
  return createPortal(
    <Sheet onClose={onClose}>
      <div className="stack">
        <h2>Scan</h2>
        <Scanner short onResult={onText} />
        <button className="btn wide" onClick={async () => onText(((await navigator.clipboard?.readText().catch(() => "")) ?? "").trim())}>
          Paste address
        </button>
      </div>
    </Sheet>,
    document.body,
  );
}

/**
 * The scan button for an address field: `pill` goes inside the `.input`, `camera` right under it (the scanner's sheet,
 * and what went wrong). A read QR (0x…, name.eth, a payment link) hands its recipient to `onAddress`.
 */
export function useAddressScan(onAddress: (to: string) => void) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const pill = (
    <button type="button" className="pill" onClick={() => (setError(null), setOpen(true))} aria-label="Scan">
      <ScanIcon size={20} />
    </button>
  );
  const camera = (
    <>
      {open && (
        <ScanSheet
          onClose={close}
          onText={text => {
            setOpen(false);
            if (!text) return;
            const r = parse(text);
            if (r.kind !== "pay") return setError("That isn't an address.");
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
 * THE address box. Every place an address is typed uses this one, so they all work the same (Austin 11-12).
 * Takes 0x…, a name (nick.eth), or a word alone (lil → lil.inst.eth). The box always shows what was typed: the text
 * and the cursor are never touched, so `nick` goes on to `nick.eth`. A match shows under the box.
 * `onChange` gets the address (and the name that was looked up), or null.
 * `value` + `onText`: the text is held outside (Send fills it from a scan). `onScan`: the scan pill opens the
 * caller's own scanner. `scan={false}`: no pill (the screen is already a scanner). `after`: a button beside the box
 * (Add): it stays level with the box when a match shows under it.
 */
const lookedUp = new Map<string, Address>(); // names already answered: a box that comes back (Back from the review) has its match at once
export function AddressInput({
  initial,
  value,
  onText,
  onChange,
  placeholder = "0x… or name.eth",
  chain,
  scan = true,
  onScan,
  onEnter,
  after,
}: {
  initial?: string;
  value?: string;
  onText?: (t: string) => void;
  onChange: (a: Address | null, name?: string) => void;
  placeholder?: string;
  chain?: number;
  scan?: boolean;
  onScan?: () => void;
  onEnter?: () => void;
  after?: React.ReactNode;
}) {
  const [own, setOwn] = useState(initial ?? "");
  const text = value ?? own;
  const setText = (t: string) => (onText ? onText(t) : setOwn(t));
  const [addr, setAddr] = useState<Address | null>(null);
  const [name, setName] = useState<string | null>(null); // the name that was looked up: as typed, or lil.inst.eth for a bare "lil"
  const [looking, setLooking] = useState(false);
  const tell = useRef(onChange);
  tell.current = onChange;
  useEffect(() => {
    const v = nameIn(text);
    const set = (a: Address | null, n: string | null) => {
      setAddr(a);
      setName(n);
      tell.current(a, n ?? undefined);
    };
    if (isAddress(v)) return set(getAddress(v), null);
    const lookup = nameTyped(v, true);
    const before = lookup ? lookedUp.get(lookup) : undefined;
    set(before ?? null, before && lookup ? lookup : null);
    if (!lookup) return;
    if (v.includes(".") && !before) setLooking(true); // a word alone is tried quietly: no "Looking up…" on the way to nick.eth
    let live = true; // a late answer for older text must never land on newer text
    const t = setTimeout(async () => {
      const j = await fetch(`/api/ens?name=${encodeURIComponent(lookup)}`).then(r => r.json()).catch(() => null);
      if (!live) return;
      setLooking(false);
      if (j?.address) (lookedUp.set(lookup, getAddress(j.address)), set(getAddress(j.address), lookup));
      else if (j) (lookedUp.delete(lookup), set(null, null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
      setLooking(false); // else "Looking up…" sticks when the next text isn't a name
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  const cam = useAddressScan(setText);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <div className="input grow">
          {addr && !name && <Blockie address={addr} size={30} />}
          <input value={text} onChange={e => setText(addressIn(e.target.value))} onKeyDown={e => e.key === "Enter" && addr && onEnter?.()} placeholder={placeholder} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          {scan &&
            (onScan ? (
              <button type="button" className="pill" onClick={onScan} aria-label="Scan">
                <ScanIcon size={20} />
              </button>
            ) : (
              cam.pill
            ))}
        </div>
        {after}
      </div>
      {looking && <span className="fine">Looking up {text}…</span>}
      {addr && name && <Who address={addr} chain={chain} label={text.includes(".") ? undefined : name} />}
      {addr && name && <NameMoved name={name} address={addr} />}
      {cam.camera}
    </div>
  );
}

/** The wedgie's green button, drawn inline in text. Never name the buttons A/B/X/Y: people see green and red. */
/** What a tx is doing right now, on its button: the same words everywhere (Send, Swap, a site's request, Share, Send everything). */
export function stageLabel(stage?: string | null): React.ReactNode {
  switch (stage) {
    case "quote":
      return "Getting the fee…";
    case "signing":
      return "Signing…";
    case "signing-hot":
      return "Sign in your browser wallet…";
    case "signing-wedgie":
      return <>Press <GreenButton /> on the wedgie…</>;
    case "sending":
    case "confirming": // still executing until it's in a block: one word for both (EXPECTATIONS: Executing…, ✓ Executed)
      return "Executing…";
  }
  return "…";
}

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
