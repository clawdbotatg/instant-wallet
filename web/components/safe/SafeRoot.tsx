"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { burnerKey, isXdai, plantTestBurner } from "@/lib/brand";
import { copy } from "../bits";
import { claimKey } from "@/lib/claim";
import { Claim } from "../Claim";
import { PairWedgie } from "./PairWedgie";
import { SafeApp } from "./SafeApp";

const BURNER_LATER = "iw.burnerLater"; // "Not now" (or nothing on it): this tab doesn't ask again

/** The wallet, the extension's wedgie pairing page (?pair=wedgie), or on xdai.io the old Burner Wallet's move screen. */
export function SafeRoot() {
  const [view, setView] = useState<"wallet" | "pair" | { burner: Hex } | { planted: Hex }>();
  useEffect(() => {
    // an old Burner paper wallet / link: xdai.io/#<key> is a claim
    const k = claimKey(window.location.hash);
    if (k) return void window.location.replace(`/pk#${k}`);
    if (new URLSearchParams(window.location.search).get("pair") === "wedgie") return setView("pair");
    const planted = plantTestBurner();
    if (planted) return setView({ planted });
    let later = false;
    try {
      later = sessionStorage.getItem(BURNER_LATER) === "1";
    } catch {}
    const old = isXdai() && !later ? burnerKey() : null;
    setView(old ? { burner: old } : "wallet");
  }, []);

  if (!view) return null;
  if (view === "pair") return <PairWedgie />;
  if (view === "wallet") return <SafeApp />;
  if ("planted" in view) return <Planted k={view.planted} />;
  return (
    <Claim
      burner={{
        key: view.burner,
        onDone: () => {
          try {
            sessionStorage.setItem(BURNER_LATER, "1");
          } catch {}
          setView("wallet");
        },
      }}
    />
  );
}

/** ?burner=new (previews only): the test key's address, to send a little xDAI to before reloading. */
function Planted({ k }: { k: Hex }) {
  const a = privateKeyToAccount(k).address;
  const [copied, setCopied] = useState(false);
  return (
    <div className="app">
      <div className="welcome">
        <h1>Test Burner</h1>
        <p>A fake old Burner Wallet key is saved in this browser. Send it a little xDAI on Gnosis:</p>
        <div className="recess mono">{a}</div>
        <button className="btn wide" onClick={async () => setCopied(await copy(a))}>
          {copied ? "Copied" : "Copy address"}
        </button>
        <a className="btn btn-green wide" href="/?brand=xdai">
          Funded: open the wallet
        </a>
      </div>
    </div>
  );
}
