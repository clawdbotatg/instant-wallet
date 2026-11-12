"use client";

import { useEffect, useState } from "react";
import { type Address, type Hash, formatUnits, zeroAddress } from "viem";
import { chainById, explorerTx, nativeSymbol } from "@/lib/chains";
import { amount as fmtAmount, usd, feeText } from "@/lib/format";
import { rememberPaid } from "@/lib/names";
import { transfer } from "@/lib/safe/core";
import { hotAvailable } from "@/lib/safe/hot";
import {
  type FeeToken,
  type Prepared,
  type Stage,
  Shared,
  finishOwners,
  getQuote,
  ownerSigners,
  prepareOwners,
  sendKind,
  usesWedgie,
} from "@/lib/safe/send";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { AddressInput, Eject, Money, TokenIcon, stageLabel } from "../bits";
import { friendly } from "@/lib/friendly";
import { Progress } from "./Progress";
import { ErrorLine } from "./WedgieButton";
import { callsOf } from "@/lib/safe/describe";
import { WhatItDoes } from "./WhatItDoes";

// each token past the first adds a transfer to the batch: quote that much more gas
const PER_TOKEN_GAS = 45_000n;

type Row = {
  stage: "idle" | "preparing" | "ready" | "busy" | "done";
  prepared?: Prepared;
  net?: Record<string, bigint>;
  hash?: Hash;
  error?: string;
  send?: Stage; // where the send is, for the bar
};

/**
 * Send everything: every token on every network to one address. One owners transaction per network (all its tokens
 * in one batch); the fee comes out of the USDC or ETH there. First tap gets the fee, the next one signs (Face ID
 * must start straight from a tap).
 */
