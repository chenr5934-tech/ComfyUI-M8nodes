"""路径与数据目录。

插件自己需要落盘的东西全在 m8/data/ 下面，那个目录在 .gitignore 里。
这里只算路径，不做 IO —— 目录的实际创建交给 ensure_data_dirs()，
在插件加载时调一次，别在每个函数里 mkdir。
"""

from __future__ import annotations

import os
from pathlib import Path

# m8/core/paths.py -> m8/core -> m8 -> 插件根
PLUGIN_DIR = Path(__file__).resolve().parent.parent.parent

# 后端包
PACKAGE_DIR = PLUGIN_DIR / "m8"

# 前端目录（ComfyUI 的 WEB_DIRECTORY 指向它）
WEB_DIR = PLUGIN_DIR / "js"
# M8web：插件自带的网页（首页 + 各功能页），由 /m8/web/ 提供
WEBAPP_DIR = PLUGIN_DIR / "M8web"

# 运行时数据
DATA_DIR = PACKAGE_DIR / "data"
SKILLS_DIR = DATA_DIR / "skills"
CACHE_DIR = DATA_DIR / "cache"

# 文件
SETTINGS_FILE = DATA_DIR / "settings.json"
CREDENTIALS_FILE = DATA_DIR / "credentials.json"
MODELS_CACHE_FILE = CACHE_DIR / "models.json"

# 小鲸鱼的用量记账。它属于「观测数据」不是「配置」，但也没大到要单开目录，
# 就放在数据根下 —— 一眼能看出它是谁的东西。
WHALE_USAGE_FILE = DATA_DIR / "whale-usage.json"

# 对话框的历史记录。存服务端不存浏览器：localStorage 会随清缓存、换 profile、
# 隐私模式一起消失，而且它写不进去时浏览器不给理由 —— 之前那版就是静默丢的。
WHALE_HISTORY_FILE = DATA_DIR / "whale-history.json"

# 相机货架：用户存的机位配置（一个配置一个 json，文件名就是配置名）
CAMERA_CONFIGS_DIR = DATA_DIR / "camera-configs"

# 提示词货架：存下来的角色配置预设，一份一个 json
PROMPT_PRESETS_DIR = DATA_DIR / "prompt-presets"

# 上传限制。
# 单个文件：skill 的主文件是提示词文本，2 MB 已经非常宽裕。
MAX_SKILL_BYTES = 2 * 1024 * 1024
# 整个包：带资源的 skill 包（参考资料、模板、示例数据）可以大得多，
# 但不该无上限 —— 这东西是要通过浏览器上传到本地 ComfyUI 的。
MAX_PACKAGE_BYTES = 16 * 1024 * 1024

# 允许的 skill 后缀（纯文本类）
SKILL_SUFFIXES = {".md", ".txt", ".json", ".yaml", ".yml", ".toml", ""}


# ------------------------------------------------------------------ 工作台数据目录

def _find_comfy_root(start: Path) -> Path | None:
    """从 start 往上找 ComfyUI 根：那个同时有 models/ 和 custom_nodes/ 的目录。

    **靠"长什么样"判断，不靠"在第几层"** —— 层数我数错过，而且插件可能通过
    junction 挂在 custom_nodes 下、也可能被塞进更深的子目录里。
    找不到就返回 None，让调用方走兜底，不抛。
    """
    node = start.resolve()
    for _ in range(6):
        if (node / "models").is_dir() and (node / "custom_nodes").is_dir():
            return node
        parent = node.parent
        if parent == node:
            break
        node = parent
    return None


def _looks_like_real_folder_paths(mod: object) -> bool:
    """确认这个是 ComfyUI 真的那个 folder_paths，不是别人塞进来的空壳。

    以前这里查的是「models_dir 旁边有没有 custom_nodes」。那个判据两头不讨好：
    它挡不住真正的假货（照着建两个目录就行），却会误伤合法安装 —— 用户用
    extra_model_paths.yaml 把 models 挪到别的盘时，新位置旁边当然不会有
    custom_nodes，于是我们把他给的值拒掉、退回自己推的默认位置，数据就存到了
    他根本不看的地方。实测复现过。

    改成看模块本身：ComfyUI 的 folder_paths 一定有 folder_names_and_paths
    这个 dict 和 get_filename_list 这个函数。这跟它在哪个盘、第几层、
    旁边有什么，一点关系都没有。
    """
    if not isinstance(getattr(mod, "folder_names_and_paths", None), dict):
        return False
    return callable(getattr(mod, "get_filename_list", None))


