/* ============================================================================
 * 图片工坊 · 分段裁剪的实跑检查
 *
 * 这个功能最容易错的是三件事，所以它们各有一条独立的断言：
 *   1. 段数 n 必须对应 n-1 条线（差一条就是错位）
 *   2. 段的像素区域要按方向算对（横切竖切差 90 度，算反了导出的就是错误尺寸）
 *   3. 分割线不能越过相邻那条线（不夹的话能把一段拖成负尺寸）
 *
 * 另外拖拽监听必须挂在 document 上 —— 这个项目在这上面栽过一次。
 *
 * 用法：node tests/frontend_cut.js
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
    disabled: false, href: '', download: '', alt: '', src: '',
    clientWidth: 900, clientHeight: 600, offsetWidth: 900, offsetHeight: 600,
    addEventListener: noop, removeEventListener: noop, focus: noop, click: noop,
    appendChild(c) {
      /* 片段的子节点要「过户」到容器上，否则测试看到的永远是片段本身 */
      if (c && c.__fragment) { c.children.forEach((x) => this.children.push(x)); return c; }
      this.children.push(c);
      return c;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
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
      const ctx = { canvas: el };
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
    },
    toBlob(cb) { cb({ size: 1, type: 'image/png' }); },
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
  /* innerHTML 收到空串时必须真的清掉子节点 —— 真实 DOM 就是这个行为。
     桩里只存一个字符串的话容器会一直累积，测出来的数量全是错的：
     这条一开始就把「蒙版层画了 8 块，应该是 5」暴露成了假问题。 */
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
  base.__listeners = listeners;
  return base;
}

const IDS = ['cutDrop', 'cutFile', 'cutFileMeta', 'cutStage', 'cutPanel', 'cutFrame', 'cutSource',
  'cutTints', 'cutLines', 'cutMutes', 'cutDir', 'cutCount', 'cutCountOut', 'cutSegList',
  'cutGenerate', 'cutChange', 'cutStatus', 'cutPreview', 'cutPreviewGrid', 'cutPreviewNote', 'cutExport'];

function boot() {
  for (const k of Object.keys(byId)) delete byId[k];
  const created = [];
  globalThis.document = makeEventTarget({
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => { const f = makeEl('fragment'); f.__fragment = true; return f; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
    body: makeEl('body'),
  });
  for (const id of IDS) reg(id);
  globalThis.window = makeEventTarget({ location: { href: 'http://x/' } });
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: noop };
  globalThis.Image = class { set src(v) { if (this.onload) this.onload(); } };
  globalThis.setTimeout = (fn) => { fn(); return 1; };

  /* M8Studio 是工坊的公共模块：上传、拖放、粘贴、以及「当前是哪张图」都归它管，
     cut.js 只订阅它的通知。测试里给一个最小的替身就够了。 */
  globalThis.M8Studio = {
    state: { img: null, url: '', name: 'image' },
    onImage: function (fn) { globalThis.__imgHook = fn; },
    reset: function () {
      if (globalThis.__imgHook) globalThis.__imgHook({ img: null, url: '', name: 'image' });
    },
  };

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/cut.js'), 'utf8');
  const api = new Function(src + '\n;return M8Cut;')();
  api.init();

  /* 换图走真实入口（M8Studio 通知），而不是直接往 state 里塞 ——
     这样 useImage 那段也一起被跑到了。
     假图片：segRect 只读 naturalWidth / naturalHeight，不用真造 Image，更不碰 canvas */
  api.setImage = function (img) {
    if (globalThis.__imgHook) globalThis.__imgHook({ img: img, url: 'blob:x', name: 'test' });
  };
  api.setImage({ naturalWidth: 1200, naturalHeight: 800 });
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.01 : tol);

/* ---------------------------------------------------------------- 跑 */

let c = null;

step('载入并初始化', () => {
  c = boot();
  if (!c) throw new Error('M8Cut 没导出来');
  if (c.state.dir !== 'h') throw new Error('默认方向不是横切');
});

