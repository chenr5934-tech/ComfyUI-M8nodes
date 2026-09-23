"""配置与密钥。

两个文件，两种性质，别混：

  settings.json     全局设置，丢了无所谓，能重建
  credentials.json  供应商密钥，丢了要重新填 —— 写的时候小心，读的时候宽容

密钥的规矩（见 docs/ARCHITECTURE.md 第四节）：
  - 明文只在服务端出现，绝不回传给前端
  - 前端只能拿到 sk-****1234 这种掩码
  - 文件权限设 0600（Windows 上基本是形式，Linux 上真管用）

线程安全：ComfyUI 的 aiohttp 和节点执行可能在不同线程里同时读写，
所以这里加锁。粒度粗一点没关系 —— 这文件一年也写不了几次。
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

from . import paths
from .errors import M8Error
from .log import SHELF_CORE, log, warn

_LOCK = threading.RLock()

# 全局设置的默认值。用户改了之后只覆盖他改的那几项（深合并）。
DEFAULT_SETTINGS: dict[str, Any] = {
    "version": 1,
    "llm": {
        "default_base_url": "https://api.deepseek.com/v1",
        "default_provider": "deepseek",
        "default_timeout": 120,
        "default_max_tokens": 4096,
        "remember_models": True,
        "max_images": 4,
        "max_image_side": 1568,
        # 自动注入 skill 时的护栏：skill 多或长会吃上下文，超了要么截断要么不带
        "max_auto_skills": 10,
        "max_skill_chars": 8000,
    },
    # 小鲸鱼（界面扩展）的偏好。和节点无关，所以单独一段。
    "whale": {
        "enabled": True,          # 挂件是否显示
        "model": "",              # 空 = 用列表里的第一个
        "systemPrompt": "",
        "thinking": "关",
        "temperature": 1.0,
        "maxTokens": 4096,
        "timeout": 120,
        "refreshSeconds": 60,     # 余额自动刷新间隔
        "historyLimit": 20,       # 对话框带多少条历史
        "position": None,         # 挂件位置，None = 右下角默认位
        "dialogSize": None,       # 对话窗口尺寸
        # 下面这几个的默认值照抄原版：避让滚动条默认是关的（勾了才留白），
        # 音量默认 0.9，大小是 1.5 倍。
        "avoidScrollbar": False,
        "scrollbarWidth": 17,
        "volume": 0.9,
        "scale": 1.5,
        "peakMode": "default",    # 峰谷提示的说法：default / liangwen / qiangqiang
        "usageMode": "ledger",    # 用量来源。只有记账这一条路，见 usage.py 的说明
        "turnCostCloseMs": 5000,  # 和原版的「自动关闭 5 秒」对齐
    },
}


def _read_json(path, default: Any) -> Any:
    """读 JSON。文件不在或坏了都返回默认值，不抛。

    读的时候宽容：settings 坏了大不了重建，不该让插件起不来。
    """
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        warn(f"读取失败，改用默认值：{path.name}（{exc}）")
        return default
    return data if isinstance(data, type(default)) else default


def _write_json(path, data: Any, mode: int | None = None) -> None:
    """写 JSON。先写临时文件再替换 —— 中途崩了也不会留下半截文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    if mode is not None:
        try:
            os.chmod(path, mode)
        except OSError:
            pass  # Windows 上常失败，不影响使用


def _deep_merge(base: dict, override: dict) -> dict:
    """默认值 + 用户覆盖。只覆盖用户动过的那几项，加新默认值时老配置也跟着升级。"""
    result = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


# ---------------------------------------------------------------- 全局设置

def load_settings() -> dict[str, Any]:
    """读全局设置，缺的项用默认值补齐。"""
    with _LOCK:
        stored = _read_json(paths.SETTINGS_FILE, {})
        return _deep_merge(DEFAULT_SETTINGS, stored)


def save_settings(patch: dict[str, Any]) -> dict[str, Any]:
    """合并式保存。传 {"llm": {"default_timeout": 300}} 只改这一项。"""
    with _LOCK:
        merged = _deep_merge(load_settings(), patch)
        try:
            _write_json(paths.SETTINGS_FILE, merged)
        except OSError as exc:
            raise M8Error("M8-CORE-004", detail=str(exc)) from exc
        return merged


def get_setting(path: str, default: Any = None) -> Any:
    """点号取设置项：get_setting("llm.default_timeout")。"""
    node: Any = load_settings()
    for part in path.split("."):
        if not isinstance(node, dict) or part not in node:
            return default
        node = node[part]
    return node


