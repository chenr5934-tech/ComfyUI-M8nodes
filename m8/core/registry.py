"""货架注册中心。

M8 的所有节点都住在 m8/nodes/<货架>/ 里。这个模块负责把它们收集起来，
拼成 ComfyUI 要的 NODE_CLASS_MAPPINGS。

为什么用扫描而不是手写清单：
  加一个货架、一个节点，只要它自己的 __init__.py 导出了 MAPPING，这里就自动收得到。
  根入口永远不会因为「忘了登记」而漏节点 —— 那种 bug 在 ComfyUI 里表现为
  「节点在图里显示成红色未知节点」，排查起来很费劲。

单个货架导入失败**不影响其他货架**：失败记进 failures，启动横幅里列出来，
再抛一条 M8-CORE-001 的日志。这样坏了一个货架，剩下的照样能用。
"""

from __future__ import annotations

import importlib
from dataclasses import dataclass, field
from types import ModuleType

from . import paths
from .errors import M8Error
from .log import SHELF_CORE, error, log, warn

NODES_PACKAGE = f"{__package__.rsplit('.', 1)[0]}.nodes"


@dataclass
class ShelfInfo:
    """一个货架的加载结果。"""

    name: str
    module: ModuleType | None = None
    class_mappings: dict = field(default_factory=dict)
    display_mappings: dict = field(default_factory=dict)
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.module is not None and not self.error

    @property
    def node_count(self) -> int:
        return len(self.class_mappings)


@dataclass
class MappingBundle:
    """一次目录扫描的结果。"""

    classes: dict = field(default_factory=dict)
    names: dict = field(default_factory=dict)
    failed: dict = field(default_factory=dict)  # 子包名 -> 错误描述


@dataclass
class RegistryResult:
    """整个插件收集完的结果。"""

    class_mappings: dict = field(default_factory=dict)
    display_mappings: dict = field(default_factory=dict)
    shelves: list[ShelfInfo] = field(default_factory=list)

    @property
    def ok_shelves(self) -> list[ShelfInfo]:
        return [s for s in self.shelves if s.ok]

    @property
    def failed_shelves(self) -> list[ShelfInfo]:
        return [s for s in self.shelves if not s.ok]


def collect_subpackages(directory, package: str) -> MappingBundle:
    """扫一个目录下的子包，收集每个子包导出的两个 MAPPING。

    目录约定是两层的，但扫描逻辑只有这一份：

        货架层   m8/nodes/          扫出各货架   （registry.collect 调用）
        功能层   m8/nodes/<货架>/    扫出各功能   （货架自己的 __init__.py 调用）

    「一个功能一个文件夹」能长期成立，靠的就是这个函数 ——
    加功能时只需要建文件夹，两层清单都不用回去手改。

    单个子包导入失败不拖垮别人：记进 failed 让上层去报，其余照常收。
    """
    bundle = MappingBundle()
    if not directory.is_dir():
        return bundle

    for entry in sorted(directory.iterdir(), key=lambda p: p.name):
        if not entry.is_dir() or entry.name.startswith(("_", ".")):
            continue
        if not (entry / "__init__.py").is_file():
            continue  # 没有 __init__.py 的目录不是功能包（可能只是放素材的）

        try:
            module = importlib.import_module(f".{entry.name}", package=package)
        except Exception as exc:  # noqa: BLE001 单个功能坏了不该拖垮整层
            bundle.failed[entry.name] = f"{type(exc).__name__}: {exc}"
            continue

        classes = getattr(module, "NODE_CLASS_MAPPINGS", None)
        if isinstance(classes, dict) and classes:
            bundle.classes.update(classes)
            bundle.names.update(getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {})

    return bundle


def discover_shelf_names() -> list[str]:
    """列出 nodes/ 下的货架目录名。下划线开头的算私有，跳过。"""
    nodes_dir = paths.PACKAGE_DIR / "nodes"
    if not nodes_dir.is_dir():
        return []
    return sorted(
        entry.name
        for entry in nodes_dir.iterdir()
        if entry.is_dir() and not entry.name.startswith("_") and (entry / "__init__.py").is_file()
    )


def load_shelf(name: str) -> ShelfInfo:
    """导入一个货架，取它的两个 MAPPING。

    货架没导出 MAPPING 不算错 —— 它可能只是个共享代码目录，跳过就是。
    """
    info = ShelfInfo(name=name)
    try:
        module = importlib.import_module(f".{name}", package=NODES_PACKAGE)
    except Exception as exc:  # noqa: BLE001 —— 货架导入期什么都可能炸，一律隔离
        wrapped = M8Error(
            "M8-CORE-001",
            message=f"货架 {name} 导入失败",
            detail=f"{type(exc).__name__}: {exc}",
        )
        info.error = wrapped.format_for_node()
        error(f"{wrapped.message}\n{wrapped.format_for_node()}", SHELF_CORE)
        return info

    info.module = module
    class_mappings = getattr(module, "NODE_CLASS_MAPPINGS", None)
    if isinstance(class_mappings, dict) and class_mappings:
        info.class_mappings = class_mappings
        info.display_mappings = getattr(module, "NODE_DISPLAY_NAME_MAPPINGS", {}) or {}
    return info


def collect() -> RegistryResult:
    """加载全部货架并合并。

    节点类名重复记 M8-CORE-002 并**跳过后来者**：日志和 /m8/health 里都会写明，
    但不让整个插件起不来。理由 —— 坏一个名字导致所有节点都不可用，
    比「其中一个节点没出现」的损失大得多。
    """
    result = RegistryResult()
    for name in discover_shelf_names():
        info = load_shelf(name)
        result.shelves.append(info)
        if not info.ok:
            continue

        for node_name, node_class in info.class_mappings.items():
            if node_name in result.class_mappings:
                owner = next(
                    (s.name for s in result.shelves if node_name in s.class_mappings and s.name != name),
                    "未知",
                )
                warn(
                    f"[M8-CORE-002] 节点类名重复，跳过后来者：{node_name}"
                    f"（货架 {owner} 和 {name} 都注册了它，改一个名字即可）",
                    SHELF_CORE,
                )
                continue
            result.class_mappings[node_name] = node_class
            result.display_mappings[node_name] = info.display_mappings.get(node_name, node_name)

        log(f"货架 {name}：{info.node_count} 个节点 [{', '.join(info.class_mappings)}]", SHELF_CORE)

    if result.failed_shelves:
        names = ", ".join(s.name for s in result.failed_shelves)
        warn(f"有货架没加载起来：{names}（其余货架照常可用）", SHELF_CORE)

    return result
