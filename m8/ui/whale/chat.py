"""小鲸鱼对话框的对话能力。

和 M8LLMInference 节点的区别，值得说清楚，否则以后会有人想「抽个公共函数」：

    节点      单轮。system + 一次用户输入，输出去接下游。是工作流的一部分，
              受 ComfyUI 的节点执行机制管辖，只能在排队跑图时执行。
    对话框    多轮。带历史消息，结果只给人看。是界面的一部分，
              用户在画布上随手问一句就该立刻有回应，等不了排队。

两者复用的是同一套下层：llm_api 发请求、skills 装配知识包、config 存取设置。
上层流程不同就各写各的，硬抽成一个函数只会两边都别扭。
"""

from __future__ import annotations

from typing import Any

from ...core import config
from ...core.errors import M8Error
from ...core.log import SHELF_UI, log, warn
from ...server import llm_api, providers, skills
from . import pricing
from . import tools as whale_tools

PROVIDER = "deepseek"

# 历史消息的上限（条）。再多的对话历史，带上去也只是烧 token。
MAX_TURNS = 40

# 画布快照给多少。完整的图可能上百个节点，全塞进去会把上下文烧光，
# 而模型真正要改的通常就是那几个提示词框和采样器。
MAX_CANVAS_NODES = 40
MAX_WIDGETS_PER_NODE = 12
MAX_WIDGET_CHARS = 160


def normalize_history(raw: Any) -> list[dict[str, Any]]:
    """把前端给的消息列表收拾成 API 要的形状。

    **只认 user / assistant / tool 三种角色**，其余一律丢掉 ——
    前端传什么都不该让它有机会往请求里塞一个伪造的 system 消息。

    tool 消息是工具调用的结果，由前端执行完发回来。它必然带着
    tool_call_id，没有 id 的 tool 消息是畸形的，直接丢（否则 API 会拒）。
    """
    if not isinstance(raw, list):
        raise M8Error("M8-SRV-002", message="messages 不是数组")

    cleaned: list[dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip().lower()

        if role == "tool":
            call_id = item.get("tool_call_id")
            if not call_id:
                continue
            cleaned.append({
                "role": "tool",
                "tool_call_id": str(call_id),
                "content": str(item.get("content") or ""),
            })
            continue

        if role not in ("user", "assistant"):
            continue

        # assistant 带 tool_calls 是工具循环的中间状态，原样带上
        calls = item.get("tool_calls")
        if role == "assistant" and isinstance(calls, list) and calls:
            cleaned.append({
                "role": "assistant",
                "content": str(item.get("content") or ""),
                "tool_calls": calls,
            })
            continue

        content = item.get("content")

        # 多模态：content 是 [{type:"text"},{type:"image_url"}] 这样的数组。
        # 只放行这两种类型，并且图片必须是 data URL 或 http(s) ——
        # 前端能往这里塞任何东西，边界得在这儿画死。
        if isinstance(content, list):
            parts: list[dict[str, Any]] = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and isinstance(part.get("text"), str):
                    if part["text"].strip():
                        parts.append({"type": "text", "text": part["text"]})
                elif part.get("type") == "image_url":
                    url = (part.get("image_url") or {}).get("url")
                    if isinstance(url, str) and url.startswith(("data:image/", "http://", "https://")):
                        parts.append({"type": "image_url", "image_url": {"url": url}})
            if parts:
                cleaned.append({"role": role, "content": parts})
            continue

        if not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content})

    if not cleaned:
        raise M8Error("M8-LLM-007", message="没有可发送的消息")

    # 最后一条不能是「普通回答」：那意味着把半截的对话发出去了，
    # 模型会接着自己上一句继续编。tool 结尾是可以的 —— 工具循环正要用它。
    last = cleaned[-1]
    if last["role"] == "assistant" and not last.get("tool_calls"):
        raise M8Error("M8-LLM-007", message="最后一条必须是用户消息或工具结果")

    return cleaned[-MAX_TURNS:]



