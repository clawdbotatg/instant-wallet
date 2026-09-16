#!/bin/sh
# Regenerate firmware/shots/*.png: every device screen, rendered by the emulator headless on top
# of firmware/mock.py (no app, no chain). Run after any change to wallet.py / mock.py and look at
# the PNGs (480x480, 2x the 240x240 panel). Exit 1 if the firmware raised.
#   emu/shots.sh [outdir]          default firmware/shots
cd "$(dirname "$0")/.." || exit 1
[ -d emu/node_modules ] || (cd emu && npm install --silent) || exit 1
OUT=${1:-firmware/shots}; mkdir -p "$OUT"
S() { echo "--shot $OUT/$1.png"; }
# a request: queue it, let the 1 s poll pick it up, shoot the summary
R() { echo "--exec mock.inject($1) --wait 1400 $(S "$2")"; }
# sign it (A), wait for the software signer + the fake relay, shoot the result, dismiss (A)
SIGN() { echo "--key A --wait 2500 $(S "$1") --key A --wait 300"; }
# shellcheck disable=SC2046
exec node emu/headless.mjs mock \
  --wait 1500 $(S 1-pair) \
  --exec 'mock.pair()' --wait 2500 $(S 2-home) \
  $(R '"transfer"' 3-sign) \
  --key down --wait 300 $(S 4-details) --key up --wait 300 \
  $(SIGN 5-done) \
  $(R '"transfer",eth=True' 3b-sign-eth) --key down --wait 300 $(S 4b-details-eth) --key up --wait 300 $(SIGN 5b-done-eth) \
  $(R '"addSigner"' 6-addkey) $(SIGN 6b-addkey-done) \
  --wait 1500 $(S 7-home-after) \
  --wait 12000 --wait 12000 --wait 12000 $(S 8-home-spark) \
  --key A --wait 300 $(S 9-receive) --key Y --wait 300 \
  --key Y --wait 300 $(S 10-keys) --key Y --wait 300 \
  --hold B --wait 800 --release B --wait 300 $(S 11-pair-manual) --key Y --wait 300 \
  --exec 'mock.inject("transfer", tamper=True)' --wait 1400 $(S 12-refused) --wait 9000 \
  $(R '"execute"' 13-execute) \
  --key down --wait 300 $(S 14-execute-details-1) --key down --wait 300 $(S 15-execute-details-2) --key up --key up --wait 300 \
  --key Y --wait 500 \
  $(R '"updateSigner"' 16-update) --key Y --wait 500 \
  $(R '"removeSigner"' 17-remove) --key Y --wait 500 \
  $(R '"setRecovery"' 18-setrecovery) --key Y --wait 500 \
  $(R '"cancelRecovery"' 19-cancel) --key Y --wait 500 \
  $(R '"setLimit"' 20-limit) --key down --wait 300 $(S 20b-limit-details) --key up --wait 300 $(SIGN 20c-limit-done) \
  $(R '"setLimit",eth=True' 21-limit-eth) --key Y --wait 500 \
  $(R '"setLimit",limit="0"' 21b-limit-remove) --key Y --wait 500 \
  $(R '"execute",admin=True' 22-admin-batch) \
  --key down --wait 300 $(S 23-admin-details-1) --key down --wait 300 $(S 24-admin-details-2) --key up --key up --wait 300 \
  $(SIGN 25-admin-done) \
  --exec 'print("rejects:", sorted(mock.received["rejects"])); print("valid:", [k for k, v in mock.received["signatures"].items() if v["valid"]]); print("log:", mock.wallet.log[-4:])'
