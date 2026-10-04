// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test, Vm } from "forge-std/Test.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";

interface IEntryPoint {
    function handleOps(InstantWallet.PackedUserOperation[] calldata ops, address payable beneficiary) external;
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

interface IUSDC {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @dev Gas in USDC through the real EntryPoint v0.8 + Circle Paymaster + USDC on a Base fork. The test contract
///      plays the bundler (any EOA calling handleOps is one). Run: forge test --mc AccountAbstraction --network optimism
///      (optimism = the RIP-7212 P-256 precompile Base has; without it the Solidity fallback just costs more gas).
contract AccountAbstractionForkTest is Test {
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address constant EP = 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108;
    address constant PM = 0x0578cFB241215b77442a541325d6A4E6dFE700Ec;
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 constant PASS_PK = 0xA11CE;
    uint256 constant CHIP_PK = 0xC111D;
    bytes32 constant CRED = keccak256("cred");
    uint256 constant USD = 1e6;

    Factory factory;
    InstantWallet impl; // for pure getters while the wallet is still undeployed
    InstantWallet w;
    bytes32 passQx;
    bytes32 passQy;
    address passId;
    address chipId;
    address bob = makeAddr("bob");
    address payable bundler = payable(address(0xB0D1E5));

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org")));
        impl = new InstantWallet();
        factory = new Factory(address(impl), address(0xDA0), 7 days);
        (uint256 x, uint256 y) = vm.publicKeyP256(PASS_PK);
        (passQx, passQy) = (bytes32(x), bytes32(y));
        w = InstantWallet(payable(factory.getAddress(passQx, passQy, 0, CRED)));
        passId = impl.signerIdOf(passQx, passQy);
        (x, y) = vm.publicKeyP256(CHIP_PK);
        chipId = impl.signerIdOf(bytes32(x), bytes32(y));
        deal(USDC, address(w), 100 * USD); // a fresh, undeployed wallet holding only USDC: no ETH anywhere
    }

    // ------------------------------------------------------------ building ops (mirrors the contract's digests)

