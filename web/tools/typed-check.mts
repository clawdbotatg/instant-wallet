// A typed-data request's card (lib/safe/typed.ts): a permit says who may spend what, in red; nothing typed is ever
// called harmless; only the fields the types name (the hashed ones) are shown (audit 11-13: a USDC Permit read
// "Moves no money", and a site could add its own lines). Seconds, no network.
//   npx tsx tools/typed-check.mts
import { typedCard } from "../lib/safe/typed";

let bad = 0;
const ok = (c: boolean, m: string, got?: unknown) => {
  console.log(`${c ? "PASS" : "FAIL"} ${m}`);
  if (!c) {
    bad++;
    if (got) console.log("     ", JSON.stringify(got));
  }
};

const CHAIN = 8453;
const safe = "0x1111111111111111111111111111111111111111";
const spender = "0x2222222222222222222222222222222222222222";
const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const dai = "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const MAX = (2n ** 256n - 1n).toString();
const site = "evil.example";
const harmless = (c: { warn: string[]; lines: string[] }) => [...c.warn, ...c.lines].some(l => /no money/i.test(l));

const permitTypes = { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] };
const permit = (value: string, more: object = {}) => ({
  domain: { name: "USD Coin", version: "2", chainId: CHAIN, verifyingContract: usdc },
  types: { EIP712Domain: [], ...permitTypes },
  primaryType: "Permit",
  message: { owner: safe, spender, value, nonce: 0, deadline: 9999999999, ...more },
});

let c = typedCard(permit(MAX), CHAIN, site);
ok(c.kind === "permit" && c.warn[0] === `Let ${spender} spend any amount of your USDC`, "USDC permit, max: 'Let <spender> spend any amount of your USDC'", c);
ok(c.contract === usdc && c.app === "USD Coin" && c.chain === CHAIN && !c.otherChain, "…with the app, the network and the contract that takes it", c);
ok(!harmless(c), "…and nothing says it moves no money");

c = typedCard(permit("5000000"), CHAIN, site);
ok(c.warn[0] === `Let ${spender} spend up to 5 USDC`, "USDC permit, 5: 'up to 5 USDC'", c);

c = typedCard(permit(MAX, { note: "refund", spender }), CHAIN, site);
ok(!c.lines.some(l => /note|refund/.test(l)) && c.lines.length === 5, "a key the types don't name is not shown", c.lines);
ok(c.lines[1] === `spender: ${spender}`, "fields come in the types' order", c.lines);

c = typedCard({ ...permit(MAX), domain: { name: "Dai Stablecoin", version: "1", chainId: CHAIN, verifyingContract: dai } }, CHAIN, site);
ok(c.kind === "permit" && c.warn[0] === `Let ${spender} spend any amount of your token ${dai}`, "another token's permit names the token's contract", c);

c = typedCard(
  {
    domain: { name: "Dai Stablecoin", version: "1", chainId: CHAIN, verifyingContract: dai },
    types: { Permit: [{ name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }] },
    primaryType: "Permit",
    message: { holder: safe, spender, nonce: 0, expiry: 0, allowed: true },
  },
  CHAIN,
  site,
);
ok(c.kind === "permit" && /any amount/.test(c.warn[0]), "DAI's permit (allowed: true) is any amount", c);

const details = [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }];
c = typedCard(
  {
    domain: { name: "Permit2", chainId: CHAIN, verifyingContract: PERMIT2 },
    types: { PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: details },
    primaryType: "PermitSingle",
    message: { details: { token: usdc, amount: (2n ** 160n - 1n).toString(), expiration: 1, nonce: 0 }, spender, sigDeadline: 1 },
  },
  CHAIN,
  site,
);
ok(c.kind === "permit2" && c.warn[0] === `Let ${spender} spend any amount of your USDC`, "Permit2 PermitSingle names the token in the message", c);
ok(c.lines.includes(`details.token: ${usdc}`) && c.lines.includes(`spender: ${spender}`), "…and its nested fields are shown", c.lines);

c = typedCard(
  {
    domain: { name: "Permit2", chainId: CHAIN, verifyingContract: PERMIT2 },
    types: { PermitBatch: [{ name: "details", type: "PermitDetails[]" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }], PermitDetails: details },
    primaryType: "PermitBatch",
    message: { details: [{ token: usdc, amount: "1000000", expiration: 1, nonce: 0 }, { token: dai, amount: MAX.slice(0, 40), expiration: 1, nonce: 0 }], spender, sigDeadline: 1 },
  },
  CHAIN,
  site,
);
ok(c.kind === "permit2" && c.warn.length === 2 && c.warn[0] === `Let ${spender} spend up to 1 USDC`, "Permit2 PermitBatch: a line per token", c);

c = typedCard(
  {
    domain: { name: "Permit2", chainId: CHAIN, verifyingContract: PERMIT2 },
    types: { PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }], TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
    primaryType: "PermitTransferFrom",
    message: { permitted: { token: usdc, amount: "2500000" }, spender, nonce: 0, deadline: 1 },
  },
  CHAIN,
  site,
);
ok(c.kind === "permit2" && c.warn[0] === `Let ${spender} spend up to 2.5 USDC`, "Permit2 PermitTransferFrom", c);

// a CoW order: not a permit, but it sells a coin
c = typedCard(
  {
    domain: { name: "Gnosis Protocol", version: "v2", chainId: CHAIN, verifyingContract: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41" },
    types: { Order: [{ name: "sellToken", type: "address" }, { name: "buyToken", type: "address" }, { name: "receiver", type: "address" }, { name: "sellAmount", type: "uint256" }, { name: "buyAmount", type: "uint256" }] },
    primaryType: "Order",
    message: { sellToken: usdc, buyToken: dai, receiver: spender, sellAmount: "1000000", buyAmount: "1" },
  },
  CHAIN,
  site,
);
ok(c.kind === "other" && /can move money/.test(c.warn[0]) && c.warn[0].includes(site), "an order: 'can move money', names the site", c);
ok(!harmless(c), "…and nothing says it moves no money");

c = typedCard({ domain: { name: "Chat" }, types: { Mail: [{ name: "contents", type: "string" }] }, primaryType: "Mail", message: { contents: "hello" } }, CHAIN, site);
ok(c.kind === "other" && c.warn.length === 1 && !harmless(c) && c.lines[0] === "contents: hello", "a plain typed message still warns, and shows its text", c);

c = typedCard(permit(MAX), 1, site);
ok(c.otherChain === CHAIN, "a domain for another network is flagged", c);

// broken shapes don't throw
ok(typedCard({}, CHAIN, site).kind === "other" && typedCard({ types: { Permit: "x" }, primaryType: "Permit", message: null }, CHAIN, "").warn.length === 1, "an empty or broken request reads as 'other'");
c = typedCard({ ...permit(MAX), message: { owner: safe, spender: "nope", value: MAX } }, CHAIN, site);
ok(c.kind === "other", "a Permit with no real spender is not called a permit", c);

if (bad) {
  console.error(`${bad} failed`);
  process.exit(1);
}
console.log("ok");
