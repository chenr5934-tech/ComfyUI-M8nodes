"""
Tag sync API - Simple background sync with global toast integration
"""

import asyncio
import json
from pathlib import Path
from aiohttp import web
from server import PromptServer
from ...utils.logger import get_logger

logger = get_logger(__name__)

# Load config
def load_config():
    """读取项目根 config.json 里的标签同步调试开关

    优先看 tag_sync.debug（config.json 的真实结构），
    其次兼容 logging.components.tag_sync == "DEBUG"。
    旧实现读的是 config['debug']['tag_sync']，而 config.json 里从来没有
    debug 段，这个开关恒为 False。
    """
    try:
        config_path = Path(__file__).parent.parent.parent.parent / "config.json"
        if config_path.exists():
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)

            tag_sync_section = config.get('tag_sync')
            if isinstance(tag_sync_section, dict) and tag_sync_section.get('debug'):
                return True

            components = config.get('logging', {}).get('components', {})
            if isinstance(components, dict):
                return str(components.get('tag_sync', '')).strip().upper() == 'DEBUG'
    except Exception as e:
        logger.error(f"[标签同步] 加载配置失败: {e}")
    return False

DEBUG_MODE = load_config()

# Import background sync manager
try:
    from .. import get_background_sync_manager, SyncStatus
    SYNC_AVAILABLE = True
    if DEBUG_MODE:
        logger.info("[标签同步] 后台同步系统已加载 (调试模式: 开启)")
    else:
        logger.info("[标签同步] 后台同步系统已加载")
except ImportError as e:
    logger.warning(f"[标签同步] 后台同步系统不可用: {e}")
    SYNC_AVAILABLE = False


def send_toast(message, toast_type="info", duration=3000):
    """
    Send toast message to frontend via WebSocket
    使用 globalToastManager 在页面上方显示堆叠的 toast
    用于重要提示（完成、失败、警告等）

    Args:
        message: Toast message text
        toast_type: 'success', 'error', 'info', 'warning'
        duration: Display duration in milliseconds (0 means persistent)
    """
    try:
        PromptServer.instance.send_sync("tag_sync_toast", {
            "message": message,
            "type": toast_type,
            "duration": duration
        })
    except Exception as e:
        logger.error(f"[标签同步] 发送 Toast 通知失败: {e}")


def send_status_show(message):
    """
    显示右上角持久化状态栏（与组执行管理器兼容堆叠）

    Args:
        message: 状态消息
    """
    try:
        PromptServer.instance.send_sync("tag_sync_status_show", {
            "message": message
        })
    except Exception as e:
        logger.error(f"[标签同步] 发送状态栏显示失败: {e}")


def send_status_update(message):
    """
    更新右上角持久化状态栏

    Args:
        message: 状态消息
    """
    try:
        PromptServer.instance.send_sync("tag_sync_status_update", {
            "message": message
        })
    except Exception as e:
        logger.error(f"[标签同步] 发送状态栏更新失败: {e}")


def send_status_hide():
    """
    隐藏右上角持久化状态栏
    """
    try:
        PromptServer.instance.send_sync("tag_sync_status_hide", {})
    except Exception as e:
        logger.error(f"[标签同步] 发送状态栏隐藏失败: {e}")


# ========================================
# Progress Callback for Background Sync
# ========================================

def progress_callback(progress_dict):
    """
    Handle progress updates from background sync
    使用右上角持久化状态栏显示进度（与组执行管理器兼容堆叠）

    Args:
        progress_dict: Progress data dictionary
    """
    try:
        status = progress_dict.get('status')
        current_task = progress_dict.get('current_task', '')
        progress = progress_dict.get('progress', 0)
        current_page = progress_dict.get('current_page', 0)
        estimated_pages = progress_dict.get('estimated_pages', 0)
        fetched_tags = progress_dict.get('fetched_tags', 0)
        error_message = progress_dict.get('error_message', '')

        # Log progress update (for debugging)
        if DEBUG_MODE:
            logger.info(f"[标签同步进度] {status}: {current_task} ({int(progress*100)}%)")

        # Build progress message (current_task already contains page info if available)
        progress_msg = f"📦 标签同步: {current_task} ({int(progress*100)}%)"

        if status in ['initializing', 'fetching', 'translating', 'saving']:
            # 首次显示或更新进度
            if progress == 0 or status == 'initializing':
                # 首次显示状态栏
                send_status_show(progress_msg)
            else:
                # 更新状态栏
                send_status_update(progress_msg)

        # Handle completion
        elif status == 'completed':
            # 隐藏状态栏
            send_status_hide()
            # 使用toast显示完成消息
            send_toast("✅ 标签同步完成！", "success", 3000)

        elif status == 'failed':
            # 隐藏状态栏
            send_status_hide()
            # 使用toast显示错误消息
            error_msg = error_message or "同步失败"
            send_toast(f"❌ {error_msg}", "error", 5000)

        elif status == 'cancelled':
            # 隐藏状态栏
            send_status_hide()
            # 使用toast显示取消消息
            send_toast("⚠️ 同步已取消", "warning", 3000)

    except Exception as e:
        logger.error(f"[标签同步] 进度回调错误: {e}")
        import traceback
        traceback.print_exc()


# ========================================
# API Endpoints
# ========================================

