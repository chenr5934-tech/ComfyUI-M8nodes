"""Behavior tests for the isolated Danbooru and Gelbooru HTTP transports.

Migrated from tools/test_gallery_site_clients.py; adds URL-allowlist boundary
coverage for _validate_site_url.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _support

CLIENTS = _support.load("danbooru_gallery.site_clients", "danbooru_gallery/site_clients.py")


class FakeCookies:
    def __init__(self):
        self.values = []

    def set(self, name, value, **kwargs):
        self.values.append((name, value, kwargs))


class FakeResponse:
    def __init__(self, status_code=200, headers=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self.text = text

    def raise_for_status(self):
        if self.status_code >= 400:
            raise CLIENTS.requests.exceptions.HTTPError(response=self)


class FakeSession:
    def __init__(self, responses=None):
        self.headers = {}
        self.cookies = FakeCookies()
        self.responses = list(responses or [FakeResponse()])
        self.calls = []
        self.closed = False

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        result = self.responses.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def close(self):
        self.closed = True


class ValidateSiteUrlTests(unittest.TestCase):
    """Every URL handed to a transport must belong to that transport's site."""

    def test_accepts_apex_subdomain_and_both_schemes(self):
        for url in (
            "https://danbooru.donmai.us/posts.json",
            "http://danbooru.donmai.us/posts.json",
            "https://cdn.donmai.us/data/sample.jpg",
            # urlparse lowercases the host, so mixed-case hosts stay valid
            "https://DANBOORU.DONMAI.US/Posts.json",
        ):
            with self.subTest(url=url):
                CLIENTS._validate_site_url(url, "donmai.us")

    def test_rejects_foreign_hosts(self):
        for url in (
            "https://gelbooru.com/index.php",
            "https://evil.example/danbooru.donmai.us",
            "https://donmai.us.evil.example/posts.json",
            "https://notdonmai.us/posts.json",
            # a trailing dot keeps the FQDN distinct from the allowlisted name
            "https://danbooru.donmai.us./posts.json",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    CLIENTS._validate_site_url(url, "donmai.us")

    def test_rejects_non_http_schemes_and_schemeless_urls(self):
        for url in (
            "ftp://danbooru.donmai.us/posts.json",
            "file:///C:/temp/x.jpg",
            "javascript:alert(1)",
            "danbooru.donmai.us/posts.json",
            "",
        ):
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    CLIENTS._validate_site_url(url, "donmai.us")

    def test_redirect_targets_must_pass_the_same_check(self):
        """A Location header copied out of a response is checked like any URL.

        The transports follow redirects, so a cross-site redirect target is only
        rejected if the caller re-validates it; see tools report.
        """
        CLIENTS._validate_site_url("https://danbooru.donmai.us/posts.json", "donmai.us")
        with self.assertRaises(ValueError):
            CLIENTS._validate_site_url("https://evil.example/steal", "donmai.us")


class GallerySiteClientTests(unittest.TestCase):
    def test_sensitive_query_values_are_redacted_from_logs(self):
        safe_url = CLIENTS._safe_url_for_log(
            "https://danbooru.donmai.us/posts.json?login=alice&api_key=secret&tags=1girl"
        )
        self.assertNotIn("alice", safe_url)
        self.assertNotIn("secret", safe_url)
        self.assertIn("tags=1girl", safe_url)

    def test_transports_reject_cross_site_urls_without_touching_the_session(self):
        danbooru_session = FakeSession()
        danbooru = CLIENTS.DanbooruHttpClient(danbooru_session)
        gelbooru = CLIENTS.GelbooruHttpClient()
        with self.assertRaises(ValueError):
            danbooru.request("GET", "https://gelbooru.com/index.php")
        with self.assertRaises(ValueError):
            gelbooru.request("GET", "https://danbooru.donmai.us/posts.json")
        self.assertEqual(danbooru_session.calls, [])

    def test_site_headers_and_sessions_are_independent(self):
        danbooru_session = FakeSession()
        gelbooru_session = FakeSession()
        danbooru = CLIENTS.DanbooruHttpClient(danbooru_session)
        gelbooru = CLIENTS.GelbooruHttpClient()
        gelbooru._sessions[False] = gelbooru_session
        danbooru.rate_limiter.min_interval = 0
        gelbooru._limiters["api"].min_interval = 0

        danbooru.request("GET", "https://danbooru.donmai.us/posts.json")
        gelbooru.request("GET", "https://gelbooru.com/index.php", request_kind="api")

        d_headers = danbooru_session.calls[0][2]["headers"]
        g_headers = gelbooru_session.calls[0][2]["headers"]
        self.assertEqual(d_headers["User-Agent"], "Danbooru-Gallery/1.0")
        self.assertNotIn("Referer", d_headers)
        self.assertEqual(g_headers["Referer"], "https://gelbooru.com/")
        self.assertIn("Mozilla/5.0", g_headers["User-Agent"])

    def test_display_all_sessions_are_kept_separate(self):
        normal_session = FakeSession()
        display_all_session = FakeSession()
        client = CLIENTS.GelbooruHttpClient()
        with mock.patch.object(CLIENTS.requests, "Session", side_effect=[normal_session, display_all_session]), \
             mock.patch.object(client, "_configure_display_all") as configure:
            self.assertIs(client.get_session(False), normal_session)
            self.assertIs(client.get_session(True), display_all_session)
            self.assertIs(client.get_session(False), normal_session)
            configure.assert_called_once_with(display_all_session)

    def test_unknown_request_kind_is_rejected(self):
        client = CLIENTS.GelbooruHttpClient()
        with self.assertRaises(ValueError):
            client.request("GET", "https://gelbooru.com/index.php", request_kind="bogus")

    def test_danbooru_retry_does_not_touch_gelbooru_transport(self):
        danbooru_session = FakeSession([
            FakeResponse(429, {"Retry-After": "0.5"}),
            FakeResponse(200),
        ])
        gelbooru_session = FakeSession([FakeResponse(200)])
        danbooru = CLIENTS.DanbooruHttpClient(danbooru_session)
        gelbooru = CLIENTS.GelbooruHttpClient()
        gelbooru._sessions[False] = gelbooru_session
        danbooru.rate_limiter.min_interval = 0
        gelbooru._limiters["api"].min_interval = 0

        with mock.patch.object(CLIENTS.time, "sleep") as sleep:
            response = danbooru.request("GET", "https://danbooru.donmai.us/posts.json")
        self.assertEqual(response.status_code, 200)
        sleep.assert_called_once_with(0.5)
        self.assertEqual(len(gelbooru_session.calls), 0)

    def test_retry_delay_is_clamped_to_the_retry_after_window(self):
        self.assertEqual(CLIENTS._retry_delay(FakeResponse(429, {"Retry-After": "0.1"})), 0.5)
        self.assertEqual(CLIENTS._retry_delay(FakeResponse(429, {"Retry-After": "120"})), 10.0)
        self.assertEqual(CLIENTS._retry_delay(FakeResponse(429, {"Retry-After": "oops"})), 2.0)
        self.assertEqual(CLIENTS._retry_delay(FakeResponse(429, {})), 2.0)

    def test_gelbooru_retries_network_failure_inside_its_transport(self):
        session = FakeSession([
            CLIENTS.requests.exceptions.ConnectionError("offline"),
            FakeResponse(200),
        ])
        client = CLIENTS.GelbooruHttpClient()
        client._sessions[False] = session
        client._limiters["public"].min_interval = 0
        with mock.patch.object(CLIENTS.time, "sleep") as sleep:
            response = client.request(
                "GET",
                "https://gelbooru.com/index.php",
                request_kind="public",
            )
        self.assertEqual(response.status_code, 200)
        sleep.assert_called_once_with(3.0)


if __name__ == "__main__":
    unittest.main()
