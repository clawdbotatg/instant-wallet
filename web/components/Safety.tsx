"use client";

import { useCallback, useEffect, useState } from "react";
import { type Address, type Hex, getAddress, isAddress, parseUnits } from "viem";
import { DEFAULT_CHAIN, chainById, publicClient } from "@/lib/chains";
import {
  type QueuedAction,
  type Safety as SafetyState,
  IMPL_32,
  ROLE_OWNER,
  cancelCalls,
  cancelRecoveryCalls,
  coldSetupCalls,
  describeCall,
  freezeCalls,
  rawPublicKey,
  readSafety,
  removeSignerCalls,
  runCalls,
  skipAndRunCalls,
  standInKey,
  unfreezeCalls,
  upgradeCalls,
} from "@/lib/cold";
import { short } from "@/lib/format";
import type { Account } from "@/lib/types";
import { type Call, type KeySigner, sendCalls } from "@/lib/wallet";
import { friendly } from "./Welcome";

const DAO: Address = "0xeF899e80aA814ab8D8e232f9Ed6403A633C727ec";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const left = (until: number, now: number) => {
  const s = Math.max(0, until - now);
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Parse a wedgie public key: "wedgie:0xqx:0xqy", "0xqx,0xqy", or 128 hex chars. */
export function parseWedgieKey(t: string): { qx: Hex; qy: Hex } | null {
  const h = t.replace(/^wedgie:/i, "").replace(/[\s,:]/g, "").replace(/0x/gi, "");
  if (!/^[0-9a-f]{128}$/i.test(h)) return null;
  return { qx: `0x${h.slice(0, 64)}`, qy: `0x${h.slice(64)}` };
}

/**
 * The wallet's safety: keys, limits, the cold wait, freeze, guardians, and the queue of waiting actions with a
 * countdown and Cancel / Skip / Run. `signer` is who signs here: the passkey (main app) or the wedgie (/wedgie).
 */
export function Safety({ account, signer, who }: { account: Account; signer?: KeySigner; who: "passkey" | "wedgie" }) {
  const chainId = DEFAULT_CHAIN.id;
  const now = useNow();
  const [s, setS] = useState<SafetyState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const me = signer?.signerId ?? account.signerId;
  const [implReady, setImplReady] = useState(true);
  useEffect(() => {
    publicClient(chainId)
      .getCode({ address: IMPL_32 })
      .then(c => setImplReady(!!c && c !== "0x"))
      .catch(() => {});
  }, [chainId]);

  const refresh = useCallback(() => {
    readSafety(chainId, account.address).then(setS).catch(e => setError(friendly(e)));
  }, [chainId, account.address]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  async function run(label: string, calls: Call[]) {
    setBusy(label);
    setError(null);
    try {
      await sendCalls(chainId, account, calls, { signer, onStage: () => {} });
      refresh();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  if (!s) return <p className="fine">Loading…</p>;
  const mine = s.signers.find(x => x.id.toLowerCase() === me.toLowerCase());
  const amOwner = mine?.role === ROLE_OWNER;
  const v32 = s.version.startsWith("3.2");
  const frozen = s.frozenUntil > now;
  const mode = !s.deployed ? "Not deployed yet" : s.coldDelay === 0 ? "Simple (no wait)" : s.noTwoKeySkip ? "Vault" : "Cold storage";

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <b>{mode}</b>
          <span className="fine">v{s.version || "—"}</span>
        </div>
        {s.coldDelay > 0 && <span className="fine">An owner acting alone waits {left(now + s.coldDelay, now)}. Both keys together: instant{s.noTwoKeySkip ? " (off: Vault)" : ""}.</span>}
        <span className="fine">
          You are signing here as the <b>{who}</b> ({mine ? (amOwner ? "owner" : "limited key") : "not a key on this wallet"}).
        </span>
      </div>

      {frozen && (
        <div className="card stack" style={{ gap: 8, boxShadow: "0 0 0 3px var(--coral)" }}>
          <b>❄️ Frozen for {left(s.frozenUntil, now)}</b>
          <span className="fine">Nothing leaves. Lifting it early: the wedgie queues Unfreeze, then a second key skips the wait.</span>
          {amOwner && (
            <button className="btn btn-sm" disabled={!!busy} onClick={() => run("unfreeze", unfreezeCalls(account.address))}>
              {s.coldDelay ? "Queue unfreeze" : "Unfreeze"}
            </button>
          )}
        </div>
      )}

      {s.queue.length > 0 && (
        <div className="stack" style={{ gap: 10 }}>
          <b>Waiting</b>
          {s.queue.map(q => (
            <QueueCard key={q.id} q={q} s={s} me={me} now={now} wallet={account.address} busy={busy} onRun={run} />
          ))}
        </div>
      )}

      {s.recovery && (
        <div className="card stack" style={{ gap: 6 }}>
          <b>Guardian recovery pending · {left(s.recovery.executeAfter, now)}</b>
          <span className="fine">
            {s.recovery.replaces !== "0x0000000000000000000000000000000000000000" ? `Replaces ${short(s.recovery.replaces)} with ` : "Adds "}
            {short(s.recovery.newId)}, proposed by {short(s.recovery.proposer)}.
          </span>
          {amOwner && (
            <button className="btn btn-sm btn-red" disabled={!!busy} onClick={() => run("cancel recovery", cancelRecoveryCalls(account.address))}>
              Cancel recovery
            </button>
          )}
        </div>
      )}

      {s.deployed && v32 && !frozen && (
        <button className="btn wide" disabled={!!busy} onClick={() => run("freeze", freezeCalls(account.address))}>
          {busy === "freeze" ? "Freezing…" : "❄️ Freeze wallet"}
        </button>
      )}

      {s.deployed && (
        <div className="card stack" style={{ gap: 8 }}>
          <b>Keys</b>
          {s.signers.map(k => (
            <div key={k.id} className="row" style={{ justifyContent: "space-between" }}>
              <span>
                {k.kind === 1 ? "🔑 wedgie" : "📱 passkey"} <span className="mono fine">{short(k.id)}</span>
                {k.id.toLowerCase() === me.toLowerCase() && <b> · you</b>}
              </span>
              <span className="row">
                <span className="fine">
                  {k.role === ROLE_OWNER
                    ? "owner"
                    : `limit ${(s.limits[k.id] ?? []).map(l => `${Number(l.limit) / 1e6}`).join(", ") || "0"}/day`}
                </span>
                {amOwner && k.role !== ROLE_OWNER && (
                  <button className="pill" disabled={!!busy} onClick={() => run("remove", removeSignerCalls(account.address, k.id))}>
                    Remove
                  </button>
                )}
              </span>
            </div>
          ))}
          <span className="fine">
            Guardians: {s.guardians.length ? s.guardians.map(g => (g.toLowerCase() === DAO.toLowerCase() ? "dao.buidlguidl.eth" : short(g))).join(", ") : "none"} · recovery wait{" "}
            {left(now + s.recoveryDelay, now)}
          </span>
        </div>
      )}

      {implReady && s.deployed && !v32 && amOwner && (
        <button className="btn wide" disabled={!!busy} onClick={() => run("upgrade", upgradeCalls(account.address))}>
          Upgrade to 3.2.1 (adds cold storage)
        </button>
      )}

      {!implReady && <p className="fine">Cold storage isn't live on this network yet (version 3.2.1 is in review).</p>}
      {implReady && amOwner && s.coldDelay === 0 && who === "passkey" && (
        <Setup account={account} needsUpgrade={!v32} busy={busy} onRun={run} />
      )}
      {!s.deployed && <p className="fine">Your wallet deploys on its first send. Make one send, then set up cold storage.</p>}
      {busy && <p className="fine">{busy}…</p>}
      {error && <p className="err">{error}</p>}
      <p className="fine">Implementation {short(IMPL_32)} on {chainById(chainId)?.name}.</p>
    </div>
  );
}

function QueueCard({
  q,
  s,
  me,
  now,
  wallet,
  busy,
  onRun,
}: {
  q: QueuedAction;
  s: SafetyState;
  me: Address;
  now: number;
  wallet: Address;
  busy: string | null;
  onRun: (label: string, calls: Call[]) => void;
}) {
  const ready = q.executeAfter <= now;
  const mineQueued = q.proposer.toLowerCase() === me.toLowerCase();
  const isKey = s.signers.some(k => k.id.toLowerCase() === me.toLowerCase());
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <b>{ready ? "Ready" : `Waits ${left(q.executeAfter, now)}`}</b>
        <span className="fine">by {short(q.proposer)}</span>
      </div>
      {q.calls.map((c, i) => (
        <span key={i} className="fine mono" style={{ fontSize: 12 }}>
          {describeCall(wallet, c)}
        </span>
      ))}
      <div className="row" style={{ flexWrap: "wrap" }}>
        {isKey && (
          <button className="pill" disabled={!!busy} onClick={() => onRun("cancel", cancelCalls(wallet, q.id))}>
            Cancel
          </button>
        )}
        {isKey && !mineQueued && !ready && !s.noTwoKeySkip && (
          <button className="pill on" disabled={!!busy} onClick={() => onRun("skip the wait", skipAndRunCalls(wallet, q))}>
            Skip the wait (both keys)
          </button>
        )}
        {ready && isKey && (
          <button className="pill on" disabled={!!busy} onClick={() => onRun("run", runCalls(wallet, q))}>
            Run it now
          </button>
        )}
      </div>
    </div>
  );
}

function Setup({
  account,
  needsUpgrade,
  busy,
  onRun,
}: {
  account: Account;
  needsUpgrade: boolean;
  busy: string | null;
  onRun: (label: string, calls: Call[]) => void;
}) {
  const [key, setKey] = useState("");
  const [limit, setLimit] = useState("100");
  const [wait, setWait] = useState(10); // minutes: test wallets
  const [recWait, setRecWait] = useState(10);
  const [guardian, setGuardian] = useState<string>(DAO);
  const [vault, setVault] = useState(false);
  const wk = parseWedgieKey(key);
  const usdc = DEFAULT_CHAIN.usdc;
  const ok = !!wk && isAddress(guardian) && Number(limit) >= 0 && wait >= 5 && recWait >= 5 && !!usdc;
  return (
    <div className="card stack">
      <b>Set up cold storage</b>
      <p className="fine">One Face ID: the wedgie becomes the owner, this passkey gets a daily limit, and anything bigger waits.</p>
      <div className="field">
        <label>Wedgie public key</label>
        <div className="input">
          <input value={key} onChange={e => setKey(e.target.value)} placeholder="wedgie:0x…:0x…" spellCheck={false} />
        </div>
        <button className="pill" onClick={() => setKey(`wedgie:${rawPublicKey(standInKey()).qx}:${rawPublicKey(standInKey()).qy}`)}>
          Use this browser's stand-in wedgie (testing)
        </button>
      </div>
      <div className="field">
        <label>Passkey limit (USDC per day)</label>
        <div className="input">
          <input inputMode="decimal" value={limit} onChange={e => setLimit(e.target.value.replace(/[^0-9.]/g, ""))} />
        </div>
      </div>
      <div className="field">
        <label>Wait for the wedgie alone (minutes)</label>
        <div className="row">
          {[10, 60, 2880].map(m => (
            <button key={m} className={`pill ${wait === m ? "on" : ""}`} onClick={() => setWait(m)}>
              {m === 2880 ? "48 h" : m === 60 ? "1 h" : "10 min (test)"}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Guardian</label>
        <div className="input">
          <input value={guardian} onChange={e => setGuardian(e.target.value.trim())} spellCheck={false} />
        </div>
        <div className="row">
          {[10, 10080].map(m => (
            <button key={m} className={`pill ${recWait === m ? "on" : ""}`} onClick={() => setRecWait(m)}>
              recovery {m === 10080 ? "7 d" : "10 min (test)"}
            </button>
          ))}
        </div>
      </div>
      <label className="row fine">
        <input type="checkbox" checked={vault} onChange={e => setVault(e.target.checked)} /> Vault: both keys together still wait
      </label>
      <button
        className="btn btn-green wide"
        disabled={!ok || !!busy}
        onClick={() =>
          onRun(
            "set up cold storage",
            coldSetupCalls(account.address, {
              wedgie: wk!,
              passkeyId: account.signerId,
              limits: [{ asset: usdc!, limit: parseUnits(limit || "0", 6) }],
              coldDelay: wait * 60,
              guardians: [getAddress(guardian)],
              recoveryDelay: recWait * 60,
              vault,
              upgrade: needsUpgrade,
            }),
          )
        }
      >
        Set up with Face ID
      </button>
    </div>
  );
}
