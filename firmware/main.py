# Instant Wallet device firmware. boot.py already brought WiFi + console up.
# Start the wallet on timers and return, so the REPL idles and the WiFi console works.
import sys
try:
    import wallet
    wallet.start()
except Exception as e:
    with open("error.log", "w") as f:
        sys.print_exception(e, f)
    sys.print_exception(e)
