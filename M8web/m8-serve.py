#!/usr/bin/env python
"""M8 工作台的独立服务。

工作台的数据是挂在「源」（协议+主机+端口）上的。CUI 在跑的时候那个源是
http://127.0.0.1:8188/m8/web/，CUI 一关源就没了。

这个服务给工作台一个自己的家门：固定端口，跟 CUI 有没有在跑无关。
它和 CUI 读写的是**同一份文件**（<ComfyUI>/models/M8data/webapp/*.json），
所以从哪个门进去看到的东西都一样。

只用标准库，不需要 ComfyUI，也不需要装任何包 —— 它必须能在 CUI 不在时自己跑起来。

用法：
    python m8-serve.py            # 默认 127.0.0.1:8199
    python m8-serve.py 9000       # 换端口
"""

from __future__ import annotations

import json
import mimetypes
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

HERE = Path(__file__).resolve().parent          # .../M8web
PLUGIN_DIR = HERE.parent                         # 插件根
sys.path.insert(0, str(PLUGIN_DIR))

from m8.core import paths, webdata                # noqa: E402
from m8.core.errors import M8Error                # noqa: E402
from m8.server import shortcut                    # noqa: E402

DEFAULT_PORT = 8199
WEB_PREFIX = "/m8/web"
DATA_PREFIX = "/m8/data"

# 和 webapp.py 同一份白名单
ALLOWED = {".html", ".css", ".js", ".json", ".svg", ".png", ".jpg", ".jpeg",
           ".webp", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".txt"}
JSON_CT = "application/json; charset=utf-8"


def load_data_dir() -> Path:
    """数据目录在哪儿。

    独立服务没有 ComfyUI 环境，自己推的话又可能被 junction 骗到（插件的真实
    路径不在 custom_nodes 下）。所以先读 CUI 留下的路标文件，那个是它用
    folder_paths 算出来的，最准。读不到再退回 paths 的推导结果。
    """
    pointer = paths.DATA_POINTER_FILE
    try:
        if pointer.is_file():
            got = pointer.read_text(encoding="utf-8").strip()
            if got:
                d = Path(got)
                # 路标是 CUI 上次启动时写的，记的是**绝对路径**。ComfyUI 被挪走、
                # 改名，或者 models 被 extra_model_paths.yaml 指到别处之后，它就过期了。
                # 照着过期路径走会在这儿新建一个空目录 —— 用户打开工作台看到空荡荡的
                # 一片，只会以为数据丢了。所以目录真在才认，不在就退回自己推的那份。
                if d.is_dir():
                    return d
    except OSError:
        pass
    return paths.USER_DATA_DIR


def read_web_strings(lang: str) -> dict:
    """读插件的 locales/<lang>/main.json，取出其中的 web 段。

    和 ComfyUI 那边的 /m8/i18n/<lang> 读的是**同一个文件** —— 工作台在哪种
    情况下打开，看到的文案都该是同一份。

    语言码会被拼进路径，所以先按字符集净化，再确认最终路径确实落在 locales/
    目录里。两道都过才读；取不到就给空表，前端会退回代码里的英文。
    """
    clean = re.sub(r"[^A-Za-z0-9_-]", "", str(lang or ""))[:8].lower()
    if not clean:
        return {}

    root = (PLUGIN_DIR / "locales").resolve()
    path = (root / clean / "main.json").resolve()
    if root != path and root not in path.parents:
        return {}
    if not path.is_file():
        return {}

    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    section = data.get("web") if isinstance(data, dict) else None
    return section if isinstance(section, dict) else {}


def resolve_static(rel: str) -> Path:
    clean = unquote(str(rel or "")).strip().lstrip("/") or "index.html"
    root = HERE.resolve()
    target = (root / clean).resolve()
    if root != target and root not in target.parents:
        raise M8Error("M8-WEB-001", message="路径越界", hint="正常从首页点进去就好")
    if target.suffix.lower() not in ALLOWED:
        raise M8Error("M8-WEB-002", message="不允许的文件类型", hint="只服务静态资源")
    return target


