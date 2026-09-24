/* ============================================================================
 * M8web · 外壳脚本
 *
 * 只做三件事：功能清单、侧栏、主题。
 * 侧栏和首页卡片都从 FEATURES 生成 —— 加一个功能只改这一处，
 * 不用去每张页面改菜单。
 * ==========================================================================*/

/* 界面文案走 i18n.js。它是 module，而这些功能脚本是普通脚本，拿不到 import ——
   i18n.js 因此挂了一份到 window。

   用 var 而不是 const：普通脚本共享全局作用域，const 在这里重复声明会直接报
   "Identifier 'T' has already been declared"，一个页面同时加载几个脚本就白屏。
   var 重复声明是合法的，每个文件仍然自足，不依赖加载顺序。

   宿主对象用 globalThis 取而不是直接写 window：前端测试在 Node 里跑这些脚本，
   那边没有 window，直接解引用会当场 "window is not defined"。

   i18n 没加载成功时走这里的兜底：**必须自己填占位符** —— 直接返回 fallback 的话，
   界面上会原样显示 "{h} h {m} min" 这种花括号，比换不成中文更糟。 */
var T = function (key, fallback, vars) {
  var host = typeof globalThis !== "undefined" ? globalThis : {};
  var i18n = host.M8I18n;
  if (i18n && typeof i18n.t === "function") return i18n.t(key, fallback, vars);

  var text = fallback === undefined ? key : fallback;
  if (vars && typeof text === "string") {
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        text = text.split("{" + k + "}").join(String(vars[k]));
      }
    }
  }
  return text;
};

/* 功能清单（唯一事实来源）
 *   id      页面文件名 pages/<id>.html
 *   icon    侧栏图标
 *   name    功能名
 *   kicker  卡片左上角那行小字
 *   desc    卡片说明
 *   tone    卡片强调色，tone2 是渐变的第二色（参考站每张卡都自带配色）
 *
 * 注意：功能页现在都是空状态，但**可以点进去** ——
 * 外壳（侧栏高亮、顶栏、面包屑、空状态）得能走通，否则框架没法验。 */
const FEATURES = [
  {
    id: "image-editor",
    icon: "🖼",
    name: "Image Workshop",
    kicker: "Image",
    desc: "Cut an image into rows or columns, drag the guides around, mute the pieces you do not want, preview before exporting.",
    tone: "#62d3c9",
    tone2: "#e3b76f",
  },
  {
    id: "oc",
    icon: "🎭",
    name: "OC Workshop",
    kicker: "Character",
    desc: "One entry per original character: sample image and trait tags kept together, ready to copy in one click.",
    tone: "#c9a6f5",
    tone2: "#7ad6d6",
  },
  {
    id: "prompts",
    icon: "🗂",
    name: "Prompt Collection",
    kicker: "Prompts",
    desc: "One card per concept prompt, filed under a category and copied in one click when you need it.",
    tone: "#f0a868",
    tone2: "#8ab8e8",
  },
  {
    id: "meta",
    icon: "🔍",
    name: "Image Metadata",
    kicker: "Inspect",
    desc: "Drop in an image and read back its generation parameters, workflow and EXIF - parsed entirely on this machine.",
    tone: "#48d4ca",
    tone2: "#e5c776",
  },
  {
    id: "lora",
    icon: "🎛",
    name: "LoRA Inspector",
    kicker: "Models",
    desc: "Drop in a safetensors file and read back its training parameters and tags - only the first few KB, cleared afterwards.",
    tone: "#7aa2d6",
    tone2: "#d89ac7",
  },
  {
    id: "obfuscate",
    icon: "🌀",
    name: "Image Obfuscation",
    kicker: "Obfuscate",
    desc: "Scramble or nest an image to hide it; the same key restores it exactly - all computed on this machine.",
    tone: "#9fb4e8",
    tone2: "#6ed3b6",
  },
  {
    id: "pixel",
    icon: "👾",
    name: "Pixel Art Conversion",
    kicker: "Pixel",
    desc: "Compress an image into pixel art with convolution: antialiasing, area averaging, sharpening, colour-reduction dithering, nearest-neighbour upscale.",
    tone: "#7fd98a",
    tone2: "#f2cd6b",
  },
];

