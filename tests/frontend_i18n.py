"""M8web 的界面语言：源码英文、译文在 locales 里，两边键集必须对得上。

这个检查的价值在于「键名写错」是最容易发生、又最不容易发现的一类错误 ——
写错了不会报任何错，只会静默显示英文原文，中文用户看到的就是没翻译的界面。
所以这里把 HTML 里用到的键和语言文件里的键做双向比对。
"""

from __future__ import annotations

import io
import json
import re
import sys
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
WEB = PLUGIN / "M8web"
LOCALES = PLUGIN / "locales"

CJK = re.compile(r"[\u4e00-\u9fff]")
DATA_I18N = re.compile(r'data-i18n="([^"]+)"')
DATA_I18N_HTML = re.compile(r'data-i18n-html="([^"]+)"')
DATA_I18N_ATTR = re.compile(r'data-i18n-attr="([^"]+)"')
DATA_I18N_TITLE = re.compile(r'data-i18n-title="([^"]+)"')
# JS 里 T("key", "fallback") 的键
JS_T = re.compile(r'\bT\(\s*["\']([A-Za-z0-9_.\-]+)["\']')

PAGES = ["index.html"] + [
    str(p.relative_to(WEB)).replace("\\", "/")
    for p in sorted((WEB / "pages").glob("*.html"))
]


def load_web(lang: str) -> dict:
    data = json.loads((LOCALES / lang / "main.json").read_text(encoding="utf-8"))
    return data.get("web", {})


def js_keys() -> set:
    """JS 里用到、或至少提到过的键名。

    不能只抓 T("key", ...)：lora.js / meta.js 把 i18n 键**存成数据**
    （[原始键, i18n 键, 英文] 三元组），因为这些表在 IIFE 顶层构造，而
    i18n.js 是 module（后执行），顶层查表只会拿到 undefined。真到渲染时才 T()。

    所以这里认得宽一点：键名只要作为字符串出现在源码里就算用到了。
    代价是「写了键名却忘了 T()」这种漏网查不出来 —— 那种事该由别的检查兜，
    而这个检查要防的是「语言文件里攒了没人认领的键慢慢烂掉」。
    """
    used = set()
    for path in sorted((WEB / "assets" / "js").glob("*.js")):
        src = path.read_text(encoding="utf-8")
        used |= set(JS_T.findall(src))
        # 加引号的普通字符串里出现的键名
        for m in re.finditer(r"""(["'])([A-Za-z][A-Za-z0-9_.\-]*)\1""", src):
            used.add(m.group(2))
    return used


def html_keys() -> set:
    keys = set()
    for rel in PAGES:
        src = (WEB / rel).read_text(encoding="utf-8")
        keys |= set(DATA_I18N.findall(src))
        keys |= set(DATA_I18N_HTML.findall(src))
        keys |= set(DATA_I18N_TITLE.findall(src))
        for spec in DATA_I18N_ATTR.findall(src):
            for pair in spec.split(","):
                if ":" in pair:
                    keys.add(pair.split(":", 1)[1].strip())
    return keys


