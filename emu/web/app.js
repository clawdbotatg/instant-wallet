// The page: editor + console on the left, the device on the right, a Worker running MicroPython,
// and a control channel (SSE) so tools/emu can drive everything from a terminal.
import { createDevice3D } from "/web/device3d.js";

const KEY_ORDER = ["A", "B", "X", "Y", "up", "down", "left", "right", "press"];
// keyboard -> device. Joystick: W A S D + space. Buttons: numpad 9 6 3 . (top row 9 6 3 . works too).
const KEYMAP = { w: "up", a: "left", s: "down", d: "right", " ": "press", 9: "A", 6: "B", 3: "X", ".": "Y" };
const CODEMAP = { Numpad9: "A", Numpad6: "B", Numpad3: "X", NumpadDecimal: "Y", Space: "press" };
const keyOf = (e) => CODEMAP[e.code] || KEYMAP[e.key] || KEYMAP[e.key.toLowerCase()];
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sab = typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated ? new SharedArrayBuffer(16 * 4) : null;
const keys = new Int32Array(sab || new ArrayBuffer(16 * 4));
const screen = $("#screen"), sctx = screen.getContext("2d");
const flatscreen = $("#flatscreen"), fctx = flatscreen.getContext("2d");
const img = sctx.createImageData(240, 240);

let worker = null, seq = 0, running = null, main = localStorage.getItem("emu.main") || "mock";
const files = new Map();          // name -> { src, text?, b64?, dirty }
let current = null, editor = null, editorFallback = null;
const log = [];
let execCapture = null;
const waiting = new Map();
let frames = 0, fpsCount = 0, fps = 0;
let device3d = null;

// ---- editor ------------------------------------------------------------------------------
if (window.CodeMirror) {
  editor = CodeMirror.fromTextArea($("#src"), {
    mode: "python", lineNumbers: true, indentUnit: 4, tabSize: 4, indentWithTabs: false, viewportMargin: 50,
    extraKeys: { "Cmd-Enter": runCurrent, "Ctrl-Enter": runCurrent, "Cmd-S": saveAll, "Ctrl-S": saveAll,
      Tab: (cm) => cm.somethingSelected() ? cm.indentSelection("add") : cm.replaceSelection("    ", "end") },
  });
  editor.on("change", () => { if (current && files.get(current)) { const f = files.get(current); f.text = editor.getValue(); f.dirty = true; renderTabs(); } });
} else {
  editorFallback = $("#src");
  editorFallback.addEventListener("input", () => { const f = files.get(current); if (f) { f.text = editorFallback.value; f.dirty = true; renderTabs(); } });
  editorFallback.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runCurrent(); } });
}
const getSrc = () => (editor ? editor.getValue() : editorFallback.value);
const setSrc = (t) => { if (editor) { editor.setValue(t); editor.clearHistory(); } else editorFallback.value = t; };

function openFile(name) {
  const f = files.get(name);
  if (!f) return;
  current = name;
  setSrc(f.text !== undefined ? f.text : `# ${name}: binary, ${Math.round(atob(f.b64).length / 1024)} KB`);
  if (editor) editor.setOption("readOnly", f.text === undefined ? "nocursor" : false);
  renderTabs();
}

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  const order = [...files.values()].sort((a, b) => (a.src === b.src ? a.name.localeCompare(b.name) : a.src === "sketches" ? -1 : 1));
  for (const f of order) {
    const b = document.createElement("button");
    b.textContent = f.name;
    b.className = (f.name === current ? "on " : "") + (f.dirty ? "dirty" : "");
    b.innerHTML += `<span class="src">${f.src === "sketches" ? "sketch" : "fw"}</span>`;
    b.onclick = () => openFile(f.name);
    tabs.appendChild(b);
    if (f.name === current) b.scrollIntoView({ inline: "nearest", block: "nearest" });
  }
  const sel = $("#main");
  sel.innerHTML = "";
  for (const f of order) if (f.name.endsWith(".py")) { const o = document.createElement("option"); o.value = f.name.slice(0, -3); o.textContent = f.name.slice(0, -3); sel.appendChild(o); }
  sel.value = main;
}

