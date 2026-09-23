/* ============================================================================
 * M8 节点包 · 前端地基
 *
 * 所有节点共用的东西都在这里：日志、接口调用、通知、节点外观、控件小工具。
 * 节点文件里不要再各写一份 —— 这是 docs/ARCHITECTURE.md 定下的规矩。
 *
 * 依赖极简：只用 ComfyUI 自带的 /scripts/app.js 和 /scripts/api.js。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

export const API_BASE = "/m8";
export const PREFIX = "[M8]";

/* 品牌色。和 js/m8_theme.css 里的 :root 变量保持一致。
   canvas 上画东西时拿不到 CSS 变量，所以这儿存一份数值。 */
export const COLOR = {
  primary: "#3ba99c",
  primaryDim: "#2c7f76",
  accent: "#e8a33d",
  ok: "#4caf7d",
  warn: "#e0a02e",
  err: "#e05c5c",
  text: "#d8e0e2",
  dim: "#8d9a9e",
};

/* ---------------------------------------------------------------- 日志 */

export function log(...args) {
  console.log(PREFIX, ...args);
}

export function warn(...args) {
  console.warn(PREFIX, ...args);
}

export function error(...args) {
  console.error(PREFIX, ...args);
}

/* ---------------------------------------------------------------- 样式 */

let themeInjected = false;

/** 把 m8_theme.css 挂进页面。
 *  用 import.meta.url 推导路径，这样插件文件夹被改名也不会失联。 */
export function injectTheme() {
  /* 顺手把界面文案拉一次。每个节点文件顶部都会调 injectTheme，所以这里是最早
     且必然会执行的时机 —— 拉到之后 t() 才有中文可用，拉不到的窗口期用英文兜底。 */
  loadUiStrings();
  if (themeInjected) return;
  themeInjected = true;
  try {
    const url = new URL("./m8_theme.css", import.meta.url).href;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    document.head.appendChild(link);
  } catch (exc) {
    warn("主题样式没挂上：", exc);
  }
}

/* ---------------------------------------------------------------- 接口 */

/** M8 接口的错误对象。前端拿到 code 就能去 docs/ERROR-PLAYBOOK.md 查。 */
export class M8ApiError extends Error {
  constructor(payload, status) {
    super(payload?.error || `接口返回 ${status}`);
    this.name = "M8ApiError";
    this.code = payload?.code || "M8-SRV-000";
    this.hint = payload?.hint || "";
    this.detail = payload?.detail || "";
    this.status = status;
  }
}

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  let response;
  try {
    response = api?.fetchApi ? await api.fetchApi(url, options) : await fetch(url, options);
  } catch (exc) {
    throw new M8ApiError({ code: "M8-SRV-001", error: "连不上插件后端", hint: "确认 ComfyUI 还在运行，然后刷新页面" });
  }

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new M8ApiError({ code: "M8-SRV-001", error: "后端返回的不是 JSON", detail: text.slice(0, 300) }, response.status);
  }

  if (!response.ok || payload?.ok === false) {
    throw new M8ApiError(payload, response.status);
  }
  return payload || {};
}

export function apiGet(path, params) {
  const query = params ? "?" + new URLSearchParams(params).toString() : "";
  return request(path + query, { method: "GET" });
}

export function apiPost(path, body) {
  return request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/**
 * 上传一个或多个文件。
 *
 * files 是 File 列表。目录上传时（webkitdirectory），每个 File 带
 * webkitRelativePath（形如 myskill/SKILL.md），要拿它当字段名 ——
 * 后端靠这个相对路径还原出整个包的结构，只传 file.name 的话结构就丢了。
 */
export function apiUpload(path, files) {
  const list = Array.isArray(files) ? files : [files];
  const form = new FormData();
  for (const file of list) {
    const rel = file.webkitRelativePath || file.name;
    form.append("files", file, rel);
  }
  // 不设 Content-Type —— 让浏览器自己带 multipart 的 boundary
  return request(path, { method: "POST", body: form });
}

/* ---------------------------------------------------------------- 通知 */

let toastBox = null;

/** 页面顶部滑入的通知。几秒后自己走。
 *  kind: "info" | "ok" | "warn" | "err" | "busy"
 *  code: 有错误码就显示出来，方便去手册查 */
export function notify(message, { kind = "info", hint = "", code = "", timeout = 4200 } = {}) {
  injectTheme();
  if (!toastBox) {
    toastBox = document.createElement("div");
    toastBox.className = "m8-toasts";
    document.body.appendChild(toastBox);
  }

  const toast = document.createElement("div");
  toast.className = "m8-toast";

  const head = document.createElement("div");
  head.className = "m8-toast-head";
  if (code) {
    const badge = document.createElement("span");
    badge.className = "m8-toast-code";
    badge.textContent = code;
    head.appendChild(badge);
  }
  head.appendChild(document.createTextNode(message));
  toast.appendChild(head);

  if (hint) {
    const hintEl = document.createElement("div");
    hintEl.className = "m8-toast-hint";
    hintEl.textContent = hint;
    toast.appendChild(hintEl);
  }

  toastBox.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("-show"));

  const kindClass = { ok: "-ok", warn: "-warn", err: "-err", busy: "-busy" }[kind];
  if (kindClass) toast.classList.add(kindClass);

  if (timeout > 0) {
    setTimeout(() => {
      toast.classList.remove("-show");
      setTimeout(() => toast.remove(), 300);
    }, timeout);
  }
  return toast;
}

