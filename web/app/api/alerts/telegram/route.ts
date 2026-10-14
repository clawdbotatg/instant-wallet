import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { getContacts, notify, putContacts, sendTelegram, take } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/**
 * The Telegram bot's webhook. The app hands you t.me/<bot>?start=<code> (made after a Face ID, good for an hour);
 * your "/start <code>" here links this chat to that wallet. Set it up once:
 *   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://instantwallet.io/api/alerts/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
 */
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) return NextResponse.json({ ok: false }, { status: 401 });
  const u = await req.json().catch(() => null);
  const m = u?.message;
  const chat = m?.chat?.id;
  if (typeof chat !== "number") return NextResponse.json({ ok: true });
  const code = /^\/start\s+([0-9a-f]{32})$/.exec(String(m.text ?? "").trim())?.[1];
  if (!code) {
    await sendTelegram(chat, "This bot sends Instant Wallet recovery alerts. Turn them on in the app: Keys → Alerts → Telegram.").catch(() => {});
    return NextResponse.json({ ok: true });
  }
  const w = await take(`tg:${code}`);
  if (!w) {
    await sendTelegram(chat, "That link expired. Tap Telegram in the app again.").catch(() => {});
    return NextResponse.json({ ok: true });
  }
  const wallet = getAddress(w);
  const old = await getContacts(wallet);
  if (old.telegram && old.telegram !== chat)
    await notify(wallet, { telegram: old.telegram }, "Your recovery alerts changed", `Telegram alerts for your Instant Wallet ${wallet} moved to another chat. If this wasn't you, open the app and check your keys.`);
  await putContacts(wallet, { ...old, telegram: chat, at: Date.now() });
  await sendTelegram(chat, `Recovery alerts are on. If anyone starts a recovery on your Instant Wallet ${wallet}, you'll hear about it here.`).catch(() => {});
  return NextResponse.json({ ok: true });
}
