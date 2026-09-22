"""用量记账：「今日已用」多少钱。

原项目（MeteorNOX/DeepSeek-Balance-Whale-Widget）的做法，这里照搬思路：

    每次观测余额 -> 和上次比 -> 变少了就是花了钱 -> 累加进今天

**为什么不用平台用量接口**：那个要平台会话令牌（不是 API Key），
而且按账号统计。用余额差值记账只需要已经在手的 API Key，
统计的也正是这个 key 花的钱 —— 单人单钥的场景下反而更准。

**代价**：只有观测到的那段时间才算得准。插件没开的时候花的钱，
会在下次观测时一次算进来（表现为某天突然多了一笔）。
想更准就让它常开，或者把刷新间隔调小。

存 m8/data/whale-usage.json。跨天自动归档，只留最近 30 天。
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
KEEP_DAYS = 30


def _today() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d")


def _now_text() -> str:
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M:%S")


def _load() -> dict[str, Any]:
    try:
        with open(paths.WHALE_USAGE_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        # 文件不在或坏了都从零开始 —— 这是个统计，丢了不影响任何功能
        return {}


def _save(data: dict[str, Any]) -> None:
    try:
        paths.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = paths.WHALE_USAGE_FILE.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, paths.WHALE_USAGE_FILE)
    except OSError as exc:
        # 记不上就算了。不能因为一个统计写不进去，把查余额也搞挂。
        warn(f"用量记账写不进磁盘：{exc}", SHELF_UI)


def observe(total: float, currency: str = "") -> dict[str, Any]:
    """观测一次余额，更新今日已用。

    只在余额**变少**时累加：变多了是充值，不是消费。
    """
    with _LOCK:
        data = _load()
        today = _today()
        currency = (currency or "").upper()

        # 跨天：归档昨天的，重开今天
        if data.get("date") != today:
            if data.get("date") and float(data.get("spent") or 0) > 0:
                history = data.get("history") or []
                history.append({"date": data["date"], "spent": round(float(data["spent"]), 6)})
                data["history"] = history[-KEEP_DAYS:]
            data["date"] = today
            data["spent"] = 0.0
            data["last"] = None
            data["currency"] = currency

        # 币种变了就把基准丢掉：拿人民币的余额去减美元的余额会得出一个荒唐的数
        if currency and data.get("currency") and data["currency"] != currency:
            data["last"] = None
            data["currency"] = currency
            data["samples"] = 0

        last = data.get("last")
        if last is not None:
            try:
                delta = float(last) - float(total)
            except (TypeError, ValueError):
                delta = 0.0
            if delta > 0:
                data["spent"] = round(float(data.get("spent") or 0) + delta, 6)

        data["last"] = float(total)
        data["at"] = _now_text()
        data["samples"] = int(data.get("samples") or 0) + 1
        if currency:
            data["currency"] = currency

        _save(data)
        return data


def summary() -> dict[str, Any]:
    """给前端看的今日用量。只读，不动文件。"""
    with _LOCK:
        data = _load()
        today = _today()
        # 跨天之后第一次读：昨天的数不该再显示成「今天」
        stale = data.get("date") != today
        return {
            "date": today,
            "spent": 0.0 if stale else round(float(data.get("spent") or 0), 6),
            "currency": data.get("currency") or "CNY",
            "last": None if stale else data.get("last"),
            "at": data.get("at") if not stale else None,
            "samples": 0 if stale else int(data.get("samples") or 0),
            "history": (data.get("history") or [])[-KEEP_DAYS:],
        }


def reset() -> None:
    """清空记账（设置面板里的「重置今日已用」）。"""
    with _LOCK:
        _save({"date": _today(), "spent": 0.0, "last": None, "samples": 0, "history": []})
