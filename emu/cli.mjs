#!/usr/bin/env node
// tools/emu: drive the emulator from a terminal (or a bot).
//   tools/emu                    start the server (if needed) and open the page
//   tools/emu run MODULE         fresh boot, then `import MODULE` (files re-read from disk)
//   tools/emu exec 'CODE'        one REPL line on the running device; prints its output
//   tools/emu key K[:MS]         press a key: A B X Y up down left right press (MS held, default 80)
//   tools/emu keys 'K,K,K'       several presses in a row
//   tools/emu shot [out.png]     screenshot (480x480) -> emu/shots/latest.png by default
//   tools/emu log [N]            last N console lines (default 40)
//   tools/emu state              what is running, fps, frames, files
//   tools/emu reset              reboot the device and re-run the main module
//   tools/emu main MODULE        set which module boots by default
//   tools/emu headless ...       no browser: see emu/headless.mjs
//   tools/emu serve              run the server in the foreground
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EMU = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.EMU_PORT || 4242;
const URL_ = `http://localhost:${PORT}`;
const [cmd, ...rest] = process.argv.slice(2);

async function up() {
  try { const r = await fetch(URL_ + "/ctl/state"); return r.ok; } catch { return false; }
}

async function ensureServer() {
  if (await up()) return;
  const child = spawn(process.execPath, [resolve(EMU, "server.mjs")], { stdio: "ignore", detached: true, env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) { if (await up()) return; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
}

async function send(obj) {
  await ensureServer();
  const r = await fetch(URL_ + "/ctl/cmd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function modName(s) { return s.replace(/\.py$/, "").replace(/^.*\//, ""); }

try {
  switch (cmd) {
    case undefined:
    case "start": {
      await ensureServer();
      const open = process.platform === "darwin" ? "open" : "xdg-open";
      spawn(open, [URL_ + "/"], { stdio: "ignore", detached: true }).unref();
      console.log("emulator at " + URL_ + "/");
      break;
    }
    case "serve": {
      const child = spawn(process.execPath, [resolve(EMU, "server.mjs"), ...rest], { stdio: "inherit" });
      child.on("exit", (c) => process.exit(c));
      break;
    }
    case "headless": {
      const child = spawn(process.execPath, [resolve(EMU, "headless.mjs"), ...rest], { stdio: "inherit" });
      child.on("exit", (c) => process.exit(c));
      break;
    }
    case "run": {
      if (!rest[0]) throw new Error("usage: tools/emu run MODULE");
      const r = await send({ cmd: "run", name: modName(rest[0]) });
      for (const l of r.lines || []) console.log(l);
      console.log(r.ok ? `running ${modName(rest[0])}` : "run failed");
      process.exit(r.ok ? 0 : 1);
    }
    case "exec": {
      const r = await send({ cmd: "exec", code: rest.join(" ") });
      for (const l of r.lines || []) console.log(l);
      break;
    }
    case "key": {
      const [name, ms] = (rest[0] || "").split(":");
      await send({ cmd: "key", name, ms: ms ? +ms : 80 });
      break;
    }
    case "keys": {
      await send({ cmd: "keys", names: rest.join(",").split(/[,\s]+/).filter(Boolean) });
      break;
    }
    case "shot": {
      const r = await send({ cmd: "shot" });
      const out = resolve(rest[0] || resolve(EMU, "shots/latest.png"));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, Buffer.from(r.png.split(",")[1], "base64"));
      console.log(out);
      break;
    }
    case "log": {
      const r = await send({ cmd: "log", n: +(rest[0] || 40) });
      for (const l of r.lines || []) console.log(l);
      break;
    }
    case "state": console.log(JSON.stringify(await send({ cmd: "state" }), null, 2)); break;
    case "reset": { const r = await send({ cmd: "reset" }); for (const l of r.lines || []) console.log(l); break; }
    case "main": { await send({ cmd: "main", name: modName(rest[0] || "mock") }); console.log("main = " + modName(rest[0] || "mock")); break; }
    default:
      console.error("unknown command: " + cmd);
      process.exit(2);
  }
} catch (e) {
  console.error("emu: " + (e.message || e));
  process.exit(1);
}
