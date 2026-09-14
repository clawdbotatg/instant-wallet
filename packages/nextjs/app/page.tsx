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
  | { kind: "predicted"; passkey: Passkey; wallet: Address; deployed: boolean }
  | { kind: "deploying"; passkey: Passkey; wallet: Address }
  | { kind: "lookup"; passkey: Passkey }
  | { kind: "error"; msg: string };

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

  const getStarted = async () => {
    try {
      setStep({ kind: "creating", msg: "Creating your key…" });
      const pk = await createPasskey(deviceLabel());
      setStep({ kind: "creating", msg: "Predicting your address…" });
      const { wallet, deployed } = await api.predict(pk.qx, pk.qy);
      setStep({ kind: "predicted", passkey: pk, wallet, deployed });
    } catch (e) {
      fail(e);
    }
  };

  const deploy = async (pk: Passkey, wallet: Address) => {
    try {
      setStep({ kind: "deploying", passkey: pk, wallet });
      await api.deploy({ qx: pk.qx, qy: pk.qy, kind: 0, credentialIdHash: credentialIdHash(pk.credentialId) });
      saveAccount({
        wallet,
        signerId: pk.signerId,
        credentialId: pk.credentialId,
        qx: pk.qx,
        qy: pk.qy,
        label: deviceLabel(),
      });
      if (isLocal) await api.fund(wallet, "100").catch(() => {});
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
      const { wallet, deployed } = await api.predict(pk.qx, pk.qy);
      if (deployed) {
        saveAccount({
          wallet,
          signerId: pk.signerId,
          credentialId: pk.credentialId,
          qx: pk.qx,
          qy: pk.qy,
          label: deviceLabel(),
        });
        router.push(`/w/${wallet}`);
        return;
      }
      setStep({ kind: "lookup", passkey: pk });
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
      saveAccount({
        wallet: snap.address,
        signerId: pk.signerId,
        credentialId: pk.credentialId,
        qx: pk.qx,
        qy: pk.qy,
        label: deviceLabel(),
      });
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

        {step.kind === "predicted" && (
          <div className="card w-full p-5 mt-8 text-left">
            <div className="text-sm text-muted">Your address on {chainLabel}</div>
            <div className="mono text-sm break-all mt-1">{step.wallet}</div>
            <p className="text-sm text-muted mt-3">
              {step.deployed
                ? "This wallet already exists. Open it."
                : "Known before any deposit. Create it to start receiving."}
            </p>
            <button
              className="btn btn-primary w-full mt-4"
              onClick={() => (step.deployed ? router.push(`/w/${step.wallet}`) : deploy(step.passkey, step.wallet))}
            >
              {step.deployed ? "Open wallet" : "Create wallet"}
              <ArrowRightIcon size={18} />
            </button>
          </div>
        )}
        {step.kind === "lookup" && (
          <div className="card w-full p-5 mt-8 text-left">
            <div className="font-semibold">Which wallet is this key on?</div>
            <p className="text-sm text-muted mt-1">
              This passkey was added to a wallet later, so its address is not derivable. Paste the wallet address.
            </p>
            <input
              className="input mono mt-3"
              placeholder="0x…"
              value={pasted}
              onChange={e => setPasted(e.target.value.trim())}
            />
            <button className="btn btn-primary w-full mt-3" onClick={() => attach(step.passkey)}>
              Open wallet
            </button>
          </div>
        )}
        {(step.kind === "creating" || step.kind === "deploying") && (
          <div className="mt-8 flex items-center gap-3 text-muted">
            <span className="w-5 h-5 rounded-full border-2 border-line border-t-ink animate-spin" />
            {step.kind === "creating" ? step.msg : "Creating your wallet…"}
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
                No seed phrase. No gas. Face ID makes the key,
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
