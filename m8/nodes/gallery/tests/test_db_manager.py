"""Behavior tests for the tag database manager (aiosqlite).

Skipped when aiosqlite is unavailable, so the suite still runs on a bare
interpreter.  Every test drives one coroutine on a private event loop: aiosqlite
binds a connection to the loop that opened it, and the manager keeps a single
connection for its lifetime.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support

HAVE_AIOSQLITE = importlib.util.find_spec("aiosqlite") is not None
REASON = "aiosqlite is not installed"


@unittest.skipUnless(HAVE_AIOSQLITE, REASON)
class TagDatabaseManagerTests(unittest.TestCase):
    def setUp(self):
        self.db_path = _support.temp_path(".db")
        self.module = _support.load("shared.db.db_manager", "shared/db/db_manager.py")
        self.manager = self.module.TagDatabaseManager(str(self.db_path))

    def tearDown(self):
        _support.discard(self.db_path)

    def run_scenario(self, scenario):
        """Run scenario(manager) on a fresh loop and close the connection there."""

        async def runner():
            try:
                return await scenario(self.manager)
            finally:
                await self.manager.close()

        return asyncio.run(runner())

    async def table_names(self, manager):
        connection = await manager.get_connection()
        cursor = await connection.execute(
            "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')"
        )
        return {row[0] for row in await cursor.fetchall()}

    def test_initialize_database_creates_tables_and_fts_triggers(self):
        def scenario(manager):
            async def run():
                await manager.initialize_database()
                return await self.table_names(manager)

            return run()

        names = self.run_scenario(scenario)
        for expected in ("hot_tags", "hot_tags_fts", "sync_metadata",
                         "hot_tags_ai", "hot_tags_au", "hot_tags_ad"):
            with self.subTest(object=expected):
                self.assertIn(expected, names)

    def test_initialize_database_is_idempotent(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.initialize_database()
            return await manager.get_tags_count()

        self.assertEqual(self.run_scenario(scenario), 0)

    def test_batch_insert_round_trips_aliases_and_translation(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 500,
                 "translation_cn": "初音未来", "aliases": ["miku"]},
                {"tag": "1girl", "category": 0, "post_count": 900},
            ])
            return (
                await manager.get_tag("hatsune_miku"),
                await manager.get_tag("1girl"),
                await manager.get_tag("missing_tag"),
            )

        tag, plain, missing = self.run_scenario(scenario)
        self.assertEqual(tag["category"], 4)
        self.assertEqual(tag["post_count"], 500)
        self.assertEqual(tag["translation_cn"], "初音未来")
        self.assertEqual(tag["aliases"], ["miku"])
        self.assertIsNotNone(tag["last_updated"])
        self.assertEqual(plain["aliases"], [])
        self.assertIsNone(missing)

    def test_insert_tag_is_visible_on_the_manager_connection(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tag("solo_tag", 0, 7)
            return await manager.get_tag("solo_tag")

        self.assertEqual(self.run_scenario(scenario)["post_count"], 7)

    def test_batch_insert_replaces_existing_rows(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([{"tag": "yuri", "category": 0, "post_count": 10}])
            await manager.insert_tags_batch([{"tag": "yuri", "category": 0, "post_count": 42}])
            return await manager.get_tag("yuri"), await manager.get_tags_count()

        tag, count = self.run_scenario(scenario)
        self.assertEqual(tag["post_count"], 42)
        self.assertEqual(count, 1)

    def test_prefix_search_is_case_insensitive_and_sorted_by_post_count(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "1girl", "category": 0, "post_count": 100},
                {"tag": "1girls", "category": 0, "post_count": 20},
                {"tag": "2girls", "category": 0, "post_count": 200},
            ])
            return (
                await manager.search_tags_by_prefix("1girl"),
                await manager.search_tags_by_prefix("1GIRL"),
                await manager.search_tags_by_prefix("1girl", limit=1),
                await manager.search_tags_by_prefix("nope"),
            )

        hits, upper_hits, limited, none_hits = self.run_scenario(scenario)
        self.assertEqual([hit["tag"] for hit in hits], ["1girl", "1girls"])
        self.assertEqual([hit["post_count"] for hit in hits], [100, 20])
        # the prefix is lowercased before matching, so upper-case input still hits
        self.assertEqual([hit["tag"] for hit in upper_hits], ["1girl", "1girls"])
        self.assertEqual(len(limited), 1)
        self.assertEqual(none_hits, [])

    def test_prefix_search_does_not_match_middle_of_tag(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([{"tag": "long_hair", "category": 0, "post_count": 5}])
            return await manager.search_tags_by_prefix("hair")

        self.assertEqual(self.run_scenario(scenario), [])

    def test_optimized_search_detects_english_prefix(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "blue_sky", "category": 0, "post_count": 30},
                {"tag": "blue_archive", "category": 3, "post_count": 50},
            ])
            return await manager.search_tags_optimized("blue")

        hits = self.run_scenario(scenario)
        self.assertEqual([hit["tag"] for hit in hits], ["blue_archive", "blue_sky"])
        self.assertTrue(all(hit["match_score"] == 10 for hit in hits))

    def test_optimized_search_matches_chinese_translation_exactly(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 500,
                 "translation_cn": "初音未来"},
            ])
            return await manager.search_tags_optimized("初音未来")

        hits = self.run_scenario(scenario)
        self.assertEqual([hit["tag"] for hit in hits], ["hatsune_miku"])
        self.assertEqual(hits[0]["match_score"], 10)

    def test_translation_search_scores_exact_match_higher_than_partial(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "exact_tag", "category": 0, "post_count": 1, "translation_cn": "猫"},
                {"tag": "partial_tag", "category": 0, "post_count": 999, "translation_cn": "猫咪"},
            ])
            return await manager.search_tags_by_translation("猫")

        hits = self.run_scenario(scenario)
        self.assertEqual([hit["tag"] for hit in hits], ["exact_tag", "partial_tag"])
        self.assertGreater(hits[0]["match_score"], hits[1]["match_score"])

    def test_delete_old_tags_drops_only_stale_rows(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "fresh_tag", "category": 0, "post_count": 1},
                {"tag": "stale_tag", "category": 0, "post_count": 1},
            ])
            connection = await manager.get_connection()
            await connection.execute("UPDATE hot_tags SET last_updated = 1 WHERE tag = 'stale_tag'")
            await connection.commit()
            removed = await manager.delete_old_tags(30)
            return removed, await manager.get_tag("stale_tag"), await manager.get_tag("fresh_tag")

        removed, stale, fresh = self.run_scenario(scenario)
        self.assertEqual(removed, 1)
        self.assertIsNone(stale)
        self.assertIsNotNone(fresh)

    def test_sync_metadata_round_trip(self):
        async def scenario(manager):
            await manager.initialize_database()
            initial = await manager.get_last_sync_time()
            await manager.set_metadata("endpoint", "/posts.json")
            await manager.set_last_sync_time(1700000000)
            await manager.set_sync_progress({"page": 3})
            values = (
                initial,
                await manager.get_metadata("endpoint"),
                await manager.get_last_sync_time(),
                await manager.get_sync_progress(),
            )
            await manager.clear_sync_progress()
            return (*values, await manager.get_sync_progress())

        initial, endpoint, last_sync, progress, cleared = self.run_scenario(scenario)
        self.assertEqual(initial, 0)
        self.assertEqual(endpoint, "/posts.json")
        self.assertEqual(last_sync, 1700000000)
        self.assertEqual(progress, {"page": 3})
        self.assertEqual(cleared, {})

    def test_health_check_passes_on_initialized_database(self):
        async def scenario(manager):
            await manager.initialize_database()
            return await manager.check_database_health()

        self.assertEqual(self.run_scenario(scenario), (True, None))

    def test_health_check_reports_missing_tables(self):
        async def scenario(manager):
            return await manager.check_database_health()

        is_healthy, message = self.run_scenario(scenario)
        self.assertFalse(is_healthy)
        self.assertIn("Missing required tables", message)

    def test_rebuild_fts_index_reindexes_existing_rows(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 1, "translation_cn": "初音未来"},
                {"tag": "b_tag", "category": 0, "post_count": 1},
            ])
            rebuilt = await manager.rebuild_fts_index()
            # the rebuilt index still answers queries through the FTS path
            hits = await manager.search_tags_optimized("初音未来")
            return rebuilt, [hit["tag"] for hit in hits]

        rebuilt, hits = self.run_scenario(scenario)
        self.assertEqual(rebuilt, 2)
        self.assertEqual(hits, ["hatsune_miku"])


if __name__ == "__main__":
    unittest.main()
