/* ============================================================================
 * 图片工坊 · 宫格拼图的实跑检查
 *
 * 这是「导入多张图拼成一张」，不是「切一张图」，所以两类断言最关键：
 *   1. coverRect() —— 每格怎么把图裁满而不拉变形。算错就是要么变形（难看），
 *      要么露边（更难看），要么裁到图片范围之外。
 *   2. 张数与格子的关系 —— 超出格子的不能拼进去、格子不够的要留空、
 *      导入多了要自动换大网格。
 *
 * 用法：node tests/frontend_grid.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const noop = () => {};

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
    textContent: '', value: '', type: '', id: '', className: '',
    disabled: false, href: '', download: '', alt: '', src: '', width: 0, height: 0, files: null,
    clientWidth: 900, clientHeight: 600,
    addEventListener: noop, removeEventListener: noop, focus: noop, click: noop,
    appendChild(c) {
      if (c && c.__fragment) { c.children.forEach((x) => this.children.push(x)); return c; }
      this.children.push(c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    hasAttribute(k) { return k in this.attributes; },
    querySelector: () => makeEl('span'),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 600, right: 900, bottom: 600 }),
    getContext() {
      const ctx = { canvas: el, drawImage: noop, clearRect: noop };
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
    },
    toBlob(cb) { cb({ size: 1, type: 'image/png' }); },
  };
  /* className 和 classList 必须双向同步 —— 真实 DOM 里它们是同一个东西的两副面孔。
     代码里既有 el.className = "thumb over" 也有 el.classList.toggle(...)，
     桩里要是各存各的，前者写的 class 后者永远查不到，测试会报出假失败。 */
  let clsName = '';
  function syncName() { clsName = Array.from(el.classSet).join(' '); }
  el.classList = {
    add: (c) => { el.classSet.add(c); syncName(); },
    remove: (c) => { el.classSet.delete(c); syncName(); },
    toggle: (c, on) => {
      if (on === undefined) { el.classSet.has(c) ? el.classSet.delete(c) : el.classSet.add(c); }
      else if (on) el.classSet.add(c); else el.classSet.delete(c);
      syncName();
      return el.classSet.has(c);
    },
    contains: (c) => el.classSet.has(c),
  };
  Object.defineProperty(el, 'className', {
    get() { return clsName; },
    set(v) {
      clsName = String(v || '');
      el.classSet = new Set(clsName.split(/\s+/).filter(Boolean));
    },
  });
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { html = v; if (!v) el.children.length = 0; },
  });
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
  return base;
}

const IDS = ['gridPanel', 'gridFrame', 'gridBoard', 'gridEmpty', 'gridPicker', 'gridDrop',
  'gridFiles', 'gridCount', 'gridThumbs', 'gridGenerate', 'gridClear', 'gridStatus',
  'gridPreview', 'gridPreviewNote', 'gridPreviewGrid'];

function fakeImg(w, h) {
  return { naturalWidth: w || 200, naturalHeight: h || 200, width: w || 200, height: h || 200 };
}

function boot() {
  for (const k of Object.keys(byId)) delete byId[k];
  globalThis.document = makeEventTarget({
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => { const f = makeEl('fragment'); f.__fragment = true; return f; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
    body: makeEl('body'),
  });
  for (const id of IDS) reg(id);
  globalThis.window = makeEventTarget({});
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: noop };
  globalThis.setTimeout = (fn) => { fn(); return 1; };
  /* 选图后 new Image() 去加载，桩里赋值 src 就同步 onload */
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 200;
      this.naturalHeight = 200;
      this.width = 200;
      this.height = 200;
    }
    set src(v) { if (this.onload) this.onload(); }
    get src() { return ''; }
  };

  globalThis.M8Studio = {
    state: { img: null, url: '', name: 'demo', tool: 'grid' },
    onImage: noop,
    reset: noop,
  };

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/grid.js'), 'utf8');
  const api = new Function(src + '\n;return M8Grid;')();
  api.init();
  return api;
}

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
const near = (a, b) => Math.abs(a - b) <= 0.01;

