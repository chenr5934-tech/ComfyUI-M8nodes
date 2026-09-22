/* ============================================================================
 * 图片工坊 · 文字与画笔的实跑检查
 *
 * 两条主线：
 *   1. **位置和尺寸一律是百分比**。存像素的话，拉一下窗口、或者导出成原图尺寸，
 *      文字和笔画就会跑到别的地方去 —— 预览和导出不是一个东西。
 *   2. 画到画布和画到预览用的是**同一个函数**，所以这里直接拿一个记账用的假
 *      ctx 去数它到底画了几笔、字号算成多少 px。
 *
 * 用法：node tests/frontend_paint.js
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
    disabled: false, checked: false, href: '', download: '', alt: '', src: '', width: 0, height: 0,
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
      const ctx = { canvas: el, clearRect: noop, drawImage: noop };
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

const IDS = ['paintPanel', 'paintFrame', 'paintBase', 'paintCanvas', 'textLayer', 'paintMode',
  'textTools', 'brushTools', 'textAdd', 'textBody', 'textSize', 'textSizeOut', 'textOutline',
  'textRemove', 'brushWidth', 'brushWidthOut', 'brushUndo', 'brushClear', 'paintColors',
  'paintGenerate', 'paintChange', 'paintStatus', 'paintPreview', 'paintPreviewNote',
  'paintPreviewGrid'];

const IMG = { naturalWidth: 1200, naturalHeight: 800 };

/* 记账用的假 ctx：数它到底画了几笔、字号算成了多少 px */
function spyCtx() {
  const calls = { fillText: [], strokeText: [], moveTo: [], lineTo: [], stroke: 0, fill: 0, arc: 0 };
  return {
    calls: calls,
    canvas: {},
    _font: '',
    set font(v) { this._font = v; },
    get font() { return this._font; },
    set fillStyle(v) { this._fill = v; },
    get fillStyle() { return this._fill; },
    set strokeStyle(v) { this._stroke = v; },
    get strokeStyle() { return this._stroke; },
    set lineWidth(v) { this._lw = v; },
    get lineWidth() { return this._lw; },
    set textAlign(v) {}, set textBaseline(v) {}, set lineJoin(v) {}, set lineCap(v) {},
    fillText: (t) => calls.fillText.push(t),
    strokeText: (t) => calls.strokeText.push(t),
    beginPath: noop,
    moveTo: (x, y) => calls.moveTo.push([x, y]),
    lineTo: (x, y) => calls.lineTo.push([x, y]),
    arc: () => { calls.arc += 1; },
    stroke: () => { calls.stroke += 1; },
    fill: () => { calls.fill += 1; },
    clearRect: noop,
    drawImage: noop,
  };
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

  globalThis.M8Studio = {
    state: { img: null, url: '', name: 'demo', tool: 'paint' },
    onImage: noop,
    reset: noop,
  };

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/paint.js'), 'utf8');
  const api = new Function(src + '\n;return M8Paint;')();
  api.init();
  api._setImage(IMG, 'blob:x');
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

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Paint 没导出来');
  if (m.state.mode !== 'text') throw new Error('默认该是文字模式');
  if (m.state.texts.length || m.state.strokes.length) throw new Error('一开始不该有东西');
});

/* ---------------------------------------------------------------- 文字 */

step('加一条文字：在中心、自动选中', () => {
  m = boot();
  m.addText();
  if (m.state.texts.length !== 1) throw new Error('没加上');
  if (m.state.selected !== 0) throw new Error('没自动选中新加的');
  const t = m.state.texts[0];
  if (t.x !== 50 || t.y !== 50) throw new Error('默认不在中心：' + t.x + ',' + t.y);
});

