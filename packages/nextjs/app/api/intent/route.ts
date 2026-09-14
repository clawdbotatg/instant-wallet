import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { type Address, formatUnits, getAddress, isAddress, parseUnits } from "viem";
import { facilitatorFee, tokenMeta } from "~~/services/chain";
import { parseCalls } from "~~/services/relay";
import { walletSnapshot } from "~~/services/wallet";
import { activity, portfolio, price, zerionEnabled } from "~~/services/zerion";
import { chainLabel, isBase } from "~~/utils/chain";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * "Talk to your wallet" (docs/PROTOCOL.md section 7). A tool-calling loop over the wallet's own
 * data. The model can only PROPOSE a transfer or an execute; the proposal card in the UI goes
 * through the same confirm step (passkey or device) as the forms. The model never signs.
 *
 * Providers (header `x-ai-provider`):
 *   anthropic          - server ANTHROPIC_API_KEY, model ANTHROPIC_MODEL || claude-sonnet-5
 *   openai-compatible  - x-ai-base-url / x-ai-key / x-ai-model from the request, never persisted
 */

type Proposal =
  | {
      kind: "transfer";
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

type Reply = { type: "chat" | "proposal"; message: string; proposal?: Proposal; provider: string; model: string };

const SYSTEM = (
  ctx: string,
) => `You are the assistant inside Instant Wallet, a stablecoin wallet on ${chainLabel} secured by passkeys (Face ID / Touch ID) and an optional hardware device.
Be brief and concrete. Amounts are in the wallet's token (USDC, 6 decimals). Every transfer also pays a small facilitator fee.
You cannot move money. When the user wants to send, call proposeTransfer once with the exact recipient and amount; the app shows a card the user confirms with Face ID or on their device.
For anything else (approvals, contract calls) an owner key is needed: use proposeExecute with the raw calls only if the user gave you calldata; never invent calldata.
If the user is over their daily Face ID limit, say the device will need to sign.
Use the tools to look things up instead of guessing. Don't repeat the whole portfolio back unless asked.

${ctx}`;

const TOOLS: { name: string; description: string; schema: Record<string, unknown> }[] = [
  {
    name: "getWallet",
    description:
      "This wallet: balance, keys (signers with roles and daily limits, remaining allowance), nonce, recovery state, recent activity.",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getPortfolio",
    description: "Token holdings and USD totals (Zerion on Base; local chain data otherwise).",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getActivity",
    description: "Recent transactions (Zerion on Base; local chain events otherwise).",
    schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "getPrice",
    description: "USD price of a token symbol, e.g. ETH.",
    schema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
      additionalProperties: false,
    },
  },
  {
    name: "proposeTransfer",
    description:
      'Propose sending the wallet\'s token. `amount` is a decimal string in whole tokens (e.g. "45" or "12.50"). `to` is an address or an ENS name.',
    schema: {
      type: "object",
      properties: { to: { type: "string" }, amount: { type: "string" }, note: { type: "string" } },
      required: ["to", "amount"],
      additionalProperties: false,
    },
  },
  {
    name: "proposeExecute",
    description: "Propose an arbitrary batch of calls (owner key required). Only when the user supplied the calldata.",
    schema: {
      type: "object",
      properties: {
        calls: {
          type: "array",
          items: {
            type: "object",
            properties: { target: { type: "string" }, value: { type: "string" }, data: { type: "string" } },
            required: ["target", "data"],
          },
        },
        description: { type: "string" },
      },
      required: ["calls", "description"],
      additionalProperties: false,
    },
  },
];

async function resolveTo(to: string): Promise<{ address: Address; name?: string }> {
  if (isAddress(to)) return { address: getAddress(to) };
  const { createPublicClient, http } = await import("viem");
  const { mainnet } = await import("viem/chains");
  const { normalize } = await import("viem/ens");
  const key = process.env.NEXT_PUBLIC_ALCHEMY_API_KEY;
  const client = createPublicClient({
    chain: mainnet,
    transport: http(
      process.env.MAINNET_RPC_URL ||
        (key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : "https://cloudflare-eth.com"),
    ),
  });
  const addr = await client.getEnsAddress({ name: normalize(to) });
  if (!addr) throw new Error(`could not resolve ${to}`);
  return { address: addr, name: to };
}

