#!/usr/bin/env python3
"""
Generates the macOS menu-bar tray glyph for BetterClaude.

Produces a bold, single-letter "b" mark authored directly at menu-bar
resolution (16x16 and 32x32) -- NOT downscaled from the full logomark.

Output is a pure black-shape + alpha PNG (macOS "template image" rules):
no color, no baked background, no grey anti-aliasing beyond hard-edged
pixel geometry. macOS derives the light/dark menu-bar tint itself.

Run:
    python3 assets/make-tray-glyph.py

Writes:
    assets/tray-icon.png       (16x16, @1x)
    assets/tray-icon@2x.png    (32x32, @2x)
"""

from PIL import Image, ImageDraw
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

BLACK = (0, 0, 0, 255)
CLEAR = (0, 0, 0, 0)


def draw_b(size: int) -> Image.Image:
    """
    Draw a bold lowercase "b" glyph on an SxS transparent canvas.

    All coordinates are computed from integer pixel geometry (not scaled
    from a smaller raster) so stems/bowls land on the pixel grid at every
    target size. Designed for size=16 and size=32.
    """
    img = Image.new("RGBA", (size, size), CLEAR)
    draw = ImageDraw.Draw(img)

    # Scale factor relative to the 16px base design. At 16 this is 1,
    # at 32 this is 2 -- used only to size the stroke weight and margin,
    # every other coordinate is placed explicitly per-size below.
    s = size / 16.0

    if size == 16:
        # --- 16x16 base design -------------------------------------
        # Optical margin: ~1px clear on all sides -> drawable 1..14.
        # Stem: 2px wide vertical bar, full ascender height.
        stem_x0, stem_x1 = 3, 4          # columns 3-4 inclusive (2px wide)
        stem_y0, stem_y1 = 1, 13         # rows 1-13 inclusive (13px tall)
        draw.rectangle([stem_x0, stem_y0, stem_x1, stem_y1], fill=BLACK)

        # Bowl: filled ring (outer circle minus inner circle) sitting
        # in the lower half, overlapping the stem's bottom on its left
        # edge so the two strokes fuse into one shape (matches how a
        # real "b" joins bowl to stem).
        outer_bbox = (4, 6, 13, 13)      # 10x8 -> not circular; adjust below
        # Use a square bounding box for a round bowl.
        outer_bbox = (5, 6, 13, 14)      # 9x9 square -> round bowl, r~4.5
        inner_bbox = (7, 8, 11, 12)      # 5x5 hole -> ring thickness ~2px
        # Bridge: the ellipse only touches column 5 near its vertical middle,
        # so near the top/bottom of the bowl there's a 1px gap between the
        # stem (cols 3-4) and the bowl -- without this the shape reads as
        # two disconnected glyphs ("l" + "o") instead of one "b".
        draw.rectangle([stem_x1, outer_bbox[1], 5, outer_bbox[3]], fill=BLACK)
        draw.ellipse(outer_bbox, fill=BLACK)
        draw.ellipse(inner_bbox, fill=CLEAR)

    elif size == 32:
        # --- 32x32 design, independently authored at 2x scale -------
        # (fractions mirror the 16px design but are placed fresh so the
        # glyph is pixel-aligned at this resolution too, not a naive
        # nearest-neighbor blow-up of the 16px raster.)
        stem_x0, stem_x1 = 6, 9          # 4px wide
        stem_y0, stem_y1 = 2, 27         # 26px tall
        draw.rectangle([stem_x0, stem_y0, stem_x1, stem_y1], fill=BLACK)

        outer_bbox = (10, 13, 27, 30)    # 18x18 round bowl
        inner_bbox = (15, 18, 22, 25)    # 8x8 hole -> ring thickness ~4px
        # Bridge (see 16px design above for why this is needed).
        draw.rectangle([stem_x1, outer_bbox[1], 10, outer_bbox[3]], fill=BLACK)
        draw.ellipse(outer_bbox, fill=BLACK)
        draw.ellipse(inner_bbox, fill=CLEAR)

    else:
        raise ValueError("only 16 and 32 are supported")

    return img


def ascii_dump(img: Image.Image) -> str:
    w, h = img.size
    alpha = img.split()[-1]
    rows = []
    for y in range(h):
        row = []
        for x in range(w):
            row.append("#" if alpha.getpixel((x, y)) > 128 else ".")
        rows.append("".join(row))
    return "\n".join(rows)


def bbox_of_drawn(img: Image.Image):
    return img.getbbox()


def preview(img: Image.Image, path: str, scale: int = 16):
    """Composite over a light swatch and save an upscaled preview."""
    w, h = img.size
    bg = Image.new("RGBA", (w, h), (230, 230, 230, 255))
    bg.alpha_composite(img)
    big = bg.resize((w * scale, h * scale), Image.NEAREST).convert("RGB")
    big.save(path)


def main():
    icon16 = draw_b(16)
    icon32 = draw_b(32)

    icon16.save(os.path.join(OUT_DIR, "tray-icon.png"))
    icon32.save(os.path.join(OUT_DIR, "tray-icon@2x.png"))

    for name, img in (("tray-icon.png (16x16)", icon16), ("tray-icon@2x.png (32x32)", icon32)):
        print(f"\n=== {name} ===")
        print(f"mode={img.mode} size={img.size}")
        corner_alpha = img.getpixel((0, 0))[3]
        print(f"corner alpha (0,0) = {corner_alpha}")
        print(f"drawn bbox = {bbox_of_drawn(img)}")
        print(ascii_dump(img))

    preview(icon16, "/tmp/tray-icon-preview-16.png", scale=16)
    preview(icon32, "/tmp/tray-icon-preview-32.png", scale=16)
    print("\nPreviews written to /tmp/tray-icon-preview-16.png and /tmp/tray-icon-preview-32.png")


if __name__ == "__main__":
    main()
