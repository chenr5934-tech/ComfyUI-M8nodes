"""M8 · 本地大模型推理 —— 功能包。

一个功能一个文件夹：这个目录里的东西都属于「本地大模型推理」这一个节点。
models.py 管模型发现和加载（带缓存），node.py 是节点本身。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
