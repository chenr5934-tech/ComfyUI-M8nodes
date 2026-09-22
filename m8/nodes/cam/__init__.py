"""相机货架。

两层目录：本目录是货架，下面每个子目录是一个**功能**（一个节点一个文件夹）。
划分与边界见 docs/ROADMAP.md；目录约定见 docs/CONVENTIONS.md。

这个货架管的是「把抽象的取景意图翻译成提示词」—— 相机位姿是数值，
模型只认文字，中间这层翻译就是本货架存在的理由。它不采样、不加载、不碰像素，
只产出字符串交给下游。

收集工作交给 core.registry.collect_subpackages，这里不做任何手工登记 ——
加一个功能就是加一个文件夹，不用回来改这个文件。
"""

from __future__ import annotations

from pathlib import Path

from ...core.registry import collect_subpackages

_bundle = collect_subpackages(Path(__file__).parent, __name__)

NODE_CLASS_MAPPINGS = _bundle.classes
NODE_DISPLAY_NAME_MAPPINGS = _bundle.names

# 哪个功能包没导入成功，键是文件夹名。启动横幅和 /m8/health 会用到。
FAILED_MODULES = _bundle.failed

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "FAILED_MODULES"]
