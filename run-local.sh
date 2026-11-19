#!/bin/bash
# Run the whole Instant Wallet on this Mac at https://local.instantwallet.io (README: "Run it fully local").
# instantwallet.io itself is never touched: only the name local.instantwallet.io points at this computer.
#
#   ./run-local.sh            set up what's missing, build, run. Ctrl+C stops it.
#   ./run-local.sh --install  keep it running in the background, and start it at login (--uninstall: stop that)
#   ./run-local.sh --remove   take local.instantwallet.io out of /etc/hosts (and --uninstall)
#
# The first run asks for your Mac password twice (the certificate, the hosts line) and for an Alchemy key.
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

NAME=local.instantwallet.io
DIR="$HOME/.instantwallet-local"
# Next.js sends usage counts to Vercel by default: not from your computer
export NEXT_TELEMETRY_DISABLED=1
ENV=web/.env.local
PORT="${IW_PORT:-3000}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

# --install: start it now and every time you log in, in the background (a LaunchAgent). Its log: ~/.instantwallet-local/run.log
LABEL=io.instantwallet.local
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
uninstall() { launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; }
if [ "${1:-}" = "--install" ]; then
  grep -q '^ALCHEMY_API_KEY=.' "$ENV" 2>/dev/null && [ -f "$DIR/$NAME.pem" ] || { echo "Run ./run-local.sh once first (it asks for your password and your Alchemy key)."; exit 1; }
  uninstall
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$PWD/run-local.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>NO_OPEN</key><string>1</string>
    <key>PATH</key><string>$(dirname "$(command -v node)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/run.log</string>
  <key>StandardErrorPath</key><string>$DIR/run.log</string>
</dict></plist>
PL
  # the copy in this window, if any, makes way
  pkill -f "next start -p $PORT" 2>/dev/null || true
  pkill -f "local-ssl-proxy@2.0.5 --source 443" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "Installed. It starts now (a few minutes the first time) and every time you log in: https://$NAME"
  echo "Log: $DIR/run.log. Stop it for good: ./run-local.sh --uninstall"
  exit 0
fi
if [ "${1:-}" = "--uninstall" ]; then
  uninstall
  echo "It won't start at login any more, and it's stopped."
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  uninstall
  sudo sed -i '' "/$NAME/d" /etc/hosts && sudo dscacheutil -flushcache
  echo "Removed $NAME from /etc/hosts."
  exit 0
fi

# 1. tools: Homebrew, Node 20+, mkcert
command -v brew >/dev/null || { echo "Install Homebrew first: https://brew.sh, then run this again."; exit 1; }
command -v node >/dev/null || { say "Installing Node"; brew install node; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 20 or newer needed: brew upgrade node"; exit 1; }
command -v mkcert >/dev/null || { say "Installing mkcert"; brew install mkcert; }
command -v git >/dev/null || { say "Installing git"; brew install git; }

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

# 4c. the transaction words (clear signing): your own copies of the EF registry and ours, updated each run when online
say "Getting the transaction words (clear signing)"
for r in ethereum/clear-signing-erc7730-registry clawdbotatg/clear-descriptors; do
  d="$DIR/${r#*/}"
  if [ -d "$d" ]; then
    (git -C "$d" fetch -q --depth 1 origin HEAD && git -C "$d" reset -q --soft FETCH_HEAD) || echo "Couldn't update ${r#*/} (offline?); using the copy you have."
  else
    git clone -q --depth 1 --no-checkout "https://github.com/$r.git" "$d" || echo "Couldn't get ${r#*/}; the words come from GitHub instead."
  fi
done
CLEAR=""
[ -d "$DIR/clear-signing-erc7730-registry" ] && [ -d "$DIR/clear-descriptors" ] && CLEAR="CLEAR_REGISTRY_DIR=$DIR/clear-signing-erc7730-registry CLEAR_OURS_DIR=$DIR/clear-descriptors"
# and what a wedgie shows when it signs: wedgie.dev/clear, only that folder of wedgie-dev (about 300 MB the first time)
W="$DIR/wedgie-clear"
if [ -d "$W" ]; then
  (git -C "$W" fetch -q --depth 1 origin HEAD && git -C "$W" reset -q --hard FETCH_HEAD) 2>/dev/null || echo "Couldn't update the wedgie's words (offline?); using the copy you have."
else
  say "Getting the wedgie's words (about 300 MB, once)"
  { git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/clawdbotatg/wedgie-dev.git "$W" &&
    git -C "$W" sparse-checkout set --no-cone '/public/clear/' '!/public/clear/screens/' &&
    git -C "$W" checkout -q; } || { rm -rf "$W"; echo "Couldn't get them; a wedgie reads them from wedgie.dev instead."; }
fi
[ -d "$W/public/clear" ] && CLEAR="$CLEAR WEDGIE_CLEAR_DIR=$W/public/clear"

# 4d. your own indexer (github.com/clawdbotatg/iw-indexer): coins and prices from your node, not Alchemy, on the
# networks you have a node for: set in Settings → Balances and prices (kept by the indexer), each RPC_URL_<chainId>
# in web/.env.local, and an Ethereum node on this computer (127.0.0.1:8545) found by itself. A node on this computer
# may not search history fast (a light client: 512 blocks at a time), so the history search goes to Alchemy
# (LOGS_URL_<chainId>). Always started (with no node it reads nothing: Alchemy, until one is set). Needs Node 22.18+.
IXDIR="$DIR/iw-indexer"
IX=""
IXENV="$( (grep '^RPC_URL_' "$ENV" 2>/dev/null || true) | xargs)"
if ! grep -q '^RPC_URL_1=' "$ENV" 2>/dev/null && curl -sf -m 2 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 | grep -q '"result":"0x1"'; then
  IXENV="$IXENV RPC_URL_1=http://127.0.0.1:8545"
  echo "Found your Ethereum node at 127.0.0.1:8545: your indexer reads from it."
fi
AK="$( (grep '^ALCHEMY_API_KEY=' "$ENV" || true) | cut -d= -f2-)"
for kv in $IXENV; do
  id="${kv%%=*}"; id="${id#RPC_URL_}"; url="${kv#*=}"
  case "$id" in 1) net=eth;; 8453) net=base;; 10) net=opt;; 42161) net=arb;; *) net="";; esac
  case "$url" in http://127.0.0.1*|http://localhost*) [ -n "$net" ] && [ -n "$AK" ] && IXENV="$IXENV LOGS_URL_$id=https://$net-mainnet.g.alchemy.com/v2/$AK";; esac
