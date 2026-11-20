import { CHAINS } from "./chains";
import type { Position } from "./types";

/**
 * The Apps list (docs/APP-STORE.md). Each entry is a Safe App at a URL, opened in our frame (lib/safeapps.ts),
 * except Swap and Revoke, our own screens in that same frame. Ours (ENS, Morpho) live in github.com/clawdbotatg/instant-wallet-apps;
 * the rest are Safe{Wallet}'s apps that let any site frame them AND accept us as their Safe (test before adding:
 * tools/apps-connect-probe.mjs). Add one: a line here.
 */
/** `chainId`: the network it opens on (a position's), else its first. */
export type AppEntry = { id: string; name: string; what: string; chains: number[]; url?: string; icon?: string; chainId?: number };

export const APPS_URL = process.env.NEXT_PUBLIC_APPS_URL || "https://instant-wallet-apps.vercel.app";
// icons ship in the app (public/apps): opening Apps asks no other host for anything

const ALL: AppEntry[] = [
  { id: "swap", name: "Swap", what: "Best price from Uniswap or LI.FI, any network", chains: CHAINS.map(c => c.id) },
  { id: "revoke", name: "Revoke", what: "See and stop every app that can spend your coins", chains: CHAINS.map(c => c.id), icon: "/apps/revoke.svg" },
  { id: "earn", name: "Earn", what: "Best interest on USDC or ETH: Aave, Compound, Spark, Morpho", chains: [8453, 1], url: `${APPS_URL}/earn`, icon: "/apps/earn.svg" },
  { id: "borrow", name: "Borrow", what: "Borrow USDC, USDT or ETH: Aave, Compound, Morpho", chains: [8453, 1], url: `${APPS_URL}/borrow`, icon: "/apps/borrow.svg" },
  { id: "stake", name: "Stake ETH", what: "Earn on ETH: Lido, Coinbase, Rocket Pool", chains: [8453, 1], url: `${APPS_URL}/stake`, icon: "/apps/stake.svg" },
  { id: "ens", name: "ENS", what: "Get a name like alice.eth", chains: [1], url: `${APPS_URL}/ens`, icon: "/apps/ens.svg" },
  { id: "morpho", name: "Morpho", what: "Earn interest on USDC", chains: [8453, 1], url: `${APPS_URL}/morpho`, icon: "/apps/morpho.svg" },
  // tested in our frame on a Base fork, 10-28 (tools/apps-connect-probe.mjs): these connect. Aave, CoW Swap, Revoke,
  // LlamaPay, Lagoon only accept app.safe.global; Spark, Velora, DeFi Saver, Snapshot never ask.
  { id: "aerodrome", name: "Aerodrome", what: "Swap and earn on Base", chains: [8453], url: "https://aerodrome.finance", icon: "/apps/aerodrome.png" },
  { id: "balancer", name: "Balancer", what: "Earn from liquidity pools", chains: [8453, 1, 100], url: "https://balancer.fi/pools", icon: "/apps/balancer.png" },
  { id: "venus", name: "Venus", what: "Lend and borrow", chains: [8453, 1], url: "https://venus.io/", icon: "/apps/venus.png" },
  { id: "superfluid", name: "Superfluid", what: "Stream money by the second", chains: [8453, 1, 100], url: "https://app.superfluid.org", icon: "/apps/superfluid.png" },
  { id: "txbuilder", name: "Transaction Builder", what: "Any contract call, for experts", chains: [8453, 1, 100], url: "https://apps-portal.safe.global/tx-builder/", icon: "/apps/txbuilder.png" },
];

/** The apps that run on at least one of this site's networks, each with its networks in this site's order. */
export const APPS: AppEntry[] = ALL.map(a => ({ ...a, chains: CHAINS.map(c => c.id).filter(id => a.chains.includes(id)) })).filter(
  a => a.chains.length > 0,
);

/**
 * Earn's fixed places, by the coin a position holds for them: Aave's aTokens, Compound's markets, Spark's sUSDC, USDC
 * and WETH (the same addresses as instant-wallet-apps src/earn/sources.ts). A Morpho vault is found by Earn itself.
 */
const EARN = new Set(
  [
    "8453:0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB", "8453:0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7",
    "1:0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c", "1:0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
    "8453:0xb125E6687d4313864e53df431d5425969c15Eb2F", "8453:0x46e6b214b524310239732D51387075E0e70970bf",
    "1:0xc3d688B66703497DAA19211EEdff47f25384cdc3", "1:0xA17581A9E3356d9A858b789D68B4d866e593aE94",
    "8453:0x3128a0F7f0ea68E7B7c9B00AFa7E41045828e858", "1:0xBc65ad17c5C0a2A4D159fa5a503f4992c7B545FE",
  ].map(k => k.toLowerCase()),
);
/** Other people's sites in the Apps list, by Zerion's name for them; the page with your own positions, where it isn't the first one. */
const SITES: [RegExp, string, string?][] = [
  [/^balancer/i, "balancer", "https://balancer.fi/portfolio"],
  [/^superfluid/i, "superfluid"],
  [/^aerodrome/i, "aerodrome"],
  [/^venus/i, "venus"],
];

/**
 * The app a position opens in, on its network (Austin 11-20: a tap on a position went to the website, though the
 * position was made in one of our apps). Earn opens on that one place, on Withdraw (`?open=` the coin held for it).
 * A site from the Apps list opens in the frame. null: no app of ours knows it, the row leaves for its website.
 */
export function appFor(p: Position): AppEntry | null {
  const app = (id: string) => APPS.find(a => a.id === id && a.chains.includes(p.chainId));
  const r = p.receipts?.length === 1 ? p.receipts[0] : null;
  const earn = app("earn");
  if (earn && r && p.type === "deposit") {
    const morpho = p.protocol === "Morpho" && p.tokens.length === 1 && /^(USDC|WETH|ETH)$/.test(p.tokens[0]);
    if (EARN.has(`${p.chainId}:${r}`) || morpho) return { ...earn, url: `${earn.url}?open=${r}`, chainId: p.chainId };
  }
  for (const [re, id, mine] of SITES) {
    const a = re.test(p.protocol) && app(id);
    if (a) return { ...a, url: mine ?? a.url, chainId: p.chainId };
  }
  return null;
}
