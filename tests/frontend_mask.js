/* ============================================================================
 * 图片工坊 · 分段遮挡的实跑检查
 *
 * 这个功能和分段裁剪长得很像，但有三处**故意不一样**，测试主要就是钉住这三点：
 *   1. 条数 n 对应 **n 条**遮罩（分段裁剪是 n-1 条线）
 *   2. 条之间**允许重叠**，不互相挡 —— 想连成一片就拖到一起
 *   3. 条只夹图片边界，不能整条拖出画面外
 *
 * 另外文字排版单独测：竖向遮罩条又高又窄，字号和换行算错就整句看不见。
 *
 * 用法：node tests/frontend_mask.js
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
      const ctx = { canvas: el, measureText: () => ({ width: 40 }) };
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

const IDS = ['maskPanel', 'maskFrame', 'maskSource', 'maskStrips', 'maskDir', 'maskCount',
  'maskCountOut', 'maskThick', 'maskThickOut', 'maskText', 'maskInfo', 'maskGenerate',
  'maskStatus', 'maskPreview', 'maskPreviewGrid', 'maskPreviewNote'];

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

  globalThis.M8Studio = {
    state: { img: null, url: '', name: 'test', tool: 'mask' },
    onImage: noop,
    reset: noop,
  };

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/mask.js'), 'utf8');
  const api = new Function(src + '\n;return M8Mask;')();
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
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.01 : tol);

/* 可控的假画布上下文：measureText 按字号线性估算，用来逼出换行和缩放 */
function fakeCtx() {
  let size = 10;
  return {
    set font(v) { const m = /(\d+(?:\.\d+)?)px/.exec(v); if (m) size = Number(m[1]); },
    get font() { return size + 'px'; },
    measureText(s) { return { width: s.length * size * 0.62 }; },
    fillText: noop,
    set fillStyle(v) {},
    set textAlign(v) {},
    set textBaseline(v) {},
  };
}

/* ---------------------------------------------------------------- 跑 */

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Mask 没导出来');
  if (m.state.dir !== 'h') throw new Error('默认不是横遮');
  if (m.state.text.indexOf('Ciallo') < 0) throw new Error('默认文字不对：' + m.state.text);
});

step('条数 n 就是 n 条遮罩（不像分段裁剪是 n-1 条线）', () => {
  m = boot();
  for (const n of [1, 2, 3, 5, 10]) {
    m.setCount(n);
    if (m.state.centers.length !== n) {
      throw new Error(n + ' 条应该有 ' + n + ' 个中心，实际 ' + m.state.centers.length);
    }
    const strips = m._el().strips.children.length;
    if (strips !== n) throw new Error(n + ' 条只画出来 ' + strips + ' 个黑条');
  }
});

step('默认是均匀分布的', () => {
  m = boot();
  m.setCount(4);
  const want = [12.5, 37.5, 62.5, 87.5];
  m.state.centers.forEach((v, i) => {
    if (!near(v, want[i], 0.001)) throw new Error('第 ' + (i + 1) + ' 条应在 ' + want[i] + '%，实际 ' + v);
  });
});

step('横遮盖满整宽，高度等于原图高 × 厚度', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  m.setThick(20);
  const r = m.rectOf(0);
  if (r.x !== 0 || r.w !== 1200) throw new Error('横遮应该盖满整宽，实际 x=' + r.x + ' w=' + r.w);
  if (!near(r.h, 160, 0.5)) throw new Error('20% 的厚度在 800 高的图上应该是 160，实际 ' + r.h);
  /* 中心 16.67%，厚度 20% → 上边在 6.67% */
  if (!near(r.y, (16.6667 - 10) / 100 * 800, 1)) throw new Error('上边位置不对：' + r.y);
});

step('竖遮盖满整高，宽度等于原图宽 × 厚度', () => {
  m = boot();
  m.setCount(3);
  m.setDir('v');
  m.setThick(20);
  const r = m.rectOf(0);
  if (r.y !== 0 || r.h !== 800) throw new Error('竖遮应该盖满整高，实际 y=' + r.y + ' h=' + r.h);
  if (!near(r.w, 240, 0.5)) throw new Error('20% 的厚度在 1200 宽的图上应该是 240，实际 ' + r.w);
});

step('改厚度，条的尺寸跟着变', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  const thin = m.rectOf(0).h;
  m.setThick(30);
  const thick = m.rectOf(0).h;
  if (!(thick > thin)) throw new Error('加厚之后条没变厚：' + thin + ' -> ' + thick);
  if (deepThick(m) > 40) throw new Error('厚度上限没夹住');
  m.setThick(1000);
  if (m.state.thick !== 40) throw new Error('厚度上限应该是 40%，实际 ' + m.state.thick);
  m.setThick(1);
  if (m.state.thick !== 3) throw new Error('厚度下限应该是 3%，实际 ' + m.state.thick);
});
function deepThick(x) { return x.state.thick; }

