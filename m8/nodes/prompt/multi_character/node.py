"""M8 · 多角色编辑（提示词货架）。

把多个角色的提示词分块组装成一段提示词，每个角色带自己的空间区域。

参考 ComfyUI-Danbooru-Gallery 的「多角色编辑器」，但**重写了它出错的地方**。
原版那几处问题都在下面标了 —— 那是这次重做的直接理由：

  1. **静默失败**。原版 generate() 和节点函数都是 except: return base_prompt，
     角色配置一旦解析失败，输出会安静地退化成一段基础提示词，使用者看到的是
     「角色全没了」但没有任何线索。本节点一律带码抛 M8-PROMPT-00x。
  2. **零宽遮罩**。原版修 x2<=x1 用的是 min(1.0, x1 + 0.1)，x1=1.0 时仍然相等。
     本节点贴边时把起点往前顶，保证至少 MIN_SPAN 的宽度。
  3. **权重没有边界**。原版直接拿 char.weight 当遮罩混合权重用，不钳制；
     语义上它也不是「角色权重」而是遮罩混合权重，文档和代码各说各话。
     本节点统一叫「混合权重」并钳在 [0.05, 2.0]。
  4. **类型转换会抛**。int(feather) 遇到 None 抛异常，然后被上面那层吃掉。
     本节点所有数值都走 _as_float，坏值带码报出来。
  5. **角色没有遮罩就被丢弃**。原版 if not mask: continue，无声无息。
     本节点缺坐标就用整幅画面，并记一条日志。

另外原版节点上有 canvas_width / canvas_height 两个参数，写进 config 之后没有
任何地方读它 —— 因为遮罩用的是百分比坐标，画布尺寸本来就不参与计算。
本节点不摆这种看不懂又没用的旋钮。

## 三种输出格式

- **attn**：`COUPLE(x1 x2, y1 y2, weight) prompt`，给 comfyui-prompt-control 的
  Attention Couple 用。
- **regional**：`prompt MASK(x1 x2, y1 y2, weight)`，多个之间用 AND 连，
  给 Regional Prompts 用。
- **plain**：纯文本逗号分隔，**不带区域语法**，不依赖任何第三方节点。
  区域信息在这种模式下没有意义，所以直接丢掉、只拼提示词。
"""

from __future__ import annotations

import json
from typing import Any

from ....core.errors import M8Error
from ....core.log import SHELF_PROMPT, log

FORMATS = ("attn", "regional", "plain")

# 区域的最小跨度。贴边时保证有这么多，避免出现零宽遮罩。
MIN_SPAN = 0.01
# 混合权重的边界。低于下限遮罩基本消失，高于上限容易把画面烧糊。
WEIGHT_MIN = 0.05
WEIGHT_MAX = 2.0
# 羽化是像素值，上限给一个宽松但不至于误填成天文数字的值
FEATHER_MAX = 512

DEFAULT_CHARACTERS = [
    {
        "enabled": True,
        "name": "角色 1",
        "prompt": "",
        "x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0,
        "weight": 1.0, "feather": 0, "fill": False,
    },
    {
        "enabled": True,
        "name": "角色 2",
        "prompt": "",
        "x": 0.5, "y": 0.0, "w": 0.5, "h": 1.0,
        "weight": 1.0, "feather": 0, "fill": False,
    },
]

DEFAULT_CONFIG: dict[str, Any] = {
    "format": "regional",
    "base": "",
    "global": "",
    "use_fill": False,
    "characters": DEFAULT_CHARACTERS,
}

DEFAULT_CONFIG_JSON = json.dumps(DEFAULT_CONFIG, ensure_ascii=False)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _as_float(value: Any, field: str, index: int, default: float) -> float:
    """安全转 float。坏值带码报出来，不静默吃。

    原版这里直接 float()/int()，遇到 None 或字符串就抛 —— 抛出来的异常又被外层
    的 except 吞掉，最后表现为「什么都没发生」。
    """
    if value is None or value == "":
        return default
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise M8Error(
            "M8-PROMPT-002",
            message=f"第 {index + 1} 个角色的 {field} 不是数字",
            hint="在节点面板上重新拖一下那个角色的位置，或点重置用回默认",
            detail=f"收到的值：{value!r}",
        ) from exc


