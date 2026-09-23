"""M8 · Skill 装载（大模型货架）。

把一段提示词文本（skill 文件）装成一个可以连线的数据包，喂给 M8LLMInference。

为什么做成独立节点而不是塞进推理节点里：
  1. 一个 skill 可以同时喂给多个推理节点，改一次全都变
  2. 推理节点因此保持干净 —— 它只管推理，不管文件
  3. skill 是可换的：换一个 skill 节点比在推理节点里重选下拉更直观

输出类型 M8_SKILL 是本插件自定义的连线类型，值是一个 dict：
    {"name": "xxx.md", "text": "...", "chars": 1234, "path": "..."}

上传功能不在这里 —— 那是前端按钮 + /m8/skills/upload 接口的事。
节点只负责「从已有的 skill 里挑一个装进来」。
"""

from __future__ import annotations

from typing import Any

from ....core import paths
from ....core.errors import M8Error
from ....core.log import SHELF_LLM, log
from ....server import skills

# Placeholder shown in the skill dropdown when nothing is uploaded yet.
# The frontend replaces it after fetching /m8/skills/list.
NO_SKILL = "(no skill uploaded yet)"


class M8SkillLoader:
    """M8 · Skill 装载

    节点上先点「上传 Skill」把文件传上去（存到 m8/data/skills/），
    再在下拉里选一个。输出接给 M8 · 大模型推理 的 skill 输入。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "skill": ([NO_SKILL], {
                    "tooltip": "Pick an uploaded skill file. Use the Upload button on the node to add one.",
                }),
            },
            "optional": {
                "enabled": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "Turn off to output an empty skill, as if unplugging the wire without editing the workflow.",
                }),
                "extra_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "Extra text appended after this skill. Handy for one-off tweaks you do not want to write into the file.",
                }),
            },
        }

    RETURN_TYPES = ("M8_SKILL",)
    RETURN_NAMES = ("skill",)
    FUNCTION = "load"
    CATEGORY = "M8/LLM"
    DESCRIPTION = "Loads a skill file (prompt text) and outputs it as a knowledge pack for M8 · LLM Inference."
    OUTPUT_NODE = False

    @classmethod
    def VALIDATE_INPUTS(cls, skill):
        """放行任意 skill 名。

        候选列表由前端拉 /m8/skills/list 之后动态写进 widget，服务端 INPUT_TYPES
        只能给一份占位列表。默认校验会拿那份占位列表去比对，于是必然报
        「Value not in list」—— 前端能选中，一提交就被拦。

        只声明 skill 一项（不带 **kwargs），这样 enabled / extra_text 仍走默认校验。
        """
        return True

    def load(self, skill, enabled=True, extra_text=""):
        if not enabled:
            log("skill 已关闭，输出空", SHELF_LLM)
            return (None,)

        name = (skill or "").strip()
        if not name or name == NO_SKILL:
            # 没选 skill 不是错误：推理节点那边会当作「这次没有知识包」处理
            return (None,)

        try:
            text = skills.read_skill(name)
        except M8Error as exc:
            raise M8Error(exc.code, message=f"Skill load failed: {exc.message}", hint=exc.hint, detail=exc.detail) from exc

        suffix = (extra_text or "").strip()
        if suffix:
            text = f"{text}\n\n{suffix}"

        payload: dict[str, Any] = {
            "name": name,
            "text": text,
            "chars": len(text),
            "path": str(paths.SKILLS_DIR / name),
        }
        log(f"装载 skill：{name}（{len(text)} 字）", SHELF_LLM)
        return (payload,)


NODE_CLASS_MAPPINGS = {"M8SkillLoader": M8SkillLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"M8SkillLoader": "M8 · Skill Loader"}
