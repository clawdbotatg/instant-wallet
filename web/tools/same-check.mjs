// EXPECTATIONS.md #2 (same thing, same look, everywhere), checked in the code: anything hand-rolled that has a
// shared part in components/bits.tsx fails. Seconds, no browser. Run: node web/tools/same-check.mjs
// A new rule from Austin goes here in the same change, so it can't come back in a fourth place.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const SHARED = "components/bits.tsx"; // where the shared parts live: it may draw them by hand

const RULES = [
  { re: /"✕"|>\s*✕\s*</, say: "a hand-drawn ✕: use <RemoveX>" },
  { re: /<a [^>]*className="pill[^"]*"[^>]*target="_blank"|<a [^>]*target="_blank"[^>]*className="pill/, say: "a pill out to another page: use <Eject>" }, // a big green button that opens a page (Telegram, wedgie.dev) is the action itself
  { re: /^\s*(OK|Ok|Yes|No|Approve|Confirm)\s*$|>\s*(OK|Yes|Approve|Confirm)\s*</, say: "OK/Yes/Approve/Confirm: say Done, Sign or Reject" },
  { re: /btn-green[^>]*>\s*(Done|Close|Cancel|Back)\b/, say: "Done/Close/Cancel/Back are white, not green" },
  { re: /\bPress [ABXY]\b|\bthe [ABXY] button\b/, say: "wedgie buttons are <GreenButton /> or 'the green button', never A/B/X/Y" },
  { re: /[>"`]\s*[+−]\{|\{get \? "\+" : "−"\}/, say: "money with a hand-written + or −: use <Money>" },
  { re: /\b(send|sends|sent) it (yourself|myself)\b|relay (is )?send/i, say: "a signed tx is executed, not sent" },
  // a tx on its way says Executing… (Austin 11-11: Activity's row said Sending…). A message that isn't a tx may say Sending…
  { re: /"Swapping…"/, say: "a tx on its way is 'Executing…', whatever it does (Austin 11-12: Swap said Swapping…)" },
  { re: /"Sending( to the network)?…"/, say: "a tx on its way is 'Executing…', not 'Sending…'", skip: ["components/safe/Alerts.tsx", "components/safe/Join.tsx"] }, // a Telegram test; a key sent to the wallet's owner
  // every address is <Who> (Austin 11-11, twice). "// plain text:" on the line: a string no part can go in (the passkey's name in the phone)
  { re: /\bshort\((?!.*\/\/ plain text:)(?!.*from "@\/lib\/format")/, say: "a bare short address: use <Who> (flat: one line; or <Words> for one inside a sentence; a full address in an error's words)" },
  { re: /<Blockie\b/, say: "a blockie placed by hand: use <Who>", skip: ["components/safe/SafeSend.tsx", "components/safe/Join.tsx", "components/safe/Keys.tsx", "components/safe/TxPage.tsx", "components/safe/WedgieButton.tsx"] },
  { re: /\bmono\b[^>]*>\s*(new key )?\{(a|address|addr|resolved|to|owner|signer|safe|account\.\w+)\}/, say: "a bare full address: use <Who> (blockie, name)" },
  { re: /\.slice\(0, 6\)\}…/, say: "an address shortened by hand: use <Who>" },
  { re: /`\$\{(many \? )?`?\$\{n \+ 1\}\. /, say: "a tx step numbered by hand: its <SrcTag> mark goes there (kit MARKS)" },
  // every coin amount is typed the same way: dollars first, a pill to switch to the coin (Austin 11-11: Send took dollars, Swap took tokens)
  // an address box keeps only the address (Austin 11-12: a pasted "0x….", a space, words around it)
  { re: /^(?!.*addressIn\().*<input.*placeholder="[^"]*0x/, say: "an address box by hand: use <AddressInput>, or addressIn() in its onChange (lib/format)" },
  { re: /inputMode="decimal"/, say: "an amount box by hand: use <AmountBox> (dollars first, switch to the coin)", skip: ["components/DropAdmin.tsx", "components/ClaimMaker.tsx"] }, // a drop's "dollars per claim" / "USDC on each": dollars only, no coin to switch to
];
// dark gray is the copy button only (Austin 10-30: most buttons white); Switch account he asked for by name
const DARK_OK = [SHARED, "components/Receive.tsx", "components/safe/Keys.tsx"]; // <CopyLink>; Switch account; the invite link's copy
RULES.push({ re: /btn-dark|pill dark/, say: "dark gray is only the copy button (<CopyLink>): make it white", skip: DARK_OK });

const files = [];
function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
}
walk(join(root, "components"));
walk(join(root, "app"));

