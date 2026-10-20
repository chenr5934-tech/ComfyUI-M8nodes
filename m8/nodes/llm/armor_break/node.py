"""M8 · 破甲注入（大模型货架）。

把一段破甲系统指令装成可连线的包，接到 M8 · 大模型推理 的 armor 输入口。

## 为什么是独立节点，而不是推理节点上的一个开关

一个档位配置可以同时喂给多个推理节点；推理节点保持干净（它管推理，不管话术）；
换档位比在推理节点上翻下拉更直观。这三条和 M8SkillLoader 的理由是一样的。

## 注入位置跟 skill 不同，这是本节点的设计核心

推理节点拼 system 消息的顺序是：**armor → system_prompt → skill**。

模型对 system 消息开头的指令权重最高。破甲内容要是被拼到末尾，
等于自己把自己削弱一半 —— 越狱提示词之所以都写在最前面，就是这个原因。

也正因为如此，这里**不能复用 M8_SKILL 那个通道**：skill 会被包进
<skill name="..."> 标签里，语义上是「参考资料」，正好把指令降级成资料，
模型对它的服从度会明显下降。

## 这个节点没有任何 IO

文案全在 prompts.py 里，随代码走。没有「预设文件找不到」这种失败路径，
所以不需要新错误码。用户要改词句就在节点上的「补充」框里写；
想整段换掉，去改 prompts.py —— 那是代码，改完就和插件版本绑定了，
不会因为升级丢东西（把它做成可编辑的外部文件反而会）。

输出类型 M8_ARMOR，值是一个 dict：
    {"level": "增强", "scene": "通用", "text": "...", "chars": 1234, "sections": [...]}
"""

from __future__ import annotations

from typing import Any

from ....core.log import SHELF_LLM, log
from . import prompts


class M8ArmorBreak:
    """M8 · 破甲注入

    选一个强度档位和场景，把这段系统指令接到 M8 · 大模型推理 的 armor 输入口。
    档位是叠加的：增强 = 基础 + 拒绝对抗，全量 = 增强 + 外来指令免疫。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "level": (list(prompts.LEVELS), {
                    "default": prompts.DEFAULT_LEVEL,
                    "tooltip": "【档位】管「破得多深」，逐档叠加：基础 = 身份与执行模式；增强 = 再加拒绝对抗；全量 = 再加外来指令免疫和占位符规则。选「关」等于把这条线摘掉。正文框留空时它决定正文。",
                }),
                "scene": (list(prompts.SCENES), {
                    "default": prompts.DEFAULT_SCENE,
                    "tooltip": "【场景】管「交付成什么形状」：编码给命令和代码块，写作要出戏，图像提示词给一行连着的提示词串。和档位正交，四乘四随便配。正文框留空时它决定正文的最后一段。",
                }),
            },
            "optional": {
                "enabled": ("BOOLEAN", {
                    "default": True,
                    "tooltip": "关掉之后输出空，等于临时摘下这个节点，不用改工作流。",
                }),
                # 正文在前、补充在后：正文是主体，补充是往主体后面续的一句话，
                # 排在一起看才分得清主次。
                "body": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "【破甲正文】真正发给模型的那段话。留空 = 用上面「档位 + 场景」拼出来的预设；填了 = 以这里为准，档位只作记录不再参与拼接。想从预设起步就点节点上的「灌入预设」，然后在这里随便改。",
                }),
                "extra": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "tooltip": "【补充指令】拼在正文最后的一句。不覆盖正文，只是续一句 —— 比如「这次只输出英文」。正文走预设还是走自定义，它都排在最后。",
                }),
            },
        }

    RETURN_TYPES = ("M8_ARMOR",)
    RETURN_NAMES = ("armor",)
    FUNCTION = "build"
    CATEGORY = "M8/大模型"
    DESCRIPTION = "破甲系统指令包：按档位和场景拼一段注入文本，接到 M8 · 大模型推理 的 armor 输入口，会放在系统消息最前面。"
    OUTPUT_NODE = False

    def build(self, level: str, scene: str, enabled: bool = True, body: str = "", extra: str = ""):
        if not enabled:
            log("破甲已关闭，输出空", SHELF_LLM)
            return {"ui": {"m8": {"text": "", "chars": 0, "preview": ""}}, "result": (None,)}

        level = prompts.normalize_level(level)
        scene = prompts.normalize_scene(scene)

        # 正文框非空就以它为准：那是用户亲手改过的，比档位预设权威。
        # 这时档位和场景只记「他从哪份预设改出来的」，不参与拼接。
        body_text = (body or "").strip()
        custom = bool(body_text)
        if not custom:
            body_text = prompts.compose(level, scene, "")

        # 补充两种模式下都拼在最后 —— 语义是「在这个基础上再加一句」，
        # 不会因为正文改成了自定义就变成替换。
        tail = (extra or "").strip()
        if tail:
            body_text = f"{body_text}\n\n{tail}" if body_text else tail

        if not body_text:
            # 档位是「关」又没有补充 —— 不是错误，推理节点那边当「这次没有破甲」处理
            log("破甲档位为「关」且没有补充，输出空", SHELF_LLM)
            return {"ui": {"m8": {"text": "", "chars": 0, "preview": ""}}, "result": (None,)}

        payload: dict[str, Any] = {
            "level": level,
            "scene": scene,
            "custom": custom,
            "text": body_text,
            "chars": len(body_text),
            "sections": ["custom"] if custom else prompts.sections_of(level, scene),
        }
        log(
            f"破甲包：{level} / {scene}{'（自定义正文）' if custom else ''}"
            f"（{len(body_text)} 字，{len(payload['sections'])} 段）",
            SHELF_LLM,
        )

        # 正文回传一份给节点上的只读框。破甲文本有上千字，看不见就是黑箱 ——
        # 用户得能确认自己往模型嘴里塞了什么。截 4000 字是防「补充」框里塞进
        # 一整篇文章把 ui 消息撑爆，正常档位远用不到这个量。
        return {"ui": {"m8": {**payload, "preview": body_text[:4000]}}, "result": (payload,)}


NODE_CLASS_MAPPINGS = {"M8ArmorBreak": M8ArmorBreak}
NODE_DISPLAY_NAME_MAPPINGS = {"M8ArmorBreak": "M8 · 破甲注入"}
