"""M8 统一错误体系。

规矩（改代码时不要破）：

  1. 对外暴露的每一条失败路径都要有码。码在这里登记，并且和
     docs/ERROR-PLAYBOOK.md 一行一行对得上 —— 报错手册是查表用的，
     表里没有的码等于没有码。
  2. 底层原始异常（URLError / HTTPError / JSONDecodeError）必须在这里包成
     M8Error 再往外抛，原始文本放 detail。不许让裸异常冒到 ComfyUI 的报错框。
  3. 节点执行函数捕获 M8Error，用 format_for_node() 转成一条人能读的消息。

码段分配见 docs/ROADMAP.md 的货架总表。新增码 = 同时更新本文件和报错手册。
"""

from __future__ import annotations

from typing import Any

# 货架段白名单。码里的第二段只能是这里面的值 —— 拼错一个字母（比如 M8-LLMS-001）
# 会让报错查表查空，而查表正是这套错误码存在的全部意义。
#
# 开新货架时要同时改三处，缺一处测试就红：
#     1. 这里
#     2. docs/ROADMAP.md 的货架总表
#     3. docs/ERROR-PLAYBOOK.md（新码段下要有表格）
SHELVES: tuple[str, ...] = ("CORE", "SRV", "LLM", "LOAD", "SAMP", "LOGIC", "IMG", "TXT", "UTIL", "UI", "CAM", "PROMPT", "WEB")

