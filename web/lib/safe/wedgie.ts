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
 */
const RPI_VID = 0x2e8a;
export const wedgieSupported = () => typeof navigator !== "undefined" && "serial" in navigator;

type Pending = { res: (v: any) => void; rej: (e: Error) => void; t: number };

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
    const w = new Wedgie();
    w.port = port;
    await port.open({ baudRate: 115200 });
    w.writer = port.writable.getWriter();
    w.reader = port.readable.getReader();
    w.read();
    return w;
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
    if (JSON.stringify(tx).length > 6000) throw new Error("Too big for the wedgie to show (6 KB max). Split it up.");
    const g = await this.request({ type: "safe_sign", tx }, 200_000);
    if (g?.type === "refused") throw new Error("Refused on the wedgie.");
    if (g?.type !== "safe_sig") throw new Error("The wedgie said something unexpected.");
    if (String(g.safeTxHash).toLowerCase() !== expectHash.toLowerCase()) throw new Error("The wedgie signed a different transaction. Not sending.");
    const data = encodeWebAuthn({ authenticatorData: g.authenticatorData, clientDataFields: g.clientDataFields, r: BigInt(g.r), s: BigInt(g.s) });
    return slots.map(signer => ({ signer, data, kind: "contract" as const }));
  }

  async close() {
    try {
      await this.reader?.cancel();
      this.writer?.releaseLock();
      await this.port?.close();
    } catch {}
  }
}
