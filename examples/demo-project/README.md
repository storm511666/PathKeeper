# 砖墙材质重建示例项目

这是一个用于体验 PathKeeper 的混合格式示例项目。它故意把同一个纹理文件的路径写进了
Markdown、JSON、YAML、Python、JavaScript、HTML、ComfyUI 工作流和纯文本里。

## 迁移任务

假设美术同事把下面这个文件：

```
assets/textures/old_brick_wall.png
```

移动并重命名为：

```
assets/materials/brick_wall.png
```

在 PathKeeper 中依次录入旧路径和新路径，保持三种匹配模式开启，然后扫描。你应当能看到
来自不同格式文件的引用；默认的忽略规则会跳过 `node_modules/`、`dist/` 和备份目录。

![砖墙纹理](assets/textures/old_brick_wall.png)

旧路径也出现在行内代码里：`./assets/textures/old_brick_wall.png`。

## 目录迁移任务

还可以尝试把整个 `datasets/raw` 目录迁移到 `datasets/processed`。项目里包含
`configs/dataset.yaml` 与若干数据文件，可用于验证目录模糊匹配模式。

## 关于示例数据

示例中的图片是 1×1 占位图，模型文件与数据集文件是空占位文件。它们仅用于展示路径引用，
不包含任何真实素材。