done
if node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  if [ -d "$IXDIR" ]; then
    (git -C "$IXDIR" fetch -q --depth 1 origin HEAD && git -C "$IXDIR" reset -q --hard FETCH_HEAD) 2>/dev/null || echo "Couldn't update the indexer (offline?); using the copy you have."
  else
    say "Getting your indexer"
    git clone -q --depth 1 https://github.com/clawdbotatg/iw-indexer.git "$IXDIR" || echo "Couldn't get the indexer; coins come from Alchemy."
  fi
  [ -f "$IXDIR/package.json" ] && (cd "$IXDIR" && npm install -s --omit=dev --no-audit --no-fund) && IX=1
else
  echo "Your indexer needs Node 22.18 or newer (brew upgrade node); coins come from Alchemy for now."
fi

# 4e. your own simulator (github.com/clawdbotatg/iw-sim): what a transaction moves, before you sign it. Reads your
# nodes (RPC_<chainId>, if they have debug_traceCall), Alchemy for the rest and for prices. The wallet asks it first and
# sim.instantwallet.io only when it has no answer. Its key stays in iw-sim/.sim-key. Needs Node 24+.
SIMDIR="$DIR/iw-sim"
SIM=""
SIMENV=""
for kv in $IXENV; do
  id="${kv%%=*}"; id="${id#RPC_URL_}"; url="${kv#*=}"
  # a node without the debug API can't run it: that network goes to Alchemy
  if curl -sf -m 5 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"debug_traceCall","params":[{"to":"0x0000000000000000000000000000000000000000"},"latest",{"tracer":"callTracer"}]}' "$url" | grep -q '"result"'; then
    SIMENV="$SIMENV RPC_$id=$url"
  else
    echo "Your node for network $id has no debug_traceCall (turn on its debug API): your simulator uses Alchemy there."
  fi
