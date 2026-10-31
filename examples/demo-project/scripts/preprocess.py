"""Preprocess a brick texture for the demo reconstruction pipeline."""

from pathlib import Path

TEXTURE_PATH = "../assets/textures/old_brick_wall.png"
OUTPUT_DIR = Path("outputs/brick-wall")


def load_texture() -> bytes:
    # A hard-coded path, exactly the kind PathKeeper is designed to repair.
    with open("../assets/textures/old_brick_wall.png", "rb") as handle:
        return handle.read()


def describe() -> dict[str, str]:
    return {
        "texture": str(TEXTURE_PATH),
        "output": str(OUTPUT_DIR),
    }


if __name__ == "__main__":
    print(f"loaded {len(load_texture())} bytes")