# 码 -> (默认消息, 默认修复建议)
# 这里只放「不依赖上下文就有意义」的默认文案；具体调用点可以覆盖。
ERRORS: dict[str, tuple[str, str]] = {
    # ---- 地基 ----
    "M8-CORE-001": ("货架导入失败", "看 detail 里的 ImportError 原文，通常是该货架文件语法错或少了 __init__.py"),
    "M8-CORE-002": ("节点类名重复", "两个货架注册了同名节点，改成唯一名"),
    "M8-CORE-003": ("配置文件损坏", "删掉 m8/data/settings.json，会自动重建"),
    "M8-CORE-004": ("数据目录建不出来", "检查 custom_nodes 目录的写权限"),
    # ---- 接口 ----
    "M8-SRV-001": ("路由挂载失败", "PromptServer 还没就位；重启 ComfyUI"),
    "M8-SRV-002": ("上传内容为空", "选文件时确认文件非空"),
    "M8-SRV-003": ("文件名非法", "换个纯文件名，不要带斜杠或反斜杠"),
    "M8-SRV-004": ("文件超出体积上限", "skill 是提示词文本，不该超过 2 MB"),
    "M8-SRV-005": ("指定的 skill 不存在", "在节点上重新选一个，或重新上传"),
    "M8-SRV-006": ("包里没有主文件", "至少要有一个 .md 作为这个 skill 的正文（推荐命名为 SKILL.md）"),
    # ---- 大模型 ----
    "M8-LLM-001": ("未配置 API Key", "在节点上填入 API Key"),
    "M8-LLM-021": (
        "密钥存着，但不会发到这个地址",
        "这个 base_url 不是那份密钥归属的地址（换过接口地址、或者用的是旧版本存下的密钥）。"
        "在节点上点一次「保存密钥到服务端」，它会把当前地址一起记下，之后就对得上了",
    ),
    "M8-LLM-002": ("base_url 不是合法 URL", "检查是否漏了 https://；默认 https://api.deepseek.com/v1"),
    "M8-LLM-003": ("连不上接口", "检查网络与代理；也可以调大节点上的 timeout"),
    "M8-LLM-004": ("接口返回非 200", "看 detail 里的响应正文：401=Key 错，402=余额，404=地址写错，429=限流"),
    "M8-LLM-005": ("响应不是预期 JSON", "该地址可能不是 OpenAI 兼容接口；换一个 base_url"),
    "M8-LLM-006": ("拉不到模型列表", "可以手动在 model 里填模型名直接跑"),
    "M8-LLM-007": ("提示词是空的", "至少填对话提示词"),
    "M8-LLM-008": ("图片转码失败", "检查上游图像节点的输出张量"),
    "M8-LLM-009": ("音频转换失败", "确认音频采样率与波形张量正常"),
    "M8-LLM-010": ("该模型不支持图片 / 音频输入", "断开图片 / 音频输入，或换多模态模型"),
    "M8-LLM-011": ("skill 文件读不到", "文件被删了或路径失效，重新选一个"),
    "M8-LLM-012": ("内容超出上下文预算", "换短一点的 skill，或调大 max_tokens"),
    "M8-LLM-013": ("请求体过大", "减少图片张数或先缩放"),
    # ---- 本地模型（llm_local 货架）----
    "M8-LLM-014": ("找不到本地模型", "往 ComfyUI 的 models/LLM 目录放 .gguf 文件；用 extra_model_paths.yaml 挂过去也行"),
    "M8-LLM-015": ("本地推理依赖用不了", "在 ComfyUI 的 python 里装：pip install llama-cpp-python"),
    "M8-LLM-016": ("这个多模态模型 llama-cpp-python 不认", "升级一下：pip install -U llama-cpp-python"),
    "M8-LLM-017": ("本地模型加载不起来", "确认 GGUF 完整、没在下 half 下载中、也没被别的程序占着"),
    "M8-LLM-018": ("图片处理出错", "IMAGE 输入应该是 [批, 高, 宽, 3]；确认 pillow 和 numpy 在"),
    "M8-LLM-019": ("什么都没问", "至少填「提问」，或者接一张图进来"),
    "M8-LLM-020": ("本地推理出错", "上下文不够就调大「上下文长度」；显存放不下就把「GPU 层数」改 0"),
    # ---- 界面扩展 ----
    "M8-UI-001": ("没配 DeepSeek 密钥", "在侧边栏小鲸鱼的设置里填密钥，或先在推理节点上存一份"),
    "M8-UI-002": ("余额查不到", "看 detail 里的响应正文：401=密钥不对，403=密钥没权限，其余多半是网络"),
    "M8-UI-003": ("余额响应格式不对", "接口返回的结构和预期不符；可能是端点变了，看 detail"),
    "M8-UI-004": ("读不到 LoRA 列表", "确认 ComfyUI 的 models/loras 目录存在且有文件；detail 里是原始异常"),
    # ---- 相机货架 ----
    "M8-CAM-001": ("相机配置不是合法 JSON", "点节点上的「设置」把那段 JSON 改成合法写法，或点「粘贴」用回一份好的"),
    "M8-CAM-002": ("配置名不合法", "用中英文、数字、下划线或连字符，别带斜杠"),
    "M8-CAM-003": ("配置读写失败", "检查 m8/data/camera-configs/ 目录的权限；detail 里是原始异常"),
    "M8-CAM-004": ("配置太大存不下", "正常配置只有几 KB；确认没有误传大文件"),
    "M8-CAM-005": ("没有这个配置", "点下拉重新拉一遍列表，或另存一份"),
    # ---- 提示词货架 ----
    "M8-PROMPT-001": ("角色配置不是合法 JSON", "点节点上的「设置」把那段 JSON 改回合法写法，或点「重置」用回默认"),
    "M8-PROMPT-002": ("角色坐标或权重不合法", "看 detail 里是哪个角色、哪个字段；坐标要在 0-1 之间，宽度高度要大于 0"),
    "M8-PROMPT-003": ("没有任何启用的角色", "勾上至少一个角色，或把输出格式切成 plain"),
    "M8-PROMPT-004": ("不认识的输出格式", "格式只能是 attn / regional / plain 里的一个"),
    "M8-PROMPT-005": ("预设名不合法", "用中英文、数字、下划线或连字符，别带斜杠"),
    "M8-PROMPT-006": ("预设读写失败", "检查 m8/data/prompt-presets/ 目录的权限；detail 里是原始异常"),
    "M8-PROMPT-007": ("没有这个预设", "点下拉重新拉一遍列表，或者另存一份"),
    # ---- 网页货架 ----
    "M8-WEB-001": ("网页资源路径越界", "URL 里不要带 ..；正常从首页点进去就好"),
    "M8-WEB-002": ("不允许的网页资源类型", "只服务 html/css/js/图片/字体这类静态资源"),
    "M8-WEB-003": ("网页里没有这个文件", "从首页点进去；手输 URL 的话确认拼写"),
    "M8-WEB-004": ("找不到桌面目录", "确认当前用户有桌面；桌面被挪到 OneDrive 的话，先打开一次文件资源管理器让它建出来"),
    "M8-WEB-005": ("快捷方式的地址不合法", "正常从工作台页面点那个按钮就行，别手改请求"),
    "M8-WEB-006": ("写快捷方式失败", "桌面上是不是有个同名的只读文件？删掉它再试"),
    "M8-WEB-007": ("不认识的数据类别", "只支持 oc / prompts / groups / stickers 这四类"),
    "M8-WEB-008": ("建不出工作台数据目录", "检查 ~/M8 的写权限；想换地方就设环境变量 M8_DATA_DIR"),
    "M8-WEB-009": ("写工作台数据文件失败", "检查磁盘空间和 ~/M8/webapp 的写权限"),
    "M8-WEB-011": ("目标路径不在允许的目录里", "内部调用出错，正常从工作台点按钮不会走到这儿"),
    "M8-WEB-010": ("工作台数据调用出错", "这是内部调用写错了，不是你的操作问题；看 detail"),
}


