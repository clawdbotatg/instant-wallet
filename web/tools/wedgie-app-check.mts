// The app's wedgie code (lib/safe/wedgie.ts) against the real wedgie Safe app (clawdbotatg/wedgie-safe's safe.py)
// run on MicroPython: a small batch, and one over the 6 KB USB line (sent in pieces). Checks the wedgie hashes
// exactly what the app expects. Needs `micropython` (brew install micropython) and a wedgie-safe checkout:
//   WEDGIE_SAFE=~/src/wedgie-safe npx tsx tools/wedgie-app-check.mts
import { spawn } from "node:child_process";
import type { Address, Hex } from "viem";
import { batch, multiSendData, safeTxHash, transfer } from "../lib/safe/core";
import { Wedgie } from "../lib/safe/wedgie";

const dir = process.env.WEDGIE_SAFE;
if (!dir) throw new Error("WEDGIE_SAFE=<a clawdbotatg/wedgie-safe checkout>");
const mp = spawn("micropython", [new URL("./wedgie/serve.py", import.meta.url).pathname, dir], { stdio: ["pipe", "pipe", "pipe"] });
let shown = "";
mp.stderr.on("data", d => (shown += d));

// a Web Serial port whose other end is the MicroPython process
const port = {
  getInfo: () => ({ usbVendorId: 0x2e8a }),
  readable: null as any,
  writable: null as any,
  async open() {
    this.readable = new ReadableStream({ start: c => mp.stdout.on("data", d => c.enqueue(new Uint8Array(d))) });
    this.writable = new WritableStream({ write: c => void mp.stdin.write(Buffer.from(c)) });
  },
  async close() {},
};
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serial: { getPorts: async () => [port], requestPort: async () => port } } });
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = { getItem: () => null, setItem() {} };

let fails = 0;
const ok = (c: boolean, what: string) => (console.log(`${c ? "PASS" : "FAIL"} ${what}`), c || fails++);
const safe = "0xD977a783Dc079932Fe100E992C0c995b1967a953" as Address;
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const slots: [Address, Address] = ["0x000000000000000000000000000000000000dEaD", "0x000000000000000000000000000000000000bEEF"];
const w = await Wedgie.connect();
for (const [name, calls] of [
  ["a small batch (send + fee)", [transfer(usdc, "0x000000000000000000000000000000000000c0Fe", 5_000_000n), transfer(usdc, slots[0], 5000n)]],
  // a stand-in for a bridge swap: 4 KB of calldata to the LI.FI diamond, naming this Safe
  ["a 4 KB batch, sent in pieces", [{ to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address, value: 0n, data: ("0x1794958f" + safe.slice(2).toLowerCase().padStart(64, "0") + "ab".repeat(4000)) as Hex }, transfer(usdc, slots[0], 5000n)]],
] as const) {
  const t = batch([...calls], 7n);
  const h = safeTxHash(8453, safe, t);
  shown = "";
  try {
    const sigs = await w.sign(8453, safe, t, h, slots);
    ok(sigs.length === 2, `${name}: the wedgie hashed what the app expects (${h.slice(0, 10)}…)`);
  } catch (e: any) {
    ok(false, `${name}: ${e.message}`);
  }
  console.log(shown.trimEnd().replace(/^/gm, "    "));
}
await w.close();
mp.kill();

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
