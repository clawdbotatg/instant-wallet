"use client";

import { useEffect, useState } from "react";
import { formatEther } from "viem";
import { instantWalletAbi } from "@/lib/abi";
import { CHAINS, explorerAddress, publicClient } from "@/lib/chains";
import { amount, short } from "@/lib/format";
import { gasAccount } from "@/lib/gasKey";
import type { Account } from "@/lib/types";
import { isDeployed } from "@/lib/wallet";
import { ChainChip, copy } from "./bits";

type Row = { chainId: number; deployed: boolean; gasEth: bigint; guardians: readonly `0x${string}`[]; version?: string };

/** The wallet's plumbing: per chain whether it's deployed, its guardians, and the gas key's ETH. */
export function Settings({ account, toast, onSignOut }: { account: Account; toast: (m: string) => void; onSignOut: () => void }) {
  const gas = gasAccount(account.address).address;
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    Promise.all(
      CHAINS.map(async c => {
        const pc = publicClient(c.id);
        const deployed = await isDeployed(c.id, account.address).catch(() => false);
        const gasEth = await pc.getBalance({ address: gas }).catch(() => 0n);
        let guardians: readonly `0x${string}`[] = [];
        let version: string | undefined;
        if (deployed) {
          guardians = await pc.readContract({ address: account.address, abi: instantWalletAbi, functionName: "getGuardians" }).catch(() => []);
          version = await pc.readContract({ address: account.address, abi: instantWalletAbi, functionName: "version" }).catch(() => undefined);
        }
        return { chainId: c.id, deployed, gasEth, guardians, version };
      }),
    ).then(setRows);
  }, [account.address, gas]);

  return (
    <div className="stack">
      <h2>Wallet</h2>
      <div className="card stack">
        <div>
          <div className="fine">Wallet address</div>
          <button className="pill" onClick={async () => (await copy(account.address)) && toast("Copied")}>
            <span className="mono">{account.address}</span>
          </button>
        </div>
        <div>
          <div className="fine">Gas key (pays network fees, can't move your money)</div>
          <button className="pill" onClick={async () => (await copy(gas)) && toast("Copied")}>
            <span className="mono">{gas}</span>
          </button>
        </div>
      </div>
      {rows.map(r => (
        <div key={r.chainId} className="card stack" style={{ gap: 6 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <ChainChip chainId={r.chainId} />
            <span className="row fine">
              <span className={`led ${r.deployed ? "on" : ""}`} /> {r.deployed ? `deployed · v${r.version ?? "?"}` : "deploys on your first send"}
            </span>
          </div>
          <div className="fine">Gas key: {amount(formatEther(r.gasEth))} ETH</div>
          <div className="fine">
            Recovery: {r.deployed ? (r.guardians.length ? r.guardians.map(short).join(", ") : "off") : "dao.buidlguidl.eth (default)"}, 7 days to cancel
          </div>
          {explorerAddress(r.chainId, account.address) && (
            <a className="fine" href={explorerAddress(r.chainId, account.address)} target="_blank" rel="noreferrer">
              Explorer
            </a>
          )}
        </div>
      ))}
      <p className="fine">
        Your passkey is the key. If it syncs (iCloud Keychain, Google Password Manager) your wallet follows it to your other
        devices: tap “I already have one” there.
      </p>
      <button className="btn btn-red wide" onClick={onSignOut}>
        Forget this wallet on this device
      </button>
    </div>
  );
}
