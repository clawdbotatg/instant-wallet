"""picowallet case parts, parametric. Run: uv run --python 3.11 --with cadquery python case/gen.py

v1: loose caps for the four A/B/X/Y tact switches and a joystick dome, sized for the v0 lid
(Tomáš Plass): 2.0 mm plate, one 4.5 x 21 mm slot for the buttons, 7.1 mm rotated-square hole for
the joystick. Caps drop into the slot from inside the lid; a flange wider than the slot keeps them
in; a pocket on the underside slips over the switch plunger.

All dimensions mm. Names ending in _GUESS are placeholders until measured (see BUTTONS.md).
"""
import cadquery as cq

# --- measured / from the v0 lid STL ---------------------------------------------------------
LID_T = 2.0            # lid plate thickness
SLOT_W = 4.5           # button slot width (across)
PITCH = 5.17           # button center to center
SWITCH_BODY = 4.5      # tact switch body, square
PLUNGER_D = 2.04       # round plunger diameter (Austin's 2.04 reading, to confirm)

# --- to confirm with the depth rod ------------------------------------------------------------
PLUNGER_BELOW_LID_GUESS = 0.6   # lid outer face down to plunger top
SWITCH_TOP_BELOW_LID_GUESS = 3.0  # lid outer face down to the switch body top (flange lives here). If this is under 2.7 there is no room for a flange and the caps become press-fit keycaps instead.
STEM_W_GUESS = 2.0              # joystick stem across flats (square)
STEM_ABOVE_LID_GUESS = 1.5      # stem top above the lid outer face

# --- design choices ---------------------------------------------------------------------------
CLEAR = 0.15           # radial clearance cap body to slot wall
CAP_ACROSS = SLOT_W - 2 * CLEAR          # 4.2
CAP_ALONG = PITCH - 0.75                 # 4.42, leaves 0.75 between neighbours
CAP_PROUD = 1.2        # how far the cap top stands above the lid face
FLANGE_OUT = 1.0       # flange beyond the body on each side, across only (along has no room)
REST_GAP = 0.3         # flange top to lid underside at rest, = click travel before it bottoms
TOP_R = 0.6            # edge round on the cap top


def cap(clear=CLEAR, plunger_below=PLUNGER_BELOW_LID_GUESS, switch_top_below=SWITCH_TOP_BELOW_LID_GUESS, verbose=False):
    """Vertical frame: z = 0 at the lid OUTER face, up is +. Lid underside at -LID_T, plunger top at
    -plunger_below, switch body top at -switch_top_below. Returned part is shifted so its lowest
    point is z = 0 (print flange down)."""
    across = SLOT_W - 2 * clear
    top_z = CAP_PROUD
    flange_top = -LID_T - REST_GAP
    flange_bot = max(-switch_top_below + 0.1, flange_top - 1.0)     # never touch the switch body
    flange_t = flange_top - flange_bot
    assert flange_t >= 0.4, "no room for a flange under the lid: measure again or thin the lid"
    body = cq.Workplane("XY").box(across, CAP_ALONG, top_z - flange_top, centered=(True, True, False)).translate((0, 0, flange_top))
    body = body.edges(">Z").fillet(TOP_R)
    flange = cq.Workplane("XY").box(across + 2 * FLANGE_OUT, CAP_ALONG, flange_t, centered=(True, True, False)).translate((0, 0, flange_bot))
    part = body.union(flange)
    plunger_top = -plunger_below
    if plunger_top > flange_bot + 0.2:
        # plunger reaches up into the cap: pocket from the bottom up to the plunger top
        pocket_d = PLUNGER_D + 0.25
        depth = plunger_top - flange_bot
        part = part.cut(cq.Workplane("XY").circle(pocket_d / 2).extrude(depth + 0.01).translate((0, 0, flange_bot - 0.01)))
        mode = "pocket %.2f deep" % depth
        low = flange_bot
    else:
        # cap bottom is above the plunger: a post reaches down to it
        post_h = flange_bot - plunger_top
        part = part.union(cq.Workplane("XY").circle((PLUNGER_D + 0.6) / 2).extrude(post_h + 0.01).translate((0, 0, plunger_top)))
        mode = "post %.2f long" % post_h
        low = plunger_top
    if verbose:
        print("cap: across %.2f along %.2f, proud %.2f, flange %.2f thick at %.2f..%.2f below lid face, %s, total %.2f" % (
            across, CAP_ALONG, CAP_PROUD, flange_t, -flange_top, -flange_bot, mode, top_z - low))
    return part.translate((0, 0, -low))


