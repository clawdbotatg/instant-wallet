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
 * /claim/new: make claim cards. A card goes empty → ready → claimed:
 *   empty    its address as a QR: send money to it (any wallet; Instant Wallet's scanner reads it as a send)
 *   ready    money is on it: now the claim QR shows, to print, copy, or write to an NFC tag
 *   claimed  it held money and now it's empty
 * Each card is a fresh key, kept in this browser so you can take back what nobody claims (docs/CLAIM.md).
 */
type Card = { key: Hex; made: number; funded?: boolean };
type Bal = { usdc: bigint; eth: bigint; where: string };
const STORE = "iw.cards";
const ETH_DUST = 50_000_000_000_000n; // as the claim page: less than it costs to move

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

async function balances(addr: Address): Promise<Bal> {
  const per = await Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const [u, e] = await Promise.all([
        c.usdc ? (pc.readContract({ address: c.usdc, abi: abi.erc20, functionName: "balanceOf", args: [addr] }) as Promise<bigint>).catch(() => 0n) : 0n,
        pc.getBalance({ address: addr }).catch(() => 0n),
      ]);
      return { name: c.name, usdc: u, eth: e < ETH_DUST ? 0n : e };
    }),
  );
  const where = per
    .flatMap(p => [p.usdc > 0n && `${formatUnits(p.usdc, 6)} USDC`, p.eth > 0n && `${Number(formatUnits(p.eth, 18)).toFixed(5)} ETH`].filter(Boolean).map(x => `${x} on ${p.name}`))
    .join(", ");
  return { usdc: per.reduce((t, p) => t + p.usdc, 0n), eth: per.reduce((t, p) => t + p.eth, 0n), where };
}

export function ClaimMaker() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [bal, setBal] = useState<Record<string, Bal>>({});
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
        balances(a).then(b => {
          setBal(x => ({ ...x, [a]: b }));
          // remember it held money, so empty later = claimed (not "waiting for money")
          if ((b.usdc > 0n || b.eth > 0n) && !c.funded) {
            const next = load().map(x => (x.key === c.key ? { ...x, funded: true } : x));
            save(next);
            setCards(next);
          }
        });
      });
    run();
    const t = setInterval(() => document.hidden || run(), 5_000);
    return () => clearInterval(t);
  }, [cards]);

  if (!cards) return null;
  const update = (next: Card[]) => {
    save(next);
    setCards(next);
  };
  const add = () => update([{ key: generatePrivateKey(), made: Date.now() }, ...cards]);
  const holds = (b?: Bal) => !!b && (b.usdc > 0n || b.eth > 0n);
  const remove = (c: Card) => {
    if (holds(bal[privateKeyToAccount(c.key).address]) && !confirm("This card still holds money. Forget its key anyway? Whoever has the card can still claim it."))
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
  const anyReady = cards.some(c => holds(bal[privateKeyToAccount(c.key).address]));

  return (
    <div className="app claim-maker">
      <div className="stack noprint">
        <h1>Claim cards</h1>
        <p className="fine">Put money on a card, print it. Whoever scans it gets the money. Treat it like cash.</p>
        <div className="row" style={{ gap: 10 }}>
          <button className="btn btn-green" onClick={add}>
            New card
          </button>
          {anyReady && (
            <button className="btn" onClick={() => window.print()}>
              Print ready cards
            </button>
          )}
        </div>
      </div>
      {cards.map(c => {
        const a = privateKeyToAccount(c.key).address;
        const b = bal[a];
        const url = claimUrl(window.location.origin, c.key);
        const state = !b ? "loading" : holds(b) ? "ready" : c.funded ? "claimed" : "empty";
        return (
          <div key={c.key} className={`card stack claim-card ${state === "ready" ? "ready" : "noprint"}`}>
            {state === "loading" && <p className="fine center">…</p>}

            {state === "empty" && (
              <>
                <b>1. Put money on this card</b>
                <p className="fine">Send USDC or ETH on {CHAINS.map(x => x.name).join(" or ")} to this address. Scan it with your wallet, or copy it.</p>
                <div onClick={async () => (await copy(a)) && setToast("Address copied")} style={{ cursor: "pointer" }}>
                  <Qr value={a} center={a}>
                    <span className="mono" style={{ marginTop: 8, fontWeight: 700 }}>{short(a)}</span>
                  </Qr>
                </div>
                <p className="fine center">Waiting for money…</p>
                <div className="row" style={{ gap: 8, justifyContent: "center" }}>
                  <button className="pill" onClick={async () => (await copy(a)) && setToast("Address copied")}>
                    Copy address
                  </button>
                  <button className="pill" onClick={() => remove(c)}>
                    Delete
                  </button>
                </div>
              </>
            )}

            {state === "ready" && (
              <>
                <div className="noprint">
                  <b>2. Ready: {b!.where}</b>
                  <p className="fine">Print it, send the link, or write it to an NFC tag.</p>
                </div>
                <Qr value={url}>
                  <b style={{ marginTop: 8 }}>Scan to claim</b>
                  <span className="fine">Instant Wallet</span>
                </Qr>
                <div className="row noprint" style={{ gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
                  <button className="pill" onClick={() => window.print()}>
                    Print
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
                </div>
              </>
            )}

            {state === "claimed" && (
              <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                <span>
                  <b>Claimed</b> <span className="fine mono">{short(a)}</span>
                </span>
                <button className="pill" onClick={() => remove(c)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        );
      })}
      {toast && <div className="toast noprint">{toast}</div>}
    </div>
  );
}
