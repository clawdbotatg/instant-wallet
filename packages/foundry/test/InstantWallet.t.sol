// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

contract InstantWalletV4 is InstantWallet {
    function version() external pure override returns (string memory) {
        return "4.0.0";
    }
}

/// @dev Two keys: a passkey (WebAuthn-wrapped) and a wedgie (raw). Same curve, same digests.
///      vm.prank / vm.expectRevert bind to the NEXT external call (getters included), so every
///      digest, signature and nonce is computed before them.
contract InstantWalletTest is Test {
    uint256 constant PASS_PK = 0xA11CE;
    uint256 constant CHIP_PK = 0xC111D;
    uint256 constant NEW_PK = 0x9E9E9;
    bytes32 constant CRED = keccak256("cred");

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

    address dao = address(0xDA0);
    address gasKey = address(0x6A5);
    address alice = address(0xA11);

    uint256 constant USD = 1e6;
    uint8 constant WEBAUTHN = 0;
    uint8 constant RAW = 1;
    uint8 constant SPENDER = 0;
    uint8 constant OWNER = 1;
    address constant ETH = address(0);

    function setUp() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(PASS_PK);
        (passQx, passQy) = (bytes32(x), bytes32(y));
        (x, y) = vm.publicKeyP256(CHIP_PK);
        (chipQx, chipQy) = (bytes32(x), bytes32(y));

        usdc = new MockUSDC();
        impl = new InstantWallet();
        address[] memory guardians = new address[](1);
        guardians[0] = dao;
        factory = new Factory(address(impl), guardians, 7 days);

        address predicted = factory.getAddress(passQx, passQy, WEBAUTHN, CRED);
        address deployed = factory.createWallet(passQx, passQy, WEBAUTHN, CRED);
        assertEq(deployed, predicted, "CREATE2 address is known before deployment");
        w = InstantWallet(payable(deployed));
        passId = w.signerIdOf(passQx, passQy);
        chipId = w.signerIdOf(chipQx, chipQy);

        usdc.mint(address(w), 10_000 * USD);
        vm.deal(address(w), 10 ether);
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
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(digest)),
            '","origin":"https://instantwallet.io"}'
        );
        bytes32 msgHash = sha256(abi.encodePacked(authData, sha256(bytes(clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, msgHash);
        // Flat tuple, exactly what WebAuthn.tryDecodeAuth expects (no leading struct offset).
        return abi.encode(r, s, uint256(23), uint256(1), authData, clientDataJSON);
    }

    function sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        return pk == CHIP_PK ? rawSig(pk, digest) : webauthnSig(pk, digest);
    }

    function deadline() internal view returns (uint256) {
        return block.timestamp + 10 minutes;
    }

    function transferAs(uint256 pk, address id, address asset, address to, uint256 amount) internal {
        bytes32 d = w.hashTransfer(asset, to, amount, w.nonces(id), deadline());
        bytes memory sig = sign(pk, d);
        uint256 dl = deadline();
        vm.prank(gasKey);
        w.metaTransfer(asset, to, amount, id, dl, sig);
    }

    function executeAs(uint256 pk, address id, InstantWallet.Call[] memory calls) internal {
        bytes32 d = w.hashExecute(w.hashCalls(calls), w.nonces(id), deadline());
        bytes memory sig = sign(pk, d);
        uint256 dl = deadline();
        vm.prank(gasKey);
        w.metaExecute(calls, id, dl, sig);
    }

    function selfCall(bytes memory data) internal view returns (InstantWallet.Call[] memory calls) {
        calls = new InstantWallet.Call[](1);
        calls[0] = InstantWallet.Call(address(w), 0, data);
    }

    /// @dev Pairing a wedgie in ONE Face ID: add it as owner, demote the passkey, set its limits.
    function pairWedgie() internal {
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](4);
        calls[0] =
            InstantWallet.Call(address(w), 0, abi.encodeCall(w.addSigner, (chipQx, chipQy, RAW, OWNER, bytes32(0))));
        calls[1] = InstantWallet.Call(address(w), 0, abi.encodeCall(w.updateSigner, (passId, SPENDER)));
        calls[2] =
            InstantWallet.Call(address(w), 0, abi.encodeCall(w.setLimit, (passId, address(usdc), uint128(100 * USD))));
        calls[3] = InstantWallet.Call(address(w), 0, abi.encodeCall(w.setLimit, (passId, ETH, uint128(0.05 ether))));
        executeAs(PASS_PK, passId, calls);
        assertEq(w.ownerCount(), 1);
        assertEq(w.getSigner(chipId).role, OWNER);
        assertEq(w.getSigner(passId).role, SPENDER);
    }

    // ------------------------------------------------------------ factory

    function test_initialState() public view {
        assertEq(w.ownerCount(), 1);
        assertEq(w.signerCount(), 1);
        assertEq(w.credentialIdToSigner(CRED), passId);
        address[] memory g = w.getGuardians();
        assertEq(g.length, 1);
        assertEq(g[0], dao);
        assertTrue(w.isGuardian(dao));
        assertEq(w.recoveryDelay(), 7 days);
        assertEq(w.remainingAllowance(passId, address(usdc)), type(uint256).max);
        assertEq(w.version(), "3.0.0");
    }

    function test_factoryIsIdempotentAndCounterfactual() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        address predicted = factory.getAddress(bytes32(x), bytes32(y), WEBAUTHN, keccak256("c3"));
        assertEq(predicted.code.length, 0);
        usdc.mint(predicted, 7 * USD); // money can arrive before the wallet exists
        address a = factory.createWallet(bytes32(x), bytes32(y), WEBAUTHN, keccak256("c3"));
        address b = factory.createWallet(bytes32(x), bytes32(y), WEBAUTHN, keccak256("c3"));
        assertEq(a, predicted);
        assertEq(b, predicted, "second call is a no-op");
        assertEq(usdc.balanceOf(a), 7 * USD);
    }

    function test_noSquatting_kindAndCredentialAreInTheAddress() public view {
        address real = factory.getAddress(passQx, passQy, WEBAUTHN, CRED);
        assertTrue(real != factory.getAddress(passQx, passQy, RAW, CRED), "kind changes the address");
        assertTrue(real != factory.getAddress(passQx, passQy, WEBAUTHN, keccak256("x")), "credential changes it");
    }

    function test_implementationCannotBeInitialized() public {
        address[] memory none = new address[](0);
        vm.expectRevert();
        impl.initialize(passQx, passQy, WEBAUTHN, CRED, none, 0);
        vm.expectRevert();
        w.initialize(passQx, passQy, WEBAUTHN, CRED, none, 0);
    }

    function test_createAndCall_deploysAndSendsInOneTx() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        bytes32 qx = bytes32(x);
        bytes32 qy = bytes32(y);
        address addr = factory.getAddress(qx, qy, WEBAUTHN, keccak256("c4"));
        usdc.mint(addr, 50 * USD);
        address id = w.signerIdOf(qx, qy);
        uint256 dl = deadline();
        // digest for a wallet that doesn't exist yet: same domain, computed off chain
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("InstantWallet"),
                keccak256("3"),
                block.chainid,
                addr
            )
        );
        bytes32 structHash = keccak256(abi.encode(w.TRANSFER_TYPEHASH(), address(usdc), alice, 20 * USD, 0, dl));
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        bytes memory call = abi.encodeCall(
            InstantWallet.metaTransfer, (address(usdc), alice, 20 * USD, id, dl, webauthnSig(NEW_PK, d))
        );

        // a bad signature reverts everything: no wallet gets deployed for free
        bytes memory bad = abi.encodeCall(
            InstantWallet.metaTransfer, (address(usdc), alice, 20 * USD, id, dl, webauthnSig(PASS_PK, d))
        );
        vm.expectRevert(InstantWallet.BadSignature.selector);
        factory.createAndCall(qx, qy, WEBAUTHN, keccak256("c4"), bad);
        assertEq(addr.code.length, 0);

        vm.prank(gasKey);
        factory.createAndCall(qx, qy, WEBAUTHN, keccak256("c4"), call);
        assertEq(usdc.balanceOf(alice), 20 * USD);
        assertEq(InstantWallet(payable(addr)).nonces(id), 1);
    }

    // ------------------------------------------------------------ signatures

    function test_ownerTransfersUsdcAndEth() public {
        transferAs(PASS_PK, passId, address(usdc), alice, 45 * USD);
        assertEq(usdc.balanceOf(alice), 45 * USD);
        transferAs(PASS_PK, passId, ETH, alice, 1 ether);
        assertEq(alice.balance, 1 ether);
        assertEq(w.nonces(passId), 2);
    }

    function test_replayRejected() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, sig);
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, sig);
    }

    function test_expiredRejected() public {
        uint256 dl = block.timestamp - 1;
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, dl);
        bytes memory sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.Expired.selector, dl, block.timestamp));
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, sig);
    }

    function test_wrongKeyRejected() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, deadline());
        bytes memory wrongKey = webauthnSig(CHIP_PK, d);
        bytes memory chipSig = rawSig(CHIP_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, wrongKey);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.UnknownSigner.selector, chipId));
        w.metaTransfer(address(usdc), alice, 1 * USD, chipId, dl, chipSig);
    }

    function test_webauthnNeedsUserVerification() public {
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, 0, deadline());
        bytes memory noUV = webauthnSigFlags(PASS_PK, d, 0x01);
        uint256 dl = deadline();
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, noUV);
    }

    function test_perSignerNonces_passkeyAndWedgieDontCollide() public {
        pairWedgie();
        // the wedgie signs a request at its nonce 0 while the passkey keeps sending
        bytes32 d = w.hashTransfer(address(usdc), alice, 500 * USD, 0, deadline());
        bytes memory wedgieSig = rawSig(CHIP_PK, d);
        uint256 dl = deadline();
        transferAs(PASS_PK, passId, address(usdc), alice, 10 * USD);
        transferAs(PASS_PK, passId, address(usdc), alice, 10 * USD);
        w.metaTransfer(address(usdc), alice, 500 * USD, chipId, dl, wedgieSig);
        assertEq(usdc.balanceOf(alice), 520 * USD);
        assertEq(w.nonces(chipId), 1);
    }

    function test_reAddedKeyCannotReplay() public {
        pairWedgie();
        bytes32 d = w.hashTransfer(address(usdc), alice, 1 * USD, w.nonces(passId), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, sig);
        executeAs(CHIP_PK, chipId, selfCall(abi.encodeCall(w.removeSigner, (passId))));
        executeAs(CHIP_PK, chipId, selfCall(abi.encodeCall(w.addSigner, (passQx, passQy, WEBAUTHN, OWNER, CRED))));
        vm.expectRevert(InstantWallet.BadSignature.selector);
        w.metaTransfer(address(usdc), alice, 1 * USD, passId, dl, sig);
    }

    // ------------------------------------------------------------ roles and limits

    function test_pairWedgieThenPasskeyIsLimited() public {
        pairWedgie();
        transferAs(CHIP_PK, chipId, address(usdc), alice, 2_000 * USD);
        assertEq(w.remainingAllowance(passId, address(usdc)), 100 * USD);
        transferAs(PASS_PK, passId, address(usdc), alice, 70 * USD);
        assertEq(w.remainingAllowance(passId, address(usdc)), 30 * USD);

        bytes32 d = w.hashTransfer(address(usdc), alice, 31 * USD, w.nonces(passId), deadline());
        bytes memory over = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(
            abi.encodeWithSelector(InstantWallet.OverLimit.selector, passId, address(usdc), 31 * USD, 30 * USD)
        );
        w.metaTransfer(address(usdc), alice, 31 * USD, passId, dl, over);

        transferAs(PASS_PK, passId, ETH, alice, 0.05 ether); // ETH has its own window
        assertEq(w.remainingAllowance(passId, ETH), 0);
        vm.warp(block.timestamp + 1 days);
        assertEq(w.remainingAllowance(passId, address(usdc)), 100 * USD);
    }

    function test_spenderCannotExecuteMoveUnlimitedAssetsOrSign1271() public {
        pairWedgie();
        MockUSDC other = new MockUSDC();
        other.mint(address(w), 5 * USD);
        bytes32 d = w.hashTransfer(address(other), alice, 1 * USD, w.nonces(passId), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.OverLimit.selector, passId, address(other), 1 * USD, 0));
        w.metaTransfer(address(other), alice, 1 * USD, passId, dl, sig);

        InstantWallet.Call[] memory calls = new InstantWallet.Call[](1);
        calls[0] = InstantWallet.Call(address(other), 0, abi.encodeCall(other.transfer, (alice, 1 * USD)));
        d = w.hashExecute(w.hashCalls(calls), w.nonces(passId), dl);
        sig = webauthnSig(PASS_PK, d);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.NotOwner.selector, passId));
        w.metaExecute(calls, passId, dl, sig);

        bytes32 h = keccak256("permit");
        assertEq(
            w.isValidSignature(h, abi.encodePacked(passId, webauthnSig(PASS_PK, w.hashMessage(h)))), bytes4(0xffffffff)
        );

        executeAs(CHIP_PK, chipId, calls); // the wedgie (owner) can
        assertEq(other.balanceOf(alice), 1 * USD);
    }

    function test_selfAdminOnlyFromTheWallet() public {
        vm.expectRevert(InstantWallet.OnlySelf.selector);
        w.setLimit(passId, ETH, 1);
        vm.expectRevert(InstantWallet.OnlySelf.selector);
        w.addSigner(chipQx, chipQy, RAW, OWNER, bytes32(0));
        address[] memory none = new address[](0);
        vm.expectRevert(InstantWallet.OnlySelf.selector);
        w.setGuardians(none, 0);
        vm.prank(address(w));
        vm.expectRevert(InstantWallet.LastOwner.selector);
        w.removeSigner(passId);
    }

    function test_cannotRemoveOrDemoteLastOwner() public {
        InstantWallet.Call[] memory calls = selfCall(abi.encodeCall(w.updateSigner, (passId, SPENDER)));
        bytes32 d = w.hashExecute(w.hashCalls(calls), 0, deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(InstantWallet.LastOwner.selector);
        w.metaExecute(calls, passId, dl, sig);
    }

    function test_executeBatchAtomic() public {
        // EIP-5792: approve + swap in one signature, all or nothing
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](2);
        calls[0] = InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.approve, (alice, 5 * USD)));
        calls[1] = InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (alice, 100_000 * USD)));
        bytes32 d = w.hashExecute(w.hashCalls(calls), 0, deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert();
        w.metaExecute(calls, passId, dl, sig);
        assertEq(usdc.allowance(address(w), alice), 0, "nothing happened");
    }

    function test_executeSendsEthValue() public {
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](1);
        calls[0] = InstantWallet.Call(alice, 2 ether, "");
        executeAs(PASS_PK, passId, calls);
        assertEq(alice.balance, 2 ether);
    }

    function test_hashCallsIsRebuildableWithoutAbiEncoder() public view {
        InstantWallet.Call[] memory calls = new InstantWallet.Call[](2);
        calls[0] = InstantWallet.Call(address(0x1), 7, hex"deadbeef");
        calls[1] = InstantWallet.Call(address(0x2), 0, "");
        bytes32 h0 = keccak256(abi.encode(address(0x1), uint256(7), keccak256(hex"deadbeef")));
        bytes32 h1 = keccak256(abi.encode(address(0x2), uint256(0), keccak256("")));
        assertEq(w.hashCalls(calls), keccak256(abi.encodePacked(h0, h1)));
    }

    // ------------------------------------------------------------ ERC-1271

    function test_erc1271_ownerSignsReplaySafe() public {
        bytes32 h = keccak256("siwe");
        bytes memory good = abi.encodePacked(passId, webauthnSig(PASS_PK, w.hashMessage(h)));
        assertEq(w.isValidSignature(h, good), bytes4(0x1626ba7e));
        // signing the raw hash (not wrapped to this wallet) is rejected
        assertEq(w.isValidSignature(h, abi.encodePacked(passId, webauthnSig(PASS_PK, h))), bytes4(0xffffffff));
        assertEq(w.isValidSignature(h, hex"00"), bytes4(0xffffffff));
        // same key, second wallet: the first wallet's signature doesn't carry over
        address w2 = factory.createWallet(passQx, passQy, WEBAUTHN, keccak256("other cred"));
        assertEq(InstantWallet(payable(w2)).isValidSignature(h, good), bytes4(0xffffffff));
    }

    // ------------------------------------------------------------ social recovery

    function test_guardianReplacesLostPhone_ownerRole() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.expectRevert(InstantWallet.OnlyGuardian.selector);
        w.startRecovery(passId, bytes32(x), bytes32(y), WEBAUTHN, keccak256("c5"));

        vm.prank(dao);
        w.startRecovery(passId, bytes32(x), bytes32(y), WEBAUTHN, keccak256("c5"));
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert();
        w.finalizeRecovery();
        vm.warp(block.timestamp + 1);
        vm.prank(alice); // anyone can finalize
        w.finalizeRecovery();

        address newId = w.signerIdOf(bytes32(x), bytes32(y));
        assertFalse(w.isSigner(passId), "lost phone is gone");
        assertEq(w.getSigner(newId).role, OWNER);
        assertEq(w.ownerCount(), 1);
        assertEq(w.credentialIdToSigner(keccak256("c5")), newId);
        transferAs(NEW_PK, newId, address(usdc), alice, 1 * USD);
    }

    function test_guardianReplacesPasskeyKeepsSpenderRole() public {
        pairWedgie();
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(dao);
        w.startRecovery(passId, bytes32(x), bytes32(y), WEBAUTHN, bytes32(0));
        vm.warp(block.timestamp + 7 days);
        w.finalizeRecovery();
        assertEq(w.getSigner(w.signerIdOf(bytes32(x), bytes32(y))).role, SPENDER);
        assertEq(w.getSigner(chipId).role, OWNER);
    }

    function test_guardianReplacesLostWedgie() public {
        pairWedgie();
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(dao);
        w.startRecovery(chipId, bytes32(x), bytes32(y), RAW, bytes32(0));
        transferAs(PASS_PK, passId, address(usdc), alice, 1 * USD); // a spender action doesn't cancel
        vm.warp(block.timestamp + 7 days);
        w.finalizeRecovery();
        address newId = w.signerIdOf(bytes32(x), bytes32(y));
        assertFalse(w.isSigner(chipId));
        assertEq(w.getSigner(newId).role, OWNER);
        assertEq(w.getSigner(newId).kind, RAW);
    }

    function test_ownerCancelsRecovery_byActingOrExplicitly() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(dao);
        w.startRecovery(passId, bytes32(x), bytes32(y), WEBAUTHN, bytes32(0));
        transferAs(PASS_PK, passId, address(usdc), alice, 1 * USD); // owner acts → cancelled
        assertEq(w.pendingRecovery().executeAfter, 0);

        vm.prank(dao);
        w.startRecovery(passId, bytes32(x), bytes32(y), WEBAUTHN, bytes32(0));
        executeAs(PASS_PK, passId, selfCall(abi.encodeCall(w.cancelRecovery, ())));
        assertEq(w.pendingRecovery().executeAfter, 0);
        vm.warp(block.timestamp + 8 days);
        vm.expectRevert(InstantWallet.RecoveryNotPending.selector);
        w.finalizeRecovery();
    }

    function test_ownerChangesGuardians() public {
        address[] memory g = new address[](2);
        g[0] = alice;
        g[1] = address(0xB0B);
        executeAs(PASS_PK, passId, selfCall(abi.encodeCall(w.setGuardians, (g, 14 days))));
        assertFalse(w.isGuardian(dao));
        assertTrue(w.isGuardian(alice));
        assertEq(w.recoveryDelay(), 14 days);

        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(dao);
        vm.expectRevert(InstantWallet.OnlyGuardian.selector);
        w.startRecovery(address(0), bytes32(x), bytes32(y), WEBAUTHN, bytes32(0));

        address[] memory none = new address[](0);
        executeAs(PASS_PK, passId, selfCall(abi.encodeCall(w.setGuardians, (none, 0))));
        assertEq(w.getGuardians().length, 0);

        InstantWallet.Call[] memory tooShort = selfCall(abi.encodeCall(w.setGuardians, (g, 1 hours)));
        bytes32 d = w.hashExecute(w.hashCalls(tooShort), w.nonces(passId), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(InstantWallet.DelayTooShort.selector);
        w.metaExecute(tooShort, passId, dl, sig);
    }

    // ------------------------------------------------------------ upgrades

    function test_upgradeOnlyByOwnerSignature() public {
        InstantWalletV4 v4 = new InstantWalletV4();
        vm.expectRevert(InstantWallet.OnlySelf.selector);
        w.upgradeToAndCall(address(v4), "");

        pairWedgie();
        InstantWallet.Call[] memory calls = selfCall(abi.encodeCall(w.upgradeToAndCall, (address(v4), "")));
        bytes32 d = w.hashExecute(w.hashCalls(calls), w.nonces(passId), deadline());
        bytes memory sig = webauthnSig(PASS_PK, d);
        uint256 dl = deadline();
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.NotOwner.selector, passId));
        w.metaExecute(calls, passId, dl, sig); // a spender can't

        address before = address(w);
        executeAs(CHIP_PK, chipId, calls);
        assertEq(w.version(), "4.0.0");
        assertEq(address(w), before, "same address");
        assertEq(w.getSigner(chipId).role, OWNER, "state survives");
        assertEq(w.remainingAllowance(passId, address(usdc)), 100 * USD);
    }

    function test_receivesEthAndNfts() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(w).call{ value: 0.5 ether }("");
        assertTrue(ok);
        assertEq(w.onERC721Received(alice, alice, 1, ""), w.onERC721Received.selector);
        assertTrue(w.supportsInterface(0x1626ba7e));
    }
}
