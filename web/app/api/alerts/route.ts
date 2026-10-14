import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { type Contacts, type Signed, authorize, channels, getContacts, masked, notify, putContacts, stash } from "@/lib/alerts";

export const dynamic = "force-dynamic";

/**
 * A wallet's recovery alerts (lib/alerts.ts).
 *   GET  ?wallet                      → { channels: which are set up here, contacts: masked }
 *   POST { wallet, change, sig }      → change is a JSON string the passkey signed:
 *        {op:"email", email} · {op:"email-off"} · {op:"telegram"} (→ { link }) · {op:"telegram-off"} ·
 *        {op:"push", sub} · {op:"push-off", endpoint} · {op:"test"}
 * Taking a contact away (or swapping the email) tells the old contacts first.
 */
export async function GET(req: NextRequest) {
  const w = req.nextUrl.searchParams.get("wallet") ?? "";
  if (!isAddress(w)) return NextResponse.json({ error: "wallet?" }, { status: 400 });
  return NextResponse.json({ channels: channels(), contacts: masked(await getContacts(getAddress(w))) });
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => null);
  if (!b || !isAddress(b.wallet) || typeof b.change !== "string" || b.change.length > 4000 || !b.sig) return NextResponse.json({ error: "bad request" }, { status: 400 });
  const wallet = getAddress(b.wallet);
  const bad = await authorize(wallet, b.change, b.sig as Signed);
  if (bad) return NextResponse.json({ error: bad }, { status: 403 });
  const ch = JSON.parse(b.change);
  const old = await getContacts(wallet);
  const c: Contacts = { ...old, at: Date.now() };
  const removed = (what: string) =>
    notify(wallet, old, "Your recovery alerts changed", `${what} on your Instant Wallet ${wallet}. If this wasn't you, someone has your passkey: open the app and check your keys.`);
  let link: string | undefined;
  switch (ch.op) {
    case "email": {
      const email = String(ch.email ?? "").trim().toLowerCase();
      if (!EMAIL.test(email)) return NextResponse.json({ error: "That email doesn't look right." }, { status: 400 });
      if (!channels().email) return NextResponse.json({ error: "Email alerts aren't set up on this server yet." }, { status: 503 });
      if (old.email && old.email !== email) await removed(`The alert email was changed to ${email}`);
      c.email = email;
      break;
    }
    case "email-off":
      await removed("Email alerts were turned off");
      delete c.email;
      break;
    case "telegram": {
      if (!channels().telegram) return NextResponse.json({ error: "Telegram alerts aren't set up on this server yet." }, { status: 503 });
      const code = crypto.randomUUID().replace(/-/g, "");
      await stash(`tg:${code}`, wallet, 3600);
      link = `https://t.me/${process.env.TELEGRAM_BOT_NAME}?start=${code}`;
      break;
    }
    case "telegram-off":
      await removed("Telegram alerts were turned off");
      delete c.telegram;
      break;
    case "push": {
      const sub = ch.sub;
      if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) return NextResponse.json({ error: "bad push subscription" }, { status: 400 });
      c.push = [...(old.push ?? []).filter(p => p.endpoint !== sub.endpoint), { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }].slice(-8);
      break;
    }
    case "push-off":
      await removed("Notifications were turned off on a device");
      c.push = (old.push ?? []).filter(p => p.endpoint !== ch.endpoint);
      break;
    case "test":
      break;
    default:
      return NextResponse.json({ error: "unknown change" }, { status: 400 });
  }
  if (ch.op !== "telegram") await putContacts(wallet, c);
  // a new contact (or a test) gets a message now: you see it works
  let errors: string[] = [];
  const fresh: Contacts =
    ch.op === "test" ? c : ch.op === "email" ? { email: c.email } : ch.op === "push" ? { push: c.push?.slice(-1) } : {};
  if (fresh.email || fresh.telegram || fresh.push?.length)
    errors = await notify(wallet, fresh, "Recovery alerts are on", `If anyone starts a recovery on your Instant Wallet ${wallet}, you'll hear about it here.`);
  return NextResponse.json({ ok: true, link, errors, contacts: masked(c) });
}