step('位置和字号存的都是百分比', () => {
  m = boot();
  m.addText();
  const t = m.state.texts[0];
  if (!(t.x >= 0 && t.x <= 100)) throw new Error('x 不是百分比：' + t.x);
  if (!(t.y >= 0 && t.y <= 100)) throw new Error('y 不是百分比：' + t.y);
  if (!(t.size > 0 && t.size <= 100)) throw new Error('字号不是百分比：' + t.size);
});

step('改内容 / 字号 / 描边', () => {
  m = boot();
  m.addText();
  m.updateText({ body: '你好', size: 12, outline: false });
  const t = m.state.texts[0];
  if (t.body !== '你好') throw new Error('内容没改：' + t.body);
  if (t.size !== 12) throw new Error('字号没改：' + t.size);
  if (t.outline !== false) throw new Error('描边没关掉');
});

step('删掉选中的那条，选中项落到下一条', () => {
  m = boot();
  m.addText(); m.addText(); m.addText();
  const ids = m.state.texts.map((t) => t.id).join(',');
  m._el && null;
  m.state.selected = 1;
  m.removeText();
  if (m.state.texts.length !== 2) throw new Error('没删掉');
  if (m.state.texts.map((t) => t.id).join(',') === ids) throw new Error('删的是同一个');
  if (m.state.selected !== 1) throw new Error('删完选中项没落到下一条');
});

step('删光之后没有选中项', () => {
  m = boot();
  m.addText();
  m.removeText();
  if (m.state.texts.length) throw new Error('没删干净');
  if (m.state.selected !== -1) throw new Error('没文字了却还有选中项');
});

step('多行文字逐行画出来', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintText(ctx, { body: '上面\n下面', x: 50, y: 50, size: 10, color: '#fff', outline: false }, 1000, 800);
  if (ctx.calls.fillText.length !== 2) {
    throw new Error('两行该画两次，实际 ' + ctx.calls.fillText.length + ' 次');
  }
  if (ctx.calls.fillText[0] !== '上面' || ctx.calls.fillText[1] !== '下面') {
    throw new Error('行内容不对：' + ctx.calls.fillText.join('|'));
  }
});

step('字号按图宽换算（10% 在 1000 宽的图上就是 100px）', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintText(ctx, { body: 'x', x: 50, y: 50, size: 10, color: '#fff', outline: false }, 1000, 800);
  /* 字体串是 "800 100px 字体名" —— parseFloat 会先吃到字重那个 800，
     所以必须用正则把带 px 的那段拎出来。 */
  const m2 = /(\d+(?:\.\d+)?)px/.exec(ctx._font);
  const got = m2 ? Number(m2[1]) : NaN;
  if (!(Math.abs(got - 100) <= 0.6)) {
    throw new Error('字号算成了 ' + got + 'px（字体串是 ' + ctx._font + '），应该是 100px');
  }
});

step('开了黑边会先描边再填色', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintText(ctx, { body: '字', x: 50, y: 50, size: 10, color: '#fff', outline: true }, 1000, 800);
  if (!ctx.calls.strokeText.length) throw new Error('开了黑边却没描边');
  if (!ctx.calls.fillText.length) throw new Error('描完没填色');
});

step('空文字不会往画布上写东西', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintText(ctx, { body: '', x: 50, y: 50, size: 10, color: '#fff' }, 1000, 800);
  if (ctx.calls.fillText.length) throw new Error('空字符串也画了');
});

/* ---------------------------------------------------------------- 画笔 */

step('画一笔：按下到抬起的每个点都记下来', () => {
  m = boot();
  m.setMode('brush');
  m._startStroke({ clientX: 100, clientY: 100 });
  if (m.state.strokes.length !== 1) throw new Error('没开始画');
  m._continueStroke({ clientX: 200, clientY: 150 });
  m._continueStroke({ clientX: 300, clientY: 200 });
  if (m.state.strokes[0].points.length !== 3) {
    throw new Error('记了 ' + m.state.strokes[0].points.length + ' 个点，应该是 3');
  }
  m._endStroke();
  if (m.state.drawing) throw new Error('抬笔后没结束这一笔');
});

