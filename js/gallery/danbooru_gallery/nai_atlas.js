/* ============================================================================
 * NAI 图鉴（法典图鉴）数据源 —— 前端直连
 *
 * 这个文件里**只有逻辑，没有一个字节的数据**。图鉴的词典、条目、图片全部
 * 来自上游，运行时按需现取：
 *
 *   data-source.json      → baseUrl / pointer
 *   {baseUrl}/current.json → release
 *   releases/{release}/codexes.json          → 词典清单
 *   releases/{release}/{codexId}.json        → 条目（几百 KB 到几 MB）
 *   releases/{release}/media.json            → 图片基址与前缀
 *   图片 = {media.baseUrl}/{images|originals}/{assetCodexId}/{文件名}?v={assetRev}
 *
 * **为什么一个都不落盘**：这个插件是开源的，任何写进仓库或写进用户磁盘的
 * 图库数据都会变成别人的空间负担。所以：
 *   - 不写 localStorage / IndexedDB / 后端文件
 *   - 词典只在**页面内存**里缓存一份（刷新即失，重启即失）
 *   - 图片交给浏览器和上游 CDN —— 上游发的是 immutable / 一年，比我们缓存得好
 *
 * 提示词语义照搬站点自己那套（app/nai-sd.js + app/copy.js 的 entryPromptText）：
 *   - 默认输出 **SD 权重格式**
 *   - 主正向 + 各角色正文按行合并，**丢掉角色标记**，不拆散
 *   - 负向一律不取
 * ==========================================================================*/

/* ---------------------------------------------------------------- 体积常量 */

/* 上游的 data-source.json 是固定入口，写死它是唯一合理的常量 —— 其余全部现取。 */
const DEFAULT_SOURCE_URL = "https://novelai.quicktagcloud.com/data-source.json";

/* ---------------------------------------------------------------- 内存缓存 */

let sourceCache = null;        // { baseUrl, release }
let mediaCache = null;         // { baseUrl, imagePrefix, originalPrefix }
let codexListCache = null;     // [{ id, title, entryCount, ... }]
const entryCache = new Map();  // codexId -> entries[]
const entryPending = new Map(); // codexId -> Promise（并发去重）
const postsCache = new Map();  // codexId -> post[]（转换结果，见 loadPosts 的说明）

/* 只留最近用过的两本词典。
 * 一本画师词典五千多条，解析成对象后是几十 MB 量级；用户来回切几本就把标签页
 * 拖爆了。Map 保持插入顺序，所以「删掉最旧的那个 key」就是 LRU，不用另建结构。 */
const CACHE_LIMIT = 2;

