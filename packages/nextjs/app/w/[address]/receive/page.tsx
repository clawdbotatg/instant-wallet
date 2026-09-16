"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { PageHeader } from "~~/components/AppShell";
import { CheckIcon, CopyIcon } from "~~/components/Icons";
import { useWallet } from "~~/components/WalletProvider";
import { api } from "~~/utils/api";
import { chainLabel, isLocal, isTestnet } from "~~/utils/chain";

export default function ReceivePage() {
  const { address, snapshot, refresh } = useWallet();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="max-w-md mx-auto lg:pt-8">
      <PageHeader title="Receive" back={`/w/${address}`} desktop />
      <div className="px-5">
        <div className="card p-6 flex flex-col items-center text-center">
          <div className="rounded-2xl p-3 bg-white border border-line">
            <QRCodeSVG value={address} size={220} level="M" fgColor="#1a1b1a" />
          </div>
          <div className="mt-5 font-bold">Send ETH or any token on {chainLabel}</div>
          <div className="mono text-[13px] text-muted break-all mt-2 leading-relaxed">{address}</div>
          <button className="btn btn-primary w-full mt-5" onClick={copy}>
            {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
            {copied ? "Copied" : "Copy address"}
          </button>
          <p className="text-muted text-sm mt-4">
            Same address on every chain and every step of the ladder
            {snapshot && !snapshot.deployed ? " — it can receive before the contract exists" : ""}. Face ID limits are
            per asset.
          </p>
          {isTestnet && (
            <a
              className="mt-3 text-sm font-semibold text-mint-dark"
              href="https://faucet.circle.com"
              target="_blank"
              rel="noreferrer"
            >
              Get test USDC from faucet.circle.com
            </a>
          )}
          {isLocal && (
            <div className="mt-3 flex gap-4 text-sm font-semibold text-mint-dark">
              <button onClick={() => api.fund(address, "100").then(refresh)}>Mint 100 test USDC</button>
              <button onClick={() => api.fund(address, "0.5", "ETH").then(refresh)}>Send 0.5 test ETH</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
