"use client";

/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import type { WalletKitTypes } from "@reown/walletkit";
import { type Hex, decodeFunctionData, erc20Abi, formatEther, formatUnits } from "viem";
import { chainById, publicClient } from "@/lib/chains";
import { short } from "@/lib/format";
import type { Account } from "@/lib/types";
import {
  type Kit,
  type Pending,
  approve,
  approveProposal,
  disconnect,
  getKit,
  pair,
  rejectProposal,
  respondError,
  triage,
} from "@/lib/walletconnect";
import { Blockie, ChainChip, Sheet } from "./bits";
import { Scanner } from "./Scanner";
import { friendly } from "./Welcome";

type Session = { topic: string; name: string; url: string; icon?: string };

/**
 * Everything WalletConnect on screen, mounted once while a wallet is open: listens for sites, shows the
 * connect question, queues requests one at a time (calls card / sign card), and the manage sheet
 * (paste or scan a wc: link, see and drop connected sites). Opened with openWalletConnect(uri?).
 */
export function WalletConnectLayer({ account, pairUri }: { account: Account; pairUri?: string }) {
  return (
    <ConnectLayer
      address={account.address}
      pairUri={pairUri}
      request={(pending, onDone, onNo) => <Request pending={pending} account={account} onDone={onDone} onNo={onNo} />}
    />
  );
}

/**
 * The same layer for any wallet: `chainIds` = the chains sites may use (default: the sendable ones), `request`
 * draws the card for one pending request (calls or a message) and answers the site.
 */
