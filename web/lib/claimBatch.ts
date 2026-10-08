import { type Address, type Hex, encodeFunctionData, getAddress, parseAbi } from "viem";
import { CHAINS, publicClient } from "./chains";
import { MULTICALL3 } from "./safe/config";

/**
 * Claim cards in bulk (docs/CLAIM.md): read many cards' balances in one call per network, fill many from a browser
 * wallet through BuidlGuidl's splitter (split.buidlguidl.com), and lay ready cards out as a PDF to print and cut.
 */

/** BuidlGuidl's ETH & token splitter (github.com/BuidlGuidl/Eth-Splitter), Base only. 2–25 recipients per call. */
export const SPLITTER: Record<number, Address> = { 8453: "0x6A8A356C2Fdb6d4004e785ADd08Af7e085a1432a" };
const SPLIT_MAX = 25;

const splitterAbi = parseAbi(["function splitERC20(address token, address[] recipients, uint256[] amounts)"]);
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);
const mc3 = parseAbi(["function getEthBalance(address) view returns (uint256)"]);

export const ETH_DUST = 50_000_000_000_000n; // 0.00005 ETH: less than it costs to move (the claim page leaves it)

export type CardBalance = { usdc: bigint; eth: bigint; where: string };

/** Every card's USDC + ETH on every network: one multicall per network, however many cards. */
export async function cardBalances(addrs: Address[]): Promise<Record<string, CardBalance>> {
  const per = await Promise.all(
    CHAINS.map(async c => {
      const pc = publicClient(c.id);
      const calls = addrs.flatMap(a => [
        ...(c.usdc ? [{ address: c.usdc, abi: erc20, functionName: "balanceOf", args: [a] } as const] : []),
        { address: MULTICALL3, abi: mc3, functionName: "getEthBalance", args: [a] } as const,
      ]);
      const r = await pc.multicall({ contracts: calls, multicallAddress: MULTICALL3 }).catch(() => null);
      const step = c.usdc ? 2 : 1;
      return addrs.map((_, i) => {
        if (!r) return { name: c.name, usdc: 0n, eth: 0n, failed: true };
        const usdc = c.usdc ? ((r[i * step].result as bigint | undefined) ?? 0n) : 0n;
        const eth = (r[i * step + step - 1].result as bigint | undefined) ?? 0n;
        return { name: c.name, usdc, eth: eth < ETH_DUST ? 0n : eth, failed: false };
      });
    }),
  );
  const out: Record<string, CardBalance> = {};
  addrs.forEach((a, i) => {
    const rows = per.map(p => p[i]);
    if (rows.some(r => r.failed)) return; // unknown, not empty: never call a card claimed on a failed read
    const where = rows
      .flatMap(p => [p.usdc > 0n && `${fmtUsdc(p.usdc)} USDC`, p.eth > 0n && `${(Number(p.eth) / 1e18).toFixed(5)} ETH`].filter(Boolean).map(x => `${x} on ${p.name}`))
      .join(", ");
    out[a] = { usdc: rows.reduce((t, p) => t + p.usdc, 0n), eth: rows.reduce((t, p) => t + p.eth, 0n), where };
  });
  return out;
}

export const fmtUsdc = (v: bigint) => (Number(v) / 1e6).toFixed(2).replace(/\.00$/, "");

const eth = () => (window as any).ethereum;

async function send(from: Address, to: Address, data: Hex, chainId: number): Promise<void> {
  const hash = (await eth().request({ method: "eth_sendTransaction", params: [{ from, to, data }] })) as Hex;
  const rc = await publicClient(chainId).waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1500 });
  if (rc.status !== "success") throw new Error(`It failed on chain (${hash.slice(0, 10)}…)`);
}

/**
 * Fill cards from the browser wallet (MetaMask, Rabby, Coinbase…): approve the splitter for the total, then one
 * splitERC20 per 25 cards (a lone leftover card gets a plain transfer). `onStep` says what the wallet is asking for.
 */
