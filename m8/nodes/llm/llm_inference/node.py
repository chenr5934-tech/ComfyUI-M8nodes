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

# 图片输入口的上限。前端一个个往下展开，到这儿为止。
# 8 个是权衡：再多节点竖着会长得离谱，而且一次发 8 张图基本都没模型吃得下。
MAX_IMAGE_INPUTS = 8

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
                    "tooltip": "选择供应商。改这个会自动带出对应的默认 base_url 和思考参数；换成别的服务商就选「自定义」自己填地址。",
                }),
                "base_url": ("STRING", {
                    "default": providers.default_base_url("deepseek"),
                    "multiline": False,
                    "tooltip": "接口地址。默认 DeepSeek 的 https://api.deepseek.com/v1，改掉就能接任何 OpenAI 兼容端点。",
                }),
                "api_key": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": "留空就用服务端已保存的密钥（推荐：点「保存密钥」存到服务端，工作流文件里就不会带明文）。填在这里只对当前节点生效，并且会写进工作流。",
                }),
                "model": ([MODEL_PLACEHOLDER], {
                    "tooltip": "填好地址和密钥后点「刷新模型」拉取，或直接手输模型名。",
                }),
                "system_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "系统提示词：定模型的人格、语气、输出格式。留空则只发对话提示词。",
                }),
                "user_prompt": ("STRING", {
                    "multiline": True,
                    "default": "",
                    # 关掉动态提示词：大模型的提示词里花括号太常见了（JSON、代码、模板变量），
                    # 开着会被 {a|b} 语法随机替换，破坏性大于那点便利。要随机就在上游接文本节点。
                    "dynamicPrompts": False,
                    "tooltip": "这次要问的事。可以接别的节点的文本输出。",
                }),
                "thinking": (providers.THINKING_OPTIONS, {
                    "default": providers.THINKING_OFF,
                    "tooltip": "思考强度。关=不额外要求；越高越让模型多想。供应商不支持该参数时会自动去掉它重试。",
                }),
                "show_thinking": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "是否把模型的思考过程显示在节点面板上（默认关：思考内容通常很长）。只影响显示，不影响 text 输出。",
                }),
                "temperature": ("FLOAT", {
                    "default": 1.0, "min": 0.0, "max": 2.0, "step": 0.05,
                    "tooltip": "随机性。写提示词这类要稳的活儿调低，创意类的调高。",
                }),
                "max_tokens": ("INT", {
                    "default": DEFAULT_MAX_TOKENS, "min": 16, "max": 131072, "step": 16,
                    "tooltip": "回答长度上限。注意这是上限不是目标。",
                }),
                "timeout": ("INT", {
                    "default": DEFAULT_TIMEOUT, "min": 5, "max": 3600, "step": 5,
                    "tooltip": "单次请求超时秒数。长思考的模型建议给到 300 以上。",
                }),
            },
            "optional": {
                "armor": ("M8_ARMOR", {
                    "tooltip": "从 M8 · 破甲注入 接进来。内容拼在系统消息最前面 —— 模型对开头的指令权重最高，破甲放末尾会被稀释。",
                }),
                "skill": ("M8_SKILL", {
                    "tooltip": "从 M8 · Skill 装载 接进来。内容会附在系统提示词后面当参考资料。",
                }),
                "skill_auto": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "打开后把服务端已上传的 skill 一起注入，由模型自己判断该用哪个。默认关：库里内容一多，每轮都会带上几份用不上的，白烧 token。",
                }),
                "image": ("IMAGE", {
                    "tooltip": "接图片给能看图的模型。接上之后，下面会自动多出下一个图片口。",
                }),
                # 多图输入。后端必须把这几个口全声明出来 —— ComfyUI 的 INPUT_TYPES
                # 是静态的，前端能动态显示/隐藏，但执行时只能拿到这里写过的名字。
                # 前端只放出「当前用得到的那一个」，一个个接下去。
                **{
                    f"image_{i}": ("IMAGE", {
                        "tooltip": f"第 {i} 张图。上一张接好之后这个口会自动出现。",
                    })
                    for i in range(2, MAX_IMAGE_INPUTS + 1)
                },
                "audio": ("AUDIO", {
                    "tooltip": "接音频给能听音频的模型（转成 WAV 发出去）。",
                }),
                "extra_params": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "【请求参数】只放 JSON 对象，会合并进请求体（比如 {\"top_p\": 0.9}）。**这里不是写提示词的地方** —— 想补一段话请用下面的「额外文本」框。",
                }),
                # 放在最后是有意的：widgets_values 按索引存取，新控件只能追加在末尾。
                # 插在中间会让已保存的工作流把 skill_auto / extra_params 的值读错位。
                "extra_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "【额外文本】拼在这一轮提问的后面，属于**用户提示词**，不是系统提示词。放补充要求、格式约束、这次想强调的东西。和本地大模型推理节点上那个同名框是一回事。",
                }),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "M8/大模型"
    DESCRIPTION = "靠 API 调用大模型：双提示词框 + 模型下拉 + 思考强度；可接 skill / 图片 / 音频，输出文本。"
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
        armor: dict | None = None,
        skill: dict | None = None,
        skill_auto: bool = False,
        image=None,
        image_2=None,
        image_3=None,
        image_4=None,
        image_5=None,
        image_6=None,
        image_7=None,
        image_8=None,
        audio=None,
        extra_params: str = "",
        extra_text: str = "",
    ):
        # 老工作流里档位存的是中文（关/低/中/高），这里归一成当前取值
        thinking = providers.normalize_thinking(thinking)

        # 八个图片口收成一个列表：哪个口接了什么后端不关心，只关心顺序
        images = [
            item for item in (
                image, image_2, image_3, image_4, image_5, image_6, image_7, image_8,
            ) if item is not None
        ]

        self._validate_request(model, user_prompt, images, audio, extra_text)

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
        armor_text = self._armor_text(armor)
        messages = self._build_messages(
            system_prompt, armor_text, user_prompt, skill_blocks, images, audio, extra_text=extra_text
        )
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
            f" / armor {len(armor_text)} chars / extra {(len(extra_text or ''))} chars / thinking {thinking}",
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
    def _validate_request(model: str, user_prompt: str, images, audio, extra_text: str = "") -> None:
        name = (model or "").strip()
        if not name or name == MODEL_PLACEHOLDER:
            raise M8Error(
                "M8-LLM-006",
                message="No model selected",
                hint="Click Refresh models on the node, or type a model name directly",
            )
        # 只写了「额外文本」也算有内容 —— 那个框拼在提问后面，本身就是一段提示词
        if (
            not (user_prompt or "").strip()
            and not (extra_text or "").strip()
            and not images
            and audio is None
        ):
            raise M8Error("M8-LLM-007")

    @staticmethod
    def _armor_text(armor) -> str:
        """从 armor 输入里取注入文本。

        连进来的东西理论上一定是 M8ArmorBreak 给的 dict，但这个口子也能被手改过的
        工作流塞进任意值。取不到就退成空串 —— 破甲是增强，缺了照常推理，
        不该让整张图跑不起来。
        """
        if isinstance(armor, dict):
            return str(armor.get("text") or "").strip()
        if isinstance(armor, str):
            return armor.strip()
        return ""

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
        armor_text: str,
        user_prompt: str,
        skill_blocks: list[str],
        images,
        audio,
        extra_text: str = "",
    ) -> list[dict]:
        messages: list[dict] = []

        # 三段拼接，顺序各有理由：
        #   armor 在最前 —— 模型对 system 开头的指令权重最高，破甲拼到末尾等于自我稀释；
        #   system_prompt 是用户自己写的人格设定，居中；
        #   skill 是参考资料，垫底。
        system_text = (system_prompt or "").strip()
        if armor_text:
            system_text = f"{armor_text}\n\n{system_text}" if system_text else armor_text
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

        # 「额外文本」和用户提示词是**同一性质**的东西 —— 都属于用户消息，
        # 只是分成两个框写：一个存常用的固定要求，一个随手改。
        # 拼成一段完整的提问发出去，不单独成一条 message。
        extra = (extra_text or "").strip()
        if extra:
            prompt_text = f"{prompt_text}\n\n{extra}" if prompt_text else extra

        if prompt_text:
            parts.append({"type": "text", "text": prompt_text})

        # 没有图时 _pack_images 直接回空列表，不用在外面再判一次
        for url in self._pack_images(images):
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
                    hint=(
                        "这个框只放请求参数 JSON，比如 {\"top_p\": 0.9}。"
                        "要补一段提示词，请清空它，改用下面的「额外文本」框（extra_text）"
                    ),
                    detail=str(exc),
                ) from exc
            if not isinstance(parsed, dict):
                raise M8Error("M8-LLM-002", message="extra_params must be a JSON object")
            payload.update(parsed)

        return payload

    # ------------------------------------------------------------ 图片 / 音频

    def _pack_images(self, tensors) -> list[str]:
        """把若干个 IMAGE 张量转成 data URL 列表。

        参数是**列表**：每个图片输入口给一个张量，形状 [B, H, W, C]，float 0~1。
        8 个口全接上就会收到 8 个张量，逐个拆帧、按口的顺序排好。

        转 PNG 再 base64 —— 用 data URL 而不是先存文件，是因为有的部署环境把
        output 目录挂到别处，存文件再给路径会踩空。
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

        # 先把所有输入口的帧摊平成一条，再统一限流 —— 逐个口限流的话
        # 「第一个口给 4 张、第二个口还有」这种情况就说不清了
        frames = []
        for slot, tensor in enumerate(tensors or []):
            if tensor is None:
                continue
            try:
                batch = tensor
                if hasattr(batch, "cpu"):
                    batch = batch.cpu().numpy()
                array = np.asarray(batch)
            except Exception as exc:  # noqa: BLE001 张量形态千奇百怪，统一转成 M8 错误
                raise wrap("M8-LLM-008", exc, message=f"Could not read image input {slot + 1}") from exc

            if array.ndim == 3:  # 单张没带 batch 维度
                array = array[None, ...]
            if array.ndim != 4:
                raise M8Error(
                    "M8-LLM-008",
                    message=f"Image input {slot + 1} has an unexpected shape: {array.shape}",
                )
            frames.extend(array[index] for index in range(array.shape[0]))

        if not frames:
            return []

        if len(frames) > limit_count:
            warn(
                f"收到 {len(frames)} 张图，只发前 {limit_count} 张"
                f"（上限在设置里可调：llm.max_images）",
                SHELF_LLM,
            )
            frames = frames[:limit_count]

        urls: list[str] = []
        for index, frame in enumerate(frames):
            
            if frame.shape[-1] == 4:
                frame = frame[..., :3]
            if frame.shape[-1] != 3:
                raise M8Error("M8-LLM-008", message=f"Image {index + 1} is not 3-channel: {frame.shape}")
            pixels = (np.clip(frame, 0.0, 1.0) * 255.0).round().astype("uint8")
            try:
                picture = PILImage.fromarray(pixels, "RGB")
                picture = self._shrink(picture, max_side)
                buffer = io.BytesIO()
                picture.save(buffer, format="PNG", optimize=False)
            except Exception as exc:  # noqa: BLE001
                raise wrap("M8-LLM-008", exc, message=f"Failed to encode image {index + 1}") from exc
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
NODE_DISPLAY_NAME_MAPPINGS = {"M8LLMInference": "M8 · 大模型推理"}
