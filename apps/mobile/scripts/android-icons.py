"""Android icon layers from assets/icon.png: adaptive foreground, background and monochrome, and the notification icon.

Run from apps/mobile: uv run --with pillow --with numpy python scripts/android-icons.py assets/icon.png assets/android
An optional third argument writes a preview (circle mask, rounded mask, notification icon on a dark bar).
"""
import sys
from PIL import Image, ImageFilter, ImageDraw
import numpy as np

src, out = sys.argv[1], sys.argv[2]
im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
mn = im.min(axis=2)
# The mark is near-white; the glow and the field are blue with a low red channel.
alpha = np.clip((mn - 70) / (225 - 70), 0, 1)
mask = Image.fromarray((alpha * 255).astype(np.uint8))
bbox = mask.point(lambda v: 255 if v > 128 else 0).getbbox()
mark = mask.crop(bbox)

def place(size, frac, img):
    w, h = img.size
    s = frac * size / max(w, h)
    img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    canvas = Image.new("L", (size, size), 0)
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas

size = 1024
# Adaptive foreground: the white mark with a blue glow, inside the 66% safe zone.
a = place(size, 0.44, mark)
g = a.filter(ImageFilter.GaussianBlur(22))
glow_rgb = (40, 110, 255)
fg = Image.new("RGBA", (size, size), glow_rgb + (0,))
glow_layer = Image.new("RGBA", (size, size), glow_rgb + (0,))
glow_layer.putalpha(g.point(lambda v: min(255, int(v * 1.6))))
white = Image.new("RGBA", (size, size), (246, 249, 255, 0))
white.putalpha(a)
fg = Image.alpha_composite(glow_layer, white)
fg.save(f"{out}/adaptive-foreground.png")

# Adaptive background: the icon's navy field as a soft radial gradient.
yy, xx = np.mgrid[0:size, 0:size]
d = np.sqrt(((xx - size * 0.45) ** 2 + (yy - size * 0.4) ** 2)) / (size * 0.75)
d = np.clip(d, 0, 1)[..., None]
inner = np.array([12, 52, 140], np.float32)
outer = np.array([4, 22, 72], np.float32)
bg = (inner * (1 - d) + outer * d).astype(np.uint8)
Image.fromarray(bg, "RGB").save(f"{out}/adaptive-background.png")

# Monochrome (Android 13 themed icons): the mark alone, as alpha.
mono = Image.new("RGBA", (size, size), (255, 255, 255, 0))
mono.putalpha(place(size, 0.44, mark))
mono.save(f"{out}/adaptive-monochrome.png")

# Notification (status bar) icon: white on transparent, 96 px, small margin.
n = Image.new("RGBA", (96, 96), (255, 255, 255, 0))
n.putalpha(place(96, 0.84, mark))
n.save(f"{out}/notification-icon.png")

# Preview: circle, squircle and a status-bar size.
prev = Image.new("RGB", (3 * 300 + 40, 300), (230, 230, 235))
full = Image.alpha_composite(Image.open(f"{out}/adaptive-background.png").convert("RGBA"), fg).resize((260, 260), Image.LANCZOS)
for i, shape in enumerate(["circle", "rounded"]):
    m = Image.new("L", (260, 260), 0)
    dr = ImageDraw.Draw(m)
    # Launchers show the inner 72/108 of the layer.
    crop = full.crop((0, 0, 260, 260))
    if shape == "circle":
        dr.ellipse((0, 0, 259, 259), fill=255)
    else:
        dr.rounded_rectangle((0, 0, 259, 259), radius=70, fill=255)
    inner_view = full.resize((390, 390), Image.LANCZOS).crop((65, 65, 325, 325))
    prev.paste(inner_view, (20 + i * 300, 20), m)
bar = Image.new("RGB", (260, 260), (20, 20, 24))
ni = Image.open(f"{out}/notification-icon.png").resize((72, 72), Image.LANCZOS)
bar.paste(ni, (94, 94), ni)
prev.paste(bar, (20 + 2 * 300, 20))
if len(sys.argv) > 3:
    prev.save(sys.argv[3])
