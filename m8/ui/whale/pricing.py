"""DeepSeek 的计价。

价格表来自原挂件项目（MeteorNOX/DeepSeek-Balance-Whale-Widget），
单位是**人民币元 / 百万 token**，每一项是 [空闲时段价, 高峰时段价]。

改动价格只需要改这一个文件 —— 换成别家的时候，把 MODEL_PRICES 的表换掉，
上层（用量换算、每轮消耗提示）一行都不用动。

**这是估算不是账单**：DeepSeek 的定价会调，而且不同模型、不同缓存命中率的
单价不一样。用它判断「今天花了多少量级」，别拿它对账。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

# 高峰时段：北京时间每天 9:00–12:00 和 14:00–18:00，其余时间便宜
PEAK_HOURS: tuple[tuple[int, int], ...] = ((9, 12), (14, 18))

BEIJING = timezone(timedelta(hours=8))

# (缓存命中, 缓存未命中, 输出)，每项是 (空闲价, 高峰价)
PRICE_BASE = {"hit": (0.05, 0.1), "miss": (1.5, 3.0), "out": (4.5, 9.0)}
PRICE_PRO = {"hit": (0.15, 0.3), "miss": (4.5, 9.0), "out": (13.5, 27.0)}

# 模型名里含哪个关键词就用哪张表。按顺序匹配，先命中的算。
MODEL_PRICES: tuple[tuple[str, dict], ...] = (
    ("deepseek-v4-pro", PRICE_PRO),
    ("deepseek-v4-flash", PRICE_BASE),
    ("deepseek-chat", PRICE_BASE),
    ("deepseek-reasoner", PRICE_BASE),
)
DEFAULT_PRICES = PRICE_BASE


def price_for(model: str) -> dict:
    """按模型名挑价格表。认不出来就用基础价 —— 宁可估低也不要不出数。"""
    name = str(model or "").lower()
    for keyword, table in MODEL_PRICES:
        if keyword in name:
            return table
    return DEFAULT_PRICES


def is_peak(at: datetime | None = None) -> bool:
    """现在是不是高峰时段（按北京时间算）。"""
    moment = at.astimezone(BEIJING) if at else datetime.now(BEIJING)
    hour = moment.hour
    return any(start <= hour < end for start, end in PEAK_HOURS)


def cost_of(model: str, usage: dict, at: datetime | None = None) -> float:
    """按一次调用的 usage 算钱（元）。

    usage 用 OpenAI 那套字段：

        prompt_tokens                 输入总数
        completion_tokens             输出
        prompt_cache_hit_tokens       输入里命中缓存的（便宜很多）
        prompt_cache_miss_tokens      输入里没命中的

    有的实现不给 cache 那两个字段，那就整段按未命中算 —— 算出来偏贵，
    但比不算强。
    """
    if not isinstance(usage, dict):
        return 0.0

    def number(key: str) -> int:
        try:
            return int(usage.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    hit = number("prompt_cache_hit_tokens")
    prompt = number("prompt_tokens")
    miss = number("prompt_cache_miss_tokens")
    if miss <= 0:
        miss = max(0, prompt - hit)
    out = number("completion_tokens")

    index = 1 if is_peak(at) else 0
    table = price_for(model)

    total = (
        hit * table["hit"][index]
        + miss * table["miss"][index]
        + out * table["out"][index]
    )
    return total / 1_000_000.0


def format_money(value: float) -> str:
    """金额显示：小额给四位小数，不然 ¥0.00 什么也看不出。"""
    amount = float(value or 0)
    if amount == 0:
        return "¥0"
    if abs(amount) < 0.01:
        return f"¥{amount:.4f}"
    return f"¥{amount:.2f}"
