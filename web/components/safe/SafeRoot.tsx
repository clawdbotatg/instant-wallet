"use client";

import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { burnerKey, isXdai } from "@/lib/brand";
import { claimKey } from "@/lib/claim";
import { Claim } from "../Claim";
import { PairWedgie } from "./PairWedgie";
import { SafeApp } from "./SafeApp";

const BURNER_LATER = "iw.burnerLater"; // "Not now" (or nothing on it): this tab doesn't ask again

/** The wallet, the extension's wedgie pairing page (?pair=wedgie), or on xdai.io the old Burner Wallet's move screen. */
export function SafeRoot() {
  const [view, setView] = useState<"wallet" | "pair" | { burner: Hex }>();
  useEffect(() => {
    // an old Burner paper wallet / link: xdai.io/#<key> is a claim
    const k = claimKey(window.location.hash);
    if (k) return void window.location.replace(`/pk#${k}`);
    if (new URLSearchParams(window.location.search).get("pair") === "wedgie") return setView("pair");
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