function rememberCodex(cache, codexId, value) {
  cache.delete(codexId);
  cache.set(codexId, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  return value;
}

/** 清掉所有内存缓存。测试和「强制刷新」用；正常流程不调。 */
export function clearNaiCache() {
  sourceCache = null;
  mediaCache = null;
  codexListCache = null;
  entryCache.clear();
  entryPending.clear();
  postsCache.clear();
}

/* ---------------------------------------------------------------- 取数 */

/* 直连还是走代理。
 *
 * 直连最省：上游是普通对象存储 + CDN，浏览器直接吃它的 immutable 缓存，
 * ComfyUI 后端一根线程都不占。但它要求上游对**插件所在的 origin** 放开 CORS，
 * 而插件跑在每个用户自己的机器上 —— 127.0.0.1:8188、localhost、换端口、
 * 内网 IP、反代域名，这个集合没法预先列出来。
 *
 * 所以做成两级：先直连，被挡了就永久切到 /danbooru_gallery/nai_atlas 代理，
 * 之后不再浪费一次失败往返。CORS 被拒在浏览器里只是个 TypeError，和断网
 * 分不出来 —— 都当「直连不可用」处理，这是有意的。
 */
let directBlocked = false;
let directWarned = false;

/** 重置直连探测状态（测试和「强制刷新」用）。 */
export function resetDirectProbe() {
  directBlocked = false;
  directWarned = false;
}

async function fetchJsonSmart(buildUrl, backendQuery) {
  if (!directBlocked) {
    try {
      const url = await buildUrl();
      const response = await fetch(url, { credentials: "omit" });
      if (!response.ok) throw new Error(`图鉴接口 ${response.status}：${url}`);
      return await response.json();
    } catch (exc) {
      directBlocked = true;
      if (!directWarned) {
        directWarned = true;
        // 只提示一次，别在控制台刷屏
        console.info(
          "[M8][nai_atlas] 直连不可用（多半是站点没对插件 origin 放开 CORS），改走后端代理",
        );
      }
      if (!backendQuery) throw exc;
    }
  }
  const response = await fetch(`/danbooru_gallery/nai_atlas?${backendQuery}`);
  if (!response.ok) {
    let detail = "";
    try {
      detail = String((await response.json())?.error || "");
    } catch (exc) {
      /* 代理也没给 JSON，下面用状态码说话 */
    }
    throw new Error(`图鉴代理 ${response.status}${detail ? "：" + detail : ""}`);
  }
  return response.json();
}

/** 直连是否还活着。给 UI 决定要不要提示用户去配 CORS。 */
export function directAvailable() {
  return !directBlocked;
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

/**
 * 解析数据源：拿 baseUrl 和当前 release。
 *
 * 直连被挡时返回 null 而不是抛错 —— 上层拿不到 URL 就自动改走后端代理，
 * 代理自己会解析同一份配置（它不需要前端告诉它 release 是多少）。
 */
async function loadSource() {
  if (sourceCache) return sourceCache;
  if (directBlocked) return null;
  try {
    const config = await fetchJsonSmart(async () => DEFAULT_SOURCE_URL, "");
    const baseUrl = trimSlash(config.baseUrl);
    if (!baseUrl) throw new Error("图鉴数据源没给出 baseUrl");
    const pointer = String(config.pointer || "current.json");
    const current = await fetchJsonSmart(async () => `${baseUrl}/${pointer}`, "");
    const release = String(current.release || "");
    if (!release) throw new Error("图鉴数据源没给出 release");
    sourceCache = { baseUrl, release };
    return sourceCache;
  } catch (exc) {
    return null;
  }
}

/** 图片基址。media.json 拿不到时用条目里的绝对地址兜底（不猜域名）。 */
async function loadMedia() {
  if (mediaCache) return mediaCache;
  let media = {};
  const source = await loadSource();
  if (source) {
    try {
      media = await fetchJsonSmart(
        async () => `${source.baseUrl}/releases/${source.release}/media.json`,
        "kind=media",
      );
    } catch (exc) {
      media = {};
    }
  } else {
    try {
      media = await fetchJsonSmart(async () => "", "kind=media");
    } catch (exc) {
      media = {};
    }
  }
  mediaCache = {
    baseUrl: trimSlash(media.baseUrl),
    imagePrefix: String(media.imagePrefix || "images"),
    originalPrefix: String(media.originalPrefix || "originals"),
  };
  return mediaCache;
}

/** 词典清单。条目多、但清单本身小（几十 KB），值得缓存。 */
export async function loadCodexList() {
  if (codexListCache) return codexListCache;
  const source = await loadSource();
  const list = await fetchJsonSmart(
    async () => (source ? `${source.baseUrl}/releases/${source.release}/codexes.json` : ""),
    "kind=codexes",
  );
  codexListCache = (Array.isArray(list) ? list : [])
    .filter((item) => item && item.id)
    .map((item) => ({
      id: String(item.id),
      title: String(item.title || item.id),
      entryCount: Number(item.entryCount) || 0,
      hasOriginal: Boolean(item.hasOriginal),
      type: String(item.type || ""),
    }));
  return codexListCache;
}

/** 某个词典的原始 payload（entries + tree）。并发同一词典只发一次请求。 */
async function loadPayload(codexId) {
  if (!codexId) return {};
  if (entryCache.has(codexId)) return entryCache.get(codexId);
  if (entryPending.has(codexId)) return entryPending.get(codexId);

  const request = (async () => {
    const source = await loadSource();
    const payload = await fetchJsonSmart(
      async () => (source ? `${source.baseUrl}/releases/${source.release}/${codexId}.json` : ""),
      `kind=codex&id=${encodeURIComponent(codexId)}`,
    );
    const safe = payload && typeof payload === "object" ? payload : {};
    rememberCodex(entryCache, codexId, safe);
    return safe;
  })().finally(() => entryPending.delete(codexId));

  entryPending.set(codexId, request);
  return request;
}

/** 某个词典的全部条目。 */
export async function loadEntries(codexId) {
  const payload = await loadPayload(codexId);
  return Array.isArray(payload?.entries) ? payload.entries : [];
}

/**
 * 某个词典的分类树，拍平成「路径 + 名称 + 数量 + 层级」的列表。
 *
 * 每部词典的 tree 都是它自己的 —— 画师词典是「单画师 / 画风组」，构图鉴是
 * 「构图风格」，别的又不一样。所以这里不做任何写死的分类，只按数据展开。
 */
export async function loadCodexTree(codexId) {
  const payload = await loadPayload(codexId);
  const out = [];
  const walk = (nodes, prefix, depth) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      const name = String(node?.name || "").trim();
      if (!name) continue;
      const path = [...prefix, name];
      out.push({
        path,
        name,
        label: path.join(" / "),
        count: Number(node?.count) || 0,
        depth,
      });
      walk(node?.children, path, depth + 1);
    }
  };
  walk(payload?.tree, [], 0);
  return out;
}

