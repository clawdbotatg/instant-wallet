"use client";

import { useEffect, useState } from "react";
import { type Address, type Hex, parseUnits } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CHAINS } from "@/lib/chains";
import { claimUrl } from "@/lib/claim";
import { type CardBalance, cardBalances, cardsPdf, fillWithWallet, fmtUsdc } from "@/lib/claimBatch";
import { short } from "@/lib/format";
import { Qr, copy, useToast } from "./bits";

/**
 * /claim/new: make claim cards (docs/CLAIM.md). A card goes empty → ready → claimed:
 *   empty    its address as a QR: send money to it (any wallet; Instant Wallet's scanner reads it as a send)
 *   ready    money is on it: now the claim QR shows, to print, copy, or write to an NFC tag
 *   claimed  it held money and now it's empty
 * Make many = a batch (N cards × $X): fill them all at once through BuidlGuidl's splitter, then a PDF to print and cut.
 * Each card is a fresh key, kept in this browser so you can take back what nobody claims.
 */
type Card = { key: Hex; made: number; funded?: boolean; batch?: string; each?: string };
type State = "loading" | "empty" | "ready" | "claimed";
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
const addrOf = (c: Card) => privateKeyToAccount(c.key).address;
const holds = (b?: CardBalance) => !!b && (b.usdc > 0n || b.eth > 0n);
const label = (b: CardBalance) => (b.usdc > 0n ? `$${fmtUsdc(b.usdc)}` : `${(Number(b.eth) / 1e18).toFixed(4)} ETH`);