/** 把 M8ApiError 变成一条通知。所有按钮的 catch 都该用它。 */
export function notifyError(exc, context = "") {
  if (exc instanceof M8ApiError) {
    error(context, exc.code, exc.message, exc.detail || "");
    return notify(context ? `${context}：${exc.message}` : exc.message, {
      kind: "err",
      hint: exc.hint,
      code: exc.code,
      timeout: 9000,
    });
  }
  error(context, exc);
  return notify(context || "出错了", { kind: "err", hint: String(exc?.message || exc), timeout: 9000 });
}

/* ---------------------------------------------------------------- 外观 */

/** 给节点套上 M8 的品牌外观。青绿标题栏 = 这是 M8 的节点。 */
export function brand(node, { color = COLOR.primary, background = "#22282b" } = {}) {
  try {
    node.color = color;
    node.bgcolor = background;
  } catch (exc) {
    warn("节点配色没设上：", exc);
  }
}

/** 改节点标题栏颜色来表示状态。
 *  state: "idle" | "busy" | "ok" | "err" */
export function setStatus(node, state, note = "") {
  const colors = {
    idle: COLOR.primary,
    busy: COLOR.accent,
    ok: COLOR.ok,
    err: COLOR.err,
  };
  node.m8State = state;
  node.m8Note = note;
  brand(node, { color: colors[state] || COLOR.primary });
  app.graph?.setDirtyCanvas(true, true);
}

// drawStatusNote 删掉了：原本想在节点右下角画状态文字，
// 后来改用 setStatus 换标题栏颜色 —— 更省地方，也不用每帧重绘。
// 留着会让下一个人以为它还在用。

/* ---------------------------------------------------------------- 控件 */

/** 加一个按钮控件。
 *  label 支持 `文字|状态` 两段，第二段会用小字显示在右边（比如进度）。 */
export function addButton(node, label, handler, { tooltip = "" } = {}) {
  let busy = false;
  const widget = node.addWidget("button", label, null, async () => {
    if (busy) {
      warn(`${label}：上一次还没跑完`);
      return;
    }
    busy = true;
    try {
      await handler();
    } catch (exc) {
      notifyError(exc, label);
    } finally {
      busy = false;
    }
  });
  widget.serialize = false;   // 按钮不进工作流
  widget.serializeValue = async () => undefined;
  if (tooltip) {
    widget.tooltip = tooltip;
    if (widget.element) widget.element.title = tooltip;
  }
  return widget;
}

/** 改一个 combo 控件的候选项，尽量保住当前选中的值。
 *  model / skill 这类「后端才知道有哪些」的下拉都走它。 */
export function setComboOptions(widget, values, { keep = true } = {}) {
  if (!widget || !Array.isArray(values) || !values.length) return;
  const previous = widget.value;
  widget.options = widget.options || {};
  widget.options.values = values;
  if (keep && previous && values.includes(previous)) {
    widget.value = previous;
  } else if (!values.includes(widget.value)) {
    widget.value = values[0];
  }
}

/** 找一个 widget。按名字查，别用下标 —— 下标会因为加个字段就错位。 */
export function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/** 拿到 widget 的取值回调链上再套一个函数（不需要就保持原样）。 */
export function onWidgetChange(node, name, handler) {
  const widget = findWidget(node, name);
  if (!widget) return null;
  const original = widget.callback;
  widget.callback = function (...args) {
    const result = original?.apply(this, args);
    handler(widget.value, widget);
    return result;
  };
  return widget;
}

