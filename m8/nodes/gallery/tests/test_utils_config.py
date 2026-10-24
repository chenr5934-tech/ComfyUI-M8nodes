"""Behavior tests for the shared config file helpers in py/utils/config.py.

The module is loaded by path with a stubbed logger, and CONFIG_FILE is pointed
at a temporary file so the real project-root config.json is never touched.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support


class ConfigFileTests(unittest.TestCase):
    def setUp(self):
        self.config_path = _support.temp_path(".json")
        self.module = _support.load("utils.config", "utils/config.py")
        self._original_config_file = self.module.CONFIG_FILE
        self.module.CONFIG_FILE = str(self.config_path)

    def tearDown(self):
        self.module.CONFIG_FILE = self._original_config_file
        self.module._config_cache = {}
        _support.discard(self.config_path)

    def test_load_config_returns_empty_mapping_when_file_is_missing(self):
        self.assertEqual(self.module.load_config(), {})

    def test_load_config_returns_empty_mapping_for_invalid_json(self):
        self.config_path.write_text("{not json", encoding="utf-8")
        self.assertEqual(self.module.load_config(), {})

    def test_save_config_writes_utf8_json_without_escaping_chinese(self):
        settings = {"sampler_node_types": ["KSampler"], "label": "中文"}
        self.assertTrue(self.module.save_config(settings))
        raw = self.config_path.read_text(encoding="utf-8")
        self.assertIn("中文", raw)
        self.assertEqual(json.loads(raw), settings)

    def test_save_config_updates_cache_used_by_get_config(self):
        self.module.save_config({"autocomplete_max_results": 25})
        self.assertEqual(self.module.get_config("autocomplete_max_results"), 25)
        self.assertEqual(self.module.get_config("missing_key", default="fallback"), "fallback")

    def test_saved_config_can_be_loaded_again(self):
        settings = {"sampler_node_types": ["KSampler"], "custom": [1, 2, 3]}
        self.module.save_config(settings)
        self.assertEqual(self.module.load_config(), settings)

    def test_save_config_reports_failure_for_unserializable_payload(self):
        """save_config() must be atomic: a failed payload leaves the file untouched.

        The payload is serialized to memory before any file is touched, and the
        write itself goes to a same-directory temp file followed by os.replace.
        So an unserializable payload returns False and the previous config
        survives byte for byte instead of being truncated into invalid JSON.
        """
        self.assertTrue(self.module.save_config({"kept": 1}))
        before = self.config_path.read_bytes()
        self.assertFalse(self.module.save_config({"kept": 1, "bad": {1, 2}}))
        self.assertTrue(self.config_path.exists())
        self.assertEqual(self.config_path.read_bytes(), before)
        self.assertEqual(json.loads(self.config_path.read_text(encoding="utf-8")), {"kept": 1})
        self.assertEqual(self.module.get_config("kept"), 1)

    def test_failed_save_leaves_no_temp_file_behind(self):
        """The atomic write must clean up its temp file when serialization fails."""
        self.assertTrue(self.module.save_config({"kept": 1}))
        config_dir = self.config_path.parent
        before_entries = {p.name for p in config_dir.iterdir()}
        self.assertFalse(self.module.save_config({"bad": {1, 2}}))
        after_entries = {p.name for p in config_dir.iterdir()}
        self.assertEqual(after_entries - before_entries, set())


class ConfigPathTests(unittest.TestCase):
    def test_config_file_points_at_project_root(self):
        """CONFIG_FILE must resolve to <project root>/config.json, not py/config.json.

        py/utils/config.py is two levels below the root, so a single dirname call
        used to land inside py/ and every user setting was silently ignored.
        """
        module = _support.load("utils.config", "utils/config.py")
        self.assertEqual(Path(module.CONFIG_FILE).resolve(), (_support.ROOT / "config.json").resolve())

    def test_debug_config_file_points_at_project_root(self):
        """py/utils/debug_config.py must read the same project-root config.json."""
        module = _support.load("utils.debug_config", "utils/debug_config.py")
        self.assertEqual(Path(module.CONFIG_FILE).resolve(), (_support.ROOT / "config.json").resolve())


if __name__ == "__main__":
    unittest.main()
