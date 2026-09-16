#!/usr/bin/env python3
# Digest parity between the device code (eip712.py + keccak.py + words.py, unmodified) and
# InstantWallet.sol v2, on a live anvil with the Factory deployed (packages/foundry/deployments/31337.json).
#
#   cd firmware && python3 test_digests.py            # needs cast, anvil at RPC (default 127.0.0.1:8545)
#
# 1. makes a software P-256 key, creates a wallet for it through Factory.createWallet
# 2. compares every one of the EIGHT v2 digests (+ domainSeparator, hashCalls, signerIdOf) with the
#    contract's views, the admin-batch selectors with `cast sig`, and the match-code word list with
#    docs/matchwords.json
# 3. signs real digests with the software key and lets the chain verify them: a USDC metaTransfer,
#    a native-ETH metaTransfer (asset = 0), and the pairing admin batch (metaExecute of addSigner +
#    setLimit x2 + setRecovery on the wallet itself), then reads back what the batch did
import json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import eip712, p256, words  # noqa: E402

RPC = os.environ.get("RPC", "http://127.0.0.1:8545")
PK0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"   # anvil account 0
ACCT0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ACCT1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"                          # anvil account 1
DEPLOY = os.path.join(HERE, "..", "packages", "foundry", "deployments", "31337.json")
MATCHWORDS = os.path.join(HERE, "..", "docs", "matchwords.json")
ZERO32 = "0x" + "00" * 32
ETH = eip712.ETH

fails = 0


def cast(*args, rpc=True):
    out = subprocess.run(["cast", *args] + (["--rpc-url", RPC] if rpc else []), capture_output=True, text=True)
    if out.returncode != 0:
        raise RuntimeError("cast %s failed:\n%s" % (" ".join(args[:3]), out.stderr.strip()))
    return out.stdout.strip()


def call(to, sig, *args):
    return cast("call", to, sig, *[str(a) for a in args])


def send(to, sig, *args, value=None):
    extra = ["--value", str(value)] if value else []
    return json.loads(cast("send", to, sig, *[str(a) for a in args], *extra, "--private-key", PK0, "--json"))


def num(s):
    return int(s.split()[0])


def check(name, mine, theirs):
    global fails
    mine, theirs = str(mine), str(theirs)
    ok = mine.lower() == theirs.lower()
    print("%s  %-24s device %s  contract %s" % ("PASS" if ok else "FAIL", name, mine[:18] + "..", theirs[:18] + ".."))
    if not ok:
        fails += 1
    return ok


def report(ok, text):
    global fails
    print("%s  %s" % ("PASS" if ok else "FAIL", text))
    if not ok:
        fails += 1
    return ok


def abi_word(kind, v):
    if kind == "address":
        return "%064x" % int(v, 16)
    if kind == "bytes32":
        return v[2:].lower()
    return "%064x" % int(v)


def encode_admin(name, *args):
    """Calldata for a self-only admin call, built from eip712.ADMIN_ABI (what the app would send)."""
    types = dict(eip712.ADMIN_ABI)[name]
    sel = [k for k, v in eip712.ADMIN_SELECTORS.items() if v[0] == name][0]
    return sel + bytes.fromhex("".join(abi_word(t, a) for t, a in zip(types, args)))


def tuple_arg(calls):
    return "[" + ",".join("(%s,%d,0x%s)" % (t, v, data.hex()) for t, v, data in calls) + "]"


def sign(d, digest):
    r, s = p256.sign(d, digest)
    return "0x%064x%064x" % (r, s)


