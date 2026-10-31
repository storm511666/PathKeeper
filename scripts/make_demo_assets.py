"""Create the tiny placeholder assets used by examples/demo-project."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent / "examples" / "demo-project"


def main() -> None:
    (ROOT / "assets" / "textures").mkdir(parents=True, exist_ok=True)
    (ROOT / "assets" / "masks").mkdir(parents=True, exist_ok=True)
    (ROOT / "assets" / "models").mkdir(parents=True, exist_ok=True)
    (ROOT / "datasets" / "raw" / "images").mkdir(parents=True, exist_ok=True)
    (ROOT / "datasets" / "raw" / "labels").mkdir(parents=True, exist_ok=True)
    (ROOT / "styles").mkdir(parents=True, exist_ok=True)

    Image.new("RGBA", (1, 1), (170, 85, 60, 255)).save(ROOT / "assets" / "textures" / "old_brick_wall.png")
    Image.new("RGBA", (1, 1), (128, 128, 255, 255)).save(
        ROOT / "assets" / "textures" / "old_brick_normal.png"
    )
    Image.new("RGBA", (1, 1), (255, 255, 255, 255)).save(ROOT / "assets" / "masks" / "brick_mask.png")
    Image.new("RGB", (1, 1), (90, 140, 90)).save(ROOT / "datasets" / "raw" / "images" / "cat_001.jpg")

    for name in ("base_model.safetensors", "dreamshaper_8.safetensors"):
        (ROOT / "assets" / "models" / name).write_bytes(b"PK-DEMO-PLACEHOLDER")

    (ROOT / "datasets" / "raw" / "labels" / "cat_001.txt").write_text(
        "0 0.5 0.5 1.0 1.0\n", encoding="utf-8"
    )
    (ROOT / "styles" / "preview.css").write_text(
        "body { font-family: sans-serif; background: #1b1b1b; color: #eee; }\n"
        "img { width: 256px; image-rendering: pixelated; }\n",
        encoding="utf-8",
    )
    print(f"Demo assets written under {ROOT}")


if __name__ == "__main__":
    main()
