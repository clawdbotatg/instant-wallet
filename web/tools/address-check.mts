// An address box keeps only the address: npx tsx tools/address-check.mts
import { addressIn, nameIn } from "../lib/format";
import { parse } from "../lib/parse";
let bad = 0;
const ok = (c: boolean, m: string) => (console.log((c ? "PASS " : "FAIL ") + m), c || bad++);
const A = "0x34F942e7567CE091CcECA12feA4B4BE67eeDC587";
for (const t of [`${A}.`, ` ${A} `, `${A}\n`, `send it to ${A}, thanks`, `(${A})`, `"${A}"`, `base:${A}`, `${A}…`, `${A} ${A}`, "0X" + A.slice(2)])
  ok(addressIn(t) === A, JSON.stringify(t));
const hash = "0x" + "ab".repeat(32);
ok(addressIn(hash) === hash, "a tx hash is left alone");
ok(addressIn(`${A} 0x${"11".repeat(20)}`).includes(" "), "two different addresses: left alone");
ok(addressIn("atg.et") === "atg.et" && addressIn(A.slice(0, 20)) === A.slice(0, 20), "half-typed text is left alone");
ok(nameIn(" atg.eth. ") === "atg.eth" && nameIn("(atg.eth)") === "atg.eth", "a name loses the dot and the brackets");
for (const t of ["sub.atg.eth", "sub.atg.", "a.b.c.atg.eth", "sub.", `${A}.eth`, `${A}.atg.eth`, `pay.${A}.eth`, `${A}-x.eth`])
  ok(addressIn(t) === t, `typing ${t}: the box is left alone`);
ok(nameIn("a.b.atg.eth.") === "a.b.atg.eth" && nameIn("sub.atg.eth") === "sub.atg.eth", "a subname keeps every dot inside it");
const sub = parse("pay.sub.atg.eth");
ok(sub.kind === "pay" && sub.to === "pay.sub.atg.eth", "a pasted subname is a send");
const p = parse(`${A}.`);
ok(p.kind === "pay" && p.to === A, "a pasted address with a dot is a send");
const n = parse("atg.eth.");
ok(n.kind === "pay" && n.to === "atg.eth", "a pasted name with a dot is a send");
process.exit(bad ? 1 : 0);
