"""M8 日志。

一件事：所有输出都带 [M8][货架] 前缀，方便在 ComfyUI 控制台里 grep。

    [M8][LLM] 拉取模型列表：https://api.deepseek.com/v1/models

搜 [M8] 能看到本插件的全部动作流水（含别的插件在一起时的噪声过滤）。
搜 [M8][LLM] 就只看大模型货架的事。

不引 logging：ComfyUI 自己的日志格式各家整合包不一样（秋叶包改过），
print 到 stdout 反而是最稳的，控制台一定看得到。
"""

from __future__ import annotations

import sys

# 货架码，和 docs/ROADMAP.md 的货架总表对应
SHELF_CORE = "CORE"
SHELF_SRV = "SRV"
SHELF_LLM = "LLM"
SHELF_LOAD = "LOAD"
SHELF_SAMP = "SAMP"
SHELF_LOGIC = "LOGIC"
SHELF_IMG = "IMG"
SHELF_TXT = "TXT"
SHELF_UTIL = "UTIL"
SHELF_UI = "UI"
SHELF_CAM = "CAM"
SHELF_PROMPT = "PROMPT"
SHELF_WEB = "WEB"


def log(message: str, shelf: str = SHELF_CORE) -> None:
    """正常信息。"""
    _emit("INFO", shelf, message)


def warn(message: str, shelf: str = SHELF_CORE) -> None:
    """可疑但不致命。"""
    _emit("WARN", shelf, message)


def error(message: str, shelf: str = SHELF_CORE) -> None:
    """出错了。注意：记日志不等于处理错误，该抛的 M8Error 还是要抛。"""
    _emit("ERROR", shelf, message)


def _emit(level: str, shelf: str, message: str) -> None:
    prefix = f"[M8][{shelf}]"
    text = f"{prefix} {message}" if level == "INFO" else f"{prefix} [{level}] {message}"
    print(text, flush=True)


def banner(version: str, shelves: list[str], node_count: int, route_count: int) -> None:
    """启动横幅。一眼看出插件加载了没有、加载了几个货架。"""
    print("", flush=True)
    line = "=" * 58
    print(line, flush=True)
    print(f"  M8 节点包 v{version}", flush=True)
    print(f"  货架：{', '.join(shelves) if shelves else '（无）'}", flush=True)
    print(f"  节点 {node_count} 个 / 接口 {route_count} 条", flush=True)
    print(line, flush=True)
    print("", flush=True)
