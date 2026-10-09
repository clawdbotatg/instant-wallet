import { type Address, type Hex, getAddress } from "viem";
import { type SafeTx, type Sig, encodeWebAuthn } from "./core";

/**
 * The wedgie over Web Serial (Chrome / Edge on a computer), running the Safe signer app (clawdbotatg/wedgie-safe).
 * Protocol (docs/WEDGIE-SAFE.md): one JSON line each way.
 *   {"id":1,"type":"hello"}                               -> {"type":"hello", ..., "safe": {"x","y"} | null}
 *   {"id":2,"type":"safe_sign","tx":{chainId, safe, to, value, data, operation, safeTxGas, baseGas, gasPrice,
 *    gasToken, refundReceiver, nonce}}                     -> {"type":"safe_sig", safeTxHash, x, y, r, s,
 *                                                             authenticatorData, clientDataFields} | {"type":"refused"}
 * The wedgie computes the hash itself, shows the transaction, and signs only on a real A press.
 * A USB line is at most 6 KB: a bigger tx (a bridge swap) sends its data ahead in pieces, if the app says it takes
 * them (hello's safe_chunk, wedgie-safe b4e86f8+):
 *   {"type":"safe_data","at":<bytes so far>,"hex":"..."} -> {"type":"safe_data","have":n}, then safe_sign with data "@".
 */
const RPI_VID = 0x2e8a;
export const wedgieSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

type Pending = { res: (v: any) => void; rej: (e: Error) => void; t: number };

// One user of the port at a time: a status peek (WedgieButton) never opens it while a signing connection holds
// it, and a connect waits for a peek in flight to close it.
let holder: Wedgie | null = null;
let peeking: Promise<unknown> | null = null;

// On a Mac, Chrome's first look for serial ports (getPorts included) also looks for Bluetooth ones and macOS
// asks "Chrome would like to use Bluetooth". So nothing peeks until this browser has asked for a wedgie once.
const ARMED = "iws.wedgie-armed";
export const wedgieArmed = () => {
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
export type WedgieHello = { version?: string; short?: string; running?: string | null; carts?: { mod: string; v?: string | null }[]; safe?: { x: Hex; y: Hex } | null; safe_chunk?: number };
const LINE_MAX = 5800; // the wedgie's USB line is 6 KB
export type Peek =
  | { kind: "none" } // no wedgie this browser was allowed to see is plugged in
  | { kind: "busy" } // a signing connection has it open right now
  | { kind: "taken" } // plugged in, but something else has the port open (a wedgie.dev tab, Thonny)
  | { kind: "silent"; error: string } // plugged in, but it didn't answer (still booting, or not running wedgie firmware)
  | { kind: "hello"; hello: WedgieHello };

export class Wedgie {
  private port: any;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private line = "";
  alive = true;
  private next = 100;
  private pending = new Map<number, Pending>();

  static async connect(): Promise<Wedgie> {
    if (!wedgieSupported()) throw new Error("This browser can't talk to a wedgie. Use Chrome or Edge on a computer.");
    const serial = (navigator as any).serial;
    const known = (await serial.getPorts()).filter((p: any) => p.getInfo().usbVendorId === RPI_VID);
    const port = known[0] ?? (await serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] }));
    arm();
    await peeking?.catch(() => {});
    if (holder) throw new Error("The wedgie is busy with another transaction.");
    const w = new Wedgie();
    w.port = port;
    await port.open({ baudRate: 115200 });
    w.writer = port.writable.getWriter();
    w.reader = port.readable.getReader();
    w.read();
    holder = w;
    return w;
  }

  /** Let this browser see a wedgie (the port picker; needs a tap). False if the person cancelled. */
  static async pick(): Promise<boolean> {
    if (!wedgieSupported()) return false;
    try {
      await (navigator as any).serial.requestPort({ filters: [{ usbVendorId: RPI_VID }] });
      arm();
      return true;
    } catch {
      return false;
    }
  }

  /** Is a wedgie plugged in, and what is it running? Opens the port for a hello and closes it again. */
  static async peek(): Promise<Peek> {
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
        if (/failed to open|busy|access denied|already open/i.test(e?.message || "")) return { kind: "taken" };
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

  /** Plugged in / unplugged (only for wedgies this browser may see). Returns the unsubscribe. */
  static watch(fn: () => void): () => void {
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
    if (!wedgieSupported()) return;
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

  async key(): Promise<{ x: Hex; y: Hex }> {
    const h = await this.request({ type: "hello" }, 5000);
    if (!h?.safe) throw new Error("The wedgie has no Safe key yet: press A on it to make one, then try again.");
    return { x: h.safe.x, y: h.safe.y };
  }

  /** One A press signs `t`; returns the signature for both of the wedgie's owner slots. */
  async sign(chainId: number, safe: Address, t: SafeTx, expectHash: Hex, slots: [Address, Address]): Promise<Sig[]> {
    const tx = {
      chainId,
      safe: getAddress(safe),
      to: getAddress(t.to),
      value: t.value.toString(),
      data: t.data,
      operation: t.operation,
      safeTxGas: 0,
      baseGas: 0,
      gasPrice: 0,
      gasToken: "0x0000000000000000000000000000000000000000",
      refundReceiver: "0x0000000000000000000000000000000000000000",
      nonce: Number(t.nonce),
    };
    let send: Record<string, unknown> = tx;
    if (JSON.stringify({ id: 0, type: "safe_sign", tx }).length > LINE_MAX) {
      const chunk = (await this.request({ type: "hello" }, 5000))?.safe_chunk;
      if (!chunk) throw new Error("This one is too big for the wedgie's Safe app. Update it at wedgie.dev, then try again.");
      const hex = t.data.slice(2);
      let at = 0;
      for (let i = 0; i < hex.length; i += chunk) {
        const r = await this.request({ type: "safe_data", at, hex: hex.slice(i, i + chunk) }, 10_000);
        if (r?.type !== "safe_data") throw new Error(`The wedgie didn't take the transaction (${r?.error || "no answer"}).`);
        at = r.have;
      }
      send = { ...tx, data: "@" };
    }
    const g = await this.request({ type: "safe_sign", tx: send }, 300_000); // a big one takes the wedgie a while to hash
    if (g?.type === "refused") throw new Error("Refused on the wedgie.");
    if (g?.type !== "safe_sig") throw new Error("The wedgie said something unexpected.");
    if (String(g.safeTxHash).toLowerCase() !== expectHash.toLowerCase()) throw new Error("The wedgie signed a different transaction. Not sending.");
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

/** Put the Safe signer on the plugged-in wedgie. step: what to say ("Press A on the wedgie", "Installing", p 0..1). */
export async function installSafeApp(step: (what: string, p?: number) => void): Promise<void> {
  let w = await Wedgie.connect();
  try {
    const h = await w.request({ type: "hello" }, 2500).catch(() => null);
    if (!h) throw new Error("The wedgie didn't answer. Unplug it, hold X while you plug it back in, then try again.");
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

    step("Press A on the wedgie to install");
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
