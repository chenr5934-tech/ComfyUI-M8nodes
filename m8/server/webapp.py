"""M8 网页的静态文件服务。

把 M8web/ 下的文件通过 /m8/web/ 提供出去。

为什么不用 ComfyUI 的 WEB_DIRECTORY：那个目录是给**前端扩展脚本**用的，
ComfyUI 会把它整个当插件资源扫。网页是给人看的独立站点，和节点扩展不是一回事，
混在一起以后两边都不好找。所以单开一个 M8web/，走自己的路由。

安全：只服务 M8web/ 目录内的文件。路径里的 .. 会被解析后与根目录比对，
拒绝任何越界访问 —— 否则一个 URL 就能读到磁盘上任意文件。
"""

from __future__ import annotations

import mimetypes
from pathlib import Path

from aiohttp import web

from ..core import paths
from ..core.errors import M8Error

# 只允许这些后缀，别的就算在目录里也不给（避免误把 .py 之类读出去）
ALLOWED_SUFFIXES = {
    ".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg",
    ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".txt",
}


def resolve(rel: str) -> Path:
    """把 URL 里的相对路径解析成 M8web 下的真实文件。越界或后缀不允许就抛。"""
    root = paths.WEBAPP_DIR.resolve()
    clean = str(rel or "").strip().lstrip("/")
    if not clean:
        clean = "index.html"

    target = (root / clean).resolve()
    # 关键：解析完（.. 已经展开）之后必须在根目录里面
    if root != target and root not in target.parents:
        raise M8Error(
            "M8-WEB-001",
            message="网页资源路径越界",
            hint="URL 里不要带 ..",
            detail=f"请求：{rel!r} → 解析到 {target}",
        )
    if target.suffix.lower() not in ALLOWED_SUFFIXES:
        raise M8Error(
            "M8-WEB-002",
            message="不允许的网页资源类型",
            hint="只服务 html/css/js/图片/字体这类静态资源",
            detail=f"后缀：{target.suffix}",
        )
    return target


async def serve(rel: str) -> web.Response:
    """按相对路径取文件。失败一律抛 M8Error。

    这里**不碰 HTTP 层的错误包装** —— 那是 routes.py 的活。
    早先这里用函数内导入去拿 routes 的 _err，等于两个模块互相依赖绕圈，
    还跨模块用了别人的私有名；现在分开了，谁都不依赖谁。
    """
    target = resolve(rel)

    if target.is_dir():
        target = target / "index.html"
    if not target.is_file():
        raise M8Error(
            "M8-WEB-003",
            message=f"网页里没有这个文件：{rel}",
            hint="从首页点进去；手输 URL 的话确认拼写",
            detail=f"实际找的是 {target}",
        )

    # 开发期一律不缓存：改完刷新就能看到，不用清缓存猜
    ctype, _ = mimetypes.guess_type(str(target))
    suffix = target.suffix.lower()
    if suffix in (".html", ".css", ".js"):
        ctype = {"html": "text/html", "css": "text/css", "js": "text/javascript"}[suffix.lstrip(".")]
    headers = {"Cache-Control": "no-cache"}
    if ctype:
        headers["Content-Type"] = ctype + ("; charset=utf-8" if ctype.startswith("text/") else "")
    return web.FileResponse(target, headers=headers)


__all__ = ["handle_static", "resolve", "ALLOWED_SUFFIXES"]
