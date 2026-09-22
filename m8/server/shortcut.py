"""桌面快捷方式。

浏览器自己做不到这件事 —— 网页 JS 压根没有写文件系统的权限。所以走服务端：
后端就跑在用户自己的机器上，往桌面写一个文件完事。

**优先做 .lnk，指向插件里的启动脚本；做不出来才退回 .url。**
  .lnk 双击会把本地服务拉起来再开浏览器，所以 ComfyUI 开不开都能用 —— 这是这个
  功能的本意。代价是 .lnk 属于二进制格式，只能请 PowerShell 出面调 COM 去生成。
  .url 是纯文本、一行 URL 就够、不挑系统语言，但它只能指向一个 http 地址：
  得先有人把服务起起来，CUI 关着的时候照样打不开。所以它只当兜底。

**为什么不干脆指向本地的 M8web/index.html**
  工作台必须走 http 才有得用：用 file:// 打开时浏览器会把每个本地文件当成独立的
  源，页面往后端发的请求全落空，看到的是一片空白。

  （早先这儿的理由是「数据存在 IndexedDB 里、IndexedDB 挂在源上」—— 那条现在
  已经不成立了：数据搬到了服务端的 <ComfyUI>/models/M8data/webapp/ 下面，
  换浏览器、换机器都还在。但「必须走 http」这条没变。）

  地址由前端把当前 location 传过来，这样 ComfyUI 挂在子路径或者换了端口也都对得上。
"""

from __future__ import annotations

import os
import subprocess
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


def icon_path() -> Path:
    """桌面图标的图。和网页那个 favicon 是同一张 —— 网页渲染成 PNG 再包成 ico。

    .lnk 只认 .ico，不认 svg，所以那份 ico 是离线生成好放进仓库的
    （assets/img/favicon.ico），不是运行时转的。
    """
    return paths.PLUGIN_DIR / "M8web" / "assets" / "img" / "favicon.ico"


def _ps_quote(text: str) -> str:
    """PowerShell 单引号字符串里的转义规则：把单引号写成两个。"""
    return str(text).replace("'", "''")


def make_lnk(lnk: Path, target: Path, workdir: Path) -> bool:
    """用 PowerShell 生成一个 .lnk，指向 target。成功返回 True。

    .lnk 是二进制格式，只能靠 COM 生成 —— 也就是得请 PowerShell 出面。
    不装 PowerShell 或者被组策略挡了的机器上会失败，那就走 .url 兜底。
    """
    script = (
        "$ws = New-Object -ComObject WScript.Shell; "
        "$sc = $ws.CreateShortcut('" + _ps_quote(lnk) + "'); "
        "$sc.TargetPath = '" + _ps_quote(target) + "'; "
        "$sc.WorkingDirectory = '" + _ps_quote(workdir) + "'; "
        "$sc.Description = 'M8 工作台'; "
    )
    # 图标跟网页那个一致。ico 不在（被人删了之类）就不设，用默认图标也行
    ico = icon_path()
    if ico.is_file():
        script += "$sc.IconLocation = '" + _ps_quote(ico) + "'; "
    script += "$sc.Save()"
    flags = 0x08000000 if os.name == "nt" else 0   # CREATE_NO_WINDOW：别闪黑框
    try:
        done = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, timeout=30, creationflags=flags,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0 and lnk.is_file()


def make_shortcut(url: str, name: str = DEFAULT_NAME) -> Path:
    """在桌面放一个快捷方式，返回写出来的路径。

    优先做**指向启动脚本的 .lnk** —— 双击它会把本地服务拉起来再开浏览器，
    所以 ComfyUI 开不开都能用。这是这个功能的本意。

    .lnk 做不出来才退回 .url。.url 是纯文本好生成，但它只能指向一个 http
    地址，意味着得先有人把服务起起来 —— 那样 CUI 关着的时候照样打不开。
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
    bat = launcher_path()
    if bat.is_file():
        lnk = target / (clean + ".lnk")
        if make_lnk(lnk, bat, bat.parent):
            return lnk
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


__all__ = ["DEFAULT_NAME", "desktop_dir", "safe_name", "make_shortcut"]
