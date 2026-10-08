import { type Address, type Hex, decodeFunctionData, encodeFunctionData, parseAbi, size, slice, zeroAddress } from "viem";
import { CHAINS } from "../chains";
import { type Call, abi } from "./core";

/**
 * Swaps (docs/SWAP.md): any asset → any asset, same chain or across chains. Two sources, the better price wins:
 *   - Uniswap v3 straight on chain (QuoterV2 + SwapRouter02): no API, same chain only
 *   - LI.FI (through /api/swap/quote): DEX aggregation and bridges/solvers across chains
 * One Safe batch: [approve exact] → the swap → [approve 0] → the relay's fee. No allowance outlives the tx.
 */

/** LI.FI's diamond: the same address on every chain. */
export const LIFI_DIAMOND: Address = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

/** Uniswap v3 SwapRouter02 + QuoterV2 (checked on chain 2026-10-06: factory() and WETH9() match). */
export const UNI: Record<number, { router: Address; quoter: Address; weth: Address }> = {
  8453: {
    router: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    weth: "0x4200000000000000000000000000000000000006",
  },
  1: {
    router: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
};

/** Contracts a swap batch may call (and approve, exactly, for the length of the batch). */
const TARGETS = new Set([LIFI_DIAMOND, ...Object.values(UNI).map(u => u.router)].map(a => a.toLowerCase()));
export const isSwapTarget = (a: Address) => TARGETS.has(a.toLowerCase());

export type Token = { chainId: number; address: Address; symbol: string; decimals: number; logo?: string; priceUsd?: number };

/** More well-known tokens per chain: the most traded ones there (by pool size), checked on chain 2026-10-08. */
const MORE: Record<number, Omit<Token, "chainId">[]> = {
  1: [
    { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x514910771af9ca656af840dff83e8264ecf986ca/69425617db0ef93a7c21c4f9b81c7ca5.png" },
    { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984/fcee0c46fc9864f48ce6a40ed1cdd135.png" },
    { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9/7baf403c819f679dc1c6571d9d978f21.png" },
    { address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", symbol: "stETH", decimals: 18, logo: "https://assets.coingecko.com/coins/images/13442/standard/steth_logo.png?1696513206" },
  ],
  8453: [
    { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0x940181a94a35a4569e4529a3cdfb74e38fd98631/bb455b8557be5d08ad67f4314f899e15.png" },
    { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xbe9895146f7af43049ca1c1ae358b0541ea49704/1f287272a7d8439af0f6b281ebf0143e.png" },
    { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", symbol: "VIRTUAL", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x44ff8620b8ca30902395a7bd3f2407e1a091bf73/cbb70834d9442214c846833e47648255.png" },
  ],
  42161: [
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/era_token/logo_url/0x5aea5775959fbc2557cc8789bc1bf90a239d9a91/61844453e63cf81301f845d7864236f6.png" },
    { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", decimals: 18, logo: "https://static.debank.com/image/coin/logo_url/arbitrum/854f629937ce94bebeb2cd38fb336de7.png" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", symbol: "GMX", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a/b4e362278f64a738b878e5393fa29837.png" },
    { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0xf97f4df75117a78c1a5a0dbb814af92458539fb4/69425617db0ef93a7c21c4f9b81c7ca5.png" },
  ],
  10: [
    { address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x4200000000000000000000000000000000000006/61844453e63cf81301f845d7864236f6.png" },
    { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x4200000000000000000000000000000000000042", symbol: "OP", decimals: 18, logo: "https://optimistic.etherscan.io/token/images/optimism_32.png" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", symbol: "VELO", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x9560e827af36c94d2ac33a39bce1fe78631088db/433c39cc788f0e5e31cb00dddd8b3c53.png" },
  ],
  137: [
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270/f6e604ba0324726a3d687c618aa4f163.png" },
    { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", symbol: "AAVE", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0xd6df932a45c0f255f85145f286ea0b292b21c90b/9ac673ff449bb7b8fbc8b8119caf4a1f.png" },
    { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39/cef6e0d1f77e59becae308dad59a5377.png" },
  ],
  43114: [
    { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDt", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0xdac17f958d2ee523a2206206994597c13d831ec7/464c0de678334b8fe87327e527bc476d.png" },
    { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", symbol: "WETH.e", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x152b9d0FdC40C096757F570A51E494bd4b943E50", symbol: "BTC.b", decimals: 8, logo: "https://static.debank.com/image/avax_token/logo_url/0x152b9d0fdc40c096757f570a51e494bd4b943e50/2411fb147c1cc4328edff5d204f09f80.png" },
    { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7/753d82f0137617110f8dec56309b4065.png" },
    { address: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd", symbol: "JOE", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd/25f094b523a2d6c51e084eeb8f60dd2f.png" },
  ],
  56: [
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c/6f9302fa889419e4ce8745931d2e19bf.png" },
    { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18, logo: "https://static.debank.com/image/coin/logo_url/bnb/9784283a36f23a58982fc964574ea530.png" },
    { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "CAKE", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82/9003539eb61139bd494b7412b785d482.png" },
  ],
  100: [
    { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0xe91d153e0b41518a2ce8dd3d7944fa863463a97d/3fedab836c5425fc3fc2eb542c34c81a.png" },
    { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", symbol: "GNO", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0x9c58bacc331c9aa871afd802db6379a98e80cedb/69e5fedeca09913fe078a8dca5b7e48c.png" },
    { address: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", symbol: "sDAI", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0xaf204776c7245bf4147c2612bf6e5972ee483701/8230d73bf3b22b0b095a61c79f1815cb.png" },
    { address: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430", symbol: "EURe", decimals: 18, logo: "https://docs.monerium.com/img/tokens/eure.svg" },
    { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
  ],
  42220: [
    { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/coin/logo_url/usdt/23af7472292cb41dc39b3f1146ead0fe.png" },
    { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", symbol: "USDm", decimals: 18, logo: "https://reserve.mento.org/tokens/USDm.svg" },
    { address: "0xD221812de1BD094f35587EE8E174B07B6167D9Af", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/celo_token/logo_url/0xd221812de1bd094f35587ee8e174b07b6167d9af/1430f9beebf5246bfbe8193886e0d302.png" },
  ],
  146: [
    { address: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", symbol: "wS", decimals: 18, logo: "https://static.debank.com/image/sonic_token/logo_url/0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38/b4cc70d040518a88adac18d906fcbfff.png" },
    { address: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x6047828dc181963ba44974801FF68e538dA5eaF9", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x3333b97138D4b086720b5aE8A7844b1345a33333", symbol: "SHADOW", decimals: 18, logo: "https://static.debank.com/image/sonic_token/logo_url/0x3333b97138d4b086720b5ae8a7844b1345a33333/72eb44fe5e33b375362d5256423b5293.png" },
  ],
  999: [
    { address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0x5555555555555555555555555555555555555555/752e760ec0b1a17b81c7535e09e76ef8.png" },
    { address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", symbol: "UBTC", decimals: 8, logo: "https://static.debank.com/image/hyper_token/logo_url/0x9fdbda0a5e284c32744d2f17ee5c74b284993463/0e625d069e829a7e3aa6ef5ea569ae59.png" },
    { address: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907", symbol: "UETH", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0xbe6727b535545c67d5caa73dea54865b92cf7907/c3d23de18dc7c3c3c77208c886e8e392.png" },
  ],
  9745: [
    { address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x6100E367285b01F48D07953803A2d8dCA5D19873", symbol: "WXPL", decimals: 18, logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/36645.png" },
  ],
  4663: [
    { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/uni_token/logo_url/uni/48bfb74adddd170e936578aec422836d.png" },
    { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/33793.png" },
  ],
  5042: [
    { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", symbol: "EURC", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x1abaea1f7c830bd89acc67ec4af516284b1bc33c/790d0c3a6da87111b66255c0d57108fa.png" },
  ],
};

/** The "To" list: the well-known tokens on each chain (anything else: search, or paste its address). */
export const POPULAR: Record<number, Omit<Token, "chainId">[]> = {
  // every other chain: its native coin, its USDC, and its most traded tokens
  ...Object.fromEntries(
    CHAINS.map(c => [
      c.id,
      [
        ...(c.nativeIsUsdc ? [] : [{ address: zeroAddress, symbol: c.native.symbol, decimals: 18, logo: c.native.logo }]),
        ...(c.usdc ? [{ address: c.usdc, symbol: "USDC", decimals: 6 }] : []),
        ...(MORE[c.id] ?? []),
      ],
    ]),
  ),
  8453: [
    { address: zeroAddress, symbol: "ETH", decimals: 18 },
    { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
    { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
    { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
    ...MORE[8453],
  ],
  1: [
    { address: zeroAddress, symbol: "ETH", decimals: 18 },
    { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
    { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
    { address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", symbol: "WETH", decimals: 18 },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
    { address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", symbol: "WBTC", decimals: 8 },
    { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18 },
    ...MORE[1],
  ],
};

/** A priced, ready-to-sign route. Amounts in base units (strings, so it survives JSON). */
export type SwapRoute = {
  via: "uniswap" | "lifi";
  tool: string; // what does the work: "Uniswap", "Across", "NearIntents", …
  from: Token;
  to: Token;
  fromAmount: string;
  toAmount: string;
  toAmountMin: string;
  toUsd?: number;
  fromUsd?: number;
  seconds: number; // how long until it lands (0 = in this tx)
  gas: string; // the swap's own gas, on top of the Safe tx (for the relay's fee)
  tx: { to: Address; data: Hex; value: string };
  approval?: Address; // ERC-20 in: who to approve (exactly, then back to 0)
  until: number; // ms: don't sign a quote older than this
};

const approve = (token: Address, spender: Address, amount: bigint): Call => ({
  to: token,
  value: 0n,
  data: encodeFunctionData({ abi: abi.erc20, functionName: "approve", args: [spender, amount] }),
});

/** The batch's calls (the relay's fee goes after these). */
export function swapCalls(r: SwapRoute): Call[] {
  const swap: Call = { to: r.tx.to, value: BigInt(r.tx.value), data: r.tx.data };
  if (r.from.address === zeroAddress || !r.approval) return [swap];
  return [approve(r.from.address, r.approval, BigInt(r.fromAmount)), swap, approve(r.from.address, r.approval, 0n)];
}

const APPROVE = "0x095ea7b3";
const sel = (d: Hex) => (size(d) >= 4 ? slice(d, 0, 4) : "0x");
const isApprove = (c: Call) => c.value === 0n && size(c.data) === 68 && sel(c.data) === APPROVE;
/** An exact approval to a swap router (whether it's reset is checkSwap's job). */
export const approvesRouter = (c: Call) => isApprove(c) && isSwapTarget(("0x" + c.data.slice(34, 74)) as Address);

/**
 * The relay's view of a swap batch: every swap call goes to a known router and names this Safe as the receiver
 * (its address is in the calldata), and every approval is to a router and set back to 0 before the batch ends.
 * Throws a plain-English reason, else returns whether the batch is a swap at all. (Any other call is checkCalls'.)
 */
export function checkSwap(safe: Address, calls: Call[]): boolean {
  const me = safe.slice(2).toLowerCase();
  let swap = false;
  const open = new Map<string, bigint>();
  for (const c of calls) {
    if (isSwapTarget(c.to)) {
      if (!c.data.toLowerCase().includes(me)) throw new Error("that swap doesn't pay this wallet");
      swap = true;
    } else if (approvesRouter(c)) {
      const d = decodeFunctionData({ abi: abi.erc20, data: c.data });
      const [spender, amount] = d.args as [Address, bigint];
      open.set(`${c.to.toLowerCase()}:${spender.toLowerCase()}`, amount);
    }
  }
  if ([...open.values()].some(v => v !== 0n)) throw new Error("an approval would outlive the swap");
  return swap;
}

/** SwapRouter02 + QuoterV2, only what we call. */
export const uniAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])",
]);

/** SwapRouter02's "the router itself" recipient: the swap lands there, then unwrapWETH9 sends ETH to the Safe. */
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
