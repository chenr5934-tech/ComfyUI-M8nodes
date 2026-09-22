"""对话框的历史记录。

**为什么存服务端**：原来存浏览器 localStorage，丢过一回 —— 关掉 ComfyUI
再打开就空了。可能的原因有一串（清缓存、换浏览器 profile、隐私模式、
容量上限），而 localStorage 写失败时**不告诉你为什么**：setItem 抛一个
异常，浏览器不给细节，前端那个 catch 就把线索一起吞了。

存服务端能绕开这一整类问题：文件在 m8/data/ 下，浏览器怎么折腾它都在。

**存什么**：只留用户和鲸鱼说过的话（user / assistant 的文本）。
工具调用的中间状态（assistant 的 tool_calls、role=tool 的结果）不存 ——
它们的格式必须和模型给的逐字一致，从磁盘读回来再拼进请求，
一旦有出入就是 400，而这种事只在下次对话时才暴露。反正「它改了什么」
本来就要写进鲸鱼的回答里。
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from ...core import paths
from ...core.log import SHELF_UI, warn

_LOCK = threading.RLock()
BEIJING = timezone(timedelta(hours=8))

# 留多少条。一次对话两条（问 + 答），这里够聊一百轮。
MAX_TURNS = 200
MAX_CONTENT_CHARS = 20000


def _now_text() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M:%S")


def _load() -> dict[str, Any]:
    try:
        with open(paths.WHALE_HISTORY_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        # 文件不在或者坏了都当空的 —— 聊天记录丢了，不该连对话框都打不开
        return {}


def _save(data: dict[str, Any]) -> None:
    paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = paths.WHALE_HISTORY_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, paths.WHALE_HISTORY_FILE)


def slim(items: Any) -> list[dict[str, str]]:
    """把前端给的记录收拾成能存的样子。

    两条规矩：

    - 只留 user / assistant 的文本。工具往返的中间状态丢弃，理由见文件头。
    - 多模态的 content 数组压成纯文本加一个 [图片] 标记：一张 data URL 就是
      几 MB，存几条就能把这个文件撑到几十兆。
    """
    if not isinstance(items, list):
        return []

    out: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()
        if role not in ("user", "assistant"):
            continue

        content = item.get("content")
        if isinstance(content, list):
            text = " ".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            ).strip()
            has_image = any(
                isinstance(part, dict) and part.get("type") == "image_url"
                for part in content
            )
            content = f"{text} [图片]".strip() if has_image else text
        if not isinstance(content, str):
            continue

        content = content.strip()[:MAX_CONTENT_CHARS]
        if not content:
            continue
        out.append({"role": role, "content": content})

    return out[-MAX_TURNS:]


def load() -> dict[str, Any]:
    """读记录，返回 {turns, updatedAt}。"""
    with _LOCK:
        data = _load()
        turns = data.get("turns")
        return {
            "turns": turns if isinstance(turns, list) else [],
            "updatedAt": data.get("updatedAt") or "",
        }


def save(items: Any) -> dict[str, Any]:
    """覆盖保存。返回真正落盘的内容（可能比传进来的短）。"""
    cleaned = slim(items)
    with _LOCK:
        # 这里**不能**静默：存不上就直说。上次丢记录就是因为写失败没人知道。
        _save({"turns": cleaned, "updatedAt": _now_text()})
    return {"turns": cleaned, "updatedAt": _now_text()}


def clear() -> None:
    with _LOCK:
        _save({"turns": [], "updatedAt": _now_text()})