def keycap(pocket_d=1.95, proud=1.5, plunger_below=0.25, skirt=0.6):
    """For the v0 lid, where the plungers sit flush with the lid face and the switch bodies are
    inside the slot: no room for a flange, so the cap press-fits onto the 2.04 mm plunger and the
    slot walls guide it. A dot of glue if the fit is loose. Print pocket-side down."""
    across = SLOT_W - 2 * CLEAR
    h = proud + plunger_below + skirt
    part = cq.Workplane("XY").box(across, CAP_ALONG, h, centered=(True, True, False))
    part = part.edges(">Z").fillet(TOP_R)
    part = part.cut(cq.Workplane("XY").circle(pocket_d / 2).extrude(plunger_below + skirt + 0.2 - 0.0).translate((0, 0, -0.01)))
    return part


def joystick_dome(stem_w=STEM_W_GUESS, stem_above=STEM_ABOVE_LID_GUESS, hole_d=9.0):
    """Dome that press-fits the stem. Flange under a round hole so it can tilt. Print in TPU or PLA."""
    dome_d = 9.5
    h = stem_above + 2.5
    dome = cq.Workplane("XY").circle(dome_d / 2).extrude(h).faces(">Z").edges().fillet(2.0)
    part = dome
    if hole_d:
        flange = cq.Workplane("XY").circle(hole_d / 2 + 1.2).extrude(0.8).translate((0, 0, -0.8))
        part = dome.union(flange)
    socket = cq.Workplane("XY").rect(stem_w + 0.08, stem_w + 0.08).extrude(stem_above + 1.2).translate((0, 0, -0.81))
    return part.cut(socket)


def export(shape, name):
    cq.exporters.export(shape, f"case/out/{name}.stl")
    bb = shape.val().BoundingBox()
    print(f"{name}.stl  {bb.xlen:.2f} x {bb.ylen:.2f} x {bb.zlen:.2f} mm")


if __name__ == "__main__" and not __import__("sys").argv[1:]:
    # caps in two clearances, four of each on one plate, flange down (top face up: print it upside
    # down? no: flange is wider than the body, so print flange DOWN, top up; bridge-free)
    # v0 lid: press-fit keycaps, two pocket sizes (PLA holes print small; try both)
    for pocket in (1.95, 2.05):
        parts = None
        for i in range(4):
            c = keycap(pocket_d=pocket).translate((i * 8.0, 0, 0))
            parts = c if parts is None else parts.union(c)
        export(parts, f"keycaps_x4_pocket{pocket:.2f}")
    # v1 lid (raised): floating caps with a flange. Needs SWITCH_TOP_BELOW_LID measured on the v1 lid.
    cap(verbose=True)
    for clear in (0.15, 0.25):
        parts = None
        for i in range(4):
            c = cap(clear=clear).translate((i * 8.0, 0, 0))
            parts = c if parts is None else parts.union(c)
        export(parts, f"v1_floating_caps_x4_clear{clear:.2f}")
    export(joystick_dome(hole_d=0), "joystick_dome")


# ============================================================================================
# v0.5: the v0 lid with a WIDER button slot (case/out/v0_lid_wide_slot.stl, cut by tools/lid)
# and caps that straddle each switch: side walls go down past the switch body through the slot,
# a lip under the lid plate keeps the cap in, the ceiling rides on the plunger.
#   z = 0 at the lid outer face, up is +. Lid plate 0..-2.0. Plunger top ≈ -0.25 (flush).
# ============================================================================================
WIDE_SLOT_W = 7.7           # what tools/lid cut
STRADDLE_CLEAR = 0.2        # cap body to slot wall, per side
SWITCH_CLEAR = 0.4          # cavity to switch body, per side
CAP_WALL = 1.0
LIP_OUT = 0.9               # lip beyond the body, per side (across only)
LIP_T = 0.8
LIP_GAP = 0.3               # lip top below the lid underside at rest (= float)
PCB_BELOW_LID_GUESS = 3.8   # lid face down to the LCD PCB (4.5 mm switch is 3.8 tall, plunger flush)


