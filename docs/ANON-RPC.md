# Private reads over Tor (plan, not built)

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
- A small filter sits in front of reth. It allows read methods and `eth_sendRawTransaction` only, batches of up
  to 20, `eth_getLogs` up to 2000 blocks, and 8 requests at once. Source: `~/bgrpc/repos/bg-tor-onion/`.
- Tested 2026-11-16 from Node with tor-js 0.4.4: `eth_blockNumber`, `eth_getBalance`, `eth_getLogs` all worked
  (1–7 s each). `debug_*` was refused.
- This is one test box. Real use needs many nodes (see Open).

## Where it goes in the code

One place: `publicClient()` in `web/lib/chains.ts`. Today it picks our proxy or "Your node". Add a third choice,
"Private", for mainnet:

```ts
import { AnonRpcWorker } from "@anon-rpc/browser-harness";
import { custom } from "viem";

const TOR_JS = "0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e";
const NODE = "http://pyordyljbployp76h5dlnmghwlenp4msm34zwhxcogpxbgc7ksq5a4qd.onion/";

// Browser only (it needs an iframe): create lazily, never during SSR.
const worker = new AnonRpcWorker({
  address: TOR_JS,
  config: { gateways: ["<ip:port:certhash of our gateway>"] },
  // Used once, to read the contract above. This one read isn't private; it only shows you use anon-rpc.
  preExisting: { rpcProvider: { request: a => fetch(proxyPath(1), post(a)).then(r => r.json()).then(j => j.result) } },
});

const transport = custom({
  async request({ method, params }) {
    const r = await worker.fetch(NODE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      anonOptions: { isolationKey: safeAddress }, // one circuit per account, so accounts can't be linked
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  },
});
```

- Keep the `split()` rule: `alchemy_*` methods have no node to go to (see Still leaks).
- No fallback to our proxy when Tor is down. A silent fallback would leak the very thing the user turned this on
  to hide. Show an error.
- Start the worker when the setting is on, not on every page load.

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

1. **Our own gateway.** One box with a fixed public IP and one open UDP port (12298). Runbook: `~/anonrpc/GATEWAY-RUNBOOK.md`.
2. **More nodes.** An opt-in `--tor` flag in buidlguidl-client that sets up Tor + the filter and prints the
   node's `.onion`.
3. **Finding nodes.** A list of node `.onion` addresses the wallet can pick from. Signed or on chain. The list
   can't change answers, only point to nodes.
4. **Base and Gnosis.** Need nodes for those chains behind their own `.onion`.
5. **Trust in the code.** The tor-js contract is owned by one EF key that can change the code every wallet runs.
   Pin a hash ourselves, or ask the EF for a timelock or multisig.