step('拖动黑条：位置跟着指针走', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  m.state.drag = 0;
  /* 容器 900x600，y=300 就是 50% */
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 300 });
  if (!near(m.state.centers[0], 50, 0.5)) throw new Error('拖到中间应落在 50%，实际 ' + m.state.centers[0]);
  document.dispatchEvent({ type: 'pointerup' });
  if (m.state.drag !== -1) throw new Error('松手后没结束拖拽');
});

step('黑条不会整条拖出画面', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  m.setThick(20);
  /* 硬往最顶上拖：中心最多到厚度的一半，否则条会露出画面 */
  m.state.drag = 0;
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: -500 });
  document.dispatchEvent({ type: 'pointerup' });
  if (m.state.centers[0] < 10 - 0.01) {
    throw new Error('中心跑到 ' + m.state.centers[0] + '% 了，10% 厚度时最多只能到 10%');
  }
  const r = m.rectOf(0);
  if (r.y < -0.5) throw new Error('条露到画面外了，y=' + r.y);
});

step('条之间允许叠在一起（这里是遮挡，不是切割）', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  /* 把第 2 条硬拖到跟第 1 条同一位置 —— 分段裁剪那里会被挡住，这里不该挡 */
  m.state.drag = 1;
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 300 });
  document.dispatchEvent({ type: 'pointerup' });
  m.state.drag = 0;
  document.dispatchEvent({ type: 'pointermove', clientX: 0, clientY: 300 });
  document.dispatchEvent({ type: 'pointerup' });
  if (!near(m.state.centers[0], m.state.centers[1], 0.5)) {
    throw new Error('两条没能拖到一起：' + m.state.centers[0] + ' vs ' + m.state.centers[1]);
  }
});

step('方向切换后，条的朝向跟着变', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  const hRect = m.rectOf(0);
  m.setDir('v');
  const vRect = m.rectOf(0);
  /* 横遮：盖满整宽，高度只占图高的一小块
     竖遮：盖满整高，宽度只占图宽的一小块
     （一开始把这条写反了，以为横遮的条也该跟图一样高 —— 那是「整图遮挡」） */
  if (hRect.w !== 1200 || hRect.h === 800) {
    throw new Error('横遮形状不对：' + hRect.w + 'x' + hRect.h);
  }
  if (vRect.h !== 800 || vRect.w === 1200) {
    throw new Error('竖遮形状不对：' + vRect.w + 'x' + vRect.h);
  }
  if (!(vRect.w < hRect.w)) throw new Error('竖遮的条应该比横遮窄：' + vRect.w + ' vs ' + hRect.w);
});

step('文字装得进框：长句子会缩小并换行', () => {
  m = boot();
  const text = m.state.text;
  /* 窄框：宽 300、高 60 */
  const fit = m.fitText(fakeCtx(), text, 300, 60);
  if (!fit.lines.length) throw new Error('一行都没排出来');
  if (fit.lines.length < 2) throw new Error('这么长的句子在 300px 宽里应该要换行');
  const need = fit.lines.length * fit.size * 1.22;
  if (need > 60.5) throw new Error('排完还装不下：需要 ' + need.toFixed(1) + 'px，框只有 60px');
});

step('框越大字越大（字号确实跟着框走）', () => {
  m = boot();
  const text = m.state.text;
  const small = m.fitText(fakeCtx(), text, 260, 48).size;
  const big = m.fitText(fakeCtx(), text, 900, 160).size;
  if (!(big > small)) throw new Error('大字框里字号反而更小：' + small + ' -> ' + big);
});

step('字号有下限，不会缩到看不见', () => {
  m = boot();
  const fit = m.fitText(fakeCtx(), m.state.text, 40, 20);
  if (fit.size < 6) throw new Error('字号缩到 ' + fit.size + 'px 了，太小');
  if (fit.size > 6.01 && !fit.fits) throw new Error('还缩得下去却没缩到装下为止');
});

step('条数下限是 1（只想盖一条也应该可以）', () => {
  m = boot();
  m.setCount(0);
  if (m.state.count !== 1) throw new Error('拖到 0 应该夹到 1，实际 ' + m.state.count);
  if (m.state.centers.length !== 1) throw new Error('1 条应该有 1 个中心');
  if (m._el().strips.children.length !== 1) throw new Error('画面上应该有 1 条');
  if (!near(m.state.centers[0], 50, 0.001)) {
    throw new Error('只盖一条时应该在正中间，实际 ' + m.state.centers[0]);
  }
  m.setCount(99);
  if (m.state.count !== 10) throw new Error('上限应该是 10，实际 ' + m.state.count);
});

