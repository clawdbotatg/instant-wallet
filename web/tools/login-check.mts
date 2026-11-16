// Wallet login (drops admin) takes only the server's own message, whole (audit 11-13, IW-16): it checked just the
// nonce at the end, so another site could ask for a nonce and get it signed under words of its own.
//   npx tsx --conditions=react-server tools/login-check.mts
import { loginMessage, walletLogin } from "../lib/drops";
let fails = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) fails++; };
const n = "0123456789abcdef01234567";
ok(loginMessage(n).includes("https://instantwallet.io") && loginMessage(n).endsWith(`\nnonce: ${n}`), "the message names the site and ends in its nonce");
ok((await walletLogin("0x0000000000000000000000000000000000000001", `Claim your free NFT\nnonce: ${n}`, "0x")) === false, "other words over a real-looking nonce: refused before anything is read");
process.exit(fails ? 1 : 0);
