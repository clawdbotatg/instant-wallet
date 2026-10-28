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
import { ErrorLine } from "./WedgieButton";

const SIGNER_NAME = { burner: "Face ID", wedgie: "wedgie", hot: "hot wallet" } as const; // who signs the change

/**
 * The daily limit under the home screen's total, one quiet line ("daily: 80/100 USDC · 0.01/0.01 ETH"), and an
 * "edit" that changes it right here. Same two taps as settings: Save gets it ready (the wedgie connects,
 * fee, nonce), Yes signs (Face ID has to start straight from a tap), then a bar until the chain shows it.
 */
export function Limits({ account, st, assets, onRefresh, toast }: { account: SafeAccount; st: ChainState; assets: Asset[]; onRefresh: () => void; toast: (m: string) => void }) {
  const b = st.budget!;
  const chainId = st.chainId;
  const coin = nativeSymbol(chainId);
  const [editing, setEditing] = useState(false);
  const [usdcIn, setUsdcIn] = useState("");
  const [ethIn, setEthIn] = useState("");
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
      setEditing(false);
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
    <div className="limits">
      {!editing ? (
        <div className="limits-rule">
          daily: {amount(formatUnits(b.usdc, 6))}/{amount(formatUnits(b.usdcMax, 6))} USDC · {amount(formatUnits(b.eth, 18))}/{amount(formatUnits(b.ethMax, 18))} {coin}
          <button
            className="link-edit"
            onClick={() => {
              setUsdcIn(formatUnits(b.usdcMax, 6));
              setEthIn(formatUnits(b.ethMax, 18));
              setError(null);
              setEditing(true);
            }}
          >
            edit
          </button>
        </div>
      ) : wait ? (
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
          <div className="row">
            <button
              className="btn btn-sm grow"
              disabled={busy}
              onClick={async () => {
                await ready.close();
                setReady(null);
              }}
            >
              Cancel
            </button>
            <button className="btn btn-sm btn-green grow" onClick={sign} disabled={busy}>
              {busy ? "Signing…" : "Yes"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          <div className="input">
            <input inputMode="decimal" value={usdcIn} onChange={e => setUsdcIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
            <span className="unit">USDC</span>
          </div>
          <div className="input">
            <input inputMode="decimal" value={ethIn} onChange={e => setEthIn(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} />
            <span className="unit">{coin}</span>
          </div>
          <div className="row">
            <button className="btn btn-sm grow" onClick={() => setEditing(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-sm btn-green grow" onClick={save} disabled={busy || !usdcIn || !ethIn}>
              {busy ? "Getting ready…" : "Save"}
            </button>
          </div>
        </div>
      )}
      {error && <ErrorLine text={error} />}
    </div>
  );
}

