# ComfyUI Danbooru Gallery 自定义节点集合

# 导入logger
from .py.utils.logger import get_logger
logger = get_logger(__name__)

# 初始化统计
import importlib
import time
import sys
_init_start_time = time.time()
_node_load_stats = {
    "total_modules": 0,
    "loaded_modules": 0,
    "failed_modules": 0,
    "total_nodes": 0,
    "errors": []
}

# 控制台输出（确保始终显示在ComfyUI控制台）
print("=" * 70, file=sys.stderr)
print("🚀 ComfyUI-Danbooru-Gallery 插件初始化开始...", file=sys.stderr)
print("=" * 70, file=sys.stderr)

# 同时记录到日志文件
logger.info("=" * 70)
logger.info("🚀 ComfyUI-Danbooru-Gallery 插件初始化开始...")
logger.info("=" * 70)

# 各节点模块清单：(模块名, 相对导入路径)
# 列表顺序 = 节点映射的合并顺序，不要随意调整
_NODE_MODULES = [
    ("danbooru_gallery", ".py.danbooru_gallery"),
    ("character_feature_swap", ".py.character_feature_swap"),
    ("prompt_selector", ".py.prompt_selector"),
    ("multi_character_editor", ".py.multi_character_editor"),
    ("resolution_master_simplify", ".py.resolution_master_simplify"),
    ("prompt_cleaning_maid", ".py.prompt_cleaning_maid"),
    ("simple_image_compare", ".py.simple_image_compare"),
    ("simple_checkpoint_loader_with_name", ".py.simple_checkpoint_loader_with_name"),
    ("simple_notify", ".py.simple_notify"),
    ("parameter_control_panel", ".py.parameter_control_panel"),
    ("parameter_break", ".py.parameter_break"),
    ("simple_load_image", ".py.simple_load_image"),
    ("simple_string_split", ".py.simple_string_split"),
    ("save_image_plus", ".py.save_image_plus"),
    ("simple_value_switch", ".py.simple_value_switch"),
    ("model_name_extractor", ".py.model_name_extractor"),
    ("enum_switch", ".py.enum_switch"),
    ("group_mute_manager", ".py.group_mute_manager"),
    ("group_ignore_manager", ".py.group_ignore_manager"),
    ("workflow_description", ".py.workflow_description"),
    ("quick_group_navigation", ".py.quick_group_navigation"),
    ("group_is_enabled", ".py.group_is_enabled"),
    ("vae_fix", ".py.vae_fix"),
]

# 逐个导入节点映射：单个模块失败（可选依赖缺失等）不再拖垮其余 20 个节点
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

_package_name = __package__ or __name__
_node_load_stats["total_modules"] = len(_NODE_MODULES)

for _module_name, _module_path in _NODE_MODULES:
    try:
        _module = importlib.import_module(_module_path, _package_name)
    except Exception as _exc:
        _node_load_stats["failed_modules"] += 1
        _node_load_stats["errors"].append({
            "module": _module_name,
            "error": f"{type(_exc).__name__}: {_exc}",
        })
        print(f"   ⚠️ 模块加载失败: {_module_name} ({type(_exc).__name__}: {_exc})", file=sys.stderr)
        logger.error(f"模块加载失败: {_module_name} ({type(_exc).__name__}: {_exc})")
        continue

    NODE_CLASS_MAPPINGS.update(getattr(_module, "NODE_CLASS_MAPPINGS", None) or {})
    NODE_DISPLAY_NAME_MAPPINGS.update(getattr(_module, "NODE_DISPLAY_NAME_MAPPINGS", None) or {})
    _node_load_stats["loaded_modules"] += 1

# 组是否启用节点还需要单独的状态同步函数（供下面的 API 使用）
try:
    from .py.group_is_enabled.group_is_enabled import update_all_group_states as gie_update_states
except Exception as _exc:
    gie_update_states = None
    print(f"   ⚠️ 组状态同步函数加载失败: {type(_exc).__name__}: {_exc}", file=sys.stderr)
    logger.error(f"组状态同步函数加载失败: {type(_exc).__name__}: {_exc}")