/* 四套主题。id 必须和 base.css 里的 :root[data-theme=...] 对上 */
const THEMES = [
  { id: "day", name: "Day" },
  { id: "night", name: "Night" },
  { id: "sakura", name: "Sakura pink" },
  { id: "ocean", name: "Ocean blue" },
];

const THEME_KEY = "m8web.theme";
const SIDE_KEY = "m8web.side";
const DEFAULT_THEME = "night";

/* ---------------------------------------------------------------- 存储 */

function readStore(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* 隐身模式写不进去，不影响使用 */
  }
}

/* ---------------------------------------------------------------- 主题 */

/* 主题挂在 <html> 上。head 里那段防闪脚本设的也是 documentElement，
   两处必须是同一个元素，否则点了按钮会被盖回去。 */
function applyTheme(id) {
  document.documentElement.dataset.theme = id;
  writeStore(THEME_KEY, id);
  const box = document.querySelector(".themes");
  if (!box) return;
  box.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.t === id;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderThemes() {
  if (document.querySelector(".themes")) return;
  const box = document.createElement("div");
  box.className = "themes";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", T("theme", "Theme"));
  box.innerHTML = THEMES.map(
    (t) => '<button type="button" data-t="' + t.id + '" aria-pressed="false">'
      + T("theme." + t.id, t.name) + "</button>",
  ).join("");
  box.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => applyTheme(b.dataset.t));
  });
  document.body.appendChild(box);
}

/* ---------------------------------------------------------------- 侧栏 */

function renderSidebar(activeId, base) {
  const side = document.createElement("aside");
  side.className = "side";

  const items = FEATURES.map((f) => {
    const cls = ["nav-item", f.id === activeId ? "active" : ""].filter(Boolean).join(" ");
    return (
      '<a class="' + cls + '" href="' + base + "pages/" + f.id + '.html">' +
      '<span class="ico">' + f.icon + "</span>" +
      '<span class="label">' + T("feat." + f.id + ".name", f.name) + "</span>" +
      "</a>"
    );
  }).join("");

  side.innerHTML =
    '<a class="brand" href="' + base + 'index.html">' +
    '<span class="mark">M8</span><span class="word">' + T("brand", "M8 Workbench") + "</span>" +
    "</a>" +
    '<nav class="nav">' +
    '<a class="nav-item" href="' + base + 'index.html">' +
    '<span class="ico">⌂</span><span class="label">' + T("navHome", "Back to home") + "</span>" +
    "</a>" +
    '<div class="nav-group">' + T("navGroup", "Features") + "</div>" +
    items +
    "</nav>" +
    '<div class="side-foot">' +
    '<button class="side-toggle" id="sideToggle" type="button">' +
    '<span class="ico">⇔</span><span class="label">' + T("sideCollapse", "Collapse sidebar") + "</span>" +
    "</button>" +
    "</div>";

  const toggle = side.querySelector("#sideToggle");
  const label = toggle ? toggle.querySelector(".label") : null;
  const collapsed = document.documentElement.classList.contains("is-side-collapsed");
  if (label && collapsed) label.textContent = T("sideExpand", "Expand sidebar");
  if (toggle) {
    toggle.setAttribute("title", collapsed ? T("sideExpand", "Expand sidebar") : T("sideCollapse", "Collapse sidebar"));
    toggle.addEventListener("click", () => {
      const root = document.documentElement;
      root.classList.toggle("is-side-collapsed");
      const off = root.classList.contains("is-side-collapsed");
      writeStore(SIDE_KEY, off ? "1" : "0");
      if (label) label.textContent = off ? T("sideExpand", "Expand sidebar") : T("sideCollapse", "Collapse sidebar");
      toggle.setAttribute("title", off ? T("sideExpand", "Expand sidebar") : T("sideCollapse", "Collapse sidebar"));
    });
  }

  return side;
}

function mountSidebar(activeId, base) {
  const host = document.getElementById("sidebar");
  if (!host) return;
  host.replaceWith(renderSidebar(activeId, base));
}

/* ---------------------------------------------------------------- 工具页顶栏 */

