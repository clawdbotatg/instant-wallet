# Instant Wallet device: build guide

A hardware signer for Instant Wallet built from three off-the-shelf parts, no soldering. It shows
the wallet balance in dollars. When the app asks it to sign something, it puts the amount, the
recipient and a three-word **match code** on its own screen and does nothing until you press the
green button. The key lives in an ATECC608 secure element and never leaves it.

On chain the device is one **signer** of an `InstantWallet` (an owner by default), alongside your
passkeys. Nothing changes about the wallet address when you pair it. Protocol: `docs/PROTOCOL.md`.

```
phone / desktop ──"send $2,000 to atg.eth"──▶ app (queue + relay)
                                                  │  the device polls over WiFi (every 12 s)
                                                  ▼
                                           the device
                                           rebuilds the EIP-712 digest from the RAW fields
                                           screen:  SIGN   $2,000 USDC to atg.eth   [amber fox 42]   REJECT
                                           ATECC608 signs the digest (P-256), r‖s
                                                  │
                                                  ▼
                                    relay pays gas ──▶ InstantWallet.metaTransfer
```

## 1. Order the parts

| part | ~price | link |
|---|---|---|
| Raspberry Pi Pico 2 W, **pre-soldered header** | $12 | Amazon `B0DRJXPPWL` (Freenove) or any Pico 2 W with headers |
| Waveshare Pico-LCD-1.3 (240×240 IPS, joystick, A/B/X/Y) | $15 | Amazon `B092VVCBQP` |
| Adafruit ATECC608 breakout, STEMMA QT | $6 | Adafruit 4314 |
| STEMMA QT / JST-SH 4-pin cable, any ends | $1 to $8 | Amazon `B08HQ1VSVL` (kit, several ends), or Adafruit 4209 (bare ends) |
| micro-USB cable, data not charge-only | | |

About $35. No soldering iron.

## 2. Print the case

`case/waveshare-13-pico-lcd-case-tomas-plass.stl` (v0): both halves in one file, PLA, 0.2 mm
layers, no supports. Snaps together, micro-USB slot on the end, screen window, the four buttons
and the joystick poke through. `case/README.md` has the history and the remix with floating
keycaps and a joystick hat (`case/zez0000/`, `case/out/`); `case/gen.py` regenerates the caps if
your parts differ. `case/BUTTONS.md` is the cap design log.

The emulator (`emu/`) renders the `case/zez0000/` STLs in 3D, so you can see the assembled device
before printing anything.

## 3. Put it together

1. Plug the Pico into the LCD board's female header, component side toward the LCD, USB at the
   joystick end.
2. Plug the STEMMA QT cable into the ATECC breakout.
3. Push the cable's four bare wires into the LCD board's header socket **beside** the Pico pins.
   The spring contact grips both. Counting from the USB end, right side: red into 3V3 (pin 36),
   black into GND (pin 38). Left side: blue into GP4 (pin 6), yellow into GP5 (pin 7). Tug lightly.
4. Jam the breakout into the gap between the two boards, wires flat.

`SOLDERING.md` has the pinout diagram and the soldered version if you want it permanent.

Buttons, as seen from the screen: the joystick is on the left; A, B, X, Y run down the right
edge, A at the top (green cap) and Y at the bottom (red cap). The firmware draws the green SIGN
bar in line with A and the red REJECT bar in line with Y.

## 4. Flash the firmware

1. Hold BOOTSEL on the Pico, plug it into a computer, release. A drive named `RP2350` appears.
2. Drag [MicroPython for the Pico 2 W](https://micropython.org/download/RPI_PICO2_W/) (`.uf2`,
   1.26 or newer) onto it. The drive disappears and the board reboots.
3. On the computer: `uv tool install mpremote` (or `pip install mpremote`).
4. Copy `firmware/secrets.example.py` to `firmware/secrets.py`. Put in your WiFi, the app URL
   (`http://<host>:3000` for a local app), and a `DEVICE_NAME` (it is shown in the pairing QR).
5. First time, over USB: `cd firmware && mpremote cp *.py :` then `mpremote reset`.