# 统计节点加载情况
_node_load_stats["total_nodes"] = len(NODE_CLASS_MAPPINGS)

# 控制台输出
print("=" * 70, file=sys.stderr)
print("✅ 节点加载完成:", file=sys.stderr)
print(f"   📦 成功加载模块: {_node_load_stats['loaded_modules']} 个", file=sys.stderr)
print(f"   🎯 成功注册节点: {_node_load_stats['total_nodes']} 个", file=sys.stderr)
if _node_load_stats["failed_modules"] > 0:
    print(f"   ❌ 失败模块: {_node_load_stats['failed_modules']} 个", file=sys.stderr)
    for error_info in _node_load_stats["errors"]:
        print(f"      - {error_info['module']}: {error_info['error']}", file=sys.stderr)
print("=" * 70, file=sys.stderr)

# 同时记录到日志文件
logger.info("=" * 70)
logger.info("✅ 节点加载完成:")
logger.info(f"   📦 成功加载模块: {_node_load_stats['loaded_modules']} 个")
logger.info(f"   🎯 成功注册节点: {_node_load_stats['total_nodes']} 个")
if _node_load_stats["failed_modules"] > 0:
    logger.error(f"   ❌ 失败模块: {_node_load_stats['failed_modules']} 个")
    for error_info in _node_load_stats["errors"]:
        logger.error(f"      - {error_info['module']}: {error_info['error']}")
logger.info("=" * 70)

# 设置JavaScript文件目录
# 前端并到插件的 js/gallery/ 下了 —— ComfyUI 的 WEB_DIRECTORY 只能声明在**插件根**，
# 货架里声明它没人读；而 "./js" 在这个目录下也不存在。给 None 让 ComfyUI 的
# `is not None` 检查直接跳过，免得以后有人以为这里还挂着一套前端。
WEB_DIRECTORY = None

