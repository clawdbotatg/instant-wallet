"use client";

import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { ETH, chainById } from "@/lib/chains";
import { claimKey } from "@/lib/claim";
import { amount, short } from "@/lib/format";
import { parse } from "@/lib/parse";
import { loadAccount } from "@/lib/safe/state";
import { Qr, copy, useToast } from "./bits";
import { SafeApp } from "./safe/SafeApp";

/**
 * A payment request opened as a web link (<origin>/ethereum:…, a phone camera's scan of a Receive QR, lib/parse.ts
 * requestLink). A wallet on this phone: it opens with Send filled in. None: what's asked, an "Open in a wallet app"
 * button (the bare ethereum: request, which MetaMask, Rainbow and others take), the address to copy, and a way to
 * make an Instant Wallet. Old v3 links (/base:0x…;0.01, /0x…, /name.eth) land here too and open Send the same way.
 */
export function PayLink() {
  const [href, setHref] = useState<string>();
  const [hasWallet, setHasWallet] = useState<boolean>();
  const [toast, setToast] = useToast();
  useEffect(() => {
    // anything else under / that isn't a page: the wallet
    // (a missing /apple-touch-icon.png parses as a name: only addresses and .eth names count)
    // an old Burner Wallet link with the key in the path (xdai.io/<key>): a claim
    const k = claimKey(window.location.pathname.replace(/^\//, ""));
    if (k) return void window.location.replace(`/pk#${k}`);
    const p = parse(window.location.href);
    if (p.kind !== "pay" || !(p.to.startsWith("0x") || p.to.endsWith(".eth"))) return void window.location.replace("/");
    setHref(window.location.href);
    setHasWallet(!!loadAccount());
  }, []);
  useEffect(() => {
    // the wallet takes over; the address bar goes back to the wallet's own
    if (hasWallet) window.history.replaceState(null, "", "/");
  }, [hasWallet]);

  if (!href || hasWallet === undefined) return null;
  if (hasWallet) return <SafeApp link={href} />;

  const p = parse(href);
  if (p.kind !== "pay") return null;
  const u = new URL(href);
  const raw = decodeURIComponent(u.pathname.replace(/^\//, "")) + u.search; // the bare request, for other wallets
  const isRequest = /^ethereum:/i.test(raw);
  const chain = p.chainId ? chainById(p.chainId) : undefined;
  const isEth = !p.asset || p.asset === ETH;
  const isUsdc = !!p.asset && p.asset.toLowerCase() === chain?.usdc?.toLowerCase();
  const symbol = isEth ? (chain?.native.symbol ?? "ETH") : isUsdc ? "USDC" : short(p.asset!);
  const amt = p.amount ?? (p.amountBase !== undefined && (isEth || isUsdc) ? formatUnits(p.amountBase, isEth ? 18 : 6) : undefined);

  return (
    <div className="app">
      <div className="welcome">
        <h1>{amt ? `Pay ${amount(amt)} ${symbol}` : "Pay"}</h1>
        <p className="fine center">
          to <span className="mono">{p.to.startsWith("0x") ? short(p.to) : p.to}</span>
          {chain && ` on ${chain.name}`}
        </p>
        {isRequest && (
          <>
            <a className="btn btn-green wide" href={raw}>
              Open in a wallet app
            </a>
            <p className="fine center">MetaMask, Rainbow and most other wallets open this with the amount filled in.</p>
            <Qr value={raw} center={p.to.startsWith("0x") ? p.to : undefined}>
              <p className="fine center" style={{ marginTop: 8 }}>Or scan it from a wallet on another device.</p>
            </Qr>
          </>
        )}
        <button className="btn wide" onClick={async () => (await copy(p.to)) && setToast("Address copied")}>
          Copy address
        </button>
        <a className="btn wide" href="/">
          Make an Instant Wallet (Face ID, no app)
        </a>
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
