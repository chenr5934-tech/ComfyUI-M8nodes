"""Gelbooru 公开页解析：原图取哪张、入队那三道门怎么过。

这个文件是为两个实测出来的缺陷写的，两处都不会抛异常、只会静默给出错误结果：

  1. `_extract_public_file_url` 一拿到 `<img id="image" src=".../samples/...">`
     就 return，后面找 `/images/` 原图的分支**永远走不到** —— 表现为每张图下到的
     都是压缩样图（同一张图实测：sample 122 KB，原图 1.9 MB）。
  2. `preview_file_url` 在没有 fallback 时回退成 `file_url`，而前端有一条
     「两者相同 = 只有预览」的判定。`id:xxx` 查询模式正好没有 fallback，
     于是每张图都被判死，入队报「无法取得所选 Gelbooru 图片的原图或精确标签」。

HTML 是**构造的最小片段**，不是真站点页面 —— 这里验的是解析规则，不是抓取。

用法：python tests/gallery_gelbooru_parse.py
"""

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ADAPTER_PATH = (
    Path(__file__).resolve().parent.parent
    / "m8" / "nodes" / "gallery" / "py" / "danbooru_gallery" / "site_adapters.py"
)

DIGEST = "0123456789abcdef0123456789abcdef"
OTHER_DIGEST = "ffffffffffffffffffffffffffffffff"

# 复刻 Gelbooru post 页的关键结构：样图在 img#image、原图在 /images/、
# 缩略图在 /thumbnails/，三者文件名是同一个 md5。
PAGE = f"""<!doctype html>
<html><body>
<div id="image-container">
  <img width="850" height="787" id="image" class="fit-width"
       src="https://img4.gelbooru.com//samples/01/23/sample_{DIGEST}.jpg">
</div>
<ul id="post-menu">
  <li><a href="https://img4.gelbooru.com//images/01/23/{DIGEST}.jpg">Original image</a></li>
</ul>
<div id="related"><img src="https://img4.gelbooru.com/thumbnails//01/23/thumbnail_{DIGEST}.jpg"></div>
<ul id="tag-list">
  <li class="tag-type-artist"><a href="?page=post&amp;s=list&amp;tags=some_artist">some_artist</a></li>
  <li class="tag-type-copyright"><a href="?page=post&amp;s=list&amp;tags=some_series">some_series</a></li>
  <li class="tag-type-character"><a href="?page=post&amp;s=list&amp;tags=some_girl">some_girl</a></li>
  <li class="tag-type-general"><a href="?page=post&amp;s=list&amp;tags=1girl">1girl</a></li>
</ul>
</body></html>
"""


def frontend_is_usable_original(post):
    """复刻 danbooru_gallery.js 的 isUsableOriginalUrl（改完之后的版本）。

    两处判断必须和后端对齐：后端有 _gelbooru_preview_only 就以后端为准；
    URL 相等只是没有那个标志时的启发式。
    """
    url = post.get("file_url")
    if not url:
        return False
    if post.get("_gelbooru_preview_only"):
        return False
    if (
        post.get("_gelbooru_preview_only") is None
        and post.get("source_site") == "gelbooru"
        and post.get("preview_file_url")
        and url == post.get("preview_file_url")
    ):
        return False
    return True