/* ---------------------------------------------------------------- 图片地址 */

function isAbsoluteUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

/** 和站点 media.js 的 mediaPath 同一条规则：prefix / codexId / 文件名。 */
export function assetUrl(media, prefix, codexId, file, rev) {
  const name = String(file || "");
  if (!name) return "";
  if (isAbsoluteUrl(name)) return rev ? `${name}?v=${encodeURIComponent(rev)}` : name;
  const parts = [prefix, codexId, name]
    .map((part) => encodeURIComponent(String(part || "")).replace(/%2F/g, "/"));
  const path = parts.join("/");
  const url = media?.baseUrl ? `${media.baseUrl}/${path}` : path;
  return rev ? `${url}?v=${encodeURIComponent(rev)}` : url;
}

/* ---------------------------------------------------------------- NAI → SD */

/* 下面这段是从站点 app/nai-sd.js 原样移植的：NAI 每层括号 ×1.05 / ÷1.05。
     {tag} → (tag:1.05)     {{tag}} → (tag:1.103)
     [tag] → (tag:0.952)    1.3::tag:: → (tag:1.3)
   支持括号嵌套；未闭合的左括号只丢括号本身，避免把后面的普通 tag 悄悄加权。
   已知限制（站点也认）：1.3::a 1.5::b:: c:: 这类数字权重自身嵌套时，:: 的就近
   闭合有歧义，不做递归解析。别在没有全库回归证据时「修正」这条语义。 */
const NAI_WEIGHT_BASE = 1.05;

export function fmtSdWeight(weight) {
  return parseFloat(weight.toFixed(3)).toString();
}

