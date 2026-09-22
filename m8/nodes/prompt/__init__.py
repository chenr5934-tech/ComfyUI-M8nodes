"""提示词货架。

两层目录：本目录是货架，下面每个子目录是一个**功能**（一个节点一个文件夹）。
划分与边界见 docs/ROADMAP.md；目录约定见 docs/CONVENTIONS.md。

这个货架管的是「提示词的结构」—— 谁在画面哪块、占多重、怎么拼成一段话。
它不认识模型，也不碰潜空间；输出永远是字符串。

和相邻货架的边界：
  - TXT 管通用文本处理（替换、正则、分行），不理解「角色」「区域」这些概念
  - CAM 管机位取景，输出的是镜头语言
  - 本货架管画面里有什么、各自在哪 —— 组合关系，不是拍摄参数

收集工作交给 core.registry.collect_subpackages，这里不做任何手工登记。
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
