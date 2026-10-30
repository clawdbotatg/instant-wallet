import { type Address, type Hex, getAddress } from "viem";
import { wedgieSign } from "clear-signing-safe-kit";
import { type SafeTx, type Sig, encodeWebAuthn } from "./core";

/**
 * The wedgie over Web Serial (Chrome / Edge on a computer), running the Safe signer app (clawdbotatg/wedgie-safe).
 * Protocol (docs/WEDGIE-SAFE.md): one JSON line each way.
 *   {"id":1,"type":"hello"}                               -> {"type":"hello", ..., "safe": {"x","y"} | null}
 *   {"id":2,"type":"safe_sign","tx":{chainId, safe, to, value, data, operation, safeTxGas, baseGas, gasPrice,
 *    gasToken, refundReceiver, nonce}}                     -> {"type":"safe_sig", safeTxHash, x, y, r, s,
 *                                                             authenticatorData, clientDataFields} | {"type":"refused"}
 *   {"id":3,"type":"safe_message","chainId","safe","hex"}  -> {"type":"safe_sig", messageHash, safeMessageHash, x, y, r, s,
 *                                                             authenticatorData, clientDataFields} (wedgie-safe safe-29+)
 * The wedgie computes the hash itself, shows the transaction (or the message's text), and signs only on a real A press.
 * A USB line is at most 6 KB: a bigger tx (a bridge swap) sends its data ahead in pieces, if the app says it takes
 * them (hello's safe_chunk, wedgie-safe b4e86f8+):
 *   {"type":"safe_data","at":<bytes so far>,"hex":"..."} -> {"type":"safe_data","have":n}, then safe_sign with data "@".
 * Clear signing (safe-24+, hello's safe_clear = the data tag it trusts): the ERC-7730 bundle for the tx goes first, in
 * pieces, {"type":"safe_clear","at","hex"} -> {"type":"safe_clear","have":n}; the next safe_sign shows the calls it
 * names (lib/safe/clear.ts). Any error answer carries {"type":"error","error":".."}: we always show its text.
 *
 * In the Instant Wallet iPhone app there's no serial port: the app gives the page window.wedgieDrive, and the same
 * requests go as files on the wedgie's WEDGIE drive (docs/WEDGIE-PHONE.md, the app's WebView.swift). The drive
 * is read-only until the wedgie lets the phone in; connect() opens the app's wedgie panel for that.
 */
const RPI_VID = 0x2e8a;
const serialOK = () => typeof navigator !== "undefined" && "serial" in navigator;

export type DriveState = "unpicked" | "away" | "readonly" | "here";
// connecting: the app is knocking or the drive is remounting; press: its firmware (0.3.37-0.3.40) asks for a
// green press before it turns writable (0.3.41+ doesn't ask)
type DriveStatus = {
  state: DriveState;
  name: string;
  panel?: boolean;
  connecting?: boolean;
  press?: boolean;
  healing?: boolean; // the app saw a cached (stale) drive and asked the wedgie to remount: about 5 s, then it's back
};
type DriveBridge = {
  status(): Promise<DriveStatus>;
  send(line: string): Promise<string>;
  read(name: string): Promise<string | null>;
  panel(mode?: string): Promise<boolean>;
  log?(text: string): Promise<boolean>; // a line in the app's log (newer app builds)
};
const bridge = (): DriveBridge | undefined => (typeof window !== "undefined" ? (window as any).wedgieDrive : undefined);
/** In the iPhone app: the wedgie is reached through its WEDGIE drive, not Web Serial. */
export const wedgieDrive = () => !!bridge();
export const driveState = async (): Promise<DriveState> => (await bridge()?.status().catch(() => null))?.state ?? "unpicked";
/** The app's wedgie panel: find the drive, let this phone in. */
export const openDrivePanel = () => bridge()?.panel();

/** This browser can reach a wedgie: Web Serial (Chrome / Edge on a computer) or the iPhone app's drive. */
export const wedgieSupported = () => wedgieDrive() || serialOK();
/** Web Serial only: picking, forgetting and installing apps on the wedgie need it. */
export const wedgieSerial = () => !wedgieDrive() && serialOK();

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** What the wedgie is doing right now, for the bar at the bottom of the screen (WedgieProgress): p is real
 * progress 0..1 when known; press = waiting for the person's green button. null = nothing. */