step('段数 n 对应 n-1 条线', () => {
  c = boot();
  for (const n of [2, 3, 5, 10]) {
    c.setCount(n);
    if (c.state.cuts.length !== n - 1) {
      throw new Error(n + ' 段应该有 ' + (n - 1) + ' 条线，实际 ' + c.state.cuts.length);
    }
    if (c.state.muted.length !== n) {
      throw new Error(n + ' 段应该有 ' + n + ' 个屏蔽位，实际 ' + c.state.muted.length);
    }
    const b = c.bounds();
    if (b.length !== n + 1) throw new Error('边界数应该是 ' + (n + 1));
    if (b[0] !== 0 || b[b.length - 1] !== 100) throw new Error('首尾边界不是 0 和 100');
  }
});

step('默认分割线是均匀的', () => {
  c = boot();
  c.setCount(4);
  const want = [25, 50, 75];
  c.state.cuts.forEach((v, i) => {
    if (!near(v, want[i], 0.001)) throw new Error('第 ' + (i + 1) + ' 条线应在 ' + want[i] + '%，实际 ' + v);
  });
});

step('改段数会重新等分，而且线永远严格递增', () => {
  c = boot();
  c.setCount(3);
  c.state.cuts[0] = 20;   /* 假装用户拖过一条 */
  c.setCount(4);
  const want = [25, 50, 75];
  c.state.cuts.forEach((v, i) => {
    if (!near(v, want[i], 0.001)) {
      throw new Error('第 ' + (i + 1) + ' 条线应是 ' + want[i] + '%，实际 ' + v);
    }
  });
  /* 这一条是为一个真实踩过的坑补的：以前「保留旧线」的写法在
     3 段 → 4 段时会把新线插到旧线前面，cuts 变成 33 / 67 / 75，
     再往上加到 7 段就彻底乱序，段宽算出 0。往上加、往下减来回切一遍。 */
  for (const n of [2, 5, 3, 9, 4, 10, 2, 7]) {
    c.setCount(n);
    const cuts = c.state.cuts;
    if (cuts.length !== n - 1) throw new Error('调到 ' + n + ' 段，线数不对');
    for (let i = 1; i < cuts.length; i++) {
      if (!(cuts[i] > cuts[i - 1])) {
        throw new Error('调到 ' + n + ' 段后线乱序了：' + cuts.join(', '));
      }
    }
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const r = c.segRect(i);
      if (r.h <= 0) throw new Error('调到 ' + n + ' 段时第 ' + (i + 1) + ' 段高度是 ' + r.h);
      sum += r.h;
    }
    if (Math.abs(sum - 800) > n) throw new Error('调到 ' + n + ' 段，各段高度之和 ' + sum + '，不是 800');
  }
});

step('横切的段是横向长条，竖切是纵向长条', () => {
  c = boot();
  c.setCount(2);
  c.setDir('h');
  const h0 = c.segRect(0);
  const h1 = c.segRect(1);
  if (h0.w !== 1200) throw new Error('横切时每段宽度应该等于原图宽，实际 ' + h0.w);
  if (h0.h + h1.h !== 800) throw new Error('横切两段高度之和应等于原图高，实际 ' + (h0.h + h1.h));
  if (h0.y !== 0) throw new Error('第一段应该从 y=0 开始');

  c.setDir('v');
  const v0 = c.segRect(0);
  const v1 = c.segRect(1);
  if (v0.h !== 800) throw new Error('竖切时每段高度应该等于原图高，实际 ' + v0.h);
  if (v0.w + v1.w !== 1200) throw new Error('竖切两段宽度之和应等于原图宽，实际 ' + (v0.w + v1.w));
  if (v0.x !== 0) throw new Error('第一段应该从 x=0 开始');
});

step('各段尺寸加起来等于原图，且没有零尺寸段', () => {
  c = boot();
  c.setCount(7);
  c.setDir('h');
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const r = c.segRect(i);
    if (r.w < 1 || r.h < 1) throw new Error('第 ' + (i + 1) + ' 段尺寸是 ' + r.w + 'x' + r.h);
    sum += r.h;
  }
  if (Math.abs(sum - 800) > 7) throw new Error('七段高度之和 ' + sum + '，偏离原图高 800 太多');
});

