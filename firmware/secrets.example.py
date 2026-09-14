# Copy to secrets.py (gitignored) and fill in. secrets.py lives on the Pico and never leaves it.
WIFI_SSID = "your-ssid"
WIFI_PASS = "your-password"
HOSTNAME = "instant"
APP_URL = "http://<app-host>:3000"      # the Instant Wallet app (device queue lives at /api/*)
DEVICE_NAME = "instant"                  # shown in the pairing QR and on the phone

# Passwordless MicroPython REPL on TCP/2323. Full signer control: isolated development only.
ENABLE_NETWORK_CONSOLE = False

# Security pins. When set, the device refuses any request whose chain / wallet / token differs,
# whatever the app says. Pin all three once the wallet is deployed; None keeps development flexible.
EXPECTED_CHAIN_ID = None                 # e.g. 8453 (Base)
EXPECTED_WALLET = None                   # e.g. "0x..." the InstantWallet clone this chip is a signer of
EXPECTED_TOKEN = None                    # e.g. "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" (USDC on Base)

# Provisioning a FRESH chip. Both are permanent; leave False otherwise.
ALLOW_LOCK = False     # lock the config zone once (required before the chip will make a key)
ALLOW_GENKEY = False   # make a new key in slot 0, replacing the old one (a wallet paired to the old key loses this signer)
