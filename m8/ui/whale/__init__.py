"""小鲸鱼：余额挂件 + 对话窗口。

移植自 MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT）。
原版是 DSH Web 界面的右下角挂件，这里改成 ComfyUI 的形态：

    侧边栏「小鲸鱼」入口      设置面板：启用开关、密钥、模型、系统提示词、思考强度
    悬浮挂件                  右键呼出对话窗口（非模态、可拖拽、可缩放）
    余额                      GET /m8/whale/balance

接口从这个 register(server) 出去，和节点货架的 routes.py 一个模式。
"""

from __future__ import annotations

import asyncio
from typing import Any

from aiohttp import web

from ...core import config
from ...core.errors import M8Error
from ...core.log import SHELF_UI, log
from ...server import providers
from ...server import routes as server_routes
from . import balance, chat, history, pricing, usage

PROVIDER = "deepseek"

# 设置里允许写的键。白名单，不是黑名单 —— 前端传什么都行，
# 但只有这里列出来的会落到 settings.json 里。
WHALE_SETTINGS = {
    "enabled",
    "model",
    "systemPrompt",
    "thinking",
    "temperature",
    "maxTokens",
    "timeout",
    "refreshSeconds",
    "historyLimit",
    "position",
    "dialogSize",
    "scale",
    "sound",
    "soundSet",
    "volume",
    "bubble",
    "avoidScrollbar",
    "scrollbarWidth",
    "peakMode",
    "usageMode",
    "turnCost",
    "turnCostCloseMs",
}


async def _read_json(request: web.Request) -> dict:
    try:
        data = await request.json()
    except Exception as exc:  # noqa: BLE001 aiohttp 的 json 错误类型不稳定
        raise M8Error("M8-SRV-002", message="请求体不是合法 JSON", detail=str(exc)) from exc
    return data if isinstance(data, dict) else {}


def _ok(**fields: Any) -> web.Response:
    return server_routes._ok(**fields)


def _err(exc: M8Error) -> web.Response:
    return server_routes._err(exc)


async def handle_balance(request: web.Request) -> web.Response:
    """GET /m8/whale/balance —— 查一次 DeepSeek 余额。

    密钥一律从服务端读，不接受请求里传 —— 挂件是常驻界面的东西，
    key 跟着请求走会出现在浏览器历史、代理日志里。
    """
    try:
        api_key = config.get_api_key(PROVIDER)
        timeout = float(request.query.get("timeout") or 20)
        data = await asyncio.to_thread(balance.fetch_balance, api_key, timeout)
    except M8Error as exc:
        return _err(exc)
    except Exception as exc:  # noqa: BLE001 兜底，不让裸异常冒到前端
        return _err(M8Error("M8-UI-002", detail=f"{type(exc).__name__}: {exc}"))

    # 顺手记一笔：每次查余额都是一个观测点，用量记账靠的就是这些点之间的差值。
    # 记不上不影响查余额本身 —— 统计坏了不该把主功能拖下水。
    primary = data.get("primary") if isinstance(data, dict) else None
    if primary:
        try:
            await asyncio.to_thread(
                usage.observe, float(primary.get("totalValue") or 0), primary.get("currency") or ""
            )
        except Exception as exc:  # noqa: BLE001
            log(f"用量记账失败（不影响余额显示）：{exc}", SHELF_UI)

    return _ok(
        balance=data,
        provider=PROVIDER,
        masked=config.mask_key(api_key),
        usage=usage.summary(),
        pricing={"peak": pricing.is_peak()},
    )


async def handle_usage(request: web.Request) -> web.Response:
    """GET /m8/whale/usage —— 今日已用（余额差值记账）。"""
    return _ok(usage=usage.summary(), pricing={"peak": pricing.is_peak()})


async def handle_usage_reset(request: web.Request) -> web.Response:
    """POST /m8/whale/usage/reset —— 清空记账。"""
    try:
        await asyncio.to_thread(usage.reset)
    except Exception as exc:  # noqa: BLE001
        return _err(M8Error("M8-CORE-004", message="重置用量记账失败", detail=str(exc)))
    return _ok(usage=usage.summary())


async def handle_state(request: web.Request) -> web.Response:
    """GET /m8/whale/state —— 挂件启动时要的一切：有没有密钥、模型、设置。

    一个请求拿完，省得挂件起来时打三次接口。
    """
    settings = config.load_settings()
    whale = settings.get("whale") or {}
    api_key = config.get_api_key(PROVIDER)
    return _ok(
        hasKey=bool(api_key),
        masked=config.mask_key(api_key),
        settings=whale,
        # 档位只该在 providers.py 里定义一处。前端从这儿拿，不硬编码。
        thinkingOptions=providers.THINKING_OPTIONS,
        # 挂件的菜单要显示「当前是高峰还是空闲」，判断只有一个来源
        isPeak=pricing.is_peak(),
        usage=usage.summary(),
    )


