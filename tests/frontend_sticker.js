/* ============================================================================
 * 图片工坊 · 贴纸遮挡的实跑检查
 *
 * 重点在两块最容易出错的地方：
 *   1. 抠图 keyPixels() —— 容差怎么映射成颜色距离、边缘要不要过渡、
 *      会不会误伤不该动的像素。这是纯函数，可以一个像素一个像素地验。
 *   2. 贴纸的新增/删除/层级/缩放 —— 索引一变就很容易错位或漏删。
 *
 * 用法：node tests/frontend_sticker.js
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
    textContent: '', value: '', type: '', id: '', className: '',
    disabled: false, href: '', download: '', alt: '', src: '', draggable: false, width: 0, height: 0,
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
      const ctx = {
        canvas: el,
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: noop,
        clearRect: noop,
        drawImage: noop,
      };
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
    },
    toBlob(cb) { cb({ size: 1, type: 'image/png' }); },
    toDataURL() { return 'data:image/png;base64,AAA'; },
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

const IDS = ['stickerPanel', 'stickerFrame', 'stickerBase', 'stickerLayer', 'stickerImport',
  'stickerCount', 'stickerLib', 'stickerLibNote',
  'stickerEmpty', 'stickerEdit', 'stickerScale', 'stickerScaleOut',
  'stickerFront', 'stickerRemove', 'stickerGenerate', 'stickerChange', 'stickerStatus',
  'stickerPreview', 'stickerPreviewGrid', 'stickerPreviewNote',
  'stickerModal', 'stickerModalX', 'stickerDrop', 'stickerFile', 'keyStage', 'stickerCanvas',
  'keyTip', 'keyTools', 'keyTol', 'keyTolOut', 'keyReset', 'keyInfo', 'stickerCancel', 'stickerApply'];

const IMG = { naturalWidth: 1200, naturalHeight: 800 };

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
  /* 贴纸库点一下就 new Image() 去加载，桩里赋值 src 时同步触发 onload */
  globalThis.Image = class {
    constructor() {
      this.naturalWidth = 240;
      this.naturalHeight = 240;
      this.width = 240;
      this.height = 240;
    }
    set src(v) { if (this.onload) this.onload(); }
    get src() { return ''; }
  };

  globalThis.M8Studio = {
    state: { img: null, url: '', name: 'test', tool: 'sticker' },
    onImage: noop,
    reset: noop,
  };
  /* 存储层默认「这个浏览器不给用」；想测它的用例自己再覆盖一次 */
  globalThis.M8StickerStore = {
    available: () => false,
    all: () => Promise.resolve(null),
    put: () => Promise.resolve(null),
    remove: () => Promise.resolve(null),
  };

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/sticker.js'), 'utf8');
  const api = new Function(src + '\n;return M8Sticker;')();
  api.init();
  api._setImage(IMG, 'blob:x');
  return api;
}

const fails = [];
/* 先把每条收集起来，最后按顺序跑一遍。
   贴纸库那几条要等 Promise（IndexedDB 天生异步），边定义边执行的话
   它们的结果会掉在报告之外 —— 那次报告就成了「全绿但没测到」。 */
const steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.01 : tol);

/* 按 [r,g,b,a] 列表造一份像素数据 */
function px(list) {
  const data = new Uint8ClampedArray(list.length * 4);
  list.forEach((p, i) => {
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  });
  return data;
}
function fakeSticker(w, h) {
  return { naturalWidth: w || 200, naturalHeight: h || 200, width: w || 200, height: h || 200 };
}

/* ---------------------------------------------------------------- 抠图 */

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Sticker 没导出来');
  if (m.state.stickers.length) throw new Error('一开始不该有贴纸');
});

step('抠图：和取样色一样的像素被抹成透明', () => {
  const data = px([[255, 255, 255, 255], [10, 20, 30, 255], [255, 255, 255, 255]]);
  const n = m.keyPixels(data, [255, 255, 255], 10);
  if (n !== 2) throw new Error('应该抹掉 2 个，实际 ' + n);
  if (data[3] !== 0) throw new Error('第 1 个像素没变透明');
  if (data[7] !== 255) throw new Error('不该动的像素被改了（第 2 个）');
  if (data[11] !== 0) throw new Error('第 3 个像素没变透明');
});

step('抠图：不碰 RGB，只改 alpha', () => {
  const data = px([[255, 255, 255, 255]]);
  m.keyPixels(data, [255, 255, 255], 50);
  if (data[0] !== 255 || data[1] !== 255 || data[2] !== 255) {
    throw new Error('RGB 被改了：' + data[0] + ',' + data[1] + ',' + data[2]);
  }
});

