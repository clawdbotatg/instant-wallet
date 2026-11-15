// A sign-in request (Sign-In with Ethereum) and who is really asking (audit 11-13, WEB-16). Over WalletConnect a
// site names itself: a phishing page said it was the real site, or said nothing (an empty name skipped the check).
// Now WalletConnect's own check of the origin is used when there is one, and no name at all is red. No network.
//   npx tsx tools/signin-check.mts
import { signInCheck } from "../lib/signin";

let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) bad++;
};
const safe = "0x1111111111111111111111111111111111111111";
const siwe = { domain: "app.uniswap.org", address: safe, uri: "https://app.uniswap.org", chainId: 1 };
const red = (a: Parameters<typeof signInCheck>[1], s = siwe) => signInCheck(s, a, safe).red.join(" | ");

ok(red({ url: "https://app.uniswap.org", origin: "https://app.uniswap.org", sure: "yes" }) === "", "the real site, checked: no warning");
ok(signInCheck(siwe, { url: "https://app.uniswap.org", origin: "https://app.uniswap.org", sure: "yes" }, safe).note === null, "and no note");
ok(/evil\.example is asking/.test(red({ url: "https://app.uniswap.org", origin: "https://evil.example", sure: "yes" })), `a phishing page that names the real site, WalletConnect knows its origin: red (${red({ url: "https://app.uniswap.org", origin: "https://evil.example", sure: "yes" })})`);
ok(red({ url: "https://app.uniswap.org", origin: "https://evil.example", sure: "no" }) !== "", `WalletConnect says the site isn't who it claims: red (${red({ url: "https://app.uniswap.org", sure: "no" })})`);
ok(red({ url: "", sure: "unknown" }) !== "", `a site that names no URL at all: red, the check isn't skipped (${red({ url: "", sure: "unknown" })})`);
ok(red({ url: "not a url", sure: "unknown" }) !== "", "a URL that doesn't read: red");
ok(/evil\.example is asking/.test(red({ url: "https://evil.example", sure: "unknown" })), "another site by its own word: red, as before");
const un = signInCheck(siwe, { url: "https://app.uniswap.org", sure: "unknown" }, safe);
ok(un.red.length === 0 && !!un.note, `the right name but nothing proves it: no red, a note (${un.note})`);
ok(red({ url: "https://app.uniswap.org", origin: "https://app.uniswap.org", sure: "yes" }, { ...siwe, address: "0x2222222222222222222222222222222222222222" }).includes("another account"), "another account: red");
ok(red({ url: "https://app.uniswap.org", origin: "https://app.uniswap.org", sure: "yes" }, { ...siwe, uri: "https://evil.example/login" }).includes("evil.example"), "a sign-in whose address (uri) is another site: red");
ok(red({ url: "https://app.uniswap.org", origin: "https://app.uniswap.org", sure: "yes" }, { ...siwe, uri: "https://uniswap.org/api" }) === "", "a uri on the same site's other name: fine");
ok(red({ url: "https://APP.Uniswap.org/", origin: "https://app.uniswap.org", sure: "yes" }) === "", "letter case doesn't matter");

if (bad) {
  console.error(`${bad} failed`);
  process.exit(1);
}
console.log("ok");
