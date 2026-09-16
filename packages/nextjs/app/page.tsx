"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type Address, isAddress } from "viem";
import { AddToHomeScreenHint } from "~~/components/AddToHomeScreenHint";
import { Avatar } from "~~/components/AppShell";
import { ArrowRightIcon, FaceIdIcon, SettingsIcon } from "~~/components/Icons";
import { LogoTile } from "~~/components/Logo";
import { type StoredAccount, deviceLabel, knownSignerIds, listAccounts, saveAccount } from "~~/utils/accounts";
import { api } from "~~/utils/api";
import { chainLabel, isLocal } from "~~/utils/chain";
import { shortAddr } from "~~/utils/format";
import { type Passkey, createPasskey, credentialIdHash, isWebAuthnSupported, loginWithPasskey } from "~~/utils/passkey";

type Step =
  | { kind: "welcome" }
  | { kind: "creating"; msg: string }
  | { kind: "lookup"; passkey: Passkey; own: Address }
  | { kind: "error"; msg: string };

/**
 * Welcome. "Get started" = one passkey; the wallet's address exists from that moment
 * (Factory.getWalletAddress, the same on every chain), so we register the key with the app and go
 * straight in. Nothing is deployed until the first outbound action — the facilitator does that.
 */
export default function Welcome() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [step, setStep] = useState<Step>({ kind: "welcome" });
  const [pasted, setPasted] = useState("");
  const [supported, setSupported] = useState(true);

  useEffect(() => {
    setAccounts(listAccounts());
    setSupported(isWebAuthnSupported());
  }, []);

  const fail = (e: any) => setStep({ kind: "error", msg: e?.message || String(e) });

  const remember = (pk: Passkey, wallet: Address) =>
    saveAccount({
      wallet,
      signerId: pk.signerId,
      credentialId: pk.credentialId,
      qx: pk.qx,
      qy: pk.qy,
      label: deviceLabel(),
    });

  const getStarted = async () => {
    try {
      setStep({ kind: "creating", msg: "Creating your key…" });
      const pk = await createPasskey(deviceLabel());
      setStep({ kind: "creating", msg: "Deriving your address…" });
      const { wallet } = await api.register({
        qx: pk.qx,
        qy: pk.qy,
        kind: 0,
        credentialIdHash: credentialIdHash(pk.credentialId),
      });
      remember(pk, wallet);
      if (isLocal) {
        // play money on the local chain, straight to the counterfactual address
        await api.fund(wallet, "100").catch(() => {});
        await api.fund(wallet, "0.5", "ETH").catch(() => {});
      }
      router.push(`/w/${wallet}`);
    } catch (e) {
      fail(e);
    }
  };

  const haveKey = async () => {
    try {
      setStep({ kind: "creating", msg: "Reading your key…" });
      const known = knownSignerIds();
      const pk = await loginWithPasskey(id => known.has(id.toLowerCase()));
      const existing = listAccounts().find(a => a.signerId.toLowerCase() === pk.signerId.toLowerCase());
      if (existing) {
        router.push(`/w/${existing.wallet}`);
        return;
      }
      const { wallet, deployed, registered } = await api.predict(pk.qx, pk.qy);
      if (deployed || registered) {
        remember(pk, wallet);
        router.push(`/w/${wallet}`);
        return;
      }
      // Never seen by this app: either a key added to some other wallet later, or a brand-new
      // counterfactual wallet of its own. Let the user pick.
      setStep({ kind: "lookup", passkey: pk, own: wallet });
    } catch (e) {
      fail(e);
    }
  };

  const openOwn = async (pk: Passkey, own: Address) => {
    try {
      await api.register({ qx: pk.qx, qy: pk.qy, kind: 0, credentialIdHash: credentialIdHash(pk.credentialId) });
      remember(pk, own);
      router.push(`/w/${own}`);
    } catch (e) {
      fail(e);
    }
  };

  const attach = async (pk: Passkey) => {
    if (!isAddress(pasted)) return fail(new Error("Paste the wallet address (0x…)"));
    try {
      const snap = await api.wallet(pasted);
      if (!snap.signers.some(s => s.signerId.toLowerCase() === pk.signerId.toLowerCase())) {
        return fail(
          new Error(
            "This passkey is not a signer of that wallet. Add it from the Keys page on a device that owns the wallet.",
          ),
        );
      }
      remember(pk, snap.address);
      router.push(`/w/${snap.address}`);
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="min-h-dvh flex flex-col items-center px-5 pb-8 max-w-md mx-auto lg:max-w-lg">
      <div className="w-full flex justify-end pt-4">
        <Link
          href="/settings"
          className="w-11 h-11 rounded-full bg-white shadow-soft flex items-center justify-center"
          aria-label="Settings"
        >
          <SettingsIcon size={20} />
        </Link>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center text-center w-full">
        <LogoTile size={200} />
        <h1 className="text-[2.6rem] leading-[1.02] font-extrabold mt-8">
          Instant
          <br />
          Wallet
        </h1>
        <p className="text-muted mt-2 text-lg">Your money, instantly.</p>

        {step.kind === "lookup" && (
          <div className="card w-full p-5 mt-8 text-left">
            <div className="font-semibold">Which wallet is this key on?</div>
            <p className="text-sm text-muted mt-1">
              If this passkey was added to an existing wallet as an extra key, paste that wallet&apos;s address.
              Otherwise open the wallet this key owns on its own.
            </p>
            <input
              className="input mono mt-3"
              placeholder="0x…"
              value={pasted}
              onChange={e => setPasted(e.target.value.trim())}
            />
            <button className="btn btn-primary w-full mt-3" onClick={() => attach(step.passkey)}>
              Open that wallet
            </button>
            <button className="btn btn-white w-full mt-2" onClick={() => openOwn(step.passkey, step.own)}>
              Open my own · {shortAddr(step.own, 6, 4)}
            </button>
          </div>
        )}
        {step.kind === "creating" && (
          <div className="mt-8 flex items-center gap-3 text-muted">
            <span className="w-5 h-5 rounded-full border-2 border-line border-t-ink animate-spin" />
            {step.msg}
          </div>
        )}
        {step.kind === "error" && (
          <div className="mt-6 w-full rounded-2xl bg-coral-soft text-coral px-4 py-3 text-sm text-left">
            {step.msg}
            <button className="block mt-1 font-semibold underline" onClick={() => setStep({ kind: "welcome" })}>
              Try again
            </button>
          </div>
        )}
      </div>

      {accounts.length > 0 && step.kind === "welcome" && (
        <div className="w-full mb-4">
          <div className="text-sm text-muted mb-2 px-1">Your wallets</div>
          <div className="card divide-y divide-line">
            {accounts.map(a => (
              <Link key={a.wallet + a.signerId} href={`/w/${a.wallet}`} className="flex items-center gap-3 px-4 py-3">
                <Avatar seed={a.wallet} />
                <div className="min-w-0 flex-1 text-left">
                  <div className="font-semibold truncate">{a.label}</div>
                  <div className="mono text-xs text-muted">{shortAddr(a.wallet, 8, 6)}</div>
                </div>
                <ArrowRightIcon size={18} className="text-muted" />
              </Link>
            ))}
          </div>
        </div>
      )}

      {step.kind === "welcome" && (
        <div className="w-full flex flex-col gap-3">
          <AddToHomeScreenHint />
          <button className="btn btn-primary w-full text-[1.05rem]" onClick={getStarted} disabled={!supported}>
            <ArrowRightIcon size={20} />
            Get started
          </button>
          <button className="btn btn-white w-full text-[1.05rem]" onClick={haveKey} disabled={!supported}>
            <FaceIdIcon size={20} />I already have a key
          </button>
          <p className="text-center text-muted text-[13px] leading-snug mt-1">
            {supported ? (
              <>
                No seed phrase. No gas. Face ID makes the key and your address on {chainLabel},
                <br />a $35 device you build guards the big money.
              </>
            ) : (
              "This browser has no passkey support. Open on a phone or a laptop with Face ID / Touch ID / Windows Hello."
            )}
          </p>
        </div>
      )}
    </div>
  );
}
