// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { Base64 } from "@openzeppelin/contracts/utils/Base64.sol";
import { InstantWallet } from "../contracts/InstantWallet.sol";
import { Factory } from "../contracts/Factory.sol";
import { MockUSDC } from "../contracts/MockUSDC.sol";

/**
 * @dev Every scenario in docs/COLD-STORAGE.md ("What a thief gets", "Losing things"), on a test wallet with
 *      10-minute waits: passkey = spender with $100/day, wedgie = owner, one guardian.
 *      vm.prank / vm.expectRevert bind to the NEXT external call, so digests and signatures are built first.
 */
contract ColdStorageTest is Test {
    uint256 constant PASS_PK = 0xA11CE; // phone passkey (WebAuthn)
    uint256 constant CHIP_PK = 0xC111D; // wedgie (raw P-256)
    uint256 constant NEW_PK = 0x9E9E9; // a replacement key
    uint256 constant THIEF_PK = 0xBADBAD;
    uint64 constant WAIT = 10 minutes;
    uint256 constant USD = 1e6;
    uint8 constant WEBAUTHN = 0;
    uint8 constant RAW = 1;
    uint8 constant SPENDER = 0;
    uint8 constant OWNER = 1;

    MockUSDC usdc;
    Factory factory;
    InstantWallet w;
    address pass;
    address chip;
    bytes32 chipQx;
    bytes32 chipQy;
    address guardian = address(0x6A4D);
    address alice = address(0xA11);
    address thief = address(0x7E1F);

    function setUp() public {
        vm.warp(1_800_000_000);
        usdc = new MockUSDC();
        address[] memory g = new address[](1);
        g[0] = guardian;
        factory = new Factory(address(new InstantWallet()), guardian, 7 days);
        (uint256 x, uint256 y) = vm.publicKeyP256(PASS_PK);
        w = InstantWallet(payable(factory.createWallet(bytes32(x), bytes32(y), WEBAUTHN, keccak256("cred"))));
        pass = w.signerIdOf(bytes32(x), bytes32(y));
        (x, y) = vm.publicKeyP256(CHIP_PK);
        (chipQx, chipQy) = (bytes32(x), bytes32(y));
        chip = w.signerIdOf(chipQx, chipQy);
        usdc.mint(address(w), 5_000 * USD);

        // pairing, one Face ID while the passkey is still the owner and there's no wait yet
        InstantWallet.Call[] memory c = new InstantWallet.Call[](5);
        c[0] = _self(abi.encodeCall(w.addSigner, (chipQx, chipQy, RAW, OWNER, bytes32(0))));
        c[1] = _self(abi.encodeCall(w.updateSigner, (pass, SPENDER)));
        c[2] = _self(abi.encodeCall(w.setLimit, (pass, address(usdc), uint128(100 * USD))));
        c[3] = _self(abi.encodeCall(w.setGuardians, (g, WAIT)));
        c[4] = _self(abi.encodeCall(w.setColdDelay, (WAIT)));
        _exec(PASS_PK, pass, c);
        assertEq(w.coldDelay(), WAIT);
        assertEq(w.getSigner(chip).role, OWNER);
        assertEq(w.getSigner(pass).role, SPENDER);
    }

    // ------------------------------------------------------------ helpers

    function _self(bytes memory data) internal view returns (InstantWallet.Call memory) {
        return InstantWallet.Call(address(w), 0, data);
    }

    function _one(InstantWallet.Call memory c) internal pure returns (InstantWallet.Call[] memory a) {
        a = new InstantWallet.Call[](1);
        a[0] = c;
    }

    function _pay(address to, uint256 amount) internal view returns (InstantWallet.Call[] memory) {
        return _one(InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (to, amount))));
    }

    function _sig(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        if (pk == CHIP_PK || pk == NEW_PK || pk == THIEF_PK) {
            (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
            return abi.encodePacked(r, s);
        }
        bytes memory authData = abi.encodePacked(bytes32(0), bytes1(0x05), uint32(0));
        string memory cdj = string.concat(
            '{"type":"webauthn.get","challenge":"', Base64.encodeURL(abi.encodePacked(digest)), '","origin":"https://x"}'
        );
        (bytes32 r2, bytes32 s2) = vm.signP256(pk, sha256(abi.encodePacked(authData, sha256(bytes(cdj)))));
        return abi.encode(r2, s2, uint256(23), uint256(1), authData, cdj);
    }

    /// @dev Signed metaExecute by `pk` (as signer `id`). Returns the id of a queued action, if it was queued.
    function _exec(uint256 pk, address id, InstantWallet.Call[] memory calls) internal returns (bytes32 qid) {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(pk, w.hashExecute(w.hashCalls(calls), w.nonces(id), dl));
        uint256 before = w.queueCount();
        vm.recordLogs();
        w.metaExecute(calls, id, dl, sig);
        if (w.queueCount() > before) {
            qid = vm.getRecordedLogs()[0].topics[1];
            assertEq(qid, keccak256(abi.encode(w.hashCalls(calls), id, before)));
        }
    }

    function _expectExecRevert(uint256 pk, address id, InstantWallet.Call[] memory calls, bytes memory err) internal {
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(pk, w.hashExecute(w.hashCalls(calls), w.nonces(id), dl));
        vm.expectRevert(err);
        w.metaExecute(calls, id, dl, sig);
    }

    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }

    // ------------------------------------------------------------ everyday

    function test_passkeySpendsWithinLimitInstantly() public {
        _exec(PASS_PK, pass, _pay(alice, 60 * USD));
        assertEq(_bal(alice), 60 * USD);
        _expectExecRevert(
            PASS_PK, pass, _pay(alice, 41 * USD), abi.encodeWithSelector(InstantWallet.OverLimit.selector, pass, address(usdc), 41 * USD, 40 * USD)
        );
    }

    function test_wedgieAloneWaits_thenAnyoneRunsIt() public {
        InstantWallet.Call[] memory big = _pay(alice, 2_000 * USD);
        bytes32 id = _exec(CHIP_PK, chip, big);
        assertTrue(id != bytes32(0), "queued, not run");
        assertEq(_bal(alice), 0);
        vm.warp(block.timestamp + WAIT - 1);
        vm.expectRevert();
        w.executeQueued(id, big);
        vm.warp(block.timestamp + 1);
        vm.prank(address(0xBEEF)); // a relay, the gas key, anyone
        w.executeQueued(id, big);
        assertEq(_bal(alice), 2_000 * USD);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.NotQueued.selector, id));
        w.executeQueued(id, big);
    }

    function test_queuedCallsMustMatch() public {
        bytes32 id = _exec(CHIP_PK, chip, _pay(alice, 2_000 * USD));
        vm.warp(block.timestamp + WAIT);
        InstantWallet.Call[] memory swapped = _pay(thief, 2_000 * USD);
        vm.expectRevert(InstantWallet.WrongCalls.selector);
        w.executeQueued(id, swapped);
    }

    function test_bothKeysSkipTheWait() public {
        InstantWallet.Call[] memory big = _pay(alice, 2_000 * USD);
        bytes32 id = _exec(CHIP_PK, chip, big);
        InstantWallet.Call[] memory c = new InstantWallet.Call[](2);
        c[0] = _self(abi.encodeCall(w.skipWait, (id)));
        c[1] = _self(abi.encodeCall(w.executeQueued, (id, big)));
        _exec(PASS_PK, pass, c); // the passkey's Face ID: "skip the wait"
        assertEq(_bal(alice), 2_000 * USD);
    }

    function test_theSameKeyCantSkipItsOwnWait() public {
        bytes32 id = _exec(CHIP_PK, chip, _pay(alice, 2_000 * USD));
        // a skip from the wedgie is itself a protecting call, so it runs at once — and fails: same key
        _expectExecRevert(CHIP_PK, chip, _one(_self(abi.encodeCall(w.skipWait, (id)))), abi.encodeWithSelector(InstantWallet.SameKey.selector));
    }

    function test_weakeningWaits_protectingDoesnt() public {
        // raise the passkey's limit: waits
        bytes32 id = _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.setLimit, (pass, address(usdc), uint128(500 * USD))))));
        assertTrue(id != bytes32(0));
        assertEq(w.getAllowance(pass, address(usdc)).limit, 100 * USD);
        // lower it: instant (wedgie or the passkey itself)
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.setLimit, (pass, address(usdc), uint128(80 * USD))))));
        assertEq(w.getAllowance(pass, address(usdc)).limit, 80 * USD);
        _exec(PASS_PK, pass, _one(_self(abi.encodeCall(w.setLimit, (pass, address(usdc), uint128(50 * USD))))));
        assertEq(w.getAllowance(pass, address(usdc)).limit, 50 * USD);
        // the passkey can't raise its own limit, or touch anyone else's
        _expectExecRevert(
            PASS_PK, pass, _one(_self(abi.encodeCall(w.setLimit, (pass, address(usdc), uint128(60 * USD))))), abi.encodeWithSelector(InstantWallet.NotOwner.selector, pass)
        );
        // shortening the wait waits; lengthening is instant
        assertTrue(_exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.setColdDelay, (WAIT / 2))))) != bytes32(0));
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.setColdDelay, (WAIT * 2)))));
        assertEq(w.coldDelay(), WAIT * 2);
    }

    function test_noInstantPermitsUnderColdStorage() public {
        bytes32 h = keccak256("USDC permit to the thief");
        bytes memory sig = abi.encodePacked(chip, _sig(CHIP_PK, w.hashMessage(h)));
        assertEq(w.isValidSignature(h, sig), bytes4(0xffffffff), "an owner signature can't skip the wait as a permit");
    }

    // ------------------------------------------------------------ a thief has your phone

    function test_stolenPhone_thiefGetsOneDayThenFreezeAndRemove() public {
        _exec(PASS_PK, pass, _pay(thief, 100 * USD)); // the most they get today
        // you, with the wedgie: freeze (instant), then remove the passkey (instant)
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.freeze, ()))));
        vm.warp(block.timestamp + 1 days); // new day, new limit: still frozen? (freeze = recoveryDelay = 10 min)
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.freeze, ())))); // extend
        _expectExecRevert(PASS_PK, pass, _pay(thief, 1 * USD), abi.encodeWithSelector(InstantWallet.WalletFrozen.selector, w.frozenUntil()));
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.removeSigner, (pass)))));
        assertFalse(w.isSigner(pass));
        assertEq(_bal(thief), 100 * USD);
    }

    function test_stolenPhone_thiefCantUnfreezeCancelRecoveryOrQueue() public {
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.freeze, ()))));
        _expectExecRevert(PASS_PK, pass, _one(_self(abi.encodeCall(w.unfreeze, ()))), abi.encodeWithSelector(InstantWallet.NotOwner.selector, pass));
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(guardian);
        w.startRecovery(pass, bytes32(x), bytes32(y), WEBAUTHN, bytes32(0));
        _expectExecRevert(PASS_PK, pass, _one(_self(abi.encodeCall(w.cancelRecovery, ()))), abi.encodeWithSelector(InstantWallet.NotOwner.selector, pass));
        assertGt(w.pendingRecovery().executeAfter, 0);
    }

    function test_unfreeze_ownerAloneWaits_bothKeysAtOnce() public {
        vm.prank(guardian);
        w.guardianFreeze();
        InstantWallet.Call[] memory un = _one(_self(abi.encodeCall(w.unfreeze, ())));
        bytes32 id = _exec(CHIP_PK, chip, un);
        assertGt(w.frozenUntil(), block.timestamp);
        InstantWallet.Call[] memory c = new InstantWallet.Call[](2);
        c[0] = _self(abi.encodeCall(w.skipWait, (id)));
        c[1] = _self(abi.encodeCall(w.executeQueued, (id, un)));
        _exec(PASS_PK, pass, c);
        assertEq(w.frozenUntil(), 0);
    }

    function test_freezeExpires() public {
        vm.prank(guardian);
        w.guardianFreeze();
        _expectExecRevert(PASS_PK, pass, _pay(alice, 1 * USD), abi.encodeWithSelector(InstantWallet.WalletFrozen.selector, w.frozenUntil()));
        vm.warp(block.timestamp + WAIT);
        _exec(PASS_PK, pass, _pay(alice, 1 * USD));
        assertEq(_bal(alice), 1 * USD);
    }

    // ------------------------------------------------------------ a thief has your wedgie

    function test_stolenWedgie_passkeyCancelsAndFreezes() public {
        InstantWallet.Call[] memory drain = _pay(thief, 5_000 * USD);
        bytes32 id = _exec(CHIP_PK, chip, drain); // thief, with your wedgie
        // your phone gets the alert: cancel + freeze, one Face ID
        InstantWallet.Call[] memory c = new InstantWallet.Call[](2);
        c[0] = _self(abi.encodeCall(w.cancelQueued, (id)));
        c[1] = _self(abi.encodeCall(w.freeze, ()));
        _exec(PASS_PK, pass, c);
        vm.warp(block.timestamp + WAIT);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.NotQueued.selector, id));
        w.executeQueued(id, drain);
        assertEq(_bal(thief), 0);
    }

    function test_stolenWedgie_cantRaiseLimitsOrAddKeysQuietly() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(THIEF_PK);
        bytes32 id = _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.addSigner, (bytes32(x), bytes32(y), RAW, OWNER, bytes32(0))))));
        assertTrue(id != bytes32(0), "adding a key waits");
        vm.prank(guardian);
        w.guardianCancel(id); // a guardian can cancel too
        vm.warp(block.timestamp + WAIT);
        vm.expectRevert();
        w.executeQueued(id, _one(_self(abi.encodeCall(w.addSigner, (bytes32(x), bytes32(y), RAW, OWNER, bytes32(0))))));
    }

    // ------------------------------------------------------------ both stolen

    function test_bothStolen_default_twoKeyIsInstant() public {
        // documented trade-off: with skipping on, both keys together are instant
        InstantWallet.Call[] memory drain = _pay(thief, 5_000 * USD);
        bytes32 id = _exec(CHIP_PK, chip, drain);
        InstantWallet.Call[] memory c = new InstantWallet.Call[](2);
        c[0] = _self(abi.encodeCall(w.skipWait, (id)));
        c[1] = _self(abi.encodeCall(w.executeQueued, (id, drain)));
        _exec(PASS_PK, pass, c);
        assertEq(_bal(thief), 5_000 * USD);
    }

    function test_bothStolen_vault_guardianCancelsInTheWait() public {
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.setNoTwoKeySkip, (true))))); // Vault: instant (protecting)
        assertTrue(w.noTwoKeySkip());
        InstantWallet.Call[] memory drain = _pay(thief, 5_000 * USD);
        bytes32 id = _exec(CHIP_PK, chip, drain);
        _expectExecRevert(PASS_PK, pass, _one(_self(abi.encodeCall(w.skipWait, (id)))), abi.encodeWithSelector(InstantWallet.SkipDisabled.selector));
        vm.prank(guardian);
        w.guardianCancel(id);
        assertEq(_bal(thief), 0);
    }

    // ------------------------------------------------------------ losing things

    function test_lostWedgie_guardianReplacesIt_passkeyCantStopIt() public {
        bytes32 stale = _exec(CHIP_PK, chip, _pay(alice, 10 * USD)); // something the old wedgie had queued
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(guardian);
        w.startRecovery(chip, bytes32(x), bytes32(y), RAW, bytes32(0));
        _exec(PASS_PK, pass, _pay(alice, 50 * USD)); // daily life goes on, and doesn't cancel the recovery
        vm.warp(block.timestamp + WAIT);
        w.finalizeRecovery();
        address newChip = w.signerIdOf(bytes32(x), bytes32(y));
        assertFalse(w.isSigner(chip));
        assertEq(w.getSigner(newChip).role, OWNER);
        vm.expectRevert(abi.encodeWithSelector(InstantWallet.UnknownSigner.selector, chip));
        w.executeQueued(stale, _pay(alice, 10 * USD)); // the lost wedgie's queue is dead
    }

    function test_lostPhoneForGood_wedgieAddsNewPasskeyAfterTheWait() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        InstantWallet.Call[] memory c = new InstantWallet.Call[](3);
        c[0] = _self(abi.encodeCall(w.removeSigner, (pass)));
        c[1] = _self(abi.encodeCall(w.addSigner, (bytes32(x), bytes32(y), WEBAUTHN, SPENDER, keccak256("new cred"))));
        c[2] = _self(abi.encodeCall(w.setLimit, (w.signerIdOf(bytes32(x), bytes32(y)), address(usdc), uint128(100 * USD))));
        // removing alone would be instant; with an add in the batch, the whole batch waits
        bytes32 id = _exec(CHIP_PK, chip, c);
        assertTrue(id != bytes32(0));
        vm.warp(block.timestamp + WAIT);
        w.executeQueued(id, c);
        assertFalse(w.isSigner(pass));
        assertEq(w.getSigner(w.signerIdOf(bytes32(x), bytes32(y))).role, SPENDER);
    }

    function test_badGuardian_wedgieCancelsRecoveryAtOnce_andFreezeExpires() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(THIEF_PK);
        vm.prank(guardian);
        w.startRecovery(chip, bytes32(x), bytes32(y), RAW, bytes32(0));
        _exec(CHIP_PK, chip, _one(_self(abi.encodeCall(w.cancelRecovery, ())))); // protecting: instant
        assertEq(w.pendingRecovery().executeAfter, 0);
        vm.prank(guardian);
        w.guardianFreeze(); // griefing
        vm.warp(block.timestamp + WAIT);
        _exec(PASS_PK, pass, _pay(alice, 1 * USD)); // expired
        // the wedgie drops the guardian (weakening: waits)
        address[] memory none = new address[](0);
        InstantWallet.Call[] memory drop = _one(_self(abi.encodeCall(w.setGuardians, (none, 0))));
        bytes32 id = _exec(CHIP_PK, chip, drop);
        vm.warp(block.timestamp + WAIT);
        w.executeQueued(id, drop);
        assertFalse(w.isGuardian(guardian));
    }

    function test_heir_guardianAddsTheirKeyAfterTheWait() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        vm.prank(guardian);
        w.startRecovery(address(0), bytes32(x), bytes32(y), RAW, bytes32(0));
        vm.warp(block.timestamp + WAIT);
        w.finalizeRecovery();
        assertEq(w.getSigner(w.signerIdOf(bytes32(x), bytes32(y))).role, OWNER);
    }

    // ------------------------------------------------------------ upgrade from 3.1

    function test_simpleWalletUnchanged_noWait() public {
        (uint256 x, uint256 y) = vm.publicKeyP256(NEW_PK);
        InstantWallet s = InstantWallet(payable(factory.createWallet(bytes32(x), bytes32(y), RAW, bytes32(0))));
        usdc.mint(address(s), 10 * USD);
        address id = s.signerIdOf(bytes32(x), bytes32(y));
        InstantWallet.Call[] memory c = _one(InstantWallet.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (alice, 10 * USD))));
        uint256 dl = block.timestamp + 1 hours;
        bytes memory sig = _sig(NEW_PK, s.hashExecute(s.hashCalls(c), 0, dl));
        s.metaExecute(c, id, dl, sig);
        assertEq(_bal(alice), 10 * USD, "coldDelay 0: the owner acts at once, as in 3.1");
    }
}
