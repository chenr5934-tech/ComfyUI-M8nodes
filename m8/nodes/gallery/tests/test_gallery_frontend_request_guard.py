"""Structural guard tests for the gallery hover/detail request scheduler.

js/danbooru_gallery/danbooru_gallery.js is a browser module living inside a
ComfyUI beforeRegisterNodeDef closure: it cannot be imported by Python. These
tests therefore pin the *shape* of the request guard (debounce, concurrency
cap, abort/timeout wiring) so a later edit cannot silently drop it, and run
node --check so the file keeps parsing.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support

GALLERY_JS = _support.ROOT / "js" / "danbooru_gallery" / "danbooru_gallery.js"
SOURCE = GALLERY_JS.read_text(encoding="utf-8")

NODE_CANDIDATES = (
    shutil.which("node"),
    r"C:\Program Files\nodejs\node.exe",
)


def _const_int(name: str) -> int:
    match = re.search(rf"const {name} = (\d+);", SOURCE)
    if match is None:
        raise AssertionError(f"{name} is not declared as an integer constant")
    return int(match.group(1))


def _slice(start_marker: str, end_marker: str) -> str:
    start = SOURCE.index(start_marker)
    end = SOURCE.index(end_marker, start)
    return SOURCE[start:end]


class HoverDebounceTests(unittest.TestCase):
    def test_debounce_window_is_within_the_agreed_range(self):
        delay = _const_int("HOVER_HYDRATE_DEBOUNCE_MS")
        self.assertGreaterEqual(delay, 120)
        self.assertLessEqual(delay, 200)

    def test_hover_handler_does_not_await_a_detail_fetch_directly(self):
        handler = _slice('wrapper.addEventListener("mouseenter"', 'wrapper.addEventListener("mouseleave"')
        self.assertIn("requestHoverHydratedPost(post, thisTooltipId)", handler)
        self.assertNotIn("await hydrateGelbooruTooltipPost(post)", handler)

    def test_leaving_the_card_drops_pending_hover_hydration(self):
        handler = _slice('wrapper.addEventListener("mouseleave"', 'wrapper.addEventListener("mousemove"')
        self.assertIn("cancelPendingHoverHydrations()", handler)


class ConcurrencyCapTests(unittest.TestCase):
    def test_cap_constant_is_small(self):
        self.assertLessEqual(_const_int("DETAIL_REQUEST_MAX_CONCURRENT"), 4)

    def test_hover_and_prefetch_share_the_slot_gate(self):
        prefetch = _slice("const runGelbooruPrefetch = async () => {", "const enqueueGelbooruPrefetch")
        self.assertIn("withDetailRequestSlot(", prefetch)
        hover = _slice("const requestHoverHydratedPost = (", "// 获取单个帖子的原始数据")
        self.assertIn("withDetailRequestSlot(", hover)

    def test_pump_never_exceeds_the_cap(self):
        pump = _slice("const pumpDetailRequestQueue = () => {", "// 拿一个并发槽位")
        self.assertIn("detailRequestActive < DETAIL_REQUEST_MAX_CONCURRENT", pump)


class AbortAndTimeoutTests(unittest.TestCase):
    def test_detail_fetch_creates_a_controller_with_a_timeout(self):
        body = _slice("const fetchOriginalPost = async (", "const splitTagString =")
        self.assertIn("new AbortController()", body)
        self.assertIn("DETAIL_REQUEST_TIMEOUT_MS", body)
        self.assertIn("signal: requestController.signal", body)
        self.assertIn("clearTimeout(timeoutTimer)", body)

    def test_aborted_requests_are_logged_as_debug_not_errors(self):
        body = _slice("const fetchOriginalPost = async (", "const splitTagString =")
        abort_branch = body[body.index("if (requestController.signal.aborted)"):]
        self.assertIn("logger.debug(", abort_branch[:400])
        self.assertNotIn("logger.error(", abort_branch[:200])

    def test_refresh_and_panel_close_abort_in_flight_details(self):
        reset_branch = _slice("                    if (reset) {", "const requestedStartPage")
        self.assertIn("abortInFlightDetailRequests();", reset_branch)
        close_panel = _slice("const closePanel = async (", "const currentPostInArray")
        self.assertIn("abortInFlightDetailRequests();", close_panel)


class ParsesTests(unittest.TestCase):
    def test_gallery_js_parses(self):
        node = next((candidate for candidate in NODE_CANDIDATES if candidate and Path(candidate).exists()), None)
        if node is None:
            self.skipTest("node executable not available")
        result = subprocess.run(
            [node, "--check", str(GALLERY_JS)],
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
