"use client";

import { use } from "react";
import Link from "next/link";
import { isAddress } from "viem";
import { AppShell } from "~~/components/AppShell";
import { WalletProvider } from "~~/components/WalletProvider";

export default function WalletLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ address: string }>;
}) {
  const { address } = use(params);
  if (!isAddress(address)) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-xl font-bold">That is not a wallet address</div>
        <Link href="/" className="btn btn-primary">
          Back to start
        </Link>
      </div>
    );
  }
  return (
    <WalletProvider address={address}>
      <AppShell>{children}</AppShell>
    </WalletProvider>
  );
}
