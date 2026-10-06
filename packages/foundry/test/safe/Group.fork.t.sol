// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SafeBase.sol";

interface ICompatibilityFallbackHandler {
    function getMessageHashForSafe(address safe, bytes memory message) external view returns (bytes32);
}

/// Group wallet: a Safe whose owners are three members' own Instant Wallets, 2 of 3.
contract GroupTest is SafeBase {
    Passkey[3] keys;
    ISafe[3] members;
    ISafe group;
    address bob = makeAddr("instant-wallet test recipient");

    function setUp() public {
        _forkBase();
        string[3] memory names = ["alice phone", "bob phone", "carol phone"];
        address[] memory owners = new address[](3);
        for (uint256 i = 0; i < 3; i++) {
            keys[i] = _passkey(names[i]);
            members[i] = _deploySafe(_deploySigner(keys[i]));
            owners[i] = address(members[i]);
        }
        bytes memory init = abi.encodeCall(
            ISafe.setup, (owners, 2, address(0), "", FALLBACK_HANDLER, address(0), 0, payable(0))
        );
        group = ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, init, 42));
        _dealUSDC(address(group), 1000e6);
    }

    /// A member signs for the group with its own wallet's rule: its owners sign the member's SafeMessage that wraps
    /// the group's tx hash; the group checks it through the member's fallback handler (EIP-1271).
    function _memberSig(uint256 i, bytes32 groupHash) internal view returns (Sig memory) {
        bytes32 msgHash = ICompatibilityFallbackHandler(FALLBACK_HANDLER).getMessageHashForSafe(
            address(members[i]), abi.encode(groupHash)
        );
        bytes memory inner = _encodeSigs(_one(_passkeySig(keys[i], msgHash)));
        return Sig(address(members[i]), inner, false);
    }

    function test_twoMembersSign() public {
        SafeTx memory t = _batch(_usdcTransfer(bob, 300e6));
        bytes32 h = _hash(group, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _memberSig(0, h);
        s[1] = _memberSig(2, h);
        assertTrue(_exec(group, t, _encodeSigs(s)));
        assertEq(IERC20(USDC).balanceOf(bob), 300e6);
    }

    function test_oneMemberIsNotEnough() public {
        SafeTx memory t = _batch(_usdcTransfer(bob, 300e6));
        bytes memory sigs = _encodeSigs(_one(_memberSig(1, _hash(group, t))));
        vm.expectRevert();
        _exec(group, t, sigs);
    }

    function test_memberApprovesOnChainInstead() public {
        // the delayed path's shape: the member Safe calls approveHash on the GROUP Safe
        SafeTx memory t = _batch(_usdcTransfer(bob, 300e6));
        bytes32 h = _hash(group, t);
        SafeTx memory approve = SafeTx(address(group), 0, abi.encodeCall(ISafe.approveHash, (h)), Operation.Call);
        _exec(members[0], approve, _encodeSigs(_one(_passkeySig(keys[0], _hash(members[0], approve)))));
        assertEq(group.approvedHashes(address(members[0]), h), 1);
        // approved hash (v = 1, r = member) + a 1271 signature from another member
        Sig[] memory s = new Sig[](2);
        s[0] = Sig(address(members[0]), abi.encodePacked(bytes32(uint256(uint160(address(members[0])))), bytes32(0), uint8(1)), true);
        s[1] = _memberSig(1, h);
        assertTrue(_exec(group, t, _encodeSigs(s)));
    }

    function test_memberRecoversWithoutTouchingTheGroup() public {
        // alice loses her phone; the DAO recovers HER wallet; the group's owners don't change
        Passkey memory newPhone = _passkey("alice phone 2");
        address s2 = _deploySigner(newPhone);
        address[] memory o = new address[](1);
        o[0] = s2;
        vm.prank(DAO);
        ISocialRecovery(RECOVERY_7D).confirmRecovery(address(members[0]), o, 1, true);
        vm.warp(block.timestamp + 7 days);
        ISocialRecovery(RECOVERY_7D).finalizeRecovery(address(members[0]));
        keys[0] = newPhone;
        SafeTx memory t = _batch(_usdcTransfer(bob, 1e6));
        bytes32 h = _hash(group, t);
        Sig[] memory s = new Sig[](2);
        s[0] = _memberSig(0, h);
        s[1] = _memberSig(1, h);
        assertTrue(_exec(group, t, _encodeSigs(s)));
    }
}