@PromptServer.instance.routes.post("/danbooru_gallery/sync_start")
async def start_sync(request):
    """Start background tag synchronization"""
    try:
        if not SYNC_AVAILABLE:
            return web.json_response({
                "success": False,
                "error": "Sync system not available"
            })

        # Get sync mode
        data = await request.json() if request.body_exists else {}
        sync_mode = data.get('mode', 'auto')

        # Get background sync manager
        bg_manager = get_background_sync_manager()

        # Check if already running
        if bg_manager.is_running():
            return web.json_response({
                "success": False,
                "error": "Synchronization already running"
            })

        # Start sync
        success = bg_manager.start_sync(sync_mode)

        if success:
            send_toast("开始同步标签数据...", "info", 2000)
            return web.json_response({
                "success": True,
                "mode": sync_mode
            })
        else:
            return web.json_response({
                "success": False,
                "error": "Failed to start synchronization"
            })

    except Exception as e:
        logger.error(f"[标签同步] 启动同步失败: {e}")
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.post("/danbooru_gallery/sync_cancel")
async def cancel_sync(request):
    """Cancel running synchronization"""
    try:
        if not SYNC_AVAILABLE:
            return web.json_response({
                "success": False,
                "error": "Sync system not available"
            })

        bg_manager = get_background_sync_manager()

        if not bg_manager.is_running():
            return web.json_response({
                "success": False,
                "error": "No synchronization is running"
            })

        bg_manager.cancel_sync()

        return web.json_response({
            "success": True,
            "message": "Cancellation requested"
        })

    except Exception as e:
        logger.error(f"[标签同步] 取消同步失败: {e}")
        return web.json_response({"success": False, "error": str(e)})


@PromptServer.instance.routes.get("/danbooru_gallery/sync_status")
async def get_sync_status(request):
    """Get current synchronization status"""
    try:
        if not SYNC_AVAILABLE:
            return web.json_response({
                "success": False,
                "error": "Sync system not available"
            })

        bg_manager = get_background_sync_manager()
        status = bg_manager.get_status()

        return web.json_response({
            "success": True,
            **status
        })

    except Exception as e:
        logger.error(f"[标签同步] 获取状态失败: {e}")
        return web.json_response({"success": False, "error": str(e)})


# ========================================
# Initialize
# ========================================

def auto_start_sync():
    """Auto-start sync on ComfyUI startup if needed"""
    if not SYNC_AVAILABLE:
        return

    try:
        from .. import get_db_manager
        from pathlib import Path

        # Check if database exists
        db_manager = get_db_manager()
        db_path = Path(db_manager.db_path)

        # Debug mode: always force full sync
        if DEBUG_MODE:
            logger.info("[标签同步] 调试模式: 强制启动完整同步...")
            bg_manager = get_background_sync_manager()
            bg_manager.start_sync("full")
            return

        if not db_path.exists():
            # First time startup, start sync automatically
            logger.info("[标签同步] 首次启动检测到,开始后台同步...")
            bg_manager = get_background_sync_manager()
            bg_manager.start_sync("full")
        else:
            # Database exists, check if update needed
            import asyncio
            import time

            # Create event loop for async check
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            async def check_update():
                last_sync = await db_manager.get_last_sync_time()
                days_since_sync = (time.time() - last_sync) / 86400

                # Default sync interval: 7 days
                if last_sync == 0 or days_since_sync >= 7:
                    logger.info(f"[标签同步] 数据库需要更新 (已 {days_since_sync:.1f} 天未同步),开始增量同步...")
                    bg_manager = get_background_sync_manager()
                    bg_manager.start_sync("incremental")
                else:
                    logger.info(f"[标签同步] 数据库是最新的 (上次同步: {days_since_sync:.1f} 天前)")

            loop.run_until_complete(check_update())
            loop.close()

    except Exception as e:
        logger.error(f"[标签同步] 自动启动检查失败: {e}")
        import traceback
        traceback.print_exc()


if SYNC_AVAILABLE:
    # Setup progress callback
    bg_manager = get_background_sync_manager()
    bg_manager.set_progress_callback(progress_callback)
    logger.info("[标签同步] 进度回调已注册")

    # Auto-start sync with smart waiting (check if WebSocket clients are connected)
    import threading
    import time

    def wait_for_clients_and_start():
        """循环等待 WebSocket 客户端连接后再启动同步"""
        logger.info("[标签同步] 等待前端加载完成...")
        max_wait_time = 60  # 最多等60秒
        check_interval = 2  # 每2秒检查一次
        elapsed = 0

        while elapsed < max_wait_time:
            try:
                # 检查是否有 WebSocket 客户端连接
                if hasattr(PromptServer.instance, 'sockets') and len(PromptServer.instance.sockets) > 0:
                    # 有客户端连接了,再等3秒确保前端完全初始化
                    logger.info(f"[标签同步] 检测到前端连接 (等待 {elapsed}秒), 再等3秒确保初始化完成...")
                    time.sleep(3)
                    logger.info("[标签同步] 前端已就绪,开始自动启动检查...")
                    auto_start_sync()
                    return
            except Exception as e:
                logger.error(f"[标签同步] 检查客户端连接失败: {e}")

            time.sleep(check_interval)
            elapsed += check_interval

        # 超时了也启动
        logger.warning(f"[标签同步] 等待超时 ({max_wait_time}秒), 强制启动...")
        auto_start_sync()

    # 启动等待线程
    wait_thread = threading.Thread(target=wait_for_clients_and_start, daemon=True)
    wait_thread.start()
    logger.info("[标签同步] 智能等待已启动 (循环检查前端连接状态,最多等待60秒)")

logger.info("[标签同步] API 端点已注册:")
logger.info("[标签同步]    POST /danbooru_gallery/sync_start")
logger.info("[标签同步]    POST /danbooru_gallery/sync_cancel")
logger.info("[标签同步]    GET  /danbooru_gallery/sync_status")
