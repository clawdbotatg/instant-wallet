import { CHAINS } from "./chains";

/**
 * The Apps list (docs/APP-STORE.md). Each entry is a Safe App at a URL, opened in our frame (lib/safeapps.ts),
 * except Swap, which is our own sheet. Ours (ENS, Morpho) live in github.com/clawdbotatg/instant-wallet-apps;
 * the rest are Safe{Wallet}'s apps that let any site frame them AND accept us as their Safe (test before adding:
 * tools/apps-connect-probe.mjs). Add one: a line here.
 */
export type AppEntry = { id: string; name: string; what: string; chains: number[]; url?: string; icon?: string };

export const APPS_URL = process.env.NEXT_PUBLIC_APPS_URL || "https://instant-wallet-apps.vercel.app";
const SAFE_ICON = (id: string) => `https://safe-transaction-assets.safe.global/safe_apps/${id}/icon.png`;

const ALL: AppEntry[] = [
  { id: "swap", name: "Swap", what: "Best price from Uniswap or LI.FI, any network", chains: CHAINS.map(c => c.id) },
  { id: "earn", name: "Earn", what: "Best interest on USDC: Aave, Compound, Spark, Morpho", chains: [8453, 1], url: `${APPS_URL}/earn`, icon: `${APPS_URL}/earn/icon.svg` },
  { id: "borrow", name: "Borrow", what: "Borrow USDC against ETH or BTC: Aave, Compound, Morpho", chains: [8453, 1], url: `${APPS_URL}/borrow`, icon: `${APPS_URL}/borrow/icon.svg` },
  { id: "ens", name: "ENS", what: "Get a name like alice.eth", chains: [1], url: `${APPS_URL}/ens`, icon: `${APPS_URL}/ens/icon.svg` },
  { id: "morpho", name: "Morpho", what: "Earn interest on USDC", chains: [8453, 1], url: `${APPS_URL}/morpho`, icon: `${APPS_URL}/morpho/icon.svg` },
  // tested in our frame on a Base fork, 10-28 (tools/apps-connect-probe.mjs): these connect. Aave, CoW Swap, Revoke,
  // LlamaPay, Lagoon only accept app.safe.global; Spark, Velora, DeFi Saver, Snapshot never ask.
  { id: "aerodrome", name: "Aerodrome", what: "Swap and earn on Base", chains: [8453], url: "https://aerodrome.finance", icon: SAFE_ICON("151") },
  { id: "balancer", name: "Balancer", what: "Earn from liquidity pools", chains: [8453, 1, 100], url: "https://balancer.fi/pools", icon: SAFE_ICON("83174312-cd91-4721-80f6-7d4f7055e1b5") },
  { id: "venus", name: "Venus", what: "Lend and borrow", chains: [8453, 1], url: "https://venus.io/", icon: SAFE_ICON("f586f39e-71ac-4772-b988-2bde27edfdeb") },
  { id: "superfluid", name: "Superfluid", what: "Stream money by the second", chains: [8453, 1, 100], url: "https://app.superfluid.org", icon: SAFE_ICON("3ee85376-cff1-497a-a9d8-51c0e5234c6e") },
  { id: "txbuilder", name: "Transaction Builder", what: "Any contract call, for experts", chains: [8453, 1, 100], url: "https://apps-portal.safe.global/tx-builder/", icon: SAFE_ICON("29") },
];

/** The apps that run on at least one of this site's networks, each with its networks in this site's order. */
export const APPS: AppEntry[] = ALL.map(a => ({ ...a, chains: CHAINS.map(c => c.id).filter(id => a.chains.includes(id)) })).filter(
  a => a.chains.length > 0,
);