done
if node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)'; then
  if [ -d "$SIMDIR" ]; then
    (git -C "$SIMDIR" fetch -q --depth 1 origin HEAD && git -C "$SIMDIR" reset -q --hard FETCH_HEAD) 2>/dev/null || echo "Couldn't update the simulator (offline?); using the copy you have."
  else
    say "Getting your simulator"
    git clone -q --depth 1 https://github.com/clawdbotatg/iw-sim.git "$SIMDIR" || echo "Couldn't get the simulator; sim.instantwallet.io runs your transactions."
  fi
  [ -f "$SIMDIR/server.ts" ] && { [ -n "$SIMENV" ] || [ -n "$AK" ]; } && SIM=1
else
  echo "Your simulator needs Node 24 or newer (brew upgrade node); sim.instantwallet.io runs your transactions for now."
fi

# 5. build
for p in "$PORT" 443 ${SIM:+8645}; do
  if lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $p is in use. Stop what's on it (or IW_PORT=3001 ./run-local.sh)."; exit 1; fi
done
# build only when the code changed since the last build (git's commit and any edits)
STAMP="$(git rev-parse HEAD 2>/dev/null)-$(git status --porcelain -- web 2>/dev/null | shasum | cut -c1-12)"
if [ -f web/.next/BUILD_ID ] && [ "$(cat "$DIR/built" 2>/dev/null)" = "$STAMP" ]; then
  say "Already built"
else
  say "Building (a few minutes the first time)"
  (cd web && npm install --no-audit --no-fund && npm run build)
  echo "$STAMP" > "$DIR/built"
fi

# 6. run: the app on $PORT, https on 443 in front of it
say "Starting"
# the store (shared tx queue, names, limits) in a file, so a restart keeps it
(cd web && exec env KV_FILE="$DIR/store.json" $CLEAR ${IX:+INDEXER_URL=http://127.0.0.1:4100} ${SIM:+SIM_URL=http://127.0.0.1:8645} npx next start -p "$PORT") &
APP=$!
IXP=""
if [ -n "$IX" ]; then
  # started again when it stops: setting a node in Settings restarts it on that node
  (cd "$IXDIR" && while :; do env $IXENV DB="$DIR/indexer.db" INDEXER_PORT=4100 node src/main.ts; sleep 1; done) >"$DIR/indexer.log" 2>&1 &
  IXP=$!
fi
SIMP=""
if [ -n "$SIM" ]; then
  (cd "$SIMDIR" && while :; do env $SIMENV ${AK:+ALCHEMY_API_KEY=$AK} PORT=8645 node server.ts; sleep 1; done) >"$DIR/sim.log" 2>&1 &
  SIMP=$!
fi
npx -y local-ssl-proxy@2.0.5 --source 443 --target "$PORT" --cert "$DIR/$NAME.pem" --key "$DIR/$NAME-key.pem" >/dev/null 2>&1 &
PROXY=$!
trap '[ -n "$IXP" ] && pkill -P $IXP 2>/dev/null; [ -n "$SIMP" ] && pkill -P $SIMP 2>/dev/null; kill $APP $PROXY $IXP $SIMP 2>/dev/null; echo; echo "Stopped."' EXIT INT TERM

for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/version" >/dev/null && break; sleep 1; done
say "Running at https://$NAME   (Ctrl+C to stop)"
echo "Sign in with your passkey. To send: Settings → Your relay, or Execute from my wallet."
[ -n "${NO_OPEN:-}" ] || open "https://$NAME" 2>/dev/null || true
wait $APP
