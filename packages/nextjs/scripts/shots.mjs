#!/usr/bin/env node
/**
 * Screenshot the main pages at phone (390x844, mobile emulation) and desktop (1440x900) widths
 * with headless Chrome over the DevTools protocol (no dependencies: Node's WebSocket + fetch).
 * Chrome's window can't go below ~500px wide, so the phone size needs device emulation.
 *
 * Usage: node scripts/shots.mjs [wallet]   (dev server on APP_URL || http://localhost:3000)
 * Output: shots/<page>-<width>.png  + a list of console errors / uncaught exceptions per page.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.env.APP_URL || "http://localhost:3000";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "shots");
mkdirSync(OUT, { recursive: true });

const wallet = process.argv[2];
const pages = [
  ["welcome", "/"],
  ["settings", "/settings"],
  ...(wallet
    ? [
        ["home", `/w/${wallet}`],
        ["send", `/w/${wallet}/send`],
        ["receive", `/w/${wallet}/receive`],
        ["activity", `/w/${wallet}/activity`],
        ["keys", `/w/${wallet}/keys`],
        ["keys-add", `/w/${wallet}/keys/add`],
        ["chat", `/w/${wallet}/chat`],
        ["send-confirm", `/w/${wallet}/send`, "confirm"],
      ]
    : []),
];
const sizes = [
  { w: 390, h: 844, mobile: true, dsf: 2, ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" },
  { w: 1440, h: 900, mobile: false, dsf: 1 },
];

// ---------------------------------------------------------------- launch chrome
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--remote-debugging-port=0", "--no-first-run", "--user-data-dir=" + join(OUT, ".chrome-profile"), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", d => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) resolve(m[1]);
  });
  chrome.on("exit", c => reject(new Error(`chrome exited ${c}\n${buf}`)));
  setTimeout(() => reject(new Error("chrome did not start\n" + buf)), 15000);
});
const httpBase = wsUrl.replace(/^ws:\/\/([^/]+).*/, "http://$1");

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn]);
  }
}
async function newPage() {
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" });
  const target = await res.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return { cdp: new Cdp(ws), id: target.id, ws };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Local chain: make sure the wallet can afford the $20 quick amount in the confirm scenario.
if (wallet) await fetch(`${BASE}/api/fund`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ wallet, amount: "100" }) }).catch(() => {});

const report = [];
for (const size of sizes) {
  for (const [name, path, scenario] of pages) {
    const { cdp, id, ws } = await newPage();
    const errors = [];
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    cdp.on("Runtime.exceptionThrown", p => errors.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`.slice(0, 300)));
    cdp.on("Runtime.consoleAPICalled", p => {
      if (p.type === "error") errors.push(`console.error: ${p.args.map(a => a.value ?? a.description ?? "").join(" ")}`.slice(0, 300));
    });
    cdp.on("Log.entryAdded", p => {
      if (p.entry.level === "error" && !/favicon/.test(p.entry.text)) errors.push(`log: ${p.entry.text}`.slice(0, 300));
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: size.w, height: size.h, deviceScaleFactor: size.dsf, mobile: size.mobile });
    if (size.ua) await cdp.send("Emulation.setUserAgentOverride", { userAgent: size.ua });
    if (size.mobile) await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    const loaded = new Promise(r => cdp.on("Page.loadEventFired", r));
    await cdp.send("Page.navigate", { url: BASE + path });
    await Promise.race([loaded, sleep(15000)]);
    await sleep(2500); // let the client fetch /api/wallet and paint
    if (scenario === "confirm") {
      // Fill the send form through React's own setters, tap $20, then the confirm button -> device sheet.
      await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        expression: `(async () => {
          const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
          const to = document.querySelector('input[placeholder="Address or ENS name"]');
          set(to, "0x000000000000000000000000000000000000dEaD");
          [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "20")?.click();
          await new Promise(r => setTimeout(r, 400));
          [...document.querySelectorAll("button")].find(b => /Confirm on device|Send with/.test(b.textContent))?.click();
          await new Promise(r => setTimeout(r, 1800));
        })()`,
      });
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = join(OUT, `${name}-${size.w}.png`);
    writeFileSync(file, Buffer.from(shot.data, "base64"));
    if (scenario === "confirm") {
      // cancel -> rejects the queued request so the e2e wallet's queue stays clean
      await cdp.send("Runtime.evaluate", { expression: `[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Cancel")?.click()` });
      await sleep(500);
    }
    report.push({ page: `${name}-${size.w}`, errors });
    console.log(`${errors.length ? "  !!  " : "  ok  "} ${name}-${size.w}.png${errors.length ? `  (${errors.length} error(s))` : ""}`);
    for (const e of errors) console.log(`        ${e}`);
    ws.close();
    await fetch(`${httpBase}/json/close/${id}`).catch(() => {});
  }
}
chrome.kill();
const bad = report.filter(r => r.errors.length);
console.log(bad.length ? `\n${bad.length} page(s) logged errors` : "\nno console errors on any page");
process.exit(0);