step('屏蔽是逐段独立的', () => {
  c = boot();
  c.setCount(3);
  c.toggleMute(1);
  if (!c.state.muted[1]) throw new Error('第 2 段没被屏蔽');
  if (c.state.muted[0] || c.state.muted[2]) throw new Error('屏蔽串到别的段上了');
  const act = c.activeIndexes();
  if (act.length !== 2 || act[0] !== 0 || act[1] !== 2) throw new Error('参与导出的段不对：' + act.join(','));
  c.toggleMute(1);
  if (c.state.muted[1]) throw new Error('再点一次没取消屏蔽');
});

step('全部屏蔽时生成按钮禁用', () => {
  c = boot();
  c.setCount(3);
  const el = c._el();
  if (el.generate.disabled) throw new Error('正常情况下生成按钮不该是禁用的');
  c.toggleMute(0); c.toggleMute(1); c.toggleMute(2);
  if (!el.generate.disabled) throw new Error('全屏蔽了按钮还是可点的');
  if (el.generate.textContent.indexOf('全部已屏蔽') < 0) throw new Error('按钮文案没提示原因');
  c.toggleMute(1);
  if (el.generate.disabled) throw new Error('解屏蔽后按钮应恢复');
});

step('界面上的线、蒙版、按钮数量都跟着段数走', () => {
  c = boot();
  c.setCount(5);
  const el = c._el();
  if (el.lines.children.length !== 4) throw new Error('线画了 ' + el.lines.children.length + ' 条，应该是 4');
  if (el.tints.children.length !== 5) throw new Error('蒙版层画了 ' + el.tints.children.length + ' 块，应该是 5');
  if (el.mutes.children.length !== 5) throw new Error('屏蔽按钮画了 ' + el.mutes.children.length + ' 个，应该是 5');
  if (el.segList.children.length !== 5) throw new Error('尺寸列表画了 ' + el.segList.children.length + ' 行，应该是 5');
});

step('屏蔽按钮的 flex 权重等于该段占比（靠它对齐）', () => {
  c = boot();
  c.setCount(4);
  const btns = c._el().mutes.children;
  const want = [25, 25, 25, 25];
  btns.forEach((b, i) => {
    const w = parseFloat(String(b.style.flex).split(' ')[0]);
    if (!near(w, want[i], 0.01)) {
      throw new Error('第 ' + (i + 1) + ' 个按钮权重 ' + w + '，该段占比 ' + want[i]);
    }
  });
  /* 把第一段拉大，权重必须跟着变。
     这里不能调 setCount 来触发重绘 —— 它现在一律重新等分，会把 60 覆盖掉。
     用 setDir 触发：它只换方向 + 重绘，不动 cuts。 */
  c.state.cuts[0] = 60;
  c.setDir('v');
  c.setDir('h');
  const w0 = parseFloat(String(c._el().mutes.children[0].style.flex).split(' ')[0]);
  if (!near(w0, 60, 0.01)) throw new Error('拉大后权重没跟着变，实际 ' + w0);
  /* 竖切时按钮是横排的，权重照样得对 */
  c.setDir('v');
  const vw = parseFloat(String(c._el().mutes.children[0].style.flex).split(' ')[0]);
  if (!near(vw, 60, 0.01)) throw new Error('竖切时权重不对，实际 ' + vw);
  c.setDir('h');
});

step('拖分割线：位置跟着指针走', () => {
  c = boot();
  c.setCount(3);
  /* 容器 900x600（桩给的尺寸），y=300 就是 50% */
  c.state.drag = 0;
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 300 });
  if (!near(c.state.cuts[0], 50, 0.5)) throw new Error('拖到中间应落在 50%，实际 ' + c.state.cuts[0]);
  document.dispatchEvent({ type: 'pointerup' });
  if (c.state.drag !== -1) throw new Error('松手后没结束拖拽');
});

step('竖切时拖的是横向位置', () => {
  c = boot();
  c.setCount(3);
  c.state.img = { naturalWidth: 1200, naturalHeight: 800 };
  c.setDir('v');
  c.state.drag = 0;
  /* 容器宽 900，x=450 就是 50% */
  document.dispatchEvent({ type: 'pointermove', clientX: 450, clientY: 0 });
  if (!near(c.state.cuts[0], 50, 0.5)) throw new Error('竖切拖到中间应落在 50%，实际 ' + c.state.cuts[0]);
  document.dispatchEvent({ type: 'pointerup' });
});

