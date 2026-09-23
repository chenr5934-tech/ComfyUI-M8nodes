"""工作台的数据文件。

四类，每类一个 json：
    oc        原创角色（带例图）
    prompts   概念提示词卡片
    groups    提示词卡片的分类
    stickers  贴纸库

**存在用户目录下（~/M8/webapp），不在插件目录里。** 这不是随手选的：
插件更新会把 custom_nodes 里的东西整个换掉，ComfyUI 整合包升级更狠 —— 直接清空重装。
这些数据是用户一条条攒的，丢了找不回来，所以必须待在插件够不着的地方。
路径用 Path.home() 算，别人装这个插件时落到的就是**他自己的**用户目录。

文件形状和网页上「导出备份」的信封一致，两边可以互相喂：
    {"app": "m8web", "kind": "oc", "v": 1, "at": "...", "count": N, "data": [...]}

读写都是「整份读进来、改、整份写回去」。数据量不大（大头是几张内嵌的图，
几十 MB 封顶），简单可靠比省那几个毫秒重要。写的时候先落临时文件再 os.replace，
中途断电也不会留下半截 json。
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from . import paths
from .errors import M8Error

# 四类数据。put/delete 的 kind 必须落在这里面，不然就是打错字了。
KINDS = ("oc", "prompts", "groups", "stickers")

# 同一进程里并发写同一个文件会互相覆盖，加把锁。
# 跨进程（CUI 和独立服务同时开着）没有锁 —— 那种情况损失的是「同一瞬间两边都在写」
# 里较晚的一次。实际用起来几乎不会碰上，而且两个入口读的是同一份文件，
# 谁都不会看到过期很久的数据。真要做跨进程锁得碰 msvcrt/fcntl，为这点概率不值得。
_LOCK = threading.RLock()


def data_file(kind: str) -> Path:
    """某一类数据落在哪个文件。kind 不认识就抛。"""
    if kind not in KINDS:
        raise M8Error(
            "M8-WEB-007",
            message="不认识的数据类别",
            hint="只支持 " + " / ".join(KINDS),
            detail=repr(kind)[:80],
        )
    return paths.WEBAPP_DATA_DIR / (kind + ".json")


def ensure_dir() -> Path:
    """把数据目录建出来。建不出来就说清楚是权限问题。"""
    try:
        paths.WEBAPP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise M8Error(
            "M8-WEB-008",
            message="建不出数据目录",
            hint="检查这个目录的写权限：" + str(paths.WEBAPP_DATA_DIR),
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    return paths.WEBAPP_DATA_DIR


def read(kind: str) -> list[dict[str, Any]]:
    """读一整类。文件不在、读不动、内容坏了 —— 一律当成空，不抛。

    读的时候要宽容：数据文件坏掉不该让整个工作台打不开，
    大不了从备份导回来。
    """
    path = data_file(kind)
    if not path.is_file():
        return []
    try:
        with _LOCK:
            raw = path.read_text(encoding="utf-8")
        obj = json.loads(raw)
    except (OSError, json.JSONDecodeError):
        return []
    rows = obj.get("data") if isinstance(obj, dict) else obj
    if not isinstance(rows, list):
        return []
    return [r for r in rows if isinstance(r, dict)]


def write(kind: str, rows: list[dict[str, Any]]) -> int:
    """整份写回去。返回写了几条。"""
    # kind 会被拼进文件名，所以必须走白名单 —— 别的读写路径都查了，这里漏过一次
    if kind not in KINDS:
        raise M8Error(
            "M8-WEB-007",
            message="不认识的数据类别",
            hint="只支持 " + " / ".join(KINDS) + " 这四类",
            detail=str(kind),
        )
    path = ensure_dir() / (kind + ".json")
    payload = {
        "app": "m8web",
        "kind": kind,
        "v": 1,
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "count": len(rows),
        "data": list(rows),
    }
    tmp = path.with_suffix(".json.tmp")
    try:
        with _LOCK:
            with open(tmp, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False)
            os.replace(tmp, path)
    except OSError as exc:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
        raise M8Error(
            "M8-WEB-009",
            message="写数据文件失败",
            hint="检查磁盘空间和这个目录的写权限：" + str(path.parent),
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    return len(rows)


def _next_id(rows: list[dict[str, Any]]) -> int:
    top = 0
    for r in rows:
        try:
            v = int(r.get("id") or 0)
        except (TypeError, ValueError):
            continue
        if v > top:
            top = v
    return top + 1


def put(kind: str, rec: dict[str, Any]) -> int:
    """新增或更新一条。没带 id 就分配一个，返回最终的 id。"""
    if not isinstance(rec, dict):
        raise M8Error("M8-WEB-010", message="要存的不是一条记录", hint="这是内部调用出错")
    rows = read(kind)
    item = dict(rec)
    rid = item.get("id")
    if isinstance(rid, int) and rid > 0:
        for i, r in enumerate(rows):
            if r.get("id") == rid:
                rows[i] = item
                write(kind, rows)
                return rid
    else:
        rid = _next_id(rows)
        item["id"] = rid
    rows.append(item)
    write(kind, rows)
    return int(rid)


def drop(kind: str, rec_id: int) -> bool:
    """删一条。返回有没有真的删掉。"""
    rows = read(kind)
    keep = [r for r in rows if r.get("id") != rec_id]
    if len(keep) == len(rows):
        return False
    write(kind, keep)
    return True


def replace(kind: str, rows: list[dict[str, Any]]) -> int:
    """整份换掉（导入备份用）。id 一律重发，免得和现有记录撞。"""
    clean: list[dict[str, Any]] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        item = dict(r)
        item.pop("id", None)
        clean.append(item)
    for i, item in enumerate(clean, start=1):
        item["id"] = i
    return write(kind, clean)


def info() -> dict[str, Any]:
    """每类多少条、文件多大、目录在哪。给 /m8/health 和设置界面用。"""
    out: dict[str, Any] = {
        "dir": str(paths.WEBAPP_DATA_DIR),
        "dirExists": paths.WEBAPP_DATA_DIR.is_dir(),
        "kinds": {},
    }
    for kind in KINDS:
        path = data_file(kind)
        size = 0
        try:
            if path.is_file():
                size = path.stat().st_size
        except OSError:
            size = 0
        out["kinds"][kind] = {"count": len(read(kind)), "bytes": size}
    return out


__all__ = [
    "KINDS",
    "data_file",
    "ensure_dir",
    "read",
    "write",
    "put",
    "drop",
    "replace",
    "info",
]
