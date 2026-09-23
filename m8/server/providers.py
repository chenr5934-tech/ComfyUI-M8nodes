"""供应商档案。

这是整个大模型货架里**唯一**允许出现「供应商差异」的地方。
节点代码和 llm_api.py 里都不许写 if 供应商 == xxx —— 要加新供应商，只改这个文件。

关于「思考强度」的诚实说明
--------------------------
各家对「让模型思考多久」的参数并不统一：有的叫 reasoning_effort，有的没有这个参数，
有的靠模型名区分（选了 reasoner 就必然思考）。这里按各家公开的 OpenAI 兼容协议填，
但**没有逐家实测过**。

所以 llm_api.py 里配了一条自动降级：如果请求被拒且报错指向思考参数，
就去掉该参数重试一次，并记一条日志。这样即使某家不支持，也不会整个跑不起来，
而是退化成「模型自己的默认思考行为」——这通常正是用户想要的。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 档位。这几个字面量既是取值、也是节点下拉里显示的文字，所以一律英文 ——
# 界面语言统一走 locales/，代码里不留中文。off / low / medium / high 本身就是
# 通用写法，中文用户读起来没有障碍。
THINKING_OFF = "off"
THINKING_LOW = "low"
THINKING_MEDIUM = "medium"
THINKING_HIGH = "high"
THINKING_OPTIONS = [THINKING_OFF, THINKING_LOW, THINKING_MEDIUM, THINKING_HIGH]

# 0.5.1 之前档位存的是中文。老设置文件和老工作流里还是那几个字，读的时候一并
# 认下来 —— 不然升级之后「思考强度」会静默掉回默认档，用户看不出是怎么回事。
_LEGACY_THINKING = {
    "关": THINKING_OFF,
    "低": THINKING_LOW,
    "中": THINKING_MEDIUM,
    "高": THINKING_HIGH,
}


def normalize_thinking(raw: Any) -> str:
    """把档位归一成当前取值。认不出来的一律当 off。"""
    text = str(raw or "").strip()
    if not text:
        return THINKING_OFF
    if text in THINKING_OPTIONS:
        return text
    return _LEGACY_THINKING.get(text, THINKING_OFF)

# 响应里可能装「思考过程」的字段名，按顺序试。
# 这是防御式解析：不同供应商（以及同一供应商的不同模型）用的字段名不一样，
# 与其押注一个，不如依次找 —— 找不到就当模型没有输出思考内容。
REASONING_FIELDS = (
    "reasoning_content",   # DeepSeek reasoner 系
    "reasoning",           # 部分兼容实现的叫法
    "thinking",            # Anthropic 风格 / 部分中转
    "reasoning_details",
    "thought",
)


@dataclass(frozen=True)
class Provider:
    """一个供应商的接口形态。"""

    key: str
    label: str
    default_base_url: str
    # 相对 base_url 的路径
    models_path: str = "/models"
    chat_path: str = "/chat/completions"
    # 控制思考强度的请求参数名；空串 = 这家不支持，不给它塞参数
    thinking_param: str = ""
    # 档位 -> 该供应商的取值
    thinking_values: dict[str, str] = field(default_factory=dict)
    # 是否按 OpenAI 的 Authorization: Bearer 发密钥（目前全都是）
    bearer_auth: bool = True
    note: str = ""

    def thinking_value(self, level: str) -> str:
        """把节点上的档位翻译成该供应商的取值。翻译不出来返回空串（不发送参数）。"""
        if not self.thinking_param or level == THINKING_OFF:
            return ""
        return self.thinking_values.get(level, "")


_OPENAI_STYLE_THINKING = {
    THINKING_LOW: "low",
    THINKING_MEDIUM: "medium",
    THINKING_HIGH: "high",
}

PROVIDERS: dict[str, Provider] = {
    "deepseek": Provider(
        key="deepseek",
        label="DeepSeek",
        default_base_url="https://api.deepseek.com/v1",
        thinking_param="reasoning_effort",
        thinking_values=dict(_OPENAI_STYLE_THINKING),
        note="默认端点。思考内容在 message.reasoning_content（用 deepseek-reasoner 类模型时）。",
    ),
    "openai": Provider(
        key="openai",
        label="OpenAI",
        default_base_url="https://api.openai.com/v1",
        thinking_param="reasoning_effort",
        thinking_values=dict(_OPENAI_STYLE_THINKING),
    ),
    "openrouter": Provider(
        key="openrouter",
        label="OpenRouter",
        default_base_url="https://openrouter.ai/api/v1",
        thinking_param="reasoning_effort",
        thinking_values=dict(_OPENAI_STYLE_THINKING),
        note="聚合站，模型列表很长。",
    ),
    "siliconflow": Provider(
        key="siliconflow",
        label="硅基流动",
        default_base_url="https://api.siliconflow.cn/v1",
        thinking_param="",
        note="国内中转，模型名带组织前缀。",
    ),
    "ollama": Provider(
        key="ollama",
        label="Ollama（本地）",
        default_base_url="http://127.0.0.1:11434/v1",
        thinking_param="",
        note="本地跑的话 API Key 随便填，Ollama 不校验。",
    ),
    "custom": Provider(
        key="custom",
        label="自定义（任意 OpenAI 兼容端点）",
        default_base_url="",
        thinking_param="",
        note="自己填 base_url。不确定参数就用「关」，或走 extra_params 手填。",
    ),
}

# 节点下拉里的顺序
PROVIDER_OPTIONS = list(PROVIDERS.keys())


def get(key: str) -> Provider:
    """按 key 取档案。认不出来就当自定义 —— 不抛异常，用户填个 URL 就该能跑。"""
    return PROVIDERS.get((key or "").strip().lower()) or PROVIDERS["custom"]


def labels() -> dict[str, str]:
    """key -> 显示名。前端下拉用。"""
    return {key: provider.label for key, provider in PROVIDERS.items()}


def default_base_url(key: str) -> str:
    """某供应商的默认地址。自定义的返回空串。"""
    return get(key).default_base_url


def describe_all() -> list[dict[str, Any]]:
    """给前端的档案摘要（不含任何密钥）。"""
    return [
        {
            "key": provider.key,
            "label": provider.label,
            "defaultBaseUrl": provider.default_base_url,
            "thinkingParam": provider.thinking_param,
            "note": provider.note,
        }
        for provider in PROVIDERS.values()
    ]
