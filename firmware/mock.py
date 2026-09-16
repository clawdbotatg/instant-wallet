# An offline fake of the Instant Wallet app (docs/PROTOCOL.md section 5), in-process.
# `import mock` patches the `requests` module so every HTTP call wallet.py makes is answered here,
# then starts the real wallet. The whole flow runs in the emulator with no app and no chain:
#
#   tools/emu run mock                      boots to the pairing QR (announce says paired: false)
#   tools/emu exec 'mock.pair()'            the phone "scanned" us: next announce says paired
#   tools/emu exec 'mock.inject("transfer")'          a pending $2,000 USDC transfer for our signer
#   tools/emu exec 'mock.inject("transfer", eth=True)'      0.05 ETH (asset = 0x0) instead
#   tools/emu exec 'mock.inject("setLimit")'          a pending "USDC 500/day for the phone" request
#   tools/emu exec 'mock.inject("execute", admin=True)'     the pairing admin batch (4 calls on the wallet)
#   tools/emu exec 'mock.inject("addSigner")'         a pending "add passkey" request
#   tools/emu exec 'mock.inject("transfer", tamper=True)'   digest lies: the device must refuse
#   kinds: transfer execute addSigner updateSigner setLimit removeSigner setRecovery cancelRecovery
#   tools/emu exec 'print(mock.check("req-1"))'       True when the posted signature verifies
#   mock.received                           {"signatures": {id: {...}}, "rejects": {id: body}}
#
# Also runs on a bare board with no WiFi (main.py: `import mock` instead of `import wallet`).
import json, time
import requests
import eip712, words, p256

CHAIN_ID = 31337
CHAIN_NAME = "Base"
WALLET = "0x8b2fD4e1c0A9b37f6E5d2C1a8b7F6e5D4c3B19ac"
TOKEN = "0x3155755b79aA083bd953911C92705B7aA82a18F9"      # MockUSDC on the local anvil (deployments/31337.json)
DECIMALS = 6
ETH = eip712.ETH
PHONE = "0x4d5c3a8f2e1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d"      # the owner's passkey signer id
RELAYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
ENS = "atg.eth"
ATG = "0x34aA3F359A9D614239015126635CE7732c18fDF3"
PHONE_QX = "0x1ccbe91c075fc7f4f033bfa248db8fccd3565de94bbfb12f3c59ff46c271bf83"
PHONE_QY = "0xce4014c68811f9a21a1fdb2c0e6113e06db7ca93b7404e78dc7ccd5ca89a4ca9"

device = {}                 # last announce body
paired = False
nonce = 12
balance = 2847.13           # USD across assets
eth_balance = 0.4213        # ETH held; the rest of the USD is USDC
ETH_USD = 2500.0
_walk = (0, 0, -1.5, 0, 2.25, 0, 0, 3.1, -0.4, 0, 14.02, 0, -2.0, 0, 0, 5.5, 0, 0, -1.1, 0, 4.4, 0)
_calls = 0
requests_db = []            # request dicts, oldest first
received = {"signatures": {}, "rejects": {}}
log = []


def _log(s):
    log.append(s)
    print("mock:", s)


class Resp:
    def __init__(self, status, obj):
        self.status_code = status
        self.text = json.dumps(obj)

    def json(self):
        return json.loads(self.text)

    def close(self):
        pass


def _split(url):
    i = url.find("/api/")
    path = url[i:] if i >= 0 else url
    q = {}
    if "?" in path:
        path, qs = path.split("?", 1)
        for kv in qs.split("&"):
            if "=" in kv:
                k, v = kv.split("=", 1)
                q[k] = v
    return path, q


def _signer_id():
    if device.get("qx"):
        return eip712.signer_id(device["qx"], device["qy"])
    return None


def state():
    global _calls, balance
    _calls += 1
    if _calls > 1:
        balance += _walk[_calls % len(_walk)]
    eth_usd = eth_balance * ETH_USD
    usdc = max(balance - eth_usd, 0.0)
    signers = [
        {"signerId": PHONE, "kind": 0, "role": 0, "label": "iPhone Face ID",
         "limits": [
             {"asset": TOKEN, "symbol": "USDC", "limit": str(500 * 10 ** DECIMALS), "remaining": str(500 * 10 ** DECIMALS)},
             {"asset": ETH, "symbol": "ETH", "limit": str(10 ** 17), "remaining": str(10 ** 17)},
         ]},
    ]
    sid = _signer_id()
    if paired and sid:
        signers.insert(0, {"signerId": sid, "kind": 1, "role": 1, "limits": [], "label": device.get("name", "device")})
    return {
        "chain": {"id": CHAIN_ID, "name": CHAIN_NAME},
        "wallet": {
            "address": WALLET, "ensName": ENS, "deployed": True, "balanceUsd": round(balance, 2),
            "assets": [
                {"asset": ETH, "symbol": "ETH", "decimals": 18, "balance": str(int(eth_balance * 10 ** 18)),
                 "balanceFormatted": "%.4f" % eth_balance, "usd": round(eth_usd, 2)},
                {"asset": TOKEN, "symbol": "USDC", "decimals": DECIMALS, "balance": str(int(usdc * 10 ** DECIMALS)),
                 "balanceFormatted": "%.2f" % usdc, "usd": round(usdc, 2)},
            ],
        },
        "relayer": {"address": RELAYER, "balanceFormatted": "0.0123"},
        "signers": signers,
        "pendingRecovery": None,
    }