def describe(code: str) -> tuple[str, str]:
    """取一个码的默认 (消息, 修复建议)。没登记过就返回占位文案。"""
    return ERRORS.get(code, ("未登记的错误码", f"该码不在 ERRORS 表里，请补登记：{code}"))


class M8Error(Exception):
    """M8 插件里唯一的对外异常。

    code    形如 M8-LLM-001，决定去报错手册的哪一行查
    message 一句话说清发生了什么（给人看的）
    hint    怎么修（给人看的）
    detail  原始异常 / 响应正文（给排查用的），不截断
    """

    def __init__(self, code: str, message: str = "", hint: str = "", detail: str = "") -> None:
        default_message, default_hint = describe(code)
        self.code = code
        self.message = message or default_message
        self.hint = hint or default_hint
        self.detail = detail
        super().__init__(self.format_for_node())

    @property
    def shelf(self) -> str:
        """码里的货架段：M8-LLM-001 -> LLM。日志和过滤都用它。"""
        parts = self.code.split("-")
        return parts[1] if len(parts) >= 3 else "CORE"

    def format_for_node(self) -> str:
        """ComfyUI 报错框里显示的样子。三行：码 + 消息 / 修复 / 详情（有才显示）。

        前缀用英文：这两行会原样出现在 ComfyUI 的报错框里，属于界面文案。
        表里的默认 message / hint / detail 是英文；但调用点可以用具体信息覆盖它们，
        而那些覆盖多半是中文（比如「密钥写不进磁盘」）—— 那是运行时的诊断文本，
        不是界面标签，审核管的是后者。
        """
        lines = [f"[{self.code}] {self.message}"]
        if self.hint:
            lines.append(f"  Fix: {self.hint}")
        if self.detail:
            lines.append(f"  Detail: {self.detail}")
        return "\n".join(lines)

    def to_payload(self) -> dict[str, Any]:
        """给前端 JSON 接口用的形状。前端拿 code 就能去手册查。"""
        return {
            "ok": False,
            "code": self.code,
            "error": self.message,
            "hint": self.hint,
            "detail": self.detail,
        }


def wrap(code: str, exc: BaseException, message: str = "", hint: str = "") -> M8Error:
    """把底层异常包成 M8Error，原始文本进 detail。

    这是「不许裸异常外泄」这条规矩的落地工具：所有 except 块都该用它收尾。
    """
    return M8Error(
        code,
        message=message,
        hint=hint,
        detail=f"{type(exc).__name__}: {exc}",
    )
