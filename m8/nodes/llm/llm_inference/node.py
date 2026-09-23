"""M8 · LLM Inference (LLM shelf).

靠 API 调外部大模型。默认指向 DeepSeek，base_url 可以改成任何 OpenAI 兼容端点。

这个文件只做三件事：
    1. 把节点上的参数 + 上游数据组装成一次 API 请求
    2. 调 llm_api 发出去
    3. 把回来的正文/思考拆开，正文走输出口，思考走 UI 消息

**不在这里做的事**：
    - 判断是哪家供应商（那在 server/providers.py，本文件里不许出现 if 供应商 ==）
    - 拼 HTTP / 处理异常（那在 server/llm_api.py）

设计取舍：
    - 输出口只有 text 一个。思考内容不走连线，走节点的界面显示 ——
      接了提示词编码之类的下游时，思考过程混进去只会污染结果。
    - image / audio 是可选输入。不接就是纯文本对话；接了就按多模态格式发出去。
      模型不支持的话接口会返回 400，报错里有说清怎么修（M8-LLM-010）。
"""

from __future__ import annotations

import base64
import io
import json
from typing import Any

from ....core import config
from ....core.errors import M8Error, wrap
from ....core.log import SHELF_LLM, log, warn
from ....server import llm_api, providers, skills

# Placeholder for the model dropdown before the list is fetched.
# The frontend replaces it once /m8/llm/models answers.
MODEL_PLACEHOLDER = "(click Refresh models to load the list)"

DEFAULT_TIMEOUT = 120
DEFAULT_MAX_TOKENS = 8192


