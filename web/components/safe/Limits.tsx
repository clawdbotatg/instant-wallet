"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseUnits, zeroAddress } from "viem";
import { chainById, nativeSymbol } from "@/lib/chains";
import { FEE_ALLOWANCE } from "@/lib/safe/config";
import { feeAllowanceCalls, setBudgetCalls } from "@/lib/safe/core";
import { type Prepared, finishOwners, getQuote, ownerSigners, prepareOwners, signerLabel, usesWedgie } from "@/lib/safe/send";
import { type ChainState, type SafeAccount, readChain } from "@/lib/safe/state";
import { Wedgie, wedgieSupported } from "@/lib/safe/wedgie";
import type { Asset } from "@/lib/types";
import { TimedBar } from "../bits";
import { friendly } from "../Welcome";
import { ErrorLine } from "./WedgieButton";


/**
 * One network's daily limit editor (settings, opened by the pencil on the limit line). Same two taps as everywhere: Save gets it ready (the wedgie connects, fee, nonce), Yes signs
 * (Face ID has to start straight from a tap), then a bar until the chain shows it.
 */
export function ChainLimit({ account, st, assets, onRefresh, toast, onClose }: { account: SafeAccount; st: ChainState; assets: Asset[]; onRefresh: () => void; toast: (m: string) => void; onClose: () => void }) {
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
      onClose();
      return;
    }
    const since = Date.now();
    const t = setInterval(() => (Date.now() - since > wait.ms + 45_000 ? setWait(null) : onRefresh()), 2_000);
    return () => clearInterval(t);
  }, [wait, settled, busy, onRefresh, toast, onClose]);

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
      w = usesWedgie(account, fresh, signers) && wedgieSupported() ? await Wedgie.connect() : null;
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
      {wait ? (
        <div className="stack" style={{ gap: 6 }}>
          <p className="fine">{busy ? "Sending…" : `Waiting for ${chainById(chainId)?.name}…`}</p>
          <TimedBar ms={wait.ms} />
        </div>
      ) : ready ? (
        <div className="stack" style={{ gap: 8 }}>
          <b>
            New daily limit: {formatUnits(ready.usdc, 6)} USDC + {formatUnits(ready.eth, 18)} {coin}
          </b>
          <p className="fine">
            Fee {fee}. Signed by {signerLabel(account, ready.p.opts.state, ready.p.opts.signers)}.
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
          <button className="btn wide" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </>
      )}
      {error && <ErrorLine text={error} />}
    </>
  );
}