def _models_dir() -> Path | None:
    """ComfyUI 的 models 目录。

    **优先问 ComfyUI 自己**：别人可能用 extra_model_paths.yaml 把 models
    挪到别的盘上去，只有它知道最终落到哪儿。**绝不写死路径** —— 别人的
    安装位置和我们的不一样。

    拿不到 folder_paths（插件单独跑的时候，比如那个独立服务）就自己从
    插件位置往上推。
    """
    try:
        import folder_paths  # type: ignore  # 只有在 ComfyUI 里才存在

        got = getattr(folder_paths, "models_dir", None)
        if got and _looks_like_real_folder_paths(folder_paths):
            return Path(got)
    except Exception:
        pass
    root = _find_comfy_root(PLUGIN_DIR)
    return (root / "models") if root else None


def _resolve_user_data_dir() -> Path:
    """工作台的数据放哪儿。四层，从最确切到最兜底。

    为什么必须放在插件目录外面：插件更新会把 custom_nodes 里的东西整个换掉
    （ComfyUI 整合包升级更狠，直接清空重装），m8/data/ 会跟着一起没。
    而工作台里的东西（OC、提示词、贴纸库）是用户一条条攒出来的，丢了找不回来。

    为什么放 models 下：那里本来就是用户自己的数据区、在别的盘上也常见、
    备份的时候顺手就带走了，而且不会被 ComfyUI 的升级流程清掉。
    """
    env = os.environ.get("M8_DATA_DIR")
    if env:
        return Path(env)
    models = _models_dir()
    if models is not None:
        return models / "M8data"
    # 一个都推不出来（插件被拆出来单独跑之类）——别抛，退回用户目录
    return Path.home() / "M8"


USER_DATA_DIR = _resolve_user_data_dir()
WEBAPP_DATA_DIR = USER_DATA_DIR / "webapp"

# 给独立服务用的路标：CUI 加载时把最终算出来的路径写一份在这儿。
# 独立服务自己没有 ComfyUI 环境，而且插件可能是 junction 挂进去的 ——
# 它从自己的真实位置往上找是找不到 ComfyUI 的。读这个文件最省事。
# 它只是个提示，丢了 CUI 下次启动会重新写，不算数据。
DATA_POINTER_FILE = WEBAPP_DIR / ".m8data"


def ensure_data_dirs() -> None:
    """建好运行时目录。插件加载时调一次。

    目录建不出来不抛异常（只警告）—— 只读的部署环境里插件其余部分还该能用，
    真正写不进去的报错留到实际写文件的时候再抛，那时才有上下文能说清。
    """
    from .log import warn

    # 顺手给独立服务留个路标。写不进去不算错 —— 它只是个提示，
    # 独立服务自己也会尝试推一遍。
    #
    # **但只在确认找到 ComfyUI 时才写。** 从真实路径跑的 python（插件是 junction
    # 挂进去的时候、或者单独跑测试的时候）推不出 ComfyUI，会算出兜底的 ~/M8 ——
    # 那不是 ComfyUI 该用的位置，把它写进路标反而会把正确的那份盖掉。踩过一次。
    try:
        if _models_dir() is not None:
            WEBAPP_DIR.mkdir(parents=True, exist_ok=True)
            DATA_POINTER_FILE.write_text(str(USER_DATA_DIR), encoding="utf-8")
    except OSError:
        pass

    for directory in (DATA_DIR, SKILLS_DIR, CACHE_DIR):
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            warn(f"建目录失败 {directory}：{exc}")


def is_inside(path: Path, parent: Path) -> bool:
    """path 是否在 parent 里（防目录穿越）。

    skills 的上传和删除都会用到：只允许操作 SKILLS_DIR 内部的路径。
    用 resolve() 之后再比，符号链接和 ../ 都会被展开。
    """
    try:
        path.resolve().relative_to(parent.resolve())
        return True
    except (ValueError, OSError):
        return False


def cred_file_mode() -> int:
    """密钥文件的权限位。Windows 上 chmod 基本无效，但仍设一个保守值。"""
    return 0o600 if os.name != "nt" else 0o600