async def handle_chat(request: web.Request) -> web.Response:
    """POST /m8/whale/chat —— 对话往前走一步。

    只跑**一步**：模型要么给出回答，要么要求调工具。工具全在前端执行
    （读队列、改画布、排队都是浏览器的能力），所以循环由前端驱动，
    这个接口保持无状态。

    body:
        messages  完整历史（前端维护，可能含 tool 消息）
        canvas    画布快照（节点编号 / 类型 / 参数），模型靠它决定改哪个节点
        settings  可选的临时覆盖（让对话框能试别的模型而不改全局）
    """
    try:
        body = await _read_json(request)
        result = await asyncio.to_thread(
            chat.step,
            body.get("messages"),
            body.get("canvas"),
            body.get("settings"),
            str(body.get("apiKey") or ""),
        )
    except M8Error as exc:
        return _err(exc)
    except Exception as exc:  # noqa: BLE001 兜底，不让裸异常冒到前端
        return _err(M8Error("M8-UI-002", message="对话失败", detail=f"{type(exc).__name__}: {exc}"))

    return _ok(**result)


async def handle_settings_set(request: web.Request) -> web.Response:
    """POST /m8/whale/settings —— 存小鲸鱼的设置。

    白名单过滤：只有 WHALE_SETTINGS 里列出来的键会落盘。
    另外这是**合并式**保存，前端可以只传改动的那几项。
    """
    try:
        body = await _read_json(request)
        patch = {key: value for key, value in body.items() if key in WHALE_SETTINGS}
        if not patch:
            return _ok(settings=config.get_setting("whale", {}))
        saved = await asyncio.to_thread(config.save_settings, {"whale": patch})
    except M8Error as exc:
        return _err(exc)

    return _ok(settings=saved.get("whale", {}))


def available_loras(limit: int = 400) -> list[str]:
    """列出 ComfyUI 认得的所有 LoRA。

    folder_paths 是 ComfyUI 自己的模块，脱离它（比如跑单元测试）时不存在 ——
    这时候报一个说清楚的码，别让 ImportError 直接冒到前端。
    """
    try:
        import folder_paths
    except ImportError as exc:
        raise M8Error("M8-UI-004", message="读不到 LoRA 列表：不在 ComfyUI 环境里", detail=str(exc)) from exc

    try:
        names = list(folder_paths.get_filename_list("loras"))
    except Exception as exc:  # noqa: BLE001 folder_paths 内部什么都可能抛
        raise M8Error("M8-UI-004", detail=f"{type(exc).__name__}: {exc}") from exc

    return sorted(names)[:limit]


async def handle_loras(request: web.Request) -> web.Response:
    """GET /m8/whale/loras —— 给小鲸鱼挑 LoRA 用。

    只回名字，不回路径 —— 模型要的是名字，路径对它没用还占上下文。
    """
    try:
        limit = int(request.query.get("limit") or 400)
        names = await asyncio.to_thread(available_loras, limit)
    except M8Error as exc:
        return _err(exc)
    except Exception as exc:  # noqa: BLE001
        return _err(M8Error("M8-UI-004", detail=f"{type(exc).__name__}: {exc}"))

    return _ok(loras=names, count=len(names))


async def handle_history_get(request: web.Request) -> web.Response:
    """GET /m8/whale/history —— 读对话框的记录。

    存服务端不存浏览器，理由见 history.py 的文件头（简单说：localStorage 丢过）。
    """
    return _ok(history=history.load())


async def handle_history_set(request: web.Request) -> web.Response:
    """POST /m8/whale/history —— 覆盖保存。

    写不进去要如实报错，不能静默 —— 上一次丢记录就是因为写失败没人知道。
    """
    try:
        body = await _read_json(request)
        saved = await asyncio.to_thread(history.save, body.get("history"))
    except M8Error as exc:
        return _err(exc)
    except OSError as exc:
        return _err(M8Error("M8-CORE-004", message="对话记录写不进磁盘", detail=str(exc)))

    return _ok(history=saved)


async def handle_history_clear(request: web.Request) -> web.Response:
    """POST /m8/whale/history/clear —— 清空。"""
    try:
        await asyncio.to_thread(history.clear)
    except OSError as exc:
        return _err(M8Error("M8-CORE-004", message="清空对话记录失败", detail=str(exc)))

    return _ok(history={"turns": [], "updatedAt": ""})


ROUTES: list[tuple[str, str, Any]] = [
    ("GET", "/m8/whale/history", handle_history_get),
    ("POST", "/m8/whale/history", handle_history_set),
    ("POST", "/m8/whale/history/clear", handle_history_clear),
    ("GET", "/m8/whale/loras", handle_loras),
    ("GET", "/m8/whale/usage", handle_usage),
    ("POST", "/m8/whale/usage/reset", handle_usage_reset),
    ("GET", "/m8/whale/balance", handle_balance),
    ("GET", "/m8/whale/state", handle_state),
    ("POST", "/m8/whale/chat", handle_chat),
    ("POST", "/m8/whale/settings", handle_settings_set),
]


def register(server: Any = None) -> int:
    """把本扩展的接口挂上去，返回挂了几条。

    和节点货架的 routes.register_all 一样：没有 PromptServer 时不硬崩，
    只是接口不生效，其余部分照常。
    """
    server = server or server_routes.get_server()
    if server is None:
        log("没有 PromptServer，小鲸鱼的接口没挂上", SHELF_UI)
        return 0

    table = getattr(server, "routes", None)
    if table is None:
        return 0

    for method, path, handler in ROUTES:
        getattr(table, method.lower())(path)(handler)

    log(f"小鲸鱼接口：{', '.join(path for _, path, _ in ROUTES)}", SHELF_UI)
    return len(ROUTES)


__all__ = ["register", "ROUTES"]
