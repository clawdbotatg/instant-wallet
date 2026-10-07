// Who can sign an owners transaction (signerOptions), for each wallet shape. No chain, no server:
//   npx tsx tools/safe-signers-check.mts
import type { Address, Hex } from "viem";
import { signerOptions } from "../lib/safe/send";
import { type ChainState, type SafeAccount, wedgieSigners } from "../lib/safe/state";

let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};
// a browser with a wallet extension and Web Serial (a computer)
(globalThis as any).window = { ethereum: {} };
const setNav = (v: object) => Object.defineProperty(globalThis, "navigator", { value: v, configurable: true });
setNav({ serial: {} });

const burner = "0x00000000000000000000000000000000000000b1" as Address;
const hot = "0x00000000000000000000000000000000000000c1" as Address;
const stranger = "0x00000000000000000000000000000000000000d1" as Address;
const wedgie = { x: ("0x" + "11".repeat(32)) as Hex, y: ("0x" + "22".repeat(32)) as Hex };
const [w1, w2] = wedgieSigners(wedgie);
const acct = (extra: Partial<SafeAccount> = {}): SafeAccount =>
  ({ credentialId: "c", qx: "0x01", qy: "0x02", burnerSigner: burner, address: "0x00000000000000000000000000000000000000a1", ...extra }) as SafeAccount;
const state = (owners: Address[], threshold: number, hasHot: boolean, hasWedgie: boolean) =>
  ({ chainId: 8453, deployed: true, owners, threshold, hasHot, hasWedgie }) as unknown as ChainState;
const show = (o: ReturnType<typeof signerOptions>) => o.map(x => `${x.signers.join("+")}${x.ready ? "" : "(not here)"}`).join(", ");

let o = signerOptions(state([burner, hot], 2, true, false), acct({ hot }));
ok(show(o) === "burner+hot", `Instant + hot (2 of 2): ${show(o)}`);

o = signerOptions(state([burner, w1, w2], 3, false, true), acct({ wedgie }));
ok(show(o) === "burner+wedgie", `Instant + wedgie (3 of 3): ${show(o)}`);

o = signerOptions(state([burner, w1, w2, hot], 3, true, true), acct({ wedgie, hot }));
ok(show(o) === "burner+wedgie, wedgie+hot", `all three (3 of 4): ${show(o)}`);

// Austin's wallet (2026-10-06): Instant + wedgie + one more owner, on a computer that never paired the wedgie
// (so its two slots look like strangers): it asked the wedgie, then failed on "no hot wallet". Now: Instant + wedgie.
o = signerOptions(state([burner, w1, w2, stranger], 3, true, true), acct());
ok(show(o) === "burner+wedgie", `Instant + wedgie + one more owner, wedgie not paired here: ${show(o)}`);
// paired: the extra owner can only be the hot wallet; Face ID + wedgie still comes first
o = signerOptions(state([burner, w1, w2, stranger], 3, true, true), acct({ wedgie }));
ok(o[0]?.signers.join("+") === "burner+wedgie", `same, wedgie paired: ${show(o)} (Instant + Wedgie first)`);

// a phone: no wallet extension, no Web Serial
(globalThis as any).window = {};
setNav({});
o = signerOptions(state([burner, w1, w2, hot], 3, true, true), acct({ wedgie, hot }));
ok(o.every(x => !x.ready), `all three on a phone: nothing it can sign alone (${show(o)})`);
process.exit(bad ? 1 : 0);
