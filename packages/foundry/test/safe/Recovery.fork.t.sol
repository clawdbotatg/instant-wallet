// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SafeBase.sol";

/// Recovery (Candide, 7 days, DAO guardian from the first setup). Includes a wallet that was never deployed.
contract RecoveryTest is SafeBase {
    Passkey burner;
    Passkey newBurner;
    address burnerSigner;
    address wallet;
    address bob = makeAddr("instant-wallet test recipient");

    function setUp() public {
        _forkBase();
        burner = _passkey("burner");
        newBurner = _passkey("new phone");
        burnerSigner = _signerAddress(burner);
        wallet = _predict(burnerSigner);
    }

    function _owners1(address a) internal pure returns (address[] memory o) {
        o = new address[](1);
        o[0] = a;
    }

    function _dao(address to, bytes memory data) internal {
        vm.prank(DAO);
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _startRecovery(address[] memory owners, uint256 threshold) internal {
        _dao(RECOVERY_7D, abi.encodeCall(ISocialRecovery.confirmRecovery, (wallet, owners, threshold, true)));
    }

    function test_recoverAWalletThatWasNeverDeployed() public {
        // money arrived, the phone (passkey not synced) was lost before any send
        _dealUSDC(wallet, 100e6);
        assertEq(wallet.code.length, 0);

        // the DAO's recovery tool rebuilds the first setup from the saved data and deploys it (anyone can)
        _deploySafe(burnerSigner);
        assertEq(wallet.code.length > 0, true);

        address newSigner = _deploySigner(newBurner);
        _startRecovery(_owners1(newSigner), 1);

        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert();
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(wallet);

        vm.warp(block.timestamp + 1);
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(wallet); // anyone can finalize

        ISafe safe = ISafe(wallet);
        assertEq(safe.getOwners().length, 1);
        assertEq(safe.getOwners()[0], newSigner);

        // the new phone spends; the old one can't
        SafeTx memory t = _batch(_usdcTransfer(bob, 5e6));
        bytes32 h = _hash(safe, t);
        bytes memory oldSigs = _encodeSigs(_one(Sig(burnerSigner, _webauthn(burner, h), false)));
        vm.expectRevert(); // the old burner is no longer an owner (its signer was never even deployed)
        _exec(safe, t, oldSigs);
        assertTrue(_exec(safe, t, _encodeSigs(_one(_passkeySig(newBurner, h)))));
        assertEq(IERC20(USDC).balanceOf(bob), 5e6);
    }

    function test_ownerCancelsADaoTakeover() public {
        _deploySigner(burner);
        ISafe safe = _deploySafe(burnerSigner);
        _dealUSDC(wallet, 100e6);

        Passkey memory evil = _passkey("dao gone bad");
        address evilSigner = _deploySigner(evil);
        _startRecovery(_owners1(evilSigner), 1);

        // the alert fires; the owner cancels (the wallet itself calls cancelRecovery)
        SafeTx memory t = SafeTx(RECOVERY_7D, 0, abi.encodeCall(ISocialRecovery.cancelRecovery, ()), Operation.Call);
        assertTrue(_exec(safe, t, _encodeSigs(_one(_passkeySig(burner, _hash(safe, t))))));

        vm.warp(block.timestamp + 8 days);
        vm.expectRevert();
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(wallet);
        assertEq(safe.getOwners()[0], burnerSigner);
    }

    function test_onlyTheGuardianCanStartRecovery() public {
        _deploySafe(burnerSigner);
        address[] memory o = _owners1(makeAddr("thief"));
        vm.prank(makeAddr("thief"));
        vm.expectRevert();
        ISocialRecovery(RECOVERY_7D).confirmRecovery(wallet, o, 1, true);
    }

    function test_ownerReplacesTheDaoWithItsOwnRecoveryAddress() public {
        // level 3: the paper seed's address becomes the guardian, the DAO is removed
        _deploySigner(burner);
        ISafe safe = _deploySafe(burnerSigner);
        address paper = vm.addr(uint256(keccak256("paper seed")));
        SafeTx memory t = _batch(
            abi.encodePacked(
                _call(RECOVERY_7D, 0, abi.encodeCall(ISocialRecovery.addGuardianWithThreshold, (paper, 1))),
                // guardians are a linked list; the newest is first, so the DAO's previous entry is `paper`
                _call(RECOVERY_7D, 0, abi.encodeCall(ISocialRecovery.revokeGuardianWithThreshold, (paper, DAO, 1)))
            )
        );
        assertTrue(_exec(safe, t, _encodeSigs(_one(_passkeySig(burner, _hash(safe, t))))));
        assertTrue(ISocialRecovery(RECOVERY_7D).isGuardian(wallet, paper));
        assertFalse(ISocialRecovery(RECOVERY_7D).isGuardian(wallet, DAO));

        // the DAO can no longer start a recovery
        address[] memory o = _owners1(makeAddr("x"));
        vm.prank(DAO);
        vm.expectRevert();
        ISocialRecovery(RECOVERY_7D).confirmRecovery(wallet, o, 1, true);

        // the paper can
        Passkey memory phone2 = _passkey("phone 2");
        address s2 = _deploySigner(phone2);
        vm.prank(paper);
        ISocialRecovery(RECOVERY_7D).confirmRecovery(wallet, _owners1(s2), 1, true);
        vm.warp(block.timestamp + 7 days);
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(wallet);
        assertEq(safe.getOwners()[0], s2);
    }

    function test_recoveryCanSetSeveralOwnersAndAThreshold() public {
        _deploySafe(burnerSigner);
        address[] memory o = new address[](3);
        o[0] = _deploySigner(newBurner);
        o[1] = makeAddr("hot");
        o[2] = makeAddr("cold");
        _startRecovery(o, 2);
        vm.warp(block.timestamp + 7 days);
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(wallet);
        assertEq(ISafe(wallet).getOwners().length, 3);
        assertEq(ISafe(wallet).getThreshold(), 2);
    }
}