def _handle(method, path, q, body):
    global paired
    if path == "/api/device" and method == "POST":
        device.update(body or {})
        return 200, {"paired": paired, "wallet": WALLET if paired else None, "signerId": _signer_id(), "chainId": CHAIN_ID}
    if path == "/api/state" and method == "GET":
        return 200, state()
    if path == "/api/requests" and method == "GET":
        want = q.get("status", "pending")
        sid = q.get("signerId", "").lower()
        out = [r for r in requests_db if r["status"] == want and (not sid or r["signerId"].lower() == sid)]
        return 200, {"requests": [_public(r) for r in out]}
    if path.startswith("/api/requests/") and method == "POST":
        parts = path.split("/")
        rid, action = parts[3], parts[4] if len(parts) > 4 else ""
        for r in requests_db:
            if r["id"] == rid:
                break
        else:
            return 404, {"error": "no such request"}
        if action == "signature":
            ok = check_sig(r, body)
            r["status"] = "confirmed" if ok else "failed"
            if ok:
                r["txHash"] = "0x0fbd390b" + "00" * 24 + "3e2c"
            else:
                r["error"] = "bad signature"
            received["signatures"][rid] = {"r": body.get("r"), "s": body.get("s"), "valid": ok}
            _log("signature for %s valid=%s" % (rid, ok))
            return 200, {"status": r["status"], "txHash": r.get("txHash"), "error": r.get("error")}
        if action == "reject":
            r["status"] = "rejected"
            r["error"] = (body or {}).get("error")
            received["rejects"][rid] = body
            _log("reject for %s: %s" % (rid, body))
            return 200, {"status": "rejected"}
    return 404, {"error": "no route %s %s" % (method, path)}


def _public(r):
    return dict((k, v) for k, v in r.items() if not k.startswith("_"))


def check_sig(r, body):
    """Verify what the device posted against the key it announced and the digest we queued."""
    try:
        rr = int(body["r"], 16)
        ss = int(body["s"], 16)
        if ss > p256.N // 2:
            return False    # not low-s
        return p256.verify(int(device["qx"], 16), int(device["qy"], 16), bytes.fromhex(r["digest"][2:]), rr, ss)
    except Exception as e:
        _log("verify error %r" % e)
        return False


def check(rid):
    s = received["signatures"].get(rid)
    return bool(s and s["valid"])


# ----------------------------------------------------------------------------- the fake requests
def pair():
    """The owner passkey signed AddSigner for our chip: from now on the announce says paired."""
    global paired
    paired = True
    try:
        import wallet
        wallet.last_announce = 0      # announce right away instead of waiting out the interval
    except ImportError:
        pass
    _log("paired")


def _word(kind, v):
    if kind == "address":
        return "%064x" % int(v, 16)
    if kind == "bytes32":
        return v[2:].lower()
    return "%064x" % int(v)


def admin_call(name, *args):
    """Calldata for one self-only admin call (what the app's pairing batch sends)."""
    types = dict(eip712.ADMIN_ABI)[name]
    sel = [k for k, v in eip712.ADMIN_SELECTORS.items() if v[0] == name][0]
    return {"target": WALLET, "value": "0", "data": eip712.hexlify(sel) + "".join(_word(t, a) for t, a in zip(types, args))}