let bad = 0;
for (const p of files) {
  const rel = relative(root, p);
  readFileSync(p, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const t = line.trim();
      if (/^(\/\/|\*|\/\*|\{\/\*)/.test(t)) return; // comments
      for (const r of RULES) {
        if ((rel === SHARED && r.say.includes("use <")) || r.skip?.includes(rel)) continue;
        if (r.re.test(line)) {
          bad++;
          console.log(`${rel}:${i + 1}  ${r.say}\n    ${t.slice(0, 140)}`);
        }
      }
    });
}
// a wallet's name is decided in one place, /api/ens: its own ENS name first, else its inst.eth name (Austin 11-12).
// And a name that gets paid is checked against where it pointed last time (<NameMoved>).
for (const p of files) {
  const rel = relative(root, p);
  const src = readFileSync(p, "utf8");
  if (/\/api\/names\?address/.test(src) && rel !== "components/safe/SafeApp.tsx") (bad++, console.log(`${rel}  a wallet's name read its own way: <Who> / useName decide it (its own ENS name first)`));
  if (/\/api\/ens\?name=/.test(src) && rel !== "components/safe/SafeApp.tsx" && !/NameMoved/.test(src)) (bad++, console.log(`${rel}  a name looked up with no <NameMoved>: say so when it points somewhere new`)); // SafeApp: ?watch, never paid
}
// a waiting tx's Reject always comes with its ✕ (Austin 10-31: the tx page had Reject and no ✕, Home had both)
for (const p of files) {
  const src = readFileSync(p, "utf8");
  if (/\btype Waiting\b/.test(src) && (/>\s*Reject\s*</.test(src) || /: "Reject"\s*[)}]/.test(src)))
    if (!/<RemoveX\b/.test(src)) (bad++, console.log(`${relative(root, p)}  a Reject with no <RemoveX>: a waiting tx gets both, ✕ then Reject`));
}
// Done, Close, Cancel (a form) and Back are white: red is only for destroying something (Austin 10-30). Whole buttons,
// since the tag often runs over several lines.
for (const p of files) {
  const src = readFileSync(p, "utf8");
  for (const b of src.match(/<button\b(?:(?!<\/button>)[\s\S])*<\/button>/g) || [])
    if (/btn-red|pill stop/.test(b) && />\s*(?:✕\s*)?(Done|Close|Cancel|Back)\s*<\/button>$/.test(b))
      (bad++, console.log(`${relative(root, p)}  a red ${b.match(/(Done|Close|Cancel|Back)\s*<\/button>$/)[1]}: closing a window is white, red only destroys`));
}
// fewest words (Austin 11-10): a settings box is its title, the box and a checkbox. No sentence that says what the
// title says, and an empty box's placeholder is its default (the address itself, or "Default …").
for (const p of files.filter(f => /Setting\.tsx$/.test(f))) {
  const src = readFileSync(p, "utf8");
  const rel = relative(root, p);
  if (/<p className="fine"/.test(src)) (bad++, console.log(`${rel}  a sentence under a settings box: the title and the box say it`));
  for (const m of src.matchAll(/placeholder=("[^"]*"|\{[^}]*\})/g))
    if (m[1].startsWith('"') && !/^"Default /.test(m[1])) (bad++, console.log(`${rel}  placeholder ${m[1]}: an empty box says its default ("Default …" or the default itself)`));
}
// Explorer above Done was a thin pill stretched across the page (Austin 11-10): <DoneBar> puts them in one row, same height
for (const p of files) {
  if (relative(root, p) === SHARED) continue;
  if (/<Eject\b[^\n]*\n\s*<button className="btn wide"[^>]*>\s*Done/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  Explorer above Done: use <DoneBar>`));
}
// Explorer on a line of its own is a normal button's height, on the right (Austin 11-11): <Eject big>
for (const p of files) {
  if (relative(root, p) === SHARED) continue;
  if (/<Eject (?!big\b)[^>]*>\s*\n\s*Explorer/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  Explorer on its own line: <Eject big>`));
}
// a row that leaves the wallet says ↗ after its name (Austin 11-11)
for (const p of files) {
  for (const m of readFileSync(p, "utf8").matchAll(/<a\b[^>]*className="(?:asset|grow)"[^>]*target="_blank"[^>]*>[\s\S]{0,400}/g))
    if (!m[0].includes("↗")) (bad++, console.log(`${relative(root, p)}  a row that leaves the wallet: ↗ after its name`));
}
// a wait of ~5 s or more gets a bar: a file that sends a tx draws one (<Progress>, or <TimedBar>/<TimeBar> for a wait it only knows the length of)
for (const p of files) {
  const src = readFileSync(p, "utf8");
  if (/\b(finishOwners|ownersSend|budgetSend)\(/.test(src) && !/<(Progress|TimedBar|TimeBar)\b/.test(src)) (bad++, console.log(`${relative(root, p)}  sends a tx with no progress bar: <Progress stage chainId hash>`));
}
// a tx's stage words ("Signing…", "Executing…") are written once: stageLabel in bits.tsx
for (const p of files) {
  if (relative(root, p) === SHARED) continue;
  if (/(sending|confirming|"signing-wedgie"|signing): ["<`]/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  a tx's stage words written by hand: stageLabel(stage)`));
}
// two button heights (Austin 11-11): every small one (pill, btn-sm) is as tall as a pill
{
  const css = readFileSync(root + "app/globals.css", "utf8");
  const h = c => css.match(new RegExp(`^\\.${c} \\{[^}]*height: (\\d+)px`, "m"))?.[1];
  if (h("pill") !== h("btn-sm")) (bad++, console.log(`app/globals.css  .btn-sm is ${h("btn-sm")} tall, .pill is ${h("pill")}: small buttons are one height`));
}
console.log(bad ? `\n${bad} not the same as everywhere else` : "same everywhere ✓");
process.exit(bad ? 1 : 0);
