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
  { re: /\.map\(short\)|<span className="mono">\{short\(/, say: "a bare short address: use <Who> (or <Words> for one inside a sentence)", skip: ["components/DropAdmin.tsx"] }, // a copy button's label
  { re: /`\$\{(many \? )?`?\$\{n \+ 1\}\. /, say: "a tx step numbered by hand: its <SrcTag> mark goes there (kit MARKS)" },
];
// dark gray is the copy button only (Austin 10-30: most buttons white); Switch account he asked for by name
const DARK_OK = [SHARED, "components/Receive.tsx", "components/safe/Keys.tsx"]; // <CopyLink>; Switch account; the invite link's copy
RULES.push({ re: /btn-dark|pill dark/, say: "dark gray is only the copy button (<CopyLink>): make it white", skip: DARK_OK });

const files = [];
(function walk(d) {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".tsx")) files.push(p);
  }
})(join(root, "components"));

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
    if (/btn-red/.test(b) && />\s*(Done|Close|Cancel|Back)\s*<\/button>$/.test(b))
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
console.log(bad ? `\n${bad} not the same as everywhere else` : "same everywhere ✓");
process.exit(bad ? 1 : 0);
