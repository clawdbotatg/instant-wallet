---
name: pico-emu
description: Write and test MicroPython for the Instant Wallet device (Pico 2 W + Waveshare Pico-LCD-1.3, 240x240 screen, joystick + A/B/X/Y) on the virtual wallet in emu/, then put it on the real board. Use for "build X for the Pico", "make a game/screen/animation for the wallet", "try this on the emulator", or "put it on the Pico".
---

# Instant Wallet device emulator

`emu/` is a virtual Instant Wallet device: real MicroPython 1.26 (WebAssembly) running the same `.py` files
the board runs, a 3D render of the case with clickable buttons, keyboard mapped to the buttons, and
a CLI so a bot can run code, press keys and look at the screen. Code that works here runs on the
Pico unchanged.

## The loop

1. Write a sketch: `emu/sketches/NAME.py` (module name = file name, no spaces, do not reuse a
   firmware name like `lcd`, `mock`, `wallet`, `demo`, `keytest`, `net`). Start from
   `emu/sketches/hello.py`.
2. Run it: `tools/emu run NAME` (starts the server and opens the page if needed, reboots the
   device, imports the module, prints its output; exit 1 on a traceback).
3. Press keys: `tools/emu key A`, `tools/emu key right:300` (hold 300 ms),
   `tools/emu keys right,right,A`. Names: `A B X Y up down left right press`.
4. Look: `tools/emu shot [out.png]` saves the screen (480x480 PNG, default `emu/shots/latest.png`).
   Read the PNG. Text is the 8x8 font, so check it is readable and inside 240x240.
5. Poke: `tools/emu exec 'NAME.some_state'` runs one REPL line and prints the result.
   `tools/emu log 60` shows recent console lines (print() output, tracebacks).
6. Iterate. `tools/emu reset` reboots into the main module; `tools/emu main NAME` sets it.

No browser: `tools/emu headless NAME --wait 300 --key A --wait 100 --shot emu/shots/x.png --exec 'print(1)'`
runs a scripted session and exits (steps run in order). Good for quick checks and CI.

Austin sees the browser page (http://localhost:4242): editor, console, the 3D device. Keys on
the page: W A S D = joystick, space = joystick press, numpad 9 6 3 . = A B X Y (click the device
first so the editor does not eat them; the 3D view shows the key next to each button).

## Ship it to the real Pico

The wallet Pico (WiFi console, when enabled): `./tools/pico cp emu/sketches/NAME.py :NAME.py` then
`./tools/pico exec 'import NAME'`. The spare Pico on USB: `~/.local/bin/mpremote connect
/dev/cu.usbmodem* resume cp emu/sketches/NAME.py :NAME.py + exec 'import NAME'` (one mpremote
process for the whole chain). Never change `main.py` on the wallet Pico unless asked. Firmware
that should ship for good goes in `firmware/` and through `tools/push`.

## The hardware, as seen from Python

- Screen: 240x240, RGB565, ST7789 over SPI. `from lcd import LCD` then `lcd = LCD()`. `lcd` is a
  `framebuf.FrameBuffer`: `fill(c)`, `pixel(x,y[,c])`, `hline/vline(x,y,len,c)`, `line(x1,y1,x2,y2,c)`,
  `rect(x,y,w,h,c[,fill])`, `fill_rect(x,y,w,h,c)`, `ellipse(cx,cy,rx,ry,c[,fill[,quadrants]])`,
  `poly(x,y,coords,c[,fill])`, `text(s,x,y,c)` (8x8 font, one size), `blit(fb,x,y[,key])`,
  `scroll(dx,dy)`. Extras in lcd.py: `big_text(s,x,y,c,scale)`, `center_text(s,y,c,scale=1)`,
  `backlight(pct)`. Nothing appears until `lcd.show()`, which costs about 38 ms (SPI at 24 MHz),
  so full-frame animation tops out near 25 fps. `machine.freq(150_000_000, 150_000_000)` before
  `LCD()` lifts that to about 65 fps (see `firmware/vid.py`). Drawing is done in C and is fast;
  per-pixel Python loops are not.
- Colors: always `color(r, g, b)` from lcd.py (the panel wants byte-swapped RGB565; raw numbers
  come out wrong). Ready-made: `BLACK WHITE RED GREEN BLUE YELLOW GREY DARK`.
- Keys: `keys = Keys()`; `keys.pressed()` returns names that went down since the last call;
  `keys.held("A")` for state. Layout: joystick on the left of the screen, buttons in a column on
  the right: A top (green cap), B, X, Y bottom (red cap). Wallet convention: A = yes/confirm,
  Y = no/back, X = quit a sketch.
- Loop styles. Timer: `Timer(period=40, mode=Timer.PERIODIC, callback=tick)`, return from the
  module, keep `tick` under ~30 ms, offer `stop()`; this is how the firmware runs and it keeps the
  REPL/WiFi console alive on the board. `while True` with `time.sleep_ms()`: fine for a game
  (`demo.py`, `vid.py` do it) but on the board it blocks the console until it returns, so always
  poll a quit key (X) inside the loop. Timer callbacks do not fire while a `while True` runs.
- Time: `time.ticks_ms()`, `time.ticks_diff(a, b)`, `time.sleep_ms()`. No `datetime`, no real clock.
- Memory: a few hundred KB of heap, no swap. Use `bytearray` for big tables, precompute palettes,
  avoid building large lists every frame, call `gc.collect()` between scenes. The emulator caps
  its heap at 448 KB so out-of-memory shows up here too.
- MicroPython, not CPython: no typing module, small stdlib (`math`, `random`, `struct`, `json`,
  `time`, `array`, `collections`), integer-first, f-strings ok. `random.randint`, `random.choice`,
  `random.getrandbits(n)`. `@micropython.viper` speeds up per-pixel loops on the board (runs as
  plain bytecode in the emulator, slower). Files: `open("x.bin","rb")`, `os.listdir()`.
- Other firmware you can import: `wallet` (the real device loop: talks to the app through `/app`,
  software signer here), `mock` (the same `wallet` on top of an in-process fake of the app:
  `mock.pair()`, `mock.inject(kind, eth=, admin=, tamper=, **fields)` for every request kind in
  docs/PROTOCOL.md section 5, `mock.check(id)`; `emu/shots.sh` renders every screen), `eip712`, `qr`, `words`,
  `keccak`, `p256`, `signer`. Do not import `atecc` (no chip in the emulator).

## Emulator vs board

Same: MicroPython version, framebuf, key names and pins, timers, SPI frame time, screen output
(pixel exact). Different: CPU is much faster here (a loop that is smooth here may crawl on the
Pico: keep per-frame Python work small), viper is not native, no I2C chip (`signer.load()` gives
the software key), `network` is always connected, `requests` goes through the page to the app,
`machine.reset()` reboots the device, the flash is rebuilt from `firmware/` + `emu/sketches/` on
every run (files a sketch writes vanish at the next run).

## Files

`emu/server.mjs` (page + control API + app proxy, port 4242), `emu/web/` (page, worker, 3D),
`emu/core/runtime.mjs` (the device: pins, SPI display capture, timers; it also writes the emulator's `secrets.py`), `emu/core/shims/*.py`
(`machine`, `network`, `requests`, `socket`, `rp2`), `emu/headless.mjs`, `emu/cli.mjs`
(`tools/emu`), `emu/sketches/` (yours), `emu/shots/` (screenshots, ignored by git).
