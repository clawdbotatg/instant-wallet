"use client";

import dynamic from "next/dynamic";
import { useSyncExternalStore } from "react";
import { fundAsk, fundSubscribe } from "@/lib/safe/relayFund";

// loaded only when asked for: a copy on your own computer with an empty relay. Our site never asks
const FundRelay = dynamic(() => import("./FundRelay"), { ssr: false });

/** In the layout, after the page: the Fund your relay sheet draws over any sheet that is up. */
export function FundRelayHost() {
  const ask = useSyncExternalStore(fundSubscribe, fundAsk, () => null);
  return ask ? <FundRelay /> : null;
}
