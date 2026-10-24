"""Behavior tests for atomic JSON settings storage.

Loaded by path like the rest of the suite: the module must stay importable
without ComfyUI.  Every case drives real files in the system temp directory.
"""

from __future__ import annotations

import builtins
import json
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support

STORE = _support.load("danbooru_gallery.settings_store", "danbooru_gallery/settings_store.py")
JsonFileStore = STORE.JsonFileStore


class JsonFileStoreTests(unittest.TestCase):
    def setUp(self):
        self.path = _support.temp_path(".json")
        self.store = JsonFileStore(self.path)

    def tearDown(self):
        _support.discard(self.path)

    def test_write_then_read_round_trips(self):
        payload = {"favorites": [{"id": 1}], "language": "zh", "gelbooru_display_all_site_content": False}
        self.assertTrue(self.store.write(payload))
        self.assertEqual(self.store.read(), payload)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8")), payload)

    def test_write_leaves_no_temp_files_behind(self):
        self.store.write({"a": 1})
        self.store.write({"a": 2})
        prefix = "." + self.path.name + "."
        leftovers = sorted(item.name for item in self.path.parent.iterdir() if item.name.startswith(prefix))
        self.assertEqual(leftovers, [])

    def test_write_replaces_the_previous_document_entirely(self):
        self.store.write({"long_key": "x" * 5000})
        self.store.write({"short": 1})
        self.assertEqual(self.store.read(), {"short": 1})
        self.assertNotIn("long_key", self.path.read_text(encoding="utf-8"))

    def test_concurrent_readers_never_observe_partial_json(self):
        """Regression: open(path, 'w') truncated the file a reader was parsing."""

        def payload(marker):
            return {"favorites": [{"id": marker} for _ in range(200)]}

        self.store.write(payload(0))
        stop = threading.Event()
        broken = []
        snapshots = []

        def reader():
            while not stop.is_set():
                try:
                    with open(self.path, "r", encoding="utf-8") as handle:
                        snapshots.append(json.load(handle))
                except ValueError as exc:
                    # The regression under test: a truncated document.
                    broken.append(repr(exc))
                    return
                except OSError:
                    # Windows denies the open for a moment while the file is swapped;
                    # the swap itself is retried, so just read again.
                    continue
                threading.Event().wait(0.001)

        thread = threading.Thread(target=reader)
        thread.start()
        try:
            for marker in range(40):
                self.store.write(payload(marker))
        finally:
            stop.set()
            thread.join()

        self.assertEqual(broken, [])
        self.assertTrue(snapshots)
        for snapshot in snapshots:
            self.assertEqual(sorted(snapshot), ["favorites"])
            self.assertEqual(len(snapshot["favorites"]), 200)

    def test_cached_reads_do_not_touch_the_disk_again(self):
        self.store.write({"image_proxy_concurrency": 6})
        opened = []
        real_open = builtins.open

        def counting_open(file, *args, **kwargs):
            opened.append(str(file))
            return real_open(file, *args, **kwargs)

        with mock.patch("builtins.open", counting_open):
            first = self.store.read_cached()
            baseline = len(opened)
            for _ in range(8):
                repeated = self.store.read_cached()
            extra_opens = len(opened) - baseline

        self.assertEqual(first, {"image_proxy_concurrency": 6})
        self.assertIs(first, repeated)
        self.assertEqual(extra_opens, 0)

    def test_cached_read_notices_a_changed_file_immediately(self):
        self.store.write({"gelbooru_display_all_site_content": False})
        self.assertFalse(self.store.read_cached()["gelbooru_display_all_site_content"])
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"gelbooru_display_all_site_content": True, "note": "size changed"}, handle)
        self.assertTrue(self.store.read_cached()["gelbooru_display_all_site_content"])

    def test_cached_read_expires_after_the_ttl(self):
        now = [1000.0]
        store = JsonFileStore(self.path, ttl=5.0, clock=lambda: now[0])
        store.write({"value": 1})
        reads = []
        original = store._read_disk

        def counting():
            reads.append(1)
            return original()

        store._read_disk = counting
        store.read_cached()  # right after write: cache is warm
        now[0] += 4.0
        store.read_cached()  # still inside the window
        self.assertEqual(len(reads), 0)
        now[0] += 2.0
        store.read_cached()  # window elapsed
        self.assertEqual(len(reads), 1)

    def test_unparsable_document_keeps_the_last_good_payload(self):
        self.store.write({"favorites": [1, 2, 3]})
        self.assertEqual(self.store.read_cached(), {"favorites": [1, 2, 3]})
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write('{"favorites": [1, 2')  # truncated by a non-atomic writer
        self.assertEqual(self.store.read_cached(), {"favorites": [1, 2, 3]})
        self.assertIsNone(self.store.read())

    def test_missing_document_reads_as_none(self):
        self.assertIsNone(self.store.read())
        self.assertIsNone(self.store.read_cached())

    def test_concurrent_mutations_do_not_lose_updates(self):
        self.store.write({"counter": 0})

        def worker():
            for _ in range(15):
                self.store.mutate(lambda payload: {**payload, "counter": payload.get("counter", 0) + 1})

        threads = [threading.Thread(target=worker) for _ in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(self.store.read_cached(), {"counter": 90})

    def test_clamp_int_bounds_and_fallback(self):
        clamp = STORE.clamp_int
        self.assertEqual(clamp(6, 6, 1, 12), 6)
        self.assertEqual(clamp("8", 6, 1, 12), 8)
        self.assertEqual(clamp(0, 6, 1, 12), 1)
        self.assertEqual(clamp(999, 6, 1, 12), 12)
        self.assertEqual(clamp(None, 6, 1, 12), 6)
        self.assertEqual(clamp("", 6, 1, 12), 6)
        self.assertEqual(clamp("wide", 6, 1, 12), 6)


if __name__ == "__main__":
    unittest.main()