class M8LLMInference:
    """M8 · LLM Inference

    Two prompt boxes: system sets persona and rules, user is what you want to ask.
    Fill in the API key, hit Refresh models, pick one from the dropdown.
    Inputs accept a skill (knowledge pack), images and audio; the output is text.
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "provider": (providers.PROVIDER_OPTIONS, {
                    "default": "deepseek",
                    "tooltip": "Pick a provider. Changing it fills in that provider's default base_url and thinking options. For anything else choose Custom and enter the address yourself.",
                }),
                "base_url": ("STRING", {
                    "default": providers.default_base_url("deepseek"),
                    "multiline": False,
                    "tooltip": "API address. Defaults to https://api.deepseek.com/v1; point it at any OpenAI-compatible endpoint.",
                }),
                "api_key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "Leave empty to use the key stored on the server (recommended: Save key keeps it out of the workflow file). Anything typed here applies to this node only and is written into the workflow.",
                }),
                "model": ([MODEL_PLACEHOLDER], {
                    "tooltip": "Fill in the address and key, then click Refresh models. You can also type a model name directly.",
                }),
                "system_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "System prompt: persona, tone, output format. Leave empty to send only the user prompt.",
                }),
                "user_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    # 关掉动态提示词：大模型的提示词里花括号太常见了（JSON、代码、模板变量），
                    # 开着会被 {a|b} 语法随机替换，破坏性大于那点便利。要随机就在上游接文本节点。
                    "dynamicPrompts": False,
                    "tooltip": "What you want to ask. Can be wired from another node's text output (right-click the input and convert it to an input socket).",
                }),
                "thinking": (providers.THINKING_OPTIONS, {
                    "default": providers.THINKING_OFF,
                    "tooltip": "Thinking effort. Off sends no extra request; higher asks the model to think more. If the provider rejects the parameter it is dropped and the request retried (the log says so).",
                }),
                "show_thinking": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Show the model's thinking on the node panel (default off: it is usually long). Display only, the text output is unaffected.",
                }),
                "temperature": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "Randomness. Lower for steady work like prompt writing, higher for creative ones.",
                }),
                "max_tokens": ("INT", {
                    "default": DEFAULT_MAX_TOKENS, "min": 16, "max": 131072, "step": 16,
                    "tooltip": "Upper bound on the reply length. It is a cap, not a target — normal answers do not fill it.",
                }),
                "timeout": ("INT", {
                    "default": DEFAULT_TIMEOUT, "min": 5, "max": 3600, "step": 5,
                    "tooltip": "Request timeout in seconds. For slow thinking models give it 300 or more.",
                }),
            },
            "optional": {
                "skill": ("M8_SKILL", {
                    "tooltip": "Wire this from M8 · Skill Loader. Its content is appended after the system prompt as reference material.",
                }),
                "skill_auto": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Inject every uploaded skill and let the model decide which applies. Off by default: once the library grows, each turn carries a few irrelevant ones and burns tokens. Referencing a specific skill with / in the prompt is more precise. Caps are configurable in settings.",
                }),
                "image": ("IMAGE", {
                    "tooltip": "Feed images to a vision model. Multiple images are sent together; count and edge limits are configurable. Models without image support return 400.",
                }),
                "audio": ("AUDIO", {
                    "tooltip": "Feed audio to a model that accepts it (converted to WAV). Models without audio support return 400.",
                }),
                "extra_params": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "Extra request parameters as a JSON object, merged into the request body. Use it for provider-specific fields this pack does not cover, e.g. {\"top_p\": 0.9}.",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "M8/LLM"
    DESCRIPTION = "Calls an external LLM over an OpenAI-compatible API: two prompt boxes, model dropdown, thinking effort. Accepts a skill, images and audio; outputs text."
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, model):
        """Accept any model name.

        和 M8SkillLoader 同理：候选列表是前端拉 /m8/llm/models 之后动态写进 widget 的，
        服务端只能给占位列表，默认校验必然拦下来。只接管 model 一项。
        """
        return True

    # ------------------------------------------------------------ 主流程

    def execute(
        self,
        provider: str,
        base_url: str,
        api_key: str,
        model: str,
        system_prompt: str = "",
        user_prompt: str = "",
        thinking: str = providers.THINKING_OFF,
        show_thinking: bool = True,
        temperature: float = 1.0,
        max_tokens: int = DEFAULT_MAX_TOKENS,
        timeout: int = DEFAULT_TIMEOUT,
        skill: dict | None = None,
        skill_auto: bool = False,
        image=None,
        audio=None,
        extra_params: str = "",
    ):
        # 老工作流里档位存的是中文（关/低/中/高），这里归一成当前取值
        thinking = providers.normalize_thinking(thinking)

        self._validate_request(model, user_prompt, image, audio)

        # 留空时用服务端存的那份 —— 但只在 base_url 确实是这个供应商的地址时才给。
        # 别人分享的工作流里可以塞一个指向他自己服务器的 base_url，密钥留空；
        # 不这么挡的话，用户一跑就把自己的密钥送出去了。
        resolved_key = config.resolve_api_key(
            api_key,
            provider,
            base_url,
            (providers.default_base_url(provider), config.saved_base_url(provider)),
        )
        if not resolved_key:
            # 分清「没配过」和「配了但不发给这个地址」—— 后者光看「未配置」找不到原因
            if config.key_target_mismatch(
                provider,
                base_url,
                (providers.default_base_url(provider), config.saved_base_url(provider)),
            ):
                raise M8Error("M8-LLM-021", detail=base_url)
            raise M8Error("M8-LLM-001")

        skill_blocks = self._collect_skill_blocks(user_prompt, skill, bool(skill_auto))
        messages = self._build_messages(system_prompt, user_prompt, skill_blocks, image, audio)
        payload = self._build_payload(
            model=model,
            messages=messages,
            provider_key=provider,
            thinking=thinking,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_params=extra_params,
        )

        # 知识包是整份注入的，一个几百 KB 的 skill 能直接顶穿上下文。
        # 这里不截断（用户明确要的东西不该被偷偷改小），但要在日志里说清楚量级 ——
        # 否则报 400 的时候没人知道是知识包太大。
        skill_chars = sum(len(block) for block in skill_blocks)
        if skill_chars > 20000:
            warn(
                f"Carrying a {skill_chars}-character knowledge pack this time; it takes up a lot of context."
                f"If the endpoint returns 400 (M8-LLM-013), the pack blew past the input limit",
                SHELF_LLM,
            )
        log(
            f"Request {model}: {len(messages)} messages / {len(skill_blocks)} knowledge packs ({skill_chars} chars)"
            f" / thinking {thinking}",
            SHELF_LLM,
        )
        data = llm_api.chat(base_url, resolved_key, payload, provider, timeout)

        text, reasoning = llm_api.extract_message(data)
        if not text and not reasoning:
            raise M8Error(
                "M8-LLM-005",
                message="The response carried no text content",
                hint="Check the model name exists and the endpoint is OpenAI-compatible",
                detail=json.dumps(data, ensure_ascii=False)[:800],
            )

        usage = llm_api.usage_of(data)
        log(f"Returned {len(text)} chars{(' / thinking ' + str(len(reasoning)) + ' chars') if reasoning else ''}", SHELF_LLM)

        # 正文走连线；思考过程走 UI 消息，显示在节点面板上，不污染下游
        ui_payload: dict[str, Any] = {
            "text": text,
            "thinking": reasoning if show_thinking else "",
            "hasThinking": bool(reasoning),
            "model": model,
            "usage": usage,
            "chars": len(text),
        }
        return {"ui": {"m8": ui_payload}, "result": (text,)}

    # ------------------------------------------------------------ 组装

    @staticmethod
    def _validate_request(model: str, user_prompt: str, image, audio) -> None:
        name = (model or "").strip()
        if not name or name == MODEL_PLACEHOLDER:
            raise M8Error(
                "M8-LLM-006",
                message="No model selected",
                hint="Click Refresh models on the node, or type a model name directly",
            )
        if not (user_prompt or "").strip() and image is None and audio is None:
            raise M8Error("M8-LLM-007")

    def _collect_skill_blocks(
        self,
        user_prompt: str,
        skill: dict | None,
        skill_auto: bool,
    ) -> list[str]:
        """收集这次请求要带上的知识包。

        三个来源，按优先级，同名只带一次：

            1. 连线进来的 skill —— 明确指定，一定带上
            2. 提示词里 /名字 引用的 —— 用户在对话框里临时指定
            3. skill_auto 打开时，服务端所有已上传的 —— 让模型自己判断该用哪个

        每个知识包都用 <skill name="..."> 围起来，模型才分得清
        「哪些是指令、哪些是资料」—— 不围的话，skill 里的示例文本
        很容易被当成新指令执行。
        """
        blocks: list[str] = []
        seen: set[str] = set()

        def add(filename: str, text: str) -> None:
            # 键要去扩展名再比：连线的 skill 名可能是「翻译规范.md」，
            # 而磁盘上的包目录叫「翻译规范」。不归一化的话同一份会被带两次，
            # 内容翻倍、上下文白烧，而且日志上看不出问题。
            key = skills.display_name(filename or "").lower()
            if not text or key in seen:
                return
            seen.add(key)
            blocks.append(f'<skill name="{filename}">\n{text}\n</skill>')

        # 1. 连线指定的
        if isinstance(skill, dict) and skill.get("text"):
            add(str(skill.get("name") or "skill"), str(skill["text"]))

        # 服务端上已上传的（2 和 3 都要用）
        try:
            available = [item["name"] for item in skills.list_skills()]
        except M8Error as exc:
            warn(f"Could not read the skill list: {exc.message}", SHELF_LLM)
            available = []

        if not available:
            return blocks

        # 2. 提示词里的 /名字
        hits, misses = skills.extract_skill_mentions(user_prompt or "", available)
        if hits:
            log(f"Knowledge packs referenced in the prompt: {', '.join(hits)}", SHELF_LLM)
        if misses:
            # 不报错：提示词里出现斜杠太常见了（路径、URL、日期），
            # 没对上就原样留在正文里，模型自己会看着办
            log(f"Slash references matched no skill: {', '.join(misses[:5])}", SHELF_LLM)
        for name, text in skills.read_many(hits):
            add(name, text)

        # 3. 自动模式：全部注入，让模型自己挑
        if skill_auto:
            limit = int(config.get_setting("llm.max_auto_skills", 10) or 10)
            budget = int(config.get_setting("llm.max_skill_chars", 8000) or 8000)
            rest = [name for name in available if name.lower() not in seen]
            if len(rest) > limit:
                log(f"Auto-inject took the first {limit} of {len(rest)}; the cap is configurable in settings", SHELF_LLM)
            for name, text in skills.read_many(rest[:limit]):
                if len(text) > budget:
                    text = text[:budget] + "\n\n...(content was too long and has been truncated)"
                add(name, text)

        return blocks

    def _build_messages(
        self,
        system_prompt: str,
        user_prompt: str,
        skill_blocks: list[str],
        image,
        audio,
    ) -> list[dict]:
        messages: list[dict] = []

        system_text = (system_prompt or "").strip()
        if skill_blocks:
            joined = "\n\n".join(skill_blocks)
            # 多个知识包时给一句话引导。不说的话，模型很容易把几份互不相干的
            # 资料当成一份连续文档来理解，产出会跑偏。
            if len(skill_blocks) > 1:
                joined += (
                    "\n\n(The above are several independent knowledge packs. Decide from the user's question which ones apply; "
                    "you do not have to use all of them, and can ignore them if none are relevant.)"
                )
            system_text = f"{system_text}\n\n{joined}" if system_text else joined

        if system_text:
            messages.append({"role": "system", "content": system_text})

        parts: list[dict] = []
        prompt_text = (user_prompt or "").strip()
        if prompt_text:
            parts.append({"type": "text", "text": prompt_text})

        if image is not None:
            for url in self._pack_images(image):
                parts.append({"type": "image_url", "image_url": {"url": url}})

        if audio is not None:
            audio_part = self._pack_audio(audio)
            if audio_part:
                parts.append(audio_part)

        if not parts:
            parts.append({"type": "text", "text": "Describe what you received."})

        # 只有文本时用最简单的字符串形式 —— 兼容性最好，
        # 有些中转站对 content 数组支持不全。
        only_text = len(parts) == 1 and parts[0].get("type") == "text"
        messages.append({"role": "user", "content": parts[0]["text"] if only_text else parts})
        return messages

    def _build_payload(
        self,
        model: str,
        messages: list[dict],
        provider_key: str,
        thinking: str,
        temperature: float,
        max_tokens: int,
        extra_params: str,
    ) -> dict:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": float(temperature),
            "max_tokens": int(max_tokens),
            "stream": False,
        }

        param_name = providers.get(provider_key).thinking_param
        value = providers.get(provider_key).thinking_value(thinking)
        if param_name and value:
            payload[param_name] = value
        elif thinking != providers.THINKING_OFF and not param_name:
            warn(f"{providers.get(provider_key).label} has no thinking-effort parameter; using the model default this time", SHELF_LLM)

        extra = (extra_params or "").strip()
        if extra:
            try:
                parsed = json.loads(extra)
            except json.JSONDecodeError as exc:
                raise M8Error(
                    "M8-LLM-002",
                    message="extra_params is not valid JSON",
                    hint="Write it as an object, e.g. {\"top_p\": 0.9}",
                    detail=str(exc),
                ) from exc
            if not isinstance(parsed, dict):
                raise M8Error("M8-LLM-002", message="extra_params must be a JSON object")
            payload.update(parsed)

        return payload

    # ------------------------------------------------------------ 图片 / 音频

    def _pack_images(self, images) -> list[str]:
        """把 IMAGE 张量转成 data URL 列表。

        IMAGE 的形状是 [B, H, W, C]，float 0~1。转 PNG 再 base64 ——
        用 data URL 而不是先存文件，是因为有的部署环境把 output 目录挂到别处，
        存文件再给路径会踩空。
        """
        limit_count = int(config.get_setting("llm.max_images", 4) or 4)
        max_side = int(config.get_setting("llm.max_image_side", 1568) or 1568)

        try:
            import numpy as np
            from PIL import Image as PILImage
        except ImportError as exc:
            raise M8Error(
                "M8-LLM-008",
                message="Pillow / numpy are missing, cannot process images",
                hint="Both ship with ComfyUI; check the environment is complete",
                detail=str(exc),
            ) from exc

        try:
            batch = images
            if hasattr(batch, "cpu"):
                batch = batch.cpu().numpy()
            array = np.asarray(batch)
        except Exception as exc:  # noqa: BLE001 张量形态千奇百怪，统一转成 M8 错误
            raise wrap("M8-LLM-008", exc, message="Could not read the image tensor") from exc

        if array.ndim == 3:  # 单张没带 batch 维度
            array = array[None, ...]
        if array.ndim != 4:
            raise M8Error("M8-LLM-008", message=f"Unexpected image tensor shape: {array.shape}")

        count = min(array.shape[0], limit_count)
        if array.shape[0] > limit_count:
            warn(f"{array.shape[0]} images, sending only the first {limit_count} (cap is configurable in settings)", SHELF_LLM)

        urls: list[str] = []
        for index in range(count):
            frame = array[index]
            if frame.shape[-1] == 4:
                frame = frame[..., :3]
            if frame.shape[-1] != 3:
                raise M8Error("M8-LLM-008", message=f"Image {index} is not 3-channel: {frame.shape}")
            pixels = (np.clip(frame, 0.0, 1.0) * 255.0).round().astype("uint8")
            try:
                picture = PILImage.fromarray(pixels, "RGB")
                picture = self._shrink(picture, max_side)
                buffer = io.BytesIO()
                picture.save(buffer, format="PNG", optimize=False)
            except Exception as exc:  # noqa: BLE001
                raise wrap("M8-LLM-008", exc, message=f"Failed to encode image {index}") from exc
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            urls.append(f"data:image/png;base64,{encoded}")

        log(f"Packed {len(urls)} images", SHELF_LLM)
        return urls

    @staticmethod
    def _shrink(picture, max_side: int):
        """超过上限就等比缩。不缩的话一张 4K 图 base64 之后能有十几兆，接口多半直接拒。"""
        width, height = picture.size
        longest = max(width, height)
        if longest <= max_side:
            return picture
        ratio = max_side / float(longest)
        return picture.resize((max(1, int(width * ratio)), max(1, int(height * ratio))))

    def _pack_audio(self, audio) -> dict | None:
        """把 AUDIO 转成 WAV 的 base64。

        AUDIO 是 ComfyUI 的音频字典：{"waveform": 张量[B, C, T], "sample_rate": int}。
        用标准库 wave 写 WAV，不依赖 torchaudio。

        注意：comfy_api/latest/_io.py 里 AudioDict 声明的是 sampler_rate，
        那是 ComfyUI 源码里的笔误 —— comfy_extras/nodes_audio.py 里 105 处实际用的
        全是 sample_rate，sampler_rate 出现 0 次。别照着那个定义"改回来"。
        """
        try:
            import numpy as np
            import wave
        except ImportError as exc:
            raise wrap("M8-LLM-009", exc) from exc

        if not isinstance(audio, dict) or "waveform" not in audio:
            raise M8Error("M8-LLM-009", message=f"Unexpected audio input type: {type(audio).__name__}")

        try:
            waveform = audio["waveform"]
            if hasattr(waveform, "cpu"):
                waveform = waveform.cpu().numpy()
            array = np.asarray(waveform, dtype="float32")
            sample_rate = int(audio.get("sample_rate") or 44100)
        except Exception as exc:  # noqa: BLE001
            raise wrap("M8-LLM-009", exc) from exc

        # [B, C, T] -> 取第一段；[C, T] 直接用
        if array.ndim == 3:
            array = array[0]
        if array.ndim == 1:
            array = array[None, :]
        if array.ndim != 2:
            raise M8Error("M8-LLM-009", message=f"Unexpected waveform shape: {array.shape}")

        channels = array.shape[0]
        samples = np.clip(array, -1.0, 1.0)
        # 转 16 位 PCM；[C, T] -> [T, C] 交错
        interleaved = (samples.T * 32767.0).astype("<i2")

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as handle:
            handle.setnchannels(channels)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(interleaved.tobytes())

        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        log(f"Packed audio: {channels} ch / {sample_rate} Hz / {samples.shape[-1] / sample_rate:.1f}s", SHELF_LLM)
        return {"type": "input_audio", "input_audio": {"data": encoded, "format": "wav"}}


NODE_CLASS_MAPPINGS = {"M8LLMInference": M8LLMInference}
NODE_DISPLAY_NAME_MAPPINGS = {"M8LLMInference": "M8 · LLM Inference"}
