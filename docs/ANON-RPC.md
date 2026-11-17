# Private reads over Tor

**Built 2026-11-16.** Settings → Your node takes a `.onion` address. Code: `web/lib/tor.ts`, wired in `lib/chains.ts`
(`publicClient`, `rpcTransport`) and `lib/safe/light.ts`. Tested in headless Chromium against bgnodetest3: Tor up in
~11 s, reads 0.3–2 s after. On Ethereum only the tor-js hash read and `alchemy_*` reached `/api/rpc/1`.

Where the build differs from the plan below:
- Any network, not Ethereum only: the save checks the node's chain id over Tor, same as a normal node.
- The light client (Prove balances, Check it in this browser) also works over Tor: Colibri takes a custom `fetch`.
  The prover (colibri-proof.tech) is still reached directly; it serves header proofs, not your address.
- Uses viem `http()` with `fetchFn: torFetch()` (batches of 20, at most 6 requests at once, 60 s timeout), not `custom()`.
- **Sends on a local copy** (local.instantwallet.io, `run-local.sh`): the page sends its Settings → Your node to
  the relay (header `x-iw-node`, `lib/local.ts` `nodeOf`), and the relay reads, quotes and sends there. A .onion
  goes over Tor from Node (`lib/torServer.ts`, tor-js direct TCP, no gateway: ~7 s first call, ~1 s after). Our
  public site ignores the header. On our site a send still goes through our relay or your browser wallet.
- **Reads on a local copy** go through the same server Tor (`app/api/local/tor`): the page starts no Tor of its own
  and uses no gateway. Its cache: `~/.instantwallet-local/tor`, wiped if Tor says it's corrupt.
- No line under the field (same-check: no sentences under a settings box). The button says "Starting Tor…" while it starts.

A setting that sends the wallet's chain reads over Tor to a BuidlGuidl home node. No server of ours, and no
Alchemy, sees your IP with your address. This is the "hide your IP" part of CROPS level 5 (`docs/CROPS.md`).

## How it works

```
Instant Wallet (browser)
  └─ @anon-rpc/browser-harness          npm, 0.4.0
       └─ tor-js worker                 Tor in WASM, inside a locked-down iframe
            └─ gateway (KPS, WebRTC)    lets a browser reach Tor; sees only encrypted bytes
                 └─ Tor (3 hops)
                      └─ node's .onion  a BG home node, no public IP, no central proxy
                           └─ filter → reth
```

- **anon-rpc** is an EF standard (github.com/ethereum/anon-rpc). The wallet reads one contract on mainnet to get the
  hash of the Tor client code, downloads that code, checks the hash, and runs it in a sandbox. It gives back a
  normal `fetch`.
- **tor-js** is the Tor client. Its contract is `0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e`. On 2026-11-16 it
  pointed at tor-js 0.4.4, which can reach `.onion` addresses and keeps accounts on separate circuits.
- **The gateway** is needed because browsers can't open raw connections to Tor. It only passes encrypted Tor
  traffic along, so it can't see what you ask or where it goes. The EF runs a demo one; we should run our own.
- **The node** runs Tor and serves its RPC as a `.onion`. The request never leaves Tor and never touches
  `rpc.buidlguidl.com`, so no central box can see or change it.

## What each party sees

| Who | Sees |
|---|---|
| Your ISP | Tor traffic to a gateway. Not the node, not the query. |
| Gateway | Encrypted Tor traffic. |
| Node operator | The query (e.g. balance of 0xabc). Not your IP. |
| Our server, Alchemy | Nothing, for calls that go this way. |

The node still sees what you ask. The light client (`docs/PROVEN-BALANCES.md`) can check its answers. Hiding the
question itself needs PIR, which isn't ready yet.

## The test node (live)

