"""M8web 的界面语言：zh / en 两份语言文件，键集必须对得上。

注：界面文案现在是**中文写在代码里**当默认值（不再为审核让步），
语言包是「同一种语言的另一份」，不是唯一的来源。

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


class TestWebRequestPaths(unittest.TestCase):
    """工作台可能被挂在子路径下（/comfy/m8/web/），所以请求地址不能写死。

    这条是踩过坑才加的：i18n.js 一开始写死 fetch("/m8/i18n/zh")，根路径下好好的，
    挂到子路径就打到 /m8/... 去了 —— 中文用户看到全英文，而本地默认路径试不出来。
    app.js 里 M8Api.base() 和 health() 早就做了推导，i18n.js 漏了。
    """

    # 允许出现的绝对路径：它们本身就是「拼前缀」的实现，不是写死的请求地址
    ALLOWED = (
        'p.indexOf("/m8/web/")',
        '"/m8/data/"',
        '"/m8/"',
        '"/m8/i18n/"',
    )

    def test_no_hardcoded_absolute_api_paths(self):
        bad = []
        for path in sorted((WEB / "assets" / "js").glob("*.js")):
            for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                st = line.strip()
                if st.startswith(("//", "*", "/*")):
                    continue
                if "fetch(" not in line:
                    continue
                for m in re.finditer(r'''fetch\(\s*["'\`](/m8/[^"'\`]*)''', line):
                    if any(a in line for a in self.ALLOWED):
                        continue
                    bad.append(f"{path.name}:{n}: fetch('{m.group(1)}')")
        self.assertEqual(bad, [], "请求地址写死了，挂到子路径下就会打错地方")

    def test_both_path_derivations_agree(self):
        """i18n.js 和 app.js 各有一份路径推导（一个是 module、一个是普通脚本，
        拿不到对方的 export）。两份口径必须一样，不然修了一处漏另一处。"""
        app = (WEB / "assets" / "js" / "app.js").read_text(encoding="utf-8")
        i18n = (WEB / "assets" / "js" / "i18n.js").read_text(encoding="utf-8")
        probe = 'p.indexOf("/m8/web/")'
        self.assertIn(probe, app, "app.js 的路径推导变了")
        self.assertIn(probe, i18n, "i18n.js 的路径推导和 app.js 不一致")


class TestDefaultsMatchLocale(unittest.TestCase):
    """代码里写的默认文案，必须和 locales/zh 里那份一字不差。

    界面文案现在是**中文直接写在代码里当默认值**（不再为审核让步，见
    docs/ARCHITECTURE.md 第八节）。locales/ 下留着同样的一份，中文环境会拉它
    覆盖一遍 —— 两份一旦漂移，中文用户看到的是语言包里的旧版本，英文用户看到的
    是代码里的新版本：同一个按钮两种说法，**而且不会有任何报错**。
    这条断言就是为这个而设的。
    """

    JS_T = re.compile(r"""\b(T|coreT)\(\s*(["'])([A-Za-z0-9_.\-]+)\2\s*,\s*(["'])((?:[^"'\\]|\\.)*)\4""")
    TFOR = re.compile(r"""\.tFor\(\s*["']([A-Za-z0-9_]+)["']""")
    CJK = re.compile(r"[\u4e00-\u9fff]")

    @classmethod
    def setUpClass(cls):
        cls.en = json.loads((LOCALES / "en" / "main.json").read_text(encoding="utf-8"))
        cls.zh = json.loads((LOCALES / "zh" / "main.json").read_text(encoding="utf-8"))

    @staticmethod
    def _unescape(s, quote):
        out = s.replace("\\" + quote, quote)
        out = out.replace("\\n", "\n").replace("\\r", "\r").replace("\\t", "\t")
        return out.replace("\\\\", "\\")

    def _check_js(self, root, section_of):
        """section_of(path, src) -> 语言包里的段名；返回 None 表示这个文件不查。"""
        bad = []
        for path in sorted(root.rglob("*.js")):
            src = path.read_text(encoding="utf-8")
            section = section_of(path, src)
            if not section:
                continue
            table = self.zh["ui"].get(section)
            if not table:
                bad.append(f"{path.name}: 语言包里没有 ui.{section} 这一段")
                continue
            for m in self.JS_T.finditer(src):
                key = m.group(3)
                default = self._unescape(m.group(5), m.group(4))
                want = table.get(key)
                if want is None:
                    bad.append(f"{path.name}: {key} 不在 ui.{section} 里")
                elif want != default:
                    bad.append(f"{path.name}: {key}\n      代码: {default}\n      语言包: {want}")
        return bad

    def test_node_and_whale_defaults_match_zh(self):
        plugin_js = PLUGIN / "js"

        def section_of(path, src):
            # m8_core.js 用 coreT，段固定是 M8Core
            if path.name == "m8_core.js":
                return "M8Core"
            hit = self.TFOR.search(src)
            return hit.group(1) if hit else None

        bad = self._check_js(plugin_js, section_of)
        self.assertEqual(bad, [], "代码默认值和 locales/zh 对不上：\n  " + "\n  ".join(bad[:12]))

    def test_m8web_defaults_match_zh(self):
        bad = []
        root = WEB / "assets" / "js"
        for path in sorted(root.glob("*.js")):
            src = path.read_text(encoding="utf-8")
            for m in self.JS_T.finditer(src):
                key = m.group(3)
                default = self._unescape(m.group(5), m.group(4))
                want = self.zh["web"].get(key)
                if want is None:
                    bad.append(f"{path.name}: {key} 不在 web 段里")
                elif want != default:
                    bad.append(f"{path.name}: {key}\n      代码: {default}\n      语言包: {want}")
        self.assertEqual(bad, [], "M8web 的默认值和 locales/zh 对不上：\n  " + "\n  ".join(bad[:12]))

    def test_html_defaults_match_zh(self):
        """HTML 里 data-i18n 的默认文字也要和语言包一致。"""
        plain = re.compile(
            r'<(?P<tag>[a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\bdata-i18n="(?P<key>[^"]+)"[^>]*?>'
            r'(?P<body>[^<]*)</(?P=tag)>'
        )
        bad = []
        for rel in PAGES:
            src = (WEB / rel).read_text(encoding="utf-8")
            for m in plain.finditer(src):
                key, body = m.group("key"), m.group("body")
                want = self.zh["web"].get(key)
                if want is None:
                    bad.append(f"{rel}: {key} 不在 web 段里")
                elif want.strip() != body.strip():
                    bad.append(f"{rel}: {key}\n      页面: {body.strip()[:70]}\n      语言包: {want.strip()[:70]}")
        self.assertEqual(bad, [], "页面默认文字和 locales/zh 对不上：\n  " + "\n  ".join(bad[:12]))


    def test_html_attr_defaults_match_zh(self):
        """data-i18n-attr 指的那些属性，写在 HTML 上的默认值也要和语言包一致。

        这一条是补的。属性上的默认值（aria-label / placeholder / title / alt）
        不在元素内容里，上面那条只查内容，于是漏了一整批，一直没被发现 ——
        因为**在 ComfyUI 里看不出来**：那边能拉到语言包，一切都被覆盖成中文。
        离线版（桌面快捷方式那个）拉不到，退回默认值，英文就露出来了。
        同一个页面两种表现，根因就在这里。

        顺带提醒：这些默认值不是装饰。读屏软件念的是 aria-label，
        输入框空了显示的是 placeholder，图片没加载出来显示的是 alt。
        """
        TAG = re.compile(r'<[a-zA-Z][a-zA-Z0-9]*\b[^>]*?\bdata-i18n-attr="[^"]*"[^>]*?>')
        SPEC = re.compile(r'data-i18n-attr="([^"]*)"')
        bad = []
        for rel in PAGES:
            src = (WEB / rel).read_text(encoding="utf-8")
            for tag in TAG.findall(src):
                spec_m = SPEC.search(tag)
                if not spec_m:
                    continue
                for pair in spec_m.group(1).split(","):
                    if ":" not in pair:
                        continue
                    attr, key = (s.strip() for s in pair.split(":", 1))
                    if not attr or not key:
                        continue
                    want = self.zh["web"].get(key)
                    if want is None:
                        bad.append(f"{rel}: {key} 不在 web 段里")
                        continue
                    got = re.search(r'\b' + re.escape(attr) + r'="([^"]*)"', tag)
                    if not got:
                        bad.append(f"{rel}: 标了 data-i18n-attr={attr}:{key}，"
                                   f"但标签上没有 {attr} 属性")
                        continue
                    if got.group(1) != want:
                        bad.append(f"{rel}: {attr}（{key}）\n"
                                   f"      页面: {got.group(1)[:70]}\n"
                                   f"      语言包: {want[:70]}")
        self.assertEqual(bad, [], "属性上的默认值和 locales/zh 对不上：\n  " + "\n  ".join(bad[:10]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
