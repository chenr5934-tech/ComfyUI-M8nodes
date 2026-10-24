"""Durability and FTS5 index-integrity tests for the tag database manager.

aiosqlite may be missing on a bare interpreter, and the pragmas/commit behaviour
is invisible to the aiosqlite-gated tests anyway, so these cases drive the real
manager code through a small awaitable shim over stdlib sqlite3.  Nothing under
test is reimplemented: get_connection (and its WAL/busy_timeout/synchronous
pragmas), insert_tag's commit and rebuild_fts_index all run unmodified.
"""

from __future__ import annotations

import asyncio
import importlib.util
import sqlite3
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support


class _AsyncCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    async def fetchone(self):
        return self._cursor.fetchone()

    async def fetchall(self):
        return self._cursor.fetchall()

    async def close(self):
        self._cursor.close()

    @property
    def rowcount(self):
        return self._cursor.rowcount


class _AsyncConnection:
    """The subset of aiosqlite.Connection that db_manager actually uses."""

    def __init__(self, connection):
        self._raw = connection

    @property
    def row_factory(self):
        return self._raw.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._raw.row_factory = value

    async def execute(self, sql, parameters=()):
        return _AsyncCursor(self._raw.execute(sql, parameters))

    async def executemany(self, sql, parameters):
        return _AsyncCursor(self._raw.executemany(sql, parameters))

    async def commit(self):
        self._raw.commit()

    async def close(self):
        self._raw.close()


class _FakeAiosqlite:
    """Stand-in for the module-level aiosqlite client used by get_connection."""

    Row = sqlite3.Row

    async def connect(self, db_path):
        connection = sqlite3.connect(db_path)
        connection.row_factory = sqlite3.Row
        return _AsyncConnection(connection)


HAVE_AIOSQLITE = importlib.util.find_spec("aiosqlite") is not None
_STUB_INSTALLED = False


def _install_aiosqlite_stub():
    """Make db_manager importable when aiosqlite is absent.

    db_manager imports aiosqlite at module scope and annotates a return type
    with aiosqlite.Connection; the placeholder satisfies both, and setUp swaps
    module.aiosqlite for the sqlite3-backed fake.  It is scoped to these tests so
    the rest of the suite still sees an honest "aiosqlite is missing".
    """
    global _STUB_INSTALLED
    if HAVE_AIOSQLITE or _STUB_INSTALLED:
        return

    stub = types.ModuleType("aiosqlite")
    stub.Row = sqlite3.Row
    stub.Connection = _AsyncConnection

    async def _unavailable_connect(*args, **kwargs):
        raise RuntimeError("aiosqlite is not installed; these tests use the sqlite3 shim")

    stub.connect = _unavailable_connect
    sys.modules["aiosqlite"] = stub
    _STUB_INSTALLED = True


def _remove_aiosqlite_stub():
    global _STUB_INSTALLED
    if _STUB_INSTALLED:
        sys.modules.pop("aiosqlite", None)
        _STUB_INSTALLED = False


