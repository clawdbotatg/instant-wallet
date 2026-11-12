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
const p = parse(`${A}.`);
ok(p.kind === "pay" && p.to === A, "a pasted address with a dot is a send");
const n = parse("atg.eth.");
ok(n.kind === "pay" && n.to === "atg.eth", "a pasted name with a dot is a send");
process.exit(bad ? 1 : 0);