export type WedgieActivity = { what: string; p?: number; press?: boolean } | null;
const watchers = new Set<(a: WedgieActivity) => void>();
export function onWedgieActivity(fn: (a: WedgieActivity) => void): () => void {
  watchers.add(fn);
  return () => void watchers.delete(fn);
}
let current: WedgieActivity = null;
const activity = (a: WedgieActivity) => {
  current = a;
  watchers.forEach(f => f(a));
};

/** The bar while the iPhone app connects the wedgie (it knocks by itself; about 4-8 s): from the first look at
 * a read-only drive until it's writable. Creeps on time so it runs about as long as the wait. */
export function watchDriveConnect(): () => void {
  if (!wedgieDrive()) return () => {};
  let since = 0;
  let mine: WedgieActivity = null;
  const t = window.setInterval(async () => {
    const s = await bridge()?.status().catch(() => null);
    const on = !!s && (s.state === "readonly" || (s.state === "away" && !!s.connecting) || !!s.healing);
    if (on) {
      since ||= Date.now();
      const p = 0.95 * (1 - Math.exp(-(Date.now() - since) / 4000));
      mine = s!.press ? { what: "Press the green button on your wedgie", p, press: true } : { what: s!.healing ? "Reconnecting your wedgie" : "Connecting your wedgie", p };
      if (!current || current === mine || current.what === mine.what || !s!.healing) activity(mine); // a signing's bar stays
    } else if (since) {
      since = 0;
      if (current === mine) activity(null); // never clear a signing's bar
      mine = null;
    }
  }, 500);
  return () => clearInterval(t);
}
// The wedgie keeps what the phone writes in 12 sectors of RAM (6 KB, FAT and folder writes included), and frees a
// deleted request's sectors only 2 s after they were written. The app deletes the last request before each write,
// so over the drive: lines of at most 3-4 sectors, and 2.2 s from one write to the next (a big tx's pieces filled
// the RAM at 2000 hex a piece, sent back to back, 10-10).
const DRIVE_LINE_MAX = 1600;
const DRIVE_CHUNK = 1400; // hex chars per safe_data piece
const DRIVE_GAP = 2200; // ms from one write to the next
let driveSent = 0;
let driveFw = ""; // the wedgie's firmware, from a hello over the drive: 0.3.41+ frees a request's RAM on read
const driveGap = () => (driveFw && !older(driveFw, "0.3.41") ? 300 : DRIVE_GAP);
// ANSWER.TXT keeps the last few answers across requests (and pages): ids that won't repeat
let driveId = (Date.now() % 1e6) * 100;
let driveLock: Promise<unknown> = Promise.resolve();

/** A line in the app's log, beside its own drive lines: proof of what the page saw. */
const dlog = (text: string) => void bridge()?.log?.(text)?.catch?.(() => {});

/** The app is remounting a stale drive (about 5 s): wait until it's back. Returns how long it took. */
async function waitHeal(): Promise<number> {
  const w0 = Date.now();
  while (Date.now() - w0 < 20000) {
    await sleep(300);
    const n = await bridge()?.status().catch(() => null);
    if (n && !n.healing && n.state === "here") break;
  }
  return Date.now() - w0;
}

