"""Generate PathKeeper's app icon from a small, reproducible drawing script.

Run: python scripts/generate_icon.py
Outputs: build/icon.png (512), build/icon.ico (multi-size Windows icon).
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"

INK = (13, 20, 25, 255)
SURFACE = (16, 29, 36, 255)
SURFACE_HI = (22, 42, 51, 255)
BRASS = (224, 177, 92, 255)
BRASS_DIM = (143, 112, 62, 255)
CHALK = (231, 238, 238, 255)


def rounded_rectangle(draw: ImageDraw.ImageDraw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


def draw_icon(size: int = 1024) -> Image.Image:
    # Work at 4x and downsample for clean edges at 16px.
    scale = 4
    canvas = size * scale
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    pad = int(canvas * 0.045)
    rounded_rectangle(
        draw,
        (pad, pad, canvas - pad, canvas - pad),
        radius=int(canvas * 0.22),
        fill=SURFACE,
    )

    # A very quiet blueprint grid inside the tile.
    grid = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    grid_draw = ImageDraw.Draw(grid)
    step = canvas // 12
    for i in range(1, 12):
        alpha = 12 if i % 3 else 20
        grid_draw.line((i * step, pad, i * step, canvas - pad), fill=(*CHALK[:3], alpha), width=2)
        grid_draw.line((pad, i * step, canvas - pad, i * step), fill=(*CHALK[:3], alpha), width=2)
    mask = Image.new("L", (canvas, canvas), 0)
    mask_draw = ImageDraw.Draw(mask)
    radius = int(canvas * 0.22)
    mask_draw.rounded_rectangle(
        (pad, pad, canvas - pad, canvas - pad), radius=radius, fill=255
    )
    # Composite the faint blueprint grid over the tile, clipped to its shape.
    grid_a = grid.getchannel("A")
    grid_clipped = ImageChops.multiply(grid_a, mask)
    grid.putalpha(grid_clipped)
    image = Image.alpha_composite(image, grid)
    draw = ImageDraw.Draw(image)

    # Route: a surveyed switchback with a moved checkpoint.
    line_width = int(canvas * 0.052)
    route = [
        (int(canvas * 0.27), int(canvas * 0.76)),
        (int(canvas * 0.27), int(canvas * 0.47)),
        (int(canvas * 0.38), int(canvas * 0.36)),
        (int(canvas * 0.72), int(canvas * 0.36)),
    ]
    draw.line(route, fill=BRASS, width=line_width, joint="curve")
    # Round caps.
    for point in (route[0], route[-1]):
        r = line_width // 2
        draw.ellipse((point[0] - r, point[1] - r, point[0] + r, point[1] + r), fill=BRASS)

    # Ghost (old) route: dashed, away from the new route.
    ghost_width = int(canvas * 0.026)
    for start, end in (
        ((0.28, 0.79), (0.44, 0.79)),
        ((0.48, 0.79), (0.62, 0.79)),
        ((0.66, 0.79), (0.76, 0.79)),
    ):
        draw.line(
            (
                int(canvas * start[0]),
                int(canvas * start[1]),
                int(canvas * end[0]),
                int(canvas * end[1]),
            ),
            fill=BRASS_DIM,
            width=ghost_width,
        )

    # Nodes: one at the origin and a larger "destination" node with a hole.
    node_r = int(canvas * 0.052)
    origin = route[0]
    draw.ellipse(
        (origin[0] - node_r, origin[1] - node_r, origin[0] + node_r, origin[1] + node_r),
        fill=CHALK,
    )
    dest_outer = int(canvas * 0.083)
    dest = route[-1]
    draw.ellipse(
        (
            dest[0] - dest_outer,
            dest[1] - dest_outer,
            dest[0] + dest_outer,
            dest[1] + dest_outer,
        ),
        fill=BRASS,
    )
    draw.ellipse(
        (
            dest[0] - dest_outer // 2,
            dest[1] - dest_outer // 2,
            dest[0] + dest_outer // 2,
            dest[1] + dest_outer // 2,
        ),
        fill=SURFACE,
    )

    # Corner accent ticks evoke a survey marker without becoming decoration.
    tick = int(canvas * 0.045)
    inset = int(canvas * 0.17)
    draw.line((pad + inset, pad + inset, pad + inset + tick, pad + inset), fill=(*BRASS[:3], 190), width=2)
    draw.line((pad + inset, pad + inset, pad + inset, pad + inset + tick), fill=(*BRASS[:3], 190), width=2)

    return image.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    BUILD.mkdir(parents=True, exist_ok=True)
    icon_1024 = draw_icon(1024)
    icon_1024.save(BUILD / "icon.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    icon_1024.save(BUILD / "icon.ico", sizes=[(s, s) for s in sizes])
    print(f"Wrote {BUILD / 'icon.png'} and {BUILD / 'icon.ico'}")


if __name__ == "__main__":
    main()