# 注册 WebSocket 事件监听器
try:
    from server import PromptServer
    from aiohttp import web
    from .py.utils import debug_config
    from .py.utils import config
    import time

    # 导入 tag sync API 以注册API端点（可选功能）
    try:
        from .py.shared.sync import tag_sync_api
        logger.info("✓ Tag sync API 已加载")
    except (ImportError, ModuleNotFoundError):
        # Tag sync API 依赖 cache 模块，如果 cache 不可用则此功能不可用
        # 这不影响其他核心功能（如 SaveImagePlus）
        tag_sync_api = None

    # 导入并注册 checkpoint 预览图 API
    try:
        from .py.simple_checkpoint_loader_with_name import register_preview_api
        register_preview_api(PromptServer.instance.routes)
        logger.info("✓ Checkpoint预览图API已注册")
    except Exception as e:
        logger.warning(f" Checkpoint预览图API注册失败: {e}")

    @PromptServer.instance.routes.post("/danbooru/logs/batch")
    async def receive_js_logs(request):
        """
        接收前端JavaScript日志的API端点

        批量接收前端日志，写入到统一的logger系统中。
        """
        try:
            data = await request.json()
            logs = data.get("logs", [])

            # 逐条处理日志
            for log_entry in logs:
                level_str = log_entry.get("level", "INFO").upper()
                component = log_entry.get("component", "JS")
                message = log_entry.get("message", "")
                timestamp = log_entry.get("timestamp", "")
                browser = log_entry.get("browser", "Unknown")

                # 使用 JS/浏览器 作为 logger 名称，避免重复的方括号
                js_logger = get_logger(f"JS/{browser}")

                # 构建消息：[组件名] 实际消息内容（如果有）
                if message:
                    full_message = f"[{component}] {message}"
                else:
                    full_message = f"[{component}]"

                # 根据级别写入日志
                if level_str == "DEBUG":
                    js_logger.debug(full_message)
                elif level_str == "INFO":
                    js_logger.info(full_message)
                elif level_str == "WARNING":
                    js_logger.warning(full_message)
                elif level_str == "ERROR":
                    js_logger.error(full_message)
                elif level_str == "CRITICAL":
                    js_logger.critical(full_message)
                else:
                    js_logger.info(full_message)

            return web.json_response({
                "success": True,
                "received": len(logs)
            })
        except Exception as e:
            logger.error(f"接收JS日志失败: {e}")
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)

    @PromptServer.instance.routes.get("/danbooru_gallery/get_debug_config")
    async def get_debug_config(request):
        """获取debug配置的API端点"""
        try:
            config = debug_config.get_all_debug_config()
            return web.json_response({"status": "success", "debug": config})
        except Exception as e:
            return web.json_response({"status": "error", "error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/danbooru_gallery/update_debug_config")
    async def update_debug_config(request):
        """更新debug配置的API端点"""
        try:
            data = await request.json()
            new_config = data.get("debug", {})
            success = debug_config.save_config(new_config)
            if success:
                return web.json_response({"status": "success", "message": "配置已更新"})
            else:
                return web.json_response({"status": "error", "message": "配置更新失败"}, status=500)
        except Exception as e:
            return web.json_response({"status": "error", "error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/danbooru_gallery/get_sampler_node_types")
    async def get_sampler_node_types(request):
        """获取采样器节点类型列表的API端点"""
        try:
            sampler_types = config.get_sampler_node_types()
            return web.json_response({"status": "success", "sampler_node_types": sampler_types})
        except Exception as e:
            return web.json_response({"status": "error", "error": str(e)}, status=500)

    # 组是否启用节点 - 状态同步API
    @PromptServer.instance.routes.post("/danbooru_gallery/group_is_enabled/sync_states")
    async def sync_group_states(request):
        """同步组状态到后端缓存"""
        try:
            data = await request.json()
            states = data.get("states", {})

            # 输入验证
            if not isinstance(states, dict):
                return web.json_response({
                    "status": "error",
                    "message": "states 必须是字典类型"
                }, status=400)

            # 验证值类型
            for key, value in states.items():
                if not isinstance(key, str) or not isinstance(value, bool):
                    return web.json_response({
                        "status": "error",
                        "message": "states 格式无效: 键必须是字符串, 值必须是布尔值"
                    }, status=400)

            if gie_update_states is None:
                return web.json_response({
                    "status": "error",
                    "message": "组状态同步模块不可用"
                }, status=503)

            gie_update_states(states)

            logger.debug(f"[GroupIsEnabled] 已同步 {len(states)} 个组状态")

            return web.json_response({
                "status": "success",
                "count": len(states)
            })
        except Exception as e:
            logger.error(f"[GroupIsEnabled] 同步状态失败: {e}")
            return web.json_response({
                "status": "error",
                "message": str(e)
            }, status=500)

    # 工作流说明节点相关API路由
    import os
    import json

    # 设置文件路径
    WORKFLOW_DESCRIPTION_SETTINGS_FILE = os.path.join(
        os.path.dirname(__file__),
        "py",
        "workflow_description",
        "settings.json"
    )

    def load_workflow_description_settings():
        """加载工作流说明节点的设置文件"""
        try:
            if os.path.exists(WORKFLOW_DESCRIPTION_SETTINGS_FILE):
                with open(WORKFLOW_DESCRIPTION_SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            return {"opened_versions": {}}
        except Exception as e:
            logger.error(f"[WorkflowDescription] 加载设置失败: {e}")
            return {"opened_versions": {}}

    def save_workflow_description_settings(settings):
        """保存工作流说明节点的设置文件"""
        try:
            os.makedirs(os.path.dirname(WORKFLOW_DESCRIPTION_SETTINGS_FILE), exist_ok=True)
            with open(WORKFLOW_DESCRIPTION_SETTINGS_FILE, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            logger.error(f"[WorkflowDescription] 保存设置失败: {e}")
            return False

    @PromptServer.instance.routes.get("/workflow_description/get_settings")
    async def get_workflow_description_settings(request):
        """获取工作流说明节点的设置（已打开的版本记录）"""
        try:
            settings = load_workflow_description_settings()
            return web.json_response({
                "success": True,
                "opened_versions": settings.get("opened_versions", {})
            })
        except Exception as e:
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)

    @PromptServer.instance.routes.post("/workflow_description/save_settings")
    async def save_workflow_description_version(request):
        """保存已打开的版本到设置文件"""
        try:
            data = await request.json()
            node_id = data.get("node_id", "")
            version = data.get("version", "")

            if not node_id or not version:
                return web.json_response({
                    "success": False,
                    "error": "缺少node_id或version参数"
                }, status=400)

            # 加载现有设置
            settings = load_workflow_description_settings()
            opened_versions = settings.get("opened_versions", {})

            # 更新版本记录
            opened_versions[str(node_id)] = version
            settings["opened_versions"] = opened_versions

            # 保存设置
            success = save_workflow_description_settings(settings)

            if success:
                return web.json_response({
                    "success": True,
                    "node_id": node_id,
                    "version": version,
                    "message": "版本已记录"
                })
            else:
                return web.json_response({
                    "success": False,
                    "error": "保存设置失败"
                }, status=500)

        except Exception as e:
            return web.json_response({
                "success": False,
                "error": str(e)
            }, status=500)

    # API注册成功统计
    _api_count = 16  # 根据上面注册的API端点数量统计（已移除旧版外部编辑器集成与 fetch 模式相关的 API）

    # 控制台输出
    print("=" * 70, file=sys.stderr)
    print("✅ API端点注册完成:", file=sys.stderr)
    print(f"   🌐 成功注册API: {_api_count} 个 (含日志接收)", file=sys.stderr)
    print("=" * 70, file=sys.stderr)

    # 同时记录到日志文件
    logger.info("=" * 70)
    logger.info("✅ API端点注册完成:")
    logger.info(f"   🌐 成功注册API: {_api_count} 个 (含日志接收)")
    logger.info("=" * 70)

except ImportError as e:
    # ComfyUI 环境不可用时的静默处理
    print(f"⚠️ 无法初始化API路由 (ComfyUI环境不可用): {e}", file=sys.stderr)
    logger.warning(f"⚠️ 无法初始化API路由 (ComfyUI环境不可用): {e}")
    import traceback
    logger.debug(traceback.format_exc())
except Exception as e:
    # 捕获其他异常并输出到控制台和日志
    print(f"❌ API初始化失败: {e}", file=sys.stderr)
    logger.error(f"❌ API初始化失败: {e}")
    import traceback
    error_trace = traceback.format_exc()
    print(error_trace, file=sys.stderr)
    logger.error(error_trace)

# 输出最终初始化报告
_init_duration = time.time() - _init_start_time

# 控制台输出（确保在ComfyUI控制台可见）
print("=" * 70, file=sys.stderr)
print("🎉 ComfyUI-Danbooru-Gallery 插件初始化完成!", file=sys.stderr)
print(f"   ⏱️  初始化耗时: {_init_duration:.3f} 秒", file=sys.stderr)
print(f"   📦 已加载模块: {_node_load_stats['loaded_modules']} 个", file=sys.stderr)
print(f"   🎯 已注册节点: {_node_load_stats['total_nodes']} 个", file=sys.stderr)
if _node_load_stats["failed_modules"] > 0:
    print(f"   ❌ 失败模块: {_node_load_stats['failed_modules']} 个", file=sys.stderr)
print("=" * 70, file=sys.stderr)

# 同时记录到日志文件
logger.info("=" * 70)
logger.info("🎉 ComfyUI-Danbooru-Gallery 插件初始化完成!")
logger.info(f"   ⏱️  初始化耗时: {_init_duration:.3f} 秒")
logger.info(f"   📦 已加载模块: {_node_load_stats['loaded_modules']} 个")
logger.info(f"   🎯 已注册节点: {_node_load_stats['total_nodes']} 个")
if _node_load_stats["failed_modules"] > 0:
    logger.error(f"   ❌ 失败模块: {_node_load_stats['failed_modules']} 个")
logger.info("=" * 70)

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']