export function ClaimMaker() {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [bal, setBal] = useState<Record<string, CardBalance>>({});
  const [toast, setToast] = useToast();
  const [nfc, setNfc] = useState(false);
  const [many, setMany] = useState<{ n: string; each: string } | null>(null);
  const [busy, setBusy] = useState<{ batch: string; step: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCards(load());
    setNfc("NDEFReader" in window);
  }, []);

  const keys = cards?.map(c => c.key).join() ?? "";
  useEffect(() => {
    if (!cards?.length) return;
    const run = async () => {
      const b = await cardBalances(cards.map(addrOf)).catch(() => null);
      if (!b) return;
      setBal(b);
      // remember a card held money, so empty later = claimed (not "waiting for money")
      const newly = cards.filter(c => !c.funded && holds(b[addrOf(c)])).map(c => c.key);
      if (newly.length) {
        const next = load().map(x => (newly.includes(x.key) ? { ...x, funded: true } : x));
        save(next);
        setCards(next);
      }
    };
    run();
    const t = setInterval(() => document.hidden || run(), 6_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys, cards?.filter(c => c.funded).length]);

  if (!cards) return null;
  const update = (next: Card[]) => {
    save(next);
    setCards(next);
  };
  const stateOf = (c: Card): State => {
    const b = bal[addrOf(c)];
    return !b ? "loading" : holds(b) ? "ready" : c.funded ? "claimed" : "empty";
  };
  const add = () => update([{ key: generatePrivateKey(), made: Date.now() }, ...cards]);
  const addMany = () => {
    const n = Math.floor(Number(many?.n));
    const each = Number(many?.each);
    if (!(n >= 2 && n <= 200)) return setError("2 to 200 cards.");
    if (!(each > 0)) return setError("How much on each card?");
    const batch = String(Date.now());
    const fresh = Array.from({ length: n }, () => ({ key: generatePrivateKey(), made: Date.now(), batch, each: String(each) }));
    setError(null);
    setMany(null);
    update([...fresh, ...cards]);
  };
  const forget = (gone: Card[], what: string) => {
    if (gone.some(c => holds(bal[addrOf(c)])) && !confirm(`${what} still holds money. Forget the keys anyway? Whoever has the cards can still claim them.`)) return;
    const k = new Set(gone.map(c => c.key));
    update(cards.filter(x => !k.has(x.key)));
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
  async function pdf(list: Card[]) {
    const ready = list.filter(c => stateOf(c) === "ready");
    if (!ready.length) return setToast("No ready cards yet");
    await cardsPdf(ready.map(c => ({ url: claimUrl(window.location.origin, c.key), amount: label(bal[addrOf(c)]) })));
  }
  async function fill(batch: string, list: Card[]) {
    const todo = list.filter(c => stateOf(c) === "empty");
    if (!todo.length) return;
    setError(null);
    try {
      await fillWithWallet(todo.map(addrOf), parseUnits(todo[0].each || "0", 6), step => setBusy({ batch, step }));
      setToast(`${todo.length} cards filled`);
    } catch (e: any) {
      setError(/rejected|denied/i.test(e?.message || "") ? "Cancelled." : e?.shortMessage || e?.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  const singles = cards.filter(c => !c.batch);
  const batches = [...new Set(cards.filter(c => c.batch).map(c => c.batch!))].map(id => cards.filter(c => c.batch === id));
  const anyReady = cards.some(c => stateOf(c) === "ready");

  return (
    <div className="app claim-maker">
      <div className="stack noprint">
        <h1>Claim cards</h1>
        <p className="fine">Put money on a card, print it. Whoever scans it gets the money. Treat it like cash.</p>
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-green" onClick={add}>
            New card
          </button>
          <button className="btn" onClick={() => setMany(many ? null : { n: "10", each: "5" })}>
            Make many
          </button>
          {anyReady && (
            <button className="btn" onClick={() => pdf(cards)}>
              PDF of ready cards
            </button>
          )}
        </div>
        {many && (
          <div className="card stack">
            <div className="row" style={{ gap: 10, alignItems: "center" }}>
              <div className="input" style={{ width: 90 }}>
                <input inputMode="numeric" value={many.n} onChange={e => setMany({ ...many, n: e.target.value })} aria-label="How many cards" />
              </div>
              <span>cards ×</span>
              <div className="input" style={{ width: 110 }}>
                <input inputMode="decimal" value={many.each} onChange={e => setMany({ ...many, each: e.target.value })} aria-label="USDC on each" />
              </div>
              <span>USDC</span>
            </div>
            <button className="btn btn-green wide" onClick={addMany}>
              Make {Math.floor(Number(many.n)) || 0} cards
            </button>
          </div>
        )}
        {error && <p className="err">{error}</p>}
      </div>

      {batches.map(list => {
        const id = list[0].batch!;
        const states = list.map(stateOf);
        const count = (s: State) => states.filter(x => x === s).length;
        const empty = count("empty");
        const total = (Number(list[0].each) || 0) * empty;
        return (
          <div key={id} className="card stack noprint">
            <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
              <b>
                {list.length} cards × ${list[0].each}
              </b>
              <span className="fine">
                {count("ready")} ready · {count("claimed")} claimed{empty ? ` · ${empty} empty` : ""}
              </span>
            </div>
            {empty > 0 && (
              <>
                <p className="fine">1. Put money on them: {fmtUsdc(BigInt(Math.round(total * 1e6)))} USDC on Base, all at once with your browser wallet (BuidlGuidl&apos;s splitter, 25 cards per transaction). Or copy the addresses into split.buidlguidl.com.</p>
                <button className="btn btn-green wide" onClick={() => fill(id, list)} disabled={!!busy || count("loading") > 0}>
                  {busy?.batch === id ? busy.step : `Fill ${empty} cards with my wallet`}
                </button>
              </>
            )}
            {count("ready") > 0 && <p className="fine">2. Print them: the PDF fits business-card sheets (10 a page), or plain paper with cut lines.</p>}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {count("ready") > 0 && (
                <button className="pill" onClick={() => pdf(list)}>
                  Download PDF
                </button>
              )}
              {empty > 0 && (
                <button
                  className="pill"
                  onClick={async () =>
                    (await copy(list.filter(c => stateOf(c) === "empty").map(addrOf).join("\n"))) && setToast(`${empty} addresses copied`)
                  }
                >
                  Copy addresses
                </button>
              )}
              <button className="pill" onClick={() => forget(list, "A card in this batch")}>
                Delete
              </button>
            </div>
            <details>
              <summary className="fine">Cards</summary>
              {list.map((c, i) => {
                const s = states[i];
                const url = claimUrl(window.location.origin, c.key);
                return (
                  <div key={c.key} className="row" style={{ justifyContent: "space-between", gap: 8, padding: "6px 0" }}>
                    <span className="mono fine">
                      {i + 1}. {short(addrOf(c))}
                    </span>
                    <span className="fine">{s === "ready" ? label(bal[addrOf(c)]) : s === "loading" ? "…" : s}</span>
                    {s === "ready" && (
                      <a className="pill" href={url}>
                        Take back
                      </a>
                    )}
                  </div>
                );
              })}
            </details>
          </div>
        );
      })}

      {singles.map(c => {
        const a = addrOf(c);
        const b = bal[a];
        const url = claimUrl(window.location.origin, c.key);
        const state = stateOf(c);
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
                  <button className="pill" onClick={() => forget([c], "This card")}>
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
                  <button className="pill" onClick={() => pdf([c])}>
                    PDF
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
                <button className="pill" onClick={() => forget([c], "This card")}>
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