def main():
    global fails
    dep = json.load(open(DEPLOY))
    by_name = {v: k for k, v in dep.items() if k.startswith("0x")}
    factory, usdc, impl = by_name["Factory"], by_name["MockUSDC"], by_name["InstantWallet"]
    chain_id = int(cast("chain-id"))
    print("chain %d  factory %s  usdc %s" % (chain_id, factory, usdc))

    # --- static parity: the word list and the admin selectors
    report(list(words.WORDS) == json.load(open(MATCHWORDS)) and len(words.WORDS) == 256,
           "words.WORDS is byte-identical to docs/matchwords.json (256 words)")
    for sel, (name, types) in eip712.ADMIN_SELECTORS.items():
        check("selector " + name, eip712.hexlify(sel), cast("sig", "%s(%s)" % (name, ",".join(types)), rpc=False))

    # --- a fresh chip key and its wallet
    d = p256.rand_scalar()
    x, y = p256.pubkey(d)
    qx, qy = "0x%064x" % x, "0x%064x" % y
    sid = eip712.signer_id(qx, qy)
    check("signerIdOf", sid, call(impl, "signerIdOf(bytes32,bytes32)(address)", qx, qy))

    wallet = call(factory, "getWalletAddress(bytes32,bytes32,bytes32)(address)", qx, qy, ZERO32)
    send(factory, "createWallet(bytes32,bytes32,bytes32,uint8,bytes32)", ZERO32, qx, qy, 1, ZERO32)
    print("wallet", wallet, "signer", sid, "(kind raw, owner)")
    assert call(wallet, "isSigner(address)(bool)", sid) == "true"

    check("domainSeparator", eip712.hexlify(eip712.domain_separator(chain_id, wallet)), call(wallet, "domainSeparator()(bytes32)"))

    # --- the eight v2 digests
    nonce, deadline = 7, 1757800000
    to, amount, fee = ACCT1, 2000_000000, 20000
    check("hashTransfer (USDC)",
          eip712.hexlify(eip712.transfer_digest(chain_id, wallet, usdc, to, amount, fee, nonce, deadline)),
          call(wallet, "hashTransfer(address,address,uint256,uint256,uint256,uint256)(bytes32)", usdc, to, amount, fee, nonce, deadline))
    check("hashTransfer (ETH)",
          eip712.hexlify(eip712.transfer_digest(chain_id, wallet, ETH, to, 10 ** 16, 10 ** 13, nonce, deadline)),
          call(wallet, "hashTransfer(address,address,uint256,uint256,uint256,uint256)(bytes32)", ETH, to, 10 ** 16, 10 ** 13, nonce, deadline))

    calls = [
        (usdc, 0, bytes.fromhex("a9059cbb" + "%064x" % int(ACCT1, 16) + "%064x" % 5_000000)),
        (ACCT1, 10 ** 15, bytes.fromhex("deadbeef01")),
    ]
    ch = eip712.calls_hash(calls)
    check("hashCalls (2 calls)", eip712.hexlify(ch), call(wallet, "hashCalls((address,uint256,bytes)[])(bytes32)", tuple_arg(calls)))
    check("hashExecute",
          eip712.hexlify(eip712.execute_digest(chain_id, wallet, calls, nonce, deadline)),
          call(wallet, "hashExecute(bytes32,uint256,uint256)(bytes32)", eip712.hexlify(ch), nonce, deadline))

    pqx, pqy = "0x" + "11" * 32, "0x" + "22" * 32
    cred = "0x" + "ab" * 32
    check("hashAddSigner",
          eip712.hexlify(eip712.add_signer_digest(chain_id, wallet, pqx, pqy, 0, 0, cred, nonce, deadline)),
          call(wallet, "hashAddSigner(bytes32,bytes32,uint8,uint8,bytes32,uint256,uint256)(bytes32)", pqx, pqy, 0, 0, cred, nonce, deadline))
    check("hashUpdateSigner",
          eip712.hexlify(eip712.update_signer_digest(chain_id, wallet, ACCT1, 1, nonce, deadline)),
          call(wallet, "hashUpdateSigner(address,uint8,uint256,uint256)(bytes32)", ACCT1, 1, nonce, deadline))
    check("hashSetLimit (USDC)",
          eip712.hexlify(eip712.set_limit_digest(chain_id, wallet, ACCT1, usdc, 500_000000, nonce, deadline)),
          call(wallet, "hashSetLimit(address,address,uint128,uint256,uint256)(bytes32)", ACCT1, usdc, 500_000000, nonce, deadline))
    check("hashSetLimit (ETH)",
          eip712.hexlify(eip712.set_limit_digest(chain_id, wallet, ACCT1, ETH, 10 ** 17, nonce, deadline)),
          call(wallet, "hashSetLimit(address,address,uint128,uint256,uint256)(bytes32)", ACCT1, ETH, 10 ** 17, nonce, deadline))
    check("hashRemoveSigner",
          eip712.hexlify(eip712.remove_signer_digest(chain_id, wallet, ACCT1, nonce, deadline)),
          call(wallet, "hashRemoveSigner(address,uint256,uint256)(bytes32)", ACCT1, nonce, deadline))
    check("hashSetRecovery",
          eip712.hexlify(eip712.set_recovery_digest(chain_id, wallet, ACCT1, 86400, nonce, deadline)),
          call(wallet, "hashSetRecovery(address,uint64,uint256,uint256)(bytes32)", ACCT1, 86400, nonce, deadline))
    check("hashCancelRecovery",
          eip712.hexlify(eip712.cancel_recovery_digest(chain_id, wallet, nonce, deadline)),
          call(wallet, "hashCancelRecovery(uint256,uint256)(bytes32)", nonce, deadline))

    # --- a USDC transfer signed with the software key, verified and executed by the contract
    send(usdc, "mint(address,uint256)", wallet, 5000_000000)
    onchain_nonce = num(call(wallet, "nonce()(uint256)"))
    now = int(cast("block", "latest", "-f", "timestamp"))
    deadline = now + 600
    digest = eip712.transfer_digest(chain_id, wallet, usdc, to, amount, fee, onchain_nonce, deadline)
    sig = sign(d, digest)
    code = words.match_code(digest)
    report(code == "%s %s %d" % (words.WORDS[digest[0]], words.WORDS[digest[1]], digest[2] % 100) and len(code.split()) == 3,
           "match code for this transfer: '%s' (WORDS[d0] WORDS[d1] d2%%100)" % code)
    valid = call(wallet, "isValidSignature(address,bytes32,bytes)(bool)", sid, eip712.hexlify(digest), sig)
    report(valid == "true", "isValidSignature -> %s" % valid)
    bad = call(wallet, "isValidSignature(address,bytes32,bytes)(bool)", sid, eip712.hexlify(bytes([digest[0] ^ 1]) + digest[1:]), sig)
    report(bad == "false", "isValidSignature on a tampered digest -> %s" % bad)

    before = num(call(usdc, "balanceOf(address)(uint256)", to))
    relayer_before = num(call(usdc, "balanceOf(address)(uint256)", ACCT0))
    rc = send(wallet, "metaTransfer(address,address,uint256,uint256,address,uint256,bytes)", usdc, to, amount, fee, sid, deadline, sig)
    got, got_fee = num(call(usdc, "balanceOf(address)(uint256)", to)) - before, num(call(usdc, "balanceOf(address)(uint256)", ACCT0)) - relayer_before
    report(got == amount and got_fee == fee and rc.get("status") in ("0x1", 1, "1"),
           "metaTransfer USDC tx %s status %s: recipient +%d, relayer fee +%d, wallet nonce now %s"
           % (rc.get("transactionHash", "?")[:14] + "..", rc.get("status"), got, got_fee, call(wallet, "nonce()(uint256)")))

    # --- a native-ETH transfer: asset = address(0)
    cast("send", wallet, "--value", str(10 ** 17), "--private-key", PK0)      # fund the wallet with 0.1 ETH
    onchain_nonce = num(call(wallet, "nonce()(uint256)"))
    eamt, efee = 10 ** 16, 10 ** 13
    digest = eip712.transfer_digest(chain_id, wallet, ETH, to, eamt, efee, onchain_nonce, deadline)
    before = int(cast("balance", to))
    rc = send(wallet, "metaTransfer(address,address,uint256,uint256,address,uint256,bytes)", ETH, to, eamt, efee, sid, deadline, sign(d, digest))
    got = int(cast("balance", to)) - before
    report(got == eamt and rc.get("status") in ("0x1", 1, "1"),
           "metaTransfer ETH tx %s: recipient +%d wei (asset = 0x0)" % (rc.get("transactionHash", "?")[:14] + "..", got))

    # --- the pairing admin batch: one Execute, every call on the wallet itself
    pd = p256.rand_scalar()
    px, py = p256.pubkey(pd)
    pqx, pqy = "0x%064x" % px, "0x%064x" % py
    psid = eip712.signer_id(pqx, pqy)
    batch = [
        (wallet, 0, encode_admin("addSigner", pqx, pqy, 0, 0, cred)),
        (wallet, 0, encode_admin("setLimit", psid, usdc, 500_000000)),
        (wallet, 0, encode_admin("setLimit", psid, ETH, 10 ** 17)),
        (wallet, 0, encode_admin("setRecovery", ACCT1, 2 * 86400)),
    ]
    decoded = [eip712.decode_admin_call(data) for _, _, data in batch]
    report([n for n, _ in decoded] == ["addSigner", "setLimit", "setLimit", "setRecovery"]
           and decoded[0][1] == [pqx, pqy, 0, 0, cred] and decoded[1][1] == [psid, usdc.lower(), 500_000000]
           and decoded[2][1] == [psid, ETH, 10 ** 17] and decoded[3][1] == [ACCT1.lower(), 2 * 86400],
           "decode_admin_call round-trips the 4 admin calls (%s)" % ", ".join(n for n, _ in decoded))
    report(eip712.decode_admin_call(batch[1][2] + b"\x01") is None and eip712.decode_admin_call(batch[1][2][:-1]) is None,
           "decode_admin_call refuses a padded / truncated setLimit")
    ch = eip712.calls_hash(batch)
    check("hashCalls (admin batch)", eip712.hexlify(ch), call(wallet, "hashCalls((address,uint256,bytes)[])(bytes32)", tuple_arg(batch)))
    onchain_nonce = num(call(wallet, "nonce()(uint256)"))
    digest = eip712.execute_digest(chain_id, wallet, batch, onchain_nonce, deadline)
    rc = send(wallet, "metaExecute((address,uint256,bytes)[],address,uint256,bytes)", tuple_arg(batch), sid, deadline, sign(d, digest))
    ok = rc.get("status") in ("0x1", 1, "1")
    report(ok, "metaExecute admin batch tx %s status %s" % (rc.get("transactionHash", "?")[:14] + "..", rc.get("status")))
    if ok:
        signer = call(wallet, "getSigner(address)((bytes32,bytes32,uint8,uint8,uint64))", psid)
        role = int(signer.strip("()").split(",")[3])        # (qx, qy, kind, role, addedAt)
        lim_usdc = call(wallet, "remainingAllowance(address,address)(uint256)", psid, usdc)
        lim_eth = call(wallet, "remainingAllowance(address,address)(uint256)", psid, ETH)
        rec = call(wallet, "recoveryAddress()(address)")
        delay = call(wallet, "recoveryDelay()(uint64)")
        report(call(wallet, "isSigner(address)(bool)", psid) == "true" and role == 0 and num(lim_usdc) == 500_000000
               and num(lim_eth) == 10 ** 17 and rec.lower() == ACCT1.lower() and num(delay) == 2 * 86400,
               "batch took effect: passkey added as role %d, USDC limit %d, ETH limit %d, recovery %s / %d s"
               % (role, num(lim_usdc), num(lim_eth), rec[:10] + "..", num(delay)))

    print("\n%d failure(s)" % fails if fails else
          "\nALL 8 v2 DIGESTS MATCH THE CONTRACT; USDC + ETH metaTransfer and the pairing admin batch went through on chain")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
