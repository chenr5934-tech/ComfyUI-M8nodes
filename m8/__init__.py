"""M8 节点包的后端实现。

    core/    地基：错误、日志、路径、配置、货架注册
    server/  接口：模型列表、skill 文件、密钥
    nodes/   节点，按货架分目录
    utils/   跨货架复用的纯函数

前端在 js/，由根 __init__.py 的 WEB_DIRECTORY 指给 ComfyUI。
"""

from . import core, nodes, server

__all__ = ["core", "nodes", "server"]
