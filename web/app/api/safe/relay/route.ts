import { NextRequest, NextResponse, after } from "next/server";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  concat,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  isHex,
  keccak256,
  pad,
  toEventSelector,
} from "viem";
import { MULTICALL3, MULTISEND_CALL_ONLY, ROLE_BURNER } from "@/lib/safe/config";
import {
  type SafeTx,
  abi,
  deploySafeCall,
  deploySignerCall,
  execData,
  rolesAddress,
  safeAddress,
  signedRolesCalldata,
  signerAddress,
} from "@/lib/safe/core";
import { GAS_BUDGET, type SendKind, feePaid, rolesCalls, unpackMultiSend } from "@/lib/safe/fee";
import { authCall, validAuth } from "@/lib/claim";
import { L1_ALLOWANCE, clients, nativeUsd, quote, tipFloor } from "@/lib/safe/relayCore";
import { tooMany } from "@/lib/limit";
import {
  RelayRefused,
  admit,
  checkCalls,
  forget,
  hasSentFine,
  isSafe,
  lost,
  once,
  overLoss,
  plainRecipientCheck,
  relaySend,
  reverted,
  sentFine,
  takeTurn,
} from "@/lib/safe/relayGuard";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // after the answer, waits for the receipt (Ethereum ~12 s) so a revert is caught and the wallet refused

/**
 * The relay: it submits a user's signed Safe transaction (or the burner's signed Roles spend) and pays the gas;
 * the user's own batch ends with the relay's fee. It never holds user funds and has no power over any Safe.
 *
 *   GET  /api/safe/relay?chainId=8453&kind=first      → a Quote (fee in USDC and in ETH)
 *        &extra=<gas>  a swap's own gas on top of the kind's (its route's estimate; capped by the kind's budget)
 *   POST /api/safe/relay  { chainId, kind: "exec", safe, tx, signatures, burner?: { x, y } }  (deploys the Safe / signer if missing)
 *   POST /api/safe/relay  { chainId, kind: "roles", safe, call, signer, signature, salt }
 *   POST /api/safe/relay  { chainId, kind: "claim", auths: [toWallet, fee] }  a claim card's two USDC EIP-3009 transfers
 *   → { hash }  (the client waits for the receipt itself)
 */

export async function GET(req: NextRequest) {
  try {
    const chainId = Number(req.nextUrl.searchParams.get("chainId"));
    const kind = (req.nextUrl.searchParams.get("kind") || "exec") as SendKind;
    if (!(kind in GAS_BUDGET)) return NextResponse.json({ error: "bad kind" }, { status: 400 });
    const extra = BigInt(/^\d{1,9}$/.test(req.nextUrl.searchParams.get("extra") || "") ? req.nextUrl.searchParams.get("extra")! : 0);
    return NextResponse.json(await quote(chainId, kind, extra));
  } catch (e: any) {
    // shortMessage first: viem's full message prints the RPC URL, and that has the Alchemy key in it
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: 400 });
  }
}

