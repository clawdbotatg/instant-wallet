"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { chainById } from "@/lib/chains";
import { loadHiddenNfts, saveHiddenNfts } from "@/lib/store";
import type { Nft } from "@/lib/types";
import { TimedBar, useSheetBack } from "../bits";

/** The wallet's NFTs: a grid, tap one to see it big. Loads only when opened. Hide works per collection. View only (no send yet). */
export function Nfts({ address }: { address: string }) {
  const [nfts, setNfts] = useState<Nft[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<Nft | null>(null);
  const [hidden, setHiddenState] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  useSheetBack(open ? () => setOpen(null) : null);
  useEffect(() => {
    setHiddenState(loadHiddenNfts());
    fetch(`/api/nfts?address=${address}`, { cache: "no-store" })
      .then(r => r.json())
      .then(j => (j?.nfts ? setNfts(j.nfts) : setFailed(true)))
      .catch(() => setFailed(true));
  }, [address]);
  const setHidden = (h: string[]) => {
    saveHiddenNfts(h);
    setHiddenState(h);
  };
  const keyOf = (n: Nft) => `${n.chainId}:${n.contract}`.toLowerCase();

  if (open) {
    const isHidden = hidden.includes(keyOf(open));
    return (
      <div className="stack">
        <img className="nft-big" src={open.image} alt={open.name} />
        <div>
          <h2>{open.name}</h2>
          <p className="fine">
            {open.collection} · {chainById(open.chainId)?.name}
            {open.type === "ERC1155" && open.balance !== "1" ? ` · ${open.balance} of them` : ""}
          </p>
        </div>
        <button
          className="btn wide"
          onClick={() => {
            setHidden(isHidden ? hidden.filter(k => k !== keyOf(open)) : [...hidden, keyOf(open)]);
            setOpen(null);
          }}
        >
          {isHidden ? "Show this collection" : "Hide this collection"}
        </button>
        <button className="pill" style={{ justifySelf: "center" }} onClick={() => setOpen(null)}>
          Back
        </button>
      </div>
    );
  }

  const shown = (nfts ?? []).filter(n => !hidden.includes(keyOf(n)));
  const hiddenOnes = (nfts ?? []).filter(n => hidden.includes(keyOf(n)));
  const grid = (list: Nft[]) => (
    <div className="nft-grid">
      {list.map(n => (
        <button key={`${n.chainId}:${n.contract}:${n.tokenId}`} className="nft" aria-label={n.name} onClick={() => setOpen(n)}>
          <img src={n.thumb} alt="" loading="lazy" />
        </button>
      ))}
    </div>
  );
  return (
    <div className="stack">
      <h2>NFTs</h2>
      {!nfts && !failed && <TimedBar ms={8_000} />}
      {failed && <p className="fine">Couldn&apos;t load NFTs. Close and try again.</p>}
      {nfts && shown.length === 0 && <p className="fine">No NFTs.</p>}
      {shown.length > 0 && grid(shown)}
      {hiddenOnes.length > 0 && (
        <button className="pill" style={{ justifySelf: "center" }} onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? "Close hidden" : `${hiddenOnes.length} hidden`}
        </button>
      )}
      {showHidden && grid(hiddenOnes)}
    </div>
  );
}