function makeExecutor(wallet: Address, proposals: Proposal[]) {
  return async (name: string, input: any): Promise<unknown> => {
    switch (name) {
      case "getWallet": {
        const s = await walletSnapshot(wallet);
        return {
          address: s.address,
          deployed: s.deployed,
          token: s.token,
          balance: s.balanceFormatted,
          nonce: s.nonce,
          signers: s.signers.map(x => ({
            signerId: x.signerId,
            label: x.label,
            kind: x.kind === 1 ? "device" : "passkey",
            role: x.role === 1 ? "owner" : "spender",
            dailyLimit: formatUnits(BigInt(x.dailyLimit), s.token.decimals),
            remainingToday:
              x.remainingAllowance === "unlimited"
                ? "unlimited"
                : formatUnits(BigInt(x.remainingAllowance), s.token.decimals),
            online: x.online,
          })),
          recovery: s.recovery,
          activity: s.activity.slice(0, 10).map(a => ({
            ...a,
            amount: a.amount ? formatUnits(BigInt(a.amount), s.token.decimals) : undefined,
            fee: a.fee ? formatUnits(BigInt(a.fee), s.token.decimals) : undefined,
          })),
          feePerTransfer: formatUnits(facilitatorFee(s.token.decimals), s.token.decimals),
        };
      }
      case "getPortfolio":
        return portfolio(wallet);
      case "getActivity":
        return activity(wallet);
      case "getPrice":
        return price(String(input?.symbol ?? "ETH"));
      case "proposeTransfer": {
        const t = await tokenMeta();
        const amount = String(input?.amount ?? "")
          .trim()
          .replace(/[$,]/g, "");
        if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error('amount must be a decimal string like "45"');
        const units = parseUnits(amount, t.decimals);
        if (units <= 0n) throw new Error("amount must be positive");
        const { address, name } = await resolveTo(String(input?.to ?? ""));
        const fee = facilitatorFee(t.decimals);
        const p: Proposal = {
          kind: "transfer",
          to: address,
          toName: name,
          amount: units.toString(),
          amountFormatted: formatUnits(units, t.decimals),
          fee: fee.toString(),
          symbol: t.symbol,
          decimals: t.decimals,
          description:
            typeof input?.note === "string"
              ? input.note
              : `Send ${formatUnits(units, t.decimals)} ${t.symbol} to ${name ?? address}`,
        };
        proposals.push(p);
        return {
          ok: true,
          proposal: p,
          next: "Tell the user the card is ready to confirm. Do not call proposeTransfer again.",
        };
      }
      case "proposeExecute": {
        const calls = parseCalls(input?.calls);
        const p: Proposal = {
          kind: "execute",
          calls: calls.map(c => ({ target: c.target, value: c.value.toString(), data: c.data })),
          description: String(input?.description ?? "Execute calls"),
        };
        proposals.push(p);
        return { ok: true, proposal: p, next: "Tell the user the card is ready to confirm (owner key required)." };
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  };
}

type Turn = { role: "user" | "assistant"; content: string };

async function runAnthropic(system: string, history: Turn[], exec: (n: string, i: any) => Promise<unknown>) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("This app has no Anthropic key configured. Choose 'Bring your own' in Settings.");
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
  const client = new Anthropic({ apiKey });
  const tools: Anthropic.Tool[] = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema as Anthropic.Tool.InputSchema,
  }));
  const messages: Anthropic.MessageParam[] = history.map(h => ({ role: h.role, content: h.content }));
  let text = "";
  for (let step = 0; step < 8; step++) {
    const res = await client.messages.create({ model, max_tokens: 2048, system, tools, messages });
    const textBlocks = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text");
    if (textBlocks.length)
      text = textBlocks
        .map(b => b.text)
        .join("\n")
        .trim();
    if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) break;
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = await Promise.all(
      uses.map(async u => {
        try {
          return {
            type: "tool_result" as const,
            tool_use_id: u.id,
            content: JSON.stringify(await exec(u.name, u.input)),
          };
        } catch (e: any) {
          return {
            type: "tool_result" as const,
            tool_use_id: u.id,
            content: `error: ${e?.message || e}`,
            is_error: true,
          };
        }
      }),
    );
    messages.push({ role: "user", content: results });
  }
  return { text, model };
}