The passwordless WiFi console is disabled by default because it grants full control of the
signer. For isolated development only, set `ENABLE_NETWORK_CONSOLE = True`; then `tools/push`
deploys firmware over the air and `tools/pico` opens the console. Disable it before holding
real value.

The screen comes up, finds the chip on the bus, and shows the **pairing QR** until the app
reports the device as a signer.

**Security pins.** Once the wallet exists, set `EXPECTED_CHAIN_ID`, `EXPECTED_WALLET` and
`EXPECTED_TOKEN` in `secrets.py`. The device then refuses any request whose chain, wallet or
transfer token differs, whatever the app says. Names, symbols and formatted amounts are display
hints; the only things the device trusts are the raw fields it hashes itself.

## 5. Set up the chip (once)

A fresh ATECC608 refuses to make a key until its config zone is locked, once, permanently. This
is normal; every chip in use is locked.

1. In `firmware/secrets.py` temporarily set `ALLOW_LOCK = True` and `ALLOW_GENKEY = True`.
2. Over USB: `mpremote exec 'import signer; s = signer.load(); print(s.lock_config()); print(s.genkey())'`.
   Record the public `qx` and `qy` it prints (they are also in the pairing QR and in what the
   device announces to the app).
3. Set both flags back to `False`, leave `ENABLE_NETWORK_CONSOLE = False`, and flash again.

`genkey` on an already provisioned chip **replaces** the key: a wallet that lists the old key as
a signer can no longer be used from this device (remove that signer from the wallet first, or
use recovery). Never enable the two flags on a device that is a signer of a funded wallet.

Without a chip on the bus the firmware falls back to a software P-256 key in `key.bin` on the
Pico's flash. That is fine for development and for the emulator; it is not a hardware wallet.

## 6. Pair it with your wallet

1. In the app, open your wallet and go to **Pair a device**.
2. The device shows a QR (also: hold **B** on the home screen). The QR text is
   `iw1:<qx>:<qy>:<name>` (`docs/PROTOCOL.md` §4b), i.e. just the public key and the name.
3. Scan it with the phone. The app shows the name and the signer id derived from the key; approve
   `AddSigner` with your passkey (Face ID / Touch ID). Optionally the app then demotes the
   passkey to a spender with a daily limit, so the device becomes the only key that can move more.
4. The device announces itself every 30 s; within that, the pairing dot in the top-right corner
   turns green and the home screen appears.

The device never sends anything but its public key and name; the wallet address, chain id and
signer id come back in the announce reply and are pinned for the session.

## 7. Using it

- **Home**: chain label top-left (green for real money, yellow otherwise), pairing dot top-right,
  balance, the change since boot, a sparkline of the balances the device has seen, the ENS name,
  and a status line (flash messages, "relay gas low", "no app for 60s", "not paired").
  **A** or joystick right: receive (a QR of the wallet address). **Y**: the signer list.
  Hold **B**: the pairing QR.
- **Sign**: green SIGN bar (A), the amount and token, the recipient's name and short address,
  the match code in a yellow box, red REJECT bar (Y). Check that the match code on the device is
  the one the phone shows. Joystick down: every raw field and the digest the device computed;
  down again scrolls; up goes back.
- Other requests have their own screens: **ADD KEY** (label, kind, role, daily limit),
  **UPDATE KEY**, **REMOVE KEY**, **SET RECOVERY**, **CANCEL** recovery, and **GENERAL CALL** /
  **BATCH** for `execute` (target, ETH value, selector; unknown selectors are marked in red; the
  calls hash is on the details page). Every one shows the match code.
- A request whose digest does not match the raw fields is refused automatically, with the reason
  posted back to the app and flashed on the status line.

## 8. Try it without hardware

`emu/` runs the same firmware in a browser or headless (`emu/README.md`). `firmware/mock.py`
is an offline fake of the app: `tools/emu run mock`, then `tools/emu exec 'mock.pair()'`,
`tools/emu exec 'mock.inject("transfer")'`, press A, and `mock.check("req-1")` verifies the
signature the device posted. `firmware/test_digests.py` proves the device's digests against the
deployed contract on a local anvil.
