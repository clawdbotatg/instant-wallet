"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { chainById, nativeSymbol } from "@/lib/chains";
import { amount } from "@/lib/format";
import { FEE_ALLOWANCE } from "@/lib/safe/config";
import { feeAllowanceCalls, setBudgetCalls } from "@/lib/safe/core";
import { type Prepared, finishOwners, getQuote, ownerSigners, prepareOwners } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, readChain } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { TimedBar } from "../bits";
import { friendly } from "../Welcome";
import { ChainSelect } from "./Pick";
import { ErrorLine } from "./WedgieButton";

const SIGNER_NAME = { burner: "Face ID", wedgie: "wedgie", hot: "hot wallet" } as const; // who signs the change

/** The daily limit under the home screen's total, one quiet line: "daily: 80/100 USDC · 0.01/0.01 ETH  edit". */
export function LimitLine({ st, onEdit }: { st: ChainState; onEdit: () => void }) {
  const b = st.budget!;
  return (
    <div className="limits-rule">
      daily: {amount(formatUnits(b.usdc, 6))}/{amount(formatUnits(b.usdcMax, 6))} USDC · {amount(formatUnits(b.eth, 18))}/{amount(formatUnits(b.ethMax, 18))}{" "}
      {nativeSymbol(st.chainId)}
      <button className="link-edit" onClick={onEdit}>
        edit
      </button>
    </div>
  );
}

/** The daily limit sheet: pick a network (each one's limit is its own), change its limit. */
export function LimitsSheet({
  account,
  states,
  assets,
  chainId: start,
  onRefresh,
  toast,
}: {
  account: SafeAccount;
  states: ChainState[];
  assets: Asset[];
  chainId: number;
  onRefresh: () => void;
  toast: (m: string) => void;
}) {
  const [chainId, setChainId] = useState(start);
  const st = states.find(s => s.chainId === chainId);
  return (
    <div className="stack">
      <h2>Daily limit</h2>
      <ChainSelect value={chainId} onChange={setChainId} />
      {!st ? (
        <p className="fine">Loading…</p>
      ) : st.budget && st.threshold > 1 ? (
        <ChainLimit key={chainId} account={account} st={st} assets={assets} onRefresh={onRefresh} toast={toast} />
      ) : (
        <p className="fine">No daily limit on {chainById(chainId)?.name}. Face ID alone can move everything here. Pair a wedgie to get one.</p>
      )}
    </div>
  );
}

/**
 * One network's limit. Same two taps as everywhere: Save gets it ready (the wedgie connects, fee, nonce), Yes signs
 * (Face ID has to start straight from a tap), then a bar until the chain shows it.
 */
