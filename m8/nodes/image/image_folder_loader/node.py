"""M8 · 文件夹读图 —— 把一整个文件夹的图按确定顺序读成 IMAGE 批次。

为什么需要它：ComfyUI 自带的「加载图像」一次只能读一张，要过一整个文件夹就得
手工点 N 次、每次换一张。这个节点把「文件夹」变成一个批次，并且**顺序是确定的**
（见 m8/core/imageio.py 的排序逻辑），下游按 batch 维逐张处理，出来还是那个顺序。

重依赖（torch / numpy / pillow）全部在函数里 import —— 模块级 import 会让
没有装这些包的静态测试环境直接炸掉，也会拖慢 ComfyUI 的启动扫描。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ....core import imageio
from ....core.errors import M8Error, wrap
from ....core.log import SHELF_IMG, log, warn

# 三个尺寸策略的语义，和 imageio.SIZE_MODES 一一对应
MODE_STRICT = imageio.SIZE_STRICT
MODE_PAD = imageio.SIZE_PAD
MODE_RESIZE = imageio.SIZE_RESIZE


def _probe_size(path: Path) -> tuple[int, int]:
    """只读文件头拿尺寸，不解码整张图。

    exif 旋转会让 PIL 报的宽高和肉眼看到的相反，所以方向标记在 5..8 时互换 ——
    这正是 ImageOps.exif_transpose 实际做的事，先在这里对齐，后面才不用二次判断。
    """
    try:
        from PIL import Image
    except Exception as exc:
        raise wrap("M8-IMG-004", exc, "pillow 没装好", "ComfyUI 自带 pillow，确认环境没被破坏")

    try:
        with Image.open(path) as handle:
            width, height = handle.size
            try:
                orientation = int(handle.getexif().get(0x0112, 1))
            except Exception:
                orientation = 1
    except Exception as exc:
        raise wrap(
            "M8-IMG-004",
            exc,
            f"读不出来：{path.name}",
            "文件可能损坏，或后缀和真实格式不符",
        )

    if orientation in (5, 6, 7, 8):
        width, height = height, width
    if width <= 0 or height <= 0:
        raise M8Error("M8-IMG-004", "这张图的尺寸是 0", "文件可能不完整", detail=str(path))
    return width, height


def _target_size(sizes: list[tuple[int, int]], mode: str, names: list[str]) -> tuple[int, int]:
    """按策略决定整个批次要用的 (宽, 高)。"""
    if mode == MODE_PAD:
        return (max(w for w, _h in sizes), max(h for _w, h in sizes))

    target = sizes[0]
    if mode == MODE_STRICT:
        mismatched = [
            f"{names[i]} {sizes[i][0]}x{sizes[i][1]}"
            for i in range(len(sizes))
            if sizes[i] != target
        ]
        if mismatched:
            shown = "、".join(mismatched[:5])
            more = "" if len(mismatched) <= 5 else f" 等 {len(mismatched)} 张"
            raise M8Error(
                "M8-IMG-005",
                "这批图尺寸不一致",
                "把「尺寸处理」改成「补边」或「拉伸」，或者先把文件夹里的图统一成同一尺寸",
                detail=f"基准 {target[0]}x{target[1]}；不一致：{shown}{more}",
            )
    return target


def _to_tensor(path: Path, target: tuple[int, int], mode: str) -> Any:
    """读一张图 → (高, 宽, 3) 的 float32 张量，取值 0..1。"""
    try:
        import numpy as np
        import torch
        from PIL import Image, ImageOps
    except Exception as exc:
        raise wrap(
            "M8-IMG-004",
            exc,
            "图像处理依赖用不了",
            "确认 ComfyUI 自带的 pillow / numpy / torch 都在，别在别的 python 里跑",
        )

    try:
        with Image.open(path) as handle:
            frames = getattr(handle, "n_frames", 1)
            if frames > 1:
                warn(f"{path.name} 是 {frames} 帧的动图，只取第一帧", shelf=SHELF_IMG)
            # exif_transpose 和 convert 都必须在这个 with 里做完：
            # 出了 with 句柄就关了，PIL 是惰性解码，再去读会报「文件已关闭」。
            img = ImageOps.exif_transpose(handle).convert("RGB")
    except Exception as exc:
        raise wrap(
            "M8-IMG-004",
            exc,
            f"读不出来：{path.name}",
            "文件可能损坏，或后缀和真实格式不符",
        )

    if img.size != target:
        if mode == MODE_PAD:
            # 等比缩放到装得下，空出来的地方补黑 —— 不裁内容、不变形。
            img = ImageOps.pad(img, target, color=(0, 0, 0), centering=(0.5, 0.5))
        else:
            img = img.resize(target, Image.LANCZOS)

    array = np.asarray(img, dtype=np.float32) / 255.0
    return torch.from_numpy(array)


class M8ImageFolderLoader:
    """把文件夹里的图按顺序读成一个 IMAGE 批次。"""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "folder": ("STRING", {"default": "", "multiline": False}),
                "recursive": ("BOOLEAN", {"default": False}),
                "sort": (list(imageio.SORT_OPTIONS), {"default": imageio.DEFAULT_SORT_LABEL}),
                "size_mode": (list(imageio.SIZE_MODES), {"default": MODE_STRICT}),
                "start_index": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF, "step": 1}),
                "limit": ("INT", {"default": 0, "min": 0, "max": 0x7FFFFFFF, "step": 1}),
            }
        }

    RETURN_TYPES = ("IMAGE", "STRING", "INT")
    RETURN_NAMES = ("图像", "文件名", "总数")
    # 逐张下发：ComfyUI 会把 list 输出逐项送给下游，遇到多输入的节点就按项展开执行
    # （execution.py: _async_map_node_over_list / merge_result_data）。于是采样器每张
    # 各跑一次、显存只吃一张，而加载器自身和模型加载这类没有 list 输入的节点仍只跑一次。
    OUTPUT_IS_LIST = (True, True, False)
    FUNCTION = "execute"
    CATEGORY = "M8/图像"
    DESCRIPTION = (
        "把一个文件夹里的图片按顺序读出来，逐张下发给下游。"
        "输出是图像列表 —— ComfyUI 对 list 输出会按项喂，所以采样器每张各跑一次、"
        "显存只吃一张；模型加载这类不吃 list 的节点仍然只跑一次。"
        "「文件名」同样逐项下发，接给「文件夹存图」就能按原名回写、保留子目录结构。"
        "文件夹填完整路径，或填相对 ComfyUI 目录的路径（如 input/pics）。"
    )

    @classmethod
    def IS_CHANGED(cls, **kwargs: Any) -> float:
        """永远当作已变更。

        节点的输入是磁盘状态，而磁盘状态 ComfyUI 的缓存签名看不见 ——
        用户往文件夹里丢了几张新图，缓存不失效的话他会看到「明明加了图却没变化」。
        """
        return float("nan")

    def execute(
        self,
        folder: str,
        recursive: bool,
        sort: str,
        size_mode: str,
        start_index: int,
        limit: int,
    ) -> tuple[list[Any], list[str], int]:
        target_dir = imageio.resolve_folder(folder, must_exist=True, prefer="input")
        mode = imageio.SORT_OPTIONS.get(sort, imageio.SORT_NAME)
        paths = imageio.list_images(target_dir, recursive=recursive, sort=mode)
        total = len(paths)

        start = max(0, int(start_index))
        if start >= total:
            raise M8Error(
                "M8-IMG-008",
                "起始序号超出范围",
                "「起始序号」从 0 开始且要小于总数",
                detail=f"起始 {start}，总数 {total}",
            )
        count = total - start if int(limit) <= 0 else min(int(limit), total - start)
        chosen = paths[start : start + count]

        names = [str(p.relative_to(target_dir)).replace("\\", "/") for p in chosen]
        sizes = [_probe_size(p) for p in chosen]
        size = _target_size(sizes, size_mode, names)

        # 这里显式 import 一次，是为了在「还没开始解码」时就给出明确的依赖错误，
        # 而不是让第一批图读到一半才在 _to_tensor 里炸。别当死代码删掉。
        try:
            import torch  # noqa: F401
        except Exception as exc:
            raise wrap("M8-IMG-004", exc, "torch 没装好", "确认用的是 ComfyUI 自带的 python")

        # 每张单独一维 batch（1, 高, 宽, 3）：下游按项收，一次只拿一张。
        tensors = [_to_tensor(p, size, size_mode).unsqueeze(0) for p in chosen]
        log(
            f"{target_dir} → 第 {start + 1}-{start + count} 张 / 共 {total} 张，"
            f"输出尺寸 {size[0]}x{size[1]}（{size_mode}）",
            shelf=SHELF_IMG,
        )
        # ui 段只给前端写状态栏用；真正的输出在 result 里，按 OUTPUT_IS_LIST 逐项下发。
        return {
            "ui": {"m8": {"count": count, "total": total}},
            "result": (tensors, names, total),
        }


NODE_CLASS_MAPPINGS = {"M8ImageFolderLoader": M8ImageFolderLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"M8ImageFolderLoader": "M8 · 文件夹读图"}
