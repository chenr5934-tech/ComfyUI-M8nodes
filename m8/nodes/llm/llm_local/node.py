"""M8 · Local LLM Inference.

和「大模型推理」那个节点是一对：那个走远程 API（要密钥、要联网），
这个走本地 GGUF 文件（不联网、不花钱）。接口特意做得像，方便来回换。

能力来自三处：
  · GGUF 主模型          文本对话
  · mmproj（多模态投影）  识图 —— 就是模型目录里那个 mmproj-*.gguf
  · skill 节点           外部知识包

音频不做 —— 那要另配 whisper 模型，是另一套东西，不塞在这个节点里。
"""

from __future__ import annotations

import base64
import io
import time
from typing import Any

from ....core.errors import M8Error
from ....core.log import SHELF_LLM, warn
from . import models

# 两个下拉里的占位项。前端 js/nodes/llm/llm_local.js 里有同名常量，
# 值必须逐字一致（tests/smoke_import.py 的契约测试会拦）。
PLACEHOLDER = "(no .gguf in models/LLM yet)"
NO_MMPROJ = "(none, text only)"

# 图片送进模型前先缩到这个边长以内。原图像素动辄几百万，直接塞会把
# 上下文撑爆 —— 模型的视觉编码是固定 token 预算的，喂再大也不会更清楚。
MAX_IMAGE_SIDE = 1024

# think 块：模型把推理过程写在 里面。有的版本靠 enable_thinking
# 关掉了，有的关不掉，所以还要有一道文本清洗兜底。
_THINK_BLOCK = None


def _think_re():
    global _THINK_BLOCK
    if _THINK_BLOCK is None:
        import re

        _THINK_BLOCK = re.compile(r"<think\b[^>]*>.*?</think\s*>", re.S | re.I)
    return _THINK_BLOCK


def strip_think(text: str) -> str:
    """把  ...  整段去掉。

    留着的话用户看到的是「用户要求我描述图片，1. 观察图片内容…」这种
    自言自语，而不是答案。实测那个 Uncensored 模型必带这个。
    """
    if not text:
        return ""
    out = _think_re().sub("", text)
    # 没闭合的（截断了）：从 <think 起全砍掉
    low = out.lower()
    i = low.find("<think")
    if i >= 0:
        out = out[:i]
    return out.strip()


def tensor_to_data_url(image: Any, index: int = 0) -> str:
    """ComfyUI 的 IMAGE 张量 → data URL。

    IMAGE 的形状是 [B, H, W, C]，取值 0..1 的 float。
    先缩到 MAX_IMAGE_SIDE 以内再编 JPEG —— 这一步不是省事，是必须：
    上下文是按 token 算的，图太大直接把预算吃光。
    """
    try:
        import numpy as np
        from PIL import Image
    except Exception as exc:
        raise M8Error(
            "M8-LLM-018",
            message="The libraries needed to handle images are missing",
            hint="ComfyUI normally ships pillow and numpy; check the environment is intact",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc

    arr = image
    try:
        if hasattr(arr, "cpu"):
            arr = arr.cpu().numpy()
        arr = np.asarray(arr)
    except Exception:
        arr = None
    if arr is None or arr.ndim != 4:
        raise M8Error(
            "M8-LLM-018",
            message="Unexpected image format received",
            hint="The IMAGE input should be [batch, height, width, 3]",
            detail=f"shape={getattr(arr, 'shape', None)}",
        )

    b = min(max(int(index), 0), arr.shape[0] - 1)
    frame = arr[b]
    frame = np.clip(frame * 255.0, 0, 255).astype("uint8")

    im = Image.fromarray(frame)
    w, h = im.size
    long_side = max(w, h)
    if long_side > MAX_IMAGE_SIDE:
        k = MAX_IMAGE_SIDE / long_side
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)

    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=88)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return "data:image/jpeg;base64," + b64


