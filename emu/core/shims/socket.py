# Emulator `socket`: enough for `import socket` to work. Raw sockets are not emulated;
# use `requests`, which the host performs. net.console() is off in the emulator's secrets.py.
AF_INET = 2
AF_INET6 = 10
SOCK_STREAM = 1
SOCK_DGRAM = 2
SOL_SOCKET = 0xFFF
SO_REUSEADDR = 4
IPPROTO_TCP = 6


def getaddrinfo(host, port, *a):
    return [(AF_INET, SOCK_STREAM, 0, "", (host, port))]


class socket:
    def __init__(self, *a, **k):
        pass

    def _no(self, *a, **k):
        raise OSError(95, "sockets are not emulated; use requests")

    bind = listen = accept = connect = send = sendall = recv = read = write = readline = _no

    def setsockopt(self, *a):
        pass

    def setblocking(self, v):
        pass

    def settimeout(self, t):
        pass

    def close(self):
        pass