/** 把一个 widget 收起来。
 *
 *  ComfyUI 没有官方的隐藏 API。要同时做三件事，少一件就会出现
 *  「收起来还能看见」或者「展开了却出不来」：
 *
 *    1. widget.hidden 和 widget.options.hidden —— 前端读的是这两个（1.51 里
 *       的判定就是 options.hidden ?? false），只看 computeSize 是没用的。
 *    2. DOM widget 的 element.style.display —— 输入框是真 DOM 节点，不走 canvas 绘制。
 *    3. computeSize 压到 -4 —— canvas 模式下的老办法，让高度算成负的。
 *
 *  vue 节点模式下尺寸由前端框架摆，第 3 条不能做，做了反而会把它撑坏。
 */
export function hideWidget(widget) {
  if (!widget || widget.m8Hidden) return;
  widget.m8Hidden = true;

  widget.hidden = true;
  widget.options = widget.options || {};
  widget.options.hidden = true;
  if (widget.element) widget.element.style.display = "none";

  if (!window.LiteGraph?.vueNodesMode) {
    widget.m8OriginalComputeSize = widget.computeSize;
    widget.m8OriginalDraw = widget.draw;
    widget.computeSize = () => [0, -4];
    widget.draw = () => {};
  }
}

export function showWidget(widget) {
  if (!widget || !widget.m8Hidden) return;
  widget.m8Hidden = false;

  widget.hidden = false;
  widget.options = widget.options || {};
  widget.options.hidden = false;
  if (widget.element) widget.element.style.display = "";

  if (!window.LiteGraph?.vueNodesMode) {
    // 优先把原来那份塞回去；本来就没有实例属性的，就删掉覆写让它回到原型实现。
    // 直接赋一个自己编的尺寸函数是不行的 —— 多行输入框该多高只有它自己知道。
    if (widget.m8OriginalComputeSize) {
      widget.computeSize = widget.m8OriginalComputeSize;
    } else {
      delete widget.computeSize;
    }
    if (widget.m8OriginalDraw) {
      widget.draw = widget.m8OriginalDraw;
    } else {
      delete widget.draw;
    }
  }
}

// remember / recall 删掉了：节点属性直接用 node.properties 读写就行，
// 包一层没有增加任何东西，反而多两个要维护的导出。

/* ---------------------------------------------------------------- 布局 */


/* ---------------------------------------------------------------- / 补全 */

/* ---------------------------------------------------------------- 界面语言 */

/* 代码里的界面字符串一律英文（ComfyUI 审核的硬要求），中文放在
   locales/zh/main.json 的 ui 段里，由 /m8/i18n/zh 取回来。

   语言从 ComfyUI 的设置项 Comfy.Locale 读；老版本没有那个设置项就退回浏览器语言。
   只有中文环境才去拉那份翻译，其余一律用代码里的英文原文。 */
export function isChinese() {
  let loc = "";
  try {
    loc = app?.extensionManager?.setting?.get?.("Comfy.Locale") || "";
  } catch (exc) {
    /* 老版本没有这个设置项，走下面的兜底 */
  }
  if (!loc) loc = (typeof navigator !== "undefined" && navigator.language) || "";
  return String(loc).toLowerCase().startsWith("zh");
}

let uiStrings = {};
let uiLoaded = false;

/** 拉一次中文界面文案。非中文环境直接返回空表，一次请求都不发。 */
export function loadUiStrings() {
  if (uiLoaded) return Promise.resolve(uiStrings);
  uiLoaded = true;
  if (!isChinese()) return Promise.resolve(uiStrings);
  return apiGet("/i18n/zh")
    .then((data) => {
      uiStrings = (data && data.strings && data.strings.ui) || {};
      return uiStrings;
    })
    .catch((exc) => {
      warn("拿界面文案失败，用英文：", exc.message);
      return uiStrings;
    });
}

/** 取一条界面文案。取不到就用 fallback —— 也就是代码里写的英文原文。
 *
 *  vars 是占位符表：文案里写 `{name}`，这里传 `{ name: 实际值 }`。
 *  为什么不用 JS 的模板字符串直接拼：中文那份存在 json 里，拼不了模板，只能用占位符。 */
export function t(key, fallback, vars) {
  let node = uiStrings;
  for (const part of String(key).split(".")) {
    if (!node || typeof node !== "object") node = undefined;
    else node = node[part];
  }
  let text = typeof node === "string" && node ? node : fallback;
  if (vars && typeof text === "string") {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split("{" + k + "}").join(String(v));
    }
  }
  return text;
}

