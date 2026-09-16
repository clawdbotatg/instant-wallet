"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Address } from "viem";
import { PageHeader } from "~~/components/AppShell";
import { type ConfirmRow, ConfirmSheet } from "~~/components/ConfirmSheet";
import { ArrowRightIcon, ChipIcon, FaceIdIcon, SparkIcon } from "~~/components/Icons";
import { useWallet } from "~~/components/WalletProvider";
import { useBiometric } from "~~/hooks/useBiometric";
import { fmtAmount, shortAddr } from "~~/utils/format";
import type { MetaAction } from "~~/utils/meta";
import { type AiSettings, aiHeaders, readAiSettings } from "~~/utils/settings";

type Proposal =
  | {
      kind: "transfer";
      asset: Address;
      to: Address;
      toName?: string;
      amount: string;
      amountFormatted: string;
      fee: string;
      symbol: string;
      decimals: number;
      description: string;
    }
  | { kind: "execute"; calls: { target: Address; value: string; data: `0x${string}` }[]; description: string };

type Msg = {
  role: "user" | "assistant";
  content: string;
  proposal?: Proposal;
  state?: "open" | "done" | "dismissed";
  txHash?: string;
};

const STARTERS = [
  "What's my balance?",
  "Who can sign for this wallet?",
  "Send 5 USDC to vitalik.eth",
  "What did I do this week?",
];

