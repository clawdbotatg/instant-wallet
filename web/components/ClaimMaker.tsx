"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, formatUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAINS, publicClient } from "@/lib/chains";
import { claimUrl } from "@/lib/claim";
import { short } from "@/lib/format";
import { abi } from "@/lib/safe/core";
import { Qr, copy, useToast } from "./bits";

/**
 * /claim/new: make claim cards. Each is a fresh key, kept in this browser so you can take back what nobody claimed
 * (open its link yourself). Fund it by sending USDC (or ETH) to its address, then print the QR, copy the link, or
 * write it to an NFC tag (Android Chrome; on an iPhone, write the link with an NFC app).
 */
type Card = { key: Hex; made: number; note?: string };
const STORE = "iw.cards";

function load(): Card[] {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "[]");
  } catch {
    return [];
  }
}
function save(cards: Card[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(cards));
  } catch {}
}

async function balances(addr: Address): Promise<string> {
  const parts = await Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const [u, e] = await Promise.all([
        c.usdc ? (pc.readContract({ address: c.usdc, abi: abi.erc20, functionName: "balanceOf", args: [addr] }) as Promise<bigint>).catch(() => 0n) : 0n,
        pc.getBalance({ address: addr }).catch(() => 0n),
      ]);
      return [u > 0n && `${formatUnits(u, 6)} USDC`, e > 0n && `${Number(formatUnits(e, 18)).toFixed(5)} ETH`]
        .filter(Boolean)
        .map(x => `${x} on ${c.name}`);
    }),
  );
  return parts.flat().join(", ") || "empty";
}

export function ClaimMaker() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [bal, setBal] = useState<Record<string, string>>({});
  const [toast, setToast] = useToast();
  const [nfc, setNfc] = useState(false);

  useEffect(() => {
    setCards(load());
    setNfc("NDEFReader" in window);
  }, []);

  useEffect(() => {
    if (!cards?.length) return;
    const run = () =>
      cards.forEach(c => {
        const a = privateKeyToAccount(c.key).address;
        balances(a).then(b => setBal(x => ({ ...x, [a]: b })));
      });
    run();
    const t = setInterval(() => document.hidden || run(), 8_000);
    return () => clearInterval(t);
  }, [cards]);

  if (!cards) return null;
  const update = (next: Card[]) => {
    save(next);
    setCards(next);
  };
  const add = () => update([{ key: generatePrivateKey(), made: Date.now() }, ...cards]);
  const remove = (c: Card) => {
    const a = privateKeyToAccount(c.key).address;
    if (bal[a] && bal[a] !== "empty" && !confirm("This card still holds money. Forget its key anyway? Whoever has the card can still claim it."))
      return;
    update(cards.filter(x => x.key !== c.key));
  };
  async function writeNfc(url: string) {
    try {
      setToast("Hold a tag to the back of the phone");
      await new (window as any).NDEFReader().write({ records: [{ recordType: "url", data: url }] });
      setToast("Written to the tag");
    } catch (e: any) {
      setToast(e?.message || "Couldn't write the tag");
    }
  }

  return (
    <div className="app claim-maker">
      <div className="stack noprint">
        <h1>Claim cards</h1>
        <p className="fine">
          A card is money anyone can claim: scan it (or tap it, on an NFC tag), make a wallet, the money moves in. Send USDC or ETH to a
          card&apos;s address to fill it. Treat it like cash: whoever reads it can take it. This browser keeps the keys, so you can take back
          what nobody claims.
        </p>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-green" onClick={add}>
            New card
          </button>
          {cards.length > 0 && (
            <button className="btn" onClick={() => window.print()}>
              Print
            </button>
          )}
        </div>
      </div>
      {cards.map(c => {
        const a = privateKeyToAccount(c.key).address;
        const url = claimUrl(window.location.origin, c.key);
        return (
          <div key={c.key} className="card stack claim-card">
            <Qr value={url}>
              <b style={{ marginTop: 8 }}>Scan to claim</b>
              <span className="fine">Instant Wallet</span>
            </Qr>
            <div className="noprint stack">
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span className="mono">{short(a)}</span>
                <span className="fine">{bal[a] ?? "…"}</span>
              </div>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="pill" onClick={async () => (await copy(a)) && setToast("Address copied: send to it to fill the card")}>
                  Copy address
                </button>
                <button className="pill" onClick={async () => (await copy(url)) && setToast("Claim link copied")}>
                  Copy link
                </button>
                {nfc && (
                  <button className="pill" onClick={() => writeNfc(url)}>
                    Write NFC tag
                  </button>
                )}
                <a className="pill" href={url}>
                  Take it back
                </a>
                <button className="pill" onClick={() => remove(c)}>
                  Forget
                </button>
              </div>
            </div>
          </div>
        );
      })}
      {toast && <div className="toast noprint">{toast}</div>}
    </div>
  );
}
