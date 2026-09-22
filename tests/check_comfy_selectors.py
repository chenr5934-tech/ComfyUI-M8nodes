"""查一个前端类名 / 选择器 / API 名在 ComfyUI 里是否真实存在。

为什么要有这个工具：
  有一次给 M8web 做顶栏入口按钮，凭印象写了四个选择器，**四个全不存在**
  （真实的叫 .comfyui-body-top）。静态检查全绿、测试全过，只有实机才看得出来。

  这类错误的成本很高：要所有者来回验好几轮。而查一次只要几秒。
  所以把它做成命令 —— 让「查」比「猜」更省事。

用法：
    python tests/check_comfy_selectors.py .comfyui-body-top
    python tests/check_comfy_selectors.py registerSidebarTab
    python tests/check_comfy_selectors.py .comfyui-menu      # 这个会告诉你找不到，并给相似的

退出码：全部找到 0，有找不到的 1。
"""

from __future__ import annotations

import difflib
import importlib.util
import os
import re
import sys
from pathlib import Path


def candidate_dirs() -> list[Path]:
    """按「换了机器也找得到」的顺序列候选位置。

    第一优先是**直接问 python 前端包在哪** —— 只要这个脚本是用 ComfyUI 自带的
    那个 python 跑的，就一定命中。盘符、安装方式、整不整合包全都跟它无关。
    以前这里写死了作者本机的路径，别人拉下来跑第一次就是
    「找不到 ComfyUI 前端打包产物」，等于这个工具只对一台机器有效。
    """
    out: list[Path] = []

    def add(p: Path) -> None:
        if p not in out:
            out.append(p)

    # 1. 环境变量：ComfyUI 装在非常规位置时最省事的一招
    env = os.environ.get("M8_COMFY_DIR")
    if env:
        base = Path(env)
        add(base / "web")
        add(base)

    # 2. 问 python 自己：前端包是作为 pip 包装进 site-packages 的
    try:
        spec = importlib.util.find_spec("comfyui_frontend_package")
        if spec is not None and spec.origin:
            static = Path(spec.origin).parent / "static"
            add(static)
            add(static / "assets")
    except (ImportError, ValueError):
        pass

    # 3. 问 ComfyUI 本体：这个脚本就是在它的环境里跑的
    try:
        import folder_paths  # type: ignore

        add(Path(folder_paths.base_path) / "web")
    except Exception:
        pass

    # 4. 兜底：从本文件往上找。junction 安装时 __file__ 解析到的是真实路径，
    #    跟 ComfyUI 目录没关系，所以只能排最后，不能当主力。
    for up in list(Path(__file__).resolve().parents)[:6]:
        add(up / "web")

    return out


# ComfyUI 前端打包产物。整页只有 <div id="vue-app"> 一个挂载点，
# 类名和 API 都只能从这里查，不能按「一般前端会这么起名」推。
def find_assets() -> Path | None:
    for base in candidate_dirs():
        assets = base / "assets"
        if assets.is_dir() and any(assets.glob("*.js")):
            return assets
        if base.is_dir() and any(base.glob("*.js")):
            return base
    return None


def collect_words(assets: Path) -> set[str]:
    """把打包产物里出现过的「词」全收集起来。

    类名（.foo-bar）、标识符（registerXxx）、CSS 变量（--foo-bg）都收，
    这样无论问的是哪种都能答上来。
    """
    words: set[str] = set()
    pat = re.compile(r"[.\-#]?([A-Za-z][A-Za-z0-9_-]{2,60})")
    for path in list(assets.glob("*.css")) + list(assets.glob("*.js")):
        try:
            text = path.read_text("utf-8", errors="ignore")
        except OSError:
            continue
        for m in pat.finditer(text):
            words.add(m.group(1))
    return words


def similar(word: str, words: set[str], limit: int = 8) -> list[str]:
    """找相近的词，帮人从「我记错了」跳到「真实叫什么」。"""
    key = word.lstrip(".#-").lower()
    hits = difflib.get_close_matches(key, [w.lower() for w in words], n=limit, cutoff=0.55)
    # 再补一层：包含关系也算相近（comfyui-body-top ← body-top）
    extra = [w for w in words if key and (key in w.lower() or w.lower() in key)][:limit]
    out: list[str] = []
    for w in list(hits) + extra:
        real = next((x for x in words if x.lower() == w), w)
        if real not in out:
            out.append(real)
    return out[:limit]


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2

    assets = find_assets()
    if assets is None:
        print("找不到 ComfyUI 前端打包产物。检查 SEARCH_DIRS 里的路径对不对。")
        return 2

    words = collect_words(assets)
    print(f"在 {assets} 里查到 {len(words)} 个词。\n")

    missing = 0
    for raw in argv[1:]:
        key = raw.lstrip(".#-")
        # 精确命中（大小写敏感）优先，否则退到不敏感
        ok = key in words or key.lower() in {w.lower() for w in words}
        # 标记只用 ASCII：Windows 中文控制台是 GBK，✓ ✗ 这类符号会直接抛
        # UnicodeEncodeError —— 一个查工具因为打印符号而崩掉就太蠢了
        if ok:
            print("[OK]    " + raw)
        else:
            missing += 1
            print("[MISS]  " + raw + "  —— 不存在，别硬写")
            near = similar(key, words)
            if near:
                # 用拼接而不是 f-string 嵌套引号 —— 那种写法在不同 Python 版本上
                # 表现不一致，不值得为省一行代码冒这个险
                print("      相近的：" + "、".join(near))

    print()
    if missing:
        print(f"{missing} 个不存在。**别硬写** —— 要么用上面这些相近的，要么去问。")
        return 1
    print("全部存在。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