export default function ChatPage() {
  const { address, refresh } = useWallet();
  const [ai, setAi] = useState<AiSettings | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<{ idx: number; action: MetaAction; title: string; rows: ConfirmRow[] } | null>(
    null,
  );
  const bottom = useRef<HTMLDivElement>(null);
  const bio = useBiometric();
  useEffect(() => {
    setAi(readAiSettings());
  }, []);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const send = async (text: string) => {
    if (!ai || !text.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: "user", content: text.trim() }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: aiHeaders(ai),
        body: JSON.stringify({
          wallet: address,
          messages: next.slice(-12).map(m => ({ role: m.role, content: m.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || res.statusText);
      setMsgs(m => [
        ...m,
        {
          role: "assistant",
          content: data.message,
          proposal: data.proposal,
          state: data.proposal ? "open" : undefined,
        },
      ]);
    } catch (e: any) {
      setMsgs(m => [...m, { role: "assistant", content: `Something went wrong: ${e?.message || e}` }]);
    } finally {
      setBusy(false);
    }
  };

  const openProposal = (idx: number, p: Proposal) => {
    if (p.kind === "transfer") {
      const name = p.toName ?? shortAddr(p.to);
      const amt = fmtAmount(p.amount, p.decimals, p.symbol);
      setConfirm({
        idx,
        action: {
          fn: "metaTransfer",
          asset: p.asset,
          to: p.to,
          amount: BigInt(p.amount),
          fee: BigInt(p.fee),
          toName: p.toName,
          assetSymbol: p.symbol,
          assetDecimals: p.decimals,
        },
        title: `Send ${amt} to ${name}`,
        rows: [
          { label: "Amount", value: amt, mono: true },
          { label: "To", value: name },
          ...(BigInt(p.fee) > 0n ? [{ label: "Fee", value: fmtAmount(p.fee, p.decimals, p.symbol), mono: true }] : []),
        ],
      });
    } else {
      setConfirm({
        idx,
        action: {
          fn: "metaExecute",
          calls: p.calls.map(c => ({ target: c.target, value: BigInt(c.value), data: c.data })),
        },
        title: p.description,
        rows: p.calls.map((c, i) => ({
          label: `Call ${i + 1}`,
          value: `${shortAddr(c.target)} · ${c.data.slice(0, 10)}`,
          mono: true,
        })),
      });
    }
  };

  if (ai && ai.provider === "off") {
    return (
      <div className="max-w-md mx-auto lg:max-w-2xl lg:pt-8">
        <PageHeader title="Talk to your wallet" back={`/w/${address}`} desktop />
        <div className="px-5">
          <div className="card p-6 flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-mint-soft text-mint-dark flex items-center justify-center">
              <SparkIcon size={30} />
            </div>
            <p className="mt-4 text-muted">
              AI is off. Everything else works without it. Turn it on in Settings to ask questions and propose transfers
              in plain words.
            </p>
            <Link href="/settings" className="btn btn-primary mt-5">
              Open settings <ArrowRightIcon size={18} />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto lg:max-w-2xl lg:pt-8 flex flex-col min-h-[calc(100dvh-7rem)] lg:min-h-[calc(100dvh-4rem)]">
      <PageHeader title="Talk to your wallet" back={`/w/${address}`} desktop />
      <div className="px-5 flex-1 flex flex-col gap-3">
        {msgs.length === 0 && (
          <div className="card p-5">
            <div className="font-bold">Ask anything about this wallet</div>
            <p className="text-muted text-sm mt-1">
              The model reads your balance and activity and can draft a transfer. It never signs: you confirm with {bio}{" "}
              or on the device.
            </p>
            <div className="flex flex-wrap gap-2 mt-3">
              {STARTERS.map(s => (
                <button key={s} className="chip chip-gray" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[85%] ${m.role === "user" ? "bg-ink text-white rounded-[20px] rounded-br-md px-4 py-2.5" : "card px-4 py-3"}`}
            >
              <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.content}</div>
              {m.proposal && (
                <div className="mt-3 rounded-2xl bg-paper p-3">
                  <div className="text-xs text-muted font-semibold uppercase tracking-wide">Proposal</div>
                  <div className="font-bold mt-1">
                    {m.proposal.kind === "transfer"
                      ? `Send ${fmtAmount(m.proposal.amount, m.proposal.decimals, m.proposal.symbol)} to ${m.proposal.toName ?? shortAddr(m.proposal.to)}`
                      : m.proposal.description}
                  </div>
                  {m.proposal.kind === "transfer" && <div className="text-muted text-sm mono">{m.proposal.to}</div>}
                  {m.state === "done" ? (
                    <div className="mt-2 text-sm font-semibold text-mint-dark">
                      Sent{m.txHash ? ` · ${shortAddr(m.txHash, 8, 6)}` : ""}
                    </div>
                  ) : m.state === "dismissed" ? (
                    <div className="mt-2 text-sm text-muted">Dismissed</div>
                  ) : (
                    <div className="flex gap-2 mt-3">
                      <button className="btn btn-primary btn-sm flex-1" onClick={() => openProposal(i, m.proposal!)}>
                        {m.proposal.kind === "transfer" ? <FaceIdIcon size={16} /> : <ChipIcon size={16} />}
                        Confirm
                      </button>
                      <button
                        className="btn btn-white btn-sm"
                        onClick={() => setMsgs(ms => ms.map((x, j) => (j === i ? { ...x, state: "dismissed" } : x)))}
                      >
                        Not now
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="card px-4 py-3 self-start text-muted text-sm flex items-center gap-2">
            <span className="w-4 h-4 rounded-full border-2 border-line border-t-ink animate-spin" /> Thinking…
          </div>
        )}
        <div ref={bottom} />
      </div>
      <form
        className="sticky bottom-[84px] lg:bottom-4 px-5 pt-3"
        onSubmit={e => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="card flex items-center gap-2 pl-4 pr-2 py-2">
          <input
            className="flex-1 bg-transparent outline-none"
            placeholder="Send 20 USDC to atg.eth…"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={busy}
          />
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !input.trim()}>
            Send
          </button>
        </div>
      </form>
      {confirm && (
        <ConfirmSheet
          action={confirm.action}
          title={confirm.title}
          rows={confirm.rows}
          onClose={() => setConfirm(null)}
          onDone={r => {
            const idx = confirm.idx;
            setConfirm(null);
            setMsgs(ms => ms.map((x, j) => (j === idx ? { ...x, state: "done", txHash: r.txHash } : x)));
            void refresh();
          }}
        />
      )}
    </div>
  );
}