step('文字必须整句显示出来，一个字都不能少', () => {
  m = boot();
  const text = m.state.text;
  /* 这条是为一个真实问题补的：预览的字号原来用「一个字约 0.58 个字宽」估算，
     而中文是全角（一个字差不多就是一个字号宽），算出来的字号偏大，
     整句就被 overflow:hidden 裁掉了。现在改用真测量，这里把各种极端尺寸都试一遍。 */
  for (const w of [180, 400, 900, 1600]) {
    for (const ratio of [0.03, 0.06, 0.12, 0.2, 0.4]) {
      const h = Math.max(1, w * ratio);
      const fit = m.fitText(fakeCtx(), text, w, h);
      if (fit.lines.join('') !== text) {
        throw new Error('文字被截断了：' + fit.lines.join('|'));
      }
      for (const line of fit.lines) {
        /* 估宽必须用 Math.round(fit.size)：fitText 内部是拿四舍五入后的字号去
           measureText 断行的（它只 Math.round 了字号，没改 fit.size 本身），
           这里再用未取整的 fit.size 算，比值一偏就会误报"超宽"。 */
        const lw = line.length * Math.round(fit.size) * 0.62;
        if (lw > w + 0.5) {
          throw new Error('有一行超宽：在 ' + w + 'px 的框里占 ' + lw.toFixed(0) + 'px');
        }
      }
      /* 实在装不下时，字号必须已经压到下限 —— 不允许「还缩得下去却没缩」 */
      const need = fit.lines.length * fit.size * 1.22;
      if (need > h + 0.5 && fit.size > 6.01) {
        throw new Error('框 ' + w + 'x' + h.toFixed(0) + ' 没排下，但字号还有 ' + fit.size + 'px 可以缩');
      }
      if (need > h + 0.5 && fit.fits) throw new Error('装不下却报了 fits');
    }
  }
});

step('换行是按字断的，不会丢字', () => {
  m = boot();
  const ctx = fakeCtx();
  const text = '一二三四五六七八九十';
  const lines = m.wrapText(ctx, text, 99999);
  if (lines.length !== 1 || lines[0] !== text) throw new Error('宽框里不该换行');
  const narrow = m.wrapText(ctx, text, 30);
  const joined = narrow.join('');
  if (joined !== text) throw new Error('换行把字弄丢了：' + joined);
});

step('竖向遮罩时，文字盒子被摆成横躺的条再转 90 度', () => {
  m = boot();
  m.setCount(3);
  m.setDir('v');
  const strip = m._el().strips.children[0];
  const label = strip.children[0];
  if (!label.classSet.has('rotated')) throw new Error('竖遮的文字没加 rotated');
  if (!label.style.transform || String(label.style.transform).indexOf('rotate(90deg)') < 0) {
    throw new Error('没有转 90 度：' + label.style.transform);
  }
  /* 必须用像素定宽：transform 只转视觉不改布局盒，
     盒还是窄的话 overflow:hidden 会先把文字裁掉 */
  const w = parseFloat(String(label.style.width));
  if (!(w > 400)) throw new Error('盒子没被摆开，宽只有 ' + w + 'px，文字会被裁掉');
});

step('横遮时不给文字加旋转', () => {
  m = boot();
  m.setCount(3);
  m.setDir('h');
  const label = m._el().strips.children[0].children[0];
  if (label.classSet.has('rotated')) throw new Error('横遮的文字不该旋转');
  if (String(label.style.transform || '').indexOf('rotate') >= 0) {
    throw new Error('横遮的文字带了旋转：' + label.style.transform);
  }
});

step('改文字会同步到每一条上', () => {
  m = boot();
  m.setCount(4);
  m.setText('换一句话');
  const strips = m._el().strips.children;
  let hit = 0;
  for (const s of strips) {
    if (s.children[0] && s.children[0].textContent === '换一句话') hit += 1;
  }
  if (hit !== 4) throw new Error('4 条里只有 ' + hit + ' 条更新了文字');
});

step('清掉图片时条也清掉', () => {
  m = boot();
  m.setCount(5);
  m._setImage(null);
  if (m.state.img) throw new Error('图片没清');
  if (m.state.centers.length) throw new Error('条没清');
  if (m._el().strips.children.length) throw new Error('画面上的黑条没清');
});

step('拖拽监听挂在 document 上', () => {
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/mask.js'), 'utf8');
  const onDoc = (src.match(/document\.addEventListener\("pointer/g) || []).length;
  if (onDoc < 3) throw new Error('document 级指针监听只有 ' + onDoc + ' 处');
  if (/strip\.addEventListener\("pointermove"/.test(src)) {
    throw new Error('拖拽监听挂在黑条上了，指针一移出条就断');
  }
  if (src.indexOf('setPointerCapture') >= 0) {
    throw new Error('出现了 setPointerCapture，会和 document 级监听抢事件');
  }
});

step('生成出来的图就是原图尺寸（不是切成多张）', () => {
  m = boot();
  m.setCount(3);
  const cv = document.createElement('canvas');
  m._drawTo(cv);
  if (cv.width !== IMG.naturalWidth || cv.height !== IMG.naturalHeight) {
    throw new Error('画布是 ' + cv.width + 'x' + cv.height + '，应该等于原图 ' + IMG.naturalWidth + 'x' + IMG.naturalHeight);
  }
});

console.log('');
if (fails.length) {
  console.log('分段遮挡实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('分段遮挡实跑检查：全部通过');
}