function ChainLimit({ account, st, assets, onRefresh, toast }: { account: SafeAccount; st: ChainState; assets: Asset[]; onRefresh: () => void; toast: (m: string) => void }) {
  const b = st.budget!;
  const chainId = st.chainId;
  const coin = nativeSymbol(chainId);
  const [usdcIn, setUsdcIn] = useState(formatUnits(b.usdcMax, 6));
  const [ethIn, setEthIn] = useState(formatUnits(b.ethMax, 18));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState<{ p: Prepared; usdc: bigint; eth: bigint; close: () => Promise<void> } | null>(null);
  const [wait, setWait] = useState<{ ms: number; usdc: bigint; eth: bigint } | null>(null);

  // sent: refresh until the chain read shows the new limit
  const settled = !!wait && b.usdcMax === wait.usdc && b.ethMax === wait.eth;
  useEffect(() => {
    if (!wait || busy) return;
    if (settled) {
      setWait(null);
      toast("Done");
      return;
    }
    const since = Date.now();
    const t = setInterval(() => (Date.now() - since > wait.ms + 45_000 ? setWait(null) : onRefresh()), 2_000);
    return () => clearInterval(t);
  }, [wait, settled, busy, onRefresh, toast]);

  const usdcAddr = chainById(chainId)?.usdc?.toLowerCase();
  const haveUsdc = assets.some(a => a.chainId === chainId && a.asset.toLowerCase() === usdcAddr && BigInt(a.balance) >= (chainId === 1 ? 10_000_000n : 1_000_000n));
  const haveEth = assets.some(a => a.chainId === chainId && a.asset === zeroAddress && BigInt(a.balance) > 0n);

  async function save() {
    setBusy(true);
    setError(null);
    let w: Wedgie | null = null;
    try {
      const usdc = parseUnits(usdcIn, 6);
      const eth = parseUnits(ethIn, 18);
      const fresh = await readChain(chainId, account); // a tx built for an old threshold fails on chain
      if (!fresh.budget) throw new Error("Still loading");
      const signers = ownerSigners(fresh, account);
      // the wedgie connects now, while this is still the tap (a port prompt needs one)
      w = signers.includes("wedgie") && wedgieSupported() ? await Wedgie.connect() : null;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const u = chainById(chainId)?.usdc;
      // the fee rule is set once (with the budget): re-send it only on a wallet from before it existed
      const feeApart = fresh.budget.feeUsdc === null && u ? feeAllowanceCalls(account.address, u, (await getQuote(chainId, "setup")).relayer, FEE_ALLOWANCE[chainId] ?? 1_000_000n, now) : [];
      const calls = [...setBudgetCalls(account.address, { usdc, eth }, now), ...feeApart];
      const p = await prepareOwners({ account, state: fresh, calls, signers, feeToken: haveUsdc || !haveEth ? "usdc" : "eth", setup: true, wedgie: w, label: "Change the daily limit" });
      const ww = w;
      setReady({ p, usdc, eth, close: async () => ww?.close() });
    } catch (e: any) {
      await w?.close();
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const ms = 2 * (chainById(chainId)?.chain.blockTime ?? 2_000) + 5_000;
    ready.p.opts.onStage = s => s === "sending" && setWait({ ms, usdc: ready.usdc, eth: ready.eth });
    try {
      await finishOwners(ready.p);
      setReady(null);
      onRefresh();
    } catch (e: any) {
      setWait(null);
      setError(friendly(e));
    } finally {
      await ready.close();
      setBusy(false);
    }
  }

  const fee = ready && (ready.p.opts.feeToken === "usdc" ? `${(Number(ready.p.fee.feeUsdc) / 1e6).toFixed(4)} USDC` : `${(Number(ready.p.fee.feeEth) / 1e18).toFixed(6)} ${coin}`);
  return (
    <>
      <p className="fine">
        What Face ID alone can send each day. Left today: {amount(formatUnits(b.usdc, 6))} USDC · {amount(formatUnits(b.eth, 18))} {coin}. More than that needs{" "}
        {ownerSigners(st, account).map(k => SIGNER_NAME[k]).join(" + ")}.
      </p>
      {wait ? (
        <div className="stack" style={{ gap: 6 }}>
          <p className="fine">{busy ? "Sending…" : `Waiting for ${chainById(chainId)?.name}…`}</p>
          <TimedBar ms={wait.ms} />
        </div>
      ) : ready ? (
        <div className="stack" style={{ gap: 8 }}>
          <b>
            Daily limit: {formatUnits(ready.usdc, 6)} USDC · {formatUnits(ready.eth, 18)} {coin}
          </b>
          <p className="fine">
            Fee {fee}. Signed by {ready.p.opts.signers.map(k => SIGNER_NAME[k]).join(" + ")}.
          </p>
          <button className="btn btn-green wide" onClick={sign} disabled={busy}>
            {busy ? "Signing and sending…" : "Yes"}
          </button>
          <button
            className="btn wide"
            disabled={busy}
            onClick={async () => {
              await ready.close();
              setReady(null);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <>
          <div className="input">
            <input inputMode="decimal" value={usdcIn} onChange={e => setUsdcIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
            <span className="unit">USDC</span>
          </div>
          <div className="input">
            <input inputMode="decimal" value={ethIn} onChange={e => setEthIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
            <span className="unit">{coin}</span>
          </div>
          <button className="btn btn-green wide" onClick={save} disabled={busy || !usdcIn || !ethIn}>
            {busy ? "Getting ready…" : "Save"}
          </button>
        </>
      )}
      {error && <ErrorLine text={error} />}
    </>
  );
}
