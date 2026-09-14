# Next: printed buttons and a joystick hat

Goal: no bare board parts showing. Four colored caps and a joystick dome, loose parts trapped
under the lid, pressing the board's own switches. Nothing glued to the board.

Why it works: a cap is a top + a flange wider than the lid hole + a post that lands on the switch.
The flange bottoms on the lid just after the click, so the switch can't be crushed. The joystick
dome press-fits the stem and its flange sits under a slightly larger hole so it can tilt 0.4 mm.

Prior art we copy from (details in README.md): SeedSigner Open Pill Mini caps and thumbstick (MIT,
copies in `reference/seedsigner/`), revetuzo's 2.05 mm socket sticks, ALPS SKQU datasheet.

Plan:
1. Calipers on the assembled stack (list in README.md, "Numbers we need").
2. `case/gen.py` (CadQuery): lid with holes + skirts, 4 caps, joystick dome, all parametric.
3. Print caps first, alone, in two clearances (+0.20 / +0.30 mm). Pick the one that drops in and
   doesn't rock. Same for the dome socket (+0.05 / +0.10 mm).
4. Print the lid, assemble, click test, adjust flange-to-plunger gap.
5. Then the full v1 case: pocket for ATECC + battery, USB slot, lanyard hole.

Numbers to bring back from the calipers:
- tact plunger diameter and height above the LCD PCB
- joystick stem width, stem height above its housing, housing height above the PCB
- PCB top to screen glass top
- centers of joystick and 4 buttons from the PCB corner at the USB end
- v0 lid thickness at the button slot

## Finding (2026-09-05, v0 case): no room for a flange

The lid's 4.5 mm slot is the switch body width: the switch bodies sit inside the lid plate and
the plungers end up flush with the lid face (they clear it by ~0.25 mm). So nothing can hang
under this lid. Two paths:

- **v0 case, now:** press-fit keycaps. 4.2 x 4.42 x 2.35 mm, a 1.95 or 2.05 mm pocket over the
  2.04 mm plunger, slot walls guide them, glue dot if loose. Print inbox drop
  `20260905-210730-v0_keycaps_test_plate` (8 caps, both pocket sizes, plus a joystick dome).
- **v1 case:** raise the lid 2 to 3 mm above the switch bodies and use the floating flanged caps
  (`v1_floating_caps_*` from gen.py). Same for the joystick: a flange under a round hole so it can
  tilt. That is the case we design ourselves anyway (battery, ATECC pocket).

Still wanted: joystick stem width and height above the lid face (was 4.18 the stem height?).

## Correction (2026-09-05, later): the lip goes BESIDE the switch, not over it

The first test plate (press-fit keycaps) was the wrong answer. What Austin asked for and what
works: widen the lid's button slot, and make caps that go in from inside with a lip.

- `tools/lid` cuts the v0 lid: button slot 4.5 → 7.7 mm wide, joystick diamond → 8.6 mm round.
  Output `case/out/v0_lid_wide_slot.stl`. The base half is unchanged.
- `gen.py straddle_cap()`: 7.3 mm across in the 7.7 slot, side walls go down past the switch body
  (cavity 5.3 mm, open at both ends because the buttons are only 5.17 mm apart), a 9.1 mm lip
  under the lid plate at 2.3–3.1 mm below the face, ceiling rides on the plunger. Top stands
  1.4 mm proud. Four of them, one plate.
- `gen.py grip_dome()`: the joystick's metal housing pokes through the lid, so a flange under the
  lid would need a 13 mm hole. Instead a deep 3.8 mm square socket with crush ribs so it stays on.
- Print drop: `20260905-*-picowallet-lid-and-floating-caps` (lid + 4 caps + dome).

Assumed, not measured: PCB 3.8 mm below the lid face (a 4.5 mm switch is 3.8 tall and the plunger
sits flush). If the lip touches the board, trim `LIP_T` or measure `PCB_BELOW_LID`.

## v06 (2026-09-06): measured, the v05 cap failed on travel

Test of v05 (green print): caps fit the slot and sat 0.2 mm proud, but would not click. The lip
bottomed on the PCB after 0.1 mm; the switch needs 0.25. The joystick dome did not go on: its
socket was 2.15 mm and 3.8 deep, but the stem has a 3 mm collar at its base.

Calipers (Austin), all above the LCD PCB top:

