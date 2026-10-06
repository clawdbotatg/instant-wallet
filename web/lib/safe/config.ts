import { type Address, type Hex, keccak256, toBytes } from "viem";

/**
 * Instant Wallet on a Safe (docs/PLAN.md). Every piece here is deployed, audited code at the same address on Base
 * and Ethereum (checked 2026-10-05; packages/foundry/test/safe proves the composition on a Base fork).
 */

export const SAFE_FACTORY: Address = "0x14F2982D601c9458F93bd70B218933A6f8165e7b"; // SafeProxyFactory 1.5.0
export const SAFE_L2: Address = "0xEdd160fEBBD92E350D4D398fb636302fccd67C7e"; // SafeL2 1.5.0 (same singleton everywhere = same address)
/** MultiSendCallOnly 1.5.0: only in the first setup (its `to = 0` = "the Safe", needed before the address exists). */
export const MULTISEND_SETUP: Address = "0xA83c336B20401Af773B6219BA5027174338D1836";
/** MultiSendCallOnly 1.4.1: every later batch. The wedgie's Safe app decodes this one and shows each action. */
export const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
export const FALLBACK_HANDLER: Address = "0x3EfCBb83A4A7AfcB4F68D501E2c2203a38be77f4"; // CompatibilityFallbackHandler 1.5.0
export const PASSKEY_FACTORY: Address = "0x1d31F259eE307358a26dFb23EB365939E8641195"; // safe-modules passkey 0.2.1
export const PASSKEY_SINGLETON: Address = "0x4E27b51350e6c2083EE19011120F50DAfEc5CA50";
export const DAIMO_VERIFIER: Address = "0xc2b78104907F722DABAc4C69f826a522B2754De4";
export const RECOVERY_7D: Address = "0x088f6cfD8BB1dDb1BB069CCb3fc1A98927D233f2"; // Candide SocialRecoveryModule, 7 days
export const DAO: Address = "0xeF899e80aA814ab8D8e232f9Ed6403A633C727ec"; // dao.buidlguidl.eth, the same Safe on both chains
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const MODULE_FACTORY: Address = "0x000000000000aDdB49795b0f9bA5BC298cDda236"; // zodiac ModuleProxyFactory 1.2.0
export const ROLES_MASTERCOPY: Address = "0xF2964CE6161ce0e75964Fe7927cE114cb0B283D5"; // Zodiac Roles 2.1.1
export const MULTISEND_UNWRAPPER: Address = "0xB4Cd4bb764C089f20DA18700CE8bc5e49F369efD";

/** P-256 precompile at 0x100 first, Daimo's verifier as the fallback: works on every chain. */
export const VERIFIERS = (0x100n << 160n) | BigInt(DAIMO_VERIFIER);
/** The wedgie's second owner slot: the same key, Daimo only, so a different signer address. */
export const VERIFIERS_SLOT2 = BigInt(DAIMO_VERIFIER);

/** Every Instant Wallet uses this salt nonce; the burner's key makes each address unique. */
export const SALT_NONCE = BigInt(keccak256(toBytes("instant-wallet.safe.v1")));

/** SafeProxy creation code (SafeProxyFactory 1.5.0 proxyCreationCode()). */
export const SAFE_PROXY_CODE: Hex = "0x608060405234801561001057600080fd5b506040516101b63803806101b68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101946022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff16021790555050607b806101196000396000f3fe608060405260005463a619486e60003560e01c14156024578060601b606c5260206060f35b3660008037600080366000845af43d6000803e806040573d6000fd5b3d6000f3fea2646970667358221220e61834ebd2d8cd909d362bf67c47ef58fd665df38e6dd036ce65611101d072e964736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";
/** SafeWebAuthnSignerProxy creation code (from the passkey factory's bytecode, via wedgie-dev src/safe/eth.ts). */
export const SIGNER_PROXY_CODE: Hex = "0x610100346100ad57601f6101b538819003918201601f19168301916001600160401b038311848410176100b2578084926080946040528339810103126100ad578051906001600160a01b03821682036100ad5760208101516040820151606090920151926001600160b01b03841684036100ad5760805260a05260c05260e05260405160ec90816100c98239608051816082015260a05181604d015260c051816027015260e0518160010152f35b600080fd5b634e487b7160e01b600052604160045260246000fdfe7f000000000000000000000000000000000000000000000000000000000000000060b63601527f000000000000000000000000000000000000000000000000000000000000000060a03601527f000000000000000000000000000000000000000000000000000000000000000036608001523660006080376000806056360160807f00000000000000000000000000000000000000000000000000000000000000005af43d600060803e60b1573d6080fd5b3d6080f3fea26469706673582212201660515548d15702d720bbc046b457ca85e941a4559ab9f9518488e4c82e5ee964736f6c634300081a0033";

/** Zodiac Roles keys for the burner's daily budget (packages/foundry/test/safe/Level2.fork.t.sol). */
export const ROLE_BURNER: Hex = keccak256(toBytes("instant-wallet.burner"));
export const KEY_USDC: Hex = keccak256(toBytes("instant-wallet.burner.usdc"));
export const KEY_ETH: Hex = keccak256(toBytes("instant-wallet.burner.eth"));
