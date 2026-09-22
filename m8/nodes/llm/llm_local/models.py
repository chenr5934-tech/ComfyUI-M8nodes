"""M8 · 本地大模型 —— 模型发现与加载。

两件事：把 models/LLM 这个目录登记给 ComfyUI，以及把 GGUF 加载起来（带缓存）。

**路径一个字都不写死。** 目录是从 ComfyUI 自己的 folder_paths.models_dir 推出来的，
所以别人装在 D 盘 E 盘、用 extra_model_paths.yaml 改过位置，都跟得上。

**为什么要有缓存**：GGUF 加载一次要一两秒到十几秒，工作流每跑一次就重载的话
根本没法用。所以同一份模型常驻内存，换模型才把旧的放掉。
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import Any

from ....core.errors import M8Error
from ....core.log import SHELF_LLM, log, warn

# ComfyUI 注册模型类型用的名字。别的插件（比如 comfyUI-llama-TE）也用 "LLM"，
# 撞上了没关系 —— folder_paths 对同一个类型只记一次目录，谁先注册谁算。
FOLDER = "LLM"

# 只认这些后缀。GGUF 是 llama.cpp 的格式，也是这里唯一支持的东西。
GGUF_SUFFIXES = {".gguf"}

_LOCK = threading.RLock()
_LLAMA = None
_LLAMA_ERROR: Exception | None = None
# 缓存：键是 (模型绝对路径, mmproj 绝对路径 or "", 上下文长度, gpu 层数)
_CACHE: dict[tuple, Any] = {}


def ensure_folder_registered() -> str:
    """把 models/LLM 登记成 ComfyUI 的模型类型，返回它的绝对路径。

    登记之后 ComfyUI 自己会扫这个目录，用户也能在 extra_model_paths.yaml 里
    再挂别的目录过来 —— 那正是「不写死路径」的意义。
    """
    import folder_paths  # 只有 ComfyUI 里才有

    root = Path(folder_paths.models_dir) / FOLDER
    try:
        if FOLDER not in folder_paths.folder_names_and_paths:
            folder_paths.folder_names_and_paths[FOLDER] = ([str(root)], set(GGUF_SUFFIXES))
        else:
            paths, exts = folder_paths.folder_names_and_paths[FOLDER]
            # 保证我们的目录在列表里，并且 .gguf 在允许的后缀里 ——
            # 别的插件可能先注册过，后缀集合不一定带 gguf。
            if str(root) not in paths:
                paths.append(str(root))
            folder_paths.folder_names_and_paths[FOLDER] = (paths, set(exts) | GGUF_SUFFIXES)
    except Exception as exc:  # 不同 ComfyUI 版本这结构可能有出入，不该因此起不来
        warn(f"登记 {FOLDER} 模型目录失败：{type(exc).__name__}: {exc}", SHELF_LLM)
    return str(root)


def _all_gguf() -> list[str]:
    """所有可选的 gguf 文件名（相对路径）。扫不出来就给空列表，不抛。"""
    ensure_folder_registered()
    try:
        import folder_paths

        files = folder_paths.get_filename_list(FOLDER)
    except Exception:
        return []
    return sorted(f for f in files if Path(f).suffix.lower() in GGUF_SUFFIXES)


def is_mmproj(name: str) -> bool:
    """名字里带 mmproj 的就是多模态投影文件，不该出现在主模型下拉里。"""
    return "mmproj" in str(name).lower()


def list_models() -> list[str]:
    """主模型列表（不含 mmproj）。"""
    return [f for f in _all_gguf() if not is_mmproj(f)]


def list_mmproj() -> list[str]:
    """多模态投影文件列表。"""
    return [f for f in _all_gguf() if is_mmproj(f)]


def _invalidate_cache() -> None:
    """把 ComfyUI 的模型文件名缓存清掉，强制下一次全扫目录。

    实测：folder_paths.get_filename_list 那层缓存本身带 mtime 校验（根目录和每个
    已知子目录都查一遍），往 models/LLM 里新丢一个 .gguf 是会被发现的，不用重启
    ComfyUI。这里再清一次是为了「刷新」按钮的语义 —— 用户按下去就是明确要求重扫，
    不该再有第二次猜测的余地。

    特殊情形：ComfyUI 执行工作流时会把 cache_helper 打开（server.py 里的
    with folder_paths.cache_helper），那期间不动它，免得打断它自己的一次一致读。
    """
    try:
        import folder_paths

        folder_paths.filename_list_cache.pop(FOLDER, None)
        helper = getattr(folder_paths, "cache_helper", None)
        if helper is not None and not getattr(helper, "active", False):
            helper.clear()
    except Exception:
        pass


def refresh() -> tuple[list[str], list[str]]:
    """强制重扫目录，返回（主模型列表, mmproj 列表）。

    只给 HTTP 那个刷新接口用。节点自己走 list_models —— 那里不该每次都全扫盘。
    """
    _invalidate_cache()
    return list_models(), list_mmproj()


def _full_path(name: str) -> Path:
    """把下拉里那个名字还原成绝对路径。"""
    import folder_paths

    got = folder_paths.get_full_path(FOLDER, name)
    if not got:
        raise M8Error(
            "M8-LLM-014",
            message="找不到这个模型文件",
            hint=f"确认它在 {Path(folder_paths.models_dir) / FOLDER} 里，或者在 extra_model_paths.yaml 里挂对了",
            detail=str(name),
        )
    return Path(got)


# 分片模型：xxx-00001-of-00003.gguf 只要喂第一片，llama.cpp 自己会接上其余的
_SHARD = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.IGNORECASE)


def _shard_group(name: str) -> str | None:
    """给一个分片文件名，返回同组其他分片的公共前缀；不是分片就返回 None。"""
    m = _SHARD.search(name)
    return name[: m.start()] if m else None


# 参数规模：9B / 4B / 1.5B 这种。同系列不同大小的 mmproj 名字几乎一模一样，
# 只有这个数字分得开，所以要单独留出来当一条判据（9b 只有两字符，会被词的
# 长度下限滤掉，那是之前配错的原因）。
_SIZE = re.compile(r"(\d+(?:\.\d+)?)\s*b(?![a-z0-9])", re.IGNORECASE)


def _dir_of(name: str) -> str:
    """相对路径里的目录部分，统一成 / 分隔的小写。直接在根目录下就返回空串。"""
    return str(Path(name).parent).replace("\\", "/").lower()


def _base_of(name: str) -> str:
    """只要文件名，去掉扩展名，小写。"""
    return Path(name).stem.lower()


def pick_mmproj(model_name: str) -> str | None:
    """给主模型自动配一个 mmproj：从盘上现有的候选里挑。"""
    return _pick_from(list_mmproj(), model_name)


def _pick_from(cands: list[str], model_name: str) -> str | None:
    """从给定候选里挑一个配给 model_name。

    和前端 llm_local.js 的 autoPickMmproj 是同一套规则，改一边必须改另一边 ——
    tests/mmproj_cases.json 里那批用例两边都跑，不一致会当场红。

    配对规则（从强到弱）：
      1. 同一个目录里的 —— 主模型和 mmproj 放一起是最常见的排布，也最不容易配错
      2. 名字里有共同特征词的，参数规模（9b / 4b）也当一个词算
      3. 候选只剩一个的话就用它
      4. 都对不上就返回 None —— 纯文本也能跑，只是没有识图
    """
    if not cands:
        return None

    # 1. 同目录优先。qwen3.5-9b 里的主模型，先看 qwen3.5-9b 里有没有 mmproj。
    pool = [c for c in cands if _dir_of(c) == _dir_of(model_name)] or cands
    if len(pool) == 1:
        return pool[0]

    # 2. 特征词 + 规模数字。长度 >=3 的实词都要，短的只放行规模（9b / 4b）——
    #    其余的 q4、k、m 是量化噪声，放进来只会互相干扰。
    parts = [w for w in re.split(r"[-_. ]+", _base_of(model_name)) if w]
    words = [
        w for w in parts
        if (len(w) >= 3 and not w.isdigit()) or _SIZE.fullmatch(w)
    ]
    best = None
    best_score = 0
    for c in pool:
        low = _base_of(c)
        score = sum(1 for w in words if w in low)
        if score > best_score:
            best, best_score = c, score
    return best


def _load_llama():
    """把 llama_cpp 导进来。导不进来就记下原因，让节点报一句人话。

    **import 之前先把 Windows 的 DLL 目录理好**：llama_cpp 自带的 lib 目录里
    有它要的运行时，不显式加进搜索路径的话，在 ComfyUI 里（torch 已经把
    一堆 DLL 拉进来了）容易撞上找不到或者版本打架。
    """
    global _LLAMA, _LLAMA_ERROR
    if _LLAMA is not None:
        return _LLAMA
    if _LLAMA_ERROR is not None:
        raise M8Error(
            "M8-LLM-015",
            message="本地推理的依赖用不了",
            hint="在 ComfyUI 的 python 里装一份：pip install llama-cpp-python",
            detail=f"{type(_LLAMA_ERROR).__name__}: {_LLAMA_ERROR}",
        )

    if os.name == "nt":
        try:
            import llama_cpp as _pkg

            for sub in ("lib", "bin"):
                d = Path(_pkg.__file__).parent / sub
                if d.is_dir() and hasattr(os, "add_dll_directory"):
                    os.add_dll_directory(str(d))
        except Exception:
            pass

    try:
        import llama_cpp

        _LLAMA = llama_cpp
        return _LLAMA
    except Exception as exc:
        _LLAMA_ERROR = exc
        raise M8Error(
            "M8-LLM-015",
            message="本地推理的依赖用不了",
            hint="在 ComfyUI 的 python 里装一份：pip install llama-cpp-python",
            detail=f"{type(exc).__name__}: {exc}",
        ) from exc


def gpu_offload_available() -> bool | None:
    """这个 llama_cpp 构建能不能把层丢给显卡。不知道就返回 None。"""
    try:
        pkg = _load_llama()
    except M8Error:
        return None
    fn = getattr(pkg, "llama_supports_gpu_offload", None)
    if not callable(fn):
        return None
    try:
        return bool(fn())
    except Exception:
        return None


def make_chat_handler(mmproj_path: str | None, *, thinking: bool):
    """造一个多模态聊天处理器。没有 mmproj 就返回 None（纯文本）。

    这里要绕两个弯，都是版本差异：
      · 有的版本参数叫 mmproj_path，有的叫 clip_model_path；
      · enable_thinking / add_vision_id 这些不一定每个版本都有。
    两个都靠「先试一个、不行换下一个」，不猜版本号。
    """
    if not mmproj_path:
        return None
    try:
        from llama_cpp.llama_chat_format import Qwen35ChatHandler
    except Exception:
        Qwen35ChatHandler = None

    if Qwen35ChatHandler is None:
        raise M8Error(
            "M8-LLM-016",
            message="这份 llama-cpp-python 不认识这个多模态模型",
            hint="升级一下：pip install -U llama-cpp-python",
            detail="没有 Qwen35ChatHandler",
        )

    # 先定「用哪个参数名收 mmproj」
    attempts = [
        {"mmproj_path": mmproj_path},
        {"clip_model_path": mmproj_path},
    ]
    handler = None
    last: Exception | None = None
    for kw in attempts:
        for extra in (
            {"enable_thinking": thinking, "add_vision_id": True, "verbose": False},
            {"enable_thinking": thinking, "verbose": False},
            {"verbose": False},
        ):
            try:
                handler = Qwen35ChatHandler(**kw, **extra)
                break
            except TypeError as exc:
                last = exc
                continue
        if handler is not None:
            break
    if handler is None:
        raise M8Error(
            "M8-LLM-016",
            message="多模态处理器建不起来",
            hint="升级 llama-cpp-python 再试",
            detail=f"{type(last).__name__}: {last}",
        ) from last
    return handler


def load(model_name: str, mmproj_name: str | None, *, ctx: int, gpu_layers: int, thinking: bool):
    """加载模型，同一份配置第二次调用直接给缓存里的那个。

    返回值是 (llama 实例, 这次是不是复用了缓存)。
    """
    pkg = _load_llama()
    model_path = str(_full_path(model_name))
    mm_path = str(_full_path(mmproj_name)) if mmproj_name else ""
    key = (model_path, mm_path, int(ctx), int(gpu_layers), bool(thinking))

    with _LOCK:
        got = _CACHE.get(key)
        if got is not None:
            return got, True

        # 换配置了就把旧的放掉 —— 显存和内存都只有一份，留着会 OOM
        for k in list(_CACHE):
            try:
                _CACHE[k].close()
            except Exception:
                pass
            _CACHE.pop(k, None)

        handler = make_chat_handler(mm_path or None, thinking=thinking)
        kwargs: dict[str, Any] = {
            "model_path": model_path,
            "n_ctx": int(ctx),
            "n_gpu_layers": int(gpu_layers),
            "verbose": False,
        }
        if handler is not None:
            kwargs["chat_handler"] = handler

        try:
            llm = pkg.Llama(**kwargs)
        except Exception as exc:
            raise M8Error(
                "M8-LLM-017",
                message="这个模型加载不起来",
                hint="确认它是完整的 GGUF、没在下载中、也没被别的程序占着",
                detail=f"{type(exc).__name__}: {exc}",
            ) from exc

        _CACHE[key] = llm
        log(f"加载了本地模型：{Path(model_name).name}"
            + (f" + {Path(mmproj_name).name}" if mmproj_name else "（纯文本）")
            + f"，上下文 {ctx}，GPU 层 {gpu_layers}", SHELF_LLM)
        return llm, False


def unload_all() -> int:
    """把缓存里的模型全放掉。返回放了几个。"""
    with _LOCK:
        n = len(_CACHE)
        for k in list(_CACHE):
            try:
                _CACHE[k].close()
            except Exception:
                pass
            _CACHE.pop(k, None)
        return n


def cached_count() -> int:
    with _LOCK:
        return len(_CACHE)
