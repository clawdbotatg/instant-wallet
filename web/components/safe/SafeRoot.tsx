"use client";

import { useEffect, useState } from "react";
import { PairWedgie } from "./PairWedgie";
import { SafeApp } from "./SafeApp";

/** The wallet, or the extension's wedgie pairing page (?pair=wedgie). */
export function SafeRoot() {
  const [pair, setPair] = useState(false);
  useEffect(() => setPair(new URLSearchParams(window.location.search).get("pair") === "wedgie"), []);
  return pair ? <PairWedgie /> : <SafeApp />;
}
