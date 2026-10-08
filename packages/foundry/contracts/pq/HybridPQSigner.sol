// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// EXPERIMENTAL, UNAUDITED. A Safe owner that needs two signatures from one passkey tap (docs/PQ-HYBRID.md):
///   1. the passkey's P-256 signature over the Safe tx hash, checked by Safe's audited passkey signer (`p256`);
///   2. a SPHINCS- C11 (hash-only, post-quantum) signature from a key derived from the passkey's PRF secret.
/// Rolling: the contract stores only a hash of the current hash-key's public key. Each approval names the next
/// key's hash and rolls to it, so a public key is seen once, then retired.
///
/// Flow, one relayer tx (Multicall3, allowFailure = false):
///   approve(safeTxHash, pkSeed, pkRoot, pqSig, next)  -> checks the hash key, rolls, marks safeTxHash (transient)
///   safe.execTransaction(..., sigs)                    -> Safe calls isValidSignature: marked AND P-256 valid
/// The mark is transient (EIP-1153), so it can't outlive the transaction.
interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4);
}

interface ISphincsVerifier {
    function verify(bytes32 pkSeed, bytes32 pkRoot, bytes32 message, bytes calldata sig) external pure returns (bool);
}

contract HybridPQSigner {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 internal constant DOMAIN = keccak256("instant-wallet.pq-hybrid.v1");

    IERC1271 public immutable p256; // Safe's passkey signer for the same passkey
    ISphincsVerifier public immutable verifier; // SphincsC11Asm

    bytes32 public commit; // keccak256(abi.encode(pkSeed, pkRoot)) of the current hash key
    uint256 public index; // which PRF salt the current key came from; +1 per roll

    event Rolled(uint256 indexed index, bytes32 commit);

    constructor(IERC1271 p256_, ISphincsVerifier verifier_, bytes32 commit_) {
        p256 = p256_;
        verifier = verifier_;
        commit = commit_;
        emit Rolled(0, commit_);
    }

    /// What the hash key signs: this signer, this chain, this key index, the Safe tx, and the next key.
    function pqMessage(bytes32 safeTxHash, bytes32 next) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), index, safeTxHash, next));
    }

    /// Anyone may submit (the relayer does); only the current hash key can produce a valid pqSig.
    function approve(bytes32 safeTxHash, bytes32 pkSeed, bytes32 pkRoot, bytes calldata pqSig, bytes32 next) external {
        require(keccak256(abi.encode(pkSeed, pkRoot)) == commit, "pq: wrong key");
        require(next != bytes32(0) && next != commit, "pq: bad next");
        require(verifier.verify(pkSeed, pkRoot, pqMessage(safeTxHash, next), pqSig), "pq: bad sig");
        commit = next;
        emit Rolled(++index, next);
        assembly {
            tstore(safeTxHash, 1)
        }
    }

    /// Safe 1.5 calls this for a contract owner. Valid only inside the tx that approved `hash`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        uint256 marked;
        assembly {
            marked := tload(hash)
        }
        if (marked != 1) return 0xffffffff;
        return p256.isValidSignature(hash, signature) == MAGIC ? MAGIC : bytes4(0xffffffff);
    }
}
