from pathlib import Path

texture = Path("../assets/textures/old_brick_wall.png")
if not texture.exists():
    print("图片位置变了，需要更新路径")
