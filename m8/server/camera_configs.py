"""相机配置的存取。

一个配置一个 json 文件，放在 m8/data/camera-configs/ 下，文件名就是配置名。

为什么存文件而不是塞进设置里：配置是**可以有很多份**的（白天/夜景/特写各一套），
设置是单例；而且用户会想直接拿文本编辑器改、想拷给别人 —— 文件天然满足这些，
塞进一个大 json 里就得额外做导入导出。

安全：配置名会拼进文件路径，所以必须净化。只允许中英文、数字、下划线、连字符
和点以外的字符一律换成下划线；再挡一次 ".." 和绝对路径 —— 这里少写一行，
别人就能靠一个配置名读写磁盘上任意位置。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..core import paths
from ..core.errors import M8Error
from ..core.log import SHELF_CAM, log

# 配置是几十行的 JSON，给足余量；超过就是误传了大文件
MAX_CONFIG_BYTES = 256 * 1024

_SAFE = re.compile(r"[^0-9A-Za-z_\-\u4e00-\u9fff.]")


def _safe_name(name: str) -> str:
    """净化配置名。空名、纯点、带分隔符的一律挡掉。"""
    raw = str(name or "").strip()
    # 先把路径分隔符和上跳清掉 —— 正则只保证字符集，挡不住 ".."
    raw = raw.replace("/", "_").replace("\\", "_")
    clean = _SAFE.sub("_", raw)
    clean = clean.lstrip(".")
    if not clean or clean in (".", ".."):
        raise M8Error(
            "M8-CAM-002",
            message="配置名不合法",
            hint="用中英文、数字、下划线或连字符，别带斜杠",
            detail=f"原始输入：{name!r}",
        )
    return clean[:64]


def config_dir() -> Path:
    """配置目录，不存在就建。"""
    try:
        paths.CAMERA_CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise M8Error(
            "M8-CAM-003",
            message="建不出配置目录",
            hint="检查 m8/data/ 的写权限",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    return paths.CAMERA_CONFIGS_DIR


def available() -> list[str]:
    """列出已有的配置名（不带后缀），按名字排序。"""
    folder = config_dir()
    names = []
    for entry in sorted(folder.iterdir(), key=lambda p: p.name):
        if entry.is_file() and entry.suffix.lower() == ".json":
            names.append(entry.stem)
    return names


def save(name: str, config: Any) -> str:
    """存一份配置。返回净化后的名字。"""
    clean = _safe_name(name)
    folder = config_dir()
    target = folder / f"{clean}.json"

    text = json.dumps(config, ensure_ascii=False, indent=2)
    size = len(text.encode("utf-8"))
    if size > MAX_CONFIG_BYTES:
        raise M8Error(
            "M8-CAM-004",
            message="配置太大，存不下",
            hint=f"上限 {MAX_CONFIG_BYTES // 1024} KB；正常配置只有几 KB",
            detail=f"实际 {size} 字节",
        )

    try:
        # 先写临时文件再改名：中途断电不会留下半个配置
        temp = target.with_suffix(".json.tmp")
        temp.write_text(text, encoding="utf-8")
        temp.replace(target)
    except OSError as exc:
        raise M8Error(
            "M8-CAM-003",
            message=f"配置写不进去：{clean}",
            hint="检查 m8/data/camera-configs/ 的写权限",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    log(f"已保存配置 {clean}（{len(text)} 字符）", SHELF_CAM)
    return clean


def load(name: str) -> Any:
    """读一份配置。读不到或不是合法 JSON 都带码报出来。"""
    clean = _safe_name(name)
    target = config_dir() / f"{clean}.json"
    if not target.is_file():
        raise M8Error(
            "M8-CAM-005",
            message=f"没有这个配置：{clean}",
            hint="点下拉重新拉一遍列表，或另存一份",
            detail=f"找不到文件：{target}",
        )
    try:
        text = target.read_text("utf-8")
    except OSError as exc:
        raise M8Error(
            "M8-CAM-003",
            message=f"配置读不出来：{clean}",
            hint="文件可能被占用或权限不对",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    try:
        return json.loads(text)
    except ValueError as exc:
        raise M8Error(
            "M8-CAM-001",
            message=f"配置 {clean} 不是合法 JSON",
            hint="直接用编辑器打开 m8/data/camera-configs/ 下那个文件改回来",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc


__all__ = ["available", "save", "load", "config_dir", "MAX_CONFIG_BYTES"]
