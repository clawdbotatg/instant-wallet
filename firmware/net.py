# WiFi plus an optional network console for isolated development.
# The console is passwordless arbitrary code execution and must remain disabled when holding value.
import network, socket, os, time
from machine import Pin
import secrets

led = Pin("LED", Pin.OUT)
PORT = 2323
_listen = None


def connect(timeout_s=20):
    network.hostname(secrets.HOSTNAME)
    wlan = network.WLAN(network.STA_IF)
    wlan.active(True)
    if not wlan.isconnected():
        wlan.connect(secrets.WIFI_SSID, secrets.WIFI_PASS)
        t0 = time.ticks_ms()
        while not wlan.isconnected() and time.ticks_diff(time.ticks_ms(), t0) < timeout_s * 1000:
            led.toggle()
            time.sleep_ms(150)
    if wlan.isconnected():
        led.on()
        print("wifi up:", wlan.ifconfig()[0], "hostname:", secrets.HOSTNAME)
    else:
        led.off()
        print("wifi failed, status", wlan.status())
    return wlan


def _accept(ls):
    try:
        conn, addr = ls.accept()
    except OSError:
        return  # nothing pending (non-blocking listen socket)
    print("console from", addr)
    conn.setblocking(False)
    os.dupterm(conn, 0)


def poll_accept():
    """Call from a timer tick. The socket-accept callback needs a free scheduler slot, which a busy
    timer can starve; polling here means a connection can never get stuck in the backlog."""
    if _listen:
        _accept(_listen)


def console(port=PORT):
    global _listen
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(socket.getaddrinfo("0.0.0.0", port)[0][-1])
    s.listen(2)
    s.setblocking(False)
    s.setsockopt(socket.SOL_SOCKET, 20, _accept)  # 20 = register accept callback
    _listen = s
    print("console listening on", port)


def start():
    wlan = connect()
    if wlan.isconnected() and getattr(secrets, "ENABLE_NETWORK_CONSOLE", False):
        console()
    elif wlan.isconnected():
        print("network console disabled")
    return wlan
