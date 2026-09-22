"""大模型 HTTP 调用层。

只管收发，不管业务：
  - 拼 URL、发请求、读响应
  - 把 urllib 的各种异常翻译成 M8Error（带码，见 docs/ERROR-PLAYBOOK.md）
  - 从响应里把「正文」和「思考过程」拆出来

用标准库 urllib，不用 requests —— 秋叶整合包的环境里多一个依赖就多一个装不上的理由。

全是阻塞调用。在 aiohttp handler 里必须用 asyncio.to_thread 包起来，
否则会把 ComfyUI 的事件循环卡住（整个界面都会僵）。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ..core.errors import M8Error, wrap
from ..core.log import SHELF_LLM, log, warn
from . import providers

# 默认的 User-Agent：有些中转站会拦没有 UA 的请求
USER_AGENT = "M8-Nodes/0.1 (+ComfyUI)"
MAX_ERROR_BODY = 2000


def normalize_base_url(raw: str) -> str:
    """把用户填的地址收拾干净，或抛出 M8-LLM-002。

    容忍这几种填法（用户不该因为少个斜杠就被拦住）：
        api.deepseek.com         -> https://api.deepseek.com
        https://api.deepseek.com/ -> https://api.deepseek.com
        http://127.0.0.1:11434/v1/ -> http://127.0.0.1:11434/v1
    """
    url = (raw or "").strip()
    if not url:
        raise M8Error("M8-LLM-002", message="base_url 是空的")

    if "://" not in url:
        # 本地地址补 http，其余补 https
        scheme = "http" if url.startswith(("127.0.0.1", "localhost", "0.0.0.0", "[::1]")) else "https"
        url = f"{scheme}://{url}"

    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise M8Error("M8-LLM-002", message=f"base_url 不是合法 URL：{raw}")

    return url.rstrip("/")


def _join(base_url: str, path: str) -> str:
    return normalize_base_url(base_url) + "/" + path.lstrip("/")


def _headers(api_key: str, provider: providers.Provider) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if api_key and provider.bearer_auth:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _truncate(text: str, limit: int = MAX_ERROR_BODY) -> str:
    text = (text or "").strip()
    return text if len(text) <= limit else text[:limit] + "…（已截断）"


def _send(url: str, api_key: str, provider: providers.Provider, payload: dict | None, timeout: float) -> tuple[int, str]:
    """发一个请求，返回 (状态码, 响应正文)。所有底层异常在这里转成 M8Error。"""
    body = None
    if payload is not None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    request = urllib.request.Request(
        url,
        data=body,
        headers=_headers(api_key, provider),
        method="POST" if body is not None else "GET",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise M8Error(
            "M8-LLM-004",
            message=f"接口返回 {exc.code}",
            hint=_hint_for_status(exc.code),
            detail=_truncate(detail),
        ) from exc
    except urllib.error.URLError as exc:
        raise wrap("M8-LLM-003", exc, message=f"连不上 {url}") from exc
    except TimeoutError as exc:
        raise M8Error("M8-LLM-003", message=f"请求超时（{timeout:.0f} 秒）", detail=str(exc)) from exc
    except OSError as exc:  # 连接被重置之类
        raise wrap("M8-LLM-003", exc) from exc


def _hint_for_status(status: int) -> str:
    return {
        400: "请求格式被拒。若用了思考强度，试试调成「关」；或检查 extra_params 的 JSON",
        401: "API Key 不对或没权限。检查密钥，或确认它属于这个 base_url 对应的服务商",
        402: "余额不足",
        403: "被拒绝访问。可能是地区限制或密钥没开通该模型",
        404: "路径不对。base_url 通常要以 /v1 结尾",
        413: "请求体过大。减少图片张数或尺寸",
        429: "触发限流或配额用尽。等一会儿，或降低并发",
        500: "对方服务端错误，重试通常就好",
        502: "网关错误，对方服务不稳定",
        503: "对方服务暂时不可用",
    }.get(status, "看 detail 里的响应正文")


def _parse_json(text: str, url: str) -> dict:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise M8Error(
            "M8-LLM-005",
            message="响应不是合法 JSON",
            hint=f"确认 {url} 是 OpenAI 兼容接口",
            detail=_truncate(text),
        ) from exc
    if not isinstance(data, dict):
        raise M8Error("M8-LLM-005", detail=f"顶层不是对象：{type(data).__name__}")
    return data


def get_json(url: str, api_key: str, provider_key: str = "custom", timeout: float = 30) -> tuple[int, dict]:
    """对一个绝对 URL 发 GET 并把响应解析成 JSON。

    给余额查询这类「不属于某个 base_url 的独立端点」用 —— 它们有自己的完整地址，
    走不了 _join(base_url, path) 那条路，但错误处理必须和别处一致：
    超时、非 200、响应不是 JSON，全都得变成带码的 M8Error。

    返回 (状态码, 解析后的 dict)。
    """
    provider = providers.get(provider_key)
    log(f"GET {url}", SHELF_LLM)
    status, text = _send(url, api_key, provider, None, timeout)
    return status, _parse_json(text, url)


def list_models(base_url: str, api_key: str, provider_key: str = "custom", timeout: float = 30) -> list[str]:
    """拉模型列表。失败抛 M8Error（不会静默返回空列表）。

    返回按字母排序、去重后的模型 id 列表。
    """
    provider = providers.get(provider_key)
    url = _join(base_url, provider.models_path)
    log(f"拉模型列表：{url}", SHELF_LLM)

    _, text = _send(url, api_key, provider, None, timeout)
    data = _parse_json(text, url)

    raw = data.get("data")
    if raw is None:
        raw = data.get("models")  # 有的实现用 models

    ids: list[str] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                ids.append(item)
            elif isinstance(item, dict):
                name = item.get("id") or item.get("name") or item.get("model")
                if name:
                    ids.append(str(name))
    elif isinstance(raw, dict):
        ids.extend(str(k) for k in raw.keys())

    if not ids:
        raise M8Error(
            "M8-LLM-006",
            message="接口没返回任何模型",
            hint="可以手动在 model 里填模型名，直接跑",
            detail=_truncate(text, 500),
        )

    unique = sorted(set(ids))
    log(f"拿到 {len(unique)} 个模型", SHELF_LLM)
    return unique


def chat(
    base_url: str,
    api_key: str,
    payload: dict,
    provider_key: str = "custom",
    timeout: float = 120,
) -> dict:
    """发一次对话补全请求，返回原始响应 dict。

    带一条自动降级：如果因为思考参数被拒（400），去掉它重试一次。
    这样「某家支持、某家不支持」的差异不会变成用户的报错。
    """
    provider = providers.get(provider_key)
    url = _join(base_url, provider.chat_path)

    try:
        _, text = _send(url, api_key, provider, payload, timeout)
    except M8Error as exc:
        thinking_param = provider.thinking_param
        if (
            exc.code == "M8-LLM-004"
            and thinking_param
            and thinking_param in payload
            and exc.message.startswith("接口返回 400")
        ):
            warn(f"{provider.label} 拒绝了参数 {thinking_param}，去掉它重试一次", SHELF_LLM)
            retry_payload = dict(payload)
            retry_payload.pop(thinking_param, None)
            _, text = _send(url, api_key, provider, retry_payload, timeout)
        else:
            raise

    return _parse_json(text, url)


def extract_message(data: dict) -> tuple[str, str]:
    """从响应里拆出 (正文, 思考过程)。

    兼容 OpenAI 的 choices[0].message，也兼容个别实现直接给 content。
    思考过程按 REASONING_FIELDS 依次找 —— 找不到就是空串，不是错误。
    """
    choices = data.get("choices")
    message: dict = {}
    if isinstance(choices, list) and choices:
        first = choices[0] or {}
        candidate = first.get("message")
        if isinstance(candidate, dict):
            message = candidate
        elif isinstance(first.get("text"), str):
            message = {"content": first["text"]}

    if not message and isinstance(data.get("content"), str):
        message = {"content": data["content"]}

    content = message.get("content")
    if isinstance(content, list):
        # 有的实现把 content 拆成 [{type: "text", text: "..."}] 数组
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    text = str(content or "").strip()

    thinking = ""
    for field_name in providers.REASONING_FIELDS:
        value = message.get(field_name)
        if value:
            thinking = str(value).strip()
            break

    return text, thinking


def usage_of(data: dict) -> dict:
    """取用量信息，给节点的状态显示用。取不到就返回空 dict。"""
    usage = data.get("usage")
    return usage if isinstance(usage, dict) else {}
