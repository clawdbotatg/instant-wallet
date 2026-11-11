// Who the relay refuses after a failed send (fix list 11b), in memory, no chain: the wallet that failed is refused
// for a day; everyone else on the same IP (a room on one Wi-Fi) still sends, until that IP's third failure.
//   npx tsx --conditions=react-server tools/relay-ban-check.mts
const { admit, reverted, IP_REVERTS } = await import("../lib/safe/relayGuard");
let bad = 0;
const ok = (c: boolean, m: string) => {
  console.log((c ? "PASS " : "FAIL ") + m);
  if (!c) bad++;
};
const w = (n: number) => ("0x" + n.toString(16).padStart(40, "0")) as `0x${string}`;
const lets = (ip: string, safe: `0x${string}`) => admit(ip, safe).then(() => true, () => false);
const ROOM = "10.0.0.1";

ok(await lets(ROOM, w(1)), "a wallet sends");
await reverted(w(1), ROOM);
ok(!(await lets(ROOM, w(1))), "its send failed on chain: that wallet is refused");
ok(await lets(ROOM, w(2)), "another wallet on the same Wi-Fi still sends");
ok(!(await lets("10.0.0.9", w(1))), "the failed wallet is refused from another IP too");

for (let i = 2; i <= IP_REVERTS; i++) await reverted(w(i), ROOM);
ok(!(await lets(ROOM, w(50))), `${IP_REVERTS} failures from one IP in a day: the IP is refused`);
ok(await lets("10.0.0.9", w(51)), "another IP is not");

// a swap can fail honestly: its first two don't count, for the wallet or the IP
const CAFE = "10.0.0.2";
await reverted(w(60), CAFE, true);
await reverted(w(60), CAFE, true);
ok(await lets(CAFE, w(60)), "two failed swaps: the wallet still sends");
await reverted(w(60), CAFE, true);
ok(!(await lets(CAFE, w(60))), "the third failed swap: the wallet is refused");
ok(await lets(CAFE, w(61)), "and its IP still isn't");

// one IP, many sends in an hour: the wallet's own cap is the only one here now
let through = 0;
for (let i = 0; i < 100; i++) if (await lets("10.0.0.3", w(1000 + i))) through++;
ok(through === 100, `100 wallets on one IP in an hour all send (${through})`);
process.exit(bad ? 1 : 0);
