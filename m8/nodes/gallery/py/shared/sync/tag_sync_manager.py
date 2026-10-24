"""
Tag sync manager
Manages automatic tag synchronization on startup
"""

import asyncio
import time
import os
from pathlib import Path
from typing import Optional, Dict
import json

from ..db.db_manager import get_db_manager
from ..fetcher.tag_fetcher import DanbooruTagFetcher
from ..translation.translation_loader import get_translation_loader
from ..cache.memory_cache import get_hot_tags_cache

# Logger导入
from ...utils.logger import PLUGIN_ROOT, get_logger
logger = get_logger(__name__)


class TagSyncManager:
    """Manage tag synchronization and caching"""

    def __init__(self, config_path: Optional[str] = None):
        """
        Initialize sync manager

        Args:
            config_path: Path to config file (auto-detect if None)
        """
        if config_path is None:
            # 项目根 config.json（插件就是仓库本身，py/danbooru_gallery/config.json 并不存在）
            config_path = PLUGIN_ROOT / "config.json"

        self.config_path = Path(config_path)
        self.config = self._load_config()

        self.db_manager = get_db_manager()
        self.fetcher = DanbooruTagFetcher(
            rate_limit=self.config['tag_sync']['api_rate_limit']
        )
        self.translation_loader = get_translation_loader()

        # Initialize cache with database query mode by default
        use_database_query = self.config['cache'].get('use_database_query', True)
        self.cache = get_hot_tags_cache(use_database_query=use_database_query)

        self._initialized = False

    def _load_config(self) -> Dict:
        """Load configuration from file

        配置来源：项目根 config.json 的同名段落（tag_sync / offline_mode / cache）。
        读不到或字段缺失时用下面的默认值，且绝不回写任何文件。
        """
        default_config = {
            "tag_sync": {
                "min_post_count": 100,
                "max_tags": 100000,
                "sync_interval_days": 7,
                "incremental_update_count": 10000,
                "api_rate_limit": 2
            },
            "offline_mode": {
                "enabled": True,
                "fallback_to_remote": True,
                "remote_timeout_ms": 2000
            },
            "cache": {
                "memory_cache_enabled": False,           # ✅ 优化: 禁用内存缓存
                "preload_on_startup": False,             # ✅ 优化: 禁用启动预加载
                "use_database_query": True,              # ✅ 优化: 启用数据库查询模式
                "query_result_cache_size": 500           # 查询结果缓存大小
            }
        }

        if self.config_path.exists():
            try:
                with open(self.config_path, 'r', encoding='utf-8') as f:
                    loaded_config = json.load(f)

                if not isinstance(loaded_config, dict):
                    return default_config

                # Merge with defaults（只认自己关心的段落）
                for key, defaults in default_config.items():
                    section = loaded_config.get(key)
                    if isinstance(section, dict):
                        defaults.update(section)
                return default_config
            except Exception as e:
                logger.error(f"⚠️ Error loading config: {e}, using defaults")
        else:
            logger.info(f"ℹ️ 配置文件不存在，使用默认值: {self.config_path}")

        return default_config

    def _save_config(self):
        """运行时不写盘。

        历史实现会往自己的 config_path 写文件，而那个路径指向包目录里
        一个并不存在的 config.json —— 等于在插件目录里凭空造文件。
        配置现在由仓库/用户维护，这里只保留方法签名，不再落盘。
        """
        logger.warning(f"⚠️ 配置为只读（{self.config_path}），忽略保存请求")
        return False

    async def _first_time_init(self):
        """First time initialization - fetch and build database"""
        logger.info("\n" + "=" * 60)
        logger.info("🔄 First startup detected, initializing tag database...")
        logger.info("⏱️  This will take 5-10 minutes, please wait...")
        logger.info("=" * 60 + "\n")

        # Initialize database
        await self.db_manager.initialize_database()

        # Fetch hot tags from Danbooru
        max_tags = self.config['tag_sync']['max_tags']
        min_post_count = self.config['tag_sync']['min_post_count']

        logger.info(f"📥 Fetching top {max_tags} hot tags (min_count={min_post_count})...")

        fetched_tags = await self.fetcher.fetch_hot_tags(
            max_tags=max_tags,
            min_post_count=min_post_count
        )

        if not fetched_tags:
            logger.error("❌ Failed to fetch tags!")
            return False

        # Load translations
        logger.info("📚 Loading translation data...")
        self.translation_loader.load_all()

        # Add translations to tags
        logger.info("🔧 Adding translations...")
        self.translation_loader.add_translations_to_tags(fetched_tags)

        # Save to database in batches
        logger.info("💾 Saving to database...")
        batch_size = 1000
        for i in range(0, len(fetched_tags), batch_size):
            batch = fetched_tags[i:i + batch_size]
            await self.db_manager.insert_tags_batch(batch)
            logger.info(f"💾 Saved {min(i + batch_size, len(fetched_tags))}/{len(fetched_tags)} tags")

        # Update sync metadata
        await self.db_manager.set_last_sync_time()
        await self.db_manager.set_metadata('initial_sync_version', '1.0')

        logger.info("\n" + "=" * 60)
        logger.info(f"✅ Initial sync complete! {len(fetched_tags)} tags added.")
        logger.info("=" * 60 + "\n")

        return True

    async def _incremental_update(self):
        """Incremental update - refresh top N tags"""
        logger.info("🔄 Performing incremental update...")

        update_count = self.config['tag_sync']['incremental_update_count']

        # Get existing tags
        existing_tags = await self.db_manager.get_all_tags()
        existing_tag_names = [t['tag'] for t in existing_tags]

        # Fetch updates
        updated_tags = await self.fetcher.incremental_update(
            existing_tag_names,
            update_count=update_count
        )

        if not updated_tags:
            logger.warning("⚠️ Incremental update failed, skipping...")
            return

        # Add translations
        self.translation_loader.load_all()
        self.translation_loader.add_translations_to_tags(updated_tags)

        # Update database
        await self.db_manager.insert_tags_batch(updated_tags)
        await self.db_manager.set_last_sync_time()

        logger.info(f"✅ Incremental update complete!")

    async def _load_to_memory(self):
        """Load tags from database to memory cache"""
        # Skip if using database query mode
        if self.config['cache'].get('use_database_query', True):
            logger.info("ℹ️ Using database query mode, skipping memory preload")
            return

        if not self.config['cache']['preload_on_startup']:
            logger.info("ℹ️ Preload disabled, skipping memory cache")
            return

        logger.info("🔧 Loading tags to memory cache...")

        # Get all tags from database
        tags = await self.db_manager.get_all_tags(order_by_hot=True)

        if not tags:
            logger.warning("⚠️ No tags found in database")
            return

        # Load into cache
        self.cache.load_tags(tags)

        logger.info(f"✅ Memory cache loaded with {len(tags)} tags")

    async def initialize(self):
        """Initialize tag system on startup"""
        if self._initialized:
            return True

        try:
            # Check if database exists
            db_path = Path(self.db_manager.db_path)

            if not db_path.exists():
                # First time setup
                success = await self._first_time_init()
                if not success:
                    return False
            else:
                # Database exists, perform health check first
                logger.info("Checking database health...")
                is_healthy, error_msg = await self.db_manager.check_database_health()

                if not is_healthy:
                    # Database is corrupted
                    logger.warning(f"⚠️ Database corruption detected: {error_msg}")
                    logger.info("🔧 Attempting automatic recovery...")

                    # Try to recover by removing corrupted database
                    recovery_success = await self.db_manager.recover_from_corruption()

                    if recovery_success:
                        logger.info("✓ Database recovery successful")
                        logger.info("🔄 Performing first-time initialization...")

                        # Perform first-time init with fresh database
                        success = await self._first_time_init()
                        if not success:
                            logger.error("❌ First-time initialization failed after recovery")
                            return False
                    else:
                        logger.error("❌ Database recovery failed")
                        logger.info("💡 Please manually delete the database file and restart ComfyUI")
                        logger.info(f"Database path: {db_path}")
                        return False
                else:
                    # Database is healthy, proceed with normal initialization
                    logger.info("✓ Database health check passed")

                    await self.db_manager.initialize_database()  # Ensure schema is up to date (includes FTS5)

                    # Check if FTS5 index needs rebuilding (for database migration)
                    tag_count = await self.db_manager.get_tags_count()
                    if tag_count > 0:
                        # Check if FTS5 index exists and has data
                        conn = await self.db_manager.get_connection()
                        cursor = await conn.execute("SELECT COUNT(*) FROM hot_tags_fts")
                        row = await cursor.fetchone()
                        fts_count = row[0] if row else 0

                        if fts_count == 0:
                            # FTS5 index is empty, rebuild it
                            logger.info(f"🔧 Detected empty FTS5 index, rebuilding for {tag_count} tags...")
                            await self.db_manager.rebuild_fts_index()

                    last_sync = await self.db_manager.get_last_sync_time()
                    days_since_sync = (time.time() - last_sync) / 86400

                    sync_interval = self.config['tag_sync']['sync_interval_days']

                    if last_sync == 0:
                        # Database exists but no sync record, probably from old version
                        logger.warning("⚠️ No sync metadata found, marking as synced")
                        await self.db_manager.set_last_sync_time()
                    elif days_since_sync >= sync_interval:
                        # Need update
                        logger.info(f"🔄 Tag database is {days_since_sync:.1f} days old")
                        await self._incremental_update()
                    else:
                        # Up to date
                        tag_count = await self.db_manager.get_tags_count()
                        logger.info(f"✓ Tag database up to date ({tag_count} tags, "
                              f"last sync: {days_since_sync:.1f} days ago)")

            # Load to memory cache
            await self._load_to_memory()

            self._initialized = True
            return True

        except Exception as e:
            logger.error(f"❌ Initialization error: {e}")
            import traceback
            logger.debug(traceback.format_exc())
            return False

        finally:
            await self.fetcher.close()

    async def force_full_sync(self):
        """Force a full synchronization"""
        logger.info("🔄 Force full synchronization...")

        # Clear existing data
        await self.db_manager.close()
        db_path = Path(self.db_manager.db_path)
        if db_path.exists():
            os.remove(db_path)
            logger.info("🗑️ Removed old database")

        # Perform first time init
        success = await self._first_time_init()

        if success:
            # Reload to memory
            await self._load_to_memory()

        await self.fetcher.close()
        return success

    def get_status(self) -> Dict:
        """Get current sync status"""
        return {
            'initialized': self._initialized,
            'cache_loaded': self.cache.is_loaded(),
            'cache_stats': self.cache.get_stats() if self.cache.is_loaded() else {},
            'config': self.config
        }


# Global sync manager instance
_sync_manager = None


def get_sync_manager() -> TagSyncManager:
    """Get global sync manager instance"""
    global _sync_manager
    if _sync_manager is None:
        _sync_manager = TagSyncManager()
    return _sync_manager


async def initialize_tag_system():
    """Initialize tag system - call this on ComfyUI startup"""
    manager = get_sync_manager()
    return await manager.initialize()


async def force_sync():
    """Force full synchronization"""
    manager = get_sync_manager()
    return await manager.force_full_sync()


# For testing
async def test_sync_manager():
    """Test sync manager"""
    manager = TagSyncManager()

    logger.info("Testing initialization...")
    success = await manager.initialize()

    if success:
        logger.info("\nStatus:")
        status = manager.get_status()
        logger.info(json.dumps(status, indent=2, ensure_ascii=False))

        # Test cache
        cache = manager.cache
        if cache.is_loaded():
            logger.info("\nTesting cache search:")
            results = await cache.search_by_prefix("1girl", limit=5)
            for r in results:
                logger.info(f"  {r['tag']} - {r['translation_cn']} (count: {r['post_count']})")

    await manager.db_manager.close()


if __name__ == "__main__":
    asyncio.run(test_sync_manager())
