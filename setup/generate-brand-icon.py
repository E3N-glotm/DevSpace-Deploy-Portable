#!/usr/bin/env python3
"""Rebuild the DevSpace Windows icon assets from one deterministic master.

This script is for maintainers; normal installation and GitHub CI use the
checked-in PNG/ICO files and do not require Pillow on end-user machines.
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "setup" / "assets"
OUTPUT.mkdir(parents=True, exist_ok=True)
EDGE = 1024
SCALE = EDGE / 256


def rect(coords):
    return tuple(round(v * SCALE) for v in coords)


def build():
    image = Image.new("RGBA", (EDGE, EDGE), (0, 0, 0, 0))
    bg = Image.new("RGBA", image.size)
    p = bg.load()
    # Deep-indigo background with a soft cyan light from the upper right.
    for y in range(EDGE):
        for x in range(EDGE):
            u, v = x / EDGE, y / EDGE
            light = max(0.0, 1.0 - ((u - 0.85) ** 2 + (v - 0.08) ** 2) ** 0.5 / 1.05)
            p[x, y] = (
                round(19 + 24 * u + 4 * light),
                round(40 + 38 * u + 32 * light),
                round(78 + 79 * u + 29 * light),
                255,
            )
    mask = Image.new("L", image.size)
    m = ImageDraw.Draw(mask)
    m.rounded_rectangle(rect((9, 9, 247, 247)), radius=round(56 * SCALE), fill=255)
    image.paste(bg, (0, 0), mask)

    # The 16px glyph is an intentionally simple bold D. Do not use a font:
    # glyph metrics/antialiasing vary between Windows installations.
    emblem = Image.new("L", image.size)
    g = ImageDraw.Draw(emblem)
    g.ellipse(rect((75, 66, 191, 191)), fill=255)
    g.rectangle(rect((72, 66, 128, 191)), fill=255)
    g.ellipse(rect((111, 93, 160, 163)), fill=0)
    image.paste((255, 255, 255, 255), (0, 0, EDGE, EDGE), emblem)

    # A restrained cyan accent gives the icon a recognizable app identity.
    d = ImageDraw.Draw(image)
    d.rounded_rectangle(rect((174, 69, 193, 88)), radius=round(7 * SCALE),
                        fill=(87, 224, 246, 255))
    return image


if __name__ == "__main__":
    master = build()
    png = OUTPUT / "devspace-portable.png"
    ico = OUTPUT / "devspace-portable.ico"
    master.resize((256, 256), Image.Resampling.LANCZOS).save(png, optimize=True)
    master.save(ico, format="ICO", sizes=[
        (16, 16), (20, 20), (24, 24), (32, 32), (40, 40),
        (48, 48), (64, 64), (128, 128), (256, 256),
    ])
    print(f"Created {png}")
    print(f"Created {ico}")