# ---------------------------------------------------------------- 密钥

def _load_credentials() -> dict[str, Any]:
    data = _read_json(paths.CREDENTIALS_FILE, {})
    if "providers" not in data or not isinstance(data["providers"], dict):
        data["providers"] = {}
    return data


def mask_key(key: str) -> str:
    """sk-abcdef...wxyz -> sk-****wxyz。

    短于 8 位的直接全遮 —— 露出来的部分比遮住的还多就没意义了。
    """
    key = (key or "").strip()
    if not key:
        return ""
    if len(key) < 8:
        return "*" * len(key)
    # 露出前三个字符，但整段都是符号时就不露（免得出现 "****abcd" 这种没信息的前缀）
    prefix = key[:3]
    head = prefix if any(ch.isalnum() for ch in prefix) else ""
    return f"{head}****{key[-4:]}"


def get_api_key(provider: str) -> str:
    """取某个供应商的密钥明文。只在服务端内部调用。"""
    with _LOCK:
        entries = _load_credentials().get("providers", {})
        entry = entries.get(provider) or {}
        return str(entry.get("api_key") or "")


def set_api_key(provider: str, key: str, base_url: str = "") -> str:
    """存密钥，返回掩码（给前端显示用）。

    base_url 是**一起记下**的接口地址：用户把 DeepSeek 的密钥配上自己的中转
    地址，那就是这份密钥归哪个地址用。以后只有请求发往这个地址时才把密钥附上。
    """
    key = (key or "").strip()
    with _LOCK:
        data = _load_credentials()
        if key:
            data["providers"][provider] = {
                "api_key": key,
                "base_url": str(base_url or "").strip(),
                "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            }
        else:
            data["providers"].pop(provider, None)
        try:
            _write_json(paths.CREDENTIALS_FILE, data, mode=paths.cred_file_mode())
        except OSError as exc:
            raise M8Error("M8-CORE-004", message="密钥写不进磁盘", detail=str(exc)) from exc
        log(f"密钥已{'保存' if key else '清除'}：{provider} -> {mask_key(key) or '（空）'}", SHELF_CORE)
        return mask_key(key)


def list_credentials() -> dict[str, str]:
    """所有供应商的密钥掩码。这个形状可以直接回给前端。"""
    with _LOCK:
        entries = _load_credentials().get("providers", {})
        return {name: mask_key(str(item.get("api_key") or "")) for name, item in entries.items()}


def _norm_url(raw: str) -> str:
    """比地址用的归一形式：去空白、去尾斜杠、转小写。"""
    return str(raw or "").strip().rstrip("/").lower()


def saved_base_url(provider: str) -> str:
    """存这份密钥时一起记下的接口地址。没记过就是空串。"""
    with _LOCK:
        entries = _load_credentials().get("providers", {}) or {}
        entry = entries.get(provider) or {}
        return str(entry.get("base_url") or "")


def resolve_api_key(
    node_key: str,
    provider: str,
    target_url: str,
    allowed_urls: tuple[str, ...],
) -> str:
    """节点上填的优先，留空就用服务端存的 —— 但**只在目标地址可信时**。

    这是「工作流文件里不带明文」那条规矩的落地：用户把密钥存在服务端，
    节点上的输入框留空，分享工作流就不会泄漏。

    **但不是无条件地交出去。** 任何能访问 ComfyUI 的页面都能调这些接口，而
    base_url 是调用方说了算的 —— 只管把存着的密钥填进去、再把请求发到调用方
    给的地址，就等于开了一个「把用户密钥寄到任意地方」的口子。分享出去的工作流
    也一样：里面带一个指向别人服务器的 base_url、密钥留空，一跑密钥就跟着走了。

    所以只有当 target_url 和这个供应商的默认地址（或存密钥时一起记下的那个
    地址）对得上时，才把密钥附上。对不上就当没存过 —— 请求照发，只是不带认证。

    **target_url 和 allowed_urls 是必填的**，不给默认值。原因很实际：第一版
    给了默认空串，结果漏改了一个调用方（小鲸鱼的对话），它拿不到密钥、表现是
    「没配密钥」，报错信息完全指不到真正的原因。必填的话漏传当场 TypeError。
    """
    node_key = (node_key or "").strip()
    if node_key:
        return node_key          # 用户自己填的，那就是他自己要用的，直接给

    stored = get_api_key(provider)
    if not stored:
        return ""

    want = _norm_url(target_url)
    allowed = {_norm_url(u) for u in allowed_urls if u}
    if want and want in allowed:
        return stored
    return ""
