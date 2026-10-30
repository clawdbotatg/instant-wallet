"use client";

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { type AppEntry, APPS } from "@/lib/apps";
import { CHAINS, chainById } from "@/lib/chains";
import { hostApp } from "@/lib/safeapps";
import type { ChainState, SafeAccount } from "@/lib/safe/state";
import { ChainIcon, SwapIcon } from "../bits";

/** The Apps sheet: one row per app, what it does, its networks. Swap opens our own sheet; the rest open in the frame. */
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
      <p className="fine">Apps other than Swap are other people&apos;s sites. They can only ask: every payment and signature shows here first.</p>
    </div>
  );
}

/** A Safe App, full screen (on a wide screen: left of the wallet), talking to this wallet on one network (a Safe App can't switch: pick another and it reloads). */
export function AppFrame({ app, account, states, onClose }: { app: AppEntry; account: SafeAccount; states: ChainState[]; onClose: () => void }) {
  const [chainId, setChainId] = useState(app.chains[0]);
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
    if (!ready || !ref.current) return;
    return hostApp(ref.current, { name: app.name, url: app.url!, icon: app.icon }, account.address, chainId, () =>
      statesRef.current.find(s => s.chainId === chainId),
    );
  }, [app.url, chainId, ready, account.address]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="appframe">
      <div className="appframe-bar">
        <button className="pill stop" onClick={onClose}>
          Close
        </button>
        <b className="grow">{app.name}</b>
        {app.chains.length > 1 ? (
          <select className="pill" value={chainId} onChange={e => setChainId(Number(e.target.value))} aria-label="Network">
            {app.chains.map(id => (
              <option key={id} value={id}>
                {chainById(id)?.name ?? id}
              </option>
            ))}
          </select>
        ) : (
          <span className="pill">{chainById(chainId)?.name}</span>
        )}
      </div>
      {ready ? (
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
