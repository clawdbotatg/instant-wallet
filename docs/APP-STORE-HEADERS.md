# Safe Apps frame headers (fetched 2026-10-28)

Source: `https://safe-client.safe.global/v1/chains/{1,8453,100}/safe-apps` (listed apps only), deduped by URL: 55 apps.
Method: `curl -s -L` GET with browser UA, last response in the redirect chain; repeated with `Sec-Fetch-Dest: iframe` and `Referer: https://app.safe.global/` vs `Referer: https://instantwallet.io/` to catch referer-gated headers. Bot-walled ones re-checked by same-origin `fetch()` in a real Chrome tab.

Class: **a** = frameable by any origin (no XFO/frame-ancestors, or `frame-ancestors *`) · **b** = frame-ancestors allowlist that includes app.safe.global but not us · **c** = not frameable · **?** = unreachable.
Note: when CSP frame-ancestors is present, browsers ignore X-Frame-Options, so `XFO: SAMEORIGIN` + frame-ancestors allowlist = class b.

Counts: a=32  b=22  c=0  ?=1

Chains column: 1=Ethereum, 8453=Base, 100=Gnosis. accessControl is from the Safe API.

| Class | App | Chains | URL | Status | X-Frame-Options | CSP frame-ancestors | manifest.json | accessControl | Features | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| a | Aave Governance | 1 | https://vote.onaave.com | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | - |  |
| a | Aave v3 | 1,100,8453 | https://app.aave.com | 200 | - | - | yes (name=Aave) | NO_RESTRICTIONS | - |  |
| a | Aerodrome Finance | 8453 | https://aerodrome.finance | 200 | - | - | yes (name=Aerodrome Finance) | NO_RESTRICTIONS | - |  |
| a | Balancer | 1,100,8453 | https://balancer.fi/pools | 200 | - | - | yes (Balancer) | NO_RESTRICTIONS | - | via browser fetch (curl got Vercel 429 bot wall) |
| a | Bulla Banker | 1,100 | https://banker.bulla.network | 200 | - | - | yes (name=Bulla Banker) | NO_RESTRICTIONS | - |  |
| a | CoW Swap | 1,100,8453 | https://swap.cow.fi | 200 | - | * | yes (name=CoW Swap) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | CSV Airdrop | 1,100,8453 | https://brown-crowded-meerkat-517.mypinata.cloud/ipfs/bafybeih2fu2oj4a2fvfci5rm7ndand7bi6wnj3rkbqaxofsqx4yhwbey6a | 200 | - | - | yes (name=CSV Airdrop) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Curve Finance | 1 | https://www.curve.finance/ | 200 | - | - | yes (name=Curve) | DOMAIN_ALLOWLIST:https://gnosis-safe.io,https://app.safe.global | BATCHED_TRANSACTIONS |  |
| a | DeFi Saver | 1,8453 | https://app.defisaver.com | 200 | - | - | yes (name=DeFi Saver) | NO_RESTRICTIONS | - |  |
| a | Drain Account | 1,100,8453 | https://apps-portal.safe.global/drain-safe | 200 | - | - | yes (name=Drain Account) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Furucombo | 1 | https://furucombo.app | 200 | - | - | no (404) | NO_RESTRICTIONS | - |  |
| a | Gnosis Bridge | 1,100 | https://bridge.gnosischain.com/ | 200 | - | - | yes (name=Gnosis Bridge) | NO_RESTRICTIONS | - |  |
| a | Lagoon Finance | 1,8453 | https://app.lagoon.finance/ | 200 | - | - | yes (name=Lagoon Finance) | NO_RESTRICTIONS | - |  |
| a | Lido Staking | 1 | https://stake.lido.fi/?ref=0x5afE11DBF44AB2D88162f687e01F8DD7a8A3EEEe | 200 | - | * | no (200, not json) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | LlamaPay | 1,100,8453 | https://gnosis-safe.llamapay.io/create | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | PancakeSwap | 1 | https://pancakeswap.finance | 200 | - | - | yes (name=PancakeSwap) | NO_RESTRICTIONS | - |  |
| a | Rango Exchange | 1 | https://app.rango.exchange/ | 200 | - | - | yes (Rango Exchange) | NO_RESTRICTIONS | - | via browser fetch (curl got Vercel 429 bot wall) |
| a | Revoke.cash | 1,100,8453 | https://revoke.cash/ | 200 | - | - | yes (name=Revoke.cash) | NO_RESTRICTIONS | - |  |
| a | Safenet Aegis Staking | 1 | https://safenet-staking.bzz.limo/ | 200 | - | - | yes (name=Safenet Aegis Staking) | NO_RESTRICTIONS | - |  |
| a | Safe{Pass}/{DAO} | 1 | https://community.safe.global/governance | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Snapshot | 1,100,8453 | https://snapshot.org | 200 | - | - | yes (name=Snapshot) | NO_RESTRICTIONS | - |  |
| a | Spark | 1,100,8453 | https://app.spark.finance/ | 200 | - | - | yes (name=Spark) | NO_RESTRICTIONS | - |  |
| a | Squid | 1 | https://app.squidrouter.com | 200 | - | - | yes (name=Squid App) | NO_RESTRICTIONS | - |  |
| a | Summer.fi | 1 | https://summer.fi | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | - |  |
| a | Superfluid | 1,100,8453 | https://app.superfluid.org | 200 | - | - | yes (name=Superfluid Dashboard) | NO_RESTRICTIONS | - |  |
| a | Teller | 1,8453 | https://app.teller.org | 200 | - | - | yes (name=Teller) | NO_RESTRICTIONS | - |  |
| a | Transaction Builder | 1,100,8453 | https://apps-portal.safe.global/tx-builder/ | 200 | - | - | yes (name=Transaction Builder) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Velora (formerly ParaSwap) | 1,100,8453 | https://embedded.velora.xyz/app/?partner=safe_app&embed=true&enableNetworkSwitch=false | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Venus Protocol | 1,8453 | https://venus.io/?utm_source=SafeWallet | 200 | - | - | no (200, not json) | NO_RESTRICTIONS | - |  |
| a | Zodiac | 1,100,8453 | https://zodiac.gnosisguild.org/ | 200 | - | - | yes (name=Zodiac) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| a | Zodiac Exit App | 1,100 | https://exit.gnosisguild.org | 200 | - | - | yes (name=Zodiac Exit App) | NO_RESTRICTIONS | - |  |
| a | Zodiac Roles | 1,100,8453 | https://roles.gnosisguild.org/ | 200 | - | - | yes (name=Zodiac Roles) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | 1inch.com | 1,100,8453 | https://1inch.com/swap | 200 | - | 'self' https://gnosis-safe.io https://dev.gnosis-safe.io https://dapp-browser.apps.ledger.com https://ledger-live-platform-apps.vercel.app https://bsc.gnosis-safe.io https://polygon.gnosis-safe.io https://tmm.world https://chamberfi.com https://dh-pre-prod.vercel.app/ https://app.safe.global https://*.coinshift.xyz https://connect.trezor.io https://verify.walletconnect.com https://wallet-v2.blocto.app https://1inch.cloudflareaccess.com https://buy.moonpay.com https://*.blockscout.com https://1inch.github.io https://connect.solflare.com https://1inch.com https://staging.1inch.com | no (404) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Arcadia Finance | 8453 | https://arcadia.finance | 200 | - | 'self' https://app.safe.global https://farcaster.xyz https://*.farcaster.xyz https://warpcast.com https://*.warpcast.com https://wallet.coinbase.com https://base.org https://*.base.org https://base.app https://*.base.app | yes (name=Arcadia Finance) | NO_RESTRICTIONS | - |  |
| b | Arrakis Pro | 1,8453 | https://app.arrakis.finance/pro | 200 | - | 'self' https://app.safe.global | yes (name=Arrakis Pro) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Compound | 1,8453 | https://app.compound.xyz/ | 200 | - | 'self' https://app.safe.global | yes (name=Compound III) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | ENS - Ethereum Name Service | 1 | https://app.ens.domains | 200 | - | https://app.safe.global | yes (name=ENS App V4) | NO_RESTRICTIONS | - |  |
| b | Figment | 1 | https://dapp.figment.io/safe/dapp/ethereum | 200 | - | https://app.safe.global/ https://app.safe.protofire.io *.ledger-sbx.com *.ledger-stg.com *.ledger-ppr.com *.ledger-test.com https://platform.apps.ledger.com | yes (name=Figment) | NO_RESTRICTIONS | - |  |
| b | Fluid | 1,8453 | https://fluid.io | 200 | - | 'self' https://*.walletconnect.com https://app.safe.global https://gnosis-safe.io https://coinshift.global https://*.coinshift.global https://dhedge.org https://www.base.dev https://manage.mellow.finance https://manage.stage.mellow.finance | yes (name=Fluid) | DOMAIN_ALLOWLIST:https://app.safe.global | BATCHED_TRANSACTIONS |  |
| b | Hedgey Vesting Tokens | 1,100,8453 | https://app.hedgey.finance/vesting | 200 | - | 'self' https://gnosis-safe.io https://app.safe.global https://safe.evmos.org https://multisig.harmony.one https://beta.coinshift.xyz https://app.oryy.io https://staging-v2.coinshift.xyz https://*.blockscout.com https://safe.optimism.io https://blast-safe.io https://safe.berachain.com https://multisig.mantle.xyz https://safe.linea.build https://safe.iotaledger.net https://*.nounspace.com https://explorer.zora.energy https://*.nektar.network https://safe.onchainden.com https://safe.gobob.xyz https://safe.autonomys.xyz | yes (name=0xHedgey Token Vesting) | DOMAIN_ALLOWLIST:https://app.safe.global | BATCHED_TRANSACTIONS |  |
| b | Jumper Exchange | 1,100,8453 | https://jumper.xyz | 200 | - | 'self' https://strapi.jumper.exchange https://strapi.jumper.xyz https://ember.so https://trade.bluefin.io https://app.safe.global https://base.app https://base.dev https://base.org https://*.base.org https://*.base.app https://*.base.dev https://farcaster.xyz https://*.farcaster.xyz | yes (name=Jumper) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | KyberSwap | 1,8453 | https://kyberswap.com/ | 200 | sameorigin | 'self' https://app.safe.global  (only when Referer is app.safe.global; plain 'self' otherwise) | yes | NO_RESTRICTIONS | - | REFERER-GATED: header changes with Referer |
| b | Maple Finance | 1 | https://app.maple.finance/earn | 200 | DENY | 'self' https://app.maple.finance ... https://app.safe.global *.onesafe.io https://verify.walletconnect.com ... https://jumpshare.com | yes (Maple Finance) | NO_RESTRICTIONS | - | via browser fetch; curl got Cloudflare 403. Final URL /earn/restricted |
| b | Monerium | 1,100 | https://monerium.app | 200 | - | 'self' https://app.safe.global https://wallet.ambire.com/ https://verify.walletconnect.com/ https://*.coinshift.global/ http://localhost:5173 https://idos-pay-demo.vercel.app/ https://staging.safe.linea.build https://safe.linea.build | yes (name=Monerium) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Morpho | 1,8453 | https://app.morpho.org/ | 200 | SAMEORIGIN | 'self' https://app.safe.global https://manage.mellow.finance https://manage.stage.mellow.finance | yes (name=Morpho) | NO_RESTRICTIONS | - |  |
| b | Pendle Finance | 1,8453 | https://app.pendle.finance/?utm_source=SafeWallet | 200 | - | https://app.safe.global https://coinshift.global https://*.coinshift.global http://localhost:5173 http://localhost:3000 | no (200, not json) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Request Finance | 1,100,8453 | https://app.request.finance | 200 | - | 'self' *.request.finance app.safe.global safe.fuse.io *.ledger-sbx.com *.ledger-stg.com *.ledger-ppr.com *.ledger-test.com dapp-browser.apps.ledger.com platform.apps.ledger.com vault.ledger.com *.octav.fi | yes (name=Request Finance) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Sablier | 1,100,8453 | https://app.sablier.com/ | 200 | - | 'self' https://*.safe.global https://impersonator.xyz https://app.decent.build https://app.decentdao.org https://staging.safe.abs.xyz https://stg.safe.morphl2.io https://safe.abs.xyz https://safe.berachain.com https://safe.chiliz.com https://safe.denergychain.com https://safe.lightlink.io https://safe.morphl2.io https://safe.optimism.io | yes (name=Sablier) | NO_RESTRICTIONS | BATCHED_TRANSACTIONS |  |
| b | Silo Finance | 1 | https://app.silo.finance | 200 | - | https://app.safe.global https://wallet.ambire.com | yes (name=Silo) | NO_RESTRICTIONS | - |  |
| b | sky.money | 1 | https://app.sky.money/ | 200 | - | 'self' https://app.safe.global | yes (name=sky.money) | NO_RESTRICTIONS | - |  |
| b | StakeWise | 1,100 | https://app.stakewise.io/ | 200 | SAMEORIGIN | 'self' https://app.safe.global https://*.blockscout.com | yes (name=StakeWise | Ethereum Liqu) | NO_RESTRICTIONS | - |  |
| b | Sushi | 1,100 | https://www.sushi.com/ | 200 | - | 'self' https://app.safe.global https://app.m-safe.io https://testnet.m-safe.io | yes (name=Sushi) | NO_RESTRICTIONS | - |  |
| b | Uniswap | 1 | https://app.uniswap.org | 200 | SAMEORIGIN | 'self' https://app.safe.global https://dexscreener.com https://*.dexscreener.com | no (200, not json) | NO_RESTRICTIONS | - |  |
| b | Yearn | 1 | https://yearn.fi | 200 | - | 'self' https://app.safe.global https://eth.blockscout.com https://polygon.blockscout.com https://base.blockscout.com https://arbitrum.blockscout.com https://explorer.optimism.io https://dapps.coin98.com | yes (name=Yearn) | NO_RESTRICTIONS | - |  |
| ? | Token Approval Manager | 1,100 | https://schmanu.infura-ipfs.io/ipfs/QmVvdFrdcv4ivCbimG2NCfoeQFtw7ynEDJHX9VAWQnoRJC | None | - | - | ? | NO_RESTRICTIONS | - | IPFS gateway timeout / 429 (unreachable) |
