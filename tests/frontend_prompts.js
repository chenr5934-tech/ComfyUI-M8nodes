/* ============================================================================
 * M8web · 提示词归纳的实跑检查
 *
 * 几条主线：
 *   1. 分类筛选取值（这里有个坑：0 恰好是「未分类」，写成「假值就不过滤」就废了）
 *   2. 分类重名自动加后缀，不然下拉框分不清哪个是哪个
 *   3. 浏览器不给存（隐身模式 / 这里就没有 indexedDB）时不炸，而且明确说存不下 ——
 *      不能假装存上了
 *   4. 删除要二次确认，不直接删
 *
 * 真持久化和完整交互测不到（这里没有真 IndexedDB），那些留给浏览器实测。
 *
 * 用法：node tests/frontend_prompts.js
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
    textContent: '', value: '', type: '', id: '', placeholder: '', title: '',
    files: null, src: '', alt: '', disabled: false,
    addEventListener: noop, removeEventListener: noop, focus: noop, click: noop, select: noop,
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
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400, right: 400, bottom: 400 }),
  };
  el.classList = {
    add: (c) => { el.classSet.add(c); },
    remove: (c) => { el.classSet.delete(c); },
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
  /* 元素也要能派发事件。代码里全是 addEventListener 绑的，
     桩不给 dispatchEvent 的话这些按钮在测试里根本点不动（第一版就全卡在这）。 */
  return makeEventTarget(el);
}

const byId = {};
function reg(id) { const e = makeEl('div'); e.id = id; byId[id] = e; return e; }

function setNavigator(obj) {
  try {
    Object.defineProperty(globalThis, 'navigator', { value: obj, writable: true, configurable: true });
  } catch (e) {
    try { globalThis.navigator = obj; } catch (e2) { /* 尽力而为 */ }
  }
}

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

const IDS = ['pgList', 'pgEmpty', 'pgCount', 'pgAddCard', 'pgGroups', 'pgStatus',
  'pgDelModal', 'pgDelTitle', 'pgDelText', 'pgDelX', 'pgDelCancel', 'pgDelOk',
  'pgNameModal', 'pgNameTitle', 'pgNameInput', 'pgNameX', 'pgNameCancel', 'pgNameOk'];

function boot() {
  for (const k of Object.keys(byId)) delete byId[k];
  globalThis.document = makeEventTarget({
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => { const f = makeEl('fragment'); f.__fragment = true; return f; },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: (id) => byId[id] || null,
    body: makeEl('body'),
    execCommand: () => true,
  });
  for (const id of IDS) reg(id);
  /* HTML 里这几个本来就带 is-hidden，桩要照做 —— 不然会报出假失败 */
  byId.pgEmpty.classList.add('is-hidden');
  byId.pgDelModal.classList.add('is-hidden');
  byId.pgNameModal.classList.add('is-hidden');
  globalThis.window = makeEventTarget({});
  globalThis.setTimeout = (fn) => { fn(); return 1; };
  /* indexedDB 默认不给：这就是 Node 环境和隐身模式的样子 */
  delete globalThis.indexedDB;

  globalThis.copied = null;
  setNavigator({
    clipboard: { writeText: (t) => { globalThis.copied = t; return Promise.resolve(); } },
  });

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/prompts.js'), 'utf8');
  const api = new Function(src + '\n;return M8Prompts;')();
  api.init();
  return api;
}

const fails = [];
const steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }

/* 多等几轮。saveCard 那条链是「openDB 的 then → run 的 Promise → newCard 的 then」，
   只等一层的话检查代码会在 setStatus 之前就开跑（第一版就是这么误报的）。
   这里 setTimeout 是同步桩，所以每一轮只推进一个 microtask，得循环几次。 */
async function settle() {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Prompts 没导出来');
});

/* ---------------------------------------------------------------- 分类取值 */

step('groupOf：没归类的都算未分类（0）', () => {
  m = boot();
  if (m.groupOf({ groupId: 5 }) !== 5) throw new Error('正常 id 读错');
  if (m.groupOf({ groupId: 0 }) !== 0) throw new Error('0 该是未分类');
  if (m.groupOf({}) !== 0) throw new Error('没有 groupId 该算未分类');
  if (m.groupOf(null) !== 0) throw new Error('null 该算未分类');
  if (m.groupOf({ groupId: '3' }) !== 0) throw new Error('字符串 id 该当未分类 —— 不然后面全是类型比较的坑');
  if (m.groupOf({ groupId: -2 }) !== 0) throw new Error('负数该当未分类');
});

step('filterCards：null 是全部，0 是未分类', () => {
  m = boot();
  const cards = [
    { id: 1, groupId: 0 }, { id: 2, groupId: 3 },
    { id: 3, groupId: 3 }, { id: 4 },
  ];
  if (m.filterCards(cards, null).length !== 4) throw new Error('null 该返回全部');
  if (m.filterCards(cards, undefined).length !== 4) throw new Error('undefined 该返回全部');
  const none = m.filterCards(cards, 0);
  if (none.length !== 2) throw new Error('未分类该有 2 张，实际 ' + none.length);
  const g3 = m.filterCards(cards, 3);
  if (g3.length !== 2) throw new Error('分类 3 该有 2 张，实际 ' + g3.length);
  /* 这一条是本文件里最值钱的：0 不能被当成「假值就不过滤」 */
  if (none.length === cards.length) throw new Error('筛未分类时退化成全部了 —— 判空值写错了');
  /* 返回的是新数组，别把原数组交出去 */
  const copy = m.filterCards(cards, null);
  copy.push({ id: 99 });
  if (cards.length !== 4) throw new Error('返回了原数组的引用，调用方一改就穿帮');
});

