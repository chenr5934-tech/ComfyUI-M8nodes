import traceback

from ..utils.logger import get_logger
from .constants import is_standalone_mode

# 初始化logger
logger = get_logger(__name__)

# 是否独立运行 —— 只由显式开关 LORA_MANAGER_STANDALONE=1 决定
standalone_mode = is_standalone_mode()

# 真实实现是否可用：standalone 或导入失败时为 False，此时降级为 dummy
_real_available = False
_degrade_reason = ""

if standalone_mode:
    _degrade_reason = "standalone mode (LORA_MANAGER_STANDALONE=1)"
else:
    try:
        from .metadata_hook import MetadataHook
        from .metadata_registry import MetadataRegistry
        from ..utils.config import is_sampler_node

        _real_available = True
    except Exception as e:
        # 不再静默降级：缺 ComfyUI 核心模块（如 nodes）时记错误+堆栈
        _degrade_reason = f"import failure: {type(e).__name__}: {e}"
        logger.error(f"[MetadataCollector] 真实实现导入失败，降级为 dummy: {type(e).__name__}: {e}")
        logger.error(traceback.format_exc())


if _real_available:

    def init():
        """Install hooks to collect metadata during execution"""
        MetadataHook.install()

        # 触发单例构造，确保 registry 可用
        MetadataRegistry()

        logger.info("ComfyUI Metadata Collector initialized")

    def get_metadata(prompt_id=None):
        """Helper function to get metadata from the registry"""
        registry = MetadataRegistry()
        return registry.get_metadata(prompt_id)

    # 导出 MetadataHook 以便 py/__init__.py 可以导入
    __all__ = ['MetadataHook', 'MetadataRegistry', 'init', 'get_metadata', 'is_sampler_node']

else:
    logger.info(f"[MetadataCollector] 使用 dummy 实现（{_degrade_reason}）")

    # Dummy implementations（standalone 模式或真实实现导入失败）
    class MetadataHook:
        """Dummy MetadataHook"""

        @staticmethod
        def install():
            pass

    def init():
        logger.warning(f"[MetadataCollector] 元数据采集未启用（{_degrade_reason}）")

    def get_metadata(prompt_id=None):
        """Dummy implementation"""
        return {}

    def is_sampler_node(class_type):
        """Dummy implementation"""
        return False

    __all__ = ['MetadataHook', 'init', 'get_metadata', 'is_sampler_node']
