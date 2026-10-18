import "server-only";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import nodemailer from "nodemailer";
import webpush from "web-push";
import { type Address, type Hex, createPublicClient, getAddress, http, keccak256, toBytes } from "viem";
import { CHAINS, chainById } from "./chains";
import { upstreamRpc } from "./rpcServer";
import { RECOVERY_MODULES } from "./safe/config";
import { abi, safeAddress, signerAddress } from "./safe/core";
import { bytesToBase64url, hexToBytes } from "./webauthn";

/**
 * Recovery alerts (Austin 10-14): a recovery that starts on a wallet reaches its owner even with the app closed.
 * Each wallet keeps its contacts here: an email, a Telegram chat, push subscriptions (one per device). A job
 * (/api/alerts/check, every 5 min) reads every listed wallet's recovery request on every chain and sends once per
 * recovery, and once more a day before it lands. Changing the contacts takes the wallet's passkey (Face ID), and
 * the old contacts are told, so a thief can't quietly switch them off first.
 * Storage: Upstash Redis (RELAY_KV_URL / RELAY_KV_TOKEN, keys "iws:alerts:").
 */

const URL_ = process.env.RELAY_KV_URL;
const TOKEN = process.env.RELAY_KV_TOKEN;
// local dev only: one store for every route (dev loads each route's modules apart), with expiry
const mem: Map<string, { v: any; until: number }> = ((globalThis as any).__iwsAlerts ??= new Map());
const P = "iws:alerts:";

async function kv(cmd: (string | number)[]): Promise<any> {
  if (!URL_ || !TOKEN) {
    if (process.env.VERCEL_ENV === "production") throw new Error("alert storage not configured");
    const [op, k, ...rest] = cmd.map(String);
    const cur = mem.get(k);
    const v = cur && cur.until > Date.now() ? cur.v : undefined;
    const put = (x: any, ex = Infinity) => mem.set(k, { v: x, until: Date.now() + ex * 1000 });
    if (op === "GET") return v ?? null;
    if (op === "SET") {
      if (rest.includes("NX") && v !== undefined) return null;
      put(rest[0], rest.includes("EX") ? Number(rest[rest.indexOf("EX") + 1]) : Infinity);
      return "OK";
    }
    if (op === "DEL") return mem.delete(k) ? 1 : 0;
    if (op === "SADD") return put([...new Set([...(v ?? []), rest[0]])]), 1;
    if (op === "SREM") return put((v ?? []).filter((x: string) => x !== rest[0])), 1;
    if (op === "SMEMBERS") return v ?? [];
    return null;
  }
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.error) throw new Error(`kv: ${j.error}`);
  return j.result;
}

export type Contacts = { email?: string; telegram?: number; push?: webpush.PushSubscription[]; at?: number };

const wk = (w: Address) => `${P}w:${w.toLowerCase()}`;
export async function getContacts(w: Address): Promise<Contacts> {
  const v = await kv(["GET", wk(w)]);
  return v ? (JSON.parse(v) as Contacts) : {};
}
export async function putContacts(w: Address, c: Contacts) {
  const empty = !c.email && !c.telegram && !c.push?.length;
  if (empty) {
    await kv(["DEL", wk(w)]);
    await kv(["SREM", `${P}wallets`, w.toLowerCase()]);
  } else {
    await kv(["SET", wk(w), JSON.stringify(c)]);
    await kv(["SADD", `${P}wallets`, w.toLowerCase()]);
  }
}
export const wallets = async (): Promise<Address[]> => ((await kv(["SMEMBERS", `${P}wallets`])) as string[]).map(x => getAddress(x));
/** First caller wins: a send that must happen once (SET NX). */
export const once = async (key: string, ttlSec: number) => (await kv(["SET", P + key, 1, "NX", "EX", ttlSec])) === "OK";
export const stash = (key: string, v: string, ttlSec: number) => kv(["SET", P + key, v, "EX", ttlSec]);
export const take = async (key: string): Promise<string | null> => {
  const v = await kv(["GET", P + key]);
  if (v !== null) await kv(["DEL", P + key]);
  return v;
};