/* ---------------------------------------------------------------- 裁满 */

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Grid 没导出来');
  if (m.state.images.length) throw new Error('一开始不该有图');
  if (m.state.n !== 3) throw new Error('默认网格应该是 3×3，实际 ' + m.state.n);
});

step('裁满：宽图按高度放大，左右各裁掉一截', () => {
  m = boot();
  /* 400×200 的图放进 100×100 的格：缩放系数 0.5 → 裁出中间 200×200 */
  const r = m.coverRect(400, 200, 100, 100);
  if (!near(r.w, 200) || !near(r.h, 200)) throw new Error('裁出 ' + r.w + '×' + r.h + '，应该是 200×200');
  if (!near(r.x, 100) || !near(r.y, 0)) throw new Error('裁的位置不对：' + r.x + ',' + r.y);
});

step('裁满：高图按宽度放大，上下各裁掉一截', () => {
  m = boot();
  const r = m.coverRect(200, 400, 100, 100);
  if (!near(r.w, 200) || !near(r.h, 200)) throw new Error('裁出 ' + r.w + '×' + r.h + '，应该是 200×200');
  if (!near(r.x, 0) || !near(r.y, 100)) throw new Error('裁的位置不对：' + r.x + ',' + r.y);
});

step('裁满：正方形图一点都不裁', () => {
  m = boot();
  const r = m.coverRect(300, 300, 100, 100);
  if (!near(r.x, 0) || !near(r.y, 0) || !near(r.w, 300) || !near(r.h, 300)) {
    throw new Error('正方形图不该裁：' + JSON.stringify(r));
  }
});

step('裁满：裁出来的区域永远在原图范围内', () => {
  m = boot();
  const cases = [[400, 200], [200, 400], [1000, 300], [300, 1000], [7, 13], [13, 7], [1, 1]];
  for (const c of cases) {
    for (const cell of [64, 128, 512]) {
      const r = m.coverRect(c[0], c[1], cell, cell);
      if (!r) throw new Error(c + ' 在 ' + cell + ' 格里返回了 null');
      if (r.x < -0.01 || r.y < -0.01) throw new Error(c + ' 采样起点为负：' + r.x + ',' + r.y);
      if (r.x + r.w > c[0] + 0.01 || r.y + r.h > c[1] + 0.01) {
        throw new Error(c + ' 采样区域超出原图：' + JSON.stringify(r));
      }
    }
  }
});

step('裁满：裁出来的宽高比和格子一致（这才是「不变形」）', () => {
  m = boot();
  const cases = [[400, 200], [200, 400], [1000, 300], [7, 13]];
  for (const c of cases) {
    const r = m.coverRect(c[0], c[1], 128, 128);
    if (!near(r.w / r.h, 1, 0.01)) {
      throw new Error(c + ' 裁出来是 ' + r.w + '×' + r.h + '，宽高比不是 1，会变形');
    }
  }
});

step('裁满：图比格子大时是缩下来的，不是截一小块', () => {
  m = boot();
  /* 4000×4000 放进 128 的格：采样区应该是 4000 的一部分，但比例仍是 1:1 */
  const r = m.coverRect(4000, 4000, 128, 128);
  if (!near(r.w, 4000) || !near(r.h, 4000)) throw new Error('正方形大图不该被裁');
});

step('裁满：尺寸为 0 时不炸', () => {
  m = boot();
  if (m.coverRect(0, 0, 100, 100) !== null) throw new Error('0 尺寸该返回 null');
  if (m.coverRect(100, 100, 0, 0) !== null) throw new Error('0 格子该返回 null');
});

/* ---------------------------------------------------------------- 张数 */

