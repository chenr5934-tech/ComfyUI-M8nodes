"""Behavior tests for persistent post caching and local tag classification.

Migrated from tools/test_gallery_post_cache.py; the modules are loaded by path
so the suite runs without ComfyUI.
"""

from __future__ import annotations

import sys
import sqlite3
import unittest
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support

POST_CACHE = _support.load("danbooru_gallery.post_cache", "danbooru_gallery/post_cache.py")
ADAPTERS = _support.load("danbooru_gallery.site_adapters", "danbooru_gallery/site_adapters.py")


class GalleryPostCacheTests(unittest.TestCase):
    def setUp(self):
        self.cache_db = _support.temp_path(".db")
        self.tags_db = _support.temp_path("_tags.db")
        with closing(sqlite3.connect(self.tags_db)) as connection, connection:
            connection.execute("CREATE TABLE hot_tags(tag TEXT PRIMARY KEY, category INTEGER NOT NULL)")
            connection.executemany(
                "INSERT INTO hot_tags(tag, category) VALUES (?, ?)",
                [("known_artist", 1), ("known_character", 4), ("known_meta", 5)],
            )
        self.cache = POST_CACHE.GalleryPostCache(str(self.cache_db), str(self.tags_db))

    def tearDown(self):
        _support.discard(self.cache_db, self.tags_db)

    def test_local_fallback_preserves_unknown_tags(self):
        post = {
            "id": "1",
            "tag_string": "known_artist known_character unknown_tag",
            "source_site": "gelbooru",
        }
        [classified] = self.cache.classify_posts("gelbooru:default", [post])
        self.assertEqual(classified["tag_string_artist"], "known_artist")
        self.assertEqual(classified["tag_string_character"], "known_character")
        self.assertEqual(classified["tag_string_general"], "unknown_tag")
        self.assertEqual(classified["_uncategorized_tags"], ["unknown_tag"])
        self.assertFalse(classified["_tag_categories_complete"])
        self.assertFalse(classified["_tag_categories_exact"])

    def test_public_detail_marks_only_parsed_categories_as_exact(self):
        adapter = ADAPTERS.GelbooruAdapter()
        html = (
            '<ul id="tag-list">'
            '<li class="tag-type-artist"><a href="index.php?page=post&s=list&tags=exact_artist">x</a></li>'
            '<li class="tag-type-general"><a href="index.php?page=post&s=list&tags=exact_general">x</a></li>'
            '</ul>'
        )
        exact = adapter.normalize_public_post_page("7", html, {"tag_string": "fallback"})
        fallback = adapter.normalize_public_post_page("8", "<html></html>", {"tag_string": "fallback"})
        self.assertTrue(exact["_tag_categories_exact"])
        self.assertEqual(exact["tag_string_artist"], "exact_artist")
        self.assertFalse(fallback["_tag_categories_exact"])

    def test_exact_detail_survives_restart_and_teaches_categories(self):
        detail = {
            "id": "2",
            "source_site": "gelbooru",
            "tag_string": "new_artist new_general",
            "tag_string_artist": "new_artist",
            "tag_string_copyright": "",
            "tag_string_character": "",
            "tag_string_general": "new_general",
            "tag_string_meta": "",
            "file_url": "https://img.example/full.jpg",
            "_gelbooru_preview_only": False,
            "_tag_categories_complete": True,
            "_tag_categories_exact": True,
            "_tag_categories_source": "gelbooru_detail",
        }
        self.cache.put_post("gelbooru:default", detail)

        restarted = POST_CACHE.GalleryPostCache(str(self.cache_db), str(self.tags_db))
        cached = restarted.get_posts("gelbooru:default", ["2"], 3600)["2"]
        self.assertEqual(cached["tag_string_artist"], "new_artist")
        self.assertTrue(cached["_gelbooru_hydrated"])

        [classified] = restarted.classify_posts(
            "gelbooru:default",
            [{"id": "3", "tag_string": "new_artist new_general"}],
        )
        self.assertEqual(classified["tag_string_artist"], "new_artist")
        self.assertEqual(classified["tag_string_general"], "new_general")
        self.assertTrue(classified["_tag_categories_complete"])
        self.assertTrue(classified["_tag_categories_exact"])

    def test_expired_post_is_not_returned(self):
        self.cache.put_post("gelbooru:default", {
            "id": "4",
            "tag_string": "known_meta",
            "_tag_categories_complete": True,
            "_tag_categories_exact": True,
        })
        with closing(sqlite3.connect(self.cache_db)) as connection, connection:
            connection.execute("UPDATE post_details SET fetched_at = 1")
        self.assertEqual(self.cache.get_posts("gelbooru:default", ["4"], 1), {})

    def test_inexact_detail_does_not_poison_category_index(self):
        self.cache.put_post("gelbooru:default", {
            "id": "5",
            "tag_string": "unverified_tag",
            "tag_string_general": "unverified_tag",
            "_tag_categories_complete": False,
            "_tag_categories_exact": False,
            "_tag_categories_source": "detail_fallback",
        })
        [classified] = self.cache.classify_posts(
            "gelbooru:default",
            [{"id": "6", "tag_string": "unverified_tag"}],
        )
        self.assertEqual(classified["_uncategorized_tags"], ["unverified_tag"])
        self.assertFalse(classified["_tag_categories_exact"])

    def test_cache_is_partitioned_per_source(self):
        self.cache.put_post("gelbooru:public", {"id": "9", "tag_string": "a_tag"})
        self.assertEqual(self.cache.get_posts("gelbooru:default", ["9"], 3600), {})
        self.assertIn("9", self.cache.get_posts("gelbooru:public", ["9"], 3600))

    def test_post_without_id_is_ignored(self):
        # touch the cache first so the schema exists before the row count below
        self.assertEqual(self.cache.get_posts("gelbooru:default", ["1"], 60), {})
        self.cache.put_post("gelbooru:default", {"tag_string": "no_id_tag"})
        with closing(sqlite3.connect(self.cache_db)) as connection:
            rows = connection.execute("SELECT COUNT(*) FROM post_details").fetchone()
        self.assertEqual(rows[0], 0)

    def test_merge_cached_posts_keeps_remote_fields(self):
        self.cache.put_post("gelbooru:default", {
            "id": "10",
            "tag_string": "tag_a",
            "file_url": "https://img.example/10.jpg",
            "_tag_categories_complete": True,
            "_tag_categories_exact": True,
        })
        merged = self.cache.merge_cached_posts(
            "gelbooru:default",
            [{"id": "10", "tag_string": "tag_a", "preview_file_url": "https://img.example/p10.jpg"}],
            3600,
        )[0]
        self.assertEqual(merged["file_url"], "https://img.example/10.jpg")
        self.assertEqual(merged["preview_file_url"], "https://img.example/p10.jpg")


if __name__ == "__main__":
    unittest.main()