/** One request over the drive: write it, then read ANSWER.TXT until an answer with its id is there. One at a time. */
function driveRequest(msg: Record<string, unknown>, ms: number): Promise<any> {
  const run = driveLock
    .catch(() => {})
    .then(async () => {
      const d = bridge();
      if (!d) throw new Error("wedgie unplugged");
      const id = ++driveId;
      const line = JSON.stringify({ ...msg, id });
      for (let tries = 0; ; tries++) {
        await sleep(Math.max(0, driveSent + driveGap() - Date.now()));
        try {
          driveSent = Date.now();
          await d.send(line);
          break;
        } catch (e) {
          if ((await bridge()?.status().catch(() => null))?.healing) {
            dlog(`${msg.type} ${id}: send waited ${await waitHeal()} ms for a remount`);
            continue;
          }
          // a full drive frees what's been read in a few seconds; unplugged doesn't come back
          if (tries >= 5 || (await driveState()) !== "here") {
            dlog(`${msg.type} ${id}: send failed ${tries + 1}x (${(e as Error)?.message})`);
            throw new Error("Couldn't reach the wedgie. Is it plugged in?");
          }
          await sleep(1000);
        }
      }
      const t0 = Date.now();
      let reads = 0, fails = 0;
      for (let end = Date.now() + ms; Date.now() < end; ) {
        await sleep(300); // a bridge call, cheap: the wedgie reads a request 0.7 s after it lands
        reads++;
        const t = await d.read("ANSWER.TXT").catch(() => null);
        if (t === null) {
          fails++;
          const st = await bridge()?.status().catch(() => null);
          if (st?.healing) {
            // the app is remounting a stale drive (2 s off USB): the wedgie keeps its answers, so wait, then read on
            dlog(`${msg.type} ${id}: waited ${await waitHeal()} ms for a remount`);
            end = Date.now() + ms;
            continue;
          }
          const s = st?.state ?? "unpicked";
          if (s !== "here") {
            dlog(`${msg.type} ${id}: drive ${s} while waiting (${Date.now() - t0} ms)`);
            throw new Error("wedgie unplugged");
          }
          continue;
        }
        for (const l of t.split("\n")) {
          if (!l.startsWith("{")) continue;
          try {
            const a = JSON.parse(l);
            if (a.id === id) {
              if (a.type === "hello" && a.version) driveFw = a.version;
              dlog(`${msg.type} ${id}: answered ${a.type} in ${Date.now() - t0} ms`);
              return a;
            }
          } catch {}
        }
      }
      dlog(`${msg.type} ${id}: no answer in ${ms} ms (${reads} reads, ${fails} failed)`);
      throw new Error("The wedgie didn't answer. Is it running the Safe signer app?");
    });
  driveLock = run;
  return run;
}

type Pending = { res: (v: any) => void; rej: (e: Error) => void; t: number };

const NOT_SAFE = "Your wedgie isn't in Safe Signer. Open Safe Signer on it, then try again.";
/** Any answer but a signature, as an error that says what the wedgie said. */
function notSigned(g: any): Error {
  if (g?.type === "refused") return new Error("Refused on the wedgie.");
  const e = String(g?.error || "");
  if (g?.type === "error" && /unknown type|^locked/.test(e)) return new Error(NOT_SAFE); // another app has it
  if (g?.type === "error" && e) return new Error(`The wedgie won't sign it: ${e}`);
  return new Error(`The wedgie said something unexpected (${g?.type || "nothing"}).`);
}

// One user of the port at a time: a status peek (WedgieButton) never opens it while a signing connection holds
// it, and a connect waits for a peek in flight to close it.
let holder: Wedgie | null = null;
let peeking: Promise<unknown> | null = null;

// On a Mac, Chrome's first look for serial ports (getPorts included) also looks for Bluetooth ones and macOS
// asks "Chrome would like to use Bluetooth". So nothing peeks until this browser has asked for a wedgie once.
const ARMED = "iws.wedgie-armed";
export const wedgieArmed = () => {
  if (!serialOK()) return false;
  try {
    return localStorage.getItem(ARMED) === "1";
  } catch {
    return false;
  }
};
const arm = () => {
  try {
    localStorage.setItem(ARMED, "1");
  } catch {}
};

/** What a plugged-in wedgie said when asked hello (nothing signs, nothing shows on its screen). */
export type WedgieHello = { version?: string; short?: string; running?: string | null; carts?: { mod: string; v?: string | null }[]; safe?: { x: Hex; y: Hex } | null; safe_chunk?: number; safe_clear?: string | null; safe_sim?: string; safe_review?: number };
const LINE_MAX = 5800; // the wedgie's USB line is 6 KB
export type Peek =
  | { kind: "none" } // no wedgie this browser was allowed to see is plugged in
  | { kind: "busy" } // a signing connection has it open right now
  | { kind: "taken" } // plugged in, but something else has the port open (a wedgie.dev tab, Thonny)
  | { kind: "silent"; error: string } // plugged in, but it didn't answer (still booting, or not running wedgie firmware)
  | { kind: "phone"; state: Exclude<DriveState, "here">; press?: boolean } // iPhone app: drive not picked, unplugged, or not writable yet
  | { kind: "hello"; hello: WedgieHello };

/** The wedgie's port is held by another tab or app (wedgie.dev, a second Instant Wallet, Thonny). ErrorLine shows it
 * with a sad wedgie. */
export const WEDGIE_TAKEN = "Your wedgie is busy in another tab. Close the other tab, then try again.";
const takenError = (e: any) => /failed to open|busy|access denied|already open/i.test(e?.message || "");

export class Wedgie {
  private port: any;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private line = "";
  alive = true;
  private drive = false; // through the iPhone app's WEDGIE drive, not a serial port
  private next = 100;
  private pending = new Map<number, Pending>();