class TagDatabaseManagerDurabilityTests(unittest.TestCase):
    def setUp(self):
        self.db_path = _support.temp_path(".db")
        _install_aiosqlite_stub()
        self.module = _support.load("shared.db.db_manager", "shared/db/db_manager.py")
        self._original_aiosqlite = self.module.aiosqlite
        self.module.aiosqlite = _FakeAiosqlite()
        self.manager = self.module.TagDatabaseManager(str(self.db_path))

    def tearDown(self):
        self.module.aiosqlite = self._original_aiosqlite
        _remove_aiosqlite_stub()
        _support.discard(self.db_path)

    def run_scenario(self, scenario):
        async def runner():
            try:
                return await scenario(self.manager)
            finally:
                await self.manager.close()

        return asyncio.run(runner())

    def test_connection_enables_wal_busy_timeout_and_normal_sync(self):
        async def scenario(manager):
            connection = await manager.get_connection()
            values = []
            for pragma in ("PRAGMA journal_mode", "PRAGMA busy_timeout", "PRAGMA synchronous"):
                cursor = await connection.execute(pragma)
                row = await cursor.fetchone()
                values.append(row[0])
            return values

        journal_mode, busy_timeout, synchronous = self.run_scenario(scenario)
        self.assertEqual(journal_mode, "wal")
        self.assertEqual(busy_timeout, 5000)
        self.assertEqual(synchronous, 1)  # 1 == NORMAL

    def test_insert_tag_is_committed_and_visible_to_other_connections(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tag("solo_tag", 0, 7, "独标签")
            observer = sqlite3.connect(str(self.db_path))
            try:
                return observer.execute(
                    "SELECT post_count FROM hot_tags WHERE tag = ?", ("solo_tag",)
                ).fetchone()
            finally:
                observer.close()

        self.assertEqual(self.run_scenario(scenario), (7,))

    def test_insert_tag_survives_close(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tag("miku", 4, 42, "初音未来")
            await manager.close()
            reopened = self.module.TagDatabaseManager(str(self.db_path))
            try:
                return await reopened.get_tag("miku"), await reopened.get_tags_count()
            finally:
                await reopened.close()

        tag, count = self.run_scenario(scenario)
        self.assertEqual(count, 1)
        self.assertEqual(tag["post_count"], 42)
        self.assertEqual(tag["translation_cn"], "初音未来")

    async def fts_terms(self, manager, term):
        connection = await manager.get_connection()
        cursor = await connection.execute(
            "SELECT rowid FROM hot_tags_fts WHERE hot_tags_fts MATCH ?", (term,)
        )
        return [row[0] for row in await cursor.fetchall()]

    def test_rebuild_fts_index_can_run_twice_on_the_same_database(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 1, "translation_cn": "初音未来"},
                {"tag": "b_tag", "category": 0, "post_count": 1},
            ])
            first = await manager.rebuild_fts_index()
            second = await manager.rebuild_fts_index()
            matches = await self.fts_terms(manager, "初音未来")
            health = await manager.check_database_health()
            return first, second, matches, health

        first, second, matches, health = self.run_scenario(scenario)
        self.assertEqual((first, second), (2, 2))
        self.assertEqual(len(matches), 1)
        self.assertEqual(health, (True, None))

    def test_rebuild_fts_index_leaves_no_phantom_matches(self):
        """Regression: writing rows straight into the index left stale entries behind."""

        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 1, "translation_cn": "初音未来"},
            ])
            await manager.rebuild_fts_index()
            # INSERT OR REPLACE moves the row to a new rowid through the sync triggers
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 2, "translation_cn": "初音未来"},
            ])
            rebuilt = await manager.rebuild_fts_index()
            matches = await self.fts_terms(manager, "初音未来")
            connection = await manager.get_connection()
            cursor = await connection.execute("SELECT rowid FROM hot_tags WHERE tag = 'hatsune_miku'")
            live = (await cursor.fetchone())[0]
            return rebuilt, matches, live

        rebuilt, matches, live = self.run_scenario(scenario)
        self.assertEqual(rebuilt, 1)
        self.assertEqual(matches, [live])

    def test_rebuild_fts_index_tolerates_deleted_rows(self):
        async def scenario(manager):
            await manager.initialize_database()
            await manager.insert_tags_batch([
                {"tag": "hatsune_miku", "category": 4, "post_count": 1, "translation_cn": "初音未来"},
                {"tag": "b_tag", "category": 0, "post_count": 1},
            ])
            await manager.rebuild_fts_index()
            connection = await manager.get_connection()
            await connection.execute("UPDATE hot_tags SET last_updated = 1")
            await connection.commit()
            removed = await manager.delete_old_tags(30)
            rebuilt = await manager.rebuild_fts_index()
            return removed, rebuilt, await self.fts_terms(manager, "初音未来")

        removed, rebuilt, matches = self.run_scenario(scenario)
        self.assertEqual(removed, 2)
        self.assertEqual(rebuilt, 0)
        self.assertEqual(matches, [])


if __name__ == "__main__":
    unittest.main()
