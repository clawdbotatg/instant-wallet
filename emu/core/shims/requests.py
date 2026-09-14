# Emulator `requests`: same surface the firmware uses (get/post, json=, timeout=, .json(), .close()).
# The transfer itself is synchronous in the host: XHR in the browser worker, curl in node.
import _emu
import json as _json


class Response:
    def __init__(self, status, text, headers):
        self.status_code = status
        self.text = text
        self.headers = headers
        self.reason = ""

    @property
    def content(self):
        return self.text.encode()

    def json(self):
        return _json.loads(self.text)

    def close(self):
        pass


def request(method, url, data=None, json=None, headers=None, timeout=None, stream=None, **kw):
    headers = dict(headers or {})
    if json is not None:
        data = _json.dumps(json)
        headers["Content-Type"] = "application/json"
    if isinstance(data, (bytes, bytearray)):
        data = bytes(data).decode()
    raw = _emu.http(method.upper(), url, data, _json.dumps(headers), int((timeout or 30) * 1000))
    r = _json.loads(raw)
    if r["status"] < 0:
        raise OSError(r["status"], r["text"])
    return Response(r["status"], r["text"], r.get("headers", {}))


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def put(url, **kw):
    return request("PUT", url, **kw)


def patch(url, **kw):
    return request("PATCH", url, **kw)


def delete(url, **kw):
    return request("DELETE", url, **kw)


def head(url, **kw):
    return request("HEAD", url, **kw)
