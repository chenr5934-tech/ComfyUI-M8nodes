/* ============================================================================
 * M8web · 外壳脚本
 *
 * 只做三件事：功能清单、侧栏、主题。
 * 侧栏和首页卡片都从 FEATURES 生成 —— 加一个功能只改这一处，
 * 不用去每张页面改菜单。
 * ==========================================================================*/

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
    name: "图片工坊",
    kicker: "图像",
    desc: "把图横着或竖着切成若干段，虚线随手拖，不要的段一键屏蔽，导出前先看预览。",
    tone: "#62d3c9",
    tone2: "#e3b76f",
  },
  {
    id: "oc",
    icon: "🎭",
    name: "OC 工坊",
    kicker: "角色",
    desc: "每个原创角色一条：例图和特征词存在一起，随时一键复制去出图。",
    tone: "#c9a6f5",
    tone2: "#7ad6d6",
  },
  {
    id: "prompts",
    icon: "🗂",
    name: "提示词归纳",
    kicker: "提示词",
    desc: "一张卡一条概念提示词，归到分类里存着，用的时候一键复制。",
    tone: "#f0a868",
    tone2: "#8ab8e8",
  },
  {
    id: "meta",
    icon: "🔍",
    name: "图片元数据",
    kicker: "解析",
    desc: "拖一张图进来，读出它的生成参数、工作流和 EXIF —— 全程在本机解析。",
    tone: "#48d4ca",
    tone2: "#e5c776",
  },
  {
    id: "lora",
    icon: "🎛",
    name: "LoRA 解析",
    kicker: "模型",
    desc: "拖一个 safetensors 进来，读出它的训练参数和标签 —— 只读开头那几 KB，读完就清。",
    tone: "#7aa2d6",
    tone2: "#d89ac7",
  },
  {
    id: "obfuscate",
    icon: "🌀",
    name: "混淆图",
    kicker: "混淆",
    desc: "置乱或嵌套两种打法把图藏起来，同一个密钥能原样解回去 —— 全程在本机算。",
    tone: "#9fb4e8",
    tone2: "#6ed3b6",
  },
  {
    id: "pixel",
    icon: "👾",
    name: "像素风转化",
    kicker: "像素",
    desc: "用卷积把图压成像素画：抗锯齿、面积平均、锐化、减色抖动、最近邻放大。",
    tone: "#7fd98a",
    tone2: "#f2cd6b",
  },
];

