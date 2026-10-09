"use client";

import { useState } from "react";
import { type Address, type Hash, formatUnits, zeroAddress } from "viem";
import { chainById, explorerTx, nativeSymbol } from "@/lib/chains";
import { amount as fmtAmount, usd } from "@/lib/format";
import { transfer } from "@/lib/safe/core";
import {
  type FeeToken,
  type Prepared,
  finishOwners,
  getQuote,
  ownerSigners,
  prepareOwners,
  sendKind,
} from "@/lib/safe/send";
import { Parked } from "@/lib/safe/pending";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { AddressInput, TokenIcon } from "../bits";
import { friendly } from "../Welcome";

// each token past the first adds a transfer to the batch: quote that much more gas
const PER_TOKEN_GAS = 45_000n;

type Row = {
  stage: "idle" | "preparing" | "ready" | "busy" | "done" | "parked";
  prepared?: Prepared;
  net?: Record<string, bigint>;
  hash?: Hash;
  error?: string;
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
  const [rows, setRows] = useState<Record<number, Row>>({});
  const set = (chainId: number, r: Row) =>
    setRows((x) => ({ ...x, [chainId]: r }));
  const chains = [...new Set(assets.map((a) => a.chainId))];
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
      if (r.prepared.opts.signers.includes("wedgie") && wedgieSupported()) {
        wedgie = await Wedgie.connect();
        r.prepared.opts.wedgie = wedgie;
      }
      const hash = await finishOwners(r.prepared);
      set(chainId, { ...r, stage: "done", hash });
    } catch (e: any) {
      if (e instanceof Parked) set(chainId, { ...r, stage: "parked" });
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
          onChange={(a) => (setTo(a), setRows({}))}
        />
        {self && <span className="err">That&apos;s this wallet.</span>}
      </div>
      {chains.length === 0 && <p className="fine">Nothing to send.</p>}
      {chains.map((chainId) => {
        const r = rows[chainId] ?? { stage: "idle" };
        const held = assets.filter((a) => a.chainId === chainId);
        const fee =
          r.prepared &&
          (r.prepared.opts.feeToken === "usdc"
            ? `${fmtAmount(formatUnits(BigInt(r.prepared.fee.feeUsdc), 6))} USDC`
            : `${fmtAmount(formatUnits(BigInt(r.prepared.fee.feeEth), 18))} ${nativeSymbol(chainId)}`);
        const url = r.hash && explorerTx(chainId, r.hash);
        return (
          <div key={chainId} className="card stack">
            <b>{chainById(chainId)?.name}</b>
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
                    <span>
                      {fmtAmount(formatUnits(n > 0n ? n : 0n, a.decimals))}{" "}
                      <span className="fine">
                        {a.price
                          ? usd(
                              Number(formatUnits(n > 0n ? n : 0n, a.decimals)) *
                                a.price,
                            )
                          : ""}
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
            {held.length > 5 && (
              <span className="fine">
                {held.length} tokens · scroll to see all
              </span>
            )}
            {fee && <span className="fine">Fee {fee}</span>}
            {r.error && <p className="err">{r.error}</p>}
            {r.stage === "done" ? (
              <p className="fine">
                ✓ Sent{" "}
                {url && (
                  <a href={url} target="_blank" rel="noreferrer">
                    view
                  </a>
                )}
              </p>
            ) : r.stage === "parked" ? (
              <p className="fine">
                Signed here. Press A on your wedgie on your computer to send it.
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
                    ? "Sending…"
                    : r.stage === "ready"
                      ? `Sign to send all on ${chainById(chainId)?.name}`
                      : `Send all on ${chainById(chainId)?.name}`}
              </button>
            )}
          </div>
        );
      })}
      <button className="btn wide" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
