// Who the relay refuses after a failed send (fix list 11b), in memory, no chain: the wallet that failed is refused
// for a day; everyone else on the same IP (a room on one Wi-Fi) still sends, until that IP's third failure.
//   npx tsx --conditions=react-server tools/relay-ban-check.mts
const { admit, reverted, IP_REVERTS, takeTurn, forget, lost, overLoss, LOSS_CAP_CENTS, sentFine, hasSentFine, isSafe } = await import("../lib/safe/relayGuard");
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

// a wallet that didn't exist before its failed swap (a new key each time costs nothing: audit IW-9): the wallet may
// try again, but each failure counts against where it came from
const DEN = "10.0.0.4";
await reverted(w(70), DEN, true, true);
ok(await lets(DEN, w(70)), "a brand-new wallet's first swap failed: it may try again");
ok(await lets(DEN, w(71)), "and one failure doesn't refuse its IP");
for (let i = 1; i < IP_REVERTS; i++) await reverted(w(70 + i), DEN, true, true);
ok(!(await lets(DEN, w(79))), `${IP_REVERTS} brand-new wallets failing from one IP: the IP is refused`);

// one send in flight per wallet (audit IW-10)
await takeTurn("fly:1:a");
ok(await takeTurn("fly:1:a", 800).then(() => false, e => e.status === 409), "a second send for a wallet waits, then is told to try again");
ok(await takeTurn("fly:1:b", 800).then(() => true, () => false), "another wallet isn't held up");
await forget("fly:1:a");
ok(await takeTurn("fly:1:a", 800).then(() => true, () => false), "the turn given back: its next send goes");

// a day's losses on a chain, and who has a past
ok(!(await overLoss(7)), "no losses: not over");
await lost(7, LOSS_CAP_CENTS - 1);
ok(!(await overLoss(7)), "under the day's allowance: not over");
await lost(7, 5);
ok((await overLoss(7)) && !(await overLoss(8)), "over it on that chain only");
ok(!(await hasSentFine(w(90))), "a wallet that never sent has no past");
await sentFine(w(90));
ok(await hasSentFine(w(90)), "one that sent and paid does");

// what counts as a Safe: a proxy we know on a singleton we know
const slot = (a: string) => async () => ("0x" + a.slice(2).padStart(64, "0")) as `0x${string}`;
const P150 = "0x608060405260005463a619486e60003560e01c14156024578060601b606c5260206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033";
ok(await isSafe(P150 as `0x${string}`, slot("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e")), "a Safe 1.5.0 proxy on SafeL2 1.5.0 is a Safe");
ok(!(await isSafe(P150 as `0x${string}`, slot("0x00000000000000000000000000000000000000aa"))), "the same proxy on an unknown singleton is not");
ok(!(await isSafe("0x600160005260206000f3", slot("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"))), "other code with a real singleton in slot 0 is not");
const P141 = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";
ok(await isSafe(P141 as `0x${string}`, slot("0x41675C099F32341bf84BFc5382aF534df5C7461a")), "a Safe 1.4.1 proxy on Safe 1.4.1 is a Safe");
ok(!(await isSafe("0x", slot("0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"))) && !(await isSafe(undefined, slot("0x0"))), "no code is not");

// one IP, many sends in an hour: the wallet's own cap is the only one here now
let through = 0;
for (let i = 0; i < 100; i++) if (await lets("10.0.0.3", w(1000 + i))) through++;
ok(through === 100, `100 wallets on one IP in an hour all send (${through})`);
process.exit(bad ? 1 : 0);