/* 四套主题。id 必须和 base.css 里的 :root[data-theme=...] 对上 */
const THEMES = [
  { id: "day", name: "白天" },
  { id: "night", name: "黑夜" },
  { id: "sakura", name: "樱花粉" },
  { id: "ocean", name: "海蓝" },
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
  box.setAttribute("aria-label", "主题");
  box.innerHTML = THEMES.map(
    (t) => '<button type="button" data-t="' + t.id + '" aria-pressed="false">' + t.name + "</button>",
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
      '<span class="label">' + f.name + "</span>" +
      "</a>"
    );
  }).join("");

  side.innerHTML =
    '<a class="brand" href="' + base + 'index.html">' +
    '<span class="mark">M8</span><span class="word">M8 工作台</span>' +
    "</a>" +
    '<nav class="nav">' +
    '<a class="nav-item" href="' + base + 'index.html">' +
    '<span class="ico">⌂</span><span class="label">返回首页</span>' +
    "</a>" +
    '<div class="nav-group">功能</div>' +
    items +
    "</nav>" +
    '<div class="side-foot">' +
    '<button class="side-toggle" id="sideToggle" type="button">' +
    '<span class="ico">⇔</span><span class="label">收起侧栏</span>' +
    "</button>" +
    "</div>";

  const toggle = side.querySelector("#sideToggle");
  const label = toggle ? toggle.querySelector(".label") : null;
  const collapsed = document.documentElement.classList.contains("is-side-collapsed");
  if (label && collapsed) label.textContent = "展开侧栏";
  if (toggle) {
    toggle.setAttribute("title", collapsed ? "展开侧栏" : "收起侧栏");
    toggle.addEventListener("click", () => {
      const root = document.documentElement;
      root.classList.toggle("is-side-collapsed");
      const off = root.classList.contains("is-side-collapsed");
      writeStore(SIDE_KEY, off ? "1" : "0");
      if (label) label.textContent = off ? "展开侧栏" : "收起侧栏";
      toggle.setAttribute("title", off ? "展开侧栏" : "收起侧栏");
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
    '<span class="crumb"><a href="' + base + 'index.html">M8 工作台</a></span>';
}

/* ---------------------------------------------------------------- 首页卡片 */

function renderCards(host) {
  if (!host) return;
  host.innerHTML = FEATURES.map((f) => {
    const style = "--tone:" + f.tone + ";--tone-2:" + f.tone2 + ";";
    return (
      '<a class="card" href="pages/' + f.id + '.html" style="' + style + '">' +
      '<span class="card-kicker">' + f.kicker + "</span>" +
      "<strong>" + f.name + "</strong>" +
      "<small>" + f.desc + "</small>" +
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
        throw new Error("后端没给回正经数据（可能没在跑？）");
      });
    }).then(function (data) {
      if (!data || !data.ok) {
        throw new Error((data && (data.hint || data.error)) || "操作失败");
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
  text.textContent = "浏览器里还存着旧数据（" + total + " 条：" 
    + items.map(function (it) { return it.label + " " + it.rows.length; }).join("、")
    + "）。现在数据存在服务器上了，要搬过去吗？";

  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "gen-btn";
  yes.textContent = "搬过去";

  const no = document.createElement("button");
  no.type = "button";
  no.className = "ghost-btn";
  no.textContent = "先不搬";
  no.addEventListener("click", function () { bar.remove(); });

  yes.addEventListener("click", function () {
    yes.disabled = true;
    text.textContent = "正在搬…";
    M8Migrate.run(items).then(function (n) {
      return M8Migrate.dropOld().then(function () { return n; });
    }).then(function (n) {
      text.textContent = "搬完了，一共 " + n + " 条。刷新一下页面就能看到。";
      no.textContent = "知道了";
      yes.remove();
    }).catch(function (e) {
      yes.disabled = false;
      text.textContent = "没搬成：" + (e && e.message ? e.message : String(e))
        + "。确认服务在跑，再试一次。";
    });
  });

  bar.appendChild(text);
  bar.appendChild(yes);
  bar.appendChild(no);
  document.body.insertBefore(bar, document.body.firstChild);
}

/* ---------------------------------------------------------------- 桌面快捷方式 */

/* 浏览器建不了快捷方式 —— 网页没有文件系统权限。所以让后端代劳。

   **后端做的是一个指向启动脚本的 .lnk，不是指向某个网址的 .url。**
   这个区别很关键：.url 只能开一个地址，所以必须先有人把服务起起来 ——
   ComfyUI 一关就白搭（第一版就是这么做的，用户点开是打不开的）。
   .lnk 指向 M8web/启动工作台.bat，双击它会把本地服务拉起来再开浏览器，
   CUI 开着关着都能用。

   以前必须指向当前地址，是因为数据还在浏览器的 IndexedDB 里、挂在「源」上。
   现在数据是服务器上的文件，不用同源了，这条路才走得通。

   下面那个 url 只在 .lnk 做不出来时当兜底（比如机器上没有 PowerShell），
   那时候它指向本地服务 —— 至少比指向 CUI 强。 */

function shortcutURL() {
  return window.location.href.replace(/[?#].*$/, "").replace(/[^/]*$/, "") + "index.html";
}

function makeShortcut() {
  const note = document.getElementById("mkShortcutNote");
  const btn = document.getElementById("mkShortcut");
  if (note) note.textContent = "正在创建…";
  if (btn) btn.disabled = true;
  /* 首页在 /m8/web/ 下，所以 ../shortcut 就是 /m8/shortcut */
  fetch("../shortcut/desktop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: shortcutURL(), name: "M8工作台" }),
  }).then(function (res) {
    return res.json();
  }).then(function (data) {
    if (!data || !data.ok) {
      throw new Error((data && (data.hint || data.error)) || "创建失败");
    }
    if (note) note.textContent = "建好了，桌面上的「" + data.fileName + "」";
  }).catch(function (e) {
    if (note) note.textContent = "没建成：" + (e && e.message ? e.message : String(e));
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
  renderTopbar(document.getElementById("topbar"), o.title || "M8 工作台", base);

  /* 只有首页有那个按钮，别的页面拿不到就跳过 */
  const mk = document.getElementById("mkShortcut");
  if (mk) mk.addEventListener("click", makeShortcut);

  /* 每个页面都查一遍旧数据 —— 用户不一定从首页进来 */
  checkOldData();
}
