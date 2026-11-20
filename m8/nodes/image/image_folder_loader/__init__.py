"""M8 · 文件夹读图 —— 功能包。

一个功能一个文件夹：这个目录里的所有东西都属于「文件夹读图」这一个节点。
节点实现在 node.py。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
