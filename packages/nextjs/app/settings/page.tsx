"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { PageHeader } from "~~/components/AppShell";
import { currentWallet, forgetAccount, listAccounts } from "~~/utils/accounts";
import { DEFAULT_STABLE, chainId, chainLabel, factoryAddress } from "~~/utils/chain";
import {
  type AiProvider,
  type AiSettings,
  DEFAULT_AI,
  readAiSettings,
  readName,
  writeAiSettings,
  writeName,
} from "~~/utils/settings";

const PROVIDERS: { id: AiProvider; title: string; desc: string }[] = [
  { id: "off", title: "Off", desc: "No AI. Plain forms only." },
  {
    id: "anthropic",
    title: "Claude (this app's key)",
    desc: "Uses the operator's Anthropic key on the server, if one is set.",
  },
  {
    id: "openai-compatible",
    title: "Bring your own",
    desc: "Any OpenAI-compatible endpoint: OpenAI, Venice, Ollama, LM Studio…",
  },
];

export default function SettingsPage() {
  const router = useRouter();
  const [ai, setAi] = useState<AiSettings>(DEFAULT_AI);
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  const [wallet, setWallet] = useState<string | null>(null);
  useEffect(() => {
    setAi(readAiSettings());
    setName(readName());
    setWallet(currentWallet());
  }, []);

  const save = () => {
    writeAiSettings(ai);
    writeName(name);
    setSaved(true);
    setTimeout(() => setSaved(false), 1200);
  };

  return (
    <div className="max-w-md mx-auto lg:max-w-2xl lg:pt-8 pb-10">
      <PageHeader title="Settings" back={wallet ? `/w/${wallet}` : "/"} desktop />
      <div className="px-5 flex flex-col gap-4">
        <div className="card p-5">
          <h3 className="font-bold text-[1.05rem]">You</h3>
          <label className="block mt-3">
            <div className="text-sm text-muted mb-1">First name (for the greeting)</div>
            <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="Austin" />
          </label>
        </div>

        <div className="card p-5">
          <h3 className="font-bold text-[1.05rem]">Talk to your wallet</h3>
          <p className="text-muted text-sm mt-1">
            Optional. The model can read your balance and activity and propose a transfer; it never signs. You confirm
            on a key.
          </p>
          <div className="mt-3 flex flex-col gap-2">
            {PROVIDERS.map(p => (
              <label
                key={p.id}
                className={`flex items-start gap-3 rounded-2xl border px-4 py-3 cursor-pointer ${ai.provider === p.id ? "border-ink bg-white" : "border-line"}`}
              >
                <input
                  type="radio"
                  name="provider"
                  className="mt-1 accent-ink"
                  checked={ai.provider === p.id}
                  onChange={() => setAi({ ...ai, provider: p.id })}
                />
                <div>
                  <div className="font-semibold">{p.title}</div>
                  <div className="text-muted text-sm">{p.desc}</div>
                </div>
              </label>
            ))}
          </div>
          {ai.provider === "openai-compatible" && (
            <div className="mt-3 flex flex-col gap-2">
              <input
                className="input mono text-sm"
                placeholder="Base URL, e.g. https://api.openai.com/v1"
                value={ai.baseUrl}
                onChange={e => setAi({ ...ai, baseUrl: e.target.value.trim() })}
              />
              <input
                className="input mono text-sm"
                placeholder="API key"
                type="password"
                value={ai.apiKey}
                onChange={e => setAi({ ...ai, apiKey: e.target.value.trim() })}
              />
              <input
                className="input mono text-sm"
                placeholder="Model, e.g. gpt-4.1-mini"
                value={ai.model}
                onChange={e => setAi({ ...ai, model: e.target.value.trim() })}
              />
              <p className="text-xs text-muted">
                Stored in this browser only and sent with each request. Never saved on the server.
              </p>
            </div>
          )}
        </div>

        <button className="btn btn-primary w-full" onClick={save}>
          {saved ? "Saved" : "Save"}
        </button>

        <div className="card p-5">
          <h3 className="font-bold text-[1.05rem]">This app</h3>
          <div className="text-sm text-muted mt-2 flex flex-col gap-1">
            <div>
              Chain: <span className="text-ink font-semibold">{chainLabel}</span> ({chainId})
            </div>
            <div className="mono text-xs break-all">Factory {factoryAddress ?? "—"}</div>
            <div className="mono text-xs break-all">USDC {DEFAULT_STABLE?.address ?? "—"}</div>
          </div>
          <div className="mt-4 text-sm text-muted">Wallets on this browser: {listAccounts().length}</div>
          <div className="flex gap-2 mt-3">
            <Link href="/" className="btn btn-white btn-sm">
              Switch wallet
            </Link>
            <button
              className="btn btn-white btn-sm text-coral"
              onClick={() => {
                if (
                  !confirm(
                    "Forget every wallet this browser knows? The passkeys stay in your keychain; you can sign back in.",
                  )
                )
                  return;
                for (const a of listAccounts()) forgetAccount(a.wallet, a.signerId);
                router.push("/");
              }}
            >
              Forget wallets here
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
