"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { type AppEntry, APPS } from "@/lib/apps";
import { CHAINS } from "@/lib/chains";
import { ChainSelect } from "./Pick";
import { hostApp } from "@/lib/safeapps";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { Net, ChainIcon, SwapIcon } from "../bits";

/** The Apps sheet: one row per app, what it does, its networks. Every one opens in the frame (AppFrame), never in a sheet. */
export function AppList({ onOpen }: { onOpen: (a: AppEntry) => void }) {
  const [link, setLink] = useState("");
  const custom = (() => {
    try {
      const u = new URL(link.trim().includes("://") ? link.trim() : `https://${link.trim()}`);
      return /^https?:$/.test(u.protocol) && (u.hostname.includes(".") || u.hostname === "localhost") ? u : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="stack">
      <h2>Apps</h2>
      <div className="assets apps">
        {APPS.map(a => (
          <button key={a.id} className="asset" onClick={() => onOpen(a)}>
            <div className="logo">{a.id === "swap" ? <SwapIcon /> : a.icon ? <img src={a.icon} alt="" /> : a.name.slice(0, 1)}</div>
            <div className="grow">
              <div className="sym">{a.name}</div>
              <div className="fine">{a.what}</div>
            </div>
            <div className="app-chains">
              {a.chains.slice(0, 3).map(id => (
                <ChainIcon key={id} chainId={id} size={16} />
              ))}
            </div>
          </button>
        ))}
      </div>
      <form
        className="field"
        onSubmit={e => {
          e.preventDefault();
          if (custom) onOpen({ id: "custom", name: custom.host, what: "", chains: CHAINS.map(c => c.id), url: custom.href });
        }}
      >
        <span className="fine">Any other Safe App: paste its link</span>
        <div className="input">
          <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://…" inputMode="url" autoCapitalize="off" autoCorrect="off" aria-label="Safe App link" />
          <button className="pill" disabled={!custom}>
            Open
          </button>
        </div>
      </form>
      <p className="fine">Other people&apos;s sites. Every payment and signature shows here first.</p>
    </div>
  );
}

/**
 * An app, full screen (on a wide screen: right of the wallet). A Safe App (app.url) is framed and talks to this wallet on
 * one network (it can't switch: pick another and it reloads). Swap and Revoke are ours: their screen is `children`.
 */
export function AppFrame({ app, account, states, onClose, children }: { app: AppEntry; account: SafeAccount; states: ChainState[]; onClose: () => void; children?: React.ReactNode }) {
  const [chainId, setChainId] = useState(app.chainId ?? app.chains[0]);
  const ref = useRef<HTMLIFrameElement>(null);
  const statesRef = useRef(states);
  statesRef.current = states;
  const ready = states.some(s => s.chainId === chainId);

  // wide screens show the wallet beside the app (globals.css, html.app-side)
  useEffect(() => {
    document.documentElement.classList.add("app-side");
    return () => document.documentElement.classList.remove("app-side");
  }, []);

  // listen before the frame loads: the app asks for the Safe at once and gives up after 10 ms
  useEffect(() => {
    if (!app.url || !ready || !ref.current) return;
    return hostApp(ref.current, { name: app.name, url: app.url!, icon: app.icon }, account.address, chainId, () =>
      statesRef.current.find(s => s.chainId === chainId),
    );
  }, [app.url, chainId, ready, account.address]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="appframe">
      <div className="appframe-bar">
        <b className="grow">{app.name}</b>
        {!app.url ? null : app.chains.length > 1 ? (
          <div style={{ width: 190, flex: "none" }}>
            <ChainSelect value={chainId} onChange={setChainId} only={app.chains} />
          </div>
        ) : (
          <span className="pill"><Net chainId={chainId} /></span>
        )}
        {/* red, top right: the one Close that is red (Austin 11-15). It ends the app; every other Close, Back, Done is white */}
        <button className="pill stop" onClick={onClose}>
          Close
        </button>
      </div>
      {!app.url ? (
        <div className="appframe-body">
          <div className="appframe-page">{children}</div>
        </div>
      ) : ready ? (
        <iframe
          key={chainId}
          ref={ref}
          src={app.url}
          title={app.name}
          allow="clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads"
        />
      ) : (
        <span className="loading-bar" aria-label="Loading" />
      )}
    </div>
  );
}