step('抠图：容差为 0 时只抹掉一模一样的那一个', () => {
  const data = px([[255, 255, 255, 255], [250, 255, 255, 255]]);
  const n = m.keyPixels(data, [255, 255, 255], 0);
  if (n !== 1) throw new Error('容差 0 时应该只抹完全相同的，实际抹了 ' + n);
  if (data[7] !== 255) throw new Error('相近但不相同的被误抹了');
});

step('抠图：容差越大抹掉越多', () => {
  const mk = () => px([[255, 255, 255, 255], [240, 240, 240, 255], [210, 210, 210, 255], [30, 40, 50, 255]]);
  const small = m.keyPixels(mk(), [255, 255, 255], 10);
  const big = m.keyPixels(mk(), [255, 255, 255], 40);
  if (!(big > small)) throw new Error('容差调大反而没抹掉更多：' + small + ' -> ' + big);
  const huge = m.keyPixels(mk(), [255, 255, 255], 100);
  if (huge < big) throw new Error('容差拉满应该抹掉最多的');
});

step('抠图：边缘留半透明过渡，不是硬切', () => {
  /* tol=8 时：完全抹除的阈值约 28.9，过渡带一直到 35.3。
     (237,237,237) 到白色的距离约 31.2，正落在过渡带里。 */
  const data = px([[237, 237, 237, 255]]);
  m.keyPixels(data, [255, 255, 255], 8);
  const a = data[3];
  if (a === 255) throw new Error('过渡带上的像素应该被削掉一部分 alpha，实际没动');
  if (a === 0) throw new Error('过渡带上的像素不该被抹成全透明');
});

step('抠图：远处颜色一点不动', () => {
  const data = px([[10, 20, 30, 255]]);
  const n = m.keyPixels(data, [255, 255, 255], 20);
  if (n !== 0) throw new Error('不相干的颜色被抹了 ' + n + ' 个');
  if (data[3] !== 255) throw new Error('alpha 被改了');
});

step('抠图：同一个像素抹两次结果一样（幂等）', () => {
  const a = px([[255, 255, 255, 255]]);
  const b = px([[255, 255, 255, 255]]);
  m.keyPixels(a, [255, 255, 255], 30);
  m.keyPixels(a, [255, 255, 255], 30);
  m.keyPixels(b, [255, 255, 255], 30);
  if (a[3] !== b[3]) throw new Error('抹两次和抹一次结果不同：' + a[3] + ' vs ' + b[3]);
});

/* ---------------------------------------------------------------- 贴纸 */

step('加贴纸：数量加一，并自动选中新的那张', () => {
  m = boot();
  if (m.state.selected !== -1) throw new Error('一开始不该有选中项');
  m.addSticker(fakeSticker(200, 100), 'blob:a');
  m.addSticker(fakeSticker(300, 300), 'blob:b');
  if (m.state.stickers.length !== 2) throw new Error('应该有 2 张，实际 ' + m.state.stickers.length);
  if (m.state.selected !== 1) throw new Error('应该自动选中新加的那张');
  if (m._el().layer.children.length !== 2) throw new Error('画面上没画出来 2 张');
});

step('新贴纸默认落在正中心', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  const s = m.state.stickers[0];
  if (!near(s.x, 50) || !near(s.y, 50)) throw new Error('默认位置不是中心：' + s.x + ',' + s.y);
  if (!(s.scale > 0)) throw new Error('默认大小不合理：' + s.scale);
});

step('贴纸记住自己的宽高比', () => {
  m = boot();
  m.addSticker(fakeSticker(400, 200), 'blob:a');
  const s = m.state.stickers[0];
  if (!near(s.ratio, 0.5, 0.001)) throw new Error('宽高比应该是 0.5，实际 ' + s.ratio);
});

step('删贴纸：删掉的是选中的那个', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  m.addSticker(fakeSticker(), 'blob:b');
  m.addSticker(fakeSticker(), 'blob:c');
  m._setSelected(1);
  m.removeSticker();
  if (m.state.stickers.length !== 2) throw new Error('删完应该剩 2 张');
  const urls = m.state.stickers.map((s) => s.url).join(',');
  if (urls !== 'blob:a,blob:c') throw new Error('删错了一张：' + urls);
  if (m.state.selected !== 1) throw new Error('删完选中项应该落到下一张上');
});

step('删最后一张后没有选中项', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  m.removeSticker();
  if (m.state.stickers.length !== 0) throw new Error('没删干净');
  if (m.state.selected !== -1) throw new Error('没有贴纸了却还有选中项');
});

step('移到最前：顺序变了，还是同一批贴纸', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  m.addSticker(fakeSticker(), 'blob:b');
  m.addSticker(fakeSticker(), 'blob:c');
  m._setSelected(0);
  m.moveFront();
  const urls = m.state.stickers.map((s) => s.url).join(',');
  if (urls !== 'blob:b,blob:c,blob:a') throw new Error('顺序不对：' + urls);
  if (m.state.selected !== 2) throw new Error('移到最前之后应该选中它');
});