def straddle_cap(proud=1.4, plunger_below=0.25, pcb_below=PCB_BELOW_LID_GUESS):
    body_w = WIDE_SLOT_W - 2 * STRADDLE_CLEAR            # 7.3 across
    cavity_w = SWITCH_BODY + 2 * SWITCH_CLEAR             # 5.3 across, open at both ends along
    assert (body_w - cavity_w) / 2 >= 0.8, "walls too thin"
    top_z = proud
    ceiling_bot = -plunger_below + 0.05                   # ceiling underside just above the plunger
    lip_top = -LID_T - LIP_GAP                            # -2.3
    lip_bot = lip_top - LIP_T                             # -3.1
    assert lip_bot > -pcb_below + 0.3, "lip would hit the PCB: measure PCB_BELOW_LID"
    body = cq.Workplane("XY").box(body_w, CAP_ALONG, top_z - lip_bot, centered=(True, True, False)).translate((0, 0, lip_bot))
    body = body.edges(">Z").fillet(TOP_R)
    lip = cq.Workplane("XY").box(body_w + 2 * LIP_OUT, CAP_ALONG, LIP_T, centered=(True, True, False)).translate((0, 0, lip_bot))
    part = body.union(lip)
    cavity = cq.Workplane("XY").box(cavity_w, CAP_ALONG + 2, ceiling_bot - lip_bot + 0.01, centered=(True, True, False)).translate((0, 0, lip_bot - 0.01))
    part = part.cut(cavity)
    print("straddle cap: %.1f x %.2f across/along, %.1f tall, walls %.2f, lip %.1f wide from %.1f to %.1f below the face" % (
        body_w, CAP_ALONG, top_z - lip_bot, (body_w - cavity_w) / 2, body_w + 2 * LIP_OUT, -lip_top, -lip_bot))
    return part.translate((0, 0, -lip_bot))


JOY_HOLE_D = 8.6            # what tools/lid cut (round, replaces the diamond)
STEM_ABOVE_LID = 4.2        # Austin's 4.18 reading, stem top above the lid face


def grip_dome(stem_w=2.0, stem_above=STEM_ABOVE_LID):
    """Dome that grips the stem: a deep square socket at the stem's own width with four crush
    ribs, so it stays on without glue. The joystick's own metal housing pokes through the lid, so
    a flange under the lid would need a much bigger hole; this is the no-flange version.
    PLA works; TPU is better."""
    socket_depth = stem_above - 0.4                        # stop 0.4 above the housing
    dome_d = 9.0
    h = stem_above + 1.6
    dome = cq.Workplane("XY").circle(dome_d / 2).extrude(h).faces(">Z").edges().fillet(2.6)
    socket = cq.Workplane("XY").rect(stem_w + 0.15, stem_w + 0.15).extrude(socket_depth).translate((0, 0, -0.01))
    part = dome.cut(socket)
    # crush ribs: four 0.25 mm ridges down the socket faces, they deform on the first press-on
    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        rib = cq.Workplane("XY").rect(0.5, 0.5).extrude(socket_depth).translate((dx * (stem_w / 2 + 0.05), dy * (stem_w / 2 + 0.05), -0.01))
        part = part.union(rib.intersect(cq.Workplane("XY").rect(stem_w + 0.15, stem_w + 0.15).extrude(socket_depth).translate((0, 0, -0.01))))
    print("grip dome: %.1f dia x %.1f tall, socket %.2f square %.1f deep with ribs" % (dome_d, h, stem_w + 0.15, socket_depth))
    return part


def build_v05():
    caps = None
    for i in range(4):
        c = straddle_cap().translate((i * 11.0, 0, 0))
        caps = c if caps is None else caps.union(c)
    export(caps, "v05_straddle_caps_x4")
    export(grip_dome(), "v05_joystick_dome_grip")