  static async connect(): Promise<Wedgie> {
    if (wedgieDrive()) return Wedgie.viaDrive();
    if (!wedgieSupported()) throw new Error("This browser can't talk to a wedgie. Use Chrome or Edge on a computer.");
    const serial = (navigator as any).serial;
    const known = (await serial.getPorts()).filter((p: any) => p.getInfo().usbVendorId === RPI_VID);
    const port = known[0] ?? (await serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] }));
    arm();
    await peeking?.catch(() => {});
    if (holder) throw new Error("The wedgie is busy with another transaction.");
    const w = new Wedgie();
    w.port = port;
    await port.open({ baudRate: 115200 }).catch((e: any) => {
      throw takenError(e) ? new Error(WEDGIE_TAKEN) : e;
    });
    w.writer = port.writable.getWriter();
    w.reader = port.readable.getReader();
    w.read();
    holder = w;
    return w;
  }

  /** In the iPhone app. Returns at once, so a Face ID asked right after still has the tap; the first request
   * waits until the drive is ready (driveIn). */
  private static async viaDrive(): Promise<Wedgie> {
    // no waiting for a status peek in flight (a slow hello would cost the Face ID its tap): driveRequest's lock
    // puts this connection's requests after it anyway
    if (holder) throw new Error("The wedgie is busy with another transaction.");
    const w = new Wedgie();
    w.drive = true;
    holder = w;
    return w;
  }

  /** The wedgie must be plugged in with its drive writable. Read-only: the app is already knocking by itself,
   * so just wait (the bottom bar shows it). Not picked or not plugged in: the app's panel walks the person through
   * it and closes by itself once writable; closing it first = no wedgie. */
  private driveIn?: Promise<void>;
  private waitDrive(): Promise<void> {
    this.driveIn ??= (async () => {
      const d = bridge();
      if (!d) throw new Error("wedgie unplugged");
      const first = await driveState();
      if (first === "here") return;
      if (first !== "readonly") await d.panel("connect");
      for (const end = Date.now() + 300_000; ; ) {
        await sleep(300);
        const s = await d.status().catch(() => null);
        if (s?.state === "here") return;
        const waiting = s?.panel || s?.state === "readonly" || (s?.state === "away" && s.connecting);
        if (!waiting || Date.now() > end) throw new Error("No wedgie connected. Plug it into this iPhone, then try again.");
      }
    })();
    this.driveIn.catch(() => (this.driveIn = undefined)); // closed the panel: the next request asks again
    return this.driveIn;
  }

  /** Let this browser see a wedgie (the port picker; needs a tap). False if the person cancelled. */
  static async pick(): Promise<boolean> {
    if (!wedgieSerial()) return false;
    try {
      await (navigator as any).serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] });
      arm();
      return true;
    } catch {
      return false;
    }
  }

  /** Is a wedgie plugged in, and what is it running? Opens the port for a hello and closes it again. */
  static async peek(fresh = false): Promise<Peek> {
    if (fresh) Wedgie.driveHello = null;
    if (wedgieDrive()) return Wedgie.peekDrive();
    if (!wedgieSupported() || !wedgieArmed()) return { kind: "none" };
    if (holder) return { kind: "busy" };
    if (peeking) return (await peeking.catch(() => ({ kind: "none" }))) as Peek;
    const run = (async (): Promise<Peek> => {
      const ports = (await (navigator as any).serial.getPorts()).filter((p: any) => p.getInfo().usbVendorId === RPI_VID);
      if (!ports.length) return { kind: "none" };
      const w = new Wedgie();
      w.port = ports[0];
      try {
        await w.port.open({ baudRate: 115200 });
      } catch (e: any) {
        if (takenError(e)) return { kind: "taken" };
        return { kind: "silent", error: "Couldn't open it." };
      }
      w.writer = w.port.writable.getWriter();
      w.reader = w.port.readable.getReader();
      w.read();
      try {
        return { kind: "hello", hello: await w.request({ type: "hello" }, 2500) };
      } catch {
        return { kind: "silent", error: "It didn't answer." };
      } finally {
        await w.close();
      }
    })();
    peeking = run;
    try {
      return await run;
    } finally {
      peeking = null;
    }
  }

  // a hello over the drive writes a file and takes a second or two: reuse it while the drive stays put
  private static driveHello: { at: number; hello: WedgieHello } | null = null;

  private static async peekDrive(): Promise<Peek> {
    if (holder) return { kind: "busy" };
    const st = await bridge()?.status().catch(() => null);
    const s = st?.state ?? "unpicked";
    if (s !== "here") {
      Wedgie.driveHello = null;
      return { kind: "phone", state: s, press: st?.press };
    }
    const c = Wedgie.driveHello;
    if (c && Date.now() - c.at < 20_000) return { kind: "hello", hello: c.hello };
    if (peeking) return (await peeking.catch(() => ({ kind: "none" }))) as Peek;
    const run = driveRequest({ type: "hello" }, 6000).then(
      (hello): Peek => {
        Wedgie.driveHello = { at: Date.now(), hello };
        return { kind: "hello", hello };
      },
      (): Peek => ({ kind: "silent", error: "It didn't answer." }),
    );
    peeking = run;
    try {
      return await run;
    } finally {
      peeking = null;
    }
  }

  /** Plugged in / unplugged (only for wedgies this browser may see). Returns the unsubscribe. */
  static watch(fn: () => void): () => void {
    if (wedgieDrive()) {
      // the app has no plug-in event for the page: look at the drive's state every 0.5 s (a cheap bridge call)
      let last: DriveState | null = null;
      const t = window.setInterval(async () => {
        const s = await driveState();
        if (last !== null && s !== last) {
          Wedgie.driveHello = null;
          fn();
        }
        last = s;
      }, 500);
      return () => clearInterval(t);
    }
    if (!wedgieSupported() || !wedgieArmed()) return () => {};
    const serial = (navigator as any).serial;
    serial.addEventListener("connect", fn);
    serial.addEventListener("disconnect", fn);
    return () => {
      serial.removeEventListener("connect", fn);
      serial.removeEventListener("disconnect", fn);
    };
  }

  /** The wedgie again after a checked install's restart (same device, maybe a new port), within ~25 s. */
  static async reopen(since: number): Promise<Wedgie> {
    const serial = (navigator as any).serial;
    while (Date.now() - since < 25_000) {
      await new Promise(r => setTimeout(r, 400));
      const port = (await serial.getPorts()).find((p: any) => p.getInfo().usbVendorId === RPI_VID);
      if (!port) continue;
      try {
        await port.open({ baudRate: 115200 });
      } catch {
        continue;
      }
      const w = new Wedgie();
      w.port = port;
      w.writer = port.writable.getWriter();
      w.reader = port.readable.getReader();
      w.read();
      holder = w;
      return w;
    }
    throw new Error("The wedgie restarted and didn't come back. Unplug it and plug it in again.");
  }

  /** Stop letting this browser see the wedgie (it asks again next time). */
  static async forget() {
    if (!wedgieSerial()) return;
    for (const p of await (navigator as any).serial.getPorts()) if (p.getInfo().usbVendorId === RPI_VID) await p.forget?.().catch(() => {});
  }

  private async read() {
    const dec = new TextDecoder("latin1");
    try {
      while (true) {
        const { value, done } = await this.reader!.read();
        if (done) break;
        this.line += dec.decode(value);
        let i;
        while ((i = this.line.indexOf("\n")) >= 0) {
          const l = this.line.slice(0, i).replace(/\r$/, "").replace(/^[\x04>]*(OK)?/, "");
          this.line = this.line.slice(i + 1);
          if (!l.startsWith("{")) continue;
          try {
            const v = JSON.parse(l);
            const p = typeof v.id === "number" ? this.pending.get(v.id) : undefined;
            if (p) {
              clearTimeout(p.t);
              this.pending.delete(v.id);
              p.res(v);
            }
          } catch {}
        }
      }
    } catch {}
    this.alive = false;
    if (holder === this) holder = null;
    for (const [, p] of this.pending) p.rej(new Error("wedgie unplugged"));
    this.pending.clear();
  }

  request(msg: Record<string, unknown>, ms = 5000): Promise<any> {
    if (this.drive) return this.waitDrive().then(() => driveRequest(msg, ms));
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("The wedgie didn't answer. Is it running the Safe signer app?"));
      }, ms);
      this.pending.set(id, { res, rej, t });
      this.writer!.write(new TextEncoder().encode(JSON.stringify({ ...msg, id }) + "\n")).catch(rej);
    });
  }

  /** A short JSON line, then `raw` bytes right after it (a checked install's put, firmware 0.3.16+). */
  requestRaw(msg: Record<string, unknown>, raw: Uint8Array, ms = 15000): Promise<any> {
    if (this.drive) return Promise.reject(new Error("Installing needs a computer."));
    const id = this.next++;
    return new Promise((res, rej) => {
      const t = window.setTimeout(() => {
        this.pending.delete(id);
        rej(new Error("The wedgie stopped answering."));
      }, ms);
      this.pending.set(id, { res, rej, t });
      this.writer!.write(new TextEncoder().encode(JSON.stringify({ ...msg, n: raw.length, id }) + "\n"))
        .then(() => this.writer!.write(raw))
        .catch(rej);
    });
  }

  /** Its hello, once per connection: it must be running Safe Signer (after a firmware update it can be in another app). */
  private hi?: Promise<WedgieHello>;
  private safeHello(): Promise<WedgieHello> {
    this.hi ??= this.request({ type: "hello" }, 5000).then(h => {
      if (h?.running !== undefined && h.running !== "safe") throw new Error(NOT_SAFE);
      return h;
    });
    this.hi.catch(() => (this.hi = undefined));
    return this.hi;
  }

  async key(): Promise<{ x: Hex; y: Hex }> {
    activity({ what: "Talking to your wedgie", p: 0.1 });
    const h = await this.request({ type: "hello" }, 5000).finally(() => activity(null));
    if (!h?.safe) throw new Error("The wedgie has no Safe key yet: press green on it to make one, then try again.");
    return { x: h.safe.x, y: h.safe.y };
  }

  /** One A press signs `t`; returns its signature for each of the wedgie's owner slots given (1 or 2). */
  async sign(chainId: number, safe: Address, t: SafeTx, expectHash: Hex, slots: Address[]): Promise<Sig[]> {
    const tx = {
      chainId,
      safe: getAddress(safe),
      to: getAddress(t.to),
      value: t.value.toString(),
      data: t.data,
      operation: t.operation,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: Number(t.nonce),
    };
    try {
      return await this.signing(tx, expectHash, slots);
    } finally {
      activity(null);
    }
  }

  /** One A press signs a site's text message (personal_sign) for the Safe; `raw` = the message's bytes. The wedgie
   * shows the text and works out the SafeMessage hash itself; `expectHash` is ours, to check it signed the same. */
  async signMessage(chainId: number, safe: Address, raw: Hex, expectHash: Hex, slots: Address[]): Promise<Sig[]> {
    const msg = { type: "safe_message", chainId, safe: getAddress(safe), hex: raw };
    if (JSON.stringify({ id: 0, ...msg }).length > (this.drive ? DRIVE_LINE_MAX : LINE_MAX)) throw new Error("This message is too long for the wedgie.");
    try {
      activity({ what: "Talking to your wedgie", p: 0.05 });
      await this.safeHello();
      activity({ what: "Press the green button on your wedgie", p: 0.92, press: true });
      const g = await this.request(msg, 300_000);
      if (g?.type === "error" && /unknown type/.test(g.error || "")) throw new Error("Your wedgie's Safe signer is too old to sign messages. Update it from the wedgie button (on a computer), then try again.");
      if (g?.type !== "safe_sig") throw notSigned(g);
      if (String(g.safeMessageHash).toLowerCase() !== expectHash.toLowerCase()) throw new Error("The wedgie signed a different message. Not sending.");
      const data = encodeWebAuthn({ authenticatorData: g.authenticatorData, clientDataFields: g.clientDataFields, r: BigInt(g.r), s: BigInt(g.s) });
      return slots.map(signer => ({ signer, data, kind: "contract" as const }));
    } finally {
      activity(null);
    }
  }

  private async signing(tx: Parameters<typeof wedgieSign>[0]["tx"], expectHash: Hex, slots: Address[]): Promise<Sig[]> {
    activity({ what: "Sending it to your wedgie", p: 0.05 });
    const hello = await this.safeHello();
    // the one way both sites send it (clear-signing-safe-kit): bundle, simulation, data in pieces, safe_sign
    const g = await wedgieSign({
      ask: (m, ms) => this.request(m, ms),
      hello,
      tx,
      ...(this.drive ? { chunk: DRIVE_CHUNK, lineMax: DRIVE_LINE_MAX } : {}),
      progress: p => activity({ what: "Sending it to your wedgie", p: 0.05 + 0.85 * p }),
      press: () => activity({ what: "Press the green button on your wedgie", p: 0.92, press: true }),
    });
    if (g?.type !== "safe_sig") throw notSigned(g);
    if (String(g.safeTxHash).toLowerCase() !== expectHash.toLowerCase()) throw new Error("The wedgie signed a different transaction. Not executing.");
    const data = encodeWebAuthn({ authenticatorData: g.authenticatorData, clientDataFields: g.clientDataFields, r: BigInt(g.r), s: BigInt(g.s) });
    return slots.map(signer => ({ signer, data, kind: "contract" as const }));
  }

  async close() {
    if (holder === this) holder = null;
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {}
  }
}

