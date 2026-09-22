"""角色配置预设的存取。

一份预设一个 json，放在 m8/data/prompt-presets/ 下，文件名就是预设名。

和相机货架的 camera_configs.py 是同一套做法，理由也一样：预设会有很多份
（双人 / 群像 / 风景+人物…），用户会想直接改文件、想拷给别人 —— 文件天然满足，
塞进一个大 json 里就得额外做导入导出。

安全：预设名会拼进文件路径，必须净化。只允许中英文、数字、下划线、连字符和点，
其余换成下划线；再挡一次 ".." 和绝对路径。这里少写一行，别人就能靠一个名字
读写磁盘上任意位置。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from ..core import paths
from ..core.errors import M8Error
from ..core.log import SHELF_PROMPT, log

# 一份预设就是角色数组加几个字段，几十 KB 顶天了
MAX_PRESET_BYTES = 512 * 1024

_SAFE = re.compile(r"[^0-9A-Za-z_\-\u4e00-\u9fff.]")


def _safe_name(name: str) -> str:
    """净化预设名。空名、纯点、带分隔符的一律挡掉。"""
    raw = str(name or "").strip()
    # 先干掉分隔符和上跳 —— 正则只管字符集，挡不住 ".."
    raw = raw.replace("/", "_").replace("\\", "_")
    clean = _SAFE.sub("_", raw).lstrip(".")
    if not clean:
        raise M8Error(
            "M8-PROMPT-005",
            message="预设名不合法",
            hint="用中英文、数字、下划线或连字符，别带斜杠",
            detail=f"原始输入：{name!r}",
        )
    return clean[:64]


def preset_dir() -> Path:
    """预设目录，不存在就建。"""
    try:
        paths.PROMPT_PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise M8Error(
            "M8-PROMPT-006",
            message="建不出预设目录",
            hint="检查 m8/data/ 的写权限",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    return paths.PROMPT_PRESETS_DIR


def available() -> list[str]:
    """列出已有的预设名（不带后缀），按名字排序。"""
    folder = preset_dir()
    return [
        entry.stem
        for entry in sorted(folder.iterdir(), key=lambda p: p.name)
        if entry.is_file() and entry.suffix.lower() == ".json"
    ]


def save(name: str, config: Any) -> str:
    """存一份预设。返回净化后的名字。"""
    clean = _safe_name(name)
    target = preset_dir() / f"{clean}.json"

    text = json.dumps(config, ensure_ascii=False, indent=2)
    size = len(text.encode("utf-8"))
    if size > MAX_PRESET_BYTES:
        raise M8Error(
            "M8-PROMPT-006",
            message="预设太大，存不下",
            hint=f"上限 {MAX_PRESET_BYTES // 1024} KB；正常预设只有几 KB",
            detail=f"实际 {size} 字节",
        )

    try:
        # 先写临时文件再改名：中途出错不会留下半个预设
        temp = target.with_suffix(".json.tmp")
        temp.write_text(text, encoding="utf-8")
        temp.replace(target)
    except OSError as exc:
        raise M8Error(
            "M8-PROMPT-006",
            message=f"预设写不进去：{clean}",
            hint="检查 m8/data/prompt-presets/ 的写权限",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    log(f"已保存预设 {clean}（{size} 字节）", SHELF_PROMPT)
    return clean


def load(name: str) -> Any:
    """读一份预设。读不到或不是合法 JSON 都带码报出来。"""
    clean = _safe_name(name)
    target = preset_dir() / f"{clean}.json"
    if not target.is_file():
        raise M8Error(
            "M8-PROMPT-007",
            message=f"没有这个预设：{clean}",
            hint="点下拉重新拉一遍列表，或者另存一份",
            detail=f"找不到文件：{target}",
        )

    try:
        text = target.read_text("utf-8")
    except OSError as exc:
        raise M8Error(
            "M8-PROMPT-006",
            message=f"预设读不出来：{clean}",
            hint="文件可能被占用或权限不对",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    try:
        return json.loads(text)
    except ValueError as exc:
        raise M8Error(
            "M8-PROMPT-001",
            message=f"预设 {clean} 不是合法 JSON",
            hint="直接用编辑器打开 m8/data/prompt-presets/ 下那个文件改回来",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc


def remove(name: str) -> str:
    """删掉一份预设。返回净化后的名字。"""
    clean = _safe_name(name)
    target = preset_dir() / f"{clean}.json"
    if not target.is_file():
        raise M8Error(
            "M8-PROMPT-007",
            message=f"没有这个预设：{clean}",
            hint="列表可能已经过期，点下拉重新拉一遍",
            detail=f"找不到文件：{target}",
        )
    try:
        target.unlink()
    except OSError as exc:
        raise M8Error(
            "M8-PROMPT-006",
            message=f"预设删不掉：{clean}",
            hint="文件可能被占用",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    log(f"已删除预设 {clean}", SHELF_PROMPT)
    return clean


__all__ = ["available", "save", "load", "remove", "preset_dir", "MAX_PRESET_BYTES"]
