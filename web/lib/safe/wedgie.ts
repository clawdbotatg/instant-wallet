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
export type WedgieHello = { version?: string; short?: string; running?: string | null; safe?: { x: Hex; y: Hex } | null; safe_chunk?: number };
const LINE_MAX = 5800; // the wedgie's USB line is 6 KB
export type Peek =
  | { kind: "none" } // no wedgie this browser was allowed to see is plugged in
  | { kind: "busy" } // a signing connection has it open right now
  | { kind: "silent"; error: string } // plugged in, but it didn't answer (still booting, or not running wedgie firmware)
  | { kind: "hello"; hello: WedgieHello };

export class Wedgie {
  private port: any;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private line = "";
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
        return { kind: "silent", error: `Couldn't open it (${e?.message || "in use by another tab?"})` };
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
