// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SafeBase.sol";

/// Level 1: a burner passkey is the only owner; DAO recovery is in the first setup. Counterfactual: money can
/// arrive before anything is deployed; the first send deploys the signer + the Safe and pays the relay in USDC,
/// all in one relayer transaction.
contract Level1Test is SafeBase {
    Passkey burner;
    address burnerSigner;
    address predicted;
    address bob = makeAddr("instant-wallet test recipient"); // makeAddr("bob") is a 7702 account on Base

    function setUp() public {
        _forkBase();
        burner = _passkey("burner");
        burnerSigner = _signerAddress(burner);
        predicted = _predict(burnerSigner);
    }

    /// The relay's one transaction for a first send: deploy signer, deploy Safe, run the signed Safe tx.
    function _firstSend(SafeTx memory t, bytes memory sigs) internal {
        IMulticall3.Call3[] memory calls = new IMulticall3.Call3[](3);
        calls[0] = IMulticall3.Call3(
            PASSKEY_FACTORY,
            false,
            abi.encodeCall(IWebAuthnSignerFactory.createSigner, (burner.x, burner.y, burner.verifiers))
        );
        calls[1] = IMulticall3.Call3(
            SAFE_FACTORY,
            false,
            abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (SAFE_L2, _initializer(burnerSigner), SALT_NONCE))
        );
        calls[2] = IMulticall3.Call3(
            predicted,
            false,
            abi.encodeCall(
                ISafe.execTransaction,
                (t.to, t.value, t.data, t.operation, 0, 0, 0, address(0), payable(0), sigs)
            )
        );
        vm.prank(relayer, relayer);
        IMulticall3(MULTICALL3).aggregate3(calls);
    }

    function test_addressIsCounterfactualAndReceivesBeforeDeploy() public {
        assertEq(predicted.code.length, 0);
        _dealUSDC(predicted, 50e6);
        assertEq(IERC20(USDC).balanceOf(predicted), 50e6);
        // same key, same address, every time
        assertEq(_predict(_signerAddress(_passkey("burner"))), predicted);
        // a different key, a different address
        assertTrue(_predict(_signerAddress(_passkey("someone else"))) != predicted);
    }

    function test_firstSendDeploysAndPaysRelayInUSDC() public {
        _dealUSDC(predicted, 50e6);
        SafeTx memory t = _batch(abi.encodePacked(_usdcTransfer(bob, 10e6), _usdcTransfer(relayer, 0.05e6)));
        bytes32 h = _hashAt(predicted, t, 0);
        _firstSend(t, _encodeSigs(_one(_passkeySig(burner, h))));

        ISafe safe = ISafe(predicted);
        assertGt(predicted.code.length, 0);
        assertEq(IERC20(USDC).balanceOf(bob), 10e6);
        assertEq(IERC20(USDC).balanceOf(relayer), 0.05e6);
        assertEq(IERC20(USDC).balanceOf(predicted), 50e6 - 10.05e6);
        assertEq(safe.getThreshold(), 1);
        assertEq(safe.getOwners().length, 1);
        assertEq(safe.getOwners()[0], burnerSigner);
        assertTrue(safe.isModuleEnabled(RECOVERY_7D));
        assertTrue(ISocialRecovery(RECOVERY_7D).isGuardian(predicted, DAO));
        assertEq(ISocialRecovery(RECOVERY_7D).threshold(predicted), 1);
        assertEq(safe.nonce(), 1);
    }

    function test_firstSendInETH() public {
        vm.deal(predicted, 0.01 ether);
        SafeTx memory t = _batch(abi.encodePacked(_call(bob, 0.003 ether, ""), _call(relayer, 0.0001 ether, "")));
        _firstSend(t, _encodeSigs(_one(_passkeySig(burner, _hashAt(predicted, t, 0)))));
        assertEq(bob.balance, 0.003 ether);
        assertEq(relayer.balance, 0.0001 ether);
    }

    function test_secondSendNeedsNoDeploy() public {
        _dealUSDC(predicted, 50e6);
        SafeTx memory t = _batch(abi.encodePacked(_usdcTransfer(bob, 1e6), _usdcTransfer(relayer, 0.05e6)));
        _firstSend(t, _encodeSigs(_one(_passkeySig(burner, _hashAt(predicted, t, 0)))));

        ISafe safe = ISafe(predicted);
        SafeTx memory t2 = _batch(abi.encodePacked(_usdcTransfer(bob, 2e6), _usdcTransfer(relayer, 0.01e6)));
        bytes memory sigs = _encodeSigs(_one(_passkeySig(burner, _hash(safe, t2))));
        vm.prank(relayer, relayer);
        assertTrue(_exec(safe, t2, sigs));
        assertEq(IERC20(USDC).balanceOf(bob), 3e6);
    }

    function test_relayCantChangeTheOwner() public {
        // Whoever deploys, the setup fixes the owner: a different initializer is a different address.
        Passkey memory attacker = _passkey("attacker");
        bytes memory evilInit = _initializer(_signerAddress(attacker));
        address evil = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, evilInit, SALT_NONCE);
        assertTrue(evil != predicted);
        // and the real one can still be deployed with the real owner
        ISafe safe = _deploySafe(burnerSigner);
        assertEq(address(safe), predicted);
        assertEq(safe.getOwners()[0], burnerSigner);
    }

    function test_replayedSignatureFails() public {
        _dealUSDC(predicted, 50e6);
        SafeTx memory t = _batch(abi.encodePacked(_usdcTransfer(bob, 1e6), _usdcTransfer(relayer, 0.05e6)));
        bytes memory sigs = _encodeSigs(_one(_passkeySig(burner, _hashAt(predicted, t, 0))));
        _firstSend(t, sigs);
        vm.prank(relayer, relayer);
        vm.expectRevert(bytes("GS024")); // the nonce moved on, so the old signature no longer matches
        _exec(ISafe(predicted), t, sigs);
    }

    function test_wrongKeyFails() public {
        _deploySigner(burner);
        ISafe safe = _deploySafe(burnerSigner);
        _dealUSDC(address(safe), 50e6);
        Passkey memory other = _passkey("other");
        _deploySigner(other);
        SafeTx memory t = _batch(_usdcTransfer(bob, 1e6));
        bytes32 h = _hash(safe, t);
        // a signature from another passkey, presented as the burner's
        bytes memory sigs = _encodeSigs(_one(Sig(burnerSigner, _webauthn(other, h), false)));
        vm.expectRevert(bytes("GS024"));
        _exec(safe, t, sigs);
    }

    function test_signatureForAnotherChainFails() public {
        _deploySigner(burner);
        ISafe safe = _deploySafe(burnerSigner);
        _dealUSDC(address(safe), 50e6);
        SafeTx memory t = _batch(_usdcTransfer(bob, 1e6));
        bytes32 hEth = _hashOn(1, address(safe), t, 0);
        assertTrue(hEth != _hash(safe, t));
        bytes memory sigs = _encodeSigs(_one(_passkeySig(burner, hEth)));
        vm.expectRevert(bytes("GS024"));
        _exec(safe, t, sigs);
    }
}
