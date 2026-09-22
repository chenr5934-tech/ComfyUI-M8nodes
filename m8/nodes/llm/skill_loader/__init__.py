"""M8 · Skill 装载 —— 功能包。

一个功能一个文件夹。这个目录里的所有东西都属于「Skill 装载」这一个节点。
文件管理本身在 m8/server/skills.py（那是接口货架的事），
这个包里只有节点自己的逻辑。

对外只暴露两个 MAPPING，由货架 __init__.py 自动收集。
"""

from .node import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
