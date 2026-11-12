import { type Address, type Hex, keccak256, toBytes } from "viem";

/**
 * A wallet's public name: alice.inst.eth. Free, first come, claimed with Face ID (app/api/names). Our server
 * answers for it (lib/namesStore.ts), so a name works the moment it's claimed, before the wallet is on any chain.
 * A wallet's own ENS name (its primary name onchain) shows first; this is what shows when it has none.
 */
export const NAME_PARENT = "inst.eth";
export const fullName = (label: string) => `${label}.${NAME_PARENT}`;
/** Where .eth names live since ENSv2 (2026-10-27): its ETHRegistry. inst.eth's owner sets the resolver here. */
export const ENS_REGISTRY: Address = "0xf60aba43e1f7f3dab1186ff03b561401c9df85e2";
/** inst.eth's own address (what it pointed at before our resolver took over): the gateway keeps answering it. */
export const ROOT_ADDRESS: Address = "0x34aA3F359A9D614239015126635CE7732c18fDF3";

/** How many names one wallet can hold. A rename keeps the old one (it still pays you), so this is the cap on renames. */
export const MAX_NAMES = 5;

/** What the passkey signs to claim a name: this wallet, this label, now. */
export const nameChallenge = (address: Address, label: string, ts: number): Hex => keccak256(toBytes(`instant-wallet name ${address.toLowerCase()} ${label} ${ts}`));

/** The label in what someone typed, key by key: "Alice" and "alice.inst.eth" are alice, "my wallet" is my-wallet. */
export function labelIn(text: string): string {
  let v = text.trimStart().toLowerCase();
  if (v.trimEnd().endsWith(`.${NAME_PARENT}`)) v = v.trimEnd().slice(0, -NAME_PARENT.length - 1);
  return v.replace(/[\s_.]+/g, "-").replace(/[^a-z0-9-]/g, "");
}

/** The label of one of our names ("alice.inst.eth" → "alice"), or null: another name, or a name under one of ours. */
export function ourLabel(name: string): string | null {
  const v = name.trim().toLowerCase();
  if (!v.endsWith(`.${NAME_PARENT}`)) return null;
  const label = v.slice(0, -NAME_PARENT.length - 1);
  return /^[a-z0-9-]+$/.test(label) ? label : null;
}

// names that would pass for us, for a company, or for help: held back as a whole name
const TAKEN = new Set(
  (
    "inst instant instantwallet wallet wallets www api app apps mail email dns ns root admin administrator mod moderator " +
    "support help helpdesk service security secure safety official verify verified team staff owner system info contact abuse " +
    "billing payment payments pay refund refunds recover recovery claim claims airdrop drop drops giveaway bank treasury dao " +
    "relay relayer guardian guardians signer wedgie wedgiedev safe safewallet gnosis gnosissafe ens eth ethereum base solana sol " +
    "bitcoin btc usdc usdt dai tether circle coinbase binance kraken okx bybit gemini robinhood metamask phantom rainbow ledger " +
    "trezor uniswap lifi aave morpho lido opensea stripe paypal venmo cashapp apple google microsoft amazon " +
    "buidlguidl atg austin austingriffith austintgriffith vitalik null undefined test"
  ).split(" "),
);
// held back anywhere in a name: words a fake helper leans on, and wallets and companies people get phished as
// (coinbase-pay, metamask-team). Only names long enough not to sit inside an ordinary word.
const INSIDE = (
  "support official admin helpdesk security customer refund verify airdrop giveaway recover moderator " +
  "instantwallet buidlguidl wedgie austingriffith vitalik walletconnect safewallet gnosissafe " +
  "coinbase binance kraken metamask phantom ledger trezor uniswap opensea paypal venmo cashapp robinhood microsoft"
).split(" ");
// numbers that stand in for letters (supp0rt, adm1n, c0inbase): read as the letter before the lists are checked.
// 1 is an l or an i, so both are tried.
const LOOKS: Record<string, string> = { "0": "o", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b" };
function reads(label: string): string[] {
  const flat = label.replace(/-/g, "").replace(/[034578]/g, d => LOOKS[d]);
  return [...new Set([flat.replace(/1/g, "l"), flat.replace(/1/g, "i")])];
}

/** Why a label isn't a name at all (its letters, its length), or null. A name already held is only ever checked for this. */
export function labelShape(label: string): string | null {
  if (!label) return null;
  if (!/^[a-z0-9-]+$/.test(label)) return "Letters, numbers and - only";
  if (label.length < 3) return "3 or more letters";
  if (label.length > 32) return "32 letters at most";
  if (label.startsWith("-") || label.endsWith("-") || label.includes("--")) return "No - at the ends or doubled";
  return null;
}

/** Why a label can't be taken as a new name, in a few words, or null: it can. */
export function labelProblem(label: string): string | null {
  const shape = labelShape(label);
  if (!label || shape) return shape;
  if (/^0x/.test(label) || /^[0-9a-f]{40}$/.test(label)) return "Can't look like an address";
  // vitalik-eth reads as vitalik.eth at a glance
  if (reads(label.replace(/-(?=[a-z0-9]+$)/, ".")).some(r => r.endsWith(".eth"))) return "Can't end in -eth";
  if (reads(label).some(r => TAKEN.has(r) || INSIDE.some(w => r.includes(w)))) return "Taken";
  return null;
}

// names this browser has paid, and where they pointed then: a name that now points somewhere else gets a warning
const PAID = "iws.paidNames";
function paid(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PAID) || "{}");
  } catch {
    return {};
  }
}
/** Where this name pointed the last time this browser paid it, when that isn't `now`. Null: the same, or never paid. */
export function movedFrom(name: string, now: Address): Address | null {
  const was = paid()[name.toLowerCase()];
  return was && was.toLowerCase() !== now.toLowerCase() ? (was as Address) : null;
}
/** A send to this name went out: remember where it pointed. */
export function rememberPaid(name: string, to: Address) {
  try {
    const all = { ...paid(), [name.toLowerCase()]: to };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k];
    localStorage.setItem(PAID, JSON.stringify(all));
  } catch {}
}