def inject(kind="transfer", tamper=False, eth=False, admin=False, **over):
    """Queue a fake pending request of `kind` for our signer. `eth=True` makes the transfer /
    setLimit about native ETH, `admin=True` makes the execute the pairing admin batch; any other
    field of the request shape (docs/PROTOCOL.md section 5) can be overridden by keyword."""
    global nonce
    sid = _signer_id() or "0x0000000000000000000000000000000000000000"
    now = 1757800000
    deadline = now + 600
    rid = "req-%d" % (len(requests_db) + 1)
    r = {"id": rid, "kind": kind, "chainId": CHAIN_ID, "wallet": WALLET, "signerId": sid, "nonce": str(nonce),
         "deadline": deadline, "status": "pending", "createdAt": now, "updatedAt": now}
    if kind == "transfer":
        if eth:
            r.update({"asset": ETH, "assetSymbol": "ETH", "assetDecimals": 18, "to": ATG, "toName": "vault.atg.eth",
                      "amount": str(5 * 10 ** 16), "amountFormatted": "0.05", "fee": str(10 ** 13)})
        else:
            r.update({"asset": TOKEN, "assetSymbol": "USDC", "assetDecimals": DECIMALS, "to": ATG, "toName": "vault.atg.eth",
                      "amount": str(2000 * 10 ** DECIMALS), "amountFormatted": "2000.00", "fee": str(20000)})
        r.update(over)
        digest = eip712.transfer_digest(CHAIN_ID, WALLET, r["asset"], r["to"], int(r["amount"]), int(r["fee"]), nonce, deadline)
    elif kind == "execute":
        if admin:
            # pairing: add the chip as owner, demote the passkey, give it limits, set recovery (docs/PROTOCOL.md section 1)
            cqx, cqy = device.get("qx") or PHONE_QX, device.get("qy") or PHONE_QY
            calls = [
                admin_call("addSigner", cqx, cqy, 1, 1, "0x" + "00" * 32),
                admin_call("updateSigner", PHONE, 0),
                admin_call("setLimit", PHONE, TOKEN, 500 * 10 ** DECIMALS),
                admin_call("setLimit", PHONE, ETH, 10 ** 17),
            ]
        else:
            calls = [
                {"target": TOKEN, "value": "0", "data": "0xa9059cbb" + ("%064x" % int(ATG, 16)) + ("%064x" % (5 * 10 ** DECIMALS))},
                {"target": ATG, "value": str(10 ** 15), "data": "0x"},
            ]
        r.update({"calls": calls})
        r.update(over)
        cl = [(c["target"], int(c["value"]), bytes.fromhex(c["data"][2:])) for c in r["calls"]]
        r["callsHash"] = eip712.hexlify(eip712.calls_hash(cl))
        digest = eip712.execute_digest(CHAIN_ID, WALLET, cl, nonce, deadline)
    elif kind == "addSigner":
        r.update({"qx": PHONE_QX, "qy": PHONE_QY, "signerKind": 0, "role": 0,
                  "credentialIdHash": "0x" + "ab" * 32, "label": "iPhone Face ID"})
        r.update(over)
        digest = eip712.add_signer_digest(CHAIN_ID, WALLET, r["qx"], r["qy"], r["signerKind"], r["role"], r["credentialIdHash"], nonce, deadline)
    elif kind == "updateSigner":
        r.update({"targetSignerId": PHONE, "role": 1})
        r.update(over)
        digest = eip712.update_signer_digest(CHAIN_ID, WALLET, r["targetSignerId"], r["role"], nonce, deadline)
    elif kind == "setLimit":
        if eth:
            r.update({"targetSignerId": PHONE, "asset": ETH, "assetSymbol": "ETH", "assetDecimals": 18, "limit": str(10 ** 17)})
        else:
            r.update({"targetSignerId": PHONE, "asset": TOKEN, "assetSymbol": "USDC", "assetDecimals": DECIMALS, "limit": str(500 * 10 ** DECIMALS)})
        r.update(over)
        digest = eip712.set_limit_digest(CHAIN_ID, WALLET, r["targetSignerId"], r["asset"], int(r["limit"]), nonce, deadline)
    elif kind == "removeSigner":
        r.update({"targetSignerId": PHONE})
        r.update(over)
        digest = eip712.remove_signer_digest(CHAIN_ID, WALLET, r["targetSignerId"], nonce, deadline)
    elif kind == "setRecovery":
        r.update({"recoveryAddress": RELAYER, "recoveryDelay": 86400})
        r.update(over)
        digest = eip712.set_recovery_digest(CHAIN_ID, WALLET, r["recoveryAddress"], r["recoveryDelay"], nonce, deadline)
    elif kind == "cancelRecovery":
        r.update(over)
        digest = eip712.cancel_recovery_digest(CHAIN_ID, WALLET, nonce, deadline)
    else:
        raise ValueError("unknown kind " + kind)
    if tamper:
        digest = bytes([digest[0] ^ 1]) + digest[1:]     # the app lies about what it wants signed
    r["digest"] = eip712.hexlify(digest)
    r["matchCode"] = words.match_code(digest)
    for k in ("digest", "matchCode", "callsHash", "signerId"):
        if k in over:
            r[k] = over[k]          # lie about a derived field on purpose: the device must refuse
    requests_db.append(r)
    nonce += 1
    _log("queued %s %s match '%s'%s" % (rid, kind, r["matchCode"], " (TAMPERED)" if tamper else ""))
    return rid


# ----------------------------------------------------------------------------- patch requests
def _request(method, url, json=None, **kw):
    path, q = _split(url)
    status, obj = _handle(method, path, q, json)
    return Resp(status, obj)


def install():
    requests.get = lambda url, **kw: _request("GET", url, **kw)
    requests.post = lambda url, **kw: _request("POST", url, **kw)


install()
import wallet
wallet.start()
