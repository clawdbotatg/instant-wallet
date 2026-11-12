"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useRef, useState } from "react";
import type { WalletKitTypes } from "@reown/walletkit";
import { type Hex, decodeFunctionData, erc20Abi, formatEther, formatUnits } from "viem";
import { chainById, nativeSymbol, publicClient } from "@/lib/chains";
import { nativeUsd } from "@/lib/price";
import { short, usd } from "@/lib/format";
import { serveExtension } from "@/lib/extension";
import { serveApps } from "@/lib/safeapps";
import type { Account } from "@/lib/types";
import {
  type Kit,
  type Pending,
  WC_CHAIN_IDS,
  approveProposal,
  disconnect,
  getKit,
  wcKeep,
  wcWanted,
  pair,
  rejectProposal,
  respondError,
  toPending,
  triage,
} from "@/lib/walletconnect";
import { Blockie, ChainChip, Sheet, Who, useToast } from "./bits";
import { WhatItDoes } from "./safe/WhatItDoes";
import { Scanner } from "./Scanner";
import { friendly } from "@/lib/friendly";
import { bio } from "@/lib/passkey";

export type Session = { topic: string; name: string; url: string; icon?: string };

/**
 * Everything WalletConnect on screen, mounted once while a wallet is open: listens for sites, shows the
 * connect question, queues requests one at a time, and the manage sheet (paste or scan a wc: link, see and drop
 * connected sites). Opened with openWalletConnect(uri?). `chainIds` = the chains sites may use (default: the sendable ones), `request`
 * draws the card for one pending request (calls or a message) and answers the site.
 */
