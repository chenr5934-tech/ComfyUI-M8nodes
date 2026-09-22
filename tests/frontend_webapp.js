/* ============================================================================
 * M8web 实跑检查：把 app.js 真的执行一遍，再对页面做结构与契约核对。
 *
 * 为什么非跑不可：这一层全是 DOM 操作，语法检查一点用都没有 ——
 * 取了不存在的元素、拼错的方法名、事件里访问 undefined，全都要跑起来才炸。
 *
 * 用法：node tests/frontend_webapp.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const noop = () => {};

/* ---------------------------------------------------------------- DOM 桩 */

function makeStyle() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : ''), set: (t, k, v) => { t[k] = v; return true; } });
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: makeStyle(),
    dataset: {},
    children: [],
    attributes: {},
    classSet: new Set(),
    textContent: '', value: '', checked: false, type: '',
    disabled: false, href: '', target: '', rel: '', id: '', className: '', innerHTML: '',
    clientWidth: 900, clientHeight: 600, offsetWidth: 900, offsetHeight: 600,
    addEventListener: noop, removeEventListener: noop, focus: noop, click: noop, select: noop,
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    replaceWith(c) { this.replaced = c; return c; },
    remove: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] || null; },
    hasAttribute(k) { return k in this.attributes; },
    setPointerCapture: noop, releasePointerCapture: noop,
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }),
    getContext() {
      const ctx = { canvas: el, measureText: () => ({ width: 40 }), imageSmoothingEnabled: false };
      ctx.createLinearGradient = () => ({ addColorStop: noop });
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
    },
    toBlob(cb) { cb({ size: 1, type: 'image/png' }); },
    toDataURL() { return 'data:image/png;base64,AAA'; },
    get firstChild() { return this.children[0] || makeEl('div'); },
  };
  el.classList = {
    add: (c) => el.classSet.add(c),
    remove: (c) => el.classSet.delete(c),
    toggle: (c, on) => {
      if (on === undefined) { el.classSet.has(c) ? el.classSet.delete(c) : el.classSet.add(c); }
      else if (on) el.classSet.add(c); else el.classSet.delete(c);
      return el.classSet.has(c);
    },
    contains: (c) => el.classSet.has(c),
  };
  return el;
}

const byId = {};
function reg(id) { const e = makeEl('div'); e.id = id; byId[id] = e; return e; }

function makeEventTarget(base) {
  const listeners = {};
  base.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  base.removeEventListener = (type, fn) => {
    if (!listeners[type]) return;
    listeners[type] = listeners[type].filter((f) => f !== fn);
  };
  base.dispatchEvent = (ev) => {
    const type = typeof ev === 'string' ? ev : ev && ev.type;
    (listeners[type] || []).forEach((fn) => fn(ev));
    return true;
  };
  base.__listeners = listeners;
  return base;
}

function makeDocument() {
  /* 注意 querySelector 默认返回 null —— 真实的 renderThemes 会先查一遍
     「主题条是不是已经在了」，桩里若永远返回一个元素，它就直接跳过了，
     那条分支等于没测。 */
  return makeEventTarget({
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
    body: makeEl('body'),
    head: makeEl('head'),
    documentElement: makeEl('html'),
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
  });
}

function installGlobals() {
  for (const k of Object.keys(byId)) delete byId[k];
  globalThis.document = makeDocument();
  globalThis.window = makeEventTarget({
    location: { pathname: '/', href: 'http://localhost:8188/' },
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
    open: noop,
  });
  globalThis.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 1; };
  globalThis.setTimeout = (fn) => { try { fn(); } catch (e) { throw e; } return 1; };
  globalThis.setInterval = () => 1;
  globalThis.clearInterval = noop;
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: noop };
  globalThis.Image = class { set src(v) { if (this.onload) this.onload(); } };
  globalThis.CustomEvent = class { constructor(t) { this.type = t; } };
  globalThis.confirm = () => false;
  globalThis.prompt = () => null;
}

/* ---------------------------------------------------------------- 跑 */

const fails = [];

function step(name, fn) {
  try {
    fn();
    console.log('  OK    ' + name);
  } catch (e) {
    fails.push(name + ' -> ' + e.message);
    console.log('  FAIL  ' + name + ' -> ' + e.message);
  }
}

