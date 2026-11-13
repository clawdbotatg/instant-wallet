import { NextRequest, NextResponse } from "next/server";
import { isAddress } from "viem";

export const dynamic = "force-dynamic";

/**
 * `GET /api/spender?chain=1&address=0x…` -> `{name, sure}`: who an approval is to (the Revoke app), in a word or two.
 *   1. Revoke.cash's open spender list (github.com/RevokeCash/whois): "Gnosis CoW Protocol", "Permit2", "Uniswap"
 *   2. the EF clear-signing registry: the descriptor's owner ("Aave DAO")
 *   3. the contract's own verified name on Sourcify ("RainbowRouter"): `sure: false`, its deployer picked it, a
 *      scam can call itself Uniswap, so the page says so
 * Kept a day by the CDN; the registry index for an hour here.
 */
const WHOIS = "https://whois.revoke.cash/generated/spenders/";
const REG = "https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/";
const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(6000) }).then(r => (r.ok ? r.json() : null)).catch(() => null);

let index: { at: number; p: Promise<Record<string, string> | null> } | null = null;
function regIndex() {
  if (!index || Date.now() - index.at > 3600_000) index = { at: Date.now(), p: get(REG + "index.calldata.json") };
  return index.p;
}
const owners = new Map<string, Promise<string | null>>();
const ownerOf = (path: string) => {
  if (!owners.has(path)) owners.set(path, get(REG + path).then(d => d?.metadata?.owner || null));
  return owners.get(path)!;
};
// "RainbowRouter" -> "Rainbow Router"
const spaced = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();

export async function GET(req: NextRequest) {
  const chain = Number(req.nextUrl.searchParams.get("chain"));
  const address = req.nextUrl.searchParams.get("address") || "";
  if (!Number.isInteger(chain) || chain <= 0 || !isAddress(address)) return NextResponse.json({ error: "chain and address" }, { status: 400 });
  const a = address.toLowerCase();
  const keep = { headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" } };
  const [w, idx] = await Promise.all([get(`${WHOIS}${chain}/${address}.json`), regIndex()]);
  if (w?.name) return NextResponse.json({ name: String(w.name).slice(0, 40), sure: true }, keep);
  const path = idx?.[`eip155:${chain}:${a}`];
  const owner = path && (await ownerOf(path));
  if (owner) return NextResponse.json({ name: String(owner).slice(0, 40), sure: true }, keep);
  const s = await get(`https://sourcify.dev/server/v2/contract/${chain}/${address}?fields=compilation.name,proxyResolution`);
  const impl = s?.proxyResolution?.implementations?.[0]?.name;
  const n = impl || s?.compilation?.name;
  return NextResponse.json({ name: n ? spaced(String(n)).slice(0, 40) : null, sure: false }, keep);
}
