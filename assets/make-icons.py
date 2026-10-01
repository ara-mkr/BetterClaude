#!/usr/bin/env python3
"""
Builds every BetterClaude icon from the two brand sources in assets/brand/:

  app-glass.png    the liquid-glass app icon (rounded glass tile, white mark)
  mark-white.png   the white mark alone on transparency

Outputs
  assets/app-icon.png, assets/icon.png, build/icon.png   1024 app icon
  build/icon.icns (macOS, via iconutil), build/icon.ico (Windows)
  assets/tray-icon.png / tray-icon@2x.png                 menu-bar glyph

The app icon follows Apple's macOS grid: the tile's visible body is scaled to
824 px and centred on a transparent 1024 canvas, so it sits at the same size
as every other Dock icon. The glass curves and shading are the source's own.

The menu-bar glyph keeps only the white strokes of the mark (the source's dark
counter fills are dropped) and is saved as a black-on-alpha *template* image:
macOS draws it white on a dark or tinted menu bar and dark on a light one, with
no background — see buildTray() in electron/main.js.

Run:  python3 assets/make-icons.py      (needs Pillow; iconutil on macOS)
"""

import os
import shutil
import subprocess
import tempfile

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BRAND = os.path.join(HERE, "brand")
BUILD = os.path.join(ROOT, "build")

CANVAS = 1024
BODY = 824  # Apple macOS icon grid: 100 px margin each side


def app_icon() -> Image.Image:
    src = Image.open(os.path.join(BRAND, "app-glass.png")).convert("RGBA")
    # Crop to the solid tile (ignore the faint outer glow when measuring).
    solid = src.getchannel("A").point(lambda v: 255 if v > 200 else 0)
    x0, y0, x1, y1 = solid.getbbox()
    pad = round((x1 - x0) * 0.006)  # keep the soft edge of the glass
    tile = src.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    size = round(BODY * tile.width / (x1 - x0))
    tile = tile.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    out.alpha_composite(tile, ((CANVAS - size) // 2, (CANVAS - size) // 2))
    return out


def tray_glyph(px: int) -> Image.Image:
    src = Image.open(os.path.join(BRAND, "mark-white.png")).convert("RGBA")
    r, g, b, a = src.split()
    lum = Image.merge("RGB", (r, g, b)).convert("L")
    # White strokes only: bright AND opaque.
    mask = Image.eval(lum, lambda v: 0 if v < 128 else min(255, (v - 128) * 2))
    mask = Image.composite(mask, Image.new("L", src.size, 0), a.point(lambda v: 255 if v > 128 else 0))
    box = mask.getbbox()
    mask = mask.crop(box)
    # Fit inside px with a 1/11 margin (≈18 px glyph in a 22 pt menu-bar slot).
    inner = px - 2 * round(px / 11)
    scale = inner / max(mask.size)
    w, h = max(1, round(mask.width * scale)), max(1, round(mask.height * scale))
    mask = mask.resize((w, h), Image.LANCZOS)
    alpha = Image.new("L", (px, px), 0)
    alpha.paste(mask, ((px - w) // 2, (px - h) // 2))
    out = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    out.putalpha(alpha)  # black RGB + alpha = template image
    return out


def write_icns(icon: Image.Image, dest: str) -> None:
    if not shutil.which("iconutil"):
        print("  iconutil not found; skipped", dest)
        return
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for base in (16, 32, 128, 256, 512):
            icon.resize((base, base), Image.LANCZOS).save(os.path.join(iconset, f"icon_{base}x{base}.png"))
            icon.resize((base * 2, base * 2), Image.LANCZOS).save(os.path.join(iconset, f"icon_{base}x{base}@2x.png"))
        subprocess.run(["iconutil", "-c", "icns", iconset, "-o", dest], check=True)


def main() -> None:
    icon = app_icon()
    for dest in (os.path.join(HERE, "app-icon.png"), os.path.join(HERE, "icon.png"), os.path.join(BUILD, "icon.png")):
        icon.save(dest)
        print("wrote", os.path.relpath(dest, ROOT))
    write_icns(icon, os.path.join(BUILD, "icon.icns"))
    print("wrote build/icon.icns")
    icon.save(os.path.join(BUILD, "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote build/icon.ico")
    tray_glyph(22).save(os.path.join(HERE, "tray-icon.png"))
    tray_glyph(44).save(os.path.join(HERE, "tray-icon@2x.png"))
    print("wrote assets/tray-icon.png, assets/tray-icon@2x.png")


if __name__ == "__main__":
    main()
