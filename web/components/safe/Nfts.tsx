"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { chainById } from "@/lib/chains";
import { loadHiddenNfts, saveHiddenNfts } from "@/lib/store";
import type { Nft } from "@/lib/types";
import { Sheet } from "../bits";

/** The wallet's NFTs as a grid under the coins; tap one to see it big (a sheet). Hide works per collection. View only (no send yet). */
export function NftGrid({ address }: { address: string }) {
  const [nfts, setNfts] = useState<Nft[] | null>(null);
  const [open, setOpen] = useState<Nft | null>(null);
  const [hidden, setHiddenState] = useState<string[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [broken, setBroken] = useState<string[]>([]); // images that failed to load: dropped from the grid
  useEffect(() => {
    setHiddenState(loadHiddenNfts());
    const load = () =>
      fetch(`/api/nfts?address=${address}`, { cache: "no-store" })
        .then(r => r.json())
        .then(j => j?.nfts && setNfts(j.nfts))
        .catch(() => {});
    load();
    window.addEventListener("instantwallet:refresh", load);
    return () => window.removeEventListener("instantwallet:refresh", load);
  }, [address]);
  const setHidden = (h: string[]) => {
    saveHiddenNfts(h);
    setHiddenState(h);
  };
  const keyOf = (n: Nft) => `${n.chainId}:${n.contract}`.toLowerCase();
  if (!nfts?.length) return null;
  const shown = nfts.filter(n => !hidden.includes(keyOf(n)));
  const hiddenOnes = nfts.filter(n => hidden.includes(keyOf(n)));
  const idOf = (n: Nft) => `${n.chainId}:${n.contract}:${n.tokenId}`;
  const grid = (list: Nft[]) => (
    <div className="nft-grid">
      {list.filter(n => !broken.includes(idOf(n))).map(n => (
        <button key={idOf(n)} className="nft" aria-label={n.name} onClick={() => setOpen(n)}>
          <img src={n.thumb} alt="" loading="lazy" onError={() => setBroken(b => [...b, idOf(n)])} />
        </button>
      ))}
    </div>
  );
  const isHidden = open && hidden.includes(keyOf(open));
  return (
    <div className="card nfts">
      {shown.length > 0 && grid(shown)}
      {hiddenOnes.length > 0 && (
        <button className="nfts-link" onClick={() => setShowHidden(!showHidden)}>
          {showHidden ? "Close hidden" : `${hiddenOnes.length} hidden`}
        </button>
      )}
      {showHidden && grid(hiddenOnes)}
      {open && createPortal(
        <Sheet onClose={() => setOpen(null)}>
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
          </div>
        </Sheet>,
        document.body,
      )}
    </div>
  );
}
