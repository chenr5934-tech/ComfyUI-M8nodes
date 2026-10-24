"""Constants used by the metadata collector"""

import os

# Metadata categories
MODELS = "models"
PROMPTS = "prompts"
SAMPLING = "sampling"
LORAS = "loras"
SIZE = "size"
IMAGES = "images"
IS_SAMPLER = "is_sampler"  # New constant to mark sampler nodes

# Complete list of categories to track
METADATA_CATEGORIES = [MODELS, PROMPTS, SAMPLING, LORAS, SIZE, IMAGES]

# 独立运行模式开关
STANDALONE_ENV_VAR = "LORA_MANAGER_STANDALONE"


def is_standalone_mode() -> bool:
    """是否处于独立运行模式（脱离 ComfyUI 的脚本化使用）。

    只认显式开关 LORA_MANAGER_STANDALONE=1。
    历史实现是
        LORA_MANAGER_STANDALONE == "1" or HF_HUB_DISABLE_TELEMETRY(默认 "0") == "0"
    后半段的缺省值就是 "0"，于是表达式恒为 True，元数据采集长期走 dummy 分支，
    SaveImagePlus / ModelNameExtractor 拿到的元数据永远是空的。反向条件已移除。
    """
    return os.environ.get(STANDALONE_ENV_VAR, "0").strip() == "1"