step('笔画点也是百分比', () => {
  m = boot();
  m.setMode('brush');
  m._startStroke({ clientX: 100, clientY: 100 });
  const p = m.state.strokes[0].points[0];
  if (!(p.x >= 0 && p.x <= 100) || !(p.y >= 0 && p.y <= 100)) {
    throw new Error('不是百分比：' + JSON.stringify(p));
  }
  /* 容器 900×600，点 (450,300) 正好是中心 */
  m._endStroke();
  m._startStroke({ clientX: 450, clientY: 300 });
  const c = m.state.strokes[1].points[0];
  if (Math.abs(c.x - 50) > 0.6 || Math.abs(c.y - 50) > 0.6) {
    throw new Error('中心点算成了 ' + c.x + ',' + c.y);
  }
});

step('文字模式下不会画上东西', () => {
  m = boot();
  m.setMode('text');
  m._startStroke({ clientX: 100, clientY: 100 });
  if (m.state.strokes.length) throw new Error('文字模式却画上了');
});

step('撤销上一笔', () => {
  m = boot();
  m.setMode('brush');
  m._startStroke({ clientX: 100, clientY: 100 }); m._endStroke();
  m._startStroke({ clientX: 200, clientY: 200 }); m._endStroke();
  if (m.state.strokes.length !== 2) throw new Error('没画上两笔');
  m.undoStroke();
  if (m.state.strokes.length !== 1) throw new Error('撤销没生效');
  m.undoStroke();
  m.undoStroke();
  if (m.state.strokes.length !== 0) throw new Error('撤到底变成负数了？');
});

step('全部清掉', () => {
  m = boot();
  m.setMode('brush');
  for (let i = 0; i < 3; i++) { m._startStroke({ clientX: 100 + i * 50, clientY: 100 }); m._endStroke(); }
  m.clearStrokes();
  if (m.state.strokes.length) throw new Error('没清干净');
});

step('一笔多点的线是连起来的', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintStroke(ctx, {
    color: '#fff', width: 4,
    points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }],
  }, 1000, 800);
  if (ctx.calls.moveTo.length !== 1) throw new Error('起点该 moveTo 一次，实际 ' + ctx.calls.moveTo.length);
  if (ctx.calls.lineTo.length !== 2) throw new Error('其余两点该 lineTo，实际 ' + ctx.calls.lineTo.length);
  if (!ctx.calls.stroke) throw new Error('没描出来');
});

step('单点也留个圆点（不然点一下什么都没有）', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintStroke(ctx, { color: '#fff', width: 4, points: [{ x: 50, y: 50 }] }, 1000, 800);
  if (!ctx.calls.arc) throw new Error('单点没画成圆点');
});

