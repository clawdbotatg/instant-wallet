import { CHAINS } from "./chains";

/**
 * The Apps list (docs/APP-STORE.md). Each entry is a Safe App at a URL, opened in our frame (lib/safeapps.ts),
 * except Swap and Revoke, our own sheets. Ours (ENS, Morpho) live in github.com/clawdbotatg/instant-wallet-apps;
 * the rest are Safe{Wallet}'s apps that let any site frame them AND accept us as their Safe (test before adding:
 * tools/apps-connect-probe.mjs). Add one: a line here.
 */
export type AppEntry = { id: string; name: string; what: string; chains: number[]; url?: string; icon?: string };

export const APPS_URL = process.env.NEXT_PUBLIC_APPS_URL || "https://instant-wallet-apps.vercel.app";
// icons ship in the app (public/apps): opening Apps asks no other host for anything

const ALL: AppEntry[] = [
  { id: "swap", name: "Swap", what: "Best price from Uniswap or LI.FI, any network", chains: CHAINS.map(c => c.id) },
  { id: "revoke", name: "Revoke", what: "See and stop every app that can spend your coins", chains: CHAINS.map(c => c.id), icon: "/apps/revoke.svg" },
  { id: "earn", name: "Earn", what: "Best interest on USDC: Aave, Compound, Spark, Morpho", chains: [8453, 1], url: `${APPS_URL}/earn`, icon: "/apps/earn.svg" },
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