export function ConnectLayer({
  address,
  pairUri,
  chainIds,
  request,
}: {
  address: string;
  pairUri?: string;
  chainIds?: number[];
  request: (pending: Pending, onDone: () => void, onNo: () => void) => React.ReactNode;
}) {
  const [kit, setKit] = useState<Kit | null>(null);
  const [sheet, setSheet] = useState(false);
  const [proposal, setProposal] = useState<WalletKitTypes.SessionProposal | null>(null);
  const [queue, setQueue] = useState<Pending[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refreshSessions = useCallback((k: Kit) => {
    setSessions(
      Object.values(k.getActiveSessions()).map(s => ({
        topic: s.topic,
        name: s.peer.metadata.name,
        url: s.peer.metadata.url,
        icon: s.peer.metadata.icons?.[0],
      })),
    );
  }, []);

  useEffect(() => {
    let live = true;
    let k: Kit;
    const onProposal = (p: WalletKitTypes.SessionProposal) => setProposal(p);
    const onRequest = async (e: WalletKitTypes.SessionRequest) => {
      try {
        const p = await triage(e, chainIds);
        if (p) setQueue(q => [...q, p]);
      } catch (err: any) {
        respondError(e.topic, e.id, err?.message || "Not supported", err?.code ?? 4200).catch(() => {});
      }
    };
    const onDelete = () => refreshSessions(k);
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
      if (k) {
        k.off("session_proposal", onProposal);
        k.off("session_request", onRequest);
        k.off("session_delete", onDelete);
      }
    };
  }, [address, chainIds?.join(), refreshSessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // openWalletConnect(uri?) from the scan button or a link
  useEffect(() => {
    const open = async (e: Event) => {
      const uri = (e as CustomEvent<string | undefined>).detail;
      setError(null);
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
  const done = () => setQueue(q => q.slice(1));

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
      {!proposal && current && (
        <Sheet onClose={() => (respondError(current.topic, current.id).catch(() => {}), done())}>
          <div key={`${current.topic}:${current.id}`}>
            {request(current, done, () => (respondError(current.topic, current.id).catch(() => {}), done()))}
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
              <button className="pill" onClick={() => onDrop(s.topic)}>
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
      <p className="fine">It will see your address and can ask you to approve things. Nothing moves without Face ID.</p>
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
        No
      </button>
    </div>
  );
}

/** What one call does, in words: ERC-20 approve / transfer decoded, ETH value shown, anything else by address. */
export function CallLine({ call, chainId }: { call: { target: `0x${string}`; value: bigint; data: Hex }; chainId: number }) {
  const [token, setToken] = useState<{ symbol: string; decimals: number } | null>(null);
  let decoded: { functionName: string; args: readonly unknown[] } | null = null;
  try {
    if (call.data !== "0x") decoded = decodeFunctionData({ abi: erc20Abi, data: call.data }) as any;
  } catch {}
  useEffect(() => {
    if (!decoded) return;
    const pc = publicClient(chainId);
    Promise.all([
      pc.readContract({ address: call.target, abi: erc20Abi, functionName: "symbol" }),
      pc.readContract({ address: call.target, abi: erc20Abi, functionName: "decimals" }),
    ])
      .then(([symbol, decimals]) => setToken({ symbol, decimals }))
      .catch(() => setToken(null));
  }, [call.target, chainId, decoded?.functionName]); // eslint-disable-line react-hooks/exhaustive-deps

  const amt = (v: unknown) =>
    token ? (BigInt(v as bigint) >= 2n ** 255n ? `unlimited ${token.symbol}` : `${formatUnits(v as bigint, token.decimals)} ${token.symbol}`) : String(v);

  let text: React.ReactNode;
  if (decoded?.functionName === "approve") {
    text = (
      <>
        <b>Let</b> <span className="mono">{short(String(decoded.args[0]))}</span> <b>spend</b> {amt(decoded.args[1])}
      </>
    );
  } else if (decoded?.functionName === "transfer") {
    text = (
      <>
        <b>Send</b> {amt(decoded.args[1])} <b>to</b> <span className="mono">{short(String(decoded.args[0]))}</span>
      </>
    );
  } else if (call.data === "0x") {
    text = (
      <>
        <b>Send</b> {formatEther(call.value)} ETH <b>to</b> <span className="mono">{short(call.target)}</span>
      </>
    );
  } else {
    text = (
      <>
        <b>Call</b> <span className="mono">{short(call.target)}</span> <span className="fine mono">{call.data.slice(0, 10)}</span>
        {call.value > 0n && <> with {formatEther(call.value)} ETH</>}
      </>
    );
  }
  return (
    <div className="row" style={{ alignItems: "flex-start" }}>
      <Blockie address={call.target} size={22} />
      <div className="grow" style={{ fontSize: 15 }}>
        {text}
      </div>
    </div>
  );
}

function Request({ pending, account, onDone, onNo }: { pending: Pending; account: Account; onDone: () => void; onNo: () => void }) {
  const [stage, setStage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = stage !== null;
  return (
    <div className="stack confirm">
      <DappHead {...pending.dapp} />
      {pending.kind === "calls" ? (
        <>
          <h2>{pending.calls.length > 1 ? `${pending.calls.length} steps, one Face ID` : "Approve?"}</h2>
          <div className="card stack" style={{ gap: 12 }}>
            {pending.calls.map((c, i) => (
              <CallLine key={i} call={c} chainId={pending.chainId} />
            ))}
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="fine">All or nothing</span>
            <ChainChip chainId={pending.chainId} />
          </div>
        </>
      ) : (
        <>
          <h2>Sign this?</h2>
          <div className="recess" style={{ whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto", fontSize: 14 }}>
            {pending.preview}
          </div>
          <p className="fine">Signing proves it's your wallet. It doesn't move money by itself, but read it.</p>
        </>
      )}
      {error && <p className="err">{error}</p>}
      <button
        className="btn btn-green wide"
        disabled={busy}
        onClick={async () => {
          setError(null);
          setStage("signing");
          try {
            await approve(pending, account, s => setStage(s));
            onDone();
          } catch (e) {
            setError(friendly(e));
            setStage(null);
          }
        }}
      >
        {stage === "signing" ? "Face ID…" : stage === "sending" ? "Sending…" : stage === "confirming" ? "Confirming…" : "Approve with Face ID"}
      </button>
      {!busy && (
        <button className="btn wide" onClick={onNo}>
          Reject
        </button>
      )}
      <p className="fine center">
        {chainById(pending.chainId)?.name} · from <span className="mono">{short(account.address)}</span>
      </p>
    </div>
  );
}
