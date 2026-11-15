// /api/alerts can't be used to mail-bomb someone or flood the recovery watcher (audit 11-13, IW-3). Signing in there
// is free (any never-used wallet's own key), so it had no limit at all: each call mailed any address from our Gmail,
// and added a wallet the watcher reads every minute. Now: a limit per caller, and one per address mailed, whoever asks.
//   npx tsx --conditions=react-server tools/limit-check.mts
import { readFileSync } from "node:fs";
delete process.env.RELAY_KV_URL;
delete process.env.RELAY_KV_TOKEN;
const L: any = await import("../lib/limit");
let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const req = (ip: string) => new Request("https://x/api/alerts", { headers: { "x-forwarded-for": ip } });
const n = "t" + Date.now();

let hits = 0;
for (let i = 0; i < 5; i++) if (await L.tooMany(req("1.1.1.1"), n, 3, 60)) hits++;
ok(hits === 2 && !(await L.tooMany(req("2.2.2.2"), n, 3, 60)), "per caller: the 4th and 5th from one IP are too many, another IP is fine");
ok(typeof L.tooManyOf === "function", "there is a limit by a key of our choosing (tooManyOf)");
if (typeof L.tooManyOf === "function") {
  const mail = "Victim@Example.com";
  const seen: boolean[] = [];
  for (let i = 0; i < 4; i++) seen.push(await L.tooManyOf(n + "mail", mail, 3, 60));
  ok(seen.join() === "false,false,false,true", `per address: the 4th mail to one address is too many, from any caller (${seen})`);
  ok(await L.tooManyOf(n + "mail", "victim@example.com ", 3, 60), "the same address in other letter case or with a space counts as the same");
  ok(!(await L.tooManyOf(n + "mail", "someone.else@example.com", 3, 60)), "another address is fine");
  const dump = JSON.stringify(await (await import("../lib/kv")).kv(["KEYS", "*"]).catch(() => "")) + (() => { try { return readFileSync(".kv.json", "utf8"); } catch { return ""; } })();
  ok(!/victim@example\.com/i.test(dump), "the address itself is not kept (its hash is)");
}
const route = readFileSync(new URL("../app/api/alerts/route.ts", import.meta.url), "utf8");
const post = route.slice(route.indexOf("export async function POST"));
ok(/tooMany\(req, "alerts"/.test(post) && post.indexOf('tooMany(req, "alerts"') < post.indexOf("authorize("), "the alerts route limits each caller before the costly checks");
ok(/tooManyOf\("alertmail"/.test(post), "and limits the mail one address gets");
process.exit(bad ? 1 : 0);