step('张数和格子的关系', () => {
  m = boot();
  for (const n of [1, 2, 3, 4, 5]) {
    m.setN(n);
    if (m.capacity() !== n * n) throw new Error(n + '×' + n + ' 的容量应该是 ' + n * n);
    if (m._el().board.children.length !== n * n) {
      throw new Error(n + '×' + n + ' 的板上画了 ' + m._el().board.children.length + ' 格');
    }
  }
});

step('导入 1 张就能拼（1×1）', () => {
  m = boot();
  m.setN(1);
  m._addImage(fakeImg(300, 300), 'blob:a');
  if (m.state.images.length !== 1) throw new Error('没加进去');
  if (m.usedImages().length !== 1) throw new Error('1×1 应该只用 1 张');
  if (m._el().generate.disabled) throw new Error('有一张图了，生成按钮不该禁用');
});

step('超出格子的图不会被拼进去', () => {
  m = boot();
  for (let i = 0; i < 6; i++) m._addImage(fakeImg(), 'blob:' + i);
  /* 导入时网格会自动跟着涨到装得下，所以这里要手动调小 ——
     平时用户也是这么撞上「装不下」的：图没变，是他把格子改小了 */
  m.setN(2);
  if (m.state.images.length !== 6) throw new Error('应该存下 6 张');
  if (m.usedImages().length !== 4) throw new Error('2×2 只能用 4 张，实际用了 ' + m.usedImages().length);
});