export function naiToSd(text) {
  if (!text) return text;
  const n = text.length;

  const readRun = (pos, ch) => {
    let count = 0;
    while (text[pos + count] === ch) count += 1;
    return count;
  };
  const cleanWeightContent = (value) => value.trim().replace(/[,\s，]+$/, "").trim();

  const parseNumericWeight = (pos) => {
    const ch = text[pos];
    if (ch !== "-" && ch !== "+" && (ch < "0" || ch > "9")) return null;
    const empty = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::(?=[,\n]|$)/);
    if (empty) return { out: "", pos: pos + empty[0].length };
    const match = text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([\s\S]*?)::/)
      || text.slice(pos).match(/^([+-]?\d+(?:\.\d+)?)::([^,\n}\]]*)/);
    if (!match) return null;
    const content = naiToSd(cleanWeightContent(match[2]));
    if (!content) return { out: "", pos: pos + match[0].length };
    return {
      out: `(${content}:${fmtSdWeight(parseFloat(match[1]))})`,
      pos: pos + match[0].length,
    };
  };

  const parseBracketWeight = (pos) => {
    const open = text[pos];
    const close = open === "{" ? "}" : "]";
    const openCount = readRun(pos, open);
    const inner = parseRange(pos + openCount, close);
    if (!inner.closed) return { out: inner.out, pos: inner.pos };

    const matchedCount = Math.min(openCount, inner.closeCount);
    const nextPos = inner.closeStart + matchedCount;
    const content = cleanWeightContent(inner.out);
    if (!matchedCount || !content) return { out: "", pos: nextPos };
    const direction = open === "{" ? 1 : -1;
    return {
      out: `(${content}:${fmtSdWeight(Math.pow(NAI_WEIGHT_BASE, direction * matchedCount))})`,
      pos: nextPos,
    };
  };

  const parseRange = (pos, stopClose = "") => {
    let out = "";
    while (pos < n) {
      const ch = text[pos];

      if (stopClose && ch === stopClose) {
        const closeCount = readRun(pos, stopClose);
        return { out, closeStart: pos, pos: pos + closeCount, closed: true, closeCount };
      }

      if (ch === "}" || ch === "]") {
        pos += readRun(pos, ch);
        continue;
      }

      const weighted = parseNumericWeight(pos);
      if (weighted) {
        out += weighted.out;
        pos = weighted.pos;
        continue;
      }

      if (ch === "{" || ch === "[") {
        const group = parseBracketWeight(pos);
        out += group.out;
        pos = group.pos;
        continue;
      }

      out += ch;
      pos += 1;
    }
    return { out, closeStart: pos, pos, closed: false, closeCount: 0 };
  };

  return parseRange(0).out;
}

/* ---------------------------------------------------------------- 提示词 */

/**
 * 一条词条的提示词，SD 格式、只有正向。
 *
 * 合并规则照站点 entryPromptText 的 SD 模式：主正向 + 各角色正文按行拼起来，
 * **丢掉 `角色名:` 这个标记** —— 这就是「Chr1+Chr2+场景不要拆散」。
 * 负向字段一个都不读。
 */
export function entryPrompt(entry) {
  const parts = [String(entry?.tags || "").trim()];
  for (const item of entry?.characterPrompts || []) {
    const prompt = String(item?.prompt || "").trim();
    if (prompt) parts.push(prompt);
  }
  return naiToSd(parts.filter(Boolean).join("\n"));
}

/* ---------------------------------------------------------------- 检索 */

/* 下面三个函数是法典站 search.js 的同一套规则，只保留「默认全文检索」这一条
   路径 —— 那边的 title:/path:/has: 这些字段前缀语法没搬，插件里用不上那么细。
   规则细节一个都没改，因为它们各自解决一个具体问题：
     - 归一化把下划线当空格：标签写的是 ask_(askzy)，用户会敲 "ask askzy"
     - 词边界：搜 cat 不该命中 category
     - 空格分词全部 AND：多个词是缩小范围，不是扩大 */