async function runOpenAI(
  cfg: { baseURL: string; apiKey: string; model: string },
  system: string,
  history: Turn[],
  exec: (n: string, i: any) => Promise<unknown>,
) {
  const client = new OpenAI({ baseURL: cfg.baseURL, apiKey: cfg.apiKey || "none" });
  const tools: OpenAI.Chat.ChatCompletionTool[] = TOOLS.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...history.map(h => ({ role: h.role, content: h.content }) as OpenAI.Chat.ChatCompletionMessageParam),
  ];
  let text = "";
  for (let step = 0; step < 8; step++) {
    const res = await client.chat.completions.create({ model: cfg.model, messages, tools, tool_choice: "auto" });
    const choice = res.choices[0];
    if (!choice) break;
    const msg = choice.message;
    if (msg.content) text = msg.content.trim();
    const calls = (msg.tool_calls ?? []).filter(
      (c): c is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => c.type === "function",
    );
    if (!calls.length) break;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls });
    for (const c of calls) {
      let out: string;
      try {
        out = JSON.stringify(await exec(c.function.name, JSON.parse(c.function.arguments || "{}")));
      } catch (e: any) {
        out = `error: ${e?.message || e}`;
      }
      messages.push({ role: "tool", tool_call_id: c.id, content: out });
    }
  }
  return { text, model: cfg.model };
}

export async function POST(req: NextRequest) {
  const provider = req.headers.get("x-ai-provider") || "off";
  if (provider === "off")
    return NextResponse.json(
      { type: "chat", message: "AI is off. Turn it on in Settings.", provider, model: "" } satisfies Reply,
      { status: 400 },
    );
  const body = await req.json().catch(() => ({}));
  const wallet = typeof body.wallet === "string" && isAddress(body.wallet) ? getAddress(body.wallet) : null;
  if (!wallet) return NextResponse.json({ error: "wallet required" }, { status: 400 });
  const history: Turn[] = Array.isArray(body.messages)
    ? body.messages
        .filter(
          (m: any) =>
            (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string" && m.content.trim(),
        )
        .slice(-20)
    : [];
  if (typeof body.message === "string" && body.message.trim())
    history.push({ role: "user", content: body.message.trim() });
  if (!history.length || history[history.length - 1].role !== "user")
    return NextResponse.json({ error: "message required" }, { status: 400 });

  const proposals: Proposal[] = [];
  const exec = makeExecutor(wallet, proposals);
  const ctx = `Wallet: ${wallet}. Data sources: ${zerionEnabled() ? "Zerion (Base)" : isBase ? "chain only" : "local test chain"}.`;
  try {
    const out =
      provider === "anthropic"
        ? await runAnthropic(SYSTEM(ctx), history, exec)
        : provider === "openai-compatible"
          ? await runOpenAI(
              {
                baseURL: req.headers.get("x-ai-base-url") || "https://api.openai.com/v1",
                apiKey: req.headers.get("x-ai-key") || "",
                model: req.headers.get("x-ai-model") || "gpt-4.1-mini",
              },
              SYSTEM(ctx),
              history,
              exec,
            )
          : null;
    if (!out) return NextResponse.json({ error: `unknown provider ${provider}` }, { status: 400 });
    const proposal = proposals[proposals.length - 1];
    const reply: Reply = {
      type: proposal ? "proposal" : "chat",
      message: out.text || (proposal ? "Ready to confirm." : "…"),
      proposal,
      provider,
      model: out.model,
    };
    return NextResponse.json(reply);
  } catch (e: any) {
    const status =
      e instanceof Anthropic.AuthenticationError || e?.status === 401
        ? 401
        : e instanceof Anthropic.RateLimitError || e?.status === 429
          ? 429
          : 502;
    return NextResponse.json({ error: e?.message || String(e), provider }, { status });
  }
}