// ---------------------------------------------------------------- installing the Safe signer
// The same checked install wedgie.dev uses (wedgie-dev src/serial/install.ts, firmware/job.py): the wedgie asks
// its person ("Install Safe signer?"), then checks wedgie.dev's signed list (release.txt + sig, our release key)
// and every file's sha256 against it before anything goes in place. So this page can't put anything on it
// that wedgie.dev didn't sign. Needs firmware 0.3.12+ (hello "jobs"); older ones update at wedgie.dev first.

const FW = "https://wedgie.dev/fw/";
const SAFE_MOD = "safe";
export class OldFirmware extends Error {}
type Manifest = { version: string; signed?: boolean; files: { name: string; size: number; sha256: string }[]; core: string[]; carts: { mod: string; name: string; entry?: string; usb?: boolean; about?: string; files: string[]; v: string; repo?: string }[] };

const sha256hex = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b as BufferSource))].map(x => x.toString(16).padStart(2, "0")).join("");
const b64 = (u8: Uint8Array) => {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const twin = (n: string) => (n.endsWith(".mpy") ? n.slice(0, -4) + ".py" : null);
const withTwins = (ns: string[]) => [...new Set([...ns, ...ns.map(twin).filter((n): n is string => !!n)])];
export const older = (a: string, b: string) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};