class TestWebLocale(unittest.TestCase):
    def setUp(self):
        self.en = load_web("en")
        self.zh = load_web("zh")

    def test_en_and_zh_share_the_same_keys(self):
        only_en = sorted(set(self.en) - set(self.zh))
        only_zh = sorted(set(self.zh) - set(self.en))
        self.assertEqual(only_en, [], "只有 en 有这些键，中文环境会掉回英文")
        self.assertEqual(only_zh, [], "只有 zh 有这些键，英文环境会显示中文")

    def test_no_empty_translations(self):
        for lang, table in (("en", self.en), ("zh", self.zh)):
            empty = sorted(k for k, v in table.items() if not str(v).strip())
            self.assertEqual(empty, [], f"{lang} 里这些键是空的")

    def test_every_key_used_in_html_exists(self):
        used = html_keys()
        missing = sorted(used - set(self.en))
        self.assertEqual(missing, [], "HTML 里用到这些键，但语言文件里没有")

    # 运行时拼出来的键前缀：T("feat." + id + ".name")、T("loraGroup." + g.id, ...) 这类，
    # 静态看不全。这里列的是前缀本身（源码里出现的是 "loraGroup." 这个字面量）。
    DYNAMIC_PREFIXES = ("feat.", "migrateKinds.", "theme.", "loraGroup.", "loraTag.")

    def test_every_key_used_in_js_exists(self):
        used = set()
        for path in sorted((WEB / "assets" / "js").glob("*.js")):
            used |= set(JS_T.findall(path.read_text(encoding="utf-8")))
        missing = sorted(
            k for k in used - set(self.en)
            if not k.endswith(".")
            and "." not in k
            and k not in self.DYNAMIC_PREFIXES
            and k.startswith(("feat", "migrateKinds", "theme", "lora", "meta", "oc", "px",
                              "pg", "si", "obf", "cut", "mask", "grid", "paint", "studio",
                              "backup", "file", "import", "copy", "key", "si"))
        )
        self.assertEqual(missing, [], "JS 里用到这些键，但语言文件里没有")

    def test_locale_files_have_no_dead_keys(self):
        """语言文件里攒下没人用的键会慢慢烂掉。留一个白名单给动态拼出来的那些。"""
        used = html_keys() | js_keys()
        # 这些是运行时拼的：T("feat." + id + ".name") / T("migrateKinds." + kind, ...)
        dynamic = {
            "feat.image-editor.name", "feat.image-editor.kicker", "feat.image-editor.desc",
            "feat.oc.name", "feat.oc.kicker", "feat.oc.desc",
            "feat.prompts.name", "feat.prompts.kicker", "feat.prompts.desc",
            "feat.meta.name", "feat.meta.kicker", "feat.meta.desc",
            "feat.lora.name", "feat.lora.kicker", "feat.lora.desc",
            "feat.obfuscate.name", "feat.obfuscate.kicker", "feat.obfuscate.desc",
            "feat.pixel.name", "feat.pixel.kicker", "feat.pixel.desc",
            "migrateKinds.oc", "migrateKinds.prompts",
            "migrateKinds.groups", "migrateKinds.stickers",
            "theme.day", "theme.night", "theme.sakura", "theme.ocean",
        }
        # 动态前缀下的一切都算被用到（T("loraGroup." + id, ...) 展开出来的那些）
        def is_dynamic(key: str) -> bool:
            return key in dynamic or key.startswith(self.DYNAMIC_PREFIXES)

        dead = sorted(k for k in set(self.en) - used if not is_dynamic(k))
        self.assertEqual(dead, [], "语言文件里这些键没人用了")


def strip_comments(src: str) -> list:
    """把 /* */ 与 // 注释换成等长空白，保留换行。

    必须真的剥掉，不能用「行首是不是 //」这种启发式：
      - 块注释的续行不以 * 开头（比如续行的中文说明）
      - 行尾注释跟在代码后面，行首判断看不见它
    两种都会造成假阳性 —— 把一句注释里的中文报成界面文案。
    换成等长空白是为了行号和列号都还对得上。
    """
    out = []
    i, n = 0, len(src)
    in_block = False
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""
        if in_block:
            if ch == "*" and nxt == "/":
                out.append("  ")
                i += 2
                in_block = False
                continue
            out.append("\n" if ch == "\n" else " ")
            i += 1
            continue
        if ch == "/" and nxt == "*":
            out.append("  ")
            i += 2
            in_block = True
            continue
        if ch == "/" and nxt == "/":
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out).splitlines()


def strip_html_comments(src: str) -> list:
    """<!-- --> 同样换成等长空白。"""
    def blank(m):
        return "".join("\n" if c == "\n" else " " for c in m.group(0))
    return re.sub(r"<!--.*?-->", blank, src, flags=re.S).splitlines()


class TestWebSourceIsEnglish(unittest.TestCase):
    """用户可见的字符串必须是英文 —— 注释和内部日志不受此限。

    审核管的是界面文案；注释是给维护者看的，console.* 只出现在开发者工具里。
    单纯「行里有引号 + 中文」会把这些全报成违规，所以两样都要排掉。
    """

    STRING_WITH_CJK = re.compile(r"""["'\`][^"'\`]*[\u4e00-\u9fff]""")
    LOG_CALL = re.compile(r"\b(console\.[a-z]+|M8\.(log|warn|error|debug))\s*\(")

    def _offenders(self, path: Path, lang: str) -> list:
        src = path.read_text(encoding="utf-8")
        lines = strip_html_comments(src) if lang == "html" else strip_comments(src)
        bad = []
        for n, line in enumerate(lines, 1):
            if not CJK.search(line):
                continue
            if self.LOG_CALL.search(line):
                continue
            if self.STRING_WITH_CJK.search(line):
                bad.append(f"{path.relative_to(WEB)}:{n}: {line.strip()[:80]}")
        return bad

    def test_locale_tables_themselves_are_exempt(self):
        # locales/ 在插件根下，不在 M8web 里，这个断言只是把边界写明白
        self.assertFalse(str(LOCALES).startswith(str(WEB)))

    def test_no_chinese_in_javascript_strings(self):
        bad = []
        for path in sorted((WEB / "assets" / "js").glob("*.js")):
            bad += self._offenders(path, "js")
        self.assertEqual(bad, [], "JS 里还有中文字符串（注释可以留）")

    def test_no_chinese_in_page_markup(self):
        bad = []
        for rel in PAGES:
            bad += self._offenders(WEB / rel, "html")
        self.assertEqual(bad, [], "页面里还有中文（注释可以留）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