function renderTopbar(host, title, base) {
  if (!host) return;
  host.innerHTML =
    "<h1>" + title + "</h1>" +
    '<span class="crumb"><a href="' + base + 'index.html">' + T("brand", "M8 Workbench") + "</a></span>";
}

/* ---------------------------------------------------------------- 首页卡片 */

function renderCards(host) {
  if (!host) return;
  host.innerHTML = FEATURES.map((f) => {
    const style = "--tone:" + f.tone + ";--tone-2:" + f.tone2 + ";";
    return (
      '<a class="card" href="pages/' + f.id + '.html" style="' + style + '">' +
      '<span class="card-kicker">' + T("feat." + f.id + ".kicker", f.kicker) + "</span>" +
      "<strong>" + T("feat." + f.id + ".name", f.name) + "</strong>" +
      "<small>" + T("feat." + f.id + ".desc", f.desc) + "</small>" +
      "</a>"
    );
  }).join("");
}

/* ---------------------------------------------------------------- 数据访问 */

/* 工作台的数据从这儿进出。以前存在浏览器的 IndexedDB 里，问题是那个东西挂在
   「源」上：换成 localhost 打开、清浏览器数据、换台机器就都看不见了，而且
   CUI 一关，提供那个源的服务就没了。现在改存服务器上的文件
   （<ComfyUI>/models/M8data/webapp/*.json），CUI 和独立服务读写的是同一份。

   路径从 location 推，不写死：ComfyUI 挂在子路径下（/comfy/m8/web/）也对得上。 */
var M8Api = (function () {
  function base() {
    const p = window.location.pathname;
    const i = p.indexOf("/m8/web/");
    return (i >= 0 ? p.slice(0, i) : "") + "/m8/data/";
  }

  function call(path, opt) {
    return fetch(base() + path, opt).then(function (res) {
      return res.json().catch(function () {
        throw new Error(T("badResponse", "The backend did not return usable data (is it running?)"));
      });
    }).then(function (data) {
      if (!data || !data.ok) {
        throw new Error((data && (data.hint || data.error)) || T("actionFailed", "The action failed"));
      }
      return data;
    });
  }

  function post(path, payload) {
    return call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  return {
    base: base,
    /* 读一整类，拿到一个数组。读不到就是空数组，不抛 —— 
       某个文件坏了不该让整个功能打不开。 */
    list: function (kind) {
      return call(kind).then(function (d) { return d.rows || []; })
        .catch(function () { return []; });
    },
    /* 存一条。没带 id 就新建，返回最终的 id。 */
    put: function (kind, rec) {
      return post(kind + "/put", { record: rec }).then(function (d) { return d.id; });
    },
    del: function (kind, id) {
      return post(kind + "/delete", { id: id }).then(function (d) { return !!d.removed; });
    },
    /* 整份换掉。导入备份走这条。 */
    replace: function (kind, rows) {
      return post(kind + "/replace", { rows: rows }).then(function (d) { return d.count; });
    },
    /* 数据目录在哪、有没有在跑 —— 界面上偶尔要显示 */
    health: function () {
      const p = window.location.pathname;
      const i = p.indexOf("/m8/web/");
      const root = (i >= 0 ? p.slice(0, i) : "") + "/m8/";
      return fetch(root + "health").then(function (r) { return r.json(); }).catch(function () { return null; });
    },
  };
})();

/* ---------------------------------------------------------------- 旧数据搬运 */

/* 数据以前存在浏览器的 IndexedDB 里，现在改成存服务器文件了。升级之后旧数据
   会「看不见」—— 它还在浏览器里，只是没人去读（而且「导出备份」也救不了它，
   那个按钮读的是新位置）。所以这儿检查一次，有就摆在页面顶上问一句。
   搬到就删旧库，免得每次开页面都问。 */
function checkOldData() {
  if (typeof M8Migrate === "undefined" || !M8Migrate) return;
  M8Migrate.scan().then(function (items) {
    if (!items || !items.length) return;
    showMigrateBar(items);
  }).catch(function () { /* 查不了就算了，别打扰用户 */ });
}

function showMigrateBar(items) {
  const total = items.reduce(function (n, it) { return n + it.rows.length; }, 0);
  const bar = document.createElement("div");
  bar.className = "migrate-bar";

  const text = document.createElement("span");
  text.className = "migrate-text";
  text.textContent = T("migrateFound", "There is still old data in this browser ({n} entries: ", { n: total }) 
    + items.map(function (it) {
      return T("migrateKinds." + it.kind, it.label) + " " + it.rows.length;
    }).join(", ")
    + T("migrateAsk", "). Data lives on the server now. Move it over?");

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "gen-btn";
  yes.textContent = T("migrateYes", "Move it");

  const no = document.createElement("button");
  no.type = "button";
  no.className = "ghost-btn";
  no.textContent = T("migrateNo", "Not now");
  no.addEventListener("click", function () { bar.remove(); });

  yes.addEventListener("click", function () {
    yes.disabled = true;
    text.textContent = T("migrateBusy", "Moving...");
    M8Migrate.run(items).then(function (n) {
      return M8Migrate.dropOld().then(function () { return n; });
    }).then(function (n) {
      text.textContent = T("migrateDone", "Done, {n} entries in total. Refresh the page to see them.", { n });
      no.textContent = T("migrateOk", "Got it");
      yes.remove();
    }).catch(function (e) {
      yes.disabled = false;
      text.textContent = T("migrateFailed", "Could not move the data: ") + (e && e.message ? e.message : String(e))
        + T("migrateFailedHint", ". Make sure the service is running and try again.");
    });
  });

  bar.appendChild(text);
  bar.appendChild(yes);
  bar.appendChild(no);
  document.body.insertBefore(bar, document.body.firstChild);
}

/* ---------------------------------------------------------------- 桌面快捷方式 */

/* 浏览器建不了快捷方式 —— 网页没有文件系统权限。所以让后端代劳。

   **后端往桌面写的是一个 .bat，内容就是「调用插件里的启动脚本」。**
   双击它会把本地服务拉起来再开浏览器，所以 CUI 开着关着都能用。

   以前做的是带图标的 .lnk —— 那个只能借 PowerShell 生成，等于「一个网页请求
   就能在本机创建进程」。这条是安全红线（审核也明确要求去掉），所以换成了纯
   文本脚本。代价是图标只能用系统默认的。

   下面那个 url 只在桌面写不进去时当兜底（只读、被组策略挡住），那时候它只能
   指向一个 http 地址，得先有人把服务起起来。 */

function shortcutURL() {
  return window.location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "") + "index.html";
}

