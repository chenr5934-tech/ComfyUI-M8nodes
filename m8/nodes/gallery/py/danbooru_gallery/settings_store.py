"""Atomic JSON settings storage with a short-lived read cache.

Two failure modes of the gallery node are handled here:

* A plain `open(path, 'w')` truncates the file before the new bytes land.  A
  reader that hits that instant parses half a document, the loader swallows the
  error and falls back to defaults, and the user's favourites appear to vanish.
  :meth:`JsonFileStore.write` writes a sibling temp file, fsyncs it and swaps it
  in with :func:`os.replace`, so readers only ever see a complete document.
* The image proxy re-read the settings file once per thumbnail.  :meth:`JsonFileStore.read_cached`
  serves the parsed payload for `ttl` seconds and drops it as soon as the file's
  mtime or size changes, so edits still take effect within one TTL window.

The module deliberately imports nothing from the project: ComfyUI, torch and the
logger are out of scope, which keeps it importable (and testable) on a bare
interpreter.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
import time
from pathlib import Path

DEFAULT_TTL_SEC = 5.0
# A Windows reader holding the file open can block the swap for a few ms.
_REPLACE_ATTEMPTS = 5
_REPLACE_DELAY_SEC = 0.01


def clamp_int(value, default: int, minimum: int, maximum: int) -> int:
    """Coerce a settings value into [minimum, maximum], falling back to default.

    A misconfigured value (None, "", 0, 10000) must never disable or blow up the
    feature it configures, hence the fallback instead of an exception.
    """
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


class JsonFileStore:
    """One JSON document on disk: atomic writes, TTL-cached reads."""

    def __init__(self, path, ttl: float = DEFAULT_TTL_SEC, clock=None):
        self._path = Path(path)
        self._ttl = ttl
        self._clock = clock or time.monotonic
        # Re-entrant: mutate() holds it while calling read() and write().
        self._lock = threading.RLock()
        self._cached = None
        self._signature = None
        self._cached_at = 0.0

    @property
    def path(self) -> Path:
        return self._path

    def invalidate(self) -> None:
        """Drop the cached payload; the next read goes to disk."""
        with self._lock:
            self._cached = None
            self._signature = None
            self._cached_at = 0.0

    def _file_signature(self):
        try:
            info = self._path.stat()
        except OSError:
            return None
        return (info.st_mtime_ns, info.st_size)

    def _read_disk(self):
        """Return (payload, signature); payload is None when unreadable or not an object."""
        signature = self._file_signature()
        if signature is None:
            return None, None
        for attempt in range(_REPLACE_ATTEMPTS):
            try:
                with open(self._path, "r", encoding="utf-8") as handle:
                    payload = json.load(handle)
                break
            except OSError:
                # Windows denies the open for a moment while a writer swaps the file.
                if attempt == _REPLACE_ATTEMPTS - 1:
                    return None, signature
                time.sleep(_REPLACE_DELAY_SEC)
            except ValueError:
                return None, signature
        if not isinstance(payload, dict):
            return None, signature
        return payload, signature

    def _remember(self, payload, signature) -> None:
        self._cached = payload
        self._signature = signature
        self._cached_at = self._clock()

    def read(self):
        """Always re-read from disk. Returns None when the document is absent or broken."""
        with self._lock:
            payload, signature = self._read_disk()
            self._remember(payload, signature)
            return payload

    def read_cached(self):
        """Serve the cached payload until it expires or the file changes underneath."""
        with self._lock:
            signature = self._file_signature()
            if (
                self._cached is not None
                and signature is not None
                and signature == self._signature
                and (self._clock() - self._cached_at) < self._ttl
            ):
                return self._cached

            payload, signature = self._read_disk()
            if payload is None:
                if signature is None:
                    # The document is gone: stop serving it.
                    self._remember(None, None)
                    return None
                # Unparsable but present: keep the last good payload rather than
                # presenting empty settings to the caller.
                return self._cached
            self._remember(payload, signature)
            return payload

    def write(self, payload) -> bool:
        """Replace the document atomically so concurrent readers see old or new, never half."""
        with self._lock:
            directory = self._path.parent
            descriptor, temp_name = tempfile.mkstemp(
                prefix=f".{self._path.name}.", suffix=".tmp", dir=str(directory)
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump(payload, handle, ensure_ascii=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                # mkstemp creates 0600; keep the mode of the file being replaced.
                try:
                    os.chmod(temp_name, os.stat(self._path).st_mode)
                except OSError:
                    pass
                self._replace(temp_name)
            except BaseException:
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass
                raise
            self._remember(dict(payload), self._file_signature())
            return True

    def _replace(self, temp_name) -> None:
        """Swap the temp file in, retrying briefly while another process holds it open."""
        last_error = None
        for attempt in range(_REPLACE_ATTEMPTS):
            try:
                os.replace(temp_name, self._path)
                return
            except OSError as exc:
                last_error = exc
                time.sleep(_REPLACE_DELAY_SEC * (attempt + 1))
        raise last_error

    def mutate(self, mutator):
        """Read-modify-write under the store lock so concurrent writers cannot interleave."""
        with self._lock:
            current = self.read()
            updated = mutator(dict(current) if isinstance(current, dict) else {})
            if updated is None:
                updated = current if isinstance(current, dict) else {}
            self.write(updated)
            return updated

    def update(self, **values):
        """Merge keyword values into the document under the store lock."""
        return self.mutate(lambda payload: {**payload, **values})
