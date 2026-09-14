// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/// @dev Two keys: a "passkey" (WebAuthn-wrapped) and a "chip" (raw). Same curve, same digests.
contract InstantWalletTest is Test {
    uint256 constant PASS_PK = 0xA11CE;
    uint256 constant CHIP_PK = 0xC111D;
    uint256 constant NEW_PK = 0x9E9E9;

    bytes32 passQx;
    bytes32 passQy;
    bytes32 chipQx;
    bytes32 chipQy;
    address passId;
    address chipId;

    MockUSDC usdc;
    InstantWallet impl;
    Factory factory;
    InstantWallet w;

    address facilitator = address(0xFAC);
    address relayer = address(0x4E1A);
    address alice = address(0xA11);

    uint256 constant USD = 1e6;
    uint8 constant WEBAUTHN = 0;
    uint8 constant RAW = 1;
    uint8 constant SPENDER = 0;
    uint8 constant OWNER = 1;

    function setUp() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PASS_PK);
        (passQx, passQy) = (bytes32(x), bytes32(y));
        (x, y) = vm.publicKeyP256(CHIP_PK);
        (chipQx, chipQy) = (bytes32(x), bytes32(y));

        usdc = new MockUSDC();
        impl = new InstantWallet();
        factory = new Factory(address(impl), address(usdc), facilitator, 1 days);

        address predicted = factory.getWalletAddress(passQx, passQy, bytes32(0));
        address deployed = factory.createWallet(bytes32(0), passQx, passQy, WEBAUTHN, keccak256("cred"));
        assertEq(deployed, predicted, "CREATE2 address is known before deployment");
        w = InstantWallet(payable(deployed));
        passId = w.signerIdOf(passQx, passQy);
        chipId = w.signerIdOf(chipQx, chipQy);

        usdc.mint(address(w), 10_000 * USD);
        vm.warp(1_800_000_000);
    }

    // ------------------------------------------------------------ signing helpers

    function rawSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        return abi.encodePacked(r, s);
    }

    function webauthnSig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        return webauthnSigFlags(pk, digest, 0x05); // UP | UV
    }

    function webauthnSigFlags(uint256 pk, bytes32 digest, bytes1 flags) internal pure returns (bytes memory) {
        bytes memory authData = abi.encodePacked(bytes32(0), flags, uint32(0)); // rpIdHash, flags, counter
        string memory clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(digest)), '","origin":"https://instant.wallet"}'
        );
        bytes32 msgHash = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, msgHash);
        // Flat tuple, exactly what WebAuthn.tryDecodeAuth expects (no leading struct offset).
        return abi.encode(r, s, uint256(23), uint256(1), authData, clientDataJSON);
    }

    function deadline() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    // ------------------------------------------------------------ the flows

    function passTransfer(address to, uint256 amount, uint256 fee) internal {
        bytes32 d = w.hashTransfer(address(usdc), to, amount, fee, w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.prank(relayer);
        w.metaTransfer(address(usdc), to, amount, fee, passId, dl, sig);
    }

    function chipTransfer(address to, uint256 amount, uint256 fee) internal {
        bytes32 d = w.hashTransfer(address(usdc), to, amount, fee, w.nonce(), deadline());
        bytes memory sig = rawSig(CHIP_PK, d);
        uint256 dl = deadline();
        vm.prank(relayer);
        w.metaTransfer(address(usdc), to, amount, fee, chipId, dl, sig);
    }

    /// @dev "Pairing": the passkey (owner) adds the chip as owner, then demotes itself to a $500/day spender.
    function pairDevice() internal {
        bytes32 d = w.hashAddSigner(chipQx, chipQy, RAW, OWNER, 0, bytes32(0), w.nonce(), deadline());
        w.metaAddSigner(chipQx, chipQy, RAW, OWNER, 0, bytes32(0), passId, deadline(), webauthnSig(PASS_PK, d));
        d = w.hashUpdateSigner(passId, SPENDER, uint128(500 * USD), w.nonce(), deadline());
        w.metaUpdateSigner(passId, SPENDER, uint128(500 * USD), passId, deadline(), webauthnSig(PASS_PK, d));
        assertEq(w.ownerCount(), 1);
        assertEq(w.getSigner(chipId).role, OWNER);
        assertEq(w.getSigner(passId).role, SPENDER);
    }

    function test_initialState() public view {
        assertEq(w.token(), address(usdc));
        assertEq(w.ownerCount(), 1);
        assertEq(w.signerCount(), 1);
        assertEq(w.credentialIdToSigner(keccak256("cred")), passId);
        assertEq(w.recoveryAddress(), facilitator);
        assertEq(w.recoveryDelay(), 1 days);
        assertEq(w.remainingAllowance(passId), type(uint256).max);
    }

    function test_passkeyOwnerTransfersWithFee() public {
        passTransfer(alice, 45 * USD, 2e4);
        assertEq(usdc.balanceOf(alice), 45 * USD);
        assertEq(usdc.balanceOf(relayer), 2e4, "fee goes to whoever relays");
        assertEq(w.nonce(), 1);
    }

    function test_replayRejected() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, deadline(), sig);
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, deadline(), sig);
    }

    function test_expiredRejected() public {
        uint256 dl = block.timestamp - 1;
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), dl);
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.Expired.selector, dl, block.timestamp));
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, dl, sig);
    }

    function test_wrongKeyRejected() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), deadline());
        bytes memory wrongKey = webauthnSig(CHIP_PK, d);
        bytes memory chipSig = rawSig(CHIP_PK, d);
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, deadline(), wrongKey);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.UnknownSigner.selector, chipId));
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, chipId, deadline(), chipSig);
    }

    function test_webauthnNeedsUserVerification() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), deadline());
        bytes memory noUV = webauthnSigFlags(PASS_PK, d, 0x01);
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, deadline(), noUV);
    }

    function test_pairDeviceThenChipOwnsAndPasskeyIsLimited() public {
        pairDevice();
        // chip: unlimited
        chipTransfer(alice, 2_000 * USD, 0);
        assertEq(usdc.balanceOf(alice), 2_000 * USD);
        // passkey: $500/day including fee
        assertEq(w.remainingAllowance(passId), 500 * USD);
        passTransfer(alice, 300 * USD, 1 * USD);
        assertEq(w.remainingAllowance(passId), 199 * USD);
        bytes32 dOver = w.hashTransfer(address(usdc), alice, 200 * USD, 0, w.nonce(), deadline());
        bytes memory over = webauthnSig(PASS_PK, dOver);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.OverLimit.selector, passId, 200 * USD, 199 * USD));
        w.metaTransfer(address(usdc), alice, 200 * USD, 0, passId, deadline(), over);
        // window rolls
        vm.warp(block.timestamp + 1 days);
        assertEq(w.remainingAllowance(passId), 500 * USD);
        passTransfer(alice, 500 * USD, 0);
        assertEq(w.remainingAllowance(passId), 0);
    }

    function test_spenderCannotExecuteOrMoveOtherTokens() public {
        pairDevice();
        MockUSDC other = new MockUSDC();
        other.mint(address(w), 5 * USD);
        bytes32 d = w.hashTransfer(address(other), alice, 1 * USD, 0, w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.TokenNotAllowed.selector, address(other)));
        w.metaTransfer(address(other), alice, 1 * USD, 0, passId, deadline(), sig);

        InstantWallet.Call[] memory calls = new InstantWallet.Call[](1);
        calls[0] = InstantWallet.Call(address(other), 0, abi.encodeCall(other.transfer, (alice, 1 * USD)));
        d = w.hashExecute(w.hashCalls(calls), w.nonce(), deadline());
        sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.NotOwner.selector, passId));
        w.metaExecute(calls, passId, deadline(), sig);

        // the chip (owner) can do both
        d = w.hashTransfer(address(other), alice, 1 * USD, 0, w.nonce(), deadline());
        w.metaTransfer(address(other), alice, 1 * USD, 0, chipId, deadline(), rawSig(CHIP_PK, d));
        d = w.hashExecute(w.hashCalls(calls), w.nonce(), deadline());
        w.metaExecute(calls, chipId, deadline(), rawSig(CHIP_PK, d));
        assertEq(other.balanceOf(alice), 2 * USD);
    }

    function test_executeBatchAtomic() public {
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](2);
        calls[0] = InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.mint, (address(w), 1 * USD)));
        calls[1] = InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (alice, 100_000 * USD))); // more than we have
        bytes32 d = w.hashExecute(w.hashCalls(calls), w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert();
        w.metaExecute(calls, passId, deadline(), sig);
        assertEq(usdc.balanceOf(address(w)), 10_000 * USD, "nothing happened");
    }

    function test_hashCallsIsRebuildableWithoutAbiEncoder() public view {
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](2);
        calls[0] = InstantWallet.Call(address(0x1), 7, hex"deadbeef");
        calls[1] = InstantWallet.Call(address(0x2), 0, "");
        bytes32 h0 = keccak256(abi.encode(address(0x1), uint256(7), keccak256(hex"deadbeef")));
        bytes32 h1 = keccak256(abi.encode(address(0x2), uint256(0), keccak256("")));
        assertEq(w.hashCalls(calls), keccak256(abi.encodePacked(h0, h1)));
    }

    function test_cannotRemoveOrDemoteLastOwner() public {
        bytes32 d = w.hashRemoveSigner(passId, w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(InstantWallet.LastOwner.selector);
        w.metaRemoveSigner(passId, passId, deadline(), sig);
        d = w.hashUpdateSigner(passId, SPENDER, 1, w.nonce(), deadline());
        sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(InstantWallet.LastOwner.selector);
        w.metaUpdateSigner(passId, SPENDER, 1, passId, deadline(), sig);
    }

    function test_chipRemovesLostPhoneAndAddsNewOne() public {
        pairDevice();
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        bytes32 d = w.hashAddSigner(bytes32(x), bytes32(y), WEBAUTHN, SPENDER, uint128(500 * USD), keccak256("cred2"), w.nonce(), deadline());
        w.metaAddSigner(bytes32(x), bytes32(y), WEBAUTHN, SPENDER, uint128(500 * USD), keccak256("cred2"), chipId, deadline(), rawSig(CHIP_PK, d));
        d = w.hashRemoveSigner(passId, w.nonce(), deadline());
        w.metaRemoveSigner(passId, chipId, deadline(), rawSig(CHIP_PK, d));
        assertFalse(w.isSigner(passId));
        assertEq(w.signerCount(), 2);
        (address[] memory ids,) = w.getSigners();
        assertEq(ids.length, 2);
        // the old passkey is dead
        d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), deadline());
        bytes memory dead = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.UnknownSigner.selector, passId));
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, passId, deadline(), dead);
    }

    function test_recoveryAddsOwnerAfterDelay() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.expectRevert(InstantWallet.OnlyRecoveryAddress.selector);
        w.startRecovery(bytes32(x), bytes32(y), 0);

        vm.prank(facilitator);
        w.startRecovery(bytes32(x), bytes32(y), 0);
        vm.prank(facilitator);
        vm.expectRevert();
        w.finalizeRecovery();

        vm.warp(block.timestamp + 1 days);
        vm.prank(facilitator);
        w.finalizeRecovery();
        address newId = w.signerIdOf(bytes32(x), bytes32(y));
        assertEq(w.getSigner(newId).role, OWNER);
        assertEq(w.ownerCount(), 2);
        assertEq(w.recoveryExecuteAfter(), 0);
        // and the new owner can act
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, w.nonce(), deadline());
        w.metaTransfer(address(usdc), alice, 1 * USD, 0, newId, deadline(), webauthnSig(NEW_PK, d));
    }

    function test_ownerActionCancelsRecoverySpenderDoesNot() public {
        pairDevice();
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(facilitator);
        w.startRecovery(bytes32(x), bytes32(y), 0);
        passTransfer(alice, 1 * USD, 0); // spender
        assertGt(w.recoveryExecuteAfter(), 0, "spender action leaves recovery pending");
        chipTransfer(alice, 1 * USD, 0); // owner
        assertEq(w.recoveryExecuteAfter(), 0, "owner action cancels");
    }

    function test_explicitCancelAndSetRecovery() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(facilitator);
        w.startRecovery(bytes32(x), bytes32(y), 1);
        bytes32 d = w.hashCancelRecovery(w.nonce(), deadline());
        w.metaCancelRecovery(passId, deadline(), webauthnSig(PASS_PK, d));
        assertEq(w.recoveryExecuteAfter(), 0);

        d = w.hashSetRecovery(alice, 14 days, w.nonce(), deadline());
        w.metaSetRecovery(alice, 14 days, passId, deadline(), webauthnSig(PASS_PK, d));
        assertEq(w.recoveryAddress(), alice);
        assertEq(w.recoveryDelay(), 14 days);
        d = w.hashSetRecovery(alice, 1, w.nonce(), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(InstantWallet.DelayTooShort.selector);
        w.metaSetRecovery(alice, 1, passId, deadline(), sig);
    }

    function test_isValidSignatureView() public view {
        bytes32 d = keccak256("anything");
        assertTrue(w.isValidSignature(passId, d, webauthnSig(PASS_PK, d)));
        assertFalse(w.isValidSignature(passId, d, webauthnSig(CHIP_PK, d)));
        assertFalse(w.isValidSignature(chipId, d, rawSig(CHIP_PK, d)), "not a signer yet");
    }

    function test_receivesEthAndNfts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(w).call{ value: 0.5 ether }("");
        assertTrue(ok);
        assertEq(w.onERC721Received(alice, alice, 1, ""), w.onERC721Received.selector);
    }
}
