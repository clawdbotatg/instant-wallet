# Soldering the ATECC608 to the Pico

Which chip: the Adafruit ATECC608 STEMMA QT breakout (Adafruit 4314). The key is generated inside
the chip and never leaves it; moving the breakout to another Pico keeps the same signer, so the
wallet it is paired with does not change.

## Fewest joints: use the STEMMA QT connector

Do not solder to the breakout. Plug a STEMMA QT cable into its JST connector and solder only the
four bare wire ends to the Pico. Adafruit 4209 is the cable with bare ends. Cutting any STEMMA QT
cable in half works too. Wire colors: red = power, black = GND, blue = SDA, yellow = SCL.

## Where on the Pico

Component side up, USB at the top. Pin numbers count down the left side then up the right.

```
                     USB
              ┌─────┤   ├─────┐
     GP0   1  │ o           o │ 40  VBUS
     GP1   2  │ o           o │ 39  VSYS
     GND   3  │ o           o │ 38  GND      <- black
     GP2   4  │ o           o │ 37  3V3_EN
     GP3   5  │ o           o │ 36  3V3 OUT  <- red
blue ->  GP4   6  │ o  SDA        o │ 35  ADC_VREF
yellow-> GP5   7  │ o  SCL        o │ 34  GP28
     GND   8  │ o           o │ 33  GND
     GP6   9  │ o           o │ 32  GP27
     ...      │              │
```

| wire | breakout | Pico pin | Pico label |
|---|---|---|---|
| red | VIN | 36 | 3V3 (OUT) |
| black | GND | 38 | GND |
| blue | SDA | 6 | GP4 |
| yellow | SCL | 7 | GP5 |

All four are within the top 8 pins, near the USB end. Solder to the existing header solder blobs
on the component side. Pins 6 and 7 are next to each other, so that is where a bridge happens.
Pin 37 sits between 36 and 38, keep solder off it.

## Doing it after 20 years

1. Pull the Pico off the LCD board first. Solder the bare Pico.
2. Iron at 320 to 350 C. Thin solder, 0.6 mm or under. A dab of flux on each blob helps a lot.
3. Tin the iron tip, wipe it. Tin each wire end: strip 2 mm, touch iron and solder to it until it
   wicks in. Trim to 1.5 mm.
4. Add a little fresh solder to each of the four header blobs so they are shiny and domed.
5. Hold the tinned wire against the blob with tweezers. Touch the iron to the blob for 1 to 2 s until
   it melts, push the wire in, lift the iron, hold still 2 s. Done. Do not keep the iron on longer
   than 3 s, the pad does not care but the wire insulation does.
6. Wires should leave the board flat along the surface, not poke up, since the LCD board sits about
   11 mm above.
7. Check with a multimeter on continuity before powering: GP4 to GP5 must NOT beep, 3V3 to GND must
   NOT beep. Each wire to its pin must beep.
8. A blob of hot glue over the four joints keeps them from flexing off.

## Test

Plug the Pico back on the LCD board, power up, then from the Mac:

```
./tools/pico exec 'from machine import I2C, Pin; import time
i2c = I2C(0, sda=Pin(4), scl=Pin(5), freq=100000)
try: i2c.writeto(0, b"\x00")   # wake pulse: the ATECC sleeps and ignores its address until woken
except OSError: pass
time.sleep_ms(2); print([hex(a) for a in i2c.scan()])'
```

Expect `['0x60']`. Nothing means a wire is off or SDA/SCL are swapped. Swap-safe: swapping SDA/SCL
does not hurt anything, just fix it.

## Ways that avoid the Pico's solder blobs

1. **No solder, tonight:** push a 30 AWG solid wire into the LCD board's female header socket beside
   the Pico pin (GP4, GP5, 3V3, GND). The spring contact grips both. Bench-grade.
2. **No solder:** micro test hook clips on the pin stubs in the gap between Pico and LCD board.
3. **Easiest solder, nothing to unplug:** the female header's through-hole joints on the screen side
   of the LCD board. GP4, GP5, 3V3, GND are unused by the LCD, so those joints are free. Unplug power,
   keep the iron away from the screen flex cable.
4. **No solder, needs a part:** Pimoroni Pico Omnibus or Decker. Pico in one slot, LCD board in
   another via a male-to-male header strip, jumpers to the ATECC from a free slot.

Find the right header joint with a multimeter on continuity from the Pico's labeled pin on its
outer face. The four pins are within the first eight positions from the USB end.