export async function fillWithWallet(cards: Address[], each: bigint, onStep: (s: string) => void, chainId = 8453): Promise<void> {
  const splitter = SPLITTER[chainId];
  const usdc = CHAINS.find(c => c.id === chainId)?.usdc;
  if (!splitter || !usdc) throw new Error("Filling many at once works on Base only.");
  if (!eth()) throw new Error("No browser wallet here. Open this page in a browser with MetaMask (or another wallet), or copy the addresses into split.buidlguidl.com.");
  const [raw] = await eth().request({ method: "eth_requestAccounts" });
  const me = getAddress(raw);
  const want = "0x" + chainId.toString(16);
  if ((await eth().request({ method: "eth_chainId" })) !== want) await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  const pc = publicClient(chainId);
  const total = each * BigInt(cards.length);
  const have = (await pc.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [me] })) as bigint;
  if (have < total) throw new Error(`That wallet has ${fmtUsdc(have)} USDC on Base; this needs ${fmtUsdc(total)}.`);
  const chunks: Address[][] = [];
  for (let i = 0; i < cards.length; i += SPLIT_MAX) chunks.push(cards.slice(i, i + SPLIT_MAX));
  const viaSplitter = chunks.filter(c => c.length > 1).reduce((t, c) => t + each * BigInt(c.length), 0n);
  if (viaSplitter > 0n) {
    const allowed = (await pc.readContract({ address: usdc, abi: erc20, functionName: "allowance", args: [me, splitter] })) as bigint;
    if (allowed < viaSplitter) {
      onStep(`Approve ${fmtUsdc(viaSplitter)} USDC for the splitter, in your wallet`);
      await send(me, usdc, encodeFunctionData({ abi: erc20, functionName: "approve", args: [splitter, viaSplitter] }), chainId);
    }
  }
  for (const [i, c] of chunks.entries()) {
    onStep(`Confirm in your wallet: ${c.length} card${c.length > 1 ? "s" : ""}${chunks.length > 1 ? ` (${i + 1} of ${chunks.length})` : ""}`);
    if (c.length === 1) await send(me, usdc, encodeFunctionData({ abi: erc20, functionName: "transfer", args: [c[0], each] }), chainId);
    else await send(me, splitter, encodeFunctionData({ abi: splitterAbi, functionName: "splitERC20", args: [usdc, c, c.map(() => each)] }), chainId);
  }
}

/**
 * A PDF of cards on the business-card sheet layout (Avery 8371 / 5371: Letter, 2 × 5 cards of 3.5 × 2 in, 0.75 in
 * side and 0.5 in top margins), with light cut lines so plain paper works too. Each card: the claim QR, the amount.
 */
export async function cardsPdf(cards: { url: string; amount: string }[]): Promise<void> {
  const [{ jsPDF }, QR] = await Promise.all([import("jspdf"), import("qrcode")]);
  const doc = new jsPDF({ unit: "in", format: "letter" });
  const W = 3.5, H = 2, X0 = 0.75, Y0 = 0.5;
  for (const [i, c] of cards.entries()) {
    const n = i % 10;
    if (i > 0 && n === 0) doc.addPage();
    const x = X0 + (n % 2) * W;
    const y = Y0 + Math.floor(n / 2) * H;
    doc.setDrawColor(200).setLineDashPattern([0.04, 0.04], 0).setLineWidth(0.005).rect(x, y, W, H);
    const png = await QR.toDataURL(c.url, { errorCorrectionLevel: "M", margin: 0, width: 600 });
    doc.addImage(png, "PNG", x + 0.18, y + 0.18, 1.64, 1.64);
    doc.setTextColor(26, 27, 26).setFont("helvetica", "bold").setFontSize(30).text(c.amount, x + 2.02, y + 0.72);
    doc.setFont("helvetica", "bold").setFontSize(12).text("Scan to claim", x + 2.02, y + 1.12);
    doc.setFont("helvetica", "normal").setFontSize(9).setTextColor(110).text(["Instant Wallet", "Treat it like cash"], x + 2.02, y + 1.38);
  }
  doc.save(`claim-cards-${cards.length}.pdf`);
}