/** What the page shows: enough to recognise your own contacts, not enough to learn someone else's. */
export function masked(c: Contacts) {
  const e = c.email?.split("@");
  return {
    email: e ? `${e[0].slice(0, 2)}…@${e[1]}` : null,
    telegram: !!c.telegram,
    push: c.push?.map(p => p.endpoint.slice(-12)) ?? [],
  };
}

// ---------------------------------------------------------------- who may change a wallet's contacts

/** The 32 bytes the passkey signs: the wallet, the change, and the time (a signed change is good for 5 minutes). */
export function changeDigest(wallet: Address, change: string, ts: number, scope = "alerts"): Hex {
  return keccak256(toBytes(`Instant Wallet ${scope}\n${wallet.toLowerCase()}\n${change}\n${ts}`));
}

export type Signed = { qx: Hex; qy: Hex; authenticatorData: Hex; clientDataFields: string; r: Hex; s: Hex; ts: number };

/**
 * A change is the wallet's own when its passkey signed it (P-256 over WebAuthn, as Safe's passkey signer checks)
 * and that passkey owns the wallet: its counterfactual Safe, or an owner on a chain where it's deployed.
 */
export async function authorize(wallet: Address, change: string, s: Signed, scope = "alerts"): Promise<string | null> {
  if (!s || !Number.isFinite(s.ts) || Math.abs(Date.now() - s.ts) > 5 * 60_000) return "That took too long. Try again.";
  if (![s.qx, s.qy, s.authenticatorData, s.r, s.s].every(v => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v)) || typeof s.clientDataFields !== "string") return "Bad signature.";
  const digest = changeDigest(wallet, change, s.ts, scope);
  const json = `{"type":"webauthn.get","challenge":"${bytesToBase64url(hexToBytes(digest))}",${s.clientDataFields}}`;
  const msg = sha256(new Uint8Array([...hexToBytes(s.authenticatorData), ...sha256(new TextEncoder().encode(json))]));
  const pub = new Uint8Array([4, ...hexToBytes(s.qx), ...hexToBytes(s.qy)]);
  const sig = new Uint8Array([...hexToBytes(s.r), ...hexToBytes(s.s)]);
  let good = false;
  try {
    good = p256.verify(sig, msg, pub, { prehash: false, lowS: false });
  } catch {}
  if (!good) return "Bad signature.";
  // one use per signature
  if (!(await once(`sig:${keccak256(sig)}`, 600))) return "Already used. Try again.";
  // an owner on a chain where the wallet is deployed; only a wallet deployed nowhere goes by its counterfactual
  // address (else a passkey a recovery replaced would keep its say here forever)
  const signer = signerAddress(s.qx, s.qy);
  let deployed = false;
  for (const c of CHAINS) {
    const url = upstreamRpc(c.id);
    if (!url) continue;
    const pc = createPublicClient({ transport: http(url) });
    const code = await pc.getCode({ address: wallet }).catch(() => undefined);
    if (!code || code === "0x") continue;
    deployed = true;
    const owners = (await pc.readContract({ address: wallet, abi: abi.safe, functionName: "getOwners" }).catch(() => [])) as Address[];
    if (owners.some(o => o.toLowerCase() === signer.toLowerCase())) return null;
  }
  if (!deployed && safeAddress(signer).toLowerCase() === wallet.toLowerCase()) return null;
  return "This passkey isn't a key of that wallet.";
}

// ---------------------------------------------------------------- sending

const SITE = process.env.ALERT_SITE || "https://instantwallet.io";
const TG = process.env.TELEGRAM_BOT_TOKEN;
export const channels = () => ({
  email: !!process.env.ALERT_MAIL_USER && !!process.env.ALERT_MAIL_PASS,
  telegram: !!TG && !!process.env.TELEGRAM_BOT_NAME,
  push: !!process.env.VAPID_PRIVATE_KEY && !!process.env.NEXT_PUBLIC_VAPID_KEY,
});

