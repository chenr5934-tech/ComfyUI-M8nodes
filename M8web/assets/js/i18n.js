/* ============================================================================
 * M8web · 界面语言
 *
 * 代码里写英文，中文放在插件的 locales/zh/main.json 的 `web` 段里 ——
 * 和节点、小鲸鱼那边共用同一份语言文件，只是各取各的段（ui / nodeDefs / web）。
 * 普通 ComfyUI 走插件的 /m8/i18n/<lang>，独立服务由 m8-serve.py 提供同一个路由。
 *
 * 为什么不做成一套编译期的模板替换：工作台里绝大多数文案是 JS 在运行时拼的
 * （状态行、通知、报错），塞进 HTML 也没用。所以走查表。
 *
 * 语言判定顺序：?lang= 参数 -> localStorage -> 浏览器语言。
 * 参数那一档是为了调试方便，也让「我想固定用中文」有个说法。
 * ==========================================================================*/

const STORE_KEY = "m8web.lang";
const ZH = /^zh\b/i;

let strings = {};
let ready = null;

/** 现在该用哪种语言。返回 "zh" 或 "en"。 */
export function currentLang() {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q) return ZH.test(q) ? "zh" : "en";
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) return ZH.test(saved) ? "zh" : "en";
  } catch (exc) {
    /* 隐私模式下 localStorage 会抛，不影响下面的兜底 */
  }
  const nav = (typeof navigator !== "undefined" && (navigator.language || navigator.languages?.[0])) || "";
  return ZH.test(nav) ? "zh" : "en";
}

export function isChinese() {
  return currentLang() === "zh";
}

/** 拉一次语言包。非中文环境直接返回空表，一个请求都不发。 */
export function loadStrings() {
  if (ready) return ready;
  ready = (async () => {
    if (!isChinese()) return strings;
    try {
      const res = await fetch("/m8/i18n/zh");
      if (!res.ok) return strings;
      const data = await res.json();
      strings = (data && data.strings && data.strings.web) || {};
    } catch (exc) {
      // 拿不到就用代码里的英文原文，不拦着界面起来
      console.warn("[M8web] 读取界面文案失败，用英文：", exc?.message || exc);
    }
    return strings;
  })();
  return ready;
}

/**
 * 取一条文案。取不到就用 fallback —— 也就是代码里写的英文原文。
 *
 * vars 是占位符表：文案里写 `{name}`，这里传 `{ name: 实际值 }`。
 * 不用模板字符串直接拼，是因为译文存在 json 里，拼不了。
 */
export function t(key, fallback, vars) {
  const node = strings[key];
  let text = typeof node === "string" && node ? node : fallback;
  if (vars && typeof text === "string") {
    for (const [k, v] of Object.entries(vars)) {
      text = text.split("{" + k + "}").join(String(v));
    }
  }
  return text;
}

/**
 * 把 HTML 里带 data-i18n 的节点换成译文。
 *
 * 用 textContent 而不是 innerHTML：文案里不该出现标签，而且这样天然防注入。
 * 需要保留标签的地方用 data-i18n-attr="title:键名" 单独处理属性。
 */
export function applyDom(root = document) {
  // <title> 拿不到 data-i18n（它在 head 里，不方便逐页重复），
  // 所以约定写在 <html data-i18n-title="键名"> 上。
  const titleKey = document.documentElement.dataset.i18nTitle;
  if (titleKey) document.title = t(titleKey, document.title);

  for (const node of root.querySelectorAll("[data-i18n]")) {
    // HTML 里写的就是英文原文，直接拿它当 fallback —— 不用再挂个属性重复一遍
    node.textContent = t(node.dataset.i18n, node.textContent);
  }

  // 少数文案里带 <strong> 之类的行内标签，纯 textContent 会把标签当字面量显示。
  // 这档走 innerHTML，所以**只能**给它我们自己的语言包内容 —— 绝不要把它
  // 接到任何来自用户、接口或文件名之类的外部字符串上。
  for (const node of root.querySelectorAll("[data-i18n-html]")) {
    const key = node.dataset.i18nHtml;
    const hit = strings[key];
    if (typeof hit === "string" && hit) node.innerHTML = hit;
  }
  for (const node of root.querySelectorAll("[data-i18n-attr]")) {
    // 形如 "title:mkShortcutTip,placeholder:somePlaceholder"
    for (const pair of node.dataset.i18nAttr.split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (!attr || !key) continue;
      const current = node.getAttribute(attr) || "";
      node.setAttribute(attr, t(key, current));
    }
  }
}

/** 启动流程：拉文案、换 HTML、再交给回调。 */
export async function bootI18n(beforeRender) {
  await loadStrings();
  applyDom();
  if (typeof beforeRender === "function") beforeRender();
}

/** 页面标题也跟着语言走（title 不在 applyDom 的扫描范围里）。 */
export function setTitle(key, fallback) {
  document.title = t(key, fallback);
}

/* app.js 和那些功能模块是普通脚本（靠全局函数互相调用），拿不到 import。
   这里再挂一份到 window，module 和普通脚本两种加载方式都能用同一套。 */
window.M8I18n = { t, loadStrings, applyDom, bootI18n, isChinese, currentLang, setTitle };