/** 绑到一个节点上，省得每处都拼前缀：const T = M8.tFor("M8LLMInference") */
export function tFor(nodeKey) {
  return (key, fallback, vars) => t(nodeKey + "." + key, fallback, vars);
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

/** 把 text 里和 query 重合的那一段包成 <mark>。
 *  只高亮第一处：skill 名字通常很短，高亮多处反而让人看不清匹配到哪。 */
function highlightMatch(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return safe;
  const end = at + query.length;
  return escapeHtml(text.slice(0, at))
    + "<mark>" + escapeHtml(text.slice(at, end)) + "</mark>"
    + escapeHtml(text.slice(end));
}

/** 看光标前面是不是一个没写完的 /引用。
 *
 *  返回 {start, end, query} 或 null。不用正则的 lookbehind —— Safari 16.4 以下不支持，
 *  而这里的判断逻辑简单到手工写更清楚。
 */
function readMention(input, trigger) {
  const caret = input.selectionStart;
  if (caret == null) return null;
  const before = input.value.slice(0, caret);
  const at = before.lastIndexOf(trigger);
  if (at < 0) return null;

  // 斜杠前面不能是字母数字或冒号斜杠：挡掉 http://x、a/b、C:/path
  const previous = at > 0 ? before[at - 1] : "";
  if (previous && /[A-Za-z0-9:/]/.test(previous)) return null;

  // 斜杠和光标之间不能有空白，否则这个引用已经写完了
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;

  return { start: at, end: caret, query };
}

function rankAndFilter(items, query) {
  const q = (query || "").toLowerCase();
  if (!q) return items.slice(0, 40);

  const scored = [];
  for (const item of items) {
    const name = (item.stem || item.name || "").toLowerCase();
    const full = (item.name || "").toLowerCase();
    const idx = name.indexOf(q);
    if (idx < 0 && full.indexOf(q) < 0) continue;
    // 前缀命中排最前，其次按命中位置，最后按名字长短
    scored.push({ item, rank: idx === 0 ? 0 : idx > 0 ? 1 : 2, idx: idx < 0 ? 999 : idx, len: name.length });
  }
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx || a.len - b.len);
  return scored.map((entry) => entry.item);
}

/** 给任意一个输入框挂上「输入触发符弹出候选」的行为。
 *
 *  键盘：上下选、回车 / Tab 确认、Esc 关掉。
 *  这些按键必须拦住，否则会冒泡到画布，变成移动节点。
 *
 *  它只管一个原生 input / textarea，不认识 ComfyUI 的 widget ——
 *  节点的 widget 由下面的 attachMentionAutocomplete 包一层；
 *  对话框那种自己造的输入框直接用它。
 */