// wedgie@buidlguidl.com, the same Gmail (app password) wedgie.dev sends from
let smtp: ReturnType<typeof nodemailer.createTransport> | null = null;
export async function sendEmail(to: string, subject: string, text: string) {
  smtp ||= nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: process.env.ALERT_MAIL_USER, pass: process.env.ALERT_MAIL_PASS } });
  await smtp.sendMail({ from: `Instant Wallet <${process.env.ALERT_MAIL_USER}>`, to, subject, text });
}

export async function sendTelegram(chat: number, text: string) {
  const r = await fetch(`https://api.telegram.org/bot${TG}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
  });
  if (!r.ok) throw new Error(`telegram: ${r.status} ${await r.text()}`);
}

/** Sends to one device; false when the device is gone (unsubscribed), so it can be dropped. */
export async function sendPush(sub: webpush.PushSubscription, title: string, body: string): Promise<boolean> {
  webpush.setVapidDetails(SITE, process.env.NEXT_PUBLIC_VAPID_KEY!, process.env.VAPID_PRIVATE_KEY!);
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body, url: SITE }), { TTL: 24 * 3600, urgency: "high" });
    return true;
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) return false;
    throw e;
  }
}

/** Every contact a wallet has. Errors are collected, not thrown: one dead channel mustn't stop the others. */
export async function notify(wallet: Address, c: Contacts, subject: string, text: string): Promise<string[]> {
  const errs: string[] = [];
  const ch = channels();
  if (c.email && ch.email) await sendEmail(c.email, subject, text).catch(e => errs.push(String(e)));
  if (c.telegram && ch.telegram) await sendTelegram(c.telegram, `${subject}\n\n${text}`).catch(e => errs.push(String(e)));
  if (c.push?.length && ch.push) {
    const alive: webpush.PushSubscription[] = [];
    for (const p of c.push) {
      const ok = await sendPush(p, subject, text.split("\n")[0]).catch(e => (errs.push(String(e)), true));
      if (ok) alive.push(p);
    }
    if (alive.length !== c.push.length) await putContacts(wallet, { ...c, push: alive });
  }
  return errs;
}

// ---------------------------------------------------------------- the watcher

export type Request = { chainId: number; wallet: Address; executeAfter: number; newOwners: Address[] };

/** Every listed wallet's running recovery, on every chain (one multicall per chain). */
export async function running(list: Address[]): Promise<Request[]> {
  const out: Request[] = [];
  for (const c of CHAINS) {
    const url = upstreamRpc(c.id);
    if (!url || !list.length) continue;
    const pc = createPublicClient({ chain: c.chain, transport: http(url) });
    // every module: a 7-day request stays readable after a move off it, but only an enabled module can run it
    const mods = RECOVERY_MODULES;
    const n = mods.length * 2;
    const res = await pc.multicall({
      contracts: list.flatMap(w => [
        ...mods.map(m => ({ address: m, abi: abi.recovery, functionName: "getRecoveryRequest", args: [w] }) as const),
        ...mods.map(m => ({ address: w, abi: abi.safe, functionName: "isModuleEnabled", args: [m] }) as const),
      ]),
      allowFailure: true,
    });
    list.forEach((w, i) => {
      const r = res.slice(i * n, i * n + n);
      mods.forEach((_, j) => {
        const v = r[j].status === "success" ? (r[j].result as any) : null;
        if (v && Number(v.executeAfter) > 0 && r[mods.length + j].result === true)
          out.push({ chainId: c.id, wallet: w, executeAfter: Number(v.executeAfter), newOwners: [...v.newOwners] });
      });
    });
  }
  return out;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function recoveryText(r: Request, soon: boolean) {
  const when = new Date(r.executeAfter * 1000).toUTCString().replace(" GMT", " UTC");
  const subject = soon ? "Recovery lands in less than a day" : "Someone started a recovery on your wallet";
  const text = [
    `A recovery on your Instant Wallet ${short(r.wallet)} (${chainById(r.chainId)?.name ?? r.chainId}) will replace your keys with ${r.newOwners.map(short).join(", ")} on ${when}.`,
    "",
    "If this is you (a lost phone or wedgie), do nothing.",
    `If it isn't, open ${SITE} now and tap Cancel it.`,
  ].join("\n");
  return { subject, text };
}