function normalizeInput(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

/** 搜索归一化：下划线与空白等价、转小写、去首尾。 */
export function normalizeMatchText(value) {
  return normalizeInput(value).replace(/[_\t\f\v\p{Zs}]+/gu, " ").trim().toLowerCase();
}

function isWordCode(code) {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
}

/** 带英文词边界的子串查找。 */
export function textIncludes(text, term) {
  if (!term) return false;
  let index = text.indexOf(term);
  if (index === -1) return false;
  const leftBoundary = isWordCode(term.charCodeAt(0));
  const rightBoundary = isWordCode(term.charCodeAt(term.length - 1));
  if (!leftBoundary && !rightBoundary) return true;
  while (index !== -1) {
    const end = index + term.length;
    if ((!leftBoundary || !isWordCode(text.charCodeAt(index - 1)))
      && (!rightBoundary || !isWordCode(text.charCodeAt(end)))) {
      return true;
    }
    index = text.indexOf(term, index + 1);
  }
  return false;
}

/** 一条词条的可搜文本：标题 + 主正向 + 各角色正文（和法典站 searchableText 同口径）。 */
export function searchableText(entry) {
  const title = normalizeMatchText(entry?.title);
  const prompt = normalizeMatchText(
    [entry?.tags, ...(entry?.characterPrompts || []).map((item) => item?.prompt)]
      .filter(Boolean)
      .join("\n"),
  );
  return [title, prompt].filter(Boolean).join("\n");
}

/** 查询分词：空格切开，全部 AND。 */
export function parseQuery(query) {
  return normalizeMatchText(query).split(" ").filter(Boolean);
}

/** 词条路径是否落在选中目录下（任意层级前缀，和法典站 matchesDirectoryFilter 一致）。 */
export function pathInDirectory(entryPath, dirPath) {
  const path = Array.isArray(entryPath) ? entryPath : [];
  const target = Array.isArray(dirPath) ? dirPath : [];
  if (!target.length) return true;
  if (path.length < target.length) return false;
  return target.every((segment, index) => path[index] === segment);
}

/**
 * 按关键词和分类过滤 post 列表。两者同时生效。
 *
 * post 上的 `_nai.searchText` 是转换时算好的（见 entryToPost），这里只做比对；
 * 每次滚动都重算一遍归一化文本是纯浪费。
 */
export function filterPosts(posts, { query = "", dirPath = null } = {}) {
  const terms = parseQuery(query);
  return (posts || []).filter((post) => {
    if (!pathInDirectory(post?._nai?.path, dirPath)) return false;
    if (!terms.length) return true;
    const text = post?._nai?.searchText || "";
    return terms.every((term) => textIncludes(text, term));
  });
}

/* ---------------------------------------------------------------- 转成通用 post */

/**
 * 把图鉴词条转成画廊认的 post 结构。
 *
 * 转成同一个形状之后，卡片渲染、多选、入队全部复用现有代码，不用给 NAI 单开
 * 一套。入队时优先读 `_nai_sd_prompt`（已经是 SD 格式），不走通用的
 * buildPromptForPost —— 那个会按分类重排、过滤、再用逗号连成一行，会把
 * 角色分段和权重语法一起揉坏。
 */
export function entryToPost(entry, codexId, media) {
  const rev = String(entry?.assetRev || "");
  const images = Array.isArray(entry?.images) && entry.images.length
    ? entry.images
    : (entry?.image ? [{ path: entry.image, original: entry.original || "" }] : []);
  const first = images[0] || {};
  const assetCodexId = String(entry?.assetCodexId || codexId || "");

  const previewUrl = assetUrl(media, media.imagePrefix, assetCodexId, first.path || entry?.image, rev);
  const originalUrl = assetUrl(media, media.originalPrefix, assetCodexId, first.original || entry?.original, rev);
  const prompt = entryPrompt(entry);
  const tags = String(entry?.tags || "");

  return {
    id: String(entry?.id || ""),
    source_site: "nai_atlas",
    file_url: originalUrl || previewUrl,
    large_file_url: previewUrl,
    preview_file_url: previewUrl,
    tag_string: tags,
    // 图鉴只有一坨不分类的 tags。全放 general，卡片才显示得出来；
    // 另外三个留空，免得分类视图里出现重复项。
    tag_string_general: tags,
    tag_string_artist: "",
    tag_string_copyright: "",
    tag_string_character: "",
    tag_string_meta: "",
    image_width: Number(entry?.imageWidth) || 0,
    image_height: Number(entry?.imageHeight) || 0,
    rating: "general",
    _tag_categories_complete: false,
    _tag_categories_exact: false,
    _nai_sd_prompt: prompt,
    _nai: {
      codexId,
      title: String(entry?.title || ""),
      path: Array.isArray(entry?.path) ? entry.path : [],
      imageCount: images.length,
      // 检索用的归一化文本，转换时算一次就够
      searchText: searchableText(entry),
    },
  };
}

/**
 * 一次把词典拉齐并转成 post 列表。
 *
 * **转换结果也要缓存。** 画廊是滚动加载的，每次往画布上铺下一批都会再要一次
 * 这个列表；不缓存的话滚动一次就把几千条重新拼一遍 URL、跑一遍权重转换，
 * 那点活儿本身不慢，但乘以条目数就是白扔的主线程时间。
 */
export async function loadPosts(codexId) {
  if (!codexId) return [];
  if (postsCache.has(codexId)) return postsCache.get(codexId);
  const [entries, media] = await Promise.all([loadEntries(codexId), loadMedia()]);
  const posts = entries.map((entry) => entryToPost(entry, codexId, media));
  return rememberCodex(postsCache, codexId, posts);
}
