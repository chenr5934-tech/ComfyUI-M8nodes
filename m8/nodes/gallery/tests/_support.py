"""Helpers that load modules from py/ by file path, with ComfyUI out of the loop.

The modules under py/ use package-relative imports, so each one is executed
inside a synthetic package whose __path__ mirrors py/ on disk.  Nothing from
folder_paths, server or torch is imported, which keeps the suite runnable on a
plain interpreter.
"""

from __future__ import annotations

import importlib.util
import logging
import sys
import tempfile
import types
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_ROOT = ROOT / "py"
PACKAGE = "m8_under_test"


def _register_package(name: str, path: Path) -> types.ModuleType:
    module = sys.modules.get(name)
    if module is None:
        module = types.ModuleType(name)
        module.__path__ = [str(path)]
        module.__package__ = name
        sys.modules[name] = module
    return module


def _register_logger_stub(qualified_name: str) -> None:
    """py modules import ..utils.logger; stdlib logging is enough for tests."""
    if qualified_name in sys.modules:
        return
    stub = types.ModuleType(qualified_name)
    stub.get_logger = logging.getLogger
    sys.modules[qualified_name] = stub


def temp_path(suffix: str = "") -> Path:
    """A unique path inside the system temp directory.

    Artifacts stay directly in the temp root: a confined sandbox may refuse
    writes inside a freshly created subdirectory.
    """
    return Path(tempfile.gettempdir()) / f"m8_test_{uuid.uuid4().hex}{suffix}"


def discard(*paths: Path) -> None:
    """Best-effort cleanup of test artifacts (plus SQLite sidecar files)."""
    for path in paths:
        path = Path(path)
        for candidate in (path, path.with_name(f"{path.name}-wal"), path.with_name(f"{path.name}-shm")):
            try:
                candidate.unlink()
            except OSError:
                pass


def prepare() -> None:
    """Register the synthetic package tree every load() call relies on."""
    _register_package(PACKAGE, PY_ROOT)
    _register_package(f"{PACKAGE}.utils", PY_ROOT / "utils")
    _register_logger_stub(f"{PACKAGE}.utils.logger")


def load(module_name: str, relative_path: str):
    """Execute py/<relative_path> as f"{PACKAGE}.{module_name}" and return it."""
    prepare()
    qualified = f"{PACKAGE}.{module_name}"
    cached = sys.modules.get(qualified)
    if cached is not None:
        return cached
    spec = importlib.util.spec_from_file_location(qualified, PY_ROOT / relative_path)
    if spec is None or spec.loader is None:  # pragma: no cover - misconfigured path
        raise ImportError(f"cannot load {relative_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[qualified] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(qualified, None)
        raise
    return module