| part | mm |
|---|---|
| tact switch body top | 2.1 |
| plunger top | 3.0 |
| joystick housing, square, chamfered corners | 7.3 wide, top at 2.04 |
| joystick stem | 1.87 square, top at 5.1 (3.05 above the housing) |
| stem collar at the base | 3.0 dia, about 1 mm tall |
| lid outer face (from the 0.2 mm proud v05 cap) | 4.4 |

So the switch body is below the lid underside (2.4): a cap does not need to straddle it. v06:

- Lid (`tools/lid`, `case/out/v06_lid.stl`): fill the old slot and diamond, then four holes
  7.7 x 4.3 at 5.17 pitch with 0.87 mm bars between, a 1.0 mm pocket on the underside around
  them (9.2 x 21.6, out to the case wall), an 8.6 round joystick hole with an 11 mm pocket
  clipped 2 mm short of the screen window.
- Cap (`gen.py v6_cap`, `v06_caps_x4.stl`): 7.3 x 3.9 body, lip all round (8.5 x 4.9, 0.5
  thick), bottom at 2.4, top at 5.4 (1.0 proud), a 2.35 pocket sits on the plunger. Floats 0.5
  under the pocket ceiling, 0.3 of travel before the cap bottom lands on the switch body.
- Hat (`gen.py v6_hat`, `v06_joystick_hat.stl`): 8.0 body in the 8.6 hole, 10 mm flange with a
  D-flat toward the screen, rests on the housing top and rocks there, caught under the pocket.
  3.6 bore for the collar, 2.05 square socket above it.
- Round caps do not fit: 5.17 pitch. Pill shape stays.
- Print drop `20260906-154129-v06_lid_caps_hat_plate` (lid + 4 caps + hat, 0.12 mm PLA).

If the caps sit pressed (no float): the PCB is closer than 4.4; deepen the pocket in `tools/lid`.
If they stand more than ~1.3 proud: the PCB is further; nothing breaks, shorten `V6_CAP_TOP`.

## v06b (2026-09-06, later): oval pocket, floating hat

v06 test: lid and caps fit, caps click. Two fixes, caps and hat only (the v06 lid stays):
- The plunger is an oval, 2.94 x 2.04 (calipers), long side across the row. The cap pocket is
  now that shape plus 0.2, so the cap sits snug on it.
- The hat rested on the joystick housing, so pressing it pushed the housing and nothing moved.
  Now it hangs on the stem tip; the 0.45 flange floats at 2.5, 0.46 above the housing and 0.45
  under the pocket ceiling. Tilt and push both have room.
- Print drop `20260906-162736-v06b_caps_hat_plate` (`gen.py v06b`).

## v06c (2026-09-06, evening): the lid would not snap onto the base

The green v06 lid left a 2 mm gap on the white base and a mallet did not close it. Not the caps:
the lid file differs from the original only in the plate. The original snap has zero clearance
along the long side (base tabs 53.0 in a 53.0 opening), so two halves from one print in one
material fit, and a lid printed later in another material and layer height does not.
`tools/lid` now opens the cavity 0.2 per side in x and 0.1 in y, keeping the catch groove.
Drop `20260906-170424-v06_lid`, lid only, asked for white PETG to match the base.

## v06d (2026-09-06, night): the button pitch was wrong

With the v06 lid on and no caps, the case closes. With caps in, it will not: the caps sat on the
switch bodies instead of the plungers and held the board 2 mm off the lid. Photos of the lid on
the board show the plungers drifting across the four holes. Measured from three photos (ratio of
plunger spacing to hole spacing, so camera scale cancels): pitch 5.58 mm, and the row centre
sits 0.3 mm toward -y of the case centreline. The 5.17 pitch used since 2026-09-05 was a guess
from the slot length, never measured.

- `tools/lid`: PITCH 5.58, BTN_Y 32.2, holes 7.7 x 4.8 (0.35 clearance along), pocket 22.8 long.
- `gen.py`: cap 7.3 x 4.1, lip 8.5 x 5.3 (0.28 between neighbours).
- Print drop `20260906-171138-v06d_lid_caps_plate`, lid + 4 caps, white PETG. Supersedes
  `20260906-170424-v06_lid` (told the printer not to print it). The v06b hat is unchanged.

## Stopped (2026-09-06, night)

Austin stopped the cap work. v06d never printed. The joystick's push-down stopped working after
the hat tests. The wallet goes back into the original white v0 case, bare buttons and joystick.
The measurements above are the useful part if anyone picks this up again.
