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
          <div className="mt-5 font-bold">
            Send {snapshot?.token.symbol ?? "USDC"} on {chainLabel}
          </div>
          <div className="mono text-[13px] text-muted break-all mt-2 leading-relaxed">{address}</div>
          <button className="btn btn-primary w-full mt-5" onClick={copy}>
            {copied ? <CheckIcon size={20} /> : <CopyIcon size={20} />}
            {copied ? "Copied" : "Copy address"}
          </button>
          <p className="text-muted text-sm mt-4">
            Same address on every step of the ladder. Only {snapshot?.token.symbol ?? "USDC"} counts toward the Face ID
            limit.
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
            <button
              className="mt-3 text-sm font-semibold text-mint-dark"
              onClick={() => api.fund(address, "100").then(refresh)}
            >
              Mint 100 test USDC (local chain)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
