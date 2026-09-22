"""M8 地基：错误、日志、路径、配置、货架注册。

这里不包含任何节点。节点住在 m8/nodes/<货架>/ 里。
"""

from .errors import M8Error, describe, wrap
from .log import log, warn, error, banner

__all__ = ["M8Error", "describe", "wrap", "log", "warn", "error", "banner"]
