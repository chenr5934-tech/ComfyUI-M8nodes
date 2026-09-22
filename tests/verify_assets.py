"""校验插件的加载方式与资源路径。

这个脚本查两类静态测试覆盖不到的问题：

  1. **加载名**：ComfyUI 是按目录名加载插件的，而目录名 ComfyUI-M8-nodes
     带连字符，不是合法的 Python 标识符 —— 插件里的相对导入在这种名字下
     能不能工作，只有真的用那个名字加载一次才知道。

  2. **前端路径**：import 的相对路径、资产 URL 写错了，语法检查照样通过，
     但页面会整片崩（模块加载失败）或者图片 404。这类错只能靠把路径
     解析出来、逐个核对文件是否存在。

跑法：
    python tests/verify_assets.py

不联网、不启动 ComfyUI。
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import sys
import types
from pathlib import Path

PKG_DIR = Path(__file__).resolve().parent.parent
REAL_DIR_NAME = "ComfyUI-M8-nodes"      # 带连字符，ComfyUI 就是这么加载的

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

problems: list[str] = []
checks = 0


def ok(label: str) -> None:
    global checks
    checks += 1
    print("  OK   " + label)


def bad(label: str, detail: str = "") -> None:
    global checks
    checks += 1
    problems.append(label + ("：" + detail if detail else ""))
    print("  FAIL " + label + ("  -> " + detail if detail else ""))


# ---------------------------------------------------------------- 1. 加载

class FakeRoutes:
    def __init__(self) -> None:
        self.entries: list[tuple[str, str]] = []

    def _deco(self, method: str, path: str):
        def deco(fn):
            self.entries.append((method, path))
            return fn
        return deco

    def get(self, path, **kw):
        return self._deco("GET", path)

    def post(self, path, **kw):
        return self._deco("POST", path)


print()
print("== 1. 用 ComfyUI 的方式加载（模块名 = 目录名，带连字符）==")

routes = FakeRoutes()
fake = types.ModuleType("server")


class FakePromptServer:
    instance = None


FakePromptServer.instance = types.SimpleNamespace(routes=routes)
fake.PromptServer = FakePromptServer
sys.modules["server"] = fake

spec = importlib.util.spec_from_file_location(
    REAL_DIR_NAME,
    str(PKG_DIR / "__init__.py"),
    submodule_search_locations=[str(PKG_DIR)],
)
module = importlib.util.module_from_spec(spec)
sys.modules[REAL_DIR_NAME] = module

try:
    with contextlib.redirect_stdout(io.StringIO()):
        spec.loader.exec_module(module)
    ok("插件用带连字符的模块名加载成功（相对导入没被名字绊住）")
except Exception as exc:
    bad("插件加载失败", "{}: {}".format(type(exc).__name__, exc))
    print()
    print("加载都过不去，后面的检查没有意义。")
    raise SystemExit(1)

nodes = getattr(module, "NODE_CLASS_MAPPINGS", {})
if nodes:
    ok("注册了 {} 个节点：{}".format(len(nodes), "、".join(sorted(nodes))))
else:
    bad("一个节点都没注册")

web_dir = getattr(module, "WEB_DIRECTORY", None)
if web_dir == "./js":
    ok("WEB_DIRECTORY 指向 ./js")
else:
    bad("WEB_DIRECTORY 不对", str(web_dir))

registered = sorted({(m, p) for m, p in routes.entries})
print("  ---- 注册了 {} 条接口".format(len(registered)))
for method, path in registered:
    print("       {} {}".format(method, path))


# ---------------------------------------------------------------- 2. 前端路径

print()
print("== 2. 前端 import 路径（解析不到就是整页崩）==")

JS_ROOT = PKG_DIR / "js"
js_files = sorted(JS_ROOT.rglob("*.js"))
print("  找到 {} 个前端模块".format(len(js_files)))

IMPORT_RE = re.compile(r"""from\s+["'](\.[^"']+)["']""")

for js in js_files:
    text = js.read_text("utf-8")
    rel_self = js.relative_to(PKG_DIR).as_posix()
    for target in IMPORT_RE.findall(text):
        resolved = (js.parent / target).resolve()
        if resolved.is_file():
            ok("{}  ->  {}".format(rel_self, target))
        else:
            bad("{} 里的 import 找不到".format(rel_self), target)


# ---------------------------------------------------------------- 3. 资产

print()
print("== 3. 资产路径（写错了是 404，浏览器只给一行红字）==")

URL_RE = re.compile(r"""new URL\(\s*["']([^"'\`]+)["']\s*,\s*import\.meta\.url\s*\)""")
ASSET_RE = re.compile(r"""assetUrl\(\s*["']([^"'\`]+)["']\s*\)""")

# assetUrl 定义在 whale.js 里，内部拼的是 ./assets/ —— 所以**不管谁调用它**，
# 解析基准都是 whale.js 所在目录下的 assets/，不是调用者自己的目录。
# （第一版脚本就是按调用者目录算的，于是 dialog.js 和 settings.js 里那几处
#   全被误报成「找不到」。校验脚本自己也得先对。）
ASSET_BASE = (JS_ROOT / "ui" / "whale").resolve()

for js in js_files:
    text = js.read_text("utf-8")
    rel_self = js.relative_to(PKG_DIR).as_posix()

    for target in URL_RE.findall(text):
        resolved = (js.parent / target).resolve()
        if resolved.is_file():
            ok("{}  ->  {}".format(rel_self, target))
        else:
            bad("{} 里的资产找不到".format(rel_self), target)

    for target in ASSET_RE.findall(text):
        resolved = (ASSET_BASE / "assets" / target).resolve()
        if resolved.is_file():
            ok("{}  ->  assetUrl({})".format(rel_self, target))
        else:
            bad("{} 里 assetUrl 指向的资产找不到".format(rel_self), target)

# 音效是拼出来的（assetUrl 里带变量），静态解析不了，单独核一遍
sound_dir = JS_ROOT / "ui" / "whale" / "assets" / "sound"
expected_sounds = ["duck-press.mp3", "duck-release.mp3", "fx1-press.mp3", "fx1-release.mp3"]
missing = [name for name in expected_sounds if not (sound_dir / name).is_file()]
if missing:
    bad("音效文件缺失", "、".join(missing))
else:
    ok("音效齐全：" + "、".join(expected_sounds))


# ---------------------------------------------------------------- 4. 结论

print()
print("=" * 58)
if problems:
    print("  校验完成：{} 项，其中 {} 项有问题".format(checks, len(problems)))
    for item in problems:
        print("    - " + item)
    print("=" * 58)
    raise SystemExit(1)

print("  校验完成：{} 项全部通过".format(checks))
print("=" * 58)