def _load(raw: str) -> dict:
    """解析角色配置。坏 JSON 报错，不静默降级成空配置。"""
    if not raw or not str(raw).strip():
        return json.loads(DEFAULT_CONFIG_JSON)
    try:
        cfg = json.loads(raw)
    except (ValueError, TypeError) as exc:
        raise M8Error(
            "M8-PROMPT-001",
            message="角色配置不是合法 JSON",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc
    if not isinstance(cfg, dict):
        raise M8Error(
            "M8-PROMPT-001",
            message="角色配置的顶层必须是一个对象",
            hint="要写成 {...} 这种键值对形式",
            detail=f"实际类型：{type(cfg).__name__}",
        )
    # 缺字段补默认。不删多余的键 —— 多出来的键不影响输出，删了反而会在
    # 用户切回旧版时丢设置。
    for key, value in json.loads(DEFAULT_CONFIG_JSON).items():
        if key not in cfg:
            cfg[key] = value
    return cfg


def _region(raw: dict, index: int) -> tuple[float, float, float, float]:
    """把一个角色的区域算成 (x1, x2, y1, y2)，全部落在 [0, 1]。

    贴边时把起点往前顶，保证留出 MIN_SPAN 的跨度。原版用的是
    min(1.0, x1 + 0.1)，x1 正好等于 1.0 时 x2 还是 1.0，输出一个零宽遮罩 ——
    那种遮罩在 prompt-control 那边等于什么都不画。
    """
    x = _clamp(_as_float(raw.get("x"), "横向位置 x", index, 0.0), 0.0, 1.0)
    y = _clamp(_as_float(raw.get("y"), "纵向位置 y", index, 0.0), 0.0, 1.0)
    w = _as_float(raw.get("w"), "宽度 w", index, 1.0)
    h = _as_float(raw.get("h"), "高度 h", index, 1.0)

    if w <= 0 or h <= 0:
        raise M8Error(
            "M8-PROMPT-002",
            message=f"第 {index + 1} 个角色的宽或高不是正数",
            hint="区域要有一点点面积；在面板上把那个框拉大一点",
            detail=f"w={w}, h={h}",
        )

    x2 = _clamp(x + w, 0.0, 1.0)
    y2 = _clamp(y + h, 0.0, 1.0)

    if x2 - x < MIN_SPAN:
        x = min(x, 1.0 - MIN_SPAN)
        x2 = x + MIN_SPAN
    if y2 - y < MIN_SPAN:
        y = min(y, 1.0 - MIN_SPAN)
        y2 = y + MIN_SPAN

    return x, x2, y, y2


def _characters(cfg: dict) -> list[dict]:
    """取出启用中的角色，区域和权重都算好。"""
    raw_list = cfg.get("characters")
    if not isinstance(raw_list, list):
        raise M8Error(
            "M8-PROMPT-002",
            message="characters 必须是一个数组",
            detail=f"实际类型：{type(raw_list).__name__}",
        )

    out: list[dict] = []
    for index, raw in enumerate(raw_list):
        if not isinstance(raw, dict):
            raise M8Error(
                "M8-PROMPT-002",
                message=f"第 {index + 1} 个角色不是一个对象",
                detail=f"实际类型：{type(raw).__name__}",
            )
        if not raw.get("enabled", True):
            continue

        prompt = str(raw.get("prompt") or "").strip()
        if not prompt:
            # 没写提示词的角色直接跳过 —— 这不是错误，只是还没填
            continue

        # 原版这里是 if not mask: continue —— 一个没配区域的角色会被无声丢掉。
        # 缺坐标就当它占满整幅，并说一声。
        if "x" not in raw and "y" not in raw and "w" not in raw and "h" not in raw:
            log(f"第 {index + 1} 个角色没配区域，按整幅画面处理", SHELF_PROMPT)
            raw = {**raw, "x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}

        x1, x2, y1, y2 = _region(raw, index)
        weight = _clamp(
            _as_float(raw.get("weight"), "混合权重 weight", index, 1.0),
            WEIGHT_MIN, WEIGHT_MAX,
        )
        feather = int(_clamp(
            _as_float(raw.get("feather"), "羽化 feather", index, 0),
            0, FEATHER_MAX,
        ))

        out.append({
            "name": str(raw.get("name") or f"角色 {index + 1}"),
            "prompt": prompt,
            "x1": x1, "x2": x2, "y1": y1, "y2": y2,
            "weight": weight,
            "feather": feather,
            "fill": bool(raw.get("fill")),
        })
    return out


def _head(cfg: dict) -> str:
    """基础提示词 + 全局提示词的合并结果。"""
    parts = []
    for key in ("base", "global"):
        text = str(cfg.get(key) or "").strip()
        if text:
            parts.append(text)
    return " ".join(parts)


def _feather_suffix(char: dict) -> str:
    return f" FEATHER({char['feather']})" if char["feather"] > 0 else ""


def _box(char: dict) -> str:
    """`x1 x2, y1 y2, weight` —— 两种区域语法共用这一段。"""
    return (
        f"{char['x1']:.2f} {char['x2']:.2f}, "
        f"{char['y1']:.2f} {char['y2']:.2f}, "
        f"{char['weight']:.2f}"
    )


def _render_attn(head: str, chars: list[dict], use_fill: bool) -> str:
    """Attention Couple 语法：head COUPLE(box) prompt ..."""
    parts = []
    if head:
        parts.append(head + " FILL()" if use_fill else head)
    elif use_fill:
        parts.append("FILL()")

    for char in chars:
        piece = f"COUPLE({_box(char)}) {char['prompt']}"
        if char["fill"]:
            piece += " FILL()"
        piece += _feather_suffix(char)
        parts.append(piece)

    return " ".join(parts).strip()


def _render_regional(head: str, chars: list[dict]) -> str:
    """Regional Prompts 语法：head AND prompt MASK(box) AND ..."""
    pieces = [f"{char['prompt']} MASK({_box(char)}){_feather_suffix(char)}" for char in chars]
    body = " AND ".join(pieces)
    return (head + " AND " + body).strip() if head else body


def _render_plain(head: str, chars: list[dict]) -> str:
    """纯文本：逗号分隔，不带任何区域语法。

    区域信息在这种模式下没有意义（下游不认识 MASK/COUPLE），所以直接丢掉，
    只把提示词拼起来。
    """
    parts = []
    if head:
        parts.append(head)
    parts.extend(char["prompt"] for char in chars)
    return ", ".join(parts).strip()


class M8MultiCharacter:
    """多角色提示词编辑器。"""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "format": (list(FORMATS), {"default": "regional"}),
                "use_fill": ("BOOLEAN", {"default": False}),
                "config": ("STRING", {"multiline": True, "default": DEFAULT_CONFIG_JSON}),
            },
            "optional": {
                "base_prompt": ("STRING", {"forceInput": True}),
                # 宽高只影响**画布的比例**，不参与提示词计算 ——
                # 遮罩用的是百分比坐标，所以画面尺寸不进去。但画布必须按真实
                # 比例画，否则「这个角色占左三分之一」在 16:9 出图上会变成偏左。
                "width": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
                "height": ("INT", {"default": 1024, "min": 64, "max": 8192, "step": 8}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("角色提示词",)
    FUNCTION = "execute"
    CATEGORY = "M8/提示词"
    DESCRIPTION = "分块编辑多个角色的提示词与画面区域，组装成一段可直接使用的提示词"

    def execute(
        self,
        format: str,
        use_fill: bool,
        config: str,
        base_prompt: str = "",
        width: int = 1024,
        height: int = 1024,
    ):
        """组装提示词。

        width / height 不参与文本计算（遮罩是百分比），但会写进日志 ——
        排查「区域看着不对」时，先确认画布比例是不是用户以为的那个。
        """
        mode = str(format or "").strip()
        if mode not in FORMATS:
            raise M8Error(
                "M8-PROMPT-004",
                message=f"不认识的输出格式：{mode}",
                hint="格式只能是 " + " / ".join(FORMATS) + " 里的一个",
            )

        cfg = _load(config)
        cfg["format"] = mode
        cfg["use_fill"] = bool(use_fill)
        if base_prompt and str(base_prompt).strip():
            cfg["base"] = str(base_prompt).strip()

        chars = _characters(cfg)
        head = _head(cfg)

        # 区域语法下一个角色都没有，输出会是个空壳 —— 说清楚，别让下游拿到空串
        if mode != "plain" and not chars:
            raise M8Error(
                "M8-PROMPT-003",
                message="没有任何启用的角色",
                hint="勾上至少一个角色并填好提示词；或把格式切成 plain",
                detail=f"配置里共 {len(cfg.get('characters') or [])} 个角色",
            )

        if mode == "attn":
            text = _render_attn(head, chars, cfg["use_fill"])
        elif mode == "regional":
            text = _render_regional(head, chars)
        else:
            text = _render_plain(head, chars)

        log(
            f"{mode} 格式，{len(chars)} 个角色 → {len(text)} 字（画布 {int(width)}×{int(height)}）",
            SHELF_PROMPT,
        )
        return (text,)


NODE_CLASS_MAPPINGS = {
    "M8MultiCharacter": M8MultiCharacter,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "M8MultiCharacter": "M8 · 多角色编辑",
}
