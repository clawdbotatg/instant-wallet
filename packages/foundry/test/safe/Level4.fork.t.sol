// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SafeBase.sol";

/// Level 4 before the phase-4 contract: owners = wedgie slot 1 + wedgie slot 2 + burner + hot, threshold 3.
/// The wedgie counts twice, so wedgie + one = 3 (instant); burner + hot = 2; wedgie alone = 2.
contract Level4Test is SafeBase {
    Passkey burner;
    Passkey wedgie1;
    Passkey wedgie2; // the same chip key, the other verifier setting
    address burnerSigner;
    address w1;
    address w2;
    uint256 hotPk = uint256(keccak256("metamask"));
    address hot;
    ISafe safe;
    address bob = makeAddr("instant-wallet test recipient");

    function setUp() public {
        _forkBase();
        burner = _passkey("burner");
        burnerSigner = _deploySigner(burner);
        safe = _deploySafe(burnerSigner);
        hot = vm.addr(hotPk);
        wedgie1 = _passkey("wedgie");
        wedgie2 = wedgie1;
        wedgie2.verifiers = VERIFIERS_SLOT2;
        w1 = _deploySigner(wedgie1);
        w2 = _deploySigner(wedgie2);
        assertTrue(w1 != w2);
        _dealUSDC(address(safe), 10_000e6);

        // level 2 then 4, each in one batch signed by the owners of the moment
        SafeTx memory t = _batch(_call(address(safe), 0, abi.encodeCall(ISafe.addOwnerWithThreshold, (hot, 2))));
        _exec(safe, t, _encodeSigs(_one(_passkeySig(burner, _hash(safe, t)))));
        t = _batch(
            abi.encodePacked(
                _call(address(safe), 0, abi.encodeCall(ISafe.addOwnerWithThreshold, (w1, 2))),
                _call(address(safe), 0, abi.encodeCall(ISafe.addOwnerWithThreshold, (w2, 3)))
            )
        );
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
    }

    /// One wedgie press = one WebAuthn signature over the hash, used for both owner slots.
    function _wedgieSigs(bytes32 h) internal view returns (Sig memory a, Sig memory b) {
        bytes memory one = _webauthn(wedgie1, h);
        a = Sig(w1, one, false);
        b = Sig(w2, one, false);
    }

    function _send(uint256 amount) internal pure returns (SafeTx memory) {
        return SafeTx(USDC, 0, abi.encodeCall(IERC20.transfer, (address(0xB0B), amount)), Operation.Call);
    }

    function test_shape() public view {
        assertEq(safe.getOwners().length, 4);
        assertEq(safe.getThreshold(), 3);
    }

    function test_wedgiePlusBurner() public {
        SafeTx memory t = _send(5000e6);
        bytes32 h = _hash(safe, t);
        (Sig memory a, Sig memory b) = _wedgieSigs(h);
        Sig[] memory s = new Sig[](3);
        s[0] = a;
        s[1] = b;
        s[2] = _passkeySig(burner, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
    }

    function test_wedgiePlusHot() public {
        SafeTx memory t = _send(5000e6);
        bytes32 h = _hash(safe, t);
        (Sig memory a, Sig memory b) = _wedgieSigs(h);
        Sig[] memory s = new Sig[](3);
        s[0] = a;
        s[1] = b;
        s[2] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
    }

    function test_burnerPlusHotIsNotEnough() public {
        SafeTx memory t = _send(5000e6);
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        bytes memory sigs = _encodeSigs(s);
        vm.expectRevert();
        _exec(safe, t, sigs);
    }

    function test_wedgieAloneIsNotEnough() public {
        SafeTx memory t = _send(5000e6);
        bytes32 h = _hash(safe, t);
        (Sig memory a, Sig memory b) = _wedgieSigs(h);
        Sig[] memory s = new Sig[](2);
        s[0] = a;
        s[1] = b;
        bytes memory sigs = _encodeSigs(s);
        vm.expectRevert();
        _exec(safe, t, sigs);
    }

    function test_oneWedgieSlotTwiceIsRejected() public {
        // the same owner can't be counted twice
        SafeTx memory t = _send(5000e6);
        bytes32 h = _hash(safe, t);
        (Sig memory a,) = _wedgieSigs(h);
        Sig[] memory s = new Sig[](3);
        s[0] = a;
        s[1] = a;
        s[2] = _passkeySig(burner, h);
        bytes memory sigs = _encodeSigs(s);
        vm.expectRevert();
        _exec(safe, t, sigs);
    }

    function test_burnerPlusHotPlusPaperCantReplaceTheWedgieWithoutItHere() public {
        // pre-phase-4 the "burner + hot + paper" path doesn't exist on chain: a stolen wedgie is replaced by recovery
        SafeTx memory t = _batch(
            abi.encodePacked(
                _call(address(safe), 0, abi.encodeCall(ISafe.removeOwner, (w2, w1, 2)))
            )
        );
        bytes32 h = _hash(safe, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _passkeySig(burner, h);
        s[1] = _eoaSig(hotPk, h);
        bytes memory sigs = _encodeSigs(s);
        vm.expectRevert();
        _exec(safe, t, sigs);
    }

    function test_replaceALostBurner() public {
        Passkey memory phone2 = _passkey("phone 2");
        address s2 = _deploySigner(phone2);
        address[] memory owners = safe.getOwners();
        address prev = address(1);
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == burnerSigner) break;
            prev = owners[i];
        }
        SafeTx memory t = SafeTx(address(safe), 0, abi.encodeCall(ISafe.swapOwner, (prev, burnerSigner, s2)), Operation.Call);
        bytes32 h = _hash(safe, t);
        (Sig memory a, Sig memory b) = _wedgieSigs(h);
        Sig[] memory s = new Sig[](3);
        s[0] = a;
        s[1] = b;
        s[2] = _eoaSig(hotPk, h);
        assertTrue(_exec(safe, t, _encodeSigs(s)));
        assertTrue(safe.isOwner(s2));
        assertFalse(safe.isOwner(burnerSigner));
        assertEq(safe.getThreshold(), 3);
    }
}
