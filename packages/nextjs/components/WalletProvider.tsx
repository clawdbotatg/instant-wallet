"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { type StoredAccount, passkeysFor, touchAccount } from "~~/utils/accounts";
import { type DeviceView, type WalletSnapshot, api } from "~~/utils/api";

/** Live view of one wallet: chain snapshot (polled), this browser's passkey for it, known devices. */
export type WalletCtx = {
  address: Address;
  snapshot: WalletSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  passkeys: StoredAccount[];
  /** The passkey this browser holds that is currently a signer of the wallet (if any). */
  passkey: StoredAccount | undefined;
  devices: DeviceView[];
  reloadAccounts: () => void;
};

const Ctx = createContext<WalletCtx | null>(null);

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}

export function WalletProvider({ address, children }: { address: Address; children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<WalletSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [passkeys, setPasskeys] = useState<StoredAccount[]>([]);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const inflight = useRef(false);

  const reloadAccounts = useCallback(() => setPasskeys(passkeysFor(address)), [address]);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const [snap, dev] = await Promise.all([
        api.wallet(address),
        api.devices(address).catch(() => ({ devices: [] as DeviceView[] })),
      ]);
      setSnapshot(snap);
      setDevices(dev.devices);
      setError(null);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
      inflight.current = false;
    }
  }, [address]);

  useEffect(() => {
    reloadAccounts();
    touchAccount(address);
    const onAcc = () => reloadAccounts();
    window.addEventListener("iw:accounts", onAcc);
    return () => window.removeEventListener("iw:accounts", onAcc);
  }, [address, reloadAccounts]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const passkey = useMemo(() => {
    const ids = new Set((snapshot?.signers ?? []).map(s => s.signerId.toLowerCase()));
    return passkeys.find(p => ids.has(p.signerId.toLowerCase())) ?? (snapshot ? undefined : passkeys[0]);
  }, [passkeys, snapshot]);

  const value = useMemo<WalletCtx>(
    () => ({ address, snapshot, loading, error, refresh, passkeys, passkey, devices, reloadAccounts }),
    [address, snapshot, loading, error, refresh, passkeys, passkey, devices, reloadAccounts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