bgnodetest3 (a home BG Client node on Austin's network, mainnet, reth, archive) serves:

```
http://pyordyljbployp76h5dlnmghwlenp4msm34zwhxcogpxbgc7ksq5a4qd.onion/
```

- Tor 0.4.9 runs in user space, with Tor's proof-of-work spam protection turned on.
- Set up by the BG client: `node index.js --tor` (PR #70). A small filter sits in front of reth. It allows read methods and `eth_sendRawTransaction` only, batches of up
  to 20, `eth_getLogs` up to 2000 blocks, and 8 requests at once. Requests naming an OFAC-sanctioned address are refused.
- Tested 2026-11-16 from Node with tor-js 0.4.4: `eth_blockNumber`, `eth_getBalance`, `eth_getLogs` all worked
  (1–7 s each). `debug_*` was refused.
- This is one test box. Real use needs many nodes (see Open).

## Build steps

The user story: in **Settings → Your node**, on Ethereum, paste
`http://pyordyljbployp76h5dlnmghwlenp4msm34zwhxcogpxbgc7ksq5a4qd.onion/` and press Save. From then on the wallet's
mainnet reads and sends go over Tor to that node.

No new setting. The existing "Your node" field (`web/components/safe/RpcSetting.tsx`) learns one thing: a URL
whose host ends in `.onion` is a Tor node.

### 1. Add the harness

`npm i @anon-rpc/browser-harness@0.4.0 --save-exact` in `web/`. Pin it exactly: it's the trusted part (it checks the
Tor code's hash and builds the sandbox). tor-js itself isn't an npm dependency: the harness downloads it from the
contract's pinned hash at run time.

### 2. New file `web/lib/tor.ts`

```ts
"use client";
import type { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { custom, type Transport } from "viem";

/** tor-js on mainnet (anon-rpc adopters.json5). Its owner can change the code; see Open #5. */
const TOR_JS = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
/** KPS gateway: how a browser reaches Tor. EF demo gateway until we run ours (Open #1). */
export const GATEWAY = "152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ";

export const isOnion = (url: string) => {
  try { return new URL(url).hostname.endsWith(".onion"); } catch { return false; }
};

let worker: Promise<AnonRpcWorker> | null = null;
/** One Tor client per page, started the first time a Tor node is used. Browser only. */
function tor(): Promise<AnonRpcWorker> {
  if (typeof window === "undefined") throw new Error("Tor runs in the browser only");
  worker ??= import("@anon-rpc/browser-harness").then(({ AnonRpcWorker }) =>
    new AnonRpcWorker({
      address: TOR_JS,
      config: { gateways: [GATEWAY] },
      // One eth_call to read TOR_JS's hash. Goes through our proxy and isn't private; it shows only that this
      // browser uses anon-rpc, not any address.
      preExisting: {
        rpcProvider: {
          request: ({ method, params }) =>
            fetch(`${location.origin}/api/rpc/1`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            }).then(r => r.json()).then(j => j.result),
        },
      },
    }),
  );
  return worker;
}

/** viem transport to a .onion node. `key` keeps accounts on separate Tor circuits (pass the Safe address). */
export const torTransport = (url: string, key = "wallet"): Transport =>
  custom({
    async request({ method, params }) {
      const r = await (await tor()).fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        anonOptions: { isolationKey: key },
      });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code });
      return j.result;
    },
  });
```

No batching: the node allows 20 calls per batch and 8 at once, and `custom()` sends one call per request. viem's
`batch` option on `custom` can be turned on later with `batchSize: 20`.

### 3. `web/lib/chains.ts`

- `publicClient()`: when `ownRpc(chainId)` is a `.onion`, use `torTransport(own)` in place of `to(own)`. Keep
  `split()`: `alchemy_*` still goes to our proxy (see Still leaks).
- Add `rpcTransport(chainId)`: `torTransport` for a `.onion`, else `http(rpcPath(chainId))`. Change the places that
  build `http(rpcPath(...))` themselves to use it: `components/Claim.tsx` (4 places) and `lib/oldSafes.ts`.
- `lib/safe/sim.ts` and `lib/safe/proven.ts` hand `rpcPath()` to the light client as a URL, and it can't fetch a
  `.onion`. If the light client can take a request function, pass the Tor transport. If not, while a `.onion` is
  set, turn "Run a light client" and "Prove balances" off and say why ("Not over Tor yet").
- No fallback to our proxy when Tor fails. A silent fallback leaks exactly what the user set this to hide. Fail
  the read and show the error, the same as an own node that's down today.

### 4. `web/components/safe/RpcSetting.tsx`

In `save()`:

```ts
if (isOnion(u)) {
  if (chainId !== 1) return toast("Tor nodes work on Ethereum only for now");
  setBusy(true); // TimedBar ms={60000}: Tor's first start takes up to a minute
  const id = await createPublicClient({ chain: mainnet, transport: torTransport(u) }).getChainId().catch(() => null);
  setBusy(false);
  if (id === null) return toast("No answer over Tor. Check the address.");
  if (id !== 1) return toast(`That isn't ${name}`);
  setOwnRpc(chainId, u);
  return toast("Using your node over Tor");
}
```

- The `https?://` check already lets `http://….onion` through. Plain `http` is fine here: Tor encrypts end to end,
  and the address is the node's key.
- Use a 60 s `TimedBar` for a `.onion` (8 s stays for normal URLs).
- Under the field, while a `.onion` is set, one line: "Over Tor. Your IP stays hidden from the node." Plus a small
  status: "Starting Tor…" until the first answer, then nothing.

### 5. Test

1. Settings → Your node → Ethereum → paste the address above → Save. Expect the bar, then "Using your node over Tor".
2. Reload. Balances on Ethereum load (slower the first time). The network tab shows no `/api/rpc/1` calls except the
   one `eth_call` to `0x700dA319…` at start and `alchemy_*`.
3. Clear the field → Save → back to "Using our node on Ethereum".
4. A bad `.onion` → "No answer over Tor" after the bar, nothing saved.
5. `npm run build` passes (no harness import on the server).

## Still leaks with this on

These don't go through `publicClient()`, so they still reach our servers or other services:

- Tokens you hold and Activity: `alchemy_getTokenBalances`, `alchemy_getAssetTransfers`, `alchemy_getTokenMetadata`.
  Fix: the log-scan plan in `docs/OWN-NODE.md` (`eth_getLogs` works over the onion).
- Prices, NFTs (`/api/price`, `/api/portfolio`, `/api/nfts`), token logos from debank/coingecko.
- The simulator (sim.wedgie.dev) sees each tx before you sign. The light-client preview avoids it.
- The relay (`/api/safe/relay`) sees your IP when it pays gas for a send.

## Costs

- First start: about 5 s in Node, up to 40 s in a browser through a gateway (measured 2026-08-24). After that,
  1–3 s per read.
- Adds the harness to the bundle. tor-js loads inside the sandbox, from the contract's pinned code.

## Open

The plan for these, in order: `docs/ANON-RPC-NEXT.md`.

1. **Our own gateway.** One box with a fixed public IP and one open UDP port (12298). Runbook: `~/anonrpc/GATEWAY-RUNBOOK.md`.
2. **More nodes.** `node index.js --tor` in buidlguidl-client sets up Tor + the filter and shows the node's `.onion`
   ([PR #70](https://github.com/BuidlGuidl/buidlguidl-client/pull/70), open; bgnodetest3 runs it).
3. **Finding nodes.** A list of node `.onion` addresses the wallet can pick from. Signed or on chain. The list
   can't change answers, only point to nodes.
4. **Base and Gnosis.** Need nodes for those chains behind their own `.onion`.
5. **Trust in the code.** The tor-js contract is owned by one EF key that can change the code every wallet runs.
   Pin a hash ourselves, or ask the EF for a timelock or multisig.
