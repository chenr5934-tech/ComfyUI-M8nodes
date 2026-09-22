"""桌面快捷方式。

浏览器自己做不到这件事 —— 网页 JS 压根没有写文件系统的权限。所以走服务端：
后端就跑在用户自己的机器上，往桌面写一个文件完事。

**为什么是 .bat，不是 .lnk**

  .lnk 是二进制格式，Windows 上只有 COM 生成得出来 —— 也就是必须请 PowerShell
  出面。而「一个网络请求就能在本机创建进程」这件事，无论脚本参数怎么固定，
  都是安全上最先被盯的点。这个插件被审核退回过，理由正是「remotely triggerable」，
  审核者还特意点明：**只检查请求来源是不是本机没用** —— 请求本来就发自用户自己
  的机器（他浏览器里任何一个页面都能发出去）。

  所以这里改成纯 Python 往桌面写一个很小的 .bat。零外部进程、零命令拼接。
  它能做的最坏的事就是「往桌面多放一个文件」，而文件名是净化过的、落点钉死在
  桌面目录里。

  代价：图标不能自定义（.bat 用系统默认图标），原来 .lnk 能设成网页那张 favicon。
  这个取舍是有意的。

**为什么不干脆指向本地的 M8web/index.html**
  工作台必须走 http 才有得用：用 file:// 打开时浏览器会把每个本地文件当成独立的
  源，页面往后端发的请求全落空，看到的是一片空白。所以桌面这个脚本要先拉起本地
  服务再开浏览器。地址由前端把当前 location 传过来，ComfyUI 挂在子路径或者换了
  端口也都对得上。
"""

from __future__ import annotations

import os
from pathlib import Path

from ..core import paths
from ..core.errors import M8Error

DEFAULT_NAME = "M8工作台"

# Windows 文件名里不许出现的字符
_BAD_CHARS = set('\\/:*?"<>|')


def desktop_dir() -> Path:
    """桌面在哪儿。

    优先问注册表 —— 中文 Windows 上桌面经常被重定向到 OneDrive 或者别的盘，
    硬拼 ~/Desktop 会写到不存在的地方，或者写到另一个同名的目录里去。
    """
    if os.name == "nt":
        try:
            import winreg  # 只有 Windows 才有这个模块

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
            ) as key:
                value, _ = winreg.QueryValueEx(key, "Desktop")
            if value:
                return Path(value)
        except Exception:
            # 注册表读不到就退回默认位置，不算错误
            pass
    return Path.home() / "Desktop"


def safe_name(name: str) -> str:
    """把用户给的名字收拾成能当文件名的样子。"""
    clean = "".join(
        c for c in str(name or "") if c not in _BAD_CHARS and ord(c) >= 32
    ).strip()
    # Windows 不允许文件名以点或空格结尾
    clean = clean.rstrip(". ")
    return clean[:48] or DEFAULT_NAME


def launcher_path() -> Path:
    """启动脚本在哪。它就在插件里，所以位置是确定的。"""
    return paths.PLUGIN_DIR / "M8web" / "start-workbench.bat"


def confined(path: Path, base: Path) -> Path:
    """把路径钉死在 base 里，返回它的真实路径。

    先 resolve 拿到真实路径（符号链接和上级跳转都会被展开），再确认它确实落在
    base 内部 —— 审核者点名要求的就是这个做法（realpath 之后再比 commonpath 的
    等价形式）。自己拼字符串检查有没有上级跳转是不够的：符号链接和 Windows 的
    8.3 短名都能绕过去。
    """
    real = path.resolve()
    root = base.resolve()
    if real != root and root not in real.parents:
        raise M8Error(
            "M8-WEB-011",
            message="目标路径不在允许的目录里",
            hint="这是内部调用出错，正常从工作台点按钮不会走到这儿",
            detail=str(path),
        )
    return real


def make_desktop_script(target: Path, clean: str) -> Path:
    """在桌面放一个 .bat，双击把工作台拉起来。

    **纯 Python 写文件，不起任何外部进程。** 这是这个功能唯一安全的形态：
    任何能访问 ComfyUI 的页面都能发这个请求，所以这个动作本身必须无害。

    脚本存成 GBK：cmd 解析 .bat 走的是系统代码页，跟文件里写不写 chcp 无关，
    而目标路径里可能有中文（用户名或整合包目录带中文都很常见）。
    """
    launcher = launcher_path()
    script = confined(target / (clean + ".bat"), target)
    text = "@echo off\r\n" + 'call "' + str(launcher) + '"\r\n'
    try:
        script.write_bytes(text.encode("gbk", "replace"))
    except OSError as exc:
        raise M8Error(
            "M8-WEB-006",
            message="写桌面脚本失败",
            hint="桌面上是不是已经有一个同名的只读文件？删掉它再试",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    return script


def make_shortcut(url: str, name: str = DEFAULT_NAME) -> Path:
    """在桌面放一个工作台入口，返回写出来的路径。

    首选**桌面 .bat**：双击它会把本地服务拉起来再开浏览器，所以 ComfyUI 开不开
    都能用 —— 这是这个功能的本意。

    桌面写不进去（只读、被组策略挡住）才退回 .url。.url 是纯文本好生成，但它只能
    指向一个 http 地址，意味着得先有人把服务起起来，CUI 关着的时候照样打不开。
    """
    target = desktop_dir()
    if not target.is_dir():
        raise M8Error(
            "M8-WEB-004",
            message="找不到桌面目录",
            hint="确认当前用户有桌面；桌面被挪到 OneDrive 的话，先打开一次文件资源管理器让它建出来",
            detail=str(target),
        )

    clean = safe_name(name)
    if launcher_path().is_file():
        try:
            return make_desktop_script(target, clean)
        except M8Error:
            pass          # 桌面写不进去，走下面的 .url 兜底
    return make_url_shortcut(target, clean, url)


def make_url_shortcut(target: Path, clean: str, url: str) -> Path:
    """兜底：在桌面放一个 .url。

    只在 .lnk 做不出来的时候走这儿。它的问题很明确 —— 只能指向一个 http
    地址，所以**得先有人把服务起起来**才不会打不开。CUI 关着的时候，
    这条路本身是通的（服务在跑就行），但双击它不会帮你把服务拉起来。
    """
    link = str(url or "").strip()
    if not link.startswith(("http://", "https://")):
        raise M8Error(
            "M8-WEB-005",
            message="地址不合法",
            hint="只接受 http 或 https 开头的地址",
            detail=link[:120],
        )

    path = target / (clean + ".url")
    # .url 是 INI 形式，行尾用 CRLF。内容全是 ASCII，编码不影响解析。
    # newline="" 是必须的 —— 不然 Python 会把我们写好的 \r\n 再转一遍。
    body = "[InternetShortcut]\r\nURL=" + link + "\r\n"
    try:
        path.write_text(body, encoding="utf-8", newline="")
    except OSError as exc:
        raise M8Error(
            "M8-WEB-006",
            message="写快捷方式失败",
            hint="桌面上是不是已经有一个同名的只读文件？删掉它再试",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    return path


__all__ = [
    "DEFAULT_NAME",
    "desktop_dir",
    "safe_name",
    "confined",
    "make_shortcut",
    "make_desktop_script",
]