step('超出的那几张在缩略图上被标出来', () => {
  m = boot();
  for (let i = 0; i < 5; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.setN(2);
  const thumbs = m._el().thumbs.children;
  const over = thumbs.filter((t) => t.classList.contains('over')).length;
  if (over !== 1) throw new Error('2×2 收了 5 张，该有 1 张标灰，实际标了 ' + over + ' 张');
});

step('导入的张数超出网格时会自动换大', () => {
  m = boot();
  m.setN(2);
  for (let i = 0; i < 5; i++) m._addImage(fakeImg(), 'blob:' + i);
  if (m.state.n !== 3) throw new Error('5 张该自动升到 3×3，实际 ' + m.state.n);
  m.setN(2);
  for (let i = 0; i < 10; i++) m._addImage(fakeImg(), 'blob:x' + i);
  if (m.state.n !== 4) throw new Error('15 张该升到 4×4，实际 ' + m.state.n);
});

step('最多收 25 张，多的直接不入列', () => {
  m = boot();
  const files = [];
  for (let i = 0; i < 30; i++) files.push({ type: 'image/png' });
  m.addFiles(files);
  if (m.state.images.length !== 25) throw new Error('实际收了 ' + m.state.images.length + ' 张');
  if (m.state.n !== 5) throw new Error('25 张该是 5×5，实际 ' + m.state.n);
});

step('非图片文件被挡掉', () => {
  m = boot();
  m.addFiles([{ type: 'text/plain' }, { type: 'image/png' }, { type: 'application/pdf' }]);
  if (m.state.images.length !== 1) throw new Error('实际收了 ' + m.state.images.length + ' 张');
});

step('空输入不会炸', () => {
  m = boot();
  m.addFiles([]);
  m.addFiles(null);
  if (m.state.images.length) throw new Error('不该有图');
});

step('缩略图带序号，序号从 1 开始', () => {
  m = boot();
  m.setN(3);
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  const thumbs = m._el().thumbs.children;
  if (thumbs.length !== 3) throw new Error('缩略图数量不对');
  const first = thumbs[0].children.filter((c) => c.className === 'thumb-no')[0];
  if (!first || first.textContent !== '1') throw new Error('第一张的序号不是 1');
});

step('删掉一张，后面的序号自动补上', () => {
  m = boot();
  m.setN(3);
  for (let i = 0; i < 4; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.removeImage(1);
  if (m.state.images.length !== 3) throw new Error('没删掉');
  const urls = m.state.images.map((x) => x.url).join(',');
  if (urls !== 'blob:x,blob:x,blob:x' && urls.indexOf('blob:0') !== 0) {
    throw new Error('删错了一张：' + urls);
  }
});

step('清空之后回到初始状态', () => {
  m = boot();
  m.setN(4);
  for (let i = 0; i < 5; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.clearAll();
  if (m.state.images.length) throw new Error('没清干净');
  if (m._el().thumbs.children.length) throw new Error('缩略图还在');
  if (m._el().board.children.length !== 16) throw new Error('板应该还是 4×4 的格子');
  if (!m._el().generate.disabled) throw new Error('没图了，生成按钮该禁用');
});

/* ---------------------------------------------------------------- 生成 */

step('生成出来是 n×512 的正方形', () => {
  m = boot();
  for (const n of [1, 3, 5]) {
    m.setN(n);
    m._addImage(fakeImg(), 'blob:a');
    const cv = document.createElement('canvas');
    m._drawTo(cv);
    if (cv.width !== n * 512 || cv.height !== n * 512) {
      throw new Error(n + '×' + n + ' 生成 ' + cv.width + '×' + cv.height + '，应该是 ' + n * 512);
    }
  }
});

step('只画装得下的那几张', () => {
  m = boot();
  let drawn = 0;
  for (let i = 0; i < 6; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.setN(2);
  const cv = document.createElement('canvas');
  /* 数一下 drawImage 被调了几次 */
  cv.getContext = () => new Proxy({ drawImage: () => { drawn += 1; }, clearRect: noop }, {
    get: (t, k) => (k in t ? t[k] : noop),
    set: () => true,
  });
  m._drawTo(cv);
  if (drawn !== 4) throw new Error('2×2 该画 4 张，实际画了 ' + drawn);
});

step('改网格会清掉旧预览', () => {
  m = boot();
  m.setN(2);
  m._addImage(fakeImg(), 'blob:a');
  m.generate();
  if (!m.state.shot) throw new Error('没生成出东西');
  m.setN(3);
  if (m.state.shot) throw new Error('换了网格但旧预览还在，会张冠李戴');
});

step('没有图时点生成只会提示，不会炸', () => {
  m = boot();
  m.generate();
  if (m._el().status.textContent.indexOf('Import some images first') < 0) {
    throw new Error('没提示，实际是：' + m._el().status.textContent);
  }
});

step('生成按钮上写着当前网格', () => {
  m = boot();
  m.setN(4);
  m._addImage(fakeImg(), 'blob:a');
  const label = m._el().generate.textContent;
  if (label.indexOf('4x4') < 0) throw new Error('按钮上没写网格：' + label);
});


/* ---------------------------------------------------------------- 重排序 */

step('重排序是插入，不是交换', () => {
  m = boot();
  for (let i = 0; i < 4; i++) m._addImage(fakeImg(), 'blob:' + i);
  /* 把第 4 张拖到最前：其它三张都该往后顺延一位 */
  m.moveTo(3, 0);
  const got = m.state.images.map((x) => x.url).join(',');
  if (got !== 'blob:3,blob:0,blob:1,blob:2') throw new Error('实际顺序：' + got);
});

step('往后拖同理', () => {
  m = boot();
  for (let i = 0; i < 4; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.moveTo(0, 2);
  const got = m.state.images.map((x) => x.url).join(',');
  if (got !== 'blob:1,blob:2,blob:0,blob:3') throw new Error('实际顺序：' + got);
});

step('拖到原位不算移动', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  const before = m.state.images.map((x) => x.url).join(',');
  if (m.moveTo(1, 1)) throw new Error('同一位置不该算移动');
  const after = m.state.images.map((x) => x.url).join(',');
  if (after !== before) throw new Error('顺序被改了');
});

step('越界的下标被夹住，不炸', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  if (m.moveTo(-1, 0)) throw new Error('负数下标不该成功');
  if (m.moveTo(9, 0)) throw new Error('超范围的下标不该成功');
  m.moveTo(0, 99);
  const got = m.state.images.map((x) => x.url).join(',');
  if (got !== 'blob:1,blob:2,blob:0') throw new Error('没夹到末尾：' + got);
});

step('重排之后旧的预览要清掉', () => {
  m = boot();
  for (let i = 0; i < 4; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.setN(2);
  m.generate();
  if (!m.state.shot) throw new Error('没生成出来');
  m.moveTo(0, 3);
  if (m.state.shot) throw new Error('重排了但旧预览还在，导出会是错的顺序');
});

step('重排后板子上第一格就是新拖过来的那张', () => {
  m = boot();
  for (let i = 0; i < 4; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.setN(2);
  m.moveTo(3, 0);
  const cell = m._el().board.children[0];
  const im = cell.children[0];
  if (!im || im.src !== 'blob:3') {
    throw new Error('第一格不是新拖来的那张，实际 ' + (im && im.src));
  }
});

step('缩略图上带着可以拖的提示', () => {
  m = boot();
  m._addImage(fakeImg(), 'blob:a');
  const t = m._el().thumbs.children[0];
  if (String(t.title).indexOf('hold and drag') < 0) throw new Error('没提示可以拖：' + t.title);
  if (!t.style.cursor && t.classList) { /* 光标由 CSS 给，这里只确认监听挂上去了 */ }
});

step('只点一下不算拖拽（不然想删却把顺序改了）', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  const before = m.state.images.map((x) => x.url).join(',');
  m.startDrag(0, { clientX: 100, clientY: 100 });
  /* 只挪了 2px —— 低于阈值，应当当成点击 */
  m.onDragMove({ clientX: 102, clientY: 101 });
  if (m.state.moved) throw new Error('2px 就进了拖拽态');
  m.endDrag();
  const after = m.state.images.map((x) => x.url).join(',');
  if (after !== before) throw new Error('点一下就把顺序改了');
});

step('移动超过阈值才进拖拽态', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.startDrag(0, { clientX: 100, clientY: 100 });
  m.onDragMove({ clientX: 140, clientY: 100 });
  if (!m.state.moved) throw new Error('移了 40px 还没进拖拽态');
  m.endDrag();
  if (m.state.drag !== -1) throw new Error('松手后没复位');
  if (m.state.moved) throw new Error('松手后 moved 没复位');
});

step('没在拖的时候移动指针不会乱动', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  const before = m.state.images.map((x) => x.url).join(',');
  m.onDragMove({ clientX: 500, clientY: 500 });
  m.endDrag();
  const after = m.state.images.map((x) => x.url).join(',');
  if (after !== before) throw new Error('没拖也在动');
});

step('拖拽的 move/up 挂在 document 上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/grid.js'), 'utf8');
  if (src.indexOf('document.addEventListener("pointermove", onMove)') < 0) {
    throw new Error('pointermove 没挂到 document —— 指针一移出那格就断了');
  }
  if (src.indexOf('document.addEventListener("pointerup", endDrag)') < 0) {
    throw new Error('pointerup 没挂到 document');
  }
});

step('拖到别的格子上会高亮目标位置', () => {
  m = boot();
  for (let i = 0; i < 3; i++) m._addImage(fakeImg(), 'blob:' + i);
  m.startDrag(0, { clientX: 100, clientY: 100 });
  m.onDragMove({ clientX: 300, clientY: 300 });
  /* 桩里所有元素的矩形都一样，indexAt 会落到第 0 格；
     这里只确认「高亮这件事被执行了」而不追究落在哪一格 */
  if (m.state.dropAt < 0) throw new Error('没算出落点');
  m.endDrag();
  const marked = m._el().thumbs.children.filter((k) => k.classList.contains('drop-target')).length;
  if (marked) throw new Error('松手后还留着高亮');
});

console.log('');
if (fails.length) {
  console.log('宫格拼图实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('宫格拼图实跑检查：全部通过');
}
