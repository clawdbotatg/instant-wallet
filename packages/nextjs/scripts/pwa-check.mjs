#!/usr/bin/env node
/**
 * Lighthouse-style PWA checks against a PRODUCTION server (the service worker only registers in
 * production builds): `yarn build && yarn serve -p 3100 && APP_URL=http://localhost:3100 yarn check:pwa`.
 *
 *   - /manifest.json is 200, has name/short_name/start_url/display/theme/background/icons
 *   - every declared icon exists and its PNG header matches the declared size (+ apple-touch-icon 180)
 *   - the page links the manifest, apple-touch-icon and apple-mobile-web-app-capable
 *   - a headless Chrome load of "/" registers the service worker at scope "/" with no console errors
 *   - /api/* responses are not served from the SW cache (Cache-Control / no cache entry)
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = process.env.APP_URL || "http://localhost:3100";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) failures++;
};

function pngSize(buf) {
  if (buf.length < 24 || buf.toString("ascii", 1, 4) !== "PNG") return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---------------------------------------------------------------- manifest + icons
const mres = await fetch(`${BASE}/manifest.json`);
check("GET /manifest.json -> 200", mres.status === 200, String(mres.status));
const manifest = await mres.json().catch(() => ({}));
check("manifest name/short_name", manifest.name === "Instant Wallet" && manifest.short_name === "Instant");
check("manifest start_url '/' display standalone", manifest.start_url === "/" && manifest.display === "standalone");
check("manifest theme/background #f4f4f1", manifest.theme_color === "#f4f4f1" && manifest.background_color === "#f4f4f1");
const icons = manifest.icons ?? [];
check("manifest has 192 + 512 icons, any + maskable", ["192x192", "512x512"].every(s => icons.some(i => i.sizes === s && i.purpose === "any") && icons.some(i => i.sizes === s && i.purpose === "maskable")));
for (const icon of icons) {
  const res = await fetch(`${BASE}${icon.src}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const size = pngSize(buf);
  const [w, h] = icon.sizes.split("x").map(Number);
  check(`icon ${icon.src} is ${icon.sizes} PNG (${icon.purpose})`, res.status === 200 && size && size.w === w && size.h === h, size ? `${size.w}x${size.h}` : String(res.status));
}
{
  const res = await fetch(`${BASE}/icons/apple-touch-icon.png`);
  const size = pngSize(Buffer.from(await res.arrayBuffer()));
  check("apple-touch-icon.png is 180x180", res.status === 200 && size?.w === 180 && size?.h === 180);
}
{
  const html = await (await fetch(`${BASE}/`)).text();
  check('<link rel="manifest" href="/manifest.json">', /rel="manifest"[^>]*href="\/manifest\.json"|href="\/manifest\.json"[^>]*rel="manifest"/.test(html));
  check('<link rel="apple-touch-icon">', /rel="apple-touch-icon"/.test(html));
  check('<meta name="apple-mobile-web-app-capable" content="yes">', /name="apple-mobile-web-app-capable" content="yes"/.test(html));
  check('<meta name="apple-mobile-web-app-title">', /name="apple-mobile-web-app-title"/.test(html));
  check("theme-color meta", /name="theme-color" content="#f4f4f1"/.test(html));
  const sw = await fetch(`${BASE}/sw.js`);
  check("GET /sw.js -> 200 javascript", sw.status === 200 && /javascript/.test(sw.headers.get("content-type") || ""));
}

// ---------------------------------------------------------------- headless chrome: sw registers, no errors
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--remote-debugging-port=0", "--no-first-run", "--user-data-dir=" + join(tmpdir(), `iw-pwa-${Date.now()}`), "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  chrome.stderr.on("data", d => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error("chrome did not start\n" + buf)), 15000);
});
const httpBase = wsUrl.replace(/^ws:\/\/([^/]+).*/, "http://$1");
const target = await (await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  } else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text);
  else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") errors.push(msg.params.args.map(a => a.value ?? a.description).join(" "));
  else if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") errors.push(msg.params.entry.text);
};
const send = (method, params = {}) => new Promise((resolve, reject) => (pending.set(++id, { resolve, reject }), ws.send(JSON.stringify({ id, method, params }))));
await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Page.navigate", { url: `${BASE}/` });
const reg = await send("Runtime.evaluate", {
  awaitPromise: true,
  returnByValue: true,
  expression: `(async () => {
    const ready = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("sw not ready in 15s")), 15000))]);
    // give the SW a moment to precache, then check the API is never cached
    await new Promise(r => setTimeout(r, 1500));
    const keys = await caches.keys();
    const cache = keys.length ? await caches.open(keys[0]) : null;
    const cachedShell = cache ? !!(await cache.match("/")) : false;
    await fetch("/api/device");
    const cachedApi = cache ? !!(await cache.match("/api/device")) : false;
    return { scope: ready.scope, active: !!ready.active, caches: keys, cachedShell, cachedApi };
  })()`,
});
const v = reg.result?.value ?? {};
check("service worker registered at scope '/'", v.active === true && typeof v.scope === "string" && new URL(v.scope).pathname === "/", JSON.stringify(v));
check("shell '/' precached", v.cachedShell === true, JSON.stringify(v.caches));
check("/api/* never cached", v.cachedApi === false);
check("no console errors on load", errors.length === 0, errors.join(" | ").slice(0, 300));
ws.close();

// ---------------------------------------------------------------- iOS Safari: "Add to Home Screen" hint
{
  const t2 = await (await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" })).json();
  const ws2 = new WebSocket(t2.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws2.onopen = r), (ws2.onerror = j)));
  const pend = new Map();
  let n = 0;
  ws2.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pend.has(msg.id)) {
      const { resolve, reject } = pend.get(msg.id);
      pend.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send2 = (method, params = {}) => new Promise((resolve, reject) => (pend.set(++n, { resolve, reject }), ws2.send(JSON.stringify({ id: n, method, params }))));
  await send2("Page.enable");
  await send2("Runtime.enable");
  await send2("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  await send2("Page.navigate", { url: `${BASE}/` });
  const hint = await send2("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      await new Promise(r => setTimeout(r, 2500));
      const shown = document.body.innerText.includes("Add to Home Screen");
      document.querySelector('button[aria-label="Dismiss"]')?.click();
      await new Promise(r => setTimeout(r, 300));
      const afterDismiss = document.body.innerText.includes("Add to Home Screen");
      return { shown, afterDismiss, remembered: !!localStorage.getItem("iw.a2hs.dismissed") };
    })()`,
  });
  const h = hint.result?.value ?? {};
  check("iOS Safari (not standalone) shows the Add to Home Screen hint", h.shown === true, JSON.stringify(h));
  check("hint dismiss hides it and is remembered in localStorage", h.afterDismiss === false && h.remembered === true);
  ws2.close();
}
chrome.kill();
console.log(failures ? `\n${failures} PWA check(s) FAILED` : "\nPWA checks passed");
process.exit(failures ? 1 : 0);