    function domain() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("InstantWallet"),
                keccak256("3"),
                block.chainid,
                address(w)
            )
        );
    }

    function typed(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domain(), structHash));
    }

    function opDigest(InstantWallet.PackedUserOperation memory op, uint256 cut, uint48 validUntil)
        internal
        view
        returns (bytes32)
    {
        bytes memory pmd = op.paymasterAndData;
        bytes memory head = new bytes(cut);
        for (uint256 i; i < cut; ++i) head[i] = pmd[i];
        bytes32 opHash = keccak256(
            abi.encode(
                op.nonce,
                keccak256(op.initCode),
                keccak256(op.callData),
                op.accountGasLimits,
                op.preVerificationGas,
                op.gasFees,
                keccak256(head),
                cut
            )
        );
        return typed(keccak256(abi.encode(impl.USEROP_TYPEHASH(), opHash, validUntil)));
    }

    function webauthnSig(bytes32 digest) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(bytes32(0), bytes1(0x05), uint32(0));
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://instantwallet.io"}'
        );
        (bytes32 r, bytes32 s) = vm.signP256(PASS_PK, sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON)))));
        return abi.encode(r, s, uint256(23), uint256(1), authData, clientDataJSON);
    }

    function rawSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        return abi.encodePacked(r, s);
    }

    function send(address to, uint256 amount) internal pure returns (InstantWallet.Call[] memory calls) {
        calls = new InstantWallet.Call[](1);
        calls[0] = InstantWallet.Call(USDC, 0, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function newOp(address signerId, InstantWallet.Call[] memory calls, bool deploy)
        internal
        view
        returns (InstantWallet.PackedUserOperation memory op)
    {
        op.sender = address(w);
        op.nonce = IEntryPoint(EP).getNonce(address(w), uint192(uint160(signerId)));
        if (deploy) {
            op.initCode =
                abi.encodePacked(address(factory), abi.encodeCall(Factory.createWallet, (passQx, passQy, 0, CRED)));
        }
        op.callData = abi.encodePacked(InstantWallet.executeUserOp.selector, abi.encode(calls));
        op.accountGasLimits = bytes32(uint256(800_000) << 128 | 300_000); // verification | call
        op.preVerificationGas = 60_000;
        op.gasFees = bytes32(uint256(0.001 gwei) << 128 | 0.05 gwei); // priority | max
        // paymaster ‖ verification gas ‖ postOp gas ‖ mode byte; Circle reads a permit only past byte 53
        op.paymasterAndData = abi.encodePacked(PM, uint128(500_000), uint128(40_000), uint8(0));
    }

    /// @dev Signs `op` with the passkey, attaching a USDC permit to the paymaster under the same one signature.
    function signWithPermit(InstantWallet.PackedUserOperation memory op, uint256 permitAmount, uint48 validUntil)
        internal
        view
    {
        bytes32 permit = keccak256(
            abi.encodePacked(
                "\x19\x01",
                IUSDC(USDC).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(PERMIT_TYPEHASH, address(w), PM, permitAmount, IUSDC(USDC).nonces(address(w)), type(uint256).max)
                )
            )
        );
        bytes32 msgDigest = typed(keccak256(abi.encode(impl.MESSAGE_TYPEHASH(), permit)));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, USDC, permitAmount);
        uint256 cut = op.paymasterAndData.length; // everything but the permit signature itself
        bytes32 a = opDigest(op, cut, validUntil);
        bytes memory keySig = webauthnSig(typed(keccak256(abi.encode(impl.PAIR_TYPEHASH(), a, msgDigest))));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, passId, impl.PAIR_TYPEHASH(), a, keySig);
        op.signature = abi.encodePacked(validUntil, uint16(cut), msgDigest, keySig);
    }

    function signPlain(InstantWallet.PackedUserOperation memory op, uint256 pk, uint48 validUntil) internal view {
        uint256 cut = op.paymasterAndData.length;
        bytes32 d = opDigest(op, cut, validUntil);
        bytes memory keySig = pk == PASS_PK ? webauthnSig(d) : rawSig(pk, d);
        op.signature = abi.encodePacked(validUntil, uint16(cut), bytes32(0), keySig);
    }

    function submit(InstantWallet.PackedUserOperation memory op) internal returns (bool success, uint256 gasCost) {
        InstantWallet.PackedUserOperation[] memory ops = new InstantWallet.PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        vm.prank(bundler, bundler);
        IEntryPoint(EP).handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == EP && logs[i].topics[0] == sig) {
                (, success, gasCost,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
            }
        }
    }

    function later() internal view returns (uint48) {
        return uint48(block.timestamp + 60);
    }

    // ------------------------------------------------------------ tests

    /// First send ever: deploys the wallet, permits the paymaster and sends, all under one Face ID, gas in USDC.
    function test_firstSend_deploysPermitsAndPaysGasInUsdc() public {
        assertEq(address(w).code.length, 0);
        InstantWallet.PackedUserOperation memory op = newOp(passId, send(bob, 5 * USD), true);
        signWithPermit(op, 2 * USD, later());
        uint256 bundlerEth = bundler.balance;
        (bool ok, uint256 gasCost) = submit(op);
        assertTrue(ok, "op succeeded");
        assertGt(address(w).code.length, 0, "deployed by the op");
        assertEq(IERC20(USDC).balanceOf(bob), 5 * USD);
        uint256 fee = 95 * USD - IERC20(USDC).balanceOf(address(w));
        emit log_named_decimal_uint("gas paid by wallet (USDC)", fee, 6);
        emit log_named_decimal_uint("gas cost (ETH, at 0.05 gwei max fee)", gasCost, 18);
        assertGt(fee, 0, "paid gas in USDC");
        assertLt(fee, USD / 10, "under 10 cents");
        assertEq(address(w).balance, 0, "never held ETH");
        assertGt(bundler.balance, bundlerEth, "bundler refunded in ETH by the EntryPoint");
        assertGe(IERC20(USDC).allowance(address(w), PM), w.GAS_ALLOWANCE() / 2, "allowance left for next time");
    }

    /// After the first op, sends carry no permit: the standing allowance pays.
    function test_laterSends_needNoPermit() public {
        InstantWallet.PackedUserOperation memory op = newOp(passId, send(bob, USD), true);
        signWithPermit(op, 2 * USD, later());
        submit(op);
        uint256 before = IERC20(USDC).balanceOf(address(w));
        op = newOp(passId, send(bob, USD), false);
        signPlain(op, PASS_PK, later());
        (bool ok,) = submit(op);
        assertTrue(ok);
        assertEq(IERC20(USDC).balanceOf(bob), 2 * USD);
        emit log_named_decimal_uint("second send gas (USDC)", before - USD - IERC20(USDC).balanceOf(address(w)), 6);
    }

    /// A spender (here a wedgie key with a $10/day limit) pays gas from the allowance and stays inside its limit.
    function test_spender_paysGasAndIsLimited() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(CHIP_PK);
        InstantWallet.Call[] memory admin = new InstantWallet.Call[](2);
        admin[0] = InstantWallet.Call(address(w), 0, abi.encodeCall(w.addSigner, (bytes32(x), bytes32(y), 1, 0, 0)));
        admin[1] = InstantWallet.Call(address(w), 0, abi.encodeCall(w.setLimit, (chipId, USDC, uint128(10 * USD))));
        InstantWallet.PackedUserOperation memory op = newOp(passId, admin, true);
        signWithPermit(op, 2 * USD, later());
        (bool ok,) = submit(op);
        assertTrue(ok, "owner added a spender");

        op = newOp(chipId, send(bob, 6 * USD), false);
        signPlain(op, CHIP_PK, later());
        (ok,) = submit(op);
        assertTrue(ok, "spender within limit");
        assertEq(IERC20(USDC).balanceOf(bob), 6 * USD);

        op = newOp(chipId, send(bob, 6 * USD), false);
        signPlain(op, CHIP_PK, later());
        (ok,) = submit(op);
        assertFalse(ok, "over limit: execution reverts (gas still paid)");
        assertEq(IERC20(USDC).balanceOf(bob), 6 * USD);

        InstantWallet.Call[] memory approve = new InstantWallet.Call[](1);
        approve[0] = InstantWallet.Call(USDC, 0, abi.encodeCall(IERC20.approve, (bob, 1)));
        op = newOp(chipId, approve, false);
        signPlain(op, CHIP_PK, later());
        (ok,) = submit(op);
        assertFalse(ok, "spenders can only send");
        assertEq(IERC20(USDC).allowance(address(w), bob), 0);
    }

    function test_expiredOpRejected() public {
        InstantWallet.PackedUserOperation memory op = newOp(passId, send(bob, USD), true);
        signWithPermit(op, 2 * USD, uint48(block.timestamp - 1));
        InstantWallet.PackedUserOperation[] memory ops = new InstantWallet.PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA22 expired or not due"));
        IEntryPoint(EP).handleOps(ops, bundler);
    }

    function test_tamperedOpRejected() public {
        InstantWallet.PackedUserOperation memory op = newOp(passId, send(bob, USD), true);
        signWithPermit(op, 2 * USD, later());
        op.callData = abi.encodePacked(InstantWallet.executeUserOp.selector, abi.encode(send(address(0xBAD), USD)));
        InstantWallet.PackedUserOperation[] memory ops = new InstantWallet.PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSignature("FailedOp(uint256,string)", 0, "AA24 signature error"));
        IEntryPoint(EP).handleOps(ops, bundler);
    }

    function test_onlyEntryPoint() public {
        factory.createWallet(passQx, passQy, 0, CRED);
        InstantWallet.PackedUserOperation memory op = newOp(passId, send(bob, USD), false);
        vm.expectRevert(InstantWallet.OnlyEntryPoint.selector);
        w.executeUserOp(op, bytes32(0));
        vm.expectRevert(InstantWallet.OnlyEntryPoint.selector);
        w.validateUserOp(op, bytes32(0), 0);
    }
}