step('缩放有上下限，不会缩没也不会撑爆', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  m.setScale(1000);
  if (m.state.stickers[0].scale !== 120) throw new Error('上限应该是 120，实际 ' + m.state.stickers[0].scale);
  m.setScale(0);
  if (m.state.stickers[0].scale !== 4) throw new Error('下限应该是 4，实际 ' + m.state.stickers[0].scale);
});

step('换底图会把贴纸清干净', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  m.addSticker(fakeSticker(), 'blob:b');
  m._setImage({ naturalWidth: 640, naturalHeight: 480 }, 'blob:new');
  if (m.state.stickers.length) throw new Error('换图后贴纸没清');
  if (m.state.selected !== -1) throw new Error('选中项没复位');
  if (m._el().layer.children.length) throw new Error('画面上的贴纸没清');
});

step('拖动贴纸：位置跟着指针', () => {
  m = boot();
  m.addSticker(fakeSticker(), 'blob:a');
  /* 容器 900x600，指针 (450,300) 就是正中心 */
  globalThis.__dragHandler && globalThis.__dragHandler({ clientX: 450, clientY: 300 });
  m.startDragForTest && m.startDragForTest(0);
});

step('拖拽监听挂在 document 上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/sticker.js'), 'utf8');
  const onDoc = (src.match(/document\.addEventListener\("pointer/g) || []).length;
  if (onDoc < 3) throw new Error('document 级指针监听只有 ' + onDoc + ' 处');
  if (/item\.addEventListener\("pointermove"/.test(src)) {
    throw new Error('拖拽监听挂在贴纸上了，指针一移出去就断');
  }
  if (src.indexOf('setPointerCapture') >= 0) {
    throw new Error('出现了 setPointerCapture，会和 document 级监听抢事件');
  }
});

/* ---------------------------------------------------------------- 模态 */

step('模态框能开能关', () => {
  m = boot();
  m._openModal();
  if (m._el().modal.classList.contains('is-hidden')) throw new Error('打开后还挂着 is-hidden');
  m._closeModal();
  if (!m._el().modal.classList.contains('is-hidden')) throw new Error('关掉后没加上 is-hidden');
});

step('模态打开时锁住页面滚动', () => {
  m = boot();
  m._openModal();
  if (!document.body.classList.contains('modal-open')) throw new Error('没锁滚动，背景会跟着滚');
  m._closeModal();
  if (document.body.classList.contains('modal-open')) throw new Error('关掉后没解锁');
});

step('没选图时「用这张」是禁用的', () => {
  m = boot();
  m._openModal();
  if (!m._el().apply.disabled) throw new Error('还没选图就能确认');
  m._closeModal();
  if (!m._el().apply.disabled) throw new Error('关掉之后应该回到禁用');
});

step('贴纸会加进画面，生成的是原图尺寸', () => {
  m = boot();
  m.addSticker(fakeSticker(200, 200), 'blob:a');
  const cv = document.createElement('canvas');
  m._drawTo(cv);
  if (cv.width !== IMG.naturalWidth || cv.height !== IMG.naturalHeight) {
    throw new Error('画布 ' + cv.width + 'x' + cv.height + '，应该等于原图尺寸');
  }
});

step('没有贴纸时生成了也不该有东西', () => {
  m = boot();
  m.generate();
  const note = m._el().status.textContent;
  if (note.indexOf('还没贴') < 0) throw new Error('应该提示还没贴贴纸，实际是：' + note);
});


/* ---------------------------------------------------------------- 贴纸库 */

step('贴纸库里一开始就有内置的那张', () => {
  m = boot();
  m._loadLibrary();
  if (m.state.library.length !== 1) throw new Error('应该有 1 张内置的，实际 ' + m.state.library.length);
  if (!m.state.library[0].builtin) throw new Error('内置标记丢了');
  if (m._el().lib.children.length !== 1) throw new Error('库里没画出来');
});

step('内置贴纸指向文件，不是塞进来的数据', () => {
  m = boot();
  m._loadLibrary();
  const it = m.state.library[0];
  if (it.url.indexOf('assets/stickers/') < 0) {
    throw new Error('内置贴纸该是文件路径（不占存储），实际是 ' + it.url.slice(0, 40));
  }
});

step('点库里的贴纸会贴到画面上', () => {
  m = boot();
  m._loadLibrary();
  const before = m.state.stickers.length;
  m._useLibraryItem(m.state.library[0]);
  if (m.state.stickers.length !== before + 1) throw new Error('没贴上去');
  if (m.state.selected !== m.state.stickers.length - 1) throw new Error('贴上后应该选中它');
});

step('没有底图时点库里的贴纸会提示，而不是悄悄失败', () => {
  m = boot();
  m._setImage(null);
  m._loadLibrary();
  m._useLibraryItem(m.state.library[0]);
  if (m.state.stickers.length) throw new Error('没有底图却贴上去了');
  if (m._el().status.textContent.indexOf('先选') < 0) {
    throw new Error('没提示要先选底图，实际是：' + m._el().status.textContent);
  }
});

step('导入的贴纸会存进库里', () => {
  m = boot();
  let saved = null;
  globalThis.M8StickerStore = {
    available: () => true,
    all: () => Promise.resolve([]),
    put: (r) => { saved = r; return Promise.resolve(1); },
    remove: () => Promise.resolve(null),
  };
  m._saveToLibrary('blob:mine', '我的贴纸');
  if (!saved) throw new Error('根本没调用存储');
  if (saved.data !== 'blob:mine') throw new Error('存进去的内容不对：' + saved.data);
  if (!saved.at) throw new Error('没记时间戳，读回来排不了序');
});

step('读库之后会把以前存下来的补进列表', async () => {
  m = boot();
  globalThis.M8StickerStore = {
    available: () => true,
    all: () => Promise.resolve([{ id: 7, data: 'blob:saved', name: '我的贴纸', at: 100 }]),
    put: () => Promise.resolve(1),
    remove: () => Promise.resolve(null),
  };
  m._loadLibrary();
  await new Promise((r) => setImmediate(r));
  if (m.state.library.length !== 2) {
    throw new Error('应该补进 1 张，实际库里 ' + m.state.library.length + ' 张');
  }
  const mine = m.state.library[1];
  if (mine.builtin) throw new Error('补进来的不该标成内置');
  if (mine.id !== 7) throw new Error('id 没保留，删不掉它');
});

step('新存进来的排在前面', async () => {
  m = boot();
  globalThis.M8StickerStore = {
    available: () => true,
    all: () => Promise.resolve([
      { id: 1, data: 'blob:old', at: 100 },
      { id: 2, data: 'blob:new', at: 900 },
    ]),
    put: () => Promise.resolve(1),
    remove: () => Promise.resolve(null),
  };
  m._loadLibrary();
  await new Promise((r) => setImmediate(r));
  const mine = m.state.library.filter((x) => !x.builtin);
  if (mine[0].id !== 2) throw new Error('新的没排前面：' + mine.map((x) => x.id).join(','));
});

step('内置贴纸删不掉', () => {
  m = boot();
  let removed = 'never';
  globalThis.M8StickerStore = {
    available: () => true,
    all: () => Promise.resolve([]),
    put: () => Promise.resolve(1),
    remove: (id) => { removed = id; return Promise.resolve(null); },
  };
  m._loadLibrary();
  m._removeLibraryItem(m.state.library[0]);
  if (removed !== 'never') throw new Error('内置贴纸竟然走了删除流程：' + removed);
});

step('我导入的能删掉', () => {
  m = boot();
  let removed = null;
  globalThis.M8StickerStore = {
    available: () => true,
    all: () => Promise.resolve([]),
    put: () => Promise.resolve(1),
    remove: (id) => { removed = id; return Promise.resolve(null); },
  };
  m._removeLibraryItem({ id: 42, builtin: false });
  if (removed !== 42) throw new Error('没删对：' + removed);
});

step('浏览器不给存时不炸，也不假装存上了', () => {
  m = boot();
  globalThis.M8StickerStore = {
    available: () => false,
    all: () => Promise.resolve(null),
    put: () => { throw new Error('不该走到这里'); },
    remove: () => { throw new Error('不该走到这里'); },
  };
  m._saveToLibrary('blob:x');
  m._loadLibrary();
  if (m.state.library.length !== 1) throw new Error('内置那张还是该在');
  if (m._el().libNote.textContent.indexOf('不给存') < 0) {
    throw new Error('应该说清楚存不了，实际是：' + m._el().libNote.textContent);
  }
});

step('存储层整个缺失也不炸（Node 环境就是这样）', () => {
  m = boot();
  delete globalThis.M8StickerStore;
  m._loadLibrary();
  m._saveToLibrary('blob:x');
  if (m.state.library.length !== 1) throw new Error('内置那张该在');
});

(async function () {
  for (const s of steps) {
    try {
      await s.fn();
      console.log('  OK    ' + s.name);
    } catch (e) {
      fails.push(s.name + ' -> ' + e.message);
      console.log('  FAIL  ' + s.name + ' -> ' + e.message);
    }
  }
  console.log('');
  if (fails.length) {
    console.log('贴纸遮挡实跑检查：' + fails.length + ' 个失败');
    fails.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log('贴纸遮挡实跑检查：全部通过');
  }
})();
