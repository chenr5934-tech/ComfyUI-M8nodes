"""M8 · 文件夹存图 —— 把 IMAGE 批次逐张写进一个文件夹，目录不存在就新建。

和「保存图像」的区别：官方节点只往 output 目录里写、且文件名由计数器决定；
这个节点认任意路径，并且能沿用上游「文件夹读图」给的原文件名 —— 这样一整条
「读一整个文件夹 → 处理 → 写回另一个文件夹」的流水线跑完，文件名对得上，
用户不用再对着一堆 00001 猜哪张是哪张。

重依赖（torch / numpy / pillow）全部在函数里 import，理由同加载器。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ....core import imageio
from ....core.errors import M8Error, wrap
from ....core.log import SHELF_IMG, log, warn

# 和官方 SaveImage 一致：4 是速度和体积的折中，调高只是更慢。
PNG_COMPRESS_LEVEL = 4


def _safe_parts(raw: str) -> tuple[list[str], str]:
    """把上游给的一行（相对路径）拆成 (子目录段, 文件名主干)。

    `..`、空段、绝对路径前缀一律丢掉：这段文本可能来自用户手填，不能让它把
    文件写到目标文件夹外面去。
    """
    text = (raw or "").strip().replace("\\", "/")
    parts = [p for p in text.split("/") if p and p not in (".", "..")]
    if not parts:
        return ([], "")

    stem = Path(parts[-1]).stem
    dirs = [imageio.sanitize_stem(part, "_") for part in parts[:-1]]
    return (dirs, imageio.sanitize_stem(stem, ""))


def _make_pnginfo(prompt: Any, extra_pnginfo: Any) -> Any:
    """PNG 的文本元数据块。写不进去就算了 —— 元数据缺失不该让整张图存不下来。"""
    try:
        from PIL.PngImagePlugin import PngInfo
    except Exception as exc:
        raise wrap("M8-IMG-007", exc, "pillow 没装好", "ComfyUI 自带 pillow，确认环境没被破坏")

    info = PngInfo()
    try:
        if prompt is not None:
            info.add_text("prompt", json.dumps(prompt))
        if extra_pnginfo is not None:
            for key, value in extra_pnginfo.items():
                info.add_text(str(key), json.dumps(value))
    except Exception as exc:  # 元数据不是本体，写不进也不该让整张图失败
        warn(f"PNG 元数据没写进去：{type(exc).__name__}: {exc}", shelf=SHELF_IMG)
    return info


def _preview_entry(path: Path) -> dict[str, str] | None:
    """只有在 ComfyUI 的 output 目录里，前端才能用 /view 拿到这张图。

    写到别处的图给不出预览，返回 None —— 与其给一个必然 404 的地址让人看到
    一排破图，不如让节点上什么都不显示。
    """
    try:
        import folder_paths  # type: ignore
        root = Path(str(folder_paths.get_output_directory())).resolve()
        relative = path.resolve().relative_to(root)
    except Exception:
        return None

    subfolder = str(relative.parent).replace("\\", "/")
    return {
        "filename": path.name,
        "subfolder": "" if subfolder == "." else subfolder,
        "type": "output",
    }


class M8ImageFolderSaver:
    """把一批 IMAGE 逐张写进目标文件夹。"""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "images": ("IMAGE",),
                "output_folder": ("STRING", {"default": "", "multiline": False}),
                "format": (list(imageio.SAVE_FORMATS), {"default": imageio.DEFAULT_SAVE_FORMAT}),
                "filename_prefix": ("STRING", {"default": "M8", "multiline": False}),
                "keep_structure": ("BOOLEAN", {"default": True}),
                "overwrite": ("BOOLEAN", {"default": False}),
                "quality": ("INT", {"default": 92, "min": 1, "max": 100, "step": 1}),
            },
            "optional": {
                # 接「文件夹读图」的「文件名」输出就能沿用原名。
                # 故意做成普通 STRING：既能连线，也能手填。
                "filenames": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    RETURN_NAMES = ()
    FUNCTION = "execute"
    CATEGORY = "M8/图像"
    OUTPUT_NODE = True
    DESCRIPTION = (
        "把一批 IMAGE 逐张写进目标文件夹，目录不存在就自动建（含所有父级）。"
        "把「文件夹读图」的「文件名」接到「文件名」输入口，就能沿用原文件名与子目录结构。"
        "文件夹填绝对路径，或填相对 ComfyUI output 目录的子路径。"
    )

    def execute(
        self,
        images: Any,
        output_folder: str,
        format: str,
        filename_prefix: str,
        keep_structure: bool,
        overwrite: bool,
        quality: int,
        filenames: str = "",
        prompt: Any = None,
        extra_pnginfo: Any = None,
    ) -> dict[str, Any]:
        if format not in imageio.SAVE_FORMATS:
            raise M8Error(
                "M8-IMG-009",
                f"不支持的保存格式：{format}",
                "格式只能是 PNG / JPEG / WEBP",
            )
        if images is None:
            raise M8Error("M8-IMG-010", "没有可保存的图像", "把 IMAGE 接到这个节点的输入上")

        try:
            import numpy as np
        except Exception as exc:
            raise wrap("M8-IMG-007", exc, "numpy 没装好", "确认用的是 ComfyUI 自带的 python")

        # ComfyUI 的 IMAGE 是 (batch, H, W, C)。个别自定义节点会吐 3 维的单张，
        # 那也当一张存 —— 按第一维迭代会把它切成 H 条，比报错还糟。
        shape = getattr(images, "shape", ())
        count = int(shape[0]) if len(shape) == 4 else 1
        if count <= 0:
            raise M8Error("M8-IMG-010", "这批图是空的", "上游没产出任何图，检查批次是不是被筛空了")

        target_dir = imageio.resolve_folder(output_folder, must_exist=False, prefer="output")
        imageio.ensure_dir(target_dir)

        pil_format, suffix = imageio.SAVE_FORMATS[format]
        names = (filenames or "").splitlines()
        prefix = imageio.sanitize_stem(filename_prefix, "M8")

        # torch 张量在 CPU 上也要先转 numpy 再交给 PIL，官方节点就是这么转的。
        array = 255.0 * images.cpu().numpy()
        if array.ndim == 3:
            array = array[None, ...]

        previews: list[dict[str, str]] = []
        for index in range(count):
            subdirs, stem = ([], "")
            if index < len(names):
                subdirs, stem = _safe_parts(names[index])

            folder = target_dir
            if keep_structure and subdirs:
                folder = target_dir.joinpath(*subdirs)
                imageio.ensure_dir(folder)

            if not stem:
                stem = f"{prefix}_{index + 1:05d}"

            path = folder / f"{stem}{suffix}"
            if not overwrite:
                path = imageio.unique_path(folder, stem, suffix)

            try:
                from PIL import Image

                frame = array[index]
                if frame.ndim == 3 and frame.shape[-1] == 1:
                    frame = frame[..., 0]
                img = Image.fromarray(np.clip(frame, 0, 255).astype(np.uint8))
                if pil_format == "JPEG":
                    img = img.convert("RGB")

                save_args: dict[str, Any] = {}
                if pil_format == "PNG":
                    save_args["pnginfo"] = _make_pnginfo(prompt, extra_pnginfo)
                    save_args["compress_level"] = PNG_COMPRESS_LEVEL
                else:
                    save_args["quality"] = max(1, min(100, int(quality)))

                img.save(path, format=pil_format, **save_args)
            except M8Error:
                raise
            except Exception as exc:
                raise wrap(
                    "M8-IMG-007",
                    exc,
                    f"存不下来：{path.name}",
                    "检查磁盘空间和目录写权限",
                )

            entry = _preview_entry(path)
            if entry is not None:
                previews.append(entry)

        log(f"{target_dir} ← 写入 {count} 张（{format}）", shelf=SHELF_IMG)
        if previews and len(previews) < count:
            warn(
                f"有 {count - len(previews)} 张不在 output 目录里，节点上不显示预览",
                shelf=SHELF_IMG,
            )
        # images 走 ComfyUI 的标准预览通道；m8 是给节点前端读的摘要
        # （message.m8，同 llm_inference 的用法）
        return {
            "ui": {
                "images": previews,
                "m8": {"saved": count, "previews": len(previews), "folder": str(target_dir)},
            }
        }


NODE_CLASS_MAPPINGS = {"M8ImageFolderSaver": M8ImageFolderSaver}
NODE_DISPLAY_NAME_MAPPINGS = {"M8ImageFolderSaver": "M8 · 文件夹存图"}
