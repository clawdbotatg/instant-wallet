import { NextResponse } from "next/server";
import { getContacts, notify, once, recoveryText, running, wallets } from "@/lib/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The recovery watcher: every listed wallet, every chain. Hit every 5 minutes (.github/workflows/alerts.yaml).
 * Open to anyone: each alert goes out once (per recovery, and once more in its last day), and a run at most every
 * 50 s, so an extra hit only checks sooner.
 */
export async function GET() {
  if (!(await once("run", 50))) return NextResponse.json({ skipped: "ran under 50 s ago" });
  const list = await wallets();
  const now = Math.floor(Date.now() / 1000);
  const sent: string[] = [];
  const errors: string[] = [];
  for (const r of await running(list)) {
    const id = `${r.chainId}:${r.wallet.toLowerCase()}:${r.executeAfter}`;
    const soon = r.executeAfter - now < 24 * 3600;
    // the first alert, then a last one in its final day (a recovery that starts with < 1 day left gets one)
    const fresh = await once(`sent:${id}`, 30 * 24 * 3600);
    const last = soon && !fresh && (await once(`soon:${id}`, 30 * 24 * 3600));
    if (!fresh && !last) continue;
    const { subject, text } = recoveryText(r, !fresh);
    errors.push(...(await notify(r.wallet, await getContacts(r.wallet), subject, text)));
    sent.push(id);
  }
  return NextResponse.json({ wallets: list.length, sent, errors });
}
