# Emulator `network`: WiFi is always up. The host (browser or node) does the real HTTP.
STA_IF = 0
AP_IF = 1
STAT_IDLE = 0
STAT_CONNECTING = 1
STAT_WRONG_PASSWORD = -3
STAT_NO_AP_FOUND = -2
STAT_CONNECT_FAIL = -1
STAT_GOT_IP = 3

_host = "instant"
_state = {"active": True, "connected": True}


def hostname(name=None):
    global _host
    if name is None:
        return _host
    _host = name


def country(c=None):
    return "US"


class WLAN:
    def __init__(self, iface=STA_IF):
        self.iface = iface

    def active(self, v=None):
        if v is None:
            return _state["active"]
        _state["active"] = bool(v)

    def connect(self, ssid=None, key=None, **kw):
        _state["connected"] = True

    def disconnect(self):
        _state["connected"] = False

    def isconnected(self):
        return _state["active"] and _state["connected"]

    def status(self, param=None):
        if param == "rssi":
            return -50
        return STAT_GOT_IP if self.isconnected() else STAT_IDLE

    def ifconfig(self, cfg=None):
        return ("127.0.0.1", "255.255.255.0", "127.0.0.1", "127.0.0.1")

    def ipconfig(self, *a, **k):
        return ("127.0.0.1", "255.255.255.0")

    def config(self, *a, **k):
        if a and a[0] == "mac":
            return b"\x02emu\x00\x01"
        if a and a[0] == "ssid":
            return "emulator"
        return None

    def scan(self):
        return [(b"emulator", b"\x02emu\x00\x01", 1, -50, 0, False)]
