"""M8 图像货架的共用文件系统逻辑。

加载器和保存器都要回答同一个问题：「用户填的这串路径到底指哪个文件夹」。
这个判断只能有一处 —— 两边各写一份，迟早一边认 `~` 一边不认，然后用户拿着
同一个路径，一个节点能跑、另一个报不存在。

这里只做纯路径与文件枚举，**不 import torch / PIL**。图片真正的读写发生在
节点执行里，那时候 ComfyUI 早就把重依赖装好了；而这份代码要能在没有 torch
的单测环境里被 import。
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

from .errors import M8Error, wrap

# 后缀白名单。故意写死：放 .psd / .tga 进来只会让「加载成功但张量是黑的」
# 这种坑更难查，而 ComfyUI 自己保存时也只认下面这几种。
IMAGE_EXTENSIONS: tuple[str, ...] = (
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".bmp",
    ".gif",
    ".tif",
    ".tiff",
)

# 排序方式。值直接写中文，因为 combo 的选项值就是界面上显示的字；
# 后端再映射回这里的常量，映射表在下面。
SORT_NAME = "name"
SORT_NAME_DESC = "name_desc"
SORT_MTIME = "mtime"
SORT_MTIME_DESC = "mtime_desc"

SORT_MODES: tuple[str, ...] = (SORT_NAME, SORT_NAME_DESC, SORT_MTIME, SORT_MTIME_DESC)

# 界面显示值 -> 内部标识。顺序即下拉框顺序。
SORT_OPTIONS: dict[str, str] = {
    "文件名（自然序）": SORT_NAME,
    "文件名（倒序）": SORT_NAME_DESC,
    "修改时间（旧→新）": SORT_MTIME,
    "修改时间（新→旧）": SORT_MTIME_DESC,
}

DEFAULT_SORT_LABEL = "文件名（自然序）"

# 尺寸不一致时的处理档位。下拉值同样是中文。
SIZE_STRICT = "严格"
SIZE_PAD = "补边"
SIZE_RESIZE = "拉伸"
SIZE_MODES: tuple[str, ...] = (SIZE_STRICT, SIZE_PAD, SIZE_RESIZE)

# 保存格式 -> 落盘用的 PIL 格式名 + 后缀
SAVE_FORMATS: dict[str, tuple[str, str]] = {
    "PNG": ("PNG", ".png"),
    "JPEG": ("JPEG", ".jpg"),
    "WEBP": ("WEBP", ".webp"),
}
DEFAULT_SAVE_FORMAT = "PNG"

_CHUNK_RE = re.compile(r"\d+|\D+")
_ILLEGAL_NAME_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def natural_key(text: str) -> tuple[tuple[int, int, str], ...]:
    """把 `img10.png` 拆成能正确排序的键。

    为什么不用 `sorted()` 直接排：字符串比较下 `img10.png` 排在 `img9.png`
    前面，而用户脑子里的顺序是 9、10、11。这里把数字段按整数比，其余按小写
    原文比。元组形状统一成 `(类型, 整数值, 文本值)`，避免 int 和 str 直接比较
    抛 TypeError。
    """
    parts: list[tuple[int, int, str]] = []
    for chunk in _CHUNK_RE.findall(text):
        if chunk.isdigit():
            parts.append((1, int(chunk), ""))
        else:
            parts.append((0, 0, chunk.lower()))
    return tuple(parts)


def is_image(path: Path) -> bool:
    """后缀是否在白名单里（大小写不敏感）。"""
    return path.suffix.lower() in IMAGE_EXTENSIONS


def comfy_roots(prefer: str = "input") -> list[Path]:
    """ComfyUI 的 input / output 目录，按 `prefer` 决定谁排前面。

    拿不到就返回空表 —— 单测环境没有 folder_paths，这里不能因此炸掉，
    「相对路径以谁为基准」这种依赖上下文的判断交给调用点降级。
    """
    pairs = (("get_input_directory", "input"), ("get_output_directory", "output"))
    if prefer == "output":
        pairs = tuple(reversed(pairs))

    try:
        import folder_paths  # type: ignore
    except Exception:
        return []

    roots: list[Path] = []
    for getter, _kind in pairs:
        fn = getattr(folder_paths, getter, None)
        if not callable(fn):
            continue
        try:
            raw = fn()
        except Exception:
            continue
        if raw:
            roots.append(Path(str(raw)).expanduser())
    return roots


def comfy_home() -> Path | None:
    """ComfyUI 安装根（output 目录的上一级）。拿不到就 None。

    界面上的相对路径先按这里找，用户填 `input/pics`、`output/成品` 都符合直觉。
    """
    roots = comfy_roots("output")
    if not roots:
        return None
    parent = roots[0].parent
    return parent if parent.is_dir() else None


def search_bases(prefer: str = "input") -> list[Path]:
    """相对路径的候选基准，按优先级排好：先 ComfyUI 根，再 input / output。"""
    bases: list[Path] = []
    home = comfy_home()
    if home is not None:
        bases.append(home)
    for root in comfy_roots(prefer):
        if root not in bases:
            bases.append(root)
    return bases


def roots_hint(prefer: str = "input") -> str:
    """「相对路径以谁为基准」的一句人话，拼进报错 hint 里。"""
    bases = search_bases(prefer)
    if not bases:
        return "相对路径会以本进程的工作目录为基准"
    return "相对路径先按 " + "、".join(str(p) for p in bases) + " 依次找"


def resolve_folder(raw: str, *, must_exist: bool, code: str = "M8-IMG-001", prefer: str = "input") -> Path:
    """把界面上填的路径解析成 Path。

    认三种写法：绝对路径、`~` 开头的家目录、相对 ComfyUI 目录的子目录名
    （加载器先试 input，保存器先试 output —— 各按各的直觉）。
    资源管理器复制出来的路径带反斜杠和成对引号，这里一并收拾掉。
    """
    text = (raw or "").strip()
    for quote in ('"', "'"):
        if len(text) >= 2 and text.startswith(quote) and text.endswith(quote):
            text = text[1:-1].strip()

    if not text:
        raise M8Error(
            code,
            "图片文件夹没填",
            "填这个文件夹的完整路径（带盘符那种），或填相对 ComfyUI 目录的路径，如 input/pics",
        )

    # 反斜杠只在 Windows 上是分隔符；在别的系统上它是合法文件名字符，
    # 但用户从 Windows 复制过来的路径永远是反斜杠，统一成 / 更省事。
    if os.sep == "/":
        text = text.replace("\\", "/")

    path = Path(text).expanduser()

    if not path.is_absolute():
        bases = search_bases(prefer)
        resolved: Path | None = None
        for base in bases:
            candidate = base / path
            if candidate.is_dir():
                resolved = candidate
                break
        if resolved is not None:
            path = resolved
        elif bases and not must_exist:
            # 保存器要新建目录，那时目录当然还不存在，按第一基准算即可。
            path = bases[0] / path
        elif not bases:
            path = Path.cwd() / path

    if must_exist and not path.is_dir():
        # detail 给出真的去找过的位置：相对路径解析失败时用户最想知道「你在哪找的」
        tried = str(path)
        if not path.is_absolute() and bases:
            tried = "、".join(str(base / path) for base in bases)
        raise M8Error(
            "M8-IMG-002",
            "图片文件夹不存在",
            roots_hint(prefer),
            detail=tried,
        )
    return path


def list_images(folder: Path, *, recursive: bool = False, sort: str = SORT_NAME) -> list[Path]:
    """按指定顺序列出文件夹里的图片。

    顺序是这个货架的全部意义 —— 用户要的是「按顺序一张张过」，所以这里永远
    返回确定的序列：即使底层 `iterdir()` 的顺序变了，输出顺序也不变。
    """
    if sort not in SORT_MODES:
        raise M8Error(
            "M8-IMG-011",
            f"未知的排序方式：{sort}",
            "用节点下拉里给的那几个值",
        )

    try:
        if recursive:
            candidates = [p for p in folder.rglob("*") if p.is_file() and is_image(p)]
        else:
            candidates = [p for p in folder.iterdir() if p.is_file() and is_image(p)]
    except OSError as exc:
        raise wrap(
            "M8-IMG-002",
            exc,
            "读不了这个文件夹",
            "检查路径权限；Windows 上还可能是路径太长（超过 260 字符）",
        )

    if not candidates:
        raise M8Error(
            "M8-IMG-003",
            "这个文件夹里没有图片",
            "支持的后缀：" + " ".join(IMAGE_EXTENSIONS)
            + ("；当前是递归模式，子文件夹也算在内" if recursive else ""),
            detail=str(folder),
        )

    records: list[tuple[float, str, Path]] = []
    for path in candidates:
        try:
            stamp = path.stat().st_mtime
        except OSError:
            stamp = 0.0
        rel = str(path.relative_to(folder)).replace(os.sep, "/")
        records.append((stamp, rel, path))

    if sort == SORT_MTIME:
        records.sort(key=lambda r: (r[0], natural_key(r[1])))
    elif sort == SORT_MTIME_DESC:
        records.sort(key=lambda r: (r[0], natural_key(r[1])), reverse=True)
    elif sort == SORT_NAME_DESC:
        records.sort(key=lambda r: natural_key(r[1]), reverse=True)
    else:
        records.sort(key=lambda r: natural_key(r[1]))

    return [r[2] for r in records]


def ensure_dir(folder: Path) -> None:
    """建目录（含所有父级）。已存在就当成功 —— 「不存在则新建」的核心就这一句。"""
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise wrap(
            "M8-IMG-006",
            exc,
            "输出目录建不出来",
            "检查这个路径能不能写：只读盘、需要管理员权限的目录都会这样",
        )


def sanitize_stem(name: str, fallback: str = "image") -> str:
    """把用户给的文件名前缀洗成合法文件名（去掉路径分隔符和 Windows 禁用字符）。"""
    text = _ILLEGAL_NAME_RE.sub("_", (name or "").strip())
    text = text.strip(" .")
    return text or fallback


def unique_path(folder: Path, stem: str, suffix: str) -> Path:
    """同名文件已存在时按 `name_00001` 递增，和 ComfyUI 的 SaveImage 一个路子。"""
    candidate = folder / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    index = 1
    while index <= 99999:
        candidate = folder / f"{stem}_{index:05d}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1
    return folder / f"{stem}_{int(time.time() * 1000)}{suffix}"