function readSrc(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function loadApp() {
  installGlobals();
  const src = readSrc('M8web/assets/js/app.js');
  /* app.js 顶层用 const 声明，抽出来挂到返回值上才拿得到 */
  return new Function(
    src + '\n;return { boot: boot, renderCards: renderCards, renderSidebar: renderSidebar, FEATURES: FEATURES, THEMES: THEMES, applyTheme: applyTheme };',
  )();
}

/* ---- 1. app.js 能加载 ---- */

let appApi = null;
step('app.js 加载，功能清单与主题都是满的', () => {
  appApi = loadApp();
  if (!appApi.FEATURES.length) throw new Error('FEATURES 是空的');
  if (appApi.THEMES.length !== 4) throw new Error('主题不是 4 套，而是 ' + appApi.THEMES.length);
  for (const t of ['day', 'night', 'sakura', 'ocean']) {
    if (!appApi.THEMES.some((x) => x.id === t)) throw new Error('少了主题 ' + t);
  }
  for (const f of appApi.FEATURES) {
    for (const k of ['id', 'icon', 'name', 'kicker', 'desc', 'tone', 'tone2']) {
      if (!f[k]) throw new Error('功能 ' + f.id + ' 少了字段 ' + k);
    }
  }
});

/* ---- 2. 首页：boot + 渲染卡片 ---- */

step('首页 boot + 渲染卡片', () => {
  appApi = loadApp();
  reg('sidebar');
  const cards = reg('cards');
  appApi.boot({ activeId: '', title: 'M8 工作台', base: '' });
  appApi.renderCards(cards);
  if (!cards.innerHTML) throw new Error('卡片没渲染出来');
  /* 每张卡必须是三层：kicker / 标题 / 描述 —— 这是参考站的结构，
     少了 kicker 卡片就变成一坨普通方块。 */
  for (const f of appApi.FEATURES) {
    if (cards.innerHTML.indexOf(f.name) < 0) throw new Error('卡片里少了 ' + f.name);
  }
  const kickers = (cards.innerHTML.match(/class="card-kicker"/g) || []).length;
  if (kickers !== appApi.FEATURES.length) {
    throw new Error('kicker 有 ' + kickers + ' 个，功能有 ' + appApi.FEATURES.length + ' 个，对不上');
  }
  const strongs = (cards.innerHTML.match(/<strong>/g) || []).length;
  const smalls = (cards.innerHTML.match(/<small>/g) || []).length;
  if (strongs !== appApi.FEATURES.length || smalls !== appApi.FEATURES.length) {
    throw new Error('卡片不是三层结构（strong ' + strongs + ' / small ' + smalls + '）');
  }
  /* 每张卡自带强调色，色带靠它走 */
  const tones = (cards.innerHTML.match(/--tone:/g) || []).length;
  if (tones !== appApi.FEATURES.length) throw new Error('有卡片没带 --tone');
  /* 首页的卡片必须能点进功能页 —— 全是禁用态的话框架根本走不通 */
  const links = (cards.innerHTML.match(/href="pages\/[a-z-]+\.html"/g) || []).length;
  if (links !== appApi.FEATURES.length) throw new Error('可点卡片只有 ' + links + ' 张');
});

/* ---- 3. 主题：切换要落盘，且必须设在 <html> 上 ---- */

step('主题切换与记忆', () => {
  appApi = loadApp();
  reg('sidebar');
  appApi.boot({ activeId: '', title: 'x', base: '' });
  if (document.documentElement.dataset.theme !== 'night') throw new Error('默认主题不是 night');
  /* 主题挂在 documentElement 上：head 里的防闪脚本也设的是它，
     两处不一致的话切主题会被盖回去，表现为「点了没反应」。 */
  globalThis.localStorage.setItem('m8web.theme', 'sakura');
  appApi.boot({ activeId: '', title: 'x', base: '' });
  if (document.documentElement.dataset.theme !== 'sakura') throw new Error('记忆的主题没生效');
});

step('主题条渲染成按钮，且用的是真实的主题 id', () => {
  appApi = loadApp();
  reg('sidebar');
  appApi.boot({ activeId: '', title: 'x', base: '' });
  const box = document.body.children.filter((c) => c.className === 'themes')[0];
  if (!box) throw new Error('主题条没挂到 body 上');
  for (const t of appApi.THEMES) {
    if (box.innerHTML.indexOf('data-t="' + t.id + '"') < 0) throw new Error('主题条少了 ' + t.id);
  }
  const n = (box.innerHTML.match(/<button/g) || []).length;
  if (n !== 4) throw new Error('主题按钮有 ' + n + ' 个');
});

/* ---- 4. 侧栏 ---- */

step('侧栏默认展开，收起按钮切的是 <html> 上的类', () => {
  appApi = loadApp();
  reg('sidebar');
  appApi.boot({ activeId: '', title: 'x', base: '' });
  /* 默认不能是收起的 —— 功能菜单是列表，收起来就看不见了 */
  if (document.documentElement.classList.contains('is-side-collapsed')) {
    throw new Error('默认状态是收起的，功能列表看不见');
  }
  globalThis.localStorage.setItem('m8web.side', '1');
  appApi.boot({ activeId: '', title: 'x', base: '' });
  if (!document.documentElement.classList.contains('is-side-collapsed')) {
    throw new Error('存了收起状态却没生效');
  }
  /* CSS 靠 :root.is-side-collapsed 切宽度，所以这个类必须挂在 documentElement 上 */
  const css = readSrc('M8web/assets/css/shell.css');
  if (css.indexOf(':root.is-side-collapsed') < 0) {
    throw new Error('shell.css 里没有 :root.is-side-collapsed，类挂错地方了');
  }
});

step('侧栏与卡片的链接前缀正确', () => {
  appApi = loadApp();
  /* 首页：base 为空 */
  const home = appApi.renderSidebar('', '').innerHTML;
  if (home.indexOf('href="index.html"') < 0) throw new Error('首页的返回首页链接不对');
  if (home.indexOf('href="pages/image-editor.html"') < 0) throw new Error('首页的功能链接不对');
  /* 功能页在 pages/ 下，必须带 ../。挑哪个功能来验不能写死 ——
     写死的话，以后换掉/改名任何一个功能，这条断言就会假报错（踩过一次）。 */
  const other = appApi.FEATURES.filter((f) => f.id !== 'image-editor')[0];
  if (!other) throw new Error('功能列表里只有一个页面，没法验前缀');
  const sub = appApi.renderSidebar('image-editor', '../').innerHTML;
  if (sub.indexOf('href="../index.html"') < 0) throw new Error('子页的返回首页链接不对');
  if (sub.indexOf('href="../pages/' + other.id + '.html"') < 0) {
    throw new Error('子页的功能链接不对：' + other.id);
  }
  /* 当前页要高亮 */
  if (sub.indexOf('nav-item active" href="../pages/image-editor.html"') < 0) {
    throw new Error('当前页没在侧栏里高亮');
  }
});

/* ---- 5. 设计底座：四套主题与关键 token ---- */

step('base.css 里四套主题齐全，且都是完整的一套', () => {
  const css = readSrc('M8web/assets/css/base.css');
  for (const t of ['day', 'night', 'sakura', 'ocean']) {
    if (t === 'night') continue; /* 默认那套写在 :root 上 */
    if (css.indexOf(':root[data-theme="' + t + '"]') < 0) throw new Error('少了主题 ' + t);
  }
  /* 每个主题块都得把这几个关键变量给全，少一个就会露出上一套的底色。
     必须用带引号的选择器精确定位 —— 文件顶上的说明注释里也写了
     :root[data-theme=sakura] 这几个字，按字符串切会把它当成主题块。 */
  const need = ['--bg-gradient', '--card', '--panel-bg', '--border', '--text', '--text-sub', '--accent'];
  const check = (label, index) => {
    const body = css.slice(index, css.indexOf('}', index));
    for (const v of need) {
      if (body.indexOf(v + ':') < 0) throw new Error('主题 ' + label + ' 里缺 ' + v);
    }
  };
  /* 暗夜那套同时挂在裸 :root 和 :root[data-theme="night"] 上 */
  const rootAt = css.search(/^:root(?=[,\s])/m);
  if (rootAt < 0) throw new Error('找不到默认的 :root 块');
  check('night', rootAt);
  for (const t of ['day', 'sakura', 'ocean']) {
    const at = css.search(new RegExp('^:root\\[data-theme="' + t + '"\\]\\s*\\{', 'm'));
    if (at < 0) throw new Error('找不到主题 ' + t + ' 的块');
    check(t, at);
  }
});

step('关键 token 对得上参考站', () => {
  const css = readSrc('M8web/assets/css/base.css');
  /* 主色是青绿，不是紫 —— 这是参考站 sidebar.css 的悬停色 */
  if (css.indexOf('--accent: #26c8bd') < 0) throw new Error('主色不是参考站的青绿 #26c8bd');
  /* 背景噪点：1px 圆点铺 4px 网格 */
  if (css.indexOf('background-size: 4px 4px') < 0) throw new Error('背景噪点的网格不对');
  if (css.indexOf('--soft-shadow') < 0) throw new Error('少了 --soft-shadow');
});

step('shell.css 抄住了参考站的三个数', () => {
  const css = readSrc('M8web/assets/css/shell.css');
  /* 侧栏 58 / 184 两个宽度 */
  if (css.indexOf('--side-w: 184px') < 0) throw new Error('侧栏展开宽度不是 184px');
  if (css.indexOf('--side-w: 58px') < 0) throw new Error('侧栏收起宽度不是 58px');
  /* 菜单项 40×40、圆角 12px */
  const item = css.slice(css.indexOf('.nav-item {'), css.indexOf('}', css.indexOf('.nav-item {')));
  if (item.indexOf('height: 40px') < 0) throw new Error('菜单项不是 40px 高');
  if (item.indexOf('--r-item') < 0) throw new Error('菜单项没用圆角变量');
  if (readSrc('M8web/assets/css/base.css').indexOf('--r-item: 12px') < 0) {
    throw new Error('圆角 12px 不对');
  }
  /* 首页是 3 列网格 */
  if (css.indexOf('repeat(3, minmax(0, 1fr))') < 0) throw new Error('首页不是 3 列网格');
  /* 悬停上浮 2px */
  if (css.indexOf('translateY(-2px)') < 0) throw new Error('卡片悬停没上浮');
});

/* ---- 6. 页面本身 ---- */

const PAGES = ['M8web/index.html'].concat(
  fs.readdirSync(path.join(ROOT, 'M8web/pages')).filter((f) => f.endsWith('.html')).map((f) => 'M8web/pages/' + f),
);

step('每个页面都引对了资源', () => {
  for (const rel of PAGES) {
    const html = readSrc(rel);
    const p = rel === 'M8web/index.html' ? '' : '../';
    for (const r of ['assets/css/base.css', 'assets/css/shell.css', 'assets/js/app.js']) {
      if (html.indexOf(p + r) < 0) throw new Error(rel + ' 没引 ' + p + r);
    }
    /* 旧的布局文件已经并进 shell.css，引回来就是走错路 */
    if (html.indexOf('layout.css') >= 0) throw new Error(rel + ' 还在引已经删掉的 layout.css');
  }
});

step('每个页面的 head 里都有防闪脚本，且设在 <html> 上', () => {
  for (const rel of PAGES) {
    const html = readSrc(rel);
    const head = html.slice(0, html.indexOf('</head>'));
    if (head.indexOf('m8web.theme') < 0) throw new Error(rel + ' 的 head 里没有防闪脚本');
    if (head.indexOf('documentElement.dataset.theme') < 0) {
      throw new Error(rel + ' 的防闪脚本没设在 documentElement 上');
    }
    /* 放在 body 末尾就晚了，还是会闪一下白底 */
    if (html.indexOf('dataset.theme', html.indexOf('</head>')) >= 0) {
      if (html.indexOf('data-theme="') >= 0) throw new Error(rel + ' 的 data-theme 写在 head 外面');
    }
  }
});

step('功能页按 HTML 的真实顺序执行，侧栏顶栏都渲染出来', () => {
  const html = readSrc('M8web/pages/image-editor.html');
  const iApp = html.indexOf('assets/js/app.js');
  const iBody = html.indexOf('<body');
  const iBoot = html.indexOf('boot({');
  if (iApp < iBody) throw new Error('app.js 引在 <body> 之前');
  if (iBoot < iApp) throw new Error('boot() 在 app.js 之前，拿不到 boot 函数');

  /* 真的把页面里的脚本按顺序跑一遍。
     用间接 eval：浏览器里多个 <script> 共享同一个全局作用域，new Function 会把它们隔开，
     那样「页面自己能不能跑通」就测不出来了 —— 而这恰恰是最该测的。

     这里必须把页面引的**每一个** <script src> 都装上。之前写死了只加载 app.js，
     页面新引一个 cut.js 就直接炸成「M8Cut is not defined」—— 那是测试的漏洞，不是页面的错。 */
  installGlobals();
  for (const id of ['sidebar', 'topbar', 'cards']) reg(id);
  const gEval = eval;
  const pageDir = path.dirname(path.join(ROOT, 'M8web/pages/image-editor.html'));
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  if (srcs.length < 2) throw new Error('只解析出 ' + srcs.length + ' 个外部脚本，是不是解析坏了');

  /* 全部拼成一段再 eval，而不是一个文件一次 eval。
     原因：浏览器里每个 <script> 共享同一个全局词法环境，顶层 const 也共享；
     而 Node 里间接 eval 的 const 只活在这一次 eval 里，下一次就看不见了 ——
     app.js 的 boot 是 function 声明（挂得上）所以没事，cut.js 的 M8Cut 是 const，
     分开 eval 就会变成「M8Cut is not defined」。拼起来才是对浏览器行为的正确模拟。 */
  const parts = srcs.map((rel) => fs.readFileSync(path.join(pageDir, rel), 'utf8'));
  const inline = [...html.matchAll(/<script>\s*([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  gEval(parts.join('\n;\n') + '\n;\n' + inline[inline.length - 1]);
  if (!byId.sidebar.replaced) throw new Error('侧栏没被渲染出来');
  if (!byId.topbar.innerHTML) throw new Error('顶栏没被渲染出来');
});

/* ---- 7. ComfyUI 顶栏入口按钮 ---- */

step('顶栏找不到容器时不炸', () => {
  installGlobals();
  globalThis.app = { registerExtension: (ext) => { globalThis.__ext2 = ext; } };
  document.querySelector = () => null;
  document.body = makeEl('body');
  const src = readSrc('js/m8_web_button.js').replace(/^import .*$/gm, '');
  new Function('app', src)(globalThis.app);
  globalThis.__ext2.setup();
});

step('顶栏有三个按钮时插在图标区之前', () => {
  installGlobals();
  let inserted = null;
  const menu = makeEl('div');
  menu.className = 'comfyui-body-top';
  const first = makeEl('button');
  first.id = 'comfy-queue';
  Object.defineProperty(first, 'parentElement', { get: () => menu });
  menu.children.push(first);
  menu.querySelector = (sel) => (/button/.test(sel) ? first : makeEl('div'));
  menu.insertBefore = (node) => { inserted = node; menu.children.push(node); return node; };
  menu.appendChild = (node) => { inserted = node; menu.children.push(node); return node; };
  globalThis.app = { registerExtension: (ext) => { globalThis.__ext3 = ext; } };
  document.body = makeEl('body');
  document.body.appendChild(menu);
  document.querySelector = (sel) => (sel.indexOf('comfyui-body-top') >= 0 ? menu : null);
  const src = readSrc('js/m8_web_button.js').replace(/^import .*$/gm, '');
  new Function('app', src)(globalThis.app);
  globalThis.__ext3.setup();
  if (!inserted) throw new Error('没有插进顶栏');
  if (inserted.id !== 'm8-web-entry') throw new Error('插的不是入口按钮，而是 ' + inserted.id);
  if (!inserted.href || inserted.href.indexOf('m8/web/index.html') < 0) {
    throw new Error('链接不对：' + inserted.href);
  }
  if (inserted.target !== '_blank') throw new Error('没有开新标签页');
});

step('重复挂载不会插出两个按钮', () => {
  installGlobals();
  const menu = makeEl('div');
  menu.className = 'comfyui-body-top';
  globalThis.app = { registerExtension: (ext) => { globalThis.__ext4 = ext; } };
  document.body = makeEl('body');
  document.body.appendChild(menu);
  const store = {};
  const origAppend = menu.appendChild.bind(menu);
  menu.appendChild = (n) => { if (n.id) store[n.id] = n; return origAppend(n); };
  document.getElementById = (id) => store[id] || null;
  document.querySelector = (sel) => (sel.indexOf('comfyui-body-top') >= 0 ? menu : null);
  const src = readSrc('js/m8_web_button.js').replace(/^import .*$/gm, '');
  new Function('app', src)(globalThis.app);
  globalThis.__ext4.setup();
  globalThis.__ext4.setup();
  globalThis.__ext4.setup();
  const count = menu.children.filter((c) => c.id === 'm8-web-entry').length;
  if (count !== 1) throw new Error('挂了 ' + count + ' 次，应该只有 1 个按钮');
});


step('编辑页的标签配平，而且面板不会互相嵌套', () => {
  /* 这一条是为一个真实踩过的坑补的：用 edit 往页面里插一整块 pane 时锚点选错了，
     结果 paint 面板被塞进 grid 面板**内部**。grid 一隐藏，paint 跟着一起藏，
     尺寸全成 0 —— 而里面的点击、画笔逻辑其实全都正常，
     页面上也不报任何错。我当时在 CSS 上绕了三轮才回头查 HTML。 */
  const html = readSrc('M8web/pages/image-editor.html');
  const open = (html.match(/<div\b/g) || []).length;
  const close = (html.match(/<\/div>/g) || []).length;
  if (open !== close) {
    throw new Error('div 标签不配平：开 ' + open + ' 个、闭 ' + close + ' 个，差 ' + (open - close));
  }

  const panes = [...html.matchAll(/<div class="shop-pane[^"]*" data-pane="([^"]+)"/g)];
  if (panes.length < 5) throw new Error('只找到 ' + panes.length + ' 个功能面板');

  /* 两个面板之间不能再冒出第三个面板的开始标签 —— 那说明嵌进去了。
     切片要从**自己开始标签之后**算起，不然第一个匹配到的就是自己。 */
  for (let i = 0; i < panes.length - 1; i++) {
    const from = panes[i].index + panes[i][0].length;
    const seg = html.slice(from, panes[i + 1].index);
    if (seg.indexOf('class="shop-pane') >= 0) {
      throw new Error('「' + panes[i][1] + '」面板里嵌了另一个面板 —— 上层一藏它就跟着藏，尺寸全 0');
    }
  }

  /* 每个面板都得有自己的预览区，否则切过去看不到生成结果 */
  for (const m of panes) {
    const after = html.slice(m.index + m[0].length);
    const next = after.indexOf('class="shop-pane');
    const block = next > 0 ? after.slice(0, next) : after;
    if (block.indexOf('studio-preview') < 0) {
      throw new Error('「' + m[1] + '」面板里没有预览区');
    }
  }
});


step('跨页面要用的样式都在 shell.css 里，不在某个功能的样式表里', () => {
  /* 这一条是为一个真实 bug 补的：.is-hidden 原来写在 studio.css 里，
     而 OC 工坊那个页面不引 studio.css —— 于是那个「删除确认框」从一进页面
     就一直显示着（浏览器眼里它一直是 display:block）。
     判据很简单：两个页面可能用到的，就必须放 shell.css。 */
  const shell = readSrc('M8web/assets/css/shell.css');
  const studio = readSrc('M8web/assets/css/studio.css');
  /* 用行首精确匹配，不能拿子串去搜：studio.css 里有个
     .preview-head .gen-btn（那是工坊专用的布局微调），子串匹配会把它误判成重复定义 */
  for (const cls of ['.is-hidden', '.gen-btn', '.ghost-btn', '.status']) {
    const re = new RegExp('^' + cls.replace('.', '\\.') + '\\s*\\{', 'm');
    if (!re.test(shell)) {
      throw new Error(cls + ' 不在 shell.css 里 —— 只引 shell 的页面会用不到它');
    }
    if (re.test(studio)) {
      throw new Error(cls + ' 又在 studio.css 里独立定义了一份，两边会打架');
    }
  }
  /* 模态那一套也一样：OC 工坊要用删除确认框，工坊要用贴纸导入框 */
  for (const cls of ['.modal {', '.modal-box {', '.modal-body {', '.modal-foot {']) {
    if (shell.indexOf(cls) < 0) throw new Error(cls + ' 不在 shell.css 里');
  }
});

step('页面用到的类，定义它的样式表必须被该页引了', () => {
  /* 这条是为同一个 bug 的另一半补的：.drop 原来写在 studio.css 里，
     而图片元数据页和 LoRA 页不引 studio.css —— 那两个页面的上传区
     一直没有样式（连虚线框都没有），可光看代码完全看不出来。
     上面那条检查是硬编码类名清单，清单外的那个它抓不到，所以改成自动扫：
     把每个页面用到的 class 拿去比对「定义它的 css 有没有被引」。 */
  const cssDir = path.join(ROOT, 'M8web/assets/css');
  const defs = {};
  for (const f of fs.readdirSync(cssDir).filter((n) => n.endsWith('.css'))) {
    const src = readSrc('M8web/assets/css/' + f);
    /* 只认 .classname，且后面必须跟空白 / 逗号 / 冒号 / 花括号 / 点 / 方括号。
       这样 0.2s、rgba(255,255,255,0.04)、xxx.png 都不会被误当成类名。 */
    const re = /\.([a-zA-Z][a-zA-Z0-9_-]*)(?=[\s,:{.[\]])/g;
    let m;
    while ((m = re.exec(src))) {
      if (!defs[m[1]]) defs[m[1]] = {};
      defs[m[1]][f] = true;
    }
  }

  /* HTML 里只当 JS 钩子使、本来就不需要样式的类。这是例外清单不是垃圾桶 ——
     每一条都得写清楚为什么不需要样式。 */
  const NO_STYLE_HOOKS = {
    'shop-pane': '工坊用 querySelectorAll 挑面板，显隐靠 .is-hidden',
  };

  const names = fs.readdirSync(path.join(ROOT, 'M8web/pages')).filter((n) => n.endsWith('.html'));
  names.push('index.html');
  const bad = [];
  for (const name of names) {
    const rel = name === 'index.html' ? 'M8web/index.html' : 'M8web/pages/' + name;
    const src = readSrc(rel);
    const linked = {};
    let m;
    const lre = /assets\/css\/([a-z]+\.css)/g;
    while ((m = lre.exec(src))) linked[m[1]] = true;

    const used = {};
    const cre = /class="([^"]*)"/g;
    while ((m = cre.exec(src))) {
      m[1].split(/\s+/).filter(Boolean).forEach((c) => { used[c] = true; });
    }
    for (const c of Object.keys(used)) {
      if (NO_STYLE_HOOKS[c]) continue;
      const own = defs[c] ? Object.keys(defs[c]) : [];
      /* HTML 里静态写死的 class 一律要求有样式。
         注意不能写成「没有定义就放过」—— 那样把定义改名就等于把检查绕过去了
         （反向验证时踩到过：把 .drop 改名之后检查反而全绿了）。 */
      if (!own.some((o) => linked[o])) {
        bad.push(name + ' 用了 .' + c + '，'
          + (own.length ? '但定义它的 ' + own.join(' / ') + ' 没被引' : '但没有任何样式表定义它'));
      }
    }
  }
  if (bad.length) throw new Error('共 ' + bad.length + ' 处：' + bad.join('；'));
});

/* ---- 5b. 接线：js 和 html 对不对得上 ---- */

step('页面里的 js 用到的 DOM id，页面上都得真有', () => {
  /* 语法检查抓不到这类错：byId("foo") 写错一个字，或者 html 改了 id 忘了同步 js。
     平时一点事没有，要等用户点到那个按钮才炸 —— 这条把它挡在前面。
     （审计时就是这么查出问题的：8 个页面漏了 favicon 之外，id 全都对得上。） */
  /* 页面可有可无的 id。app.js 是外壳，被所有页面共用，但「顶栏」和「创建快捷方式按钮」
     只有部分页面有 —— 代码里都守住了，缺了不会炸。
     这是例外清单，每一条都要写清为什么可以缺（不然它就成了垃圾桶）。 */
  const OPTIONAL_IDS = {
    topbar: '首页没有顶栏；renderTopbar 里 if (!host) return',
    mkShortcut: '只有首页有那个按钮；makeShortcut 只挂在取到的按钮上，别的页面根本不会调到',
    mkShortcutNote: '同上，和按钮成对出现',
  };

  const dir = path.join(ROOT, 'M8web/pages');
  const targets = ['M8web/index.html'].concat(
    fs.readdirSync(dir).filter((n) => n.endsWith('.html')).map((n) => 'M8web/pages/' + n),
  );
  const bad = [];
  for (const rel of targets) {
    const src = readSrc(rel);
    const ids = {};
    let m;
    const idRe = /\bid="([^"]+)"/g;
    while ((m = idRe.exec(src))) ids[m[1]] = true;

    const scripts = [];
    const sRe = /<script src="([^"]+\.js)"/g;
    while ((m = sRe.exec(src))) scripts.push(m[1].replace(/^\.\.\//, ''));

    for (const s of scripts) {
      const jsRel = 'M8web/' + s;
      if (!fs.existsSync(path.join(ROOT, jsRel))) {
        bad.push(path.basename(rel) + ' 引了不存在的 ' + s);
        continue;
      }
      const js = readSrc(jsRel);
      const useRe = /\bbyId\("([^"]+)"\)|\bgetElementById\("([^"]+)"\)/g;
      while ((m = useRe.exec(js))) {
        const id = m[1] || m[2];
        if (ids[id] || OPTIONAL_IDS[id]) continue;
        bad.push(path.basename(rel) + ' 缺 id「' + id + '」（' + path.basename(s) + ' 在用）');
      }
    }
  }
  if (bad.length) {
    throw new Error(bad.length + ' 处：' + bad.slice(0, 6).join('；'));
  }
});

step('js 用到的 M8 模块，页面得把定义它的文件也加载了', () => {
  /* 同一个毛病的另一半：页面用了 M8Backup，却忘了 <script src="backup.js">。
     控制台会报 ReferenceError，但除非点那个按钮，否则看不出来。 */
  const jsDir = path.join(ROOT, 'M8web/assets/js');
  const owner = {};
  let m;
  for (const f of fs.readdirSync(jsDir).filter((n) => n.endsWith('.js'))) {
    const src = readSrc('M8web/assets/js/' + f);
    const re = /\bconst (M8[A-Z][A-Za-z]*) = /g;
    while ((m = re.exec(src))) owner[m[1]] = f;
    const re2 = /\bfunction (M8[A-Z][A-Za-z]*)\s*\(/g;
    while ((m = re2.exec(src))) owner[m[1]] = f;
  }

  const dir = path.join(ROOT, 'M8web/pages');
  const targets = ['M8web/index.html'].concat(
    fs.readdirSync(dir).filter((n) => n.endsWith('.html')).map((n) => 'M8web/pages/' + n),
  );
  const bad = [];
  for (const rel of targets) {
    const src = readSrc(rel);
    const loaded = {};
    const sRe = /<script src="([^"]+\.js)"/g;
    while ((m = sRe.exec(src))) loaded[path.basename(m[1])] = true;
    for (const f of Object.keys(loaded)) {
      if (!fs.existsSync(path.join(jsDir, f))) continue;
      const js = readSrc('M8web/assets/js/' + f);
      const useRe = /\b(M8[A-Z][A-Za-z]*)\b/g;
      while ((m = useRe.exec(js))) {
        const mod = m[1];
        if (!owner[mod]) continue;
        if (!loaded[owner[mod]]) {
          bad.push(path.basename(rel) + ' 用了 ' + mod + '，但没加载 ' + owner[mod]);
        }
      }
    }
  }
  if (bad.length) {
    throw new Error(bad.length + ' 处：' + Array.from(new Set(bad)).slice(0, 6).join('；'));
  }
});

step('每个功能页都引了它真正需要的样式表', () => {
  const oc = readSrc('M8web/pages/oc.html');
  if (oc.indexOf('../assets/css/shell.css') < 0) throw new Error('OC 工坊没引 shell.css');
  if (oc.indexOf('../assets/css/oc.css') < 0) throw new Error('OC 工坊没引自己的样式');
  const studio = readSrc('M8web/pages/image-editor.html');
  for (const css of ['base.css', 'shell.css', 'studio.css']) {
    if (studio.indexOf('../assets/css/' + css) < 0) throw new Error('工坊页没引 ' + css);
  }
});

step('顶栏选择器用的是真实存在的类名', () => {
  /* 这一条是为一个实际报过的问题补的：按钮一直不出现，
   * 根因是我凭印象写了 .comfyui-menu / .comfy-menu / #comfyui-menu，
   * 而这三个在 ComfyUI 里**都不存在**。真实的是 .comfyui-body-top。
   * 这条断言不能证明类名在新版里仍然有效（那要实机验证），
   * 它能做的是：有人把它换成别的猜测值时立刻红。 */
  const entry = readSrc('js/m8_web_button.js');
  if (entry.indexOf('comfyui-body-top') < 0) {
    throw new Error('顶栏选择器里没有 .comfyui-body-top，是不是又改成猜的了');
  }
  const codeOnly = entry
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
  for (const bad of ['.comfyui-menu', '.comfy-menu', '#comfyui-menu']) {
    if (codeOnly.indexOf(bad) >= 0) throw new Error('还在用不存在的选择器 ' + bad);
  }
  if (entry.indexOf('没找到顶栏容器') < 0) {
    throw new Error('找不到顶栏时没有诊断日志，问题会静默消失');
  }
});

console.log('');
if (fails.length) {
  console.log('M8web 实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('M8web 实跑检查：全部通过（' + PAGES.length + ' 个页面）');
}
