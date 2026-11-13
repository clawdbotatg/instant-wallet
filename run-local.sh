#!/bin/bash
# Run the whole Instant Wallet on this Mac at https://local.instantwallet.io (README: "Run it fully local").
# instantwallet.io itself is never touched: only the name local.instantwallet.io points at this computer.
#
#   ./run-local.sh            set up what's missing, build, run. Ctrl+C stops it.
#   ./run-local.sh --remove   take local.instantwallet.io out of /etc/hosts
#
# The first run asks for your Mac password twice (the certificate, the hosts line) and for an Alchemy key.
set -euo pipefail
cd "$(dirname "$0")"

NAME=local.instantwallet.io
DIR="$HOME/.instantwallet-local"
ENV=web/.env.local
PORT="${IW_PORT:-3000}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ "${1:-}" = "--remove" ]; then
  sudo sed -i '' "/$NAME/d" /etc/hosts && sudo dscacheutil -flushcache
  echo "Removed $NAME from /etc/hosts."
  exit 0
fi

# 1. tools: Homebrew, Node 20+, mkcert
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh, then run this again."; exit 1; }
command -v node >/dev/null || { say "Installing Node"; brew install node; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 20 or newer needed: brew upgrade node"; exit 1; }
command -v mkcert >/dev/null || { say "Installing mkcert"; brew install mkcert; }

# 2. a certificate this Mac trusts, for local.instantwallet.io
say "Trusting your own certificate (may ask for your Mac password)"
mkcert -install
mkdir -p "$DIR"
[ -f "$DIR/$NAME.pem" ] || (cd "$DIR" && mkcert "$NAME")

# 3. local.instantwallet.io → this computer
if ! grep -q "$NAME" /etc/hosts; then
  say "Pointing $NAME at this computer (asks for your Mac password)"
  echo "127.0.0.1 $NAME" | sudo tee -a /etc/hosts >/dev/null
  sudo dscacheutil -flushcache
  sudo killall -HUP mDNSResponder 2>/dev/null || true
fi

# 4. your own Alchemy key (reads balances and sends; free)
if ! grep -q '^ALCHEMY_API_KEY=.' "$ENV" 2>/dev/null; then
  say "An Alchemy key is needed: sign in at https://dashboard.alchemy.com, create an app, copy its API key."
  read -r -p "Paste it here: " KEY
  [ -n "$KEY" ] || { echo "No key, stopping."; exit 1; }
  echo "ALCHEMY_API_KEY=$KEY" >> "$ENV"
fi

# 4b. your own node, if you run one (optional): it carries the chain reads and your relay's sends
if ! grep -q '^RPC_URL_' "$ENV" 2>/dev/null && [ -t 0 ]; then
  GUESS=""
  for u in http://127.0.0.1:8545 http://localhost:8545; do
    curl -sf -m 2 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$u" >/dev/null && { GUESS=$u; break; }
  done
  say "Your own node? Paste its URL, or press Enter to use Alchemy only.${GUESS:+ (Found one at $GUESS: type y to use it.)}"
  read -r -p "Node URL: " NODE
  [ "$NODE" = "y" ] && NODE=$GUESS
  if [ -n "$NODE" ]; then
    HEX=$(curl -sf -m 5 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$NODE" | grep -oE '"result":"0x[0-9a-fA-F]+"' | grep -oE '0x[0-9a-fA-F]+' || true)
    if [ -n "$HEX" ]; then
      echo "RPC_URL_$((HEX))=$NODE" >> "$ENV"
      echo "Using your node for network $((HEX))."
    else
      echo "That node didn't answer; using Alchemy. Add it later in web/.env.local as RPC_URL_<chainId>=<url>."
    fi
  fi
fi

# 5. build
for p in "$PORT" 443; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p is in use. Stop what's on it (or IW_PORT=3001 ./run-local.sh)."; exit 1; fi
done
say "Building (a few minutes the first time)"
(cd web && npm install --no-audit --no-fund && npm run build)

# 6. run: the app on $PORT, https on 443 in front of it
say "Starting"
(cd web && exec npx next start -p "$PORT") &
APP=$!
npx -y local-ssl-proxy@2.0.5 --source 443 --target "$PORT" --cert "$DIR/$NAME.pem" --key "$DIR/$NAME-key.pem" >/dev/null 2>&1 &
PROXY=$!
trap 'kill $APP $PROXY 2>/dev/null; echo; echo "Stopped."' EXIT INT TERM

for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null && break; sleep 1; done
say "Running at https://$NAME   (Ctrl+C to stop)"
echo "Sign in with your passkey. To send: Settings → Your relay, or Execute from my wallet."
[ -n "${NO_OPEN:-}" ] || open "https://$NAME" 2>/dev/null || true
wait $APP
