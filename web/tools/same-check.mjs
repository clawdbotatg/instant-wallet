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
  { re: /<Blockie\b/, say: "a blockie placed by hand: use <Who>", skip: ["components/safe/Keys.tsx", "components/safe/TxPage.tsx", "components/safe/WedgieButton.tsx"] },
  { re: /\bmono\b[^>]*>\s*(new key )?\{(a|address|addr|resolved|to|owner|signer|safe|account\.\w+)\}/, say: "a bare full address: use <Who> (blockie, name)" },
  { re: /\.slice\(0, 6\)\}…/, say: "an address shortened by hand: use <Who>" },
  { re: /`\$\{(many \? )?`?\$\{n \+ 1\}\. /, say: "a tx step numbered by hand: its <SrcTag> mark goes there (kit MARKS)" },
  // every coin amount is typed the same way: dollars first, a pill to switch to the coin (Austin 11-11: Send took dollars, Swap took tokens)
  // an address box keeps only the address (Austin 11-12: a pasted "0x….", a space, words around it)
  // one address box, everywhere (Austin 11-12: adding a signer didn't look names up the way Send does)
  { re: /<input.*placeholder="[^"]*0x/, say: "an address box by hand: use <AddressInput>" },
  { re: /\bnameTyped\(|\buseAddressScan\(|\/api\/ens\?name=/, say: "a name looked up or an address scanned by hand: use <AddressInput>", skip: ["components/safe/SafeApp.tsx"] }, // ?watch=name.eth in the link: no box
  // a link is copied, never shared (Austin 11-12: an invite showed its whole link and a Share button)
  { re: /^\s*Share\s*$|>\s*Share\s*<|navigator\.share\(\{ url/, say: "a Share button: a link is copied with <CopyLink>" },
  { re: /<AddressInput[^>]*\bbare\b/, say: "<AddressInput> has no modes: every box takes a word alone" },
  // a network is its logo and its name, everywhere (Austin 11-12: Activity had the logo, a waiting tx didn't). An asset row is the one place without: its token icon has the badge
  { re: /(?<!\$)\{chainById\([^()]*\)\?\.name\b(?!.*\/\* (in the token icon|plain text:))|<ChainIcon\b.*\?\.name\b/, say: "a network's name drawn by hand: use <Net> (logo, then name)" },
  // something new shows at once (Austin 11-12: Home re-read its waiting transactions every 5 minutes, for a limit that didn't apply)
  { re: /setInterval\(.*,\s*(\d+\s*\*\s*60_?000|[4-9]\d_?000|\d{3,}_?000)\s*\)/, say: "a list re-read slower than every 30 s: something new shows within seconds" },
  // found by the 11-12 look through the whole app: each was said or drawn two ways
  { re: /<ChainChip\b|<ChainIcon\b[^>]*\/>\s*$/, say: "a network as a chip, or its logo alone: use <Net> (logo, then name)", skip: ["components/safe/Apps.tsx", "components/safe/Pick.tsx"] }, // an app's row of logos; the picker's own icon slot
  { re: /Network fee: \{|[Dd]aily budget|Instant wallet\b|hot wallet…|title="(Open in|See it on) the explorer"|"Swapped"|✓ signed/, say: "said another way elsewhere: Fee · daily limit · Instant Wallet · browser wallet · <Eject>'s own title · Executed · ✓ Signed" },
  { re: /"\$" \+|`\$\$\{\(?[\w.]+\)?\.toFixed\(|const compactUsd/, say: "dollars written by hand: usd() or compactUsd() from lib/format" },
  { re: /"(Working|Getting ready|Cancelling|Signing)…"|`(Check )?\$\{bio\(\)\}…`/, say: "a button's busy words written by hand: stageLabel(\"quote\" | \"signing\" | \"sending\")", skip: [SHARED] },
  { re: /<p className="err">\{(error|err|refused)\}/, say: "an error drawn by hand: use <ErrorLine> (an address in it is drawn as <Who>)" },
  { re: /^\s*Disconnect\s*$/, say: "a Disconnect word button: <RemoveX label=\"Disconnect\">, the red ✕ like every other row" },
  // picked by what most of the app already says (11-12): Sign on the tap that signs, recovery address, coin
  { re: /stageLabel\((stage|step)\) : (step === "unfunded" \? "Try again" : )?"(Send|Swap|Fund it)"/, say: "the tap that signs says Sign, or 'Sign to …'" },
  { re: /["`>][^"`<{]*( [Gg]uardians?\b|\b[Gg]uardians? )[^"`<{]*["`<]/, say: "'guardian' in words a user reads: say 'recovery address'", skip: ["components/safe/RecoverTool.tsx", "components/safe/SafeWelcome.tsx"] }, // code that reads getGuardians
  { re: /Execute it myself|your wallet pays the gas/, say: "said one way: '… from my wallet (I pay gas)'" },
  { re: /^\s*✓ (Executed|Funded)\b|Card written ✓/, say: "a tx that ran, said by hand: <ExecutedLine href> (and <DoneBar> on a finished screen)" },
  { re: /\.length\}\/\{/, say: "a count as x/y: say 'x of y'" },
  { re: /(btn|pill)[^>]*style=\{\{[^}]*\bheight: \d/, say: "a button with its own height: two heights only, 56 and 38" },
  { re: /inputMode="decimal"/, say: "an amount box by hand: use <AmountBox> (dollars first, switch to the coin)", skip: ["components/DropAdmin.tsx", "components/ClaimMaker.tsx"] }, // a drop's "dollars per claim" / "USDC on each": dollars only, no coin to switch to
];

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
  if (/(Spending|Savings) account/.test(src)) (bad++, console.log(`${rel}  a made-up wallet name: a wallet with no name shows its address (Austin 11-12)`));
  if (/\/api\/names\?address/.test(src) && rel !== "components/safe/SafeApp.tsx") (bad++, console.log(`${rel}  a wallet's name read its own way: <Who> / useName decide it (its own ENS name first)`));
  if (/\/api\/ens\?name=/.test(src) && rel !== "components/safe/SafeApp.tsx" && !/NameMoved/.test(src)) (bad++, console.log(`${rel}  a name looked up with no <NameMoved>: say so when it points somewhere new`)); // SafeApp: ?watch, never paid
}
// dark gray is the second choice (Austin 11-12): it sits beside a green, and Reject is never it.
// <CopyLink>, Switch account and the invite link's copy are dark gray on their own.
const DARK_OK = [SHARED, "components/Receive.tsx", "components/safe/Keys.tsx"];
for (const p of files) {
  const rel = relative(root, p);
  const src = readFileSync(p, "utf8");
  if (/btn-dark|pill dark/.test(src) && !/btn-green/.test(src) && !DARK_OK.includes(rel)) (bad++, console.log(`${rel}  a dark gray button with no green one: dark gray is the second choice, else white`));
  // a copy link on the screen is the second choice: nothing else there is dark gray. <CopyLink green> is the one thing left to do, not a second choice
  if (/<CopyLink(?![^>]*\bgreen\b)/.test(src) && /btn-dark|pill dark/.test(src) && rel !== SHARED) (bad++, console.log(`${rel}  a second dark gray button beside a copy link: the copy link is the second choice, make the other white`));
  if (/(btn-dark|pill dark)[^>]*>\s*Reject\b/.test(src)) (bad++, console.log(`${rel}  Reject is white, not dark gray`));
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
// Explorer above Done was a thin pill stretched across the page (Austin 11-10): <DoneBar> is Done, with the ⏏ in the sheet's top right
for (const p of files) {
  if (relative(root, p) === SHARED) continue;
  if (/<Eject\b[^\n]*\n\s*<button className="btn wide"[^>]*>\s*Done/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  Explorer above Done: use <DoneBar>`));
}
// a block explorer link is the bare ⏏ icon, never a button that says Explorer (Austin 11-12): <Eject href title />
for (const p of files) {
  if (/<Eject\b[^>]*>\s*Explorer/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  a button that says Explorer: the bare <Eject /> icon`));
}
// a tx on its way says Executing…, never Confirming… (Austin 11-12)
for (const p of files) {
  if (/["`>]Confirming…/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  "Confirming…": a tx on its way says Executing…`));
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
// an avatar comes through /api/avatar: the browser never loads one from its own host (which would learn who you pay)
for (const p of files) {
  if (/euc\.li|ipfs\.io|src=\{[^}]*avatarUrl/.test(readFileSync(p, "utf8"))) (bad++, console.log(`${relative(root, p)}  an avatar from its own host: /api/avatar?name=`));
}
// two button heights (Austin 11-11): every small one (pill, btn-sm) is as tall as a pill
{
  const css = readFileSync(root + "app/globals.css", "utf8");
  const h = c => css.match(new RegExp(`^\\.${c} \\{[^}]*height: (\\d+)px`, "m"))?.[1];
  if (h("pill") !== h("btn-sm")) (bad++, console.log(`app/globals.css  .btn-sm is ${h("btn-sm")} tall, .pill is ${h("pill")}: small buttons are one height`));
}
console.log(bad ? `\n${bad} not the same as everywhere else` : "same everywhere ✓");
process.exit(bad ? 1 : 0);
