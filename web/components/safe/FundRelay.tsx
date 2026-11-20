"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Address, type Hex, formatEther } from "viem";
import { nativeSymbol, relayHeaders } from "@/lib/chains";
import { friendly } from "@/lib/friendly";
import { usd as fmtUsd } from "@/lib/format";
import { connectHot, hotAvailable, hotCall } from "@/lib/safe/hot";
import { type Short, fundAsk, fundSubscribe, mineOffer } from "@/lib/safe/relayFund";
import { CopyAddress, FromMine, Net, Qr, Sheet, TimedBar, Who, stageLabel } from "../bits";
import { ErrorLine } from "./WedgieButton";

/**
 * Fund your relay: a copy on your own computer whose relay can't pay for a send (lib/safe/relayFund.ts). The
 * relay's address as a QR code, what it holds (read every 3 s from the node the relay sends through), and it closes
 * itself when the money is there: the send that opened it goes on. Not made yet: Make my relay first.
 * Once, in the layout, over whatever sheet is up.
 */
export default function FundRelay() {
  const ask = useSyncExternalStore(fundSubscribe, fundAsk, () => null);
  if (!ask) return null;
  return <Fund key={`${ask.short.chainId}:${ask.short.address}`} first={ask.short} done={ask.done} />;
}

// about this much is plenty: a send costs a cent on Base, a dollar or so on Ethereum (Settings → Your relay says the same)
const plenty = (chainId: number) => (chainId === 1 ? 5 : 1);

function Fund({ first, done }: { first: Short; done: (funded: boolean) => void }) {
  const [short, setShort] = useState(first);
  const { chainId, address } = short;
  const coin = nativeSymbol(chainId);
  const [have, setHave] = useState<bigint | null>(short.have !== undefined ? BigInt(short.have) : null);
  const [busy, setBusy] = useState<"make" | "send" | null>(null);
  const [sent, setSent] = useState<Hex | null>(null);
  const [error, setError] = useState<string | null>(null);
  const need = short.need !== undefined ? BigInt(short.need) : 1n;
  const over = useRef(false);
  const end = (funded: boolean) => {
    if (over.current) return;
    over.current = true;
    done(funded);
  };

  // what the relay holds, every 3 s while this is up and the tab is seen (EXPECTATIONS #6: money sent to you shows
  // within seconds). The limit: none, it's this computer asking its own node
  useEffect(() => {
    if (!address) return;
    let live = true;
    const read = () =>
      !document.hidden &&
      fetch(`/api/local/relay?chainId=${chainId}`, { cache: "no-store", headers: relayHeaders(chainId) })
        .then(r => r.json())
        .then(j => {
          const wei = j?.balances?.[0]?.wei;
          if (live && typeof wei === "string") setHave(BigInt(wei));
        })
        .catch(() => {});
    read();
    const t = setInterval(read, 3000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [address, chainId]);
  useEffect(() => {
    if (address && have !== null && have >= need) end(true);
  }, [have, need, address]); // eslint-disable-line react-hooks/exhaustive-deps

  // no relay yet: make its key (kept on this computer), then ask what it needs here
  async function make() {
    setBusy("make");
    setError(null);
    try {
      const r = await fetch("/api/local/relay", { method: "POST" }).then(r => r.json());
      if (r.error) throw new Error(r.error);
      const q = await fetch(`/api/safe/relay?chainId=${chainId}&kind=exec`, { cache: "no-store", headers: relayHeaders(chainId) }).then(r => r.json());
      if (q?.relay?.address) {
        setShort(q.relay);
        setHave(q.relay.have !== undefined ? BigInt(q.relay.have) : null);
      } else if (q?.error) throw new Error(q.error);
      else end(true);
    } catch (e) {
      setError(friendly(e));
    }
    setBusy(null);
  }

  // one tap: your browser wallet sends it the money
  // $1 ($5 on Ethereum), or three sends' worth when gas is so high that isn't enough. The words say what is sent
  const give = short.usd ? BigInt(Math.ceil((plenty(chainId) / short.usd) * 1e18)) : 0n;
  const amount = give > need * 3n ? give : need * 3n;
  const about = short.usd ? fmtUsd((Number(amount) / 1e18) * short.usd) : `${Number(formatEther(amount)).toPrecision(2)} ${coin}`;
  const [hot, setHot] = useState(false);
  useEffect(() => setHot(hotAvailable()), []);
  async function fromMine() {
    if (!address) return;
    setBusy("send");
    setError(null);
    try {
      const who = await connectHot();
      setSent(await hotCall(chainId, who, { to: address as Address, value: amount, data: "0x" }));
    } catch (e) {
      setError(friendly(e));
    }
    setBusy(null);
  }

  const mine = mineOffer();
  const worth = short.usd && have !== null ? ` (${fmtUsd((Number(have) / 1e18) * short.usd)})` : "";
  return (
    <Sheet onClose={() => !busy && end(false)}>
      <div className="stack">
        <h2>{address ? "Fund your relay" : "Make your relay"}</h2>
        {!address ? (
          <>
            <p className="fine">It pays to execute what you sign on this computer. Each fee pays it back.</p>
            {error && <ErrorLine text={error} />}
            <button className="btn btn-green wide" onClick={make} disabled={!!busy}>
              {busy ? "Making…" : "Make my relay"}
            </button>
          </>
        ) : (
          <>
            <p className="fine row" style={{ gap: 6, flexWrap: "wrap" }}>
              It needs {coin} on <Net chainId={chainId} /> to execute. About {about}.
            </p>
            <Qr value={address} center={address}>
              <div className="row" style={{ gap: 8, marginTop: 10 }}>
                <span style={{ fontSize: 17, fontWeight: 600 }}><Who flat plain address={address} /></span>
                <CopyAddress address={address} label={null} />
              </div>
            </Qr>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="fine">It has</span>
              <span>{have === null ? "…" : `${Number(formatEther(have)).toPrecision(have === 0n ? 1 : 3)} ${coin}${worth}`}</span>
            </div>
            {sent && <TimedBar ms={chainId === 1 ? 15_000 : 5_000} />}
            {error && <ErrorLine text={error} />}
            {hot && !sent && (
              <button className="btn btn-green wide" onClick={fromMine} disabled={!!busy}>
                {busy === "send" ? stageLabel("signing-hot") : `Send ${about} from my wallet`}
              </button>
            )}
            {mine && !busy && !sent && (
              <FromMine
                onClick={() => {
                  end(false);
                  setTimeout(mine, 150); // after the send that opened this has let go of its button
                }}
              />
            )}
          </>
        )}
      </div>
    </Sheet>
  );
}
