"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeader } from "~~/components/AppShell";
import { SendPanel } from "~~/components/SendPanel";
import { useWallet } from "~~/components/WalletProvider";

function SendInner() {
  const { address } = useWallet();
  const router = useRouter();
  const q = useSearchParams();
  return (
    <div className="max-w-md mx-auto lg:max-w-lg lg:pt-8">
      <PageHeader title="Send" back={`/w/${address}`} desktop />
      <SendPanel
        variant="page"
        initialTo={q.get("to") ?? ""}
        initialAmount={q.get("amount") ?? ""}
        onSent={() => router.push(`/w/${address}`)}
      />
    </div>
  );
}

export default function SendPage() {
  return (
    <Suspense>
      <SendInner />
    </Suspense>
  );
}
