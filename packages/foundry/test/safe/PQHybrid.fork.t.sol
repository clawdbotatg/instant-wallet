// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./SafeBase.sol";
import { HybridPQSigner, IERC1271 as IHybr1271, ISphincsVerifier } from "../../contracts/pq/HybridPQSigner.sol";
import { SphincsC11Asm } from "../../contracts/pq/SphincsC11Asm.sol";

/// EXPERIMENTAL post-quantum hybrid owner (docs/PQ-HYBRID.md). SPHINCS- signatures come from the web signer
/// through vm.ffi, so this proves the browser code and the on-chain verifier agree:
///   cd packages/foundry && forge test --ffi --match-path test/safe/PQHybrid.fork.t.sol -vv
contract PQHybridTest is SafeBase {
    Passkey k;
    address p256Signer;
    HybridPQSigner hybrid;
    ISafe safe;
    address bob = makeAddr("bob");

    function setUp() public {
        _forkBase();
        k = _passkey("pq-burner");
        p256Signer = _deploySigner(k);
        hybrid = new HybridPQSigner(IHybr1271(p256Signer), ISphincsVerifier(address(new SphincsC11Asm())), _commit(0));
        safe = _deploySafe(p256Signer);
        _dealUSDC(address(safe), 100e6);

        // opt in: the passkey owner swaps itself for the hybrid owner (plain passkey signature, old path)
        SafeTx memory t = SafeTx(address(safe), 0, abi.encodeCall(ISafe.swapOwner, (address(1), p256Signer, address(hybrid))), Operation.Call);
        assertTrue(_exec(safe, t, _encodeSigs(_one(_passkeySig(k, _hash(safe, t))))));
        assertTrue(safe.isOwner(address(hybrid)) && !safe.isOwner(p256Signer));
    }

    // ---- helpers: material(i) stands in for the passkey's PRF output with salt i

    function _material(uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encode("pq-burner prf", i));
    }

    function _ffi(string memory cmd, bytes32 material, bytes32 msg_) internal returns (bytes memory) {
        string[] memory a = new string[](msg_ == 0 ? 4 : 5);
        a[0] = "node";
        a[1] = "../../web/tools/pq-sign.mts";
        a[2] = cmd;
        a[3] = vm.toString(material);
        if (msg_ != 0) a[4] = vm.toString(msg_);
        return vm.ffi(a);
    }

    function _commit(uint256 i) internal returns (bytes32) {
        (bytes32 seed, bytes32 root) = abi.decode(_ffi("pub", _material(i), 0), (bytes32, bytes32));
        return keccak256(abi.encode(seed, root));
    }

    struct Approval {
        bytes32 seed;
        bytes32 root;
        bytes sig;
        bytes32 next;
    }

    /// What one passkey tap produces for `h`: key i signs (h, commit of key i+1).
    function _approval(uint256 i, bytes32 h) internal returns (Approval memory a) {
        a.next = _commit(i + 1);
        (a.seed, a.root, a.sig) = abi.decode(_ffi("sign", _material(i), hybrid.pqMessage(h, a.next)), (bytes32, bytes32, bytes));
    }

    function _send(uint256 amount) internal view returns (SafeTx memory) {
        return SafeTx(USDC, 0, abi.encodeCall(IERC20.transfer, (bob, amount)), Operation.Call);
    }

    /// The relayer's one transaction: approve, then execTransaction, atomically.
    function _relay(SafeTx memory t, Approval memory a, bytes memory webauthn) internal {
        _relayCalls(_calls(t, a, webauthn));
    }

    function _relayCalls(IMulticall3.Call3[] memory c) internal {
        vm.prank(relayer);
        IMulticall3(MULTICALL3).aggregate3(c);
    }

    function _calls(SafeTx memory t, Approval memory a, bytes memory webauthn) internal view returns (IMulticall3.Call3[] memory c) {
        bytes memory sigs = _encodeSigs(_one(Sig(address(hybrid), webauthn, false)));
        c = new IMulticall3.Call3[](2);
        c[0] = IMulticall3.Call3(address(hybrid), false, abi.encodeCall(HybridPQSigner.approve, (_hash(safe, t), a.seed, a.root, a.sig, a.next)));
        c[1] = IMulticall3.Call3(
            address(safe), false, abi.encodeCall(ISafe.execTransaction, (t.to, t.value, t.data, t.operation, 0, 0, 0, address(0), payable(0), sigs))
        );
    }

    // ---- tests

    function test_sendsAndRolls() public {
        for (uint256 i = 0; i < 3; i++) {
            SafeTx memory t = _send(1e6);
            bytes32 h = _hash(safe, t);
            Approval memory a = _approval(i, h);
            uint256 g = gasleft();
            _relay(t, a, _webauthn(k, h));
            console.log("approve + exec gas", g - gasleft());
            assertEq(hybrid.index(), i + 1);
            assertEq(hybrid.commit(), a.next);
        }
        assertEq(IERC20(USDC).balanceOf(bob), 3e6);
    }

    function test_retiredKeyRejected() public {
        SafeTx memory t = _send(1e6);
        _relay(t, _approval(0, _hash(safe, t)), _webauthn(k, _hash(safe, t)));
        // key 0 is retired: a second tx signed by key 0 fails even with a good passkey signature
        t = _send(2e6);
        bytes32 h = _hash(safe, t);
        Approval memory a = _approval(0, h);
        IMulticall3.Call3[] memory c = _calls(t, a, _webauthn(k, h));
        vm.expectRevert();
        _relayCalls(c);
    }

    function test_needsTheHashKey() public {
        SafeTx memory t = _send(1e6);
        bytes32 h = _hash(safe, t);
        // P-256 alone (no approve): the Safe rejects it
        bytes memory sigs = _encodeSigs(_one(Sig(address(hybrid), _webauthn(k, h), false)));
        vm.expectRevert();
        _exec(safe, t, sigs);
        // a different hash key signing: rejected
        Approval memory a = _approval(7, h);
        vm.expectRevert(bytes("pq: wrong key"));
        hybrid.approve(h, a.seed, a.root, a.sig, a.next);
    }

    function test_needsThePasskey() public {
        SafeTx memory t = _send(1e6);
        bytes32 h = _hash(safe, t);
        Approval memory a = _approval(0, h);
        IMulticall3.Call3[] memory c = _calls(t, a, _webauthn(_passkey("someone else"), h));
        vm.expectRevert();
        _relayCalls(c);
    }

    /// forge-config: default.isolate = true
    function test_approvalDoesNotOutliveItsTx() public {
        SafeTx memory t = _send(1e6);
        bytes32 h = _hash(safe, t);
        Approval memory a = _approval(0, h);
        hybrid.approve(h, a.seed, a.root, a.sig, a.next); // its own tx (foundry: one call = one tx)
        assertEq(hybrid.isValidSignature(h, _webauthn(k, h)), bytes4(0xffffffff));
    }

    /// The app's pqMessage (web/lib/safe/pq/message.ts) is byte-identical to the contract's.
    function test_appMessageMatches() public {
        bytes32 h = keccak256("tx");
        bytes32 next = keccak256("next");
        string[] memory a = new string[](8);
        a[0] = "node";
        a[1] = "../../web/tools/pq-sign.mts";
        a[2] = "msg";
        a[3] = vm.toString(block.chainid);
        a[4] = vm.toString(address(hybrid));
        a[5] = vm.toString(hybrid.index());
        a[6] = vm.toString(h);
        a[7] = vm.toString(next);
        assertEq(bytes32(vm.ffi(a)), hybrid.pqMessage(h, next));
    }

    function test_sigBoundToNext() public {
        SafeTx memory t = _send(1e6);
        bytes32 h = _hash(safe, t);
        Approval memory a = _approval(0, h);
        vm.expectRevert(); // relayer swaps in its own next key: signature no longer matches
        hybrid.approve(h, a.seed, a.root, a.sig, keccak256("attacker key"));
    }

    /// Where the gas goes. Forge's Base fork has no P-256 precompile, so the passkey check runs Daimo's Solidity
    /// fallback (~350K here); on Base itself the precompile makes it a few thousand.
    function test_gasBreakdown() public {
        SafeTx memory t = _send(1e6);
        bytes32 h = _hash(safe, t);
        Approval memory a = _approval(0, h);
        bytes32 m = hybrid.pqMessage(h, a.next);
        ISphincsVerifier v = hybrid.verifier();
        uint256 g = gasleft();
        v.verify(a.seed, a.root, m, a.sig);
        console.log("sphincs verify", g - gasleft());
        bytes memory w = _webauthn(k, h);
        g = gasleft();
        IERC1271(p256Signer).isValidSignature(h, w);
        console.log("p256 isValidSignature", g - gasleft());
        g = gasleft();
        hybrid.approve(h, a.seed, a.root, a.sig, a.next);
        console.log("approve", g - gasleft());
        bytes memory sigs = _encodeSigs(_one(Sig(address(hybrid), w, false)));
        g = gasleft();
        _exec(safe, t, sigs);
        console.log("exec", g - gasleft());
    }
}