export function SendAll({
  account,
  assets,
  states,
  onDone,
}: {
  account: SafeAccount;
  assets: Asset[];
  states: ChainState[];
  onDone: () => void;
}) {
  const [to, setTo] = useState<Address | null>(null);
  const [toName, setToName] = useState<string | null>(null); // the name typed for it, if one was
  const [rows, setRows] = useState<Record<number, Row>>({});
  const [mine, setMine] = useState(false); // your own browser wallet sends it, not our relay
  const [canMine, setCanMine] = useState(false);
  useEffect(() => setCanMine(hotAvailable()), []);
  const set = (chainId: number, r: Row) =>
    setRows((x) => ({ ...x, [chainId]: r }));
  // a network stays listed once it's signed: emptied, it would drop out of `assets` and take "✓ Executed" with it
  const chains = [...new Set([...assets.map((a) => a.chainId), ...Object.keys(rows).map(Number).filter((id) => rows[id]?.stage === "busy" || rows[id]?.stage === "done")])];
  const self = !!to && to.toLowerCase() === account.address.toLowerCase();

  async function prepare(chainId: number) {
    const st = states.find((s) => s.chainId === chainId);
    const held = assets.filter(
      (a) => a.chainId === chainId && BigInt(a.balance) > 0n,
    );
    if (!st || !to) return;
    set(chainId, { stage: "preparing" });
    try {
      const usdcAddr = chainById(chainId)?.usdc?.toLowerCase();
      const usdcA = held.find((a) => a.asset.toLowerCase() === usdcAddr);
      const ethA = held.find((a) => a.asset === zeroAddress);
      const signers = ownerSigners(st, account);
      if (mine) {
        // no fee: every token goes out whole, the wallet that sends pays the gas
        const calls = held.map((a) => transfer(a.asset as Address, to, BigInt(a.balance)));
        const net = Object.fromEntries(held.map((a) => [a.asset, BigInt(a.balance)]));
        const prepared = await prepareOwners({ account, state: st, calls, signers, feeToken: "usdc", self: true, label: `Send everything on ${chainById(chainId)?.name}` });
        set(chainId, { stage: "ready", prepared, net });
        return;
      }
      const kind = await sendKind(account, st, "owners", signers);
      const q = await getQuote(
        chainId,
        kind,
        PER_TOKEN_GAS * BigInt(Math.max(0, held.length - 1)),
      );
      // the fee in USDC when there's enough of it, else ETH
      const feeToken: FeeToken | null =
        usdcA && BigInt(usdcA.balance) > BigInt(q.feeUsdc)
          ? "usdc"
          : ethA && BigInt(ethA.balance) > BigInt(q.feeEth)
            ? "eth"
            : null;
      if (!feeToken)
        throw new Error(
          `Not enough USDC or ${nativeSymbol(chainId)} on ${chainById(chainId)?.name} for the fee.`,
        );
      const feeAsset = feeToken === "usdc" ? usdcA! : ethA!;
      const net: Record<string, bigint> = {};
      for (const a of held)
        net[a.asset] =
          BigInt(a.balance) -
          (a === feeAsset
            ? BigInt(feeToken === "usdc" ? q.feeUsdc : q.feeEth)
            : 0n);
      const calls = held
        .filter((a) => net[a.asset] > 0n)
        .map((a) => transfer(a.asset as Address, to, net[a.asset]));
      const prepared = await prepareOwners({
        account,
        state: st,
        calls,
        signers,
        feeToken,
        quote: q,
        label: `Send everything on ${chainById(chainId)?.name}`,
      });
      set(chainId, { stage: "ready", prepared, net });
    } catch (e: any) {
      set(chainId, { stage: "idle", error: friendly(e) });
    }
  }

  async function sign(chainId: number) {
    const r = rows[chainId];
    if (!r?.prepared) return;
    set(chainId, { ...r, stage: "busy", error: undefined });
    let wedgie: Wedgie | null = null;
    try {
      if (usesWedgie(r.prepared.opts.account, r.prepared.opts.state, r.prepared.opts.signers) && wedgieSupported()) {
        wedgie = await Wedgie.connect();
        r.prepared.opts.wedgie = wedgie;
      }
      r.prepared.opts.onStage = (s, h) => setRows((x) => ({ ...x, [chainId]: { ...x[chainId], send: s, hash: h ?? x[chainId]?.hash } }));
      const hash = await finishOwners(r.prepared);
      set(chainId, { ...r, stage: "done", hash });
      if (toName && to) rememberPaid(toName, to);
    } catch (e: any) {
      if (e instanceof Shared) set(chainId, { stage: "idle" }); // its page has the sheet now
      else set(chainId, { stage: "idle", error: friendly(e) }); // get a fresh fee and nonce next time
    } finally {
      await wedgie?.close();
    }
  }

  return (
    <div className="stack">
      <h2>Send everything</h2>
      <div className="field">
        <label>To</label>
        <AddressInput
          onChange={(a, name) => (setTo(a), setToName(name ?? null), setRows({}))}
        />
        {self && <span className="err">That&apos;s this wallet.</span>}
      </div>
      {canMine && (
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={mine} onChange={(e) => (setMine(e.target.checked), setRows({}))} />
          Execute it myself (no fee, I pay gas)
        </label>
      )}
      {chains.length === 0 && <p className="fine">Nothing to send.</p>}
      {chains.map((chainId) => {
        const r = rows[chainId] ?? { stage: "idle" };
        const held = assets.filter((a) => a.chainId === chainId);
        const fee =
          r.prepared &&
          !r.prepared.opts.self &&
          feeText(r.prepared.fee, r.prepared.opts.feeToken, nativeSymbol(chainId));
        const url = r.hash && explorerTx(chainId, r.hash);
        // the same as the card you sign on Home: the batch you're about to sign, run by the simulator
        const ran = r.prepared && r.prepared.opts.state.deployed ? r.prepared.t : null;
        // what you hold: shown until the run answers, and again if it can't (never hide the coins)
        const list = (
            <div className="send-all-list">
              {held.map((a) => {
                const n = r.net?.[a.asset] ?? BigInt(a.balance);
                return (
                  <div key={a.asset} className="row" style={{ gap: 10 }}>
                    <TokenIcon
                      symbol={a.symbol}
                      asset={a.asset}
                      chainId={a.chainId}
                      logo={a.logo}
                    />
                    <span className="grow">{a.symbol}</span>
                    <Money
                      amount={formatUnits(n > 0n ? n : 0n, a.decimals)}
                      symbol={a.symbol}
                      usd={a.price ? Number(formatUnits(n > 0n ? n : 0n, a.decimals)) * a.price : null}
                      size={16}
                    />
                  </div>
                );
              })}
            </div>
        );
        return (
          <div key={chainId} className="card stack">
            <b>{chainById(chainId)?.name}</b>
            {ran ? <WhatItDoes quiet chainId={chainId} safe={account.address} calls={callsOf(ran)} tx={ran} else={list} /> : list}
            {held.length > 5 && !ran && (
              <span className="fine">
                {held.length} tokens · scroll to see all
              </span>
            )}
            {fee && <span className="fine">Fee {fee}</span>}
            {r.prepared?.opts.self && <span className="fine">No fee. Your browser wallet executes it and pays the gas.</span>}
            {r.error && <ErrorLine text={r.error} />}
            {r.stage === "done" ? (
              <p className="fine row" style={{ gap: 8, justifyContent: "space-between" }}>
                ✓ Executed {url && <Eject href={url} title="See it on the explorer" />}
              </p>
            ) : (
              <button
                className="btn btn-green wide"
                disabled={
                  !to || self || r.stage === "preparing" || r.stage === "busy"
                }
                onClick={() =>
                  r.stage === "ready" ? sign(chainId) : prepare(chainId)
                }
              >
                {r.stage === "preparing"
                  ? "Getting the fee…"
                  : r.stage === "busy"
                    ? stageLabel(r.send ?? "sending")
                    : r.stage === "ready"
                      ? `Sign to send all on ${chainById(chainId)?.name}`
                      : `Send all on ${chainById(chainId)?.name}`}
              </button>
            )}
            {r.stage === "busy" && <Progress stage={r.send ?? null} chainId={chainId} hash={r.hash} />}
          </div>
        );
      })}
      <button className="btn wide" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
