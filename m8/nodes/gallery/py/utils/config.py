"""
通用配置管理模块
统一管理所有组件的配置项
"""

import json
import os
import tempfile
from typing import Any, List
from pathlib import Path

# Logger导入
from .logger import get_logger
logger = get_logger(__name__)

# 插件根目录（本文件在 py/utils/ 下，向上三级：py/utils -> py -> 插件根）
# 与 py/utils/logger.py 的 PLUGIN_ROOT、py/utils/config_manager.py 的 plugin_root 同一口径
PLUGIN_ROOT = Path(__file__).resolve().parent.parent.parent

# 配置文件路径（指向项目根目录的config.json）
CONFIG_FILE = str(PLUGIN_ROOT / "config.json")

# 全局配置缓存
_config_cache: dict[str, Any] = {}


def load_config() -> dict[str, Any]:
    """加载完整配置文件"""
    global _config_cache

    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                _config_cache = json.load(f)
                return _config_cache
        else:
            # 如果配置文件不存在，返回空字典
            _config_cache = {}
            return _config_cache
    except Exception as e:
        logger.error(f"加载配置文件失败: {str(e)}")
        _config_cache = {}
        return _config_cache


def get_config(key: str, default: Any = None) -> Any:
    """
    获取指定配置项

    Args:
        key: 配置项键名
        default: 默认值

    Returns:
        配置值，如果不存在则返回默认值
    """
    # 如果缓存为空，先加载配置
    if not _config_cache:
        load_config()

    return _config_cache.get(key, default)


def get_sampler_node_types() -> List[str]:
    """
    获取采样器节点类型列表

    Returns:
        采样器节点类型列表
    """
    # 默认的采样器节点类型
    default_types = [
        "KSampler",
        "KSamplerAdvanced",
        "PixelKSampleUpscalerProvider",
        "PixelKSampleUpscalerSharpening",
        "SamplerCustom",
        "SamplerCustomAdvanced"
    ]

    return get_config("sampler_node_types", default_types)


def is_sampler_node(class_type: str) -> bool:
    """
    判断节点类型是否是主采样器节点

    这个函数用于组执行管理器判断后续组是否有采样器，以决定是否需要激进模式清理。
    也用于元数据收集器标识采样器节点。

    Args:
        class_type: 节点的类名

    Returns:
        bool: 如果是主采样器返回True，否则返回False
    """
    sampler_types = get_sampler_node_types()
    return class_type in sampler_types


def atomic_write_json(path: str, payload: Any) -> None:
    """
    原子写 JSON 文件：先整体序列化到内存，再写同目录临时文件，最后 os.replace 替换。

    任何一步失败都会抛异常，且目标文件保持原样——读方永远看不到半截 JSON，
    序列化失败也不会把已有配置截断。

    Args:
        path: 目标文件路径
        payload: 要写入的数据

    Raises:
        Exception: 序列化失败或磁盘写入失败时原样抛出
    """
    # 先序列化：不可序列化的 payload 在这里就失败，磁盘上什么都没动
    text = json.dumps(payload, indent=2, ensure_ascii=False)

    # 临时文件必须和目标同目录，os.replace 才是同文件系统内的原子替换
    target_dir = os.path.dirname(os.path.abspath(path)) or "."
    fd, temp_path = tempfile.mkstemp(prefix=".config-", suffix=".tmp", dir=target_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, path)
    except BaseException:
        # 失败时清掉临时文件，目标文件不动
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


def save_config(config: dict[str, Any]) -> bool:
    """
    保存配置文件

    Args:
        config: 完整配置字典

    Returns:
        是否保存成功
    """
    global _config_cache

    try:
        # 原子写入项目根 config.json（失败时原文件不受影响）
        atomic_write_json(CONFIG_FILE, config)

        # 更新缓存
        _config_cache = config

        logger.info(f"配置已保存")
        return True
    except Exception as e:
        logger.error(f"保存配置文件失败: {str(e)}")
        return False


# 初始化时加载配置
load_config()
