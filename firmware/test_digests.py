#!/usr/bin/env python3
# Digest parity between the device code (eip712.py + keccak.py, unmodified) and InstantWallet.sol,
# on a live anvil with the Factory deployed (packages/foundry/deployments/31337.json).
#
#   cd firmware && python3 test_digests.py            # needs cast, anvil at RPC (default 127.0.0.1:8545)
#
# 1. makes a software P-256 key, creates a wallet for it through Factory.createWallet
# 2. compares every one of the seven digests (+ domainSeparator, hashCalls) with the contract's view
# 3. signs a transfer digest, checks isValidSignature, mints MockUSDC and submits metaTransfer
import json, os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eip712, p256, words  # noqa: E402

RPC = os.environ.get("RPC", "http://127.0.0.1:8545")
PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # anvil account 0
ACCT1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"                          # anvil account 1
DEPLOY = os.path.join(HERE, "..", "packages", "foundry", "deployments", "31337.json")
ZERO32 = "0x" + "00" * 32

fails = 0


def cast(*args):
    out = subprocess.run(["cast", *args, "--rpc-url", RPC], capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("cast %s failed:\n%s" % (" ".join(args[:3]), out.stderr.strip()))
    return out.stdout.strip()


def call(to, sig, *args):
    return cast("call", to, sig, *[str(a) for a in args])


def send(to, sig, *args):
    return json.loads(cast("send", to, sig, *[str(a) for a in args], "--private-key", PK0, "--json"))


def check(name, mine, theirs):
    global fails
    ok = mine.lower() == theirs.lower()
    print("%s  %-22s device %s  contract %s" % ("PASS" if ok else "FAIL", name, mine[:18] + "..", theirs[:18] + ".."))
    if not ok:
        fails += 1
    return ok


def main():
    global fails
    dep = json.load(open(DEPLOY))
    by_name = {v: k for k, v in dep.items() if k.startswith("0x")}
    factory, usdc = by_name["Factory"], by_name["MockUSDC"]
    chain_id = int(cast("chain-id"))
    print("chain %d  factory %s  usdc %s" % (chain_id, factory, usdc))

    d = p256.rand_scalar()
    x, y = p256.pubkey(d)
    qx, qy = "0x%064x" % x, "0x%064x" % y
    sid = eip712.signer_id(qx, qy)
    check("signerIdOf", sid, call(by_name["InstantWallet"], "signerIdOf(bytes32,bytes32)(address)", qx, qy))

    wallet = call(factory, "getWalletAddress(bytes32,bytes32,bytes32)(address)", qx, qy, ZERO32)
    send(factory, "createWallet(bytes32,bytes32,bytes32,uint8,bytes32)", ZERO32, qx, qy, 1, ZERO32)
    print("wallet", wallet, "signer", sid, "(kind raw, owner)")
    assert call(wallet, "isSigner(address)(bool)", sid) == "true"

    check("domainSeparator", eip712.hexlify(eip712.domain_separator(chain_id, wallet)), call(wallet, "domainSeparator()(bytes32)"))

    nonce, deadline = 7, 1757800000
    token, to, amount, fee = usdc, ACCT1, 2000_000000, 20000
    check("hashTransfer",
          eip712.hexlify(eip712.transfer_digest(chain_id, wallet, token, to, amount, fee, nonce, deadline)),
          call(wallet, "hashTransfer(address,address,uint256,uint256,uint256,uint256)(bytes32)", token, to, amount, fee, nonce, deadline))

    calls = [
        (usdc, 0, bytes.fromhex("a9059cbb" + "%064x" % int(ACCT1, 16) + "%064x" % 5_000000)),
        (ACCT1, 10 ** 15, bytes.fromhex("deadbeef01")),
    ]
    tuple_arg = "[" + ",".join("(%s,%d,0x%s)" % (t, v, data.hex()) for t, v, data in calls) + "]"
    ch = eip712.calls_hash(calls)
    check("hashCalls (2 calls)", eip712.hexlify(ch), call(wallet, "hashCalls((address,uint256,bytes)[])(bytes32)", tuple_arg))
    check("hashExecute",
          eip712.hexlify(eip712.execute_digest(chain_id, wallet, calls, nonce, deadline)),
          call(wallet, "hashExecute(bytes32,uint256,uint256)(bytes32)", eip712.hexlify(ch), nonce, deadline))

    pqx, pqy = "0x" + "11" * 32, "0x" + "22" * 32
    cred = "0x" + "ab" * 32
    check("hashAddSigner",
          eip712.hexlify(eip712.add_signer_digest(chain_id, wallet, pqx, pqy, 0, 0, 500_000000, cred, nonce, deadline)),
          call(wallet, "hashAddSigner(bytes32,bytes32,uint8,uint8,uint128,bytes32,uint256,uint256)(bytes32)", pqx, pqy, 0, 0, 500_000000, cred, nonce, deadline))
    check("hashUpdateSigner",
          eip712.hexlify(eip712.update_signer_digest(chain_id, wallet, ACCT1, 1, 750_000000, nonce, deadline)),
          call(wallet, "hashUpdateSigner(address,uint8,uint128,uint256,uint256)(bytes32)", ACCT1, 1, 750_000000, nonce, deadline))
    check("hashRemoveSigner",
          eip712.hexlify(eip712.remove_signer_digest(chain_id, wallet, ACCT1, nonce, deadline)),
          call(wallet, "hashRemoveSigner(address,uint256,uint256)(bytes32)", ACCT1, nonce, deadline))
    check("hashSetRecovery",
          eip712.hexlify(eip712.set_recovery_digest(chain_id, wallet, ACCT1, 86400, nonce, deadline)),
          call(wallet, "hashSetRecovery(address,uint64,uint256,uint256)(bytes32)", ACCT1, 86400, nonce, deadline))
    check("hashCancelRecovery",
          eip712.hexlify(eip712.cancel_recovery_digest(chain_id, wallet, nonce, deadline)),
          call(wallet, "hashCancelRecovery(uint256,uint256)(bytes32)", nonce, deadline))

    # sign a real transfer with the software key and let the contract verify + execute it
    send(usdc, "mint(address,uint256)", wallet, 5000_000000)
    onchain_nonce = int(call(wallet, "nonce()(uint256)").split()[0])
    now = int(cast("block", "latest", "-f", "timestamp"))
    deadline = now + 600
    digest = eip712.transfer_digest(chain_id, wallet, token, to, amount, fee, onchain_nonce, deadline)
    r, s = p256.sign(d, digest)
    sig = "0x%064x%064x" % (r, s)
    print("match code for this transfer:", words.match_code(digest))
    valid = call(wallet, "isValidSignature(address,bytes32,bytes)(bool)", sid, eip712.hexlify(digest), sig)
    print("%s  isValidSignature -> %s" % ("PASS" if valid == "true" else "FAIL", valid))
    if valid != "true":
        fails += 1
    bad = call(wallet, "isValidSignature(address,bytes32,bytes)(bool)", sid, eip712.hexlify(bytes([digest[0] ^ 1]) + digest[1:]), sig)
    print("%s  isValidSignature on a tampered digest -> %s" % ("PASS" if bad == "false" else "FAIL", bad))
    if bad != "false":
        fails += 1

    before = int(call(usdc, "balanceOf(address)(uint256)", to).split()[0])
    relayer_before = int(call(usdc, "balanceOf(address)(uint256)", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266").split()[0])
    rc = send(wallet, "metaTransfer(address,address,uint256,uint256,address,uint256,bytes)", token, to, amount, fee, sid, deadline, sig)
    after = int(call(usdc, "balanceOf(address)(uint256)", to).split()[0])
    relayer_after = int(call(usdc, "balanceOf(address)(uint256)", "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266").split()[0])
    moved = after - before == amount and relayer_after - relayer_before == fee
    print("%s  metaTransfer tx %s status %s: recipient +%d, relayer fee +%d, wallet nonce now %s"
          % ("PASS" if moved and rc.get("status") in ("0x1", 1, "1") else "FAIL", rc.get("transactionHash", "?")[:14] + "..", rc.get("status"),
             after - before, relayer_after - relayer_before, call(wallet, "nonce()(uint256)")))
    if not moved:
        fails += 1

    print("\n%d failure(s)" % fails if fails else "\nALL DIGESTS MATCH THE CONTRACT; signature verified on chain and a metaTransfer went through")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
