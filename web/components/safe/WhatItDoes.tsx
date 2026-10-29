"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { short } from "@/lib/format";
import { describe } from "@/lib/safe/describe";
import type { Call } from "@/lib/safe/core";

type Field = { label: string; value: string; address?: string };
type Told = { what: string; fields: Field[] } | null;

// one ask per set of calls, kept for the page's life
const got = new Map<string, Promise<Told[] | null>>();
function ask(chainId: number, safe: Address, calls: Call[]) {
  const body = JSON.stringify({ chain: chainId, safe, calls: calls.map(c => ({ to: c.to, value: String(c.value), data: c.data })) });
  if (!got.has(body))
    got.set(
      body,
      fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body })
        .then(r => (r.ok ? r.json() : null))
        .then(j => (Array.isArray(j?.calls) ? (j.calls as Told[]) : null))
        .catch(() => null),
    );
  return got.get(body)!;
}

/** What a Safe tx does, call by call: clear signing (ERC-7730, the words the wedgie shows) where the registry has it,
 * else lib/safe/describe.ts. */
export function WhatItDoes({ chainId, safe, calls }: { chainId: number; safe: Address; calls: Call[] }) {
  const [told, setTold] = useState<Told[] | null>(null);
  const key = `${chainId}|${calls.map(c => c.to + c.data + c.value).join()}`;
  useEffect(() => {
    let live = true;
    setTold(null);
    if (calls.length) ask(chainId, safe, calls).then(t => live && setTold(t));
    return () => {
      live = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {calls.map((c, i) => {
        const t = told?.[i];
        return (
          <div key={i} className="stack" style={{ gap: 2 }}>
            <span style={{ fontSize: 15, fontWeight: t ? 600 : undefined }}>{t ? t.what : describe(chainId, safe, c)}</span>
            {t?.fields.map((f, j) => (
              <span key={j} className="fine">
                {f.label}: {f.address ? <span className="mono">{short(f.address)}</span> : f.value}
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}
