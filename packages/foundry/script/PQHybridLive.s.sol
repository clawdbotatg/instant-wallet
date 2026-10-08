// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../test/safe/SafeBase.sol";
import { HybridPQSigner, IERC1271 as IHybr1271, ISphincsVerifier } from "../contracts/pq/HybridPQSigner.sol";
import { SphincsC11Asm } from "../contracts/pq/SphincsC11Asm.sol";

/// EXPERIMENTAL live run of the post-quantum hybrid owner (docs/PQ-HYBRID.md) on a real chain, to measure cost.
/// A software P-256 key stands in for the phone's passkey (same on-chain path). Deploys the verifier, the passkey
/// signer, a Safe, the hybrid; swaps the hybrid in; then makes SENDS zero-value sends that each roll the hash key.
///   forge script script/PQHybridLive.s.sol --ffi --rpc-url <rpc> --private-key <funded key> --broadcast
contract PQHybridLive is SafeBase {
    HybridPQSigner hybrid;
    ISafe safe;
    Passkey k;
    string tag;

    function run() external {
        tag = vm.envOr("PQ_TAG", string("pq-live-1"));
        uint256 sends = vm.envOr("SENDS", uint256(2));
        k = _passkey(tag);
        address me = msg.sender;

        vm.startBroadcast();
        address verifier = address(new SphincsC11Asm());
        address p256 = IWebAuthnSignerFactory(PASSKEY_FACTORY).createSigner(k.x, k.y, k.verifiers);
        safe = ISafe(ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_L2, _initializer(p256), uint256(keccak256(bytes(tag)))));
        hybrid = new HybridPQSigner(IHybr1271(p256), ISphincsVerifier(verifier), _commit(0));

        SafeTx memory t = SafeTx(address(safe), 0, abi.encodeCall(ISafe.swapOwner, (address(1), p256, address(hybrid))), Operation.Call);
        _exec(safe, t, _encodeSigs(_one(Sig(p256, _webauthn(k, _hash(safe, t)), false))));

        for (uint256 i = 0; i < sends; i++) {
            t = SafeTx(me, 0, "", Operation.Call);
            bytes32 h = _hash(safe, t);
            bytes32 next = _commit(i + 1);
            (bytes32 seed, bytes32 root, bytes memory sig) =
                abi.decode(_ffi("sign", _material(i), hybrid.pqMessage(h, next)), (bytes32, bytes32, bytes));
            bytes memory sigs = _encodeSigs(_one(Sig(address(hybrid), _webauthn(k, h), false)));
            IMulticall3.Call3[] memory c = new IMulticall3.Call3[](2);
            c[0] = IMulticall3.Call3(address(hybrid), false, abi.encodeCall(HybridPQSigner.approve, (h, seed, root, sig, next)));
            c[1] = IMulticall3.Call3(
                address(safe), false, abi.encodeCall(ISafe.execTransaction, (t.to, 0, "", Operation.Call, 0, 0, 0, address(0), payable(0), sigs))
            );
            IMulticall3(MULTICALL3).aggregate3(c);
        }
        vm.stopBroadcast();

        console.log("verifier", verifier);
        console.log("passkey signer", p256);
        console.log("safe", address(safe));
        console.log("hybrid", address(hybrid));
        console.log("hybrid index", hybrid.index());
    }

    function _material(uint256 i) internal view returns (bytes32) {
        return keccak256(abi.encode(tag, "prf", i));
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
}
