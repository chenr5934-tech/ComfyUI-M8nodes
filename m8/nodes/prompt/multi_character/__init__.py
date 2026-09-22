"""M8 · 多角色编辑 —— 功能包。

一个功能一个文件夹：这个目录里的所有东西都属于「多角色编辑」这一个节点。
节点实现在 node.py；以后要加区域预设、角色模板，也放这里，
不要去动别的功能的目录 —— 改一个功能只该翻一个文件夹。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
