"""界面扩展货架。

和 m8/nodes/ 平级的另一类货架：这里的东西**不产出节点**，
它们改变的是 ComfyUI 界面本身（侧边栏、悬浮挂件、对话框）。

分类依据和节点货架一样 —— 按「它干的活」分，不按「它跟谁长得像」：

    ui/whale/    小鲸鱼：余额挂件 + 对话窗口

为什么不塞进 m8/nodes/：那边的约定是「一个子目录 = 一个节点」，
货架收集器取的是 NODE_CLASS_MAPPINGS。界面扩展没有节点类，
混进去会让那条约定失效，以后看目录就分不清哪些是能拖进画布的节点。

收集方式和节点货架一致：扫子目录，逐个调用它们的 register(server)。
加一个界面扩展就是加一个文件夹，入口不用改。
"""

from __future__ import annotations

import importlib
from pathlib import Path
from typing import Any

from ..core.errors import M8Error
from ..core.log import SHELF_CORE, error, log, warn

EXTENSIONS_PACKAGE = __name__


def discover_extension_names() -> list[str]:
    """列出 ui/ 下的扩展目录名。下划线开头的是私有，跳过。"""
    here = Path(__file__).parent
    return sorted(
        entry.name
        for entry in here.iterdir()
        if entry.is_dir()
        and not entry.name.startswith(("_", "."))
        and (entry / "__init__.py").is_file()
    )


def collect_extensions(server: Any = None) -> int:
    """加载全部界面扩展，逐个注册它们的接口。

    单个扩展坏掉不影响别的：记下来继续走。界面扩展挂了顶多是少一个挂件，
    不该让整个插件起不来。

    返回总共挂了几条接口。
    """
    total = 0
    for name in discover_extension_names():
        try:
            module = importlib.import_module(f".{name}", package=EXTENSIONS_PACKAGE)
        except Exception as exc:  # noqa: BLE001 扩展导入期什么都可能炸
            wrapped = M8Error(
                "M8-CORE-001",
                message=f"界面扩展 {name} 导入失败",
                detail=f"{type(exc).__name__}: {exc}",
            )
            error(wrapped.format_for_node(), SHELF_CORE)
            continue

        register = getattr(module, "register", None)
        if not callable(register):
            warn(f"界面扩展 {name} 没有 register(server)，跳过", SHELF_CORE)
            continue

        try:
            count = register(server) or 0
        except Exception as exc:  # noqa: BLE001
            error(f"界面扩展 {name} 注册失败：{type(exc).__name__}: {exc}", SHELF_CORE)
            continue

        total += count
        log(f"界面扩展 {name}：挂了 {count} 条接口", SHELF_CORE)

    return total


__all__ = ["collect_extensions", "discover_extension_names"]
