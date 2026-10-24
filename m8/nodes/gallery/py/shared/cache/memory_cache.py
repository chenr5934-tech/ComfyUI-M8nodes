"""
HotTagsCache implementation

Provides two working modes for tag autocomplete:
1. Database query mode (default, recommended):
   - Zero memory footprint
   - 2-5ms query latency (FTS5 optimized)
   - Always up-to-date

2. Memory cache mode (optional):
   - <1ms query latency
   - ~100MB memory usage
   - Manual sync required

所有查询接口都是 async 的：底层 db_manager 用的是 aiosqlite，只能在事件循环里 await。
历史实现是同步方法 + loop.run_until_complete，在 ComfyUI 的 aiohttp 事件循环里
`loop.is_running()` 恒为真，于是每次都只打一条 warning 然后返回 []（静默失效）。
该路径已删除，改为真正的 async 实现；同时前缀索引由"每个 tag 的全部前缀"
改为"排序键 + bisect"，避免 10 万 tag 产生百万级索引条目。

Thread-safe with RLock protection.
"""

import bisect
import heapq
import threading
import time

# Logger导入
from ...utils.logger import get_logger
logger = get_logger(__name__)
from typing import List, Dict, Optional, Tuple


class HotTagsCache:
    """
    Hot tags memory cache with dual-mode support

    This class provides an optional memory caching layer for tag search optimization.
    By default, it operates in database query mode (transparent pass-through).
    """

    def __init__(self, use_database_query: bool = True):
        """
        Initialize cache

        Args:
            use_database_query: Whether to use database query mode
                - True (default): Pass-through to database, no memory cache
                - False: Use in-memory cache with prefix indexing
        """
        # ========== Configuration ==========
        self.use_database_query = use_database_query

        # ========== Database Connection (lazy-loaded) ==========
        self.db_manager = None  # Will be initialized on first query

        # ========== Memory Cache Data (only used when use_database_query=False) ==========
        self._tags_list: List[Dict] = []  # All tags list
        # 排序后的 (小写 tag, tags_list 下标)，用于 bisect 前缀查找
        self._sorted_keys: List[str] = []
        self._sorted_indices: List[int] = []
        self._translation_index: Dict[str, List[int]] = {}  # character -> tag indices

        # ========== State Flags ==========
        self._loaded: bool = False  # Whether data is loaded
        self._last_update: float = 0.0  # Last update timestamp

        # ========== Thread Safety ==========
        self._lock = threading.RLock()  # Recursive lock for thread safety

        # ========== Query Result Cache (LRU) ==========
        self._query_result_cache: Dict[str, Tuple[float, List[Dict]]] = {}
        self._query_cache_size: int = 500  # Max 500 cached queries
        self._query_cache_ttl: float = 300.0  # Cache TTL: 5 minutes

        logger.info(f"初始化缓存（模式: {'数据库查询' if use_database_query else '内存缓存'}）")

    # ==================== Core Query Interfaces ====================

    async def search_by_prefix(self, prefix: str, limit: int = 10) -> List[Dict]:
        """
        Search tags by prefix (English)

        Args:
            prefix: Search prefix (e.g., "1girl")
            limit: Maximum number of results

        Returns:
            List[Dict]: Matching tags
                [{
                    'tag': str,
                    'category': int,
                    'post_count': int,
                    'translation_cn': str,
                    'aliases': List[str]
                }, ...]
        """
        if not prefix:
            return []

        prefix = prefix.lower().strip()

        if self.use_database_query:
            # Database mode: pass-through to database
            return await self._search_database_by_prefix(prefix, limit)

        # Memory mode: search in memory index
        with self._lock:
            return self._search_in_memory_by_prefix(prefix, limit)

    async def search_by_translation(self, query: str, limit: int = 10) -> List[Dict]:
        """
        Search tags by Chinese translation

        Args:
            query: Chinese query string (e.g., "1个女孩")
            limit: Maximum number of results

        Returns:
            List[Dict]: Same as search_by_prefix
        """
        if not query:
            return []

        query = query.strip()

        if self.use_database_query:
            # Database mode: pass-through to database
            return await self._search_database_by_translation(query, limit)

        # Memory mode: search in memory index
        with self._lock:
            return self._search_in_memory_by_translation(query, limit)

    async def search_optimized(self, query: str, limit: int = 10,
                              search_type: str = "auto") -> List[Dict]:
        """
        Smart search with automatic language detection and LRU caching

        Args:
            query: Query string
            limit: Maximum number of results
            search_type: "auto" (detect), "english", or "chinese"

        Returns:
            List[Dict]: Same as search_by_prefix

        Note:
            数据库模式下直接把 query 交给 db.search_tags_optimized（FTS5），
            与仓库里其它调用方走同一条路径；内存模式下用本地索引 + LRU。
        """
        if not query:
            return []

        query = query.strip()

        if self.use_database_query:
            db = self._get_db_manager()
            if db is None:
                return []
            try:
                return await db.search_tags_optimized(query, limit, search_type=search_type)
            except Exception as e:
                logger.error(f"数据库优化查询失败: {e}")
                return []

        # Check query result cache
        cache_key = f"{query}:{limit}:{search_type}"
        cached_result = self._get_cached_query_result(cache_key)
        if cached_result is not None:
            return cached_result

        # Auto-detect language
        if search_type == "auto":
            search_type = self._detect_language(query)

        # Execute search
        with self._lock:
            if search_type == "chinese":
                results = self._search_in_memory_by_translation(query, limit)
            else:
                results = self._search_in_memory_by_prefix(query, limit)

        # Cache the result
        self._cache_query_result(cache_key, results)

        return results

    # ==================== Data Management Interfaces ====================

    def load_tags(self, tags: List[Dict]) -> None:
        """
        Load tags into memory and build indices

        Args:
            tags: Tag list from database

        Note:
            - Only effective when use_database_query=False
            - Will build prefix and translation indices
        """
        if self.use_database_query:
            logger.info("数据库查询模式下不需要加载标签到内存")
            return

        logger.info(f"开始加载标签数据: {len(tags)} 个标签")
        start_time = time.time()

        with self._lock:
            try:
                self._tags_list = tags
                self._build_prefix_index()
                self._build_translation_index()
                self._loaded = True
                self._last_update = time.time()

                elapsed = time.time() - start_time
                logger.info(f"✓ 标签数据加载完成，耗时 {elapsed:.2f}s")

            except Exception as e:
                logger.error(f"Error: 标签加载失败: {e}")
                self._loaded = False
                raise

    def clear(self) -> None:
        """Clear memory cache"""
        with self._lock:
            self._tags_list.clear()
            self._sorted_keys.clear()
            self._sorted_indices.clear()
            self._translation_index.clear()
            self._query_result_cache.clear()
            self._loaded = False
            self._last_update = 0.0
            logger.info("缓存已清空")

    # ==================== State Query Interfaces ====================

    def is_loaded(self) -> bool:
        """
        Check if cache is loaded

        Returns:
            True if memory cache has data, False otherwise
        """
        if self.use_database_query:
            return False  # Database mode doesn't load into memory
        return self._loaded

    def get_stats(self) -> Dict:
        """
        Get cache statistics

        Returns:
            {
                'mode': str,              # "database" or "memory"
                'total_tags': int,        # Total number of tags
                'memory_size_mb': float,  # Memory usage in MB
                'index_count': int,       # Number of index entries
                'last_update': float      # Last update timestamp
            }
        """
        with self._lock:
            stats = {
                'mode': 'database' if self.use_database_query else 'memory',
                'total_tags': len(self._tags_list),
                'memory_size_mb': self._calculate_memory_size(),
                'index_count': len(self._translation_index),
                'last_update': self._last_update,
            }
            return stats

    # ==================== Internal Implementation Methods ====================

    def _get_db_manager(self):
        """Lazily resolve the shared database manager（不可用时返回 None）"""
        if self.db_manager is None:
            try:
                from ..db.db_manager import get_db_manager
                self.db_manager = get_db_manager()
            except Exception as e:
                logger.error(f"数据库管理器不可用: {e}")
                return None
        return self.db_manager

    async def _search_database_by_prefix(self, prefix: str, limit: int) -> List[Dict]:
        """Search by prefix using database (transparent pass-through)"""
        db = self._get_db_manager()
        if db is None:
            return []
        try:
            return await db.search_tags_by_prefix(prefix, limit)
        except Exception as e:
            logger.error(f"数据库前缀查询失败: {e}")
            return []

    async def _search_database_by_translation(self, query: str, limit: int) -> List[Dict]:
        """Search by translation using database"""
        db = self._get_db_manager()
        if db is None:
            return []
        try:
            return await db.search_tags_by_translation(query, limit)
        except Exception as e:
            logger.error(f"数据库翻译查询失败: {e}")
            return []

    def _search_in_memory_by_prefix(self, prefix: str, limit: int) -> List[Dict]:
        """Search by prefix in memory index"""
        if not self._loaded:
            logger.warning("Warning: 缓存未加载")
            return []

        start = bisect.bisect_left(self._sorted_keys, prefix)
        if start >= len(self._sorted_keys):
            return []

        def _iter_matches():
            idx = start
            while idx < len(self._sorted_keys) and self._sorted_keys[idx].startswith(prefix):
                yield self._tags_list[self._sorted_indices[idx]]
                idx += 1

        # 只需 top-limit，不必把命中的全部条目物化出来
        results = heapq.nlargest(limit, _iter_matches(), key=lambda t: t.get('post_count', 0))
        return [tag.copy() for tag in results]

    def _search_in_memory_by_translation(self, query: str, limit: int) -> List[Dict]:
        """Search by translation in memory index"""
        if not self._loaded:
            logger.warning("Warning: 缓存未加载")
            return []

        # Find tags containing the query characters
        matching_indices_set = set()

        for char in query:
            indices = self._translation_index.get(char, [])
            if not matching_indices_set:
                matching_indices_set = set(indices)
            else:
                matching_indices_set &= set(indices)

        if not matching_indices_set:
            return []

        # Get tag info and filter by full match
        results = []
        for idx in matching_indices_set:
            if idx < len(self._tags_list):
                tag_info = self._tags_list[idx]
                translation = tag_info.get('translation_cn', '')
                if query in translation:
                    results.append(tag_info)

        # Sort by post_count (descending)
        results.sort(key=lambda x: x.get('post_count', 0), reverse=True)

        return [tag.copy() for tag in results[:limit]]

    def _build_prefix_index(self) -> None:
        """Build the sorted tag keys used by bisect prefix search.

        历史实现为每个 tag 的每个字符前缀建一条索引，10 万 tag 会产生
        百万级条目。排序键 + bisect 是 O(n log n) 排序、零额外索引条目。
        """
        pairs = []
        for idx, tag_info in enumerate(self._tags_list):
            tag = tag_info.get('tag', '').lower()
            if not tag:
                continue
            pairs.append((tag, idx))

        pairs.sort(key=lambda item: item[0])
        self._sorted_keys = [item[0] for item in pairs]
        self._sorted_indices = [item[1] for item in pairs]

        logger.info(f"前缀索引构建完成: {len(self._sorted_keys)} 个排序键")

    def _build_translation_index(self) -> None:
        """Build translation index for Chinese characters"""
        self._translation_index.clear()

        for idx, tag_info in enumerate(self._tags_list):
            translation = tag_info.get('translation_cn', '')
            if not translation:
                continue

            # Build index for each character
            for char in translation:
                if char not in self._translation_index:
                    self._translation_index[char] = []
                self._translation_index[char].append(idx)

        logger.info(f"翻译索引构建完成: {len(self._translation_index)} 个字符")

    def _detect_language(self, query: str) -> str:
        """
        Auto-detect language (Chinese vs English)

        Args:
            query: Query string

        Returns:
            "chinese" or "english"
        """
        for char in query:
            # Check if contains Chinese characters
            if '\u4e00' <= char <= '\u9fff':
                return 'chinese'
        return 'english'

    def _calculate_memory_size(self) -> float:
        """
        Calculate memory usage in MB

        Returns:
            Memory size in MB
        """
        if not self._loaded:
            return 0.0

        # Rough estimation
        # tags_list: ~1KB per tag
        # indices: ~100 bytes per entry
        tags_size = len(self._tags_list) * 1024  # bytes
        index_size = (len(self._sorted_keys) + len(self._translation_index)) * 100

        total_bytes = tags_size + index_size
        return total_bytes / (1024 * 1024)  # Convert to MB

    def _get_cached_query_result(self, cache_key: str) -> Optional[List[Dict]]:
        """Get cached query result if valid"""
        if cache_key in self._query_result_cache:
            cached_time, cached_results = self._query_result_cache[cache_key]
            # Check TTL
            if time.time() - cached_time < self._query_cache_ttl:
                return cached_results
            else:
                # Expired, remove from cache
                del self._query_result_cache[cache_key]
        return None

    def _cache_query_result(self, cache_key: str, results: List[Dict]) -> None:
        """Cache query result with LRU eviction"""
        self._query_result_cache[cache_key] = (time.time(), results)

        # LRU eviction
        if len(self._query_result_cache) > self._query_cache_size:
            # Remove oldest entry
            oldest_key = min(
                self._query_result_cache.items(),
                key=lambda x: x[1][0]
            )[0]
            del self._query_result_cache[oldest_key]


# ==================== Factory Function (Singleton Pattern) ====================

_cache_instance: Optional[HotTagsCache] = None
_cache_lock = threading.Lock()


def get_hot_tags_cache(use_database_query: bool = True) -> HotTagsCache:
    """
    Get global HotTagsCache singleton instance

    Args:
        use_database_query: Whether to use database query mode

    Returns:
        HotTagsCache instance

    Note:
        - Singleton pattern: multiple calls return the same instance
        - First call initializes with the given parameter
    """
    global _cache_instance

    with _cache_lock:
        if _cache_instance is None:
            _cache_instance = HotTagsCache(use_database_query)
        return _cache_instance
