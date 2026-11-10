import { NextResponse } from "next/server";
import { forget, getContacts, notify, once, recoveryText, running, wallets } from "@/lib/alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The recovery watcher: every listed wallet, every chain. Hit every 5 minutes (.github/workflows/alerts.yaml).
 * Open to anyone: each alert goes out once (per recovery, and once more in its last day), and a run at most every
 * 50 s, so an extra hit only checks sooner.
 * An alert that reached nobody (every channel failed) isn't marked sent: the next run sends it again. That, or a chain
 * that couldn't be read, answers 500, so the workflow goes red.
 */
export async function GET() {
  if (!(await once("run", 50))) return NextResponse.json({ skipped: "ran under 50 s ago" });
  const list = await wallets();
  const now = Math.floor(Date.now() / 1000);
  const sent: string[] = [];
  const missed: string[] = [];
  const unread: string[] = []; // chains that couldn't be read this run
  const errors: string[] = [];
  const found = await running(list, unread);
  errors.push(...unread);
  for (const r of found) {
    const id = `${r.chainId}:${r.wallet.toLowerCase()}:${r.executeAfter}`;
    const soon = r.executeAfter - now < 24 * 3600;
    // the first alert, then a last one in its final day (a recovery that starts with < 1 day left gets one)
    const fresh = await once(`sent:${id}`, 30 * 24 * 3600);
    const last = soon && !fresh && (await once(`soon:${id}`, 30 * 24 * 3600));
    if (!fresh && !last) continue;
    const { subject, text } = recoveryText(r, !fresh);
    const reached = { n: 0 };
    const errs = await notify(r.wallet, await getContacts(r.wallet), subject, text, reached).catch(e => [String(e)]);
    errors.push(...errs);
    if (errs.length && !reached.n) {
      // nobody got it: try again next run. (One channel down while another works is not retried: no repeats.)
      await forget(fresh ? `sent:${id}` : `soon:${id}`).catch(() => {});
      missed.push(id);
    } else sent.push(id);
  }
  return NextResponse.json({ wallets: list.length, sent, missed, errors }, { status: missed.length || unread.length ? 500 : 200 });
}