def load_adapters():
    spec = importlib.util.spec_from_file_location("m8_gallery_site_adapters", ADAPTER_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TestGelbooruPublicPage(unittest.TestCase):
    """公开页 → 归一化 post。入队能不能成功，全看这里出来的字段。"""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_adapters()
        cls.adapter = cls.mod.get_site_adapter("gelbooru")

    def parse(self, html, ref=None):
        # id: 查询模式下前端传的就是这么个裸引用，没有 preview_file_url
        return self.adapter.normalize_public_post_page("15147483", html, ref or {"id": "15147483"})

    # ---- 1. 原图 ----

    def test_prefers_original_over_sample(self):
        post = self.parse(PAGE)
        self.assertIn("/images/", post["file_url"])
        self.assertNotIn("/samples/", post["file_url"])
        self.assertIn(DIGEST, post["file_url"])

    def test_falls_back_to_sample_when_no_original_link(self):
        """页面里没有 /images/ 时退回样图 —— 宁可给样图，也别一张都不给。"""
        page = PAGE.replace(f"images/01/23/{DIGEST}.jpg", f"images/01/23/{OTHER_DIGEST}.jpg")
        post = self.parse(page)
        self.assertIn("/samples/", post["file_url"])
        self.assertFalse(post["_gelbooru_preview_only"])

    def test_missing_everything_marks_preview_only(self):
        """连样图都没有时，_gelbooru_preview_only 必须是真 —— 那是给前端的权威标志。"""
        page = """<html><body><ul id="tag-list">
          <li class="tag-type-general"><a href="?page=post&amp;s=list&amp;tags=1girl">1girl</a></li>
        </ul></body></html>"""
        post = self.parse(page)
        self.assertEqual(post["file_url"], "")
        self.assertTrue(post["_gelbooru_preview_only"])

    # ---- 2. 预览地址 ----

    def test_preview_differs_from_file_url(self):
        post = self.parse(PAGE)
        self.assertTrue(post["preview_file_url"])
        self.assertNotIn("thumbnail", post["file_url"].lower())
        self.assertIn("thumbnail", post["preview_file_url"].lower())

    def test_preview_kept_when_fallback_has_one(self):
        """列表页给的缩略图优先，别拿页面里随便一个缩略图顶掉它。"""
        ref = {"id": "15147483", "preview_file_url": "https://img4.gelbooru.com/thumbnails/x.jpg"}
        post = self.parse(PAGE, ref)
        self.assertEqual(post["preview_file_url"], "https://img4.gelbooru.com/thumbnails/x.jpg")

    # ---- 3. 入队那三道门 ----

    def test_queue_requirements_all_pass(self):
        """复刻前端 isUsableOriginalUrl 的三条规则，确认这条链走得通。

        前端那条「file_url === preview_file_url 就判死」是这里的主角 ——
        它和后端自己的 _gelbooru_preview_only 曾经各说各话。
        """
        post = self.parse(PAGE)
        self.assertTrue(frontend_is_usable_original(post), "前端仍会判这张图不可用")

        # 另外两条（有分类标签、分类精确）
        self.assertTrue(post["_tag_categories_exact"])
        self.assertTrue(post["_tag_categories_complete"])

    def test_queue_still_passes_when_page_has_no_thumbnail(self):
        """页面里连缩略图都没有时，preview 会回退成 file_url（两者相等）。

        前端那条「相等就判死」的启发式现在只在**没有后端标志**时才生效，
        所以这种情况依然能入队 —— 这是修完之后比修之前多出来的那层保险。
        """
        page = PAGE.replace(
            f'<div id="related"><img src="https://img4.gelbooru.com/thumbnails//01/23/thumbnail_{DIGEST}.jpg"></div>',
            "",
        )
        post = self.parse(page)
        self.assertEqual(post["preview_file_url"], post["file_url"])
        self.assertIs(post["_gelbooru_preview_only"], False)
        self.assertTrue(frontend_is_usable_original(post))

    # ---- 4. 标签分类不能被顺手改坏 ----

    def test_tag_categories_still_exact(self):
        post = self.parse(PAGE)
        self.assertEqual(post["tag_string_artist"], "some_artist")
        self.assertEqual(post["tag_string_copyright"], "some_series")
        self.assertEqual(post["tag_string_character"], "some_girl")
        self.assertIn("1girl", post["tag_string_general"])

    # ---- 5. md5 提取本身 ----

    def test_url_digest(self):
        adapter_cls = type(self.adapter)
        self.assertEqual(
            adapter_cls._url_digest(
                "https://img4.gelbooru.com//samples/01/23/sample_" + DIGEST + ".jpg"
            ),
            DIGEST,
        )
        self.assertEqual(adapter_cls._url_digest(""), "")
        self.assertEqual(adapter_cls._url_digest("https://x/y/no-digest.jpg"), "")


class TestMediaHostAllowlist(unittest.TestCase):
    """图片抓取的域名白名单。

    这是 SSRF 防护，不是可选的便利项：放宽到任意域名，就等于把 ComfyUI 后端
    变成「你给 URL 我就替你抓」的跳板。加图鉴站点时只加它自己的域，别写成
    「以 .com 结尾都行」。
    """

    @classmethod
    def setUpClass(cls):
        import importlib.util as iu

        path = (
            Path(__file__).resolve().parent.parent
            / "m8" / "nodes" / "gallery" / "py" / "danbooru_gallery" / "danbooru_gallery.py"
        )
        cls.src = path.read_text(encoding="utf-8")

    def test_allowlist_contains_all_three_sites(self):
        self.assertIn('ALLOWED_MEDIA_SUFFIXES = ("donmai.us", "gelbooru.com", "quicktagcloud.com")', self.src)

    def test_no_wildcard_suffix(self):
        """白名单里不许出现裸的顶级域，否则等于没设防。"""
        match = __import__("re").search(r"ALLOWED_MEDIA_SUFFIXES = \(([^)]*)\)", self.src)
        self.assertIsNotNone(match)
        for item in match.group(1).split(","):
            value = item.strip().strip('"').strip("'")
            if not value:
                continue
            self.assertGreaterEqual(value.count("."), 1, f"白名单项太宽: {value}")

    def test_nai_host_helper_matches_subdomains_only(self):
        # 直接把那段函数抠出来执行，避免 import 整个节点模块（它要 folder_paths）
        import re

        match = re.search(r"def _is_nai_atlas_host\(host: str\) -> bool:\n(.+?)\n\n", self.src, re.S)
        self.assertIsNotNone(match)
        namespace = {}
        exec("def _is_nai_atlas_host(host):\n" + match.group(1), namespace)  # noqa: S102
        is_nai = namespace["_is_nai_atlas_host"]

        self.assertTrue(is_nai("assets.quicktagcloud.com"))
        self.assertTrue(is_nai("quicktagcloud.com"))
        self.assertFalse(is_nai("evil-quicktagcloud.com"))
        self.assertFalse(is_nai("quicktagcloud.com.evil.net"))
        self.assertFalse(is_nai("donmai.us"))


class TestSourceIsolation(unittest.TestCase):
    """接入 NAI 图鉴之后，D 站 / G 站必须一字未变。

    这一组不看行为（那要真跑 ComfyUI），只钉**结构**：分支还在、顺序还对、
    fallback 还是原来那条。加第三个来源时最怕的就是顺手把 else 改成 elif 之后，
    Danbooru 悄悄走错分支 —— 那种错不报错，只会让 D 站拉不到图。
    """

    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent
        cls.py = (root / "m8" / "nodes" / "gallery" / "py" / "danbooru_gallery" / "danbooru_gallery.py").read_text(encoding="utf-8")
        cls.js = (root / "js" / "gallery" / "danbooru_gallery" / "danbooru_gallery.js").read_text(encoding="utf-8")

    def test_backend_media_fetch_keeps_both_sites(self):
        start = self.py.index("def _fetch_supported_media")
        end = self.py.index("def _fetch_gelbooru_public_posts", start)
        body = self.py[start:end]
        self.assertIn('host == "gelbooru.com"', body)
        self.assertIn("_gelbooru_request(", body)
        self.assertIn("_danbooru_request(", body)
        # 图鉴分支排在 gelbooru 之前，且 gelbooru 那支仍是 elif 不是被挤成 else
        self.assertLess(body.index("_is_nai_atlas_host"), body.index("_gelbooru_request("))
        self.assertIn("elif host ==", body)

    def test_backend_image_proxy_keeps_both_sites(self):
        start = self.py.index("async def image_proxy")
        end = self.py.index("async def get_posts_for_front", start)
        body = self.py[start:end]
        self.assertIn("_gelbooru_request", body)
        self.assertIn("_danbooru_request", body)
        self.assertIn("_is_nai_atlas_host", body)

    def test_frontend_preview_url_keeps_gelbooru_branch(self):
        """G 站不拼 md5、D 站要拼 —— 这条一直是分开的，别被图鉴改动顺手合并。"""
        anchor = "const isNaiAtlas = post.source_site"
        start = self.js.index(anchor)
        body = self.js[start:start + 600]
        self.assertIn('post.source_site === "gelbooru"', body)
        self.assertIn("post.preview_file_url", body)
        self.assertIn("post.md5", body)

    def test_frontend_nai_branch_returns_before_backend_call(self):
        """图鉴分支必须在请求后端之前就 return，否则会多打一次无用请求。"""
        nai = self.js.index('if (src === "nai_atlas") {')
        posts_call = self.js.index("await fetch(`/danbooru_gallery/posts?", nai)
        self.assertLess(nai, posts_call, "NAI 分支排在了后端请求之后")

    def test_frontend_prompt_fallback_keeps_original_path(self):
        """D/G 没有 _nai_sd_prompt，必须仍然走 buildPromptForPost。"""
        self.assertIn("_nai_sd_prompt || buildPromptForPost(effectivePost)", self.js)

    def test_only_nai_bypasses_image_proxy(self):
        """缩略图直连只对图鉴生效；D/G 仍走后端代理（上游有 Cloudflare）。"""
        start = self.js.index("const isNaiAtlas = post.source_site")
        body = self.js[start:start + 800]
        self.assertIn("isNaiAtlas", body)
        self.assertIn("/danbooru_gallery/image_proxy?url=", body)


if __name__ == "__main__":
    unittest.main(verbosity=2)