async function saveFile(name) {
  const f = files.get(name);
  if (!f || f.text === undefined) return;
  await fetch("/ctl/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, content: f.text, src: f.src }) });
  f.dirty = false;
  if (worker) await ask({ type: "write", name, data: f.text });
  renderTabs();
}
async function saveAll() { for (const [n, f] of files) if (f.dirty) await saveFile(n); }

$("#newfile").onclick = async () => {
  let name = prompt("new sketch name (module name, no spaces)", "sketch");
  if (!name) return;
  name = name.replace(/\.py$/, "").replace(/[^\w-]/g, "_") + ".py";
  if (!files.has(name)) files.set(name, { name, src: "sketches", text: TEMPLATE.replace(/NAME/g, name.slice(0, -3)), dirty: true });
  openFile(name);
  await saveFile(name);
};

const TEMPLATE = `# NAME: a sketch for the Pico wallet. Run: tools/emu run NAME
import time
from machine import Timer
from lcd import LCD, Keys, color, BLACK, WHITE, GREEN, RED, YELLOW, GREY

lcd = LCD()
keys = Keys()
timer = None
x, y, dx, dy = 100, 100, 3, 2


def draw():
    lcd.fill(BLACK)
    lcd.fill_rect(x, y, 40, 40, GREEN)
    lcd.center_text("NAME", 8, YELLOW, 2)
    lcd.center_text("X quits", 224, GREY)
    lcd.show()


def tick(_):
    global x, y, dx, dy
    for k in keys.pressed():          # names: A B X Y up down left right press
        if k == "X":
            stop(); return
    x += dx; y += dy
    if x < 0 or x > 200: dx = -dx
    if y < 20 or y > 200: dy = -dy
    draw()


def start():
    global timer
    draw()
    timer = Timer(period=40, mode=Timer.PERIODIC, callback=tick)


def stop():
    if timer:
        timer.deinit()


start()
`;

// ---- console -------------------------------------------------------------------------------
function appendLog(line, cls) {
  log.push(line);
  if (log.length > 2000) log.shift();
  const d = document.createElement("div");
  if (cls) d.className = cls; else if (/^(Traceback|  File |\w+Error:)/.test(line)) d.className = "err";
  d.textContent = line;
  const el = $("#log");
  el.appendChild(d);
  while (el.childElementCount > 600) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
  if (execCapture) execCapture.push(line);
}
const hist = []; let hi = 0;
$("#repl").addEventListener("keydown", async (e) => {
  const inp = e.target;
  if (e.key === "Enter" && inp.value.trim()) {
    const code = inp.value; inp.value = ""; hist.push(code); hi = hist.length;
    appendLog(">>> " + code, "in");
    await exec(code);
  } else if (e.key === "ArrowUp") { if (hi > 0) inp.value = hist[--hi]; e.preventDefault(); }
  else if (e.key === "ArrowDown") { inp.value = hi < hist.length - 1 ? hist[++hi] : (hi = hist.length, ""); e.preventDefault(); }
});

// ---- device ------------------------------------------------------------------------------
function ask(msg) {
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }); });
}

async function exec(code) {
  if (!worker) return ["device is not running"];
  execCapture = [];
  try { await ask({ type: "exec", code }); } catch (e) { appendLog(String(e), "err"); }
  const out = execCapture; execCapture = null;
  return out;
}

