"""M8 · 大模型推理 —— 功能包。

一个功能一个文件夹：这个目录里的所有东西都属于「大模型推理」这一个节点。
节点实现在 node.py；以后这个节点要加专属的解析器、schema、单测，也放在这里，
不要去动别的功能的目录 —— 改一个功能只该翻一个文件夹，这是目录约定的全部意义。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
