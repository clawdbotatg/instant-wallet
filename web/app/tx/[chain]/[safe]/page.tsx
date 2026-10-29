"use client";

import { useParams } from "next/navigation";
import { getAddress } from "viem";
import { TxPage, isSafeRoute } from "@/components/safe/TxPage";

/** /tx/<chain>/<safe>#<code>: one transaction other signers open, see and sign (docs/MULTI-SIGNER.md). */
export default function Page() {
  const { chain, safe } = useParams<{ chain: string; safe: string }>();
  if (!isSafeRoute(chain, safe)) return <p className="fine">That link is broken: ask for it again.</p>;
  return (
    <div className="app">
      <TxPage chainId={Number(chain)} safe={getAddress(safe)} />
    </div>
  );
}
