"""DeepSeek 余额查询。

端点：GET https://api.deepseek.com/user/balance
认证：Authorization: Bearer <API Key>

**一个踩过的坑**（来自原挂件项目 MeteorNOX/DeepSeek-Balance-Whale-Widget 的规格文档）：
balance_infos 是多币种数组，而且**顺序不固定**，直接取 [0] 会出现今天显示 CNY、
明天显示 USD 这种事。展示项的挑选规则必须显式写出来，见 pick_primary。
"""

from __future__ import annotations

import json
import time
from typing import Any

from ...core.errors import M8Error
from ...core.log import SHELF_UI, log
from ...server import llm_api

BALANCE_URL = "https://api.deepseek.com/user/balance"


def _amount(item: dict, key: str) -> float:
    """把接口给的金额字符串转成数字。转不动就当 0，不抛异常。

    接口返回的是字符串（"110.00"），不是数字 —— 直接拿去比较会变成字母序。
    """
    try:
        return float(str(item.get(key, "0")).strip())
    except (TypeError, ValueError):
        return 0.0


def normalize(item: dict) -> dict[str, Any]:
    """把一条 balance_info 整理成前端好用的形状（原文 + 数值都留着）。"""
    return {
        "currency": str(item.get("currency") or ""),
        "total": str(item.get("total_balance") or "0"),
        "granted": str(item.get("granted_balance") or "0"),
        "toppedUp": str(item.get("topped_up_balance") or "0"),
        "totalValue": _amount(item, "total_balance"),
        "grantedValue": _amount(item, "granted_balance"),
        "toppedUpValue": _amount(item, "topped_up_balance"),
    }


def pick_primary(items: list[dict]) -> dict | None:
    """挑一个用来展示的币种。

    四条规则，按顺序试（顺序不是随便定的，理由写在括号里）：

        1. CNY 且余额 > 0   （用户多半用人民币，优先显示有余额的那个）
        2. 任意余额 > 0 的   （没有人民币余额时，至少显示一个真的有钱的）
        3. CNY              （全都没余额，那就显示人民币，0 元也是有意义的信息）
        4. 第一项            （兜底：什么币种都认，总比空着强）
    """
    if not items:
        return None

    cny = [i for i in items if i["currency"].upper() == "CNY"]

    # 有余额的按金额降序排，金额相同再按币种名 —— **不能直接用数组顺序**。
    # 接口给的多币种顺序不固定，取 positive[0] 会出现同一个账户
    # 今天显示 USD、明天显示 HKD。这个坑原项目文档里写过，我照抄代码时又踩了一次，
    # 是测试用「同一组数据正序/倒序结果必须一致」把它抓出来的。
    positive = sorted(
        (i for i in items if i["totalValue"] > 0),
        key=lambda i: (-i["totalValue"], i["currency"]),
    )
    # 兜底同理：按币种名排，给一个与输入顺序无关的确定结果
    by_name = sorted(items, key=lambda i: i["currency"])

    for candidate in (
        next((i for i in cny if i["totalValue"] > 0), None),
        positive[0] if positive else None,
        cny[0] if cny else None,
        by_name[0] if by_name else None,
    ):
        if candidate:
            return candidate
    return None


def fetch_balance(api_key: str, timeout: float = 20) -> dict[str, Any]:
    """查一次余额。

    api_key 为空时报 M8-UI-001 —— 这是最常见的失败，给个明确的码比让
    接口返回 401 更省事。
    """
    if not (api_key or "").strip():
        raise M8Error("M8-UI-001")

    try:
        _, data = llm_api.get_json(BALANCE_URL, api_key, "deepseek", timeout)
    except M8Error as exc:
        # 401/403 是密钥的问题，不是网络 —— 换成余额自己的码，查表更直接
        if exc.code == "M8-LLM-004":
            raise M8Error("M8-UI-002", message=exc.message, hint=exc.hint, detail=exc.detail) from exc
        raise

    infos = data.get("balance_infos")
    if not isinstance(infos, list):
        raise M8Error("M8-UI-003", detail=json.dumps(data, ensure_ascii=False)[:400])

    items = [normalize(item) for item in infos if isinstance(item, dict)]
    primary = pick_primary(items)

    log(
        f"余额已取：{len(items)} 个币种"
        + (f"，展示 {primary['currency']} {primary['total']}" if primary else ""),
        SHELF_UI,
    )

    return {
        "available": bool(data.get("is_available")),
        "items": items,
        "primary": primary,
        "fetchedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