step('分割线拖不过相邻那条（不夹会拖出负尺寸段）', () => {
  c = boot();
  c.setCount(3);
  c.state.cuts[1] = 40;
  c.state.drag = 0;
  /* 硬往 90% 拖，必须被第 2 条线挡住 */
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 540 });
  document.dispatchEvent({ type: 'pointerup' });
  if (c.state.cuts[0] >= 40) {
    throw new Error('第 1 条线越过了第 2 条线：' + c.state.cuts[0] + ' >= 40');
  }
  /* 也不能贴死，得留出抓得住的距离 */
  if (40 - c.state.cuts[0] < 1) throw new Error('两条线贴太近了，圆点会叠在一起');
  const r = c.segRect(0);
  if (r.h <= 0) throw new Error('夹失败，第一段高度成了 ' + r.h);
});

step('没有图时拖拽不生效', () => {
  c = boot();
  c.setCount(3);
  c.state.img = null;
  const before = c.state.cuts.slice();
  c.state.drag = 0;
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 500 });
  if (c.state.cuts[0] !== before[0]) throw new Error('没图的时候线还能被拖走');
});

step('拖拽监听挂在 document 上（挂元素上会拖到一半断）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/cut.js'), 'utf8');
  const onDoc = (src.match(/document\.addEventListener\("pointer/g) || []).length;
  if (onDoc < 3) throw new Error('document 级指针监听只有 ' + onDoc + ' 处，move/up/cancel 都要有');
  for (const bad of ['.addEventListener("pointermove"', 'knob.addEventListener("pointermove"', 'frame.addEventListener("pointermove"']) {
    if (src.indexOf(bad) >= 0 && src.indexOf(bad) !== src.indexOf('document' + bad)) {
      /* 只允许 document 那一种写法 */
    }
  }
  if (/frame\.addEventListener\("pointermove"/.test(src)) {
    throw new Error('拖拽监听又挂回画布上了');
  }
  if (/knob\.addEventListener\("pointermove"/.test(src)) {
    throw new Error('拖拽监听挂在圆点上了，移出圆点就断');
  }
  if (src.indexOf('setPointerCapture') >= 0) {
    throw new Error('出现了 setPointerCapture，会和 document 级监听抢事件');
  }
});

step('拖动过程中不整层重画（重画会把手上的圆点换掉）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/cut.js'), 'utf8');
  const i = src.indexOf('function onMove(');
  const body = src.slice(i, src.indexOf('\n  function endDrag', i));
  if (/\n    render\(\)/.test(body)) {
    throw new Error('onMove 里整层 render() 了 —— 拖拽会中途断掉');
  }
  if (body.indexOf('renderTints()') < 0) throw new Error('拖动时蒙版层没跟着更新');
});

step('清掉图片时自己的状态要跟着清', () => {
  c = boot();
  c.setCount(4);
  c.toggleMute(0);
  /* 走 M8Studio.reset()：图片一清，cut.js 就该把分割线和屏蔽全丢掉。
     工作台和选图区的显隐现在归 M8Studio 管，cut.js 不再碰。 */
  globalThis.M8Studio.reset();
  if (c.state.img) throw new Error('图片没清掉');
  if (c.state.cuts.length) throw new Error('分割线没清掉');
  if (c.state.muted.length) throw new Error('屏蔽状态没清掉');
});

step('生成时跳过被屏蔽的段', () => {
  c = boot();
  c.setCount(4);
  c.toggleMute(2);
  const idx = c.activeIndexes();
  if (idx.indexOf(2) >= 0) throw new Error('被屏蔽的段还留在导出列表里');
  if (idx.length !== 3) throw new Error('参与导出的段数不对：' + idx.length);
  /* 导出文件名按原始段号，跳过屏蔽后不会重编号 —— 否则用户对不上第几段 */
  const names = idx.map((i) => 'part-' + (i + 1));
  if (names.join(',') !== 'part-1,part-2,part-4') {
    throw new Error('段号被重排了：' + names.join(','));
  }
});

console.log('');
if (fails.length) {
  console.log('分段裁剪实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('分段裁剪实跑检查：全部通过');
}