if __name__ == "__main__" and __import__("sys").argv[1:] == ["v05"]:
    build_v05()


# ============================================================================================
# v0.6 (2026-09-06): measured. Frame here is the PCB: z = 0 at the LCD PCB top, up is +.
#   plunger top 3.0, switch body top 2.1, joystick housing 7.3 sq / top 2.04, stem 1.87 sq to
#   5.1 with a 3.0 dia collar at its base. Lid outer face 4.4 above the PCB (cap stood 0.2 proud
#   with the v05 lid), lid plate 2.0, underside 2.4. tools/lid pockets the underside 1.0 mm at
#   the buttons and the joystick, so the plate there is 1.0 thick and its underside sits at 3.4.
# The v05 cap failed because its lip bottomed on the PCB after 0.1 mm of travel. The switch
# body top (2.1) is below the lid underside, so a cap no longer straddles it: a short block on
# the plunger with a lip on all four sides, caught in the pocket. One lid hole per cap.
# ============================================================================================
PCB_TO_LID_FACE = 4.4
V6_PLUNGER_TOP = 3.0
V6_BODY_TOP = 2.1
V6_POCKET_CEIL = 3.4          # lid underside inside the 1.0 mm pocket
V6_PITCH = 5.58                            # measured from photos on 2026-09-06 (5.17 was a guess and put the outer caps on the switch bodies)
V6_HOLE_ACROSS, V6_HOLE_ALONG = 7.7, 4.8   # per-cap lid hole (across the row, along the row)
V6_CAP_ACROSS, V6_CAP_ALONG = 7.3, 4.1     # 0.2 clear across, 0.35 along
V6_LIP_ACROSS, V6_LIP_ALONG = 0.6, 0.6     # lip beyond the body; 0.6 across because the wall is 0.4 from the slot; 0.28 left between neighbours along
V6_LIP_T = 0.5
V6_CAP_BOTTOM = 2.4          # 0.3 above the switch body; full press (0.3) lands on it = stop
V6_CAP_TOP = PCB_TO_LID_FACE + 1.0
V6_PLUNGER_L, V6_PLUNGER_W = 2.94, 2.04  # oval plunger, calipers, long side across the row
V6_PLUNGER_CLEAR = 0.2                    # total, snug; PLA holes print small


def v6_cap():
    lip_top = V6_CAP_BOTTOM + V6_LIP_T                     # 2.9, floats 0.5 under the pocket ceiling
    assert lip_top + 0.15 < V6_POCKET_CEIL
    lip = (cq.Workplane("XY").rect(V6_CAP_ACROSS + 2 * V6_LIP_ACROSS, V6_CAP_ALONG + 2 * V6_LIP_ALONG)
           .extrude(V6_LIP_T).edges("|Z").fillet(0.6).translate((0, 0, V6_CAP_BOTTOM)))
    body = (cq.Workplane("XY").rect(V6_CAP_ACROSS, V6_CAP_ALONG).extrude(V6_CAP_TOP - V6_CAP_BOTTOM)
            .edges("|Z").fillet(0.8).translate((0, 0, V6_CAP_BOTTOM)))
    body = body.edges(">Z").fillet(0.6)
    part = body.union(lip)
    pocket = (cq.Workplane("XY").slot2D(V6_PLUNGER_L + V6_PLUNGER_CLEAR, V6_PLUNGER_W + V6_PLUNGER_CLEAR, 0)
              .extrude(V6_PLUNGER_TOP - V6_CAP_BOTTOM + 0.01).translate((0, 0, V6_CAP_BOTTOM - 0.01)))
    part = part.cut(pocket)
    print("v6 cap: %.1f x %.1f body, lip %.1f x %.1f, bottom %.1f, top %.1f (%.1f proud), oval pocket %.2f x %.2f, %.1f deep" % (
        V6_CAP_ACROSS, V6_CAP_ALONG, V6_CAP_ACROSS + 2 * V6_LIP_ACROSS, V6_CAP_ALONG + 2 * V6_LIP_ALONG,
        V6_CAP_BOTTOM, V6_CAP_TOP, V6_CAP_TOP - PCB_TO_LID_FACE, V6_PLUNGER_L + V6_PLUNGER_CLEAR, V6_PLUNGER_W + V6_PLUNGER_CLEAR, V6_PLUNGER_TOP - V6_CAP_BOTTOM))
    return part.translate((0, 0, -V6_CAP_BOTTOM))         # print lip down