export function attachMention(input, {
  getItems = async () => [],
  trigger = "/",
  maxItems = 8,
  emptyHint = "还没有可引用的内容。",
} = {}) {
  if (!input) return null;

  let items = [];
  let itemsAt = 0;
  let filtered = [];
  let active = 0;
  let mention = null;
  let panel = null;
  let wasOpen = false;

  // 列表缓存 15 秒：够短，别处刚上传完 skill 很快就能在这里看到；
  // 又不至于每敲一个字母都去问一次后端。
  const CACHE_MS = 15000;

  function buildPanel() {
    panel = document.createElement("div");
    panel.className = "m8-mention";
    document.body.appendChild(panel);
    // 用 mousedown 而不是 click：blur 会先于 click 触发，click 永远等不到
    panel.addEventListener("mousedown", (event) => {
      const row = event.target.closest(".m8-mention-item");
      if (!row) return;
      event.preventDefault();
      pick(Number(row.dataset.index));
    });
    return panel;
  }

  function place() {
    if (!panel || !panel.classList.contains("-show")) return;
    const rect = input.getBoundingClientRect();
    const height = panel.offsetHeight || 200;
    // 默认向上弹：输入框下沿常常已经贴着画布底部了
    let top = rect.top - height - 6;
    if (top < 8) top = rect.bottom + 6;
    const width = Math.min(Math.max(rect.width, 240), 420);
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    panel.style.top = `${Math.max(8, top)}px`;
    panel.style.left = `${Math.max(8, left)}px`;
    panel.style.width = `${width}px`;
  }

  function render() {
    if (!panel) return;
    if (!mention) {
      panel.classList.remove("-show");
      return;
    }

    panel.innerHTML = "";

    if (!items.length) {
      panel.innerHTML = `<div class="m8-mention-empty">${escapeHtml(emptyHint)}</div>`;
    } else if (!filtered.length) {
      panel.innerHTML = `<div class="m8-mention-empty">没有匹配「${escapeHtml(mention.query)}」的 skill</div>`;
    } else {
      filtered.slice(0, maxItems).forEach((item, index) => {
        const row = document.createElement("div");
        row.className = "m8-mention-item" + (index === active ? " -active" : "");
        row.dataset.index = String(index);

        const name = document.createElement("div");
        name.className = "m8-mention-name";
        name.innerHTML = highlightMatch(item.stem || item.name || "", mention.query);
        row.appendChild(name);

        if (item.title) {
          const title = document.createElement("div");
          title.className = "m8-mention-title";
          title.textContent = item.title;
          row.appendChild(title);
        }

        const meta = document.createElement("div");
        meta.className = "m8-mention-meta";
        meta.textContent = item.sizeText || "";
        row.appendChild(meta);

        panel.appendChild(row);
      });
    }

    const hint = document.createElement("div");
    hint.className = "m8-mention-hint";
    hint.textContent = "↑↓ 选择 · Enter 确认 · Esc 取消";
    panel.appendChild(hint);

    panel.classList.add("-show");
    place();
  }

  function scrollActiveIntoView() {
    const row = panel?.querySelector(`.m8-mention-item[data-index="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }

  function pick(index) {
    const item = filtered[index];
    if (!item || !mention) return close();

    const value = input.value;
    const inserted = trigger + (item.stem || item.name);
    input.value = value.slice(0, mention.start) + inserted + " " + value.slice(mention.end);

    const caret = mention.start + inserted.length + 1;
    input.setSelectionRange(caret, caret);

    // 通知 ComfyUI 值变了，否则 widget.value 还是旧的
    input.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    input.focus();
  }

  function close() {
    mention = null;
    filtered = [];
    active = 0;
    panel?.classList.remove("-show");
  }

  async function refreshItems() {
    try {
      items = (await getItems()) || [];
      itemsAt = Date.now();
    } catch (exc) {
      items = [];
      warn("拉 skill 列表失败，补全暂时不可用：", exc.message || exc);
    }
  }

  function isStale() {
    return Date.now() - itemsAt > CACHE_MS;
  }

  function update() {
    mention = readMention(input, trigger);
    if (!mention) {
      close();
      wasOpen = false;
      return;
    }

    // 只在「刚打出触发符」时去后端拉，不是每敲一个字都拉
    const justOpened = !wasOpen;
    wasOpen = true;

    if (justOpened && (!items.length || isStale())) {
      refreshItems().then(() => {
        if (!mention) return;
        filtered = rankAndFilter(items, mention.query);
        active = 0;
        render();
      });
      if (!panel) buildPanel();
      panel.innerHTML = '<div class="m8-mention-empty">正在读取 skill 列表…</div>';
      panel.classList.add("-show");
      place();
      return;
    }

    if (!panel) buildPanel();
    filtered = rankAndFilter(items, mention.query);
    if (active >= filtered.length) active = 0;
    render();
  }

  input.addEventListener("input", update);

  input.addEventListener("keydown", (event) => {
    if (!mention || !panel?.classList.contains("-show")) return;

    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (step) {
      event.preventDefault();
      event.stopPropagation();
      if (filtered.length) {
        active = (active + step + filtered.length) % Math.min(filtered.length, maxItems);
        render();
        scrollActiveIntoView();
      }
      return;
    }

    if (event.key === "Enter" || event.key === "Tab") {
      // 没有候选时放行回车：那时候用户是想换行或提交，不是在选东西
      if (!filtered.length) return;
      event.preventDefault();
      event.stopPropagation();
      pick(active);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  });

  input.addEventListener("blur", () => setTimeout(close, 120));
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, true);

  log(`输入框已挂上 ${trigger} 补全`);
  return { close, refresh: refreshItems, get panel() { return panel; } };
}

/** 把补全挂到某个节点 widget 的输入框上。
 *
 *  节点上的输入框是 ComfyUI 造的（widget.inputEl），先找到它再交给
 *  attachMention —— 两者共用同一套交互，行为不会有差别。
 */
export function attachMentionAutocomplete(node, widgetName, options = {}) {
  const widget = findWidget(node, widgetName);
  const input = widget?.inputEl;
  if (!input) {
    warn(`${widgetName} 没有 DOM 输入框（被转成 input 了？），跳过补全`);
    return null;
  }
  return attachMention(input, options);
}

/** 让节点重新算高度。加了控件之后调一下，否则新控件会被挤出可视区。 */
export function relayout(node) {
  requestAnimationFrame(() => {
    try {
      const size = node.computeSize();
      node.setSize([Math.max(node.size[0], size[0]), Math.max(node.size[1], size[1])]);
      app.graph?.setDirtyCanvas(true, true);
    } catch (exc) {
      warn("重排失败：", exc);
    }
  });
}
