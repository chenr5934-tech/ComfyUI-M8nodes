"""M8 接口层：后端 HTTP。

浏览器直接调外部大模型会被 CORS 拦，也读不了本地磁盘，
所以这些活儿全在后端做，前端只负责显示和触发。
"""

from . import llm_api, providers, routes, skills

__all__ = ["llm_api", "providers", "routes", "skills"]