class Handler(BaseHTTPRequestHandler):
    server_version = "M8Serve/1.0"

    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, payload: dict, status: int = 200) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), JSON_CT)

    def _ok(self, **fields) -> None:
        self._json({"ok": True, **fields})

    def _fail(self, exc: M8Error) -> None:
        self._json(exc.to_payload(), 400)

    def _body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0:
            return {}
        try:
            obj = json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}
        return obj if isinstance(obj, dict) else {}

    def log_message(self, fmt, *args) -> None:
        pass  # 别把每个请求刷到窗口上，用户看不见真正重要的那几行

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/m8/health":
            self._ok(app="m8-serve", data=webdata.info(), port=self.server.server_address[1])
            return

        if path.startswith("/m8/i18n/"):
            lang = path[len("/m8/i18n/"):]
            self._ok(strings=read_web_strings(lang), lang=lang)
            return

        if path.startswith(DATA_PREFIX + "/"):
            kind = path[len(DATA_PREFIX) + 1:]
            try:
                self._ok(kind=kind, rows=webdata.read(kind))
            except M8Error as exc:
                self._fail(exc)
            return

        if path.startswith(WEB_PREFIX):
            try:
                target = resolve_static(path[len(WEB_PREFIX):])
            except M8Error as exc:
                self._fail(exc)
                return
            if not target.is_file():
                self._fail(M8Error("M8-WEB-003", message="网页里没有这个文件", hint="从首页点进去"))
                return
            ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype += "; charset=utf-8"
            try:
                self._send(200, target.read_bytes(), ctype)
            except OSError:
                self._fail(M8Error("M8-WEB-003", message="读不出这个文件", hint=str(target)))
            return

        self._send(404, b"not found", "text/plain; charset=utf-8")

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path

        if path == "/m8/shortcut/desktop":
            try:
                body = self._body()
                made = shortcut.make_shortcut(str(body.get("url") or ""),
                                              str(body.get("name") or shortcut.DEFAULT_NAME))
            except M8Error as exc:
                self._fail(exc)
                return
            self._ok(path=str(made), fileName=made.name)
            return

        if path.startswith(DATA_PREFIX + "/"):
            parts = path[len(DATA_PREFIX) + 1:].split("/")
            kind = parts[0]
            action = parts[1] if len(parts) > 1 else ""
            body = self._body()
            try:
                if action == "put":
                    rec = body.get("record")
                    if not isinstance(rec, dict):
                        raise M8Error("M8-WEB-010", message="要存的不是一条记录", hint="内部调用出错")
                    self._ok(kind=kind, id=webdata.put(kind, rec))
                    return
                if action == "delete":
                    self._ok(kind=kind, removed=webdata.drop(kind, body.get("id")))
                    return
                if action == "replace":
                    rows = body.get("rows")
                    if not isinstance(rows, list):
                        raise M8Error("M8-WEB-010", message="要替换的不是一个列表", hint="导入备份走这条")
                    self._ok(kind=kind, count=webdata.replace(kind, rows))
                    return
                raise M8Error("M8-WEB-007", message="不认识的接口", hint="只有 put / delete / replace")
            except M8Error as exc:
                self._fail(exc)
            return

        self._send(404, b"not found", "text/plain; charset=utf-8")


def main() -> int:
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print("端口要是数字，比如：python m8-serve.py 8199")
            return 2

    global_dir = load_data_dir()
    # 路标里写的和我们自己推的不一样，就以路标为准 —— 重新指过去
    if global_dir != paths.USER_DATA_DIR:
        paths.USER_DATA_DIR = global_dir
        paths.WEBAPP_DATA_DIR = global_dir / "webapp"

    try:
        webdata.ensure_dir()
    except M8Error as exc:
        print("建不出数据目录：" + str(exc.hint))
        return 1

    info = webdata.info()
    print("M8 工作台服务")
    print("  地址:     http://127.0.0.1:%d%s/index.html" % (port, WEB_PREFIX))
    print("  数据目录: " + str(info["dir"]))
    for kind, st in info["kinds"].items():
        print("    %-9s %d 条" % (kind, st["count"]))
    print("")
    print("关掉这个窗口就是停止服务。")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("停了。")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