def build_messages(*, system: str, user: str, extra: str, images: list[str], skill: str) -> list[dict]:
    """拼成 OpenAI 那种 messages 结构。

    skill 放系统段（它是长期背景，不是这一轮的问题）；
    extra 文本放用户段末尾（它是补充要求，跟着问题走）。
    """
    sys_parts = []
    if skill:
        sys_parts.append(skill.strip())
    if system:
        sys_parts.append(system.strip())

    text = (user or "").strip()
    if extra and extra.strip():
        text = (text + "\n\n" + extra.strip()).strip() if text else extra.strip()

    content: list[dict] = []
    if text:
        content.append({"type": "text", "text": text})
    for url in images:
        content.append({"type": "image_url", "image_url": {"url": url}})

    messages: list[dict] = []
    if sys_parts:
        messages.append({"role": "system", "content": "\n\n".join(sys_parts)})
    # 只有图没文字也得给个空文本，不然有的模板会拼不出合法消息
    messages.append({"role": "user", "content": content or [{"type": "text", "text": ""}]})
    return messages


class M8LLMLocal:
    """M8 · Local LLM Inference"""

    CATEGORY = "M8/LLM"
    FUNCTION = "run"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("text", "status")
    OUTPUT_NODE = False
    DESCRIPTION = (
        "Runs inference on a local GGUF model: no network, no API key."
        "Models live in ComfyUI's models/LLM folder."
        "Pair it with an mmproj file in the same folder to enable vision; a skill node can supply a knowledge pack."
    )

    @classmethod
    def INPUT_TYPES(cls):
        # 列表在 ComfyUI 扫目录的时机上可能还是空的，至少给一个占位，
        # 不然前端会渲染成一个空下拉，看着像坏了。
        names = models.list_models() or [PLACEHOLDER]
        mm = [NO_MMPROJ] + models.list_mmproj()
        return {
            "required": {
                "model": (names, {
                    "tooltip": "The main .gguf in models/LLM. If the list is empty, check that folder.",
                }),
                "system_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "System prompt. Combined with any skill into the system block, skill first.",
                }),
                "user_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "What you want to ask this round.",
                }),
                "extra_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "Extra text appended after the prompt. Good for additional requirements, style constraints, fields to reference.",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "Images for the model to look at. Without it the run is text only. Needs an mmproj file next to the model, otherwise vision does nothing.",
                }),
                "skill": ("M8_SKILL", {
                    "tooltip": "Wire the output of a skill loader node here to use it as a knowledge pack.",
                }),
                "mmproj": (mm, {
                    "tooltip": "Multimodal projection file. Auto-paired by name; pick one manually if that guessed wrong.",
                }),
                "max_tokens": ("INT", {"default": 512, "min": 16, "max": 8192, "step": 16}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05}),
                "top_p": ("FLOAT", {"default": 0.95, "min": 0.05, "max": 1.0, "step": 0.05}),
                "ctx": ("INT", {
                    "default": 4096, "min": 512, "max": 32768, "step": 512,
                    "tooltip": "Context length. Larger uses more memory; only needed for long conversations or many images.",
                }),
                "gpu_layers": ("INT", {
                    "default": -1, "min": -1, "max": 200, "step": 1,
                    "tooltip": "-1 = offload as many layers as the GPU allows (recommended; depends on whether llama-cpp-python was built with CUDA). 0 = CPU only.",
                }),
                "thinking": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Whether the model should show its thinking. Off gives cleaner output; some models ignore it, in which case ask in the prompt too.",
                }),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # 模型文件换了内容（重新下载、换量化版本）时要重跑，所以把文件名和大小带上。
        # 返回 NaN 表示「永远重跑」—— 那会让缓存彻底失效，太浪费。
        try:
            name = kwargs.get("model") or ""
            p = models._full_path(name)
            return f"{name}:{p.stat().st_size}"
        except Exception:
            return kwargs.get("model") or ""

    def run(
        self,
        model: str,
        system_prompt: str = "",
        user_prompt: str = "",
        extra_text: str = "",
        image=None,
        skill: Any = None,
        mmproj: str = NO_MMPROJ,
        max_tokens: int = 512,
        temperature: float = 0.7,
        top_p: float = 0.95,
        ctx: int = 4096,
        gpu_layers: int = -1,
        thinking: bool = False,
    ):
        t0 = time.time()

        if not model or model.startswith("（"):
            raise M8Error(
                "M8-LLM-014",
                message="No local model available",
                hint="Drop a .gguf into ComfyUI's models/LLM folder, then re-create this node",
                detail=str(model),
            )
        if not (user_prompt or "").strip() and not (extra_text or "").strip() and image is None:
            raise M8Error(
                "M8-LLM-019",
                message="Nothing was asked",
                hint="Fill in the prompt, or wire an image in",
            )

        # mmproj：选了就用选的，没选就按名字自动配。
        #
        # **不管这一轮有没有图都配。** 一开始写成「有图才配」，结果同一模型
        # 带图和不带图变成了两个不同的缓存键 —— 每轮都重载，还把上一个卸掉。
        # 带着 mmproj 跑纯文本是完全正常的，所以固定配上就行。
        picked = "" if str(mmproj).startswith("（") else str(mmproj)
        if not picked:
            picked = models.pick_mmproj(model) or ""
            if not picked and image is not None:
                warn("No mmproj found next to this model; vision will not work", SHELF_LLM)

        images: list[str] = []
        if image is not None:
            images.append(tensor_to_data_url(image, 0))

        skill_text = ""
        if skill is not None:
            # skill 节点给的是结构化字典，正文在 text / content / main 里都可能
            if isinstance(skill, dict):
                for k in ("text", "content", "main", "body"):
                    v = skill.get(k)
                    if isinstance(v, str) and v.strip():
                        skill_text = v
                        break
                if not skill_text:
                    skill_text = str(skill.get("name") or "")
            else:
                skill_text = str(skill)

        messages = build_messages(
            system=system_prompt, user=user_prompt, extra=extra_text,
            images=images, skill=skill_text,
        )

        llm, reused = models.load(
            model, picked or None, ctx=int(ctx), gpu_layers=int(gpu_layers), thinking=bool(thinking),
        )

        try:
            out = llm.create_chat_completion(
                messages=messages,
                max_tokens=int(max_tokens),
                temperature=float(temperature),
                top_p=float(top_p),
            )
        except Exception as exc:
            raise M8Error(
                "M8-LLM-020",
                message="Inference failed",
                hint="The context may be too small (raise Context length), or the GPU cannot fit it (try setting GPU layers to 0)",
                detail=f"{type(exc).__name__}: {exc}",
            ) from exc

        raw = ""
        try:
            raw = out["choices"][0]["message"]["content"] or ""
        except Exception:
            raw = ""
        text = strip_think(raw)

        usage = out.get("usage") or {}
        n_out = usage.get("completion_tokens") or 0
        dt = max(1e-6, time.time() - t0)
        rate = (n_out / dt) if n_out else 0.0

        gpu = models.gpu_offload_available()
        bits = [
            f"{dt:.1f}s",
            f"{n_out} tokens out" if n_out else "0 tokens out",
            (f"{rate:.1f} tok/s" if rate else ""),
            ("vision" if images else "text only"),
            ("reused cache" if reused else "loaded fresh"),
            ("GPU available" if gpu else ("CPU (this llama-cpp-python has no GPU support)" if gpu is False else "backend unknown")),
        ]
        status = " · ".join(b for b in bits if b)
        return (text, status)


NODE_CLASS_MAPPINGS = {"M8LLMLocal": M8LLMLocal}
NODE_DISPLAY_NAME_MAPPINGS = {"M8LLMLocal": "M8 · Local LLM Inference"}
