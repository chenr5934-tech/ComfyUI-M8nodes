"""M8 · 破甲注入 —— 功能包。

一个功能一个文件夹。这个目录里的所有东西都属于「破甲注入」这一个节点：
prompts.py 是它的文案库，node.py 是它的逻辑。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