step('countIn：数得对（含未分类）', () => {
  m = boot();
  const cards = [{ groupId: 0 }, { groupId: 2 }, { groupId: 2 }, {}];
  if (m.countIn(cards, 0) !== 2) throw new Error('未分类该 2 个，实际 ' + m.countIn(cards, 0));
  if (m.countIn(cards, 2) !== 2) throw new Error('分类 2 该 2 个');
  if (m.countIn(cards, 7) !== 0) throw new Error('不存在的分类该是 0');
  if (m.countIn([], 0) !== 0) throw new Error('空列表该是 0');
});

step('groupNameOf：找得到就给名字，找不到给空串', () => {
  m = boot();
  const gs = [{ id: 1, name: '构图' }, { id: 2, name: '光影' }];
  if (m.groupNameOf(gs, 2) !== '光影') throw new Error('找错了');
  if (m.groupNameOf(gs, 9) !== '') throw new Error('找不到该给空串');
  if (m.groupNameOf([], 1) !== '') throw new Error('空表该给空串');
});

step('uniqueName：重名自动加后缀', () => {
  m = boot();
  if (m.uniqueName([], '构图') !== '构图') throw new Error('没有重名不该动它');
  if (m.uniqueName([{ name: '构图' }], '构图') !== '构图 2') throw new Error('第一次重名该给 2');
  if (m.uniqueName([{ name: '构图' }, { name: '构图 2' }], '构图') !== '构图 3') {
    throw new Error('连着重名该继续往下数');
  }
  if (m.uniqueName([], '   ') !== '新分类') throw new Error('空白名字该给默认的');
  if (m.uniqueName([], '') !== '新分类') throw new Error('空名字该给默认的');
  if (m.uniqueName([], null) !== '新分类') throw new Error('null 该给默认的');
});

/* ---------------------------------------------------------------- 例图 */

step('取图：不是图片的文件直接返回空串，不去碰 FileReader', () => {
  m = boot();
  return m.readImage({ type: 'text/plain' }).then((r) => {
    if (r !== '') throw new Error('非图片该给空串，实际 ' + JSON.stringify(r));
  });
});

step('取图：没给文件也返回空串', () => {
  m = boot();
  return m.readImage(null).then((r) => {
    if (r !== '') throw new Error('null 该给空串');
  });
});

step('取图：没有 type 的文件也当非图片处理', () => {
  m = boot();
  return m.readImage({}).then((r) => {
    if (r !== '') throw new Error('没有 type 该给空串');
  });
});

/* ---------------------------------------------------------------- 界面 */

step('init 先同步渲染一次，不干等 IndexedDB', () => {
  m = boot();
  const n = byId.pgGroups.children.length;
  if (n < 3) throw new Error('分类条该有「全部」「未分类」「新建分类」，实际 ' + n + ' 个');
  if (byId.pgEmpty.classList.contains('is-hidden')) throw new Error('没有卡片时该显示空状态');
  if (byId.pgList.children.length) throw new Error('没有卡片时列表该是空的');
});

step('存不下的时候：明确说存不下，不假装存上了', () => {
  m = boot();
  byId.pgAddCard.dispatchEvent({ type: 'click' });
  return settle().then(() => {
    const st = byId.pgStatus.textContent || '';
    if (st.indexOf('不给存') < 0) throw new Error('没提示存不下，用户会以为存上了：' + st);
    if (byId.pgList.children.length) throw new Error('存不下却把卡片显示出来了');
  });
});

step('存不下的时候：新建分类也如实说', () => {
  m = boot();
  /* 分类条上的「＋ 新建分类」是渲染出来的，init 时已经绑好监听了 */
  const bar = byId.pgGroups;
  const addBtn = bar.children[bar.children.length - 1];
  if (!addBtn) throw new Error('分类条上没有新建按钮');
  addBtn.dispatchEvent({ type: 'click' });
  return settle().then(() => {
    const st = byId.pgStatus.textContent || '';
    if (st.indexOf('不给存') < 0) throw new Error('新建分类没说存不下：' + st);
  });
});

step('删除确认框：没有待删的东西时，点确认/取消/叉都不炸', () => {
  m = boot();
  byId.pgDelOk.dispatchEvent({ type: 'click' });
  byId.pgDelCancel.dispatchEvent({ type: 'click' });
  byId.pgDelX.dispatchEvent({ type: 'click' });
  if (!byId.pgDelModal.classList.contains('is-hidden')) throw new Error('取消之后框该是关着的');
  return settle();
});

step('改名框：确认之后关上，空名字当没改', () => {
  m = boot();
  byId.pgNameInput.value = '构图';
  byId.pgNameOk.dispatchEvent({ type: 'click' });
  if (!byId.pgNameModal.classList.contains('is-hidden')) throw new Error('确认之后该关上');
  byId.pgNameInput.value = '';
  byId.pgNameOk.dispatchEvent({ type: 'click' });
  if (!byId.pgNameModal.classList.contains('is-hidden')) throw new Error('空名字也该把框关掉');
  return settle();
});

step('分类条上的删除按钮：点了会弹确认，而不是直接删', () => {
  /* 这里没有真 IndexedDB，建不出分类，所以只能验「没有分类时点不炸」。
     带分类的完整流程交给浏览器实测。 */
  m = boot();
  const bar = byId.pgGroups;
  let clicked = 0;
  for (let i = 0; i < bar.children.length; i++) {
    const c = bar.children[i];
    if (c && typeof c.dispatchEvent === 'function') { c.dispatchEvent({ type: 'click' }); clicked++; }
  }
  if (!clicked) throw new Error('分类条上一个可点的都没有');
  return settle();
});

(async () => {
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
    console.log('提示词归纳实跑检查：' + fails.length + ' 个失败');
    fails.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log('提示词归纳实跑检查：全部通过');
  }
})();