step('线宽按图宽换算', () => {
  m = boot();
  const ctx = spyCtx();
  m.paintStroke(ctx, { color: '#fff', width: 5, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, 1000, 800);
  if (Math.abs(ctx._lw - 50) > 0.6) throw new Error('5% 在 1000 宽的图上该是 50px，实际 ' + ctx._lw);
});

/* ---------------------------------------------------------------- 模式 */

step('切模式会换工具面板', () => {
  m = boot();
  m.setMode('brush');
  if (m._el().textTools.classList.contains('is-hidden') === false) {
    throw new Error('换到画笔了，文字面板还露着');
  }
  if (m._el().brushTools.classList.contains('is-hidden')) {
    throw new Error('换到画笔了，画笔面板没露出来');
  }
  m.setMode('text');
  if (m._el().textTools.classList.contains('is-hidden')) throw new Error('换回文字，面板没回来');
  if (!m._el().brushTools.classList.contains('is-hidden')) throw new Error('画笔面板没收起来');
});

step('切模式会在画布上标出来（用来换光标）', () => {
  m = boot();
  m.setMode('brush');
  if (m._el().frame.dataset.mode !== 'brush') throw new Error('画布上没标模式');
});

step('乱传模式会被忽略', () => {
  m = boot();
  m.setMode('text');
  m.setMode('nonsense');
  if (m.state.mode !== 'text') throw new Error('被乱值改掉了模式');
});

step('色板点了会换颜色', () => {
  m = boot();
  const before = m.state.color;
  m.state.color = '#e53e3e';
  const box = m._el().colors;
  /* 色板是 render 时重建的，这里只确认它渲染出了色块 */
  if (!box.children.length) throw new Error('色板没渲染出东西');
  if (m._el().colors.children.length !== 8) {
    throw new Error('色板该有 8 个色块，实际 ' + m._el().colors.children.length);
  }
  m.state.color = before;
});

/* ---------------------------------------------------------------- 生成 */

step('生成出来是原图尺寸，不是显示尺寸', () => {
  m = boot();
  m.addText();
  m.setMode('brush');
  m._startStroke({ clientX: 100, clientY: 100 });
  m._endStroke();
  const cv = document.createElement('canvas');
  m.drawTo(cv);
  if (cv.width !== IMG.naturalWidth || cv.height !== IMG.naturalHeight) {
    throw new Error('画布 ' + cv.width + '×' + cv.height + '，应该等于原图 ' +
      IMG.naturalWidth + '×' + IMG.naturalHeight);
  }
});

step('什么都没写没画时生成会提示', () => {
  m = boot();
  m.generate();
  if (m._el().status.textContent.indexOf('没什么可生成') < 0) {
    throw new Error('没提示，实际是：' + m._el().status.textContent);
  }
});

step('换底图会把文字和笔画都清掉', () => {
  m = boot();
  m.addText();
  m.setMode('brush');
  m._startStroke({ clientX: 100, clientY: 100 }); m._endStroke();
  m._setImage({ naturalWidth: 640, naturalHeight: 480 }, 'blob:new');
  if (m.state.texts.length) throw new Error('文字没清');
  if (m.state.strokes.length) throw new Error('笔画没清');
  if (m.state.selected !== -1) throw new Error('选中项没复位');
});

step('拖拽和画线都挂在 document 上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/paint.js'), 'utf8');
  const onDoc = (src.match(/document\.addEventListener\("pointer/g) || []).length;
  if (onDoc < 3) throw new Error('document 级指针监听只有 ' + onDoc + ' 处');
  if (/canvas\.addEventListener\("pointermove"/.test(src)) {
    throw new Error('画线监听挂在画布上了，指针一移出去笔画就断');
  }
  if (src.indexOf('setPointerCapture') >= 0) {
    throw new Error('出现了 setPointerCapture，会和 document 级监听抢事件');
  }
});

step('窗口尺寸变了会重排（位置是按百分比存的，得重算像素）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/paint.js'), 'utf8');
  if (src.indexOf('addEventListener("resize"') < 0) {
    throw new Error('没监听 resize —— 拉窗口之后文字和笔画会错位');
  }
});


step('切到这个标签时会重新排一次版', () => {
  m = boot();
  m.addText();
  const before = m._el().layer.children.length;
  /* 模拟从别的标签切过来 */
  window.dispatchEvent({ type: 'm8studio:switch', detail: { tool: 'paint' } });
  const after = m._el().layer.children.length;
  if (after !== before) throw new Error('重排把文字弄丢了：' + before + ' -> ' + after);
  if (!after) throw new Error('重排之后没有文字节点');
});

step('切到别的标签时不做多余的事', () => {
  m = boot();
  m.addText();
  const before = m._el().layer.children.length;
  window.dispatchEvent({ type: 'm8studio:switch', detail: { tool: 'cut' } });
  if (m._el().layer.children.length !== before) throw new Error('被别的标签影响到了');
});

console.log('');
if (fails.length) {
  console.log('文字与画笔实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('文字与画笔实跑检查：全部通过');
}