async function reboot(runName) {
  if (worker) { worker.terminate(); worker = null; for (const w of waiting.values()) w.reject(new Error("rebooted")); waiting.clear(); }
  for (const i of KEY_ORDER.keys()) keys[i] = 0;
  setConn("booting", "");
  const b = await (await fetch("/ctl/boot")).json();
  mark("boot payload");
  for (const f of b.files) {
    const old = files.get(f.name);
    if (old && old.dirty) continue;
    files.set(f.name, { ...f, dirty: false });
  }
  for (const n of [...files.keys()]) if (!b.files.some((f) => f.name === n) && !files.get(n).dirty) files.delete(n);
  if (!current || !files.has(current)) openFile(files.has(runName + ".py") ? runName + ".py" : [...files.keys()][0]);
  else { const f = files.get(current); if (!f.dirty && f.text !== undefined && f.text !== getSrc()) setSrc(f.text); }
  renderTabs();
  const payload = b.files.map((f) => { const cur = files.get(f.name); return cur && cur.text !== undefined ? { name: f.name, text: cur.text } : f; });
  worker = new Worker("/web/worker.js", { type: "module" });
  worker.onmessage = onMsg;
  worker.onerror = (e) => appendLog("worker: " + e.message, "err");
  mark("worker created");
  appendLog(`── boot, import ${runName} ──`, "sys");
  frames = 0;
  execCapture = [];
  try { await ask({ type: "boot", keys: sab || keys.buffer, files: payload, shims: b.shims, appUrl: b.appUrl, run: runName }); } catch (e) { appendLog(String(e), "err"); }
  const out = execCapture; execCapture = null;
  running = runName;
  const failed = out.some((l) => /^Traceback/.test(l));
  setConn(failed ? "error in " + runName : "running " + runName, failed ? "bad" : "ok");
  return { ok: !failed, lines: out };
}

function onMsg(e) {
  const m = e.data;
  if (m.type === "frame") {
    const b = new Uint8Array(m.buf), d = img.data;
    for (let i = 0, o = 0; i < b.length; i += 2, o += 4) {
      const c = (b[i] << 8) | b[i + 1];
      d[o] = (c >> 8) & 0xf8; d[o + 1] = (c >> 3) & 0xfc; d[o + 2] = (c << 3) & 0xf8; d[o + 3] = 255;
    }
    sctx.putImageData(img, 0, 0);
    fctx.putImageData(img, 0, 0);
    frames = m.frames; fpsCount++;
    if (device3d) device3d.updateScreen();
  } else if (m.type === "out") appendLog(m.line);
  else if (m.type === "mark") console.log(m.text);
  else if (m.type === "pwm") { if (m.pin === 13 && device3d) device3d.setBacklight(m.frac); }
  else if (m.type === "pin") { if (m.pin === "LED" && device3d) device3d.setLed(!!m.v); }
  else if (m.type === "reset") { appendLog("machine.reset()", "sys"); reboot(main); }
  else if (m.type === "done") { const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(new Error(m.error)) : w.resolve(); } }
}

function setConn(text, cls) { const c = $("#conn"); c.textContent = text; c.className = cls; }
setInterval(() => { fps = fpsCount; fpsCount = 0; $("#fps").textContent = fps + " fps"; $("#frames").textContent = frames + " frames"; }, 1000);

async function runCurrent() {
  await saveAll();
  const name = current && current.endsWith(".py") ? current.slice(0, -3) : main;
  await reboot(name);
}
$("#run").onclick = runCurrent;
$("#reset").onclick = () => reboot(main);
$("#main").onchange = (e) => { main = e.target.value; localStorage.setItem("emu.main", main); reboot(main); };
$("#shot").onclick = () => { const a = document.createElement("a"); a.href = shotDataURL(); a.download = `pico-${Date.now()}.png`; a.click(); };
function shotDataURL() {
  const c = document.createElement("canvas"); c.width = c.height = 480;
  const g = c.getContext("2d"); g.imageSmoothingEnabled = false; g.drawImage(screen, 0, 0, 480, 480);
  return c.toDataURL("image/png");
}