function makeShortcut() {
  const note = document.getElementById("mkShortcutNote");
  const btn = document.getElementById("mkShortcut");
  if (note) note.textContent = T("shortcutBusy", "Creating...");
  if (btn) btn.disabled = true;
  /* 首页在 /m8/web/ 下，所以 ../shortcut 就是 /m8/shortcut */
  fetch("../shortcut/desktop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: shortcutURL(), name: T("shortcutName", "M8 Workbench") }),
  }).then(function (res) {
    return res.json();
  }).then(function (data) {
    if (!data || !data.ok) {
      throw new Error((data && (data.hint || data.error)) || T("shortcutFailed", "Could not create it"));
    }
    if (note) note.textContent = T("shortcutDone", "Created: {name} on your desktop", { name: data.fileName });
  }).catch(function (e) {
    if (note) note.textContent = T("shortcutError", "Could not create it: ") + (e && e.message ? e.message : String(e));
  }).then(function () {
    if (btn) btn.disabled = false;
  });
}

/* ---------------------------------------------------------------- 入口 */

function boot(opt) {
  const o = opt || {};
  const base = o.base || "";

  applyTheme(readStore(THEME_KEY, DEFAULT_THEME));
  renderThemes();

  if (readStore(SIDE_KEY, "0") === "1") {
    document.documentElement.classList.add("is-side-collapsed");
  }

  mountSidebar(o.activeId || "", base);
  renderTopbar(document.getElementById("topbar"), o.title || T("brand", "M8 Workbench"), base);

  /* 只有首页有那个按钮，别的页面拿不到就跳过 */
  const mk = document.getElementById("mkShortcut");
  if (mk) mk.addEventListener("click", makeShortcut);

  /* 每个页面都查一遍旧数据 —— 用户不一定从首页进来 */
  checkOldData();
}