/** What wedgie.dev ships now: its firmware version and the Safe signer's commit. Fetched at most every 10 minutes. */
export type Latest = { version: string; safe?: string };
let latest: { at: number; p: Promise<Latest | null> } | null = null;
export function latestWedgie(): Promise<Latest | null> {
  if (latest && Date.now() - latest.at < 600_000) return latest.p;
  const p = fetch(FW + "manifest.json", { cache: "no-cache" })
    .then(r => r.json() as Promise<Manifest>)
    .then(m => (m.signed && m.version ? { version: m.version, safe: m.carts.find(c => c.mod === SAFE_MOD)?.v } : null))
    .catch(() => null);
  latest = { at: Date.now(), p };
  p.then(v => v === null && (latest = null)); // a failed look tries again next time
  return p;
}

/** Is the plugged-in wedgie behind wedgie.dev? firmware: its core is older. app: its Safe signer isn't wedgie.dev's. */
export function behind(h: WedgieHello, l: Latest | null): { firmware?: boolean; app?: boolean } {
  if (!l) return {};
  const v = h.carts?.find(c => c.mod === SAFE_MOD)?.v;
  return { firmware: !!h.version && older(h.version, l.version), app: "safe" in h && !!l.safe && !!v && v !== l.safe };
}

/** Put the Safe signer on the plugged-in wedgie. step: what to say ("Press the green button on the wedgie", "Installing", p 0..1). */
export async function installSafeApp(step: (what: string, p?: number) => void): Promise<void> {
  if (!wedgieSerial()) throw new Error("Install the Safe signer from Chrome or Edge on a computer.");
  let w = await Wedgie.connect();
  try {
    const h = await w.request({ type: "hello" }, 2500).catch(() => null);
    if (!h) throw new Error("The wedgie didn't answer. Unplug it, plug it back in, then try again.");
    if (!h.jobs || !h.version || older(h.version, "0.3.12")) throw new OldFirmware("Its firmware is too old for this. Update it at wedgie.dev first.");
    const [m, rel] = await Promise.all([
      fetch(FW + "manifest.json", { cache: "no-cache" }).then(r => r.json() as Promise<Manifest>),
      Promise.all(["release.txt", "release.sig"].map(n => fetch(FW + n, { cache: "no-cache" }).then(r => r.text()))),
    ]);
    const cart = m.carts.find(c => c.mod === SAFE_MOD);
    if (!m.signed || !cart) throw new Error("wedgie.dev doesn't have the Safe signer right now. Try again later.");
    const info = (n: string) => m.files.find(f => f.name === n)!;
    // what's on it: every app file wedgie.dev knows, plus any an app on it listed itself (a repo app)
    const all = withTwins([...m.core, ...m.carts.flatMap(c => c.files)]);
    const v = await w.request({ type: "sums", names: [], exists: all }, 30000);
    if (!v?.sums) throw new Error("The wedgie didn't say what's on it.");
    const listed: string[] = withTwins((v.apps || []).flatMap((a: any) => (Array.isArray(a?.files) ? a.files : [])));
    const extra = listed.filter(n => !(n in v.sums));
    if (extra.length) Object.assign(v.sums, (await w.request({ type: "sums", names: [], exists: extra }, 30000))?.sums || {});
    const keep = new Set(withTwins([...m.core, ...cart.files]));
    const del = withTwins([...m.carts.flatMap(c => c.files), ...listed]).filter(n => !keep.has(n) && v.sums[n]);
    const write = cart.files;
    const apps = [{ mod: cart.mod, name: cart.name, ...(cart.entry ? { entry: cart.entry } : {}), ...(cart.usb ? { usb: true } : {}), about: cart.about, v: cart.v, ...(cart.repo ? { repo: cart.repo, files: cart.files } : {}) }];
    // the files download while the wedgie asks
    const files = Promise.all(
      write.map(async n => {
        const buf = new Uint8Array(await (await fetch(FW + n, { cache: "no-cache" })).arrayBuffer());
        if ((await sha256hex(buf)) !== info(n).sha256) throw new Error("wedgie.dev changed just now. Try again.");
        return { n, buf };
      }),
    );
    files.catch(() => {});

    step("Press the green button on the wedgie to install");
    let bin = h.bin as number | undefined;
    const sent = Date.now();
    const go = await w
      .request({ type: "job", job: `Install ${cart.name}`, version: m.version, write, delete: del, apps: JSON.stringify(apps), bytes: write.reduce((t, n) => t + info(n).size, 0), ...(bin ? { raw: true } : {}) }, 120_000)
      .catch(e => (w.alive ? Promise.reject(e) : null));
    if (go === null) {
      // a yes restarts it into install mode, and the first restart since it was plugged in drops the port: find it again
      step("Restarting into the install");
      await w.close();
      w = await Wedgie.reopen(sent);
      const h2 = await w.request({ type: "hello" }, 1500).catch(() => null);
      if (!h2?.job) throw new Error("The wedgie restarted without the install (Y on its screen?).");
      bin = h2.bin;
    } else if (go.type === "refused") throw new Error("You said no on the wedgie.");
    else if (go.type === "busy") throw new Error("The wedgie is busy signing. Try again after.");
    else if (go.type !== "go") throw new Error(`The wedgie said ${go.error || go.type}.`);

    let got = await files.catch(async e => {
      await w.request({ type: "abort" }, 5000).catch(() => {});
      throw e;
    });
    step("Checking wedgie.dev's signature", 0);
    const a = await w.request({ type: "release", release: rel[0], sig: rel[1].trim() }, 60_000);
    if (a?.type !== "ok") throw new Error(`The wedgie stopped: ${a?.error || a?.type}`);
    const s = await w.request({ type: "sums", names: write }, 30_000);
    if (s?.type !== "sums") throw new Error(`The wedgie stopped: ${s?.error || s?.type}`);
    got = got.filter(({ n }) => s.sums[n] !== info(n).sha256);
    const total = got.reduce((t, f) => t + f.buf.length, 0) || 1;
    const size = bin ? Math.min(bin, 4096) : 1024;
    let done = 0;
    for (const { n, buf } of got)
      for (let o = 0; o < Math.max(buf.length, 1); o += size) {
        const part = buf.subarray(o, o + size);
        const end = o + size >= buf.length;
        const r = bin ? await w.requestRaw({ type: "put", name: n, end }, part) : await w.request({ type: "put", name: n, data: b64(part), end }, 15_000);
        if (r?.type !== "ok") throw new Error(`The wedgie stopped: ${r?.error || r?.type}`);
        done += part.length;
        step("Installing", done / total);
      }
    const d = await w.request({ type: "commit" }, 30_000);
    if (d?.type !== "done") throw new Error(`The wedgie stopped: ${d?.error || d?.type}`);
    step("Done. The wedgie is restarting", 1);
  } finally {
    await w.close();
  }
}