const hex = (v: unknown): v is Hex => typeof v === "string" && isHex(v);
const TRANSFER_EVENT = toEventSelector("Transfer(address,address,uint256)");

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }
  // before the chain reads below: a refused caller shouldn't cost a dozen of them each try (admit() comes after)
  if (await tooMany(req, "relay", 240, 3600)) return NextResponse.json({ error: "Too many sends from here this hour." }, { status: 429 });
  let turn: string | undefined; // this wallet's turn (one send in flight): given back when the tx lands, or here if none went out
  try {
    const chainId = Number(body.chainId);
    const { info, pc, wc } = clients(chainId);
    const me = wc.account.address;
    const plain = plainRecipientCheck(
      a => (a.toLowerCase() === me.toLowerCase() ? Promise.resolve(undefined) : pc.getCode({ address: a }).catch(() => "0xfe" as Hex)),
      a => pc.getStorageAt({ address: a, slot: "0x0" }).catch(() => undefined),
    );
    // a claim card has no Safe: its own key is the one rate-limited and refused after a revert
    if (body.kind === "claim" && validAuth(body.auths?.[0]) && isAddress(body.auths[0].from)) body.safe = body.auths[0].from;
    if (!isAddress(body.safe)) throw new Error("safe?");
    const safe = getAddress(body.safe);
    let to: Address;
    let data: Hex;
    let paid: { usdc: bigint; eth: bigint };
    let kind: SendKind;
    let swap = false;
    let fresh = false; // the wallet isn't deployed yet: this send would make it
    let sentKey: string; // one submission per signed tx, whatever bytes come after its signatures

    if (body.kind === "exec") {
      const t = body.tx;
      if (!t || !isAddress(t.to) || !hex(t.data) || !hex(body.signatures)) throw new Error("tx?");
      const tx: SafeTx = { to: getAddress(t.to), value: BigInt(t.value), data: t.data, operation: Number(t.operation) as 0 | 1, nonce: BigInt(t.nonce) };
      if (tx.to !== MULTISEND_CALL_ONLY || tx.operation !== 1 || tx.value !== 0n) throw new Error("only Instant Wallet batches");
      const inner = unpackMultiSend(tx.data);
      const checked = await checkCalls(safe, inner, plain, true);
      swap = checked.swap;
      const dapp = checked.dapp;
      paid = feePaid(inner, me, info.usdc);
      // a level change (deploys Roles or the wedgie's signers) gets the bigger gas budget
      const setup = !swap && !dapp && inner.some(c => c.data !== "0x" && !c.data.toLowerCase().startsWith("0xa9059cbb")); // any wallet change
      const exec = execData(tx, body.signatures);
      // the tx alone, not its signatures: a Safe ignores bytes after them, so six paddings of one signed tx were six
      // different bodies, all sent (audit IW-10)
      sentKey = `tx:${chainId}:${keccak256(concat([safe, execData(tx, "0x")]))}`;
      // the burner's signer contract must exist before Safe checks its signature: deploy it in the same transaction
      // (a new phone after a recovery, or the very first send)
      const k = body.burner ?? body.deploy;
      const pre: { to: Address; data: Hex }[] = [];
      // a P-256 key is two 32-byte numbers; anything else (a watched wallet's "0x") isn't one
      const key = !!k && hex(k.x) && hex(k.y) && k.x.length === 66 && k.y.length === 66;
      if (key) {
        const sc = await pc.getCode({ address: signerAddress(k.x, k.y) });
        if (!sc || sc === "0x") pre.push(deploySignerCall(k.x, k.y));
      }
      const code = await pc.getCode({ address: safe });
      if (!code || code === "0x") {
        // first send on this chain: deploy the Safe from the first setup (the burner's own address), then run the tx
        if (!key) throw new Error("this wallet isn't deployed here yet: send its key");
        const signer = signerAddress(k.x, k.y);
        if (safeAddress(signer) !== safe) throw new Error("that key doesn't make this address");
        pre.push(deploySafeCall(signer));
        fresh = true;
      } else if (!(await isSafe(code, () => pc.getStorageAt({ address: safe, slot: "0x0" })))) {
        // any other contract can answer "true" to execTransaction and pay nothing (audit IW-1)
        throw new RelayRefused("The relay only sends for a Safe wallet.", 400);
      }
      if (pre.length) {
        const calls = [...pre, { to: safe, data: exec }];
        to = MULTICALL3;
        data = encodeFunctionData({
          abi: abi.multicall3,
          functionName: "aggregate3",
          args: [calls.map(c => ({ target: c.to, allowFailure: false, callData: c.data }))],
        });
        kind = setup ? "first-setup" : swap ? "first-swap" : dapp ? "first-dapp" : "first";
      } else {
        to = safe;
        data = exec;
        kind = setup
          ? "setup"
          : swap
            ? body.wedgie ? "swap-wedgie" : "swap"
            : dapp
              ? body.wedgie ? "dapp-wedgie" : "dapp"
              : body.wedgie ? "exec-wedgie" : "exec";
      }
      if (dapp) swap = true; // from here `swap` only means "a revert may be honest": a site's price can move too
    } else if (body.kind === "roles") {
      if (!hex(body.call) || !hex(body.signature) || !hex(body.salt) || !isAddress(body.signer)) throw new Error("role call?");
      const inner = rolesCalls(body.call, ROLE_BURNER);
      await checkCalls(safe, inner, plain);
      paid = feePaid(inner, me, info.usdc);
      to = rolesAddress(safe);
      // a call to an address with no code "succeeds" and does nothing: the wallet must be a Safe with its Roles
      // module deployed (audit IW-2)
      const [safeCode, rolesCode] = await Promise.all([pc.getCode({ address: safe }), pc.getCode({ address: to })]);
      if (!rolesCode || rolesCode === "0x" || !(await isSafe(safeCode, () => pc.getStorageAt({ address: safe, slot: "0x0" }))))
        throw new RelayRefused("This wallet has no daily limit set up on this network.", 400);
      sentKey = `tx:${chainId}:${keccak256(concat([safe, body.call, body.salt, getAddress(body.signer)]))}`;
      data = signedRolesCalldata(body.call, getAddress(body.signer), body.signature, body.salt);
      kind = "roles";
    } else if (body.kind === "claim") {
      // only USDC transfers from the card's key: everything to one wallet, the fee to the relay (lib/claim.ts)
      const [main, fee] = body.auths ?? [];
      if (body.auths.length !== 2 || !validAuth(main) || !validAuth(fee) || !info.usdc) throw new Error("claim?");
      if (!isAddress(main.to) || getAddress(fee.from) !== safe) throw new Error("claim?");
      if (getAddress(fee.to) !== me || getAddress(main.to) === me) throw new Error("the fee goes to the relay, the rest to a wallet");
      if (BigInt(main.value) === 0n) throw new Error("nothing to claim");
      if (main.nonce.toLowerCase() === fee.nonce.toLowerCase()) throw new Error("claim?");
      const usdcAddr = getAddress(info.usdc);
      paid = { usdc: BigInt(fee.value), eth: 0n };
      sentKey = `tx:${chainId}:claim:${safe}:${main.nonce.toLowerCase()}`;
      to = MULTICALL3;
      data = encodeFunctionData({
        abi: abi.multicall3,
        functionName: "aggregate3",
        args: [[main, fee].map(a => ({ target: usdcAddr, allowFailure: false, callData: authCall(a) }))],
      });
      kind = "claim";
    } else throw new Error("kind?");

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "?";
    await admit(ip, safe);
    // a swap or a site's call runs code the relay can't read, and can fail on chain after passing here. Once that has
    // cost a day's allowance on this chain, those are sent only for wallets that have sent and paid before
    if (swap && (await overLoss(chainId)) && !(await hasSentFine(safe)))
      throw new RelayRefused("The relay is only sending swaps and sites' requests for wallets that have sent before today. Send something first, or try tomorrow.", 429);
    const myTurn = `fly:${chainId}:${safe}`;
    await takeTurn(myTurn);
    turn = myTurn;

    // the fee must cover this send at today's gas price, with the same margins as the quote (+ L1 data on L2s)
    const q = await quote(chainId, kind);
    // the fees this send will really carry, worked out before the estimate: the estimate used a tip of 1 wei, the
    // send didn't, and a contract could tell the two apart (pass here, fail on chain: audit IW-9)
    const floor = tipFloor(chainId);
    const fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { gasPrice: bigint } | null = await pc
      .estimateFeesPerGas()
      .then((f: any) => {
        if (f?.maxFeePerGas !== undefined && f?.maxPriorityFeePerGas !== undefined) {
          const tip = f.maxPriorityFeePerGas > floor ? f.maxPriorityFeePerGas : floor;
          return { maxPriorityFeePerGas: tip, maxFeePerGas: f.maxFeePerGas - f.maxPriorityFeePerGas + tip };
        }
        return f?.gasPrice !== undefined ? { gasPrice: f.gasPrice as bigint } : null;
      })
      .catch(e => {
        if (floor) throw e; // Ethereum: never send without its tip floor
        return null; // elsewhere, as before: the node's own fees at send
      });
    // a load-balanced RPC can be a block behind the client's last read (a deposit, the previous send): retry once
    // estimate at the real fee (a contract can behave differently when tx.gasprice is 0), and never above the budget
    const estimate = () => pc.estimateGas({ account: me, to, data, ...(fees ?? { maxFeePerGas: BigInt(q.gasPrice), maxPriorityFeePerGas: 1n }) });
    const gas = await estimate()
      .catch(() => new Promise(r => setTimeout(r, 3000)).then(estimate))
      .catch((e: any) => {
        throw new Error(`it would fail on chain: ${e?.shortMessage || e?.message || e}`);
      });
    if (gas > GAS_BUDGET[kind]) throw new RelayRefused("That's bigger than a normal Instant Wallet send.", 400);
    const l1 = chainId === 1 ? 0n : L1_ALLOWANCE;
    const costEth = (gas * BigInt(q.gasPrice) * 105n) / 100n + l1; // gas price may tick up a little before inclusion
    const costUsdc = BigInt(Math.ceil((Number(costEth) / 1e18) * q.ethUsd * 1e6));
    if (paid.eth < costEth && paid.usdc < costUsdc) {
      await forget(myTurn);
      turn = undefined;
      return NextResponse.json({ error: "fee too low", need: { feeEth: q.feeEth, feeUsdc: q.feeUsdc } }, { status: 402 });
    }

    // one submission per signed tx: a reverted Safe tx keeps its nonce, so the same body could be replayed forever
    if (!(await once(sentKey, 3600))) throw new RelayRefused("Already sent.", 409);
    const hash = await relaySend(
      chainId,
      me,
      () => pc.getTransactionCount({ address: me, blockTag: "pending" }),
      nonce => wc.sendTransaction({ to, data, gas: (gas * 13n) / 10n, nonce, chain: info.chain, ...(fees ?? {}) }),
    ).catch(async (e: any) => {
      // it surely didn't go out (the lock was busy, or the node itself said no): let the retry through, not "Already
      // sent." for an hour. A timeout or a dropped connection stays marked: that one may have gone out.
      // ("already known" is the node saying it has this very tx: it did go out.)
      const said = e?.walk?.((x: any) => x?.name === "RpcRequestError");
      if (e instanceof RelayRefused || (said && !/already known|known transaction/i.test(String(said.message)))) await forget(sentKey);
      throw e;
    });
    // answer with the hash now (the wallet shows progress, a site gets its answer); the look at how it went runs after
    turn = undefined; // it's out: the turn is given back below, once it has landed
    const feeUsdc = paid.usdc >= costUsdc ? paid.usdc : 0n; // which coin this send's fee is in
    after(async () => {
      try {
        // look every second: the wallet's next send waits for this one's turn to come back
        const rc = await pc.waitForTransactionReceipt({ hash, timeout: 55_000, pollingInterval: 1_000 }).catch(() => null);
        if (!rc) return;
        // paid? A USDC fee leaves a Transfer to the relay in the receipt. An ETH fee leaves no log: there a tx that
        // succeeded on a real Safe (checked above) ran its whole batch, the fee last (MultiSendCallOnly: all or nothing)
        const landed = rc.status === "success";
        const me32 = pad(me).toLowerCase();
        const gotUsdc = rc.logs
          .filter(l => !!info.usdc && l.address.toLowerCase() === info.usdc.toLowerCase() && l.topics[0] === TRANSFER_EVENT && l.topics[2]?.toLowerCase() === me32)
          .reduce((t, l) => t + BigInt(l.data), 0n);
        const paidUp = landed && (feeUsdc === 0n || gotUsdc >= feeUsdc);
        if (paidUp) return void (await sentFine(safe));
        // a send that landed and didn't pay is never an honest swap that slipped
        await reverted(safe, ip, landed ? false : swap, fresh);
        const wei = rc.gasUsed * rc.effectiveGasPrice + BigInt((rc as any).l1Fee ?? 0);
        await lost(chainId, (Number(wei) / 1e18) * (await nativeUsd(chainId).catch(() => q.ethUsd)) * 100);
      } catch {
        // the look is bookkeeping: it must never throw into the platform
      } finally {
        await forget(myTurn);
      }
    });
    return NextResponse.json({ hash });
  } catch (e: any) {
    if (turn) await forget(turn); // nothing went out: the wallet's turn is free again
    return NextResponse.json({ error: e?.shortMessage || e?.message || String(e) }, { status: e instanceof RelayRefused ? e.status : 400 });
  }
}