V6_JOY_HOLE_D = 8.6           # lid hole (tools/lid fills the diamond first, then bores this)
V6_HAT_D = 8.0                # hat body, 0.3 clear per side for tilt
V6_HAT_FLANGE_D = 10.0        # rests on the housing top (2.04) around the collar, rocks there
V6_HAT_FLANGE_FLAT = 4.0      # D-flat on the screen side: the window edge is 6.75 from center
V6_HAT_FLANGE_T = 0.45
V6_HAT_FLANGE_Z = 2.5         # flange underside: 0.46 above the housing top, flange top 0.45 under the pocket ceiling (v06 rested ON the housing, so nothing moved)
V6_HAT_TOP = 6.4              # 2.0 above the lid face
V6_STEM_W = 1.87
V6_COLLAR_D = 3.0
V6_HOUSING_TOP = 2.04
V6_STEM_TOP = 5.1


def v6_hat():
    z0 = V6_HAT_FLANGE_Z                                   # the hat hangs on the stem tip; flange floats
    # the intersect box is centered on x=0 and 8 wide: flange runs -5..+4, flat on +x (toward the screen)
    flange = (cq.Workplane("XY").circle(V6_HAT_FLANGE_D / 2).extrude(V6_HAT_FLANGE_T)
              .intersect(cq.Workplane("XY").box(V6_HAT_FLANGE_D, V6_HAT_FLANGE_D + 2, V6_HAT_FLANGE_T, centered=(True, True, False)).translate((V6_HAT_FLANGE_FLAT - V6_HAT_FLANGE_D / 2, 0, 0)))
              .translate((0, 0, z0)))
    body = cq.Workplane("XY").circle(V6_HAT_D / 2).extrude(V6_HAT_TOP - z0).translate((0, 0, z0))
    body = body.faces(">Z").edges().fillet(2.4)
    part = body.union(flange)
    collar_bore_top = V6_HOUSING_TOP + 1.45                # collar is ~1 mm tall; leave room
    bore = cq.Workplane("XY").circle((V6_COLLAR_D + 0.6) / 2).extrude(collar_bore_top - z0 + 0.01).translate((0, 0, z0 - 0.01))
    socket_top = V6_STEM_TOP + 0.03                        # socket floor sits on the stem tip
    socket = cq.Workplane("XY").rect(V6_STEM_W + 0.18, V6_STEM_W + 0.18).extrude(socket_top - collar_bore_top + 0.01).translate((0, 0, collar_bore_top - 0.01))
    part = part.cut(bore).cut(socket)
    print("v6 hat: body %.1f dia in a %.1f hole, flange %.1f dia (flat at %.1f) %.1f thick from %.2f, top %.1f (%.1f proud), socket %.2f sq %.1f deep, collar bore %.1f dia to %.2f" % (
        V6_HAT_D, V6_JOY_HOLE_D, V6_HAT_FLANGE_D, V6_HAT_FLANGE_FLAT, V6_HAT_FLANGE_T, z0, V6_HAT_TOP, V6_HAT_TOP - PCB_TO_LID_FACE,
        V6_STEM_W + 0.18, socket_top - collar_bore_top, V6_COLLAR_D + 0.6, collar_bore_top))
    return part.translate((0, 0, -z0))                     # print flange down


def build_v06(plate=False):
    caps = None
    for i in range(4):
        c = v6_cap().translate((i * 11.0, 0, 0))
        caps = c if caps is None else caps.union(c)
    export(caps, "v06_caps_x4")
    hat = v6_hat(); export(hat, "v06_joystick_hat")
    if plate:
        export(caps.union(hat.translate((-8, 0, 0))), "v06b_caps_hat_plate")
    return caps


if __name__ == "__main__" and __import__("sys").argv[1:] in (["v06"], ["v06b"]):
    build_v06(plate=__import__("sys").argv[1] == "v06b")
