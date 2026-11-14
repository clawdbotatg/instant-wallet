// No site may frame the wallet (audit 11-13: a decoy over Sign in a framed /tx page). Every page and API answer
// must say so in its headers. Against a running copy:
//   node tools/frame-check.mjs [http://localhost:3100]     (default: https://instantwallet.io)
const base = process.argv[2] || "https://instantwallet.io";
let bad = 0;
for (const p of ["/", "/tx/8453/0x0000000000000000000000000000000000000001", "/recover", "/paper", "/api/version", "/api/safe/queue", "/nope"]) {
  const r = await fetch(base + p, { redirect: "manual" });
  const csp = r.headers.get("content-security-policy") || "", xfo = r.headers.get("x-frame-options") || "";
  const ok = /frame-ancestors 'none'/.test(csp) && xfo.toUpperCase() === "DENY";
  bad += ok ? 0 : 1;
  console.log(ok ? "ok  " : "FAIL", p, r.status, JSON.stringify(csp), xfo);
}
console.log(bad ? `${bad} FAILED` : "ALL OK");
process.exit(bad ? 1 : 0);