def collect_skill_blocks(history: list[dict[str, str]]) -> list[str]:
    """找最后一条用户消息里的 /名字 引用，把对应知识包带上。

    只解析最后一条：用户是在问这一句的时候引的，往上翻三条之前的引用
    多半已经过期了，带上只会让上下文变脏。
    """
    last = history[-1]["content"]
    try:
        available = skills.skill_names()
    except M8Error as exc:
        warn(f"读不到 skill 列表：{exc.message}", SHELF_UI)
        return []

    if not available:
        return []

    hits, misses = skills.extract_skill_mentions(last, available)
    if hits:
        log(f"对话框引用了知识包：{', '.join(hits)}", SHELF_UI)
    if misses:
        log(f"斜杠引用没对上任何 skill：{', '.join(misses[:5])}", SHELF_UI)

    blocks = []
    for name, text in skills.read_many(hits):
        blocks.append(f'<skill name="{name}">\n{text}\n</skill>')
    return blocks


def build_messages(
    system_prompt: str,
    history: list[dict[str, str]],
    skill_blocks: list[str],
) -> list[dict[str, Any]]:
    """拼出发给 API 的消息数组。"""
    messages: list[dict[str, Any]] = []

    system_text = (system_prompt or "").strip()
    if skill_blocks:
        joined = "\n\n".join(skill_blocks)
        if len(skill_blocks) > 1:
            joined += (
                "\n\n（以上是多个独立的知识包。请根据用户的问题自行判断该用哪一个，"
                "不必全部使用；都不相关就忽略。）"
            )
        system_text = f"{system_text}\n\n{joined}" if system_text else joined

    if system_text:
        messages.append({"role": "system", "content": system_text})

    messages.extend(history)
    return messages


def resolve_settings(override: dict | None = None) -> dict[str, Any]:
    """把「存的设置」和「这次请求的临时覆盖」合并起来。

    override 让对话框可以在不落盘的情况下临时换个模型试一句 ——
    试完不改全局，这是对话框该有的手感。
    """
    stored = dict(config.get_setting("whale", {}) or {})
    if isinstance(override, dict):
        for key in ("model", "systemPrompt", "thinking", "temperature", "maxTokens", "timeout"):
            if override.get(key) not in (None, ""):
                stored[key] = override[key]
    return stored


def render_canvas(canvas: Any) -> str:
    """把前端给的画布快照渲染成一段给模型看的文字。

    只列节点编号、类型、标题和参数。模型要靠这些编号去调 set_node_widget，
    所以编号一定要带上 —— 少了它模型就只能编。
    """
    nodes = canvas.get("nodes") if isinstance(canvas, dict) else None
    if not isinstance(nodes, list) or not nodes:
        return "\n\n## 当前画布\n\n（没有读到节点，或者画布是空的）\n"

    lines = ["\n\n## 当前画布\n", ""]
    for node in nodes[:MAX_CANVAS_NODES]:
        if not isinstance(node, dict):
            continue
        title = str(node.get("title") or node.get("type") or "?")
        node_type = str(node.get("type") or "?")
        parts = []
        for widget in (node.get("widgets") or [])[:MAX_WIDGETS_PER_NODE]:
            if not isinstance(widget, dict):
                continue
            value = str(widget.get("value", ""))
            if len(value) > MAX_WIDGET_CHARS:
                value = value[:MAX_WIDGET_CHARS] + "…"
            parts.append(f"{widget.get('name', '?')}={value}")
        suffix = f"：{', '.join(parts)}" if parts else ""
        lines.append(f"- #{node.get('id')} {title}（{node_type}）{suffix}")

    if len(nodes) > MAX_CANVAS_NODES:
        lines.append(f"（还有 {len(nodes) - MAX_CANVAS_NODES} 个节点没列出来）")
    lines.append("")
    return "\n".join(lines)


