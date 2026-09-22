"""M8 · 相机控制 —— 功能包。

一个功能一个文件夹：这个目录里的所有东西都属于「相机控制」这一个节点。
节点实现在 node.py；算法、默认配置、以后要加的角度预设都放这里，
不要去动别的功能的目录 —— 改一个功能只该翻一个文件夹。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
