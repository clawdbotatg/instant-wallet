import type { Address } from "viem";
import { relayHeaders } from "../chains";
import { isLocal } from "../local";

/**
 * A copy on your own computer has its own relay (Settings → Your relay), and it pays for every send. Empty, or not
 * made yet, it can't: then the Fund your relay sheet opens (components/safe/FundRelay.tsx) with its address as a QR
 * code and what it holds, and the send goes on by itself once the money is there (Austin 11-19: two signatures in,
 * Execute said "gas required exceeds allowance (0)"). Never on our site: its relay is ours to keep funded.
 *
 * One place: every request to /api/safe/relay goes through relayJson().
 */
export type Short = { chainId: number; address: Address | null; have?: string; need?: string; usd?: number };

/** The relay can't pay for this. Its message says so in words; `short` draws the sheet. */
export class RelayEmpty extends Error {
  short: Short;
  constructor(message: string, short: Short) {
    super(message);
    this.short = short;
  }
}

type Ask = { short: Short; done: (funded: boolean) => void };
let ask: Ask | null = null;
const subs = new Set<() => void>();
const tell = () => subs.forEach(f => f());
export const fundSubscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const fundAsk = () => ask;

/** What the relay's last "can't pay" said, so the error line under any button can offer the sheet (<ErrorLine>). */
let last: { text: string; short: Short } | null = null;
export const shortFor = (text: string): Short | null => (last && last.text === text ? last.short : null);

/** Told when the relay got its money: a screen whose fee failed asks for it again. */
export const RELAY_FUNDED = "iw:relayfunded";

/** Open the sheet. true: the relay has the money now. false: closed without. One at a time. */
export function askFund(short: Short): Promise<boolean> {
  if (ask) return Promise.resolve(false);
  return new Promise(res => {
    ask = {
      short,
      done: funded => {
        ask = null;
        tell();
        if (funded) {
          last = null;
          window.dispatchEvent(new Event(RELAY_FUNDED));
        }
        res(funded);
      },
    };
    tell();
  });
}

/** "Execute from my wallet", as the screen under the sheet would do it (bits.tsx useOfferMine). The newest one. */
type Offer = () => (() => void) | null; // the screen's action as it is right now, or null: not on offer
const mines: Offer[] = [];
export function offerMine(get: Offer) {
  mines.push(get);
  return () => void mines.splice(mines.lastIndexOf(get), 1);
}
export function mineOffer(): (() => void) | null {
  for (let i = mines.length - 1; i >= 0; i--) {
    const fn = mines[i]();
    if (fn) return fn;
  }
  return null;
}

// opened by a tap, never by a fee read in the background: the browser says whether a tap just happened. Where it
// can't say, the error line's button opens the sheet
const tapped = () => typeof navigator !== "undefined" && !!(navigator as any).userActivation?.isActive;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A request to the relay. On a copy on your own computer, when the relay can't pay and a tap started this, the
 * sheet opens and the same request goes again once it's funded. Else it fails with RelayEmpty.
 */
export async function relayJson(chainId: number, url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; j: any }> {
  const byTap = tapped(); // asked now: the answer can come back after the browser has forgotten the tap
  let funded = 0; // tries since the sheet saw the money: the relay's node can be a block behind the read that saw it
  for (;;) {
    const r = await fetch(url, { cache: "no-store", ...init, headers: { ...(init.headers as Record<string, string>), ...relayHeaders(chainId) } });
    const j = await r.json().catch(() => ({}));
    const short: Short | undefined = !r.ok && isLocal() ? j?.relay : undefined;
    if (!short) return { ok: r.ok, status: r.status, j };
    const text = String(j.error || "Your relay can't pay for this.");
    last = { text, short };
    if (funded && funded < 5) {
      funded++;
      await wait(2000);
      continue;
    }
    if (!(byTap || tapped()) || !(await askFund(short))) throw new RelayEmpty(text, short);
    funded = 1;
  }
}
