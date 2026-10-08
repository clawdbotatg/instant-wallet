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

/**
 * More well-known tokens per chain, ~20 with the coin and USDC: the most traded there (by pool size and volume),
 * each checked on chain 2026-10-08. Robinhood's stock tokens all share one issuer's contract code. Search finds the rest.
 */
const MORE: Record<number, Omit<Token, "chainId">[]> = {
  1: [
    { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x514910771af9ca656af840dff83e8264ecf986ca/69425617db0ef93a7c21c4f9b81c7ca5.png" },
    { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", symbol: "UNI", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x1f9840a85d5af5bf1d1762f925bdaddc4201f984/fcee0c46fc9864f48ce6a40ed1cdd135.png" },
    { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", symbol: "AAVE", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9/7baf403c819f679dc1c6571d9d978f21.png" },
    { address: "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", symbol: "stETH", decimals: 18, logo: "https://assets.coingecko.com/coins/images/13442/standard/steth_logo.png?1696513206" },
    { address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F", symbol: "USDS", decimals: 18, logo: "https://assets.coingecko.com/coins/images/39926/standard/usds.webp?1726666683" },
    { address: "0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", symbol: "PYUSD", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x6c3ea9036406852006290770bedfcaba0e23a0e8/8af98a6a2c36c107eeb4b349fddb51b0.png" },
    { address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", symbol: "weETH", decimals: 18, logo: "https://assets.coingecko.com/coins/images/33033/small/weETH.png" },
    { address: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", symbol: "wstETH", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0/d0405a0d11669d4e75286d8dd808e19b.png" },
    { address: "0x68749665FF8D2d112Fa859AA293F07A622782F38", symbol: "XAUt", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x68749665ff8d2d112fa859aa293f07a622782f38/a100487c27e4e6e5557ef770230c7f8b.png" },
    { address: "0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E", symbol: "crvUSD", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e/0eb208f018ae08f504b2c201172b8eea.png" },
    { address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", symbol: "PEPE", decimals: 18 },
    { address: "0xfAbA6f8e4a5E8Ab82F62fe7C39859FA577269BE3", symbol: "ONDO", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xfaba6f8e4a5e8ab82f62fe7c39859fa577269be3/5afbedf06f5827e346deada3dc7d7c39.png" },
    { address: "0x57e114B691Db790C35207b2e685D4A43181e6061", symbol: "ENA", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x57e114b691db790c35207b2e685d4a43181e6061/f6063e563114a7df3903c930674a9230.png" },
    { address: "0xE0f63A424a4439cBE457D80E4f4b51aD25b2c56C", symbol: "SPX", decimals: 8, logo: "https://static.debank.com/image/eth_token/logo_url/0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c/70dadec8c2829bab2a469c6576387a83.png" },
  ],
  8453: [
    { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0x940181a94a35a4569e4529a3cdfb74e38fd98631/bb455b8557be5d08ad67f4314f899e15.png" },
    { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xbe9895146f7af43049ca1c1ae358b0541ea49704/1f287272a7d8439af0f6b281ebf0143e.png" },
    { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", symbol: "VIRTUAL", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x44ff8620b8ca30902395a7bd3f2407e1a091bf73/cbb70834d9442214c846833e47648255.png" },
    { address: "0xBAa5CC21fd487B8Fcc2F632f3F4E8D37262a0842", symbol: "MORPHO", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842/c092d2c513136e17883955cdd2c62ff1.png" },
    { address: "0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf", symbol: "VVV", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf/cb6b0ee99f533c8a6d5459587c77cb8e.png" },
    { address: "0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b", symbol: "BNKR", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b/e1adcf390c0bd765f0008721e3817e28.png" },
    { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", decimals: 18, logo: "https://strapi.jumper.exchange/uploads/degen_38108fbdaa.webp" },
    { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT", decimals: 18, logo: "https://strapi.jumper.exchange/uploads/brett_ca2d328cc8.jpeg" },
    { address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", symbol: "TOSHI", decimals: 18, logo: "https://strapi.jumper.exchange/uploads/toshi_51fef7e455.webp" },
    { address: "0x1111111111166b7FE7bd91427724B487980aFc69", symbol: "ZORA", decimals: 18, logo: "https://static.debank.com/image/base_token/logo_url/0x1111111111166b7fe7bd91427724b487980afc69/5cfbf8c19d9328428ea7be742e5a630d.png" },
    { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6, logo: "https://static.debank.com/image/base_token/logo_url/0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42/d780f677e5a8c6a28cca43f5a091e8a7.png" },
    { address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", symbol: "wstETH", decimals: 18, logo: "https://static.debank.com/image/canto_token/logo_url/0xc71aaf8e486e3f33841bb56ca3fd2ac3fa8d29a8/ba9510019b6fe342763515973115cc3c.png" },
  ],
  42161: [
    { address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/era_token/logo_url/0x5aea5775959fbc2557cc8789bc1bf90a239d9a91/61844453e63cf81301f845d7864236f6.png" },
    { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", symbol: "ARB", decimals: 18, logo: "https://static.debank.com/image/coin/logo_url/arbitrum/854f629937ce94bebeb2cd38fb336de7.png" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a", symbol: "GMX", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0xfc5a1a6eb076a2c7ad06ed22c90d7e710e35ad0a/b4e362278f64a738b878e5393fa29837.png" },
    { address: "0xf97f4df75117a78c1A5a0DBb814Af92458539FB4", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0xf97f4df75117a78c1a5a0dbb814af92458539fb4/69425617db0ef93a7c21c4f9b81c7ca5.png" },
    { address: "0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe", symbol: "weETH", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee/bbe132e0827e0b26a725a6c81de284b5.png" },
    { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8, logo: "https://static.debank.com/image/base_token/logo_url/0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf/a4ae837a6ca2fc45f07a74898cc4ba45.png" },
    { address: "0x5979D7b546E38E414F7E9822514be443A4800529", symbol: "wstETH", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x5979d7b546e38e414f7e9822514be443a4800529/7e931af8cb34b6f5671ca2eb1b847849.png" },
    { address: "0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8", symbol: "PENDLE", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x0c880f6761f1af8d9aa9c466984b80dab9a8c9e8/b9351f830cd0a6457e489b8c685f29ad.png" },
    { address: "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978", symbol: "CRV", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x11cdb42b0eb46d95f990bedd4695a6e3fa034978/38f4cbac8fb4ac70c384a65ae0cca337.png" },
    { address: "0x9623063377AD1B27544C965cCd7342f7EA7e88C7", symbol: "GRT", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x9623063377ad1b27544c965ccd7342f7ea7e88c7/8a3fcf468cdf3ae0c7a56cfb12ab4816.png" },
    { address: "0x289ba1701C2F088cf0faf8B3705246331cB8A839", symbol: "LPT", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x289ba1701c2f088cf0faf8b3705246331cb8a839/2b0e16c3295259f03cb6a737f373608d.png" },
    { address: "0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0", symbol: "UNI", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0/fcee0c46fc9864f48ce6a40ed1cdd135.png" },
    { address: "0x539bdE0d7Dbd336b79148AA742883198BBF60342", symbol: "MAGIC", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x539bde0d7dbd336b79148aa742883198bbf60342/68a7b26beb3b26432f8603ae00f9f718.png" },
    { address: "0x18c11FD286C5EC11c3b683Caa813B77f5163A122", symbol: "GNS", decimals: 18, logo: "https://static.debank.com/image/arb_token/logo_url/0x18c11fd286c5ec11c3b683caa813b77f5163a122/9dc1bb50d224f58fb2e52c58785f1d59.png" },
  ],
  10: [
    { address: "0x01bFF41798a0BcF287b996046Ca68b395DbC1071", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x4200000000000000000000000000000000000006/61844453e63cf81301f845d7864236f6.png" },
    { address: "0x68f180fcCe6836688e9084f035309E29Bf0A2095", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x4200000000000000000000000000000000000042", symbol: "OP", decimals: 18, logo: "https://optimistic.etherscan.io/token/images/optimism_32.png" },
    { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", symbol: "VELO", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x9560e827af36c94d2ac33a39bce1fe78631088db/433c39cc788f0e5e31cb00dddd8b3c53.png" },
    { address: "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", symbol: "wstETH", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x1f32b1c2345538c0c6f582fcb022739c4a194ebb/7e931af8cb34b6f5671ca2eb1b847849.png" },
    { address: "0x76FB31fb4af56892A25e32cFC43De717950c9278", symbol: "AAVE", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x76fb31fb4af56892a25e32cfc43de717950c9278/9ac673ff449bb7b8fbc8b8119caf4a1f.png" },
    { address: "0x350a791Bfc2C21F9Ed5d10980Dad2e2638ffa7f6", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6/c30bfeeea5f4889668905d2911767bca.png" },
    { address: "0x8700dAec35aF8Ff88c16BdF0418774CB3D7599B4", symbol: "SNX", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x8700daec35af8ff88c16bdf0418774cb3d7599b4/fb568c26c7902169572abe8fa966e791.png" },
    { address: "0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40", symbol: "tBTC", decimals: 18, logo: "https://static.debank.com/image/op_token/logo_url/0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40/81d0f366026c3480d25d3c1dfa5b60d3.png" },
    { address: "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", symbol: "USDC", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png" },
  ],
  137: [
    { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", symbol: "DAI", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x6B175474E89094C44Da98b954EedeAC495271d0F/logo.png" },
    { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", symbol: "WPOL", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270/f6e604ba0324726a3d687c618aa4f163.png" },
    { address: "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", symbol: "AAVE", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0xd6df932a45c0f255f85145f286ea0b292b21c90b/9ac673ff449bb7b8fbc8b8119caf4a1f.png" },
    { address: "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39/cef6e0d1f77e59becae308dad59a5377.png" },
    { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", symbol: "USDC", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png" },
    { address: "0xb33EaAd8d922B1083446DC23f610c2567fB5180f", symbol: "UNI", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0xb33eaad8d922b1083446dc23f610c2567fb5180f/fcee0c46fc9864f48ce6a40ed1cdd135.png" },
    { address: "0xBbba073C31bF03b8ACf7c28EF0738DeCF3695683", symbol: "SAND", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0xbbba073c31bf03b8acf7c28ef0738decf3695683/81853b2ea8c205afa8ebbdf213637520.png" },
    { address: "0xB5C064F955D8e7F38fE0460C556a72987494eE17", symbol: "QUICK", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0xb5c064f955d8e7f38fe0460c556a72987494ee17/841c0b0cfbdf9a82c770fad1aea9022c.png" },
    { address: "0xd93f7E271cB87c23AaA73edC008A79646d1F9912", symbol: "SOL", decimals: 9, logo: "https://assets.coingecko.com/coins/images/4128/small/solana.png" },
    { address: "0xdF7837DE1F2Fa4631D716CF2502f8b230F1dcc32", symbol: "TEL", decimals: 2, logo: "https://static.debank.com/image/matic_token/logo_url/0xdf7837de1f2fa4631d716cf2502f8b230f1dcc32/161a26f47e94d3a29876733cccefa868.png" },
    { address: "0x172370d5Cd63279eFa6d502DAB29171933a610AF", symbol: "CRV", decimals: 18, logo: "https://static.debank.com/image/matic_token/logo_url/0x172370d5cd63279efa6d502dab29171933a610af/4a3b2aa9775c79867db769e3bed76e83.png" },
  ],
  43114: [
    { address: "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", symbol: "USDt", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0xdac17f958d2ee523a2206206994597c13d831ec7/464c0de678334b8fe87327e527bc476d.png" },
    { address: "0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB", symbol: "WETH.e", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x152b9d0FdC40C096757F570A51E494bd4b943E50", symbol: "BTC.b", decimals: 8, logo: "https://static.debank.com/image/avax_token/logo_url/0x152b9d0fdc40c096757f570a51e494bd4b943e50/2411fb147c1cc4328edff5d204f09f80.png" },
    { address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", symbol: "WAVAX", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7/753d82f0137617110f8dec56309b4065.png" },
    { address: "0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd", symbol: "JOE", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x6e84a6216ea6dacc71ee8e6b0a5b7322eebc0fdd/25f094b523a2d6c51e084eeb8f60dd2f.png" },
    { address: "0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE", symbol: "sAVAX", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be/1c9f8f5ffdcd19e813f85159be7663a2.png" },
    { address: "0x60781C2586D68229fde47564546784ab3fACA982", symbol: "PNG", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x60781c2586d68229fde47564546784ab3faca982/a3dd9c68afb24187117a6f7adc923d9e.png" },
    { address: "0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD", symbol: "EURC", decimals: 6, logo: "https://static.debank.com/image/avax_token/logo_url/0xc891eb4cbdeff6e073e859e987815ed1505c2acd/790d0c3a6da87111b66255c0d57108fa.png" },
    { address: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664", symbol: "USDC.e", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/logo.png" },
    { address: "0x63a72806098Bd3D9520cC43356dD78afe5D386D9", symbol: "AAVE.e", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x63a72806098bd3d9520cc43356dd78afe5d386d9/594c468396abaf8b8b43785aa06c4f8e.png" },
    { address: "0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34", symbol: "USDe", decimals: 18, logo: "https://static.debank.com/image/avax_token/logo_url/0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34/1228d6e73f70f37ec1f6fe02a3bbe6ff.png" },
  ],
  56: [
    { address: "0x55d398326f99059fF775485246999027B3197955", symbol: "USDT", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", symbol: "ETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", symbol: "BTCB", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c/6f9302fa889419e4ce8745931d2e19bf.png" },
    { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", symbol: "WBNB", decimals: 18, logo: "https://static.debank.com/image/coin/logo_url/bnb/9784283a36f23a58982fc964574ea530.png" },
    { address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", symbol: "CAKE", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82/9003539eb61139bd494b7412b785d482.png" },
    { address: "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d", symbol: "USD1", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d/20466428407a585c38e7141a7bf5e100.png" },
    { address: "0x21cAef8A43163Eea865baeE23b9C2E327696A3bf", symbol: "XAUt", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x68749665ff8d2d112fa859aa293f07a622782f38/a100487c27e4e6e5557ef770230c7f8b.png" },
    { address: "0xbA2aE424d960c26247Dd6c32edC70B295c744C43", symbol: "DOGE", decimals: 8, logo: "https://static.debank.com/image/bsc_token/logo_url/0xba2ae424d960c26247dd6c32edc70b295c744c43/5fb1f729987d700cd736b6990e164b50.png" },
    { address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE", symbol: "XRP", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe/247c7c042eb1c707fe016a18163a0b79.png" },
    { address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD", symbol: "LINK", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd/69425617db0ef93a7c21c4f9b81c7ca5.png" },
    { address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003", symbol: "TWT", decimals: 18, logo: "https://static.debank.com/image/bsc_token/logo_url/0x4b0f1812e5df2a09796481ff14017e6005508003/55d9888131510d7c8bdff5e7e2c0d871.png" },
    { address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", symbol: "FDUSD", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xc5f0f7b66764f6ec8c8dff7ba683102295e16409/9c61b134f82d8780005895d8fb6b19ab.png" },
  ],
  100: [
    { address: "0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "WXDAI", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0xe91d153e0b41518a2ce8dd3d7944fa863463a97d/3fedab836c5425fc3fc2eb542c34c81a.png" },
    { address: "0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb", symbol: "GNO", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0x9c58bacc331c9aa871afd802db6379a98e80cedb/69e5fedeca09913fe078a8dca5b7e48c.png" },
    { address: "0xaf204776c7245bF4147c2612BF6e5972Ee483701", symbol: "sDAI", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0xaf204776c7245bf4147c2612bf6e5972ee483701/8230d73bf3b22b0b095a61c79f1815cb.png" },
    { address: "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430", symbol: "EURe", decimals: 18, logo: "https://docs.monerium.com/img/tokens/eure.svg" },
    { address: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x177127622c4A00F3d409B75571e12cB3c8973d3c", symbol: "COW", decimals: 18, logo: "https://superfluid-finance.github.io/tokenlist/icons/cow.svg" },
    { address: "0x4d18815D14fe5c3304e87B3FA18318baa5c23820", symbol: "SAFE", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0x5afe3855358e112b5647b952709e6165e1c1eeee/46e9dd25f7a9df3b795d35232bc3c527.png" },
    { address: "0x6C76971f98945AE98dD7d4DFcA8711ebea946eA6", symbol: "wstETH", decimals: 18, logo: "https://static.debank.com/image/xdai_token/logo_url/0x6c76971f98945ae98dd7d4dfca8711ebea946ea6/7e931af8cb34b6f5671ca2eb1b847849.png" },
    { address: "0xaBEf652195F98A91E490f047A5006B71c85f058d", symbol: "crvUSD", decimals: 18, logo: "https://static.debank.com/image/eth_token/logo_url/0xf939e0a03fb07f59a73314e73794be0e57ac1b4e/c8e14f0d2abeda53a52c418094b7ea03.png" },
  ],
  42220: [
    { address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/coin/logo_url/usdt/23af7472292cb41dc39b3f1146ead0fe.png" },
    { address: "0x765DE816845861e75A25fCA122bb6898B8B1282a", symbol: "USDm", decimals: 18, logo: "https://reserve.mento.org/tokens/USDm.svg" },
    { address: "0xD221812de1BD094f35587EE8E174B07B6167D9Af", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/celo_token/logo_url/0xd221812de1bd094f35587ee8e174b07b6167d9af/1430f9beebf5246bfbe8193886e0d302.png" },
    { address: "0xaf37E8B6C9ED7f6318979f56Fc287d76c30847ff", symbol: "XAUt0", decimals: 6 },
    { address: "0xD8763CBa276a3738E6DE85b4b3bF5FDed6D6cA73", symbol: "EURm", decimals: 18, logo: "https://reserve.mento.org/tokens/EURm.svg" },
  ],
  146: [
    { address: "0x039e2fB66102314Ce7b64Ce5Ce3E5183bc94aD38", symbol: "wS", decimals: 18, logo: "https://static.debank.com/image/sonic_token/logo_url/0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38/b4cc70d040518a88adac18d906fcbfff.png" },
    { address: "0x50c42dEAcD8Fc9773493ED674b675bE577f2634b", symbol: "WETH", decimals: 18, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/logo.png" },
    { address: "0x6047828dc181963ba44974801FF68e538dA5eaF9", symbol: "USDT", decimals: 6, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0xdAC17F958D2ee523a2206206994597C13D831ec7/logo.png" },
    { address: "0x3333b97138D4b086720b5aE8A7844b1345a33333", symbol: "SHADOW", decimals: 18, logo: "https://static.debank.com/image/sonic_token/logo_url/0x3333b97138d4b086720b5ae8a7844b1345a33333/72eb44fe5e33b375362d5256423b5293.png" },
    { address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", symbol: "WBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/ethereum/assets/0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599/logo.png" },
    { address: "0x2D0E0814E62D80056181F5cd932274405966e4f0", symbol: "BEETS", decimals: 18, logo: "https://static.debank.com/image/sonic_token/logo_url/0x2d0e0814e62d80056181f5cd932274405966e4f0/b1e402e978f0566e6476d9af620ec6c2.png" },
  ],
  999: [
    { address: "0x5555555555555555555555555555555555555555", symbol: "WHYPE", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0x5555555555555555555555555555555555555555/752e760ec0b1a17b81c7535e09e76ef8.png" },
    { address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x9FDBdA0A5e284c32744D2f17Ee5c74B284993463", symbol: "UBTC", decimals: 8, logo: "https://static.debank.com/image/hyper_token/logo_url/0x9fdbda0a5e284c32744d2f17ee5c74b284993463/0e625d069e829a7e3aa6ef5ea569ae59.png" },
    { address: "0xBe6727B535545C67d5cAa73dEa54865B92CF7907", symbol: "UETH", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0xbe6727b535545c67d5caa73dea54865b92cf7907/c3d23de18dc7c3c3c77208c886e8e392.png" },
    { address: "0xfD739d4e423301CE9385c1fb8850539D657C296D", symbol: "kHYPE", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0xfd739d4e423301ce9385c1fb8850539d657c296d/c80ab8cb672513f5d9831c6a538f4cf5.png" },
    { address: "0x9b498C3c8A0b8CD8BA1D9851d40D186F1872b44E", symbol: "PURR", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0x9b498c3c8a0b8cd8ba1d9851d40d186f1872b44e/f24d47ea475bd86c3f1c8289191c1b64.png" },
    { address: "0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949", symbol: "XAUt0", decimals: 6, logo: "https://static.debank.com/image/hyper_token/logo_url/0xf4d9235269a96aadafc9adae454a0618ebe37949/385aafbcccaaf39039b3b659703445c3.png" },
    { address: "0xfFaa4a3D97fE9107Cef8a3F48c069F577Ff76cC1", symbol: "stHYPE", decimals: 18, logo: "https://static.debank.com/image/hyper_token/logo_url/0xffaa4a3d97fe9107cef8a3f48c069f577ff76cc1/2b4b9aeb0f707e33e511fa7276610bd6.png" },
  ],
  9745: [
    { address: "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb", symbol: "USDT", decimals: 6, logo: "https://static.debank.com/image/ink_token/logo_url/0x0200c29006150606b650577bbe7b6248f58470c1/8bba37fddc2774e06a94b8952e3e3ad7.png" },
    { address: "0x6100E367285b01F48D07953803A2d8dCA5D19873", symbol: "WXPL", decimals: 18, logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/36645.png" },
    { address: "0xC4374775489CB9C56003BF2C9b12495fC64F0771", symbol: "syrupUSDT", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x356b8d89c1e1239cbbb9de4815c39a1474d5ba7d/7071fa8d94bc1c23139bb45af26f5af9.png" },
  ],
  4663: [
    { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18, logo: "https://static.debank.com/image/uni_token/logo_url/uni/48bfb74adddd170e936578aec422836d.png" },
    { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6, logo: "https://s2.coinmarketcap.com/static/img/coins/64x64/33793.png" },
    { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec.png" },
    { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xaf3d76f1834a1d425780943c99ea8a608f8a93f9.png" },
    { address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", symbol: "TSLA", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0x322f0929c4625ed5bad873c95208d54e1c003b2d.png" },
    { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", symbol: "SPY", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0x117cc2133c37b721f49de2a7a74833232b3b4c0c.png" },
    { address: "0xD5f3879160bc7c32ebb4dC785F8a4F505888de68", symbol: "QQQ", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xd5f3879160bc7c32ebb4dc785f8a4f505888de68.png" },
    { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", symbol: "GOOGL", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3.png" },
    { address: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", symbol: "AMZN", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0x12f190a9f9d7d37a250758b26824b97ce941bf54.png" },
    { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", symbol: "META", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xc0d6457c16cc70d6790dd43521c899c87ce02f35.png" },
    { address: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", symbol: "MSFT", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xe93237c50d904957cf27e7b1133b510c669c2e74.png" },
    { address: "0xec262a75e413fAfD0dF80480274532C79D42da09", symbol: "MSTR", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xec262a75e413fafd0df80480274532c79d42da09.png" },
    { address: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", symbol: "COIN", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0x6330d8c3178a418788df01a47479c0ce7ccf450b.png" },
    { address: "0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5", symbol: "CRCL", decimals: 18, logo: "https://cdn.robinhood.com/ncw_assets/logos/0xdf0992e440dd0be65bd8439b609d6d4366bf1cb5.png" },
  ],
  5042: [
    { address: "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1", symbol: "EURC", decimals: 6, logo: "https://static.debank.com/image/eth_token/logo_url/0x1abaea1f7c830bd89acc67ec4af516284b1bc33c/790d0c3a6da87111b66255c0d57108fa.png" },
    { address: "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0", symbol: "cirBTC", decimals: 8, logo: "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/bitcoin/info/logo.png" },
    { address: "0x128cC466B61f542da60c70e3aA11c10e19B84EDB", symbol: "WETH", decimals: 18 },
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