def step(
    history: Any,
    canvas: Any = None,
    override: dict | None = None,
    api_key: str = "",
) -> dict[str, Any]:
    """跑**一步**：问模型一次。

    它可能给出最终回答，也可能要求调用工具 —— 两种情况都正常返回，
    由前端决定是接着循环还是收尾。

    为什么不做成「后端一口气跑完工具循环」：工具全在前端执行
    （读队列、改画布、排队都是浏览器的能力），后端没有执行它们的途径。
    循环放前端，后端保持无状态，每一步用户还都看得见。
    """
    messages_in = normalize_history(history)
    settings = resolve_settings(override)

    # 小鲸鱼固定发往该供应商的默认地址（下面几行用的就是它），所以密钥一定匹配得上。
    # 走 resolve_api_key 而不是直接读，是为了和其它两条路径用同一套规矩。
    key = config.resolve_api_key(
        api_key,
        PROVIDER,
        providers.default_base_url(PROVIDER),
        (providers.default_base_url(PROVIDER), config.saved_base_url(PROVIDER)),
    )
    if not key:
        if config.key_target_mismatch(
            PROVIDER,
            providers.default_base_url(PROVIDER),
            (providers.default_base_url(PROVIDER), config.saved_base_url(PROVIDER)),
        ):
            raise M8Error("M8-LLM-021", detail=providers.default_base_url(PROVIDER))
        raise M8Error("M8-UI-001")

    # 系统消息由三块拼成：用户设的人格 + 工具使用规矩 + 画布快照
    system_text = (settings.get("systemPrompt") or "").strip()
    system_text += whale_tools.tool_guide()
    system_text += render_canvas(canvas)

    skill_blocks = collect_skill_blocks(messages_in)
    messages = build_messages(system_text, messages_in, skill_blocks)

    model = str(settings.get("model") or "").strip()
    if not model:
        # 没选模型时替用户挑一个，省得第一次用就卡在「请先选模型」。
        # 挑完**记进设置** —— 不记的话每一轮对话都要多打一次模型列表接口，
        # 白白多一个网络往返。
        model = _first_model(key, settings)
        try:
            config.save_settings({"whale": {"model": model}})
            log(f"没选模型，自动用了 {model} 并记进设置", SHELF_UI)
        except Exception as exc:  # noqa: BLE001 记不住不影响这一轮
            warn(f"自动选的模型没记上（不影响这次对话）：{exc}", SHELF_UI)

    thinking = str(settings.get("thinking") or providers.THINKING_OFF)
    payload: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": float(settings.get("temperature") or 1.0),
        "max_tokens": int(settings.get("maxTokens") or 4096),
        "stream": False,
        "tools": whale_tools.TOOLS,
        "tool_choice": "auto",
    }

    provider = providers.get(PROVIDER)
    value = provider.thinking_value(thinking)
    if value:
        payload[provider.thinking_param] = value

    timeout = float(settings.get("timeout") or 120)
    log(
        f"对话框请求 {model}：{len(messages)} 条消息 / 知识包 {len(skill_blocks)} 个",
        SHELF_UI,
    )
    data = llm_api.chat(
        providers.default_base_url(PROVIDER), key, payload, PROVIDER, timeout
    )

    message = _first_message(data)
    tool_calls = message.get("tool_calls") if isinstance(message.get("tool_calls"), list) else []

    text, reasoning = llm_api.extract_message(data)
    # 有工具调用时没有正文是正常的 —— 模型这一轮就是要去调工具
    if not text and not reasoning and not tool_calls:
        raise M8Error(
            "M8-LLM-005",
            message="响应里既没有正文也没有工具调用",
            hint="确认选的模型还存在，且它支持 function calling",
        )

    usage_data = llm_api.usage_of(data)
    cost = pricing.cost_of(model, usage_data)

    return {
        "text": text,
        "thinking": reasoning,
        "toolCalls": tool_calls,
        "usage": usage_data,
        "cost": cost,
        "costText": pricing.format_money(cost),
        "peak": pricing.is_peak(),
        "model": model,
        "skills": [name for name in _skill_names_of(skill_blocks)],
    }


def _first_message(data: dict) -> dict:
    """从响应里取第一条 message。取不到返回空 dict。"""
    choices = data.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], dict):
        message = choices[0].get("message")
        if isinstance(message, dict):
            return message
    return {}


def _skill_names_of(blocks: list[str]) -> list[str]:
    """从围栏里把知识包名字抠出来，只用于回显。"""
    names = []
    for block in blocks:
        head = block.split(">", 1)[0]
        if 'name="' in head:
            names.append(head.split('name="', 1)[1].strip().strip('"'))
    return names


def _first_model(api_key: str, settings: dict[str, Any]) -> str:
    """用户没选模型时，拉一次列表取第一个。

    拉不到就报错说清楚 —— 总比发一个空 model 给接口然后收到一句
    莫名其妙的 400 强。
    """
    try:
        models = llm_api.list_models(
            providers.default_base_url(PROVIDER), api_key, PROVIDER, 30
        )
    except M8Error as exc:
        raise M8Error(
            "M8-UI-002",
            message="没选模型，而且模型列表也拉不到",
            hint="在小鲸鱼的设置里选一个模型，或检查密钥",
            detail=exc.detail or exc.message,
        ) from exc

    if not models:
        raise M8Error("M8-LLM-006")
    return models[0]
