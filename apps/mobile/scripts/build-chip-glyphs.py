"""Builds assets/fonts/MilagreChipGlyphs.ttf: the composer's chip icons as font glyphs.

The phone composer is a native text field that can only style its own characters, so a mention token draws its icon
through its first character: `[` of `[Image #1]` is the image icon, `/` of a skill the wand, `@` of a file the file
icon, and `]` draws nothing. The icons are desktop's Hugeicons (core-free-icons), strokes turned into fills.

    python3 -m venv /tmp/glyphs && /tmp/glyphs/bin/pip install fonttools picosvg
    node scripts/chip-glyph-svgs.cjs | /tmp/glyphs/bin/python -I scripts/build-chip-glyphs.py assets/fonts/MilagreChipGlyphs.ttf
"""

import json
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from picosvg.svg import SVG

UPM = 1000
# The 24-unit icon box drawn 0.9em tall, centred a little above the baseline like desktop's 0.95em chip icon.
SIZE = 900
ADVANCE = 1080
BOTTOM = -130

svgs = json.load(sys.stdin)
glyphs = {".notdef": None, "space": None, "bracketright": None}
cmap = {0x20: "space", 0x5D: "bracketright"}
for char, svg in svgs.items():
    name = {"[": "bracketleft", "/": "slash", "@": "at"}[char]
    cmap[ord(char)] = name
    glyphs[name] = SVG.fromstring(svg).topicosvg()

order = list(glyphs)
built = {}
metrics = {}
for name, svg in glyphs.items():
    pen = TTGlyphPen(None)
    if svg is not None:
        scale = SIZE / 24
        # SVG y runs down; font y runs up.
        flipped = TransformPen(pen, (scale, 0, 0, -scale, (ADVANCE - SIZE) / 2, BOTTOM + SIZE))
        for shape in svg.shapes():
            parse_path(shape.as_path().d, flipped)
    built[name] = pen.glyph()
    metrics[name] = (ADVANCE if svg is not None else 250 if name == "space" else 0, 0)

fb = FontBuilder(UPM, isTTF=True)
fb.setupGlyphOrder(order)
fb.setupCharacterMap(cmap)
fb.setupGlyf(built)
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=900, descent=-250)
fb.setupNameTable({"familyName": "MilagreChipGlyphs", "styleName": "Regular", "fullName": "MilagreChipGlyphs", "psName": "MilagreChipGlyphs"})
fb.setupOS2(sTypoAscender=900, sTypoDescender=-250, usWinAscent=900, usWinDescent=250)
fb.setupPost()
fb.save(sys.argv[1])