export function ConnectLayer({
  address,
  pairUri,
  chainIds,
  request,
  onSessions,
}: {
  address: string;
  pairUri?: string;
  chainIds?: number[];
  /** `onBusy(true)` while it signs and sends: the sheet can't be closed then */
  request: (pending: Pending, onDone: () => void, onNo: () => void, onBusy: (b: boolean) => void) => React.ReactNode;
  /** the connected sites, each time the list changes (the home page shows them) */
  onSessions?: (s: Session[]) => void;
}) {
  const [kit, setKit] = useState<Kit | null>(null);
  const [sheet, setSheet] = useState(false);
  // WalletConnect starts (and talks to its servers) only when it's needed: a site is connected, Connect is open, or
  // a wc: link came in. A wallet that never connects a site never starts it.
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (sheet || pairUri) return setOn(true);
    let live = true;
    wcWanted().then(w => live && w && setOn(true));
    return () => {
      live = false;
    };
  }, [sheet, pairUri]);
  const [proposal, setProposal] = useState<WalletKitTypes.SessionProposal | null>(null);
  const [queue, setQueue] = useState<Pending[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useToast();

  const refreshSessions = useCallback((k: Kit) => {
    const list = Object.values(k.getActiveSessions()).map(s => ({
      topic: s.topic,
      name: s.peer.metadata.name,
      url: s.peer.metadata.url,
      icon: s.peer.metadata.icons?.[0],
    }));
    setSessions(list);
    wcKeep(list.length > 0);
    onSessions?.(list);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!on) return;
    let live = true;
    let k: Kit;
    // a proposal only comes from a pairing the user started (a scan, a paste, a link): that was the yes, so connect
    // at once. Only a site WalletConnect flags (known scam, or not the domain it claims) still asks.
    const onProposal = async (p: WalletKitTypes.SessionProposal) => {
      const v = p.verifyContext?.verified;
      if (v?.isScam || v?.validation === "INVALID") return setProposal(p);
      try {
        await approveProposal(p, { address }, chainIds);
        setSheet(false);
        refreshSessions(k);
        setToast(`Connected to ${p.params.proposer.metadata.name || "the site"}`);
      } catch {
        setProposal(p); // couldn't (no shared chain, …): show the question and its error
      }
    };
    const onRequest = async (e: WalletKitTypes.SessionRequest) => {
      try {
        const p = await triage(e, chainIds);
        if (p) setQueue(q => [...q, p]);
      } catch (err: any) {
        respondError(e.topic, e.id, err?.message || "Not supported", err?.code ?? 4200).catch(() => {});
      }
    };
    const onDelete = () => k && refreshSessions(k);
    window.addEventListener("iw:wcsessions", onDelete);
    getKit()
      .then(x => {
        if (!live) return;
        k = x;
        setKit(x);
        refreshSessions(x);
        x.on("session_proposal", onProposal);
        x.on("session_request", onRequest);
        x.on("session_delete", onDelete);
      })
      .catch(e => setError(friendly(e)));
    return () => {
      live = false;
      window.removeEventListener("iw:wcsessions", onDelete);
      if (k) {
        k.off("session_proposal", onProposal);
        k.off("session_request", onRequest);
        k.off("session_delete", onDelete);
      }
    };
  }, [on, address, chainIds?.join(), refreshSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // the browser extension: sites on this computer ask through it, into the same queue (lib/extension.ts)
  useEffect(() => {
    const ids = chainIds ?? WC_CHAIN_IDS;
    return serveExtension(address, ids, r => {
      const topic = `ext:${r.rid}`;
      try {
        const dapp = { name: new URL(r.origin).host, url: r.origin, icon: r.icon };
        const p = toPending(topic, 0, r.method, r.params as any[], r.chainId, dapp, ids);
        if (!p) throw Object.assign(new Error(`${r.method} is not supported`), { code: 4200 });
        setQueue(q => [...q, p]);
      } catch (err: any) {
        respondError(topic, 0, err?.message || "Not supported", err?.code ?? 4200).catch(() => {});
      }
    });
  }, [address, chainIds?.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  // a Safe App in our frame (lib/safeapps.ts): its calls and messages, into the same queue
  useEffect(
    () =>
      serveApps(r => {
        try {
          const p = toPending(r.topic, 0, r.method, r.params as any[], r.chainId, r.dapp, chainIds ?? WC_CHAIN_IDS);
          if (!p) throw Object.assign(new Error(`${r.method} is not supported`), { code: 4200 });
          setQueue(q => [...q, p]);
        } catch (err: any) {
          respondError(r.topic, 0, err?.message || "Not supported", err?.code ?? 4200).catch(() => {});
        }
      }),
    [chainIds?.join()], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // openWalletConnect(uri?) from the scan button or a link
  useEffect(() => {
    const open = async (e: Event) => {
      const uri = (e as CustomEvent<string | undefined>).detail;
      setError(null);
      setOn(true);
      if (!uri) return setSheet(true);
      try {
        await pair(uri);
      } catch (err) {
        setSheet(true);
        setError(friendly(err));
      }
    };
    window.addEventListener("iw:walletconnect", open);
    return () => window.removeEventListener("iw:walletconnect", open);
  }, []);

  // a /wc?uri=… link: pair once the client is up
  useEffect(() => {
    if (!kit || !pairUri) return;
    pair(pairUri).catch(err => {
      setSheet(true);
      setError(friendly(err));
    });
  }, [kit, pairUri]);

  const current = queue[0];
  // signing or sending: closing the sheet then would tell the site "rejected" while the transaction still goes out
  const signing = useRef(false);
  const done = () => ((signing.current = false), setQueue(q => q.slice(1)));
  const no = (p: Pending) => {
    if (signing.current) return;
    respondError(p.topic, p.id).catch(() => {});
    done();
  };

  return (
    <>
      {sheet && !proposal && !current && (
        <Sheet onClose={() => setSheet(false)}>
          <Manage
            sessions={sessions}
            error={error}
            onPair={async uri => {
              setError(null);
              try {
                await pair(uri);
              } catch (e) {
                setError(friendly(e));
              }
            }}
            onDrop={async topic => {
              await disconnect(topic).catch(() => {});
              if (kit) refreshSessions(kit);
            }}
          />
        </Sheet>
      )}
      {proposal && (
        <Sheet onClose={() => (rejectProposal(proposal).catch(() => {}), setProposal(null))}>
          <Connect
            proposal={proposal}
            onYes={async () => {
              await approveProposal(proposal, { address }, chainIds);
              setProposal(null);
              setSheet(false);
              if (kit) refreshSessions(kit);
            }}
            onNo={() => (rejectProposal(proposal).catch(() => {}), setProposal(null))}
          />
        </Sheet>
      )}
      {toast && <div className="toast">{toast}</div>}
      {!proposal && current && (
        <Sheet onClose={() => no(current)}>
          <div key={`${current.topic}:${current.id}`}>
            {request(current, done, () => no(current), b => void (signing.current = b))}
          </div>
        </Sheet>
      )}
    </>
  );
}

export function DappHead({ name, url, icon }: { name: string; url: string; icon?: string }) {
  return (
    <div className="row">
      {icon ? <img src={icon} alt="" width={44} height={44} style={{ borderRadius: 12 }} /> : <div className="logo" />}
      <div className="grow">
        <b style={{ fontSize: 19 }}>{name || "A site"}</b>
        <div className="fine">{url.replace(/^https?:\/\//, "")}</div>
      </div>
    </div>
  );
}

function Manage({
  sessions,
  error,
  onPair,
  onDrop,
}: {
  sessions: Session[];
  error: string | null;
  onPair: (uri: string) => void;
  onDrop: (topic: string) => void;
}) {
  const [scan, setScan] = useState(false);
  const [uri, setUri] = useState("");
  return (
    <div className="stack">
      <h2>Connect to a site</h2>
      <p className="fine">On the site, pick WalletConnect and scan its QR code, or paste the link.</p>
      {scan ? (
        <Scanner
          onResult={t => {
            setScan(false);
            onPair(t.trim());
          }}
        />
      ) : (
        <button className="btn btn-green wide" onClick={() => setScan(true)}>
          Scan QR code
        </button>
      )}
      <div className="input">
        <input value={uri} onChange={e => setUri(e.target.value)} placeholder="wc:…" autoCapitalize="none" spellCheck={false} />
        <button className="pill" disabled={!uri.startsWith("wc:")} onClick={() => onPair(uri.trim())}>
          Connect
        </button>
      </div>
      {error && <p className="err">{error}</p>}
      {sessions.length > 0 && (
        <div className="card stack" style={{ gap: 10 }}>
          <b>Connected</b>
          {sessions.map(s => (
            <div key={s.topic} className="row">
              <div className="grow">
                <DappHead name={s.name} url={s.url} icon={s.icon} />
              </div>
              <button className="pill stop" onClick={() => onDrop(s.topic)}>
                Disconnect
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Connect({ proposal, onYes, onNo }: { proposal: WalletKitTypes.SessionProposal; onYes: () => Promise<void>; onNo: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = proposal.params.proposer.metadata;
  const v = proposal.verifyContext?.verified;
  const scam = v?.isScam;
  const mismatch = v?.validation === "INVALID";
  return (
    <div className="stack">
      <h2>Connect?</h2>
      <DappHead name={m.name} url={m.url} icon={m.icons?.[0]} />
      {(scam || mismatch) && (
        <p className="err">{scam ? "Known scam site. Don't connect." : "This site isn't who it says it is. Check the address."}</p>
      )}
      <p className="fine">It will see your address and can ask you to sign things. Nothing moves without {bio()}.</p>
      {error && <p className="err">{error}</p>}
      <button
        className={`btn wide ${scam ? "btn-red" : "btn-green"}`}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await onYes();
          } catch (e) {
            setError(friendly(e));
            setBusy(false);
          }
        }}
      >
        {busy ? "Connecting…" : "Connect"}
      </button>
      <button className="btn wide" onClick={onNo}>
        Reject
      </button>
    </div>
  );
}
