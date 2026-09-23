"""M8 节点包 · ComfyUI 插件入口。

这个文件只做四件事，别的都不做：
    1. 建好运行时目录
    2. 让 registry 扫描各货架，收集节点
    3. 把接口挂到 ComfyUI 的 aiohttp 上
    4. 打一条启动横幅

**不要在这里 import 具体节点类** —— 加节点应该只改货架目录里的文件。
这个入口如果开始感受到「每次加节点都要回来改」，说明货架设计被破坏了。

设计取舍：单个货架导入失败不会导致整个插件起不来，失败信息会打在横幅上。
坏一个货架还能用其余的，比全崩了好。
"""

from __future__ import annotations

from .m8.core import banner, paths
from .m8.core.errors import M8Error
from .m8.core.log import SHELF_CORE, error
from .m8.core.registry import collect
from .m8.server import routes
from .m8.ui import collect_extensions

VERSION = "0.4.4"

# 1. 运行时目录（密钥、skill、缓存都住这儿）
paths.ensure_data_dirs()

# 2. 收集货架。重名之类的硬错误在这里已经按「警告 + 跳过」处理过，
#    所以正常情况下不会抛出来。
try:
    _registry = collect()
except M8Error as exc:  # noqa: PERF203 兜底，保证插件至少能被导入
    error(exc.format_for_node(), SHELF_CORE)
    _registry = None

if _registry is None:
    NODE_CLASS_MAPPINGS: dict = {}
    NODE_DISPLAY_NAME_MAPPINGS: dict = {}
    _shelves: list[str] = []
else:
    NODE_CLASS_MAPPINGS = _registry.class_mappings
    NODE_DISPLAY_NAME_MAPPINGS = _registry.display_mappings
    _shelves = [shelf.name for shelf in _registry.ok_shelves]

# 3. 接口。没有 PromptServer 时返回 0，不抛 —— 节点本身仍可用。
_runtime = {
    "shelves": [
        {
            "name": shelf.name,
            "nodes": list(shelf.class_mappings),
            "ok": shelf.ok,
            "error": shelf.error,
        }
        for shelf in (_registry.shelves if _registry else [])
    ],
    "nodeCount": len(NODE_CLASS_MAPPINGS),
}
routes.set_runtime_info(_runtime)
_RouteCount = routes.register_all()

# 3b. 界面扩展。它们不产出节点，所以走另一条收集路径（m8/ui/），
#     但接口是挂在同一个 PromptServer 上的。
_ExtensionCount = collect_extensions(routes.get_server())
_RouteCount += _ExtensionCount
_runtime["routeCount"] = _RouteCount
_runtime["extensionRoutes"] = _ExtensionCount

# 4. 横幅
banner(VERSION, _shelves, len(NODE_CLASS_MAPPINGS), _RouteCount)

# ComfyUI 从这里读前端目录；js/ 下的文件会在页面加载时被自动注入
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
