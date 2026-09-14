# emu: the virtual Instant Wallet device

Real MicroPython (the WebAssembly build of 1.26, the board runs 1.26.1) running the firmware in
`firmware/` unchanged, with the `machine`/`network`/`requests` modules replaced by shims that talk
to the page. The screen is captured from the ST7789 SPI stream, so what you see is the exact
framebuffer. The device is drawn in 3D from the case STLs in `hardware/case/zez0000/`.

```
tools/emu                 # start the server, open http://localhost:4242
tools/emu run mock        # the whole signing flow offline (firmware/mock.py fakes the app)
tools/emu run hello       # reboot + import emu/sketches/hello.py
tools/emu key A           # press a button (A B X Y up down left right press), key right:300 holds
tools/emu shot            # emu/shots/latest.png
tools/emu exec 'mock.inject("transfer")'   # queue a fake request; then `tools/emu key A`
tools/emu log             # console lines
tools/emu headless mock --wait 1500 --exec 'mock.pair()' --wait 2500 --shot emu/shots/x.png    # no browser
```

Page: left = files, editor (Cmd/Ctrl+Enter runs the open file), console with a REPL; right = the
device (orbit with the mouse, click the caps) or the flat view. Keyboard: W A S D and space for
the joystick, numpad 9 6 3 . for A B X Y (top-row 9 6 3 . work too), after clicking the device.
The 3D view labels each button with its key. `main` picks what boots on reset.

The flash is `firmware/*.py` and `*.bin` (never `secrets.py`; a stub is generated with
`APP_URL = "/app"`, which the server proxies to the Instant Wallet app, `--app http://host:port`,
default `http://localhost:3000`) plus `emu/sketches/*` on top. `main` = `wallet` talks to that
app; `main` = `mock` needs no app at all (see the top of `firmware/mock.py`). Saving in the editor writes to disk.

## Give it to your AI

`emu/SKILL.md` is the skill file. It tells an AI what the screen and buttons are, how to write a
sketch, how to run it here (`tools/emu run`, `key`, `shot`), and how to put it on the real Pico.
Hand it over with a checkout of this repo (the skill runs `tools/emu`, which needs node). In
Claude Code it loads on its own from `.claude/skills/pico-emu`; say "build Tetris for the Pico
wallet" or `/pico-emu`. The page links to it too (top right, "skill file for your AI", also at
http://localhost:4242/skill).

What is modeled: pins (keys pull low when pressed), SPI display window commands, the SPI transfer
time (24 MHz cap until `machine.freq(cpu, peri)` raises the peripheral clock, like rp2), PWM
backlight, `Pin("LED")` (the base glows), `Timer` periodic/one-shot, `Pin.irq`, `machine.reset()`,
a 448 KB heap. Not modeled: I2C (the ATECC608 is absent, the software signer in `key.bin` is used), sockets,
PIO, native/viper code generation (runs as bytecode), real timing of Python itself (wasm is much
faster than the RP2350).

Needs node 18+ and `npm install` in `emu/` (done by `tools/emu` on first run). No build step.