// ---- keys --------------------------------------------------------------------------------
function setKey(name, down) {
  const i = KEY_ORDER.indexOf(name);
  if (i < 0) return;
  if (sab) Atomics.store(keys, i, down ? 1 : 0);
  else { keys[i] = down ? 1 : 0; if (worker) worker.postMessage({ type: "keys", state: Array.from(keys) }); }
  if (device3d) device3d.setKey(name, down);
  for (const b of document.querySelectorAll(`#flat [data-key="${name}"]`)) b.classList.toggle("down", down);
}
const isTyping = (t) => t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest?.(".CodeMirror"));
window.addEventListener("keydown", (e) => {
  if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = keyOf(e);
  if (!k) return;
  e.preventDefault();
  if (!e.repeat) setKey(k, true);
});
window.addEventListener("keyup", (e) => { const k = keyOf(e); if (k) setKey(k, false); });
window.addEventListener("blur", () => { for (const k of KEY_ORDER) setKey(k, false); });
for (const b of document.querySelectorAll("#flat [data-key]")) {
  const k = b.dataset.key;
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); setKey(k, true); $("#right").focus({ preventScroll: true }); });
  b.addEventListener("pointerup", () => setKey(k, false));
  b.addEventListener("pointerleave", () => setKey(k, false));
}
$("#stage").addEventListener("pointerdown", () => $("#right").focus({ preventScroll: true }));

// ---- views -------------------------------------------------------------------------------
function setView(v) {
  localStorage.setItem("emu.view", v);
  $("#stage").hidden = v !== "3d"; $("#flat").hidden = v !== "flat";
  $("#view3d").classList.toggle("on", v === "3d"); $("#viewflat").classList.toggle("on", v === "flat");
  if (device3d) device3d.resize();
}
$("#view3d").onclick = () => setView("3d");
$("#viewflat").onclick = () => setView("flat");

// ---- control channel for tools/emu -------------------------------------------------------
const handlers = {
  async run({ name }) { const r = await reboot(name); if (files.has(name + ".py")) openFile(name + ".py"); return r; },
  async exec({ code }) { appendLog(">>> " + code, "in"); return { ok: true, lines: await exec(code) }; },
  async key({ name, ms }) { setKey(name, true); await sleep(ms || 80); setKey(name, false); await sleep(60); return { ok: true }; },
  async keys({ names }) { for (const n of names) { const [k, ms] = n.split(":"); setKey(k, true); await sleep(+(ms || 80)); setKey(k, false); await sleep(120); } return { ok: true }; },
  async shot() { return { ok: true, png: shotDataURL() }; },
  async log({ n }) { return { ok: true, lines: log.slice(-(n || 40)) }; },
  async state() { return { ok: true, main, running, frames, fps, sharedKeys: !!sab, view: localStorage.getItem("emu.view") || "3d", files: [...files.keys()] }; },
  async reset() { return reboot(main); },
  async main({ name }) { main = name; localStorage.setItem("emu.main", main); renderTabs(); return { ok: true }; },
};
const es = new EventSource("/ctl/events");
es.onmessage = async (e) => {
  const c = JSON.parse(e.data);
  let result;
  try { result = handlers[c.cmd] ? await handlers[c.cmd](c) : { ok: false, error: "unknown cmd " + c.cmd }; }
  catch (err) { result = { ok: false, error: String(err && err.message || err) }; }
  fetch("/ctl/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: c.id, result }) });
};

// ---- go ----------------------------------------------------------------------------------
const T0 = performance.now();
const mark = (what) => console.log(`[emu] ${what} at ${Math.round(performance.now() - T0)} ms`);
setView(localStorage.getItem("emu.view") || "3d");
if (!sab) appendLog("no SharedArrayBuffer: keys reach the device only while it is idle (busy loops will not see them)", "err");
const booting = reboot(main).then(() => mark("booted"));
try {
  device3d = await createDevice3D($("#stage"), screen, { onKey: setKey, onGrab: () => $("#right").focus({ preventScroll: true }) });
  device3d.updateScreen();
  mark("3d ready");
} catch (e) {
  appendLog("3D view unavailable (" + (e.message || e) + "), using flat view", "err");
  setView("flat");
}
await booting;
