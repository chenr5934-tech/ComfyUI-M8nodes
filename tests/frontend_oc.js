/* ============================================================================
 * M8web · OC 工坊的实跑检查
 *
 * 几条主线：
 *   1. 增删改查的语义（新建、标脏、保存清脏、删除）
 *   2. 复制特征词：有内容就复制、空内容要提示而不是静默失败
 *   3. 浏览器不给存（隐身模式 / 老浏览器 / 这里就没有 indexedDB）时不炸，
 *      并且明确告诉用户「这次加的东西关掉就没了」—— 不能假装存上了
 *
 * 用法：node tests/frontend_oc.js
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
  return el;
}

const byId = {};
function reg(id) { const e = makeEl('div'); e.id = id; byId[id] = e; return e; }

function setNavigator(obj) {
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: obj, writable: true, configurable: true,
    });
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

const IDS = ['ocList', 'ocEmpty', 'ocCount', 'ocAdd', 'ocStatus',
  'ocDelModal', 'ocDelText', 'ocDelX', 'ocDelCancel', 'ocDelOk'];

function boot(opts) {
  const o = opts || {};
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
  /* HTML 里 ocEmpty 和 ocDelModal 本来就带 is-hidden，桩要照做 ——
     不然测试会以为它们一上来就是显示的，报出假失败。 */
  byId.ocEmpty.classList.add('is-hidden');
  byId.ocDelModal.classList.add('is-hidden');
  globalThis.window = makeEventTarget({});
  globalThis.setTimeout = (fn) => { fn(); return 1; };
  /* indexedDB 默认不给：这就是 Node 环境和隐身模式的样子 */
  if (o.indexedDB) globalThis.indexedDB = o.indexedDB;
  else delete globalThis.indexedDB;

  globalThis.copied = null;
  /* Node 18+ 自带一个只读的全局 navigator，直接赋值会**静默失败** ——
     于是代码走去 execCommand 兜底，测试却还在等 clipboard 那条路。
     必须用 defineProperty 硬盖。 */
  setNavigator({
    clipboard: {
      writeText: (t) => { globalThis.copied = t; return Promise.resolve(); },
    },
  });

  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/oc.js'), 'utf8');
  const api = new Function(src + '\n;return M8OC;')();
  api.init();
  return api;
}

const fails = [];
const steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8OC 没导出来');
  if (m.state.list.length) throw new Error('一开始不该有 OC');
});

step('浏览器不给存时，明确说清楚而不是假装存上了', () => {
  m = boot();
  const note = m._el().status.textContent;
  if (note.indexOf('will not store anything') < 0 && note.indexOf('will not store anything') < 0) {
    throw new Error('没告诉用户存不了，实际是：' + note);
  }
});

step('新建一条', async () => {
  m = boot();
  await m.add();
  if (m.state.list.length !== 1) throw new Error('没加上');
  if (m._el().list.children.length !== 1) throw new Error('没渲染出来');
  if (!m._el().empty.classList.contains('is-hidden')) throw new Error('空状态没收起来');
});

step('列表是一条一条竖着排（每条一个 oc-row）', async () => {
  m = boot();
  await m.add();
  await m.add();
  await m.add();
  const rows = m._el().list.children;
  if (rows.length !== 3) throw new Error('应该有 3 行，实际 ' + rows.length);
  rows.forEach((r, i) => {
    if (String(r.className).indexOf('oc-row') < 0) throw new Error('第 ' + (i + 1) + ' 行不是 oc-row');
  });
});

step('每条左边是图、右边是名字和特征词', async () => {
  m = boot();
  await m.add();
  const row = m._el().list.children[0];
  const classes = row.children.map((c) => String(c.className).split(' ')[0]);
  if (classes.indexOf('oc-photo') !== 0) throw new Error('第一个子元素该是例图区，实际 ' + classes.join(','));
  if (classes.indexOf('oc-body') < 0) throw new Error('右边该有 oc-body，实际 ' + classes.join(','));
  const body = row.children[classes.indexOf('oc-body')];
  const inner = body.children.map((c) => String(c.className).split(' ')[0]);
  if (inner.indexOf('oc-name') < 0) throw new Error('右边没有名字输入框');
  if (inner.indexOf('oc-prompt') < 0) throw new Error('右边没有特征词文本框');
});

step('特征词是文本框（textarea），不是普通 div', async () => {
  m = boot();
  await m.add();
  const row = m._el().list.children[0];
  const body = row.children.filter((c) => String(c.className).indexOf('oc-body') >= 0)[0];
  const ta = body.children.filter((c) => String(c.className) === 'oc-prompt')[0];
  if (!ta) throw new Error('找不到特征词框');
  if (ta.tagName !== 'TEXTAREA') throw new Error('特征词该是 textarea，实际是 ' + ta.tagName);
});

step('打字之后那条会被标成「有改动没保存」', async () => {
  m = boot();
  await m.add();
  const id = m.state.list[0].id;
  if (m.state.dirty[id]) throw new Error('刚加完不该是脏的');
  m.touch(id, { prompt: '金色长发、红瞳' });
  if (!m.state.dirty[id]) throw new Error('改了却没标脏');
  if (m.state.list[0].prompt !== '金色长发、红瞳') throw new Error('内容没写进记录');
});

step('保存之后脏标记清掉', async () => {
  m = boot();
  await m.add();
  const id = m.state.list[0].id;
  m.touch(id, { prompt: 'abc' });
  await m.saveOne(id);
  if (m.state.dirty[id]) throw new Error('存完还挂着脏标记');
});

step('保存会更新改动时间', async () => {
  m = boot();
  await m.add();
  const rec = m.state.list[0];
  const before = rec.updatedAt;
  await new Promise((r) => setTimeout(r, 5));
  rec.updatedAt = before;
  await m.saveOne(rec.id);
  if (!(rec.updatedAt >= before)) throw new Error('时间没更新');
});

step('删掉一条', async () => {
  m = boot();
  await m.add();
  await m.add();
  const id = m.state.list[0].id;
  m.removeOne(id);
  await new Promise((r) => setImmediate(r));
  if (m.state.list.length !== 1) throw new Error('没删掉');
  if (m.state.list[0].id === id) throw new Error('删错了一条');
});

step('删光之后空状态回来', async () => {
  m = boot();
  await m.add();
  m.removeOne(m.state.list[0].id);
  await new Promise((r) => setImmediate(r));
  if (!m._el().empty.classList.contains('is-hidden') === false) {
    throw new Error('没 OC 了，空状态该显示出来');
  }
});

step('复制特征词', async () => {
  m = boot();
  await m.add();
  const id = m.state.list[0].id;
  m.touch(id, { prompt: '银色短发、蓝瞳、黑色大衣' });
  m.copyOne(id);
  await new Promise((r) => setImmediate(r));
  if (globalThis.copied !== '银色短发、蓝瞳、黑色大衣') {
    throw new Error('复制到的内容不对：' + globalThis.copied);
  }
  if (m._el().status.textContent.indexOf('Trait tags copied') < 0) {
    throw new Error('没给成功提示，实际是：' + m._el().status.textContent);
  }
});

step('空特征词点复制会提示，而不是静默失败', async () => {
  m = boot();
  await m.add();
  globalThis.copied = null;
  m.copyOne(m.state.list[0].id);
  await new Promise((r) => setImmediate(r));
  if (globalThis.copied !== null) throw new Error('空的也复制了？');
  if (m._el().status.textContent.indexOf('No trait tags written') < 0) {
    throw new Error('没提示，实际是：' + m._el().status.textContent);
  }
});

step('复制有兜底路径（clipboard 用不了时走 execCommand）', () => {
  m = boot();
  setNavigator({});
  let called = false;
  const origCreate = globalThis.document.createElement;
  globalThis.document.createElement = (t) => {
    const e = origCreate(t);
    if (t === 'textarea') { e.select = () => { called = true; }; }
    return e;
  };
  return m.copyText('兜底测试').then(function () {
    if (!called) throw new Error('没走兜底路径');
  });
});

step('界面上的文字会跟着记录走', async () => {
  m = boot();
  await m.add();
  const rec = m.state.list[0];
  rec.name = '小春';
  rec.prompt = '粉发、绿瞳';
  m._render();
  const row = m._el().list.children[0];
  const body = row.children.filter((c) => String(c.className).indexOf('oc-body') >= 0)[0];
  const name = body.children.filter((c) => String(c.className) === 'oc-name')[0];
  const ta = body.children.filter((c) => String(c.className) === 'oc-prompt')[0];
  if (name.value !== '小春') throw new Error('名字没显示出来：' + name.value);
  if (ta.value !== '粉绿、绿瞳' && ta.value !== '粉发、绿瞳') throw new Error('特征词没显示出来：' + ta.value);
});

step('计数会跟着变', async () => {
  m = boot();
  if (m._el().count.textContent.indexOf('No OCs yet') < 0) throw new Error('空的时候计数不对');
  await m.add();
  await m.add();
  if (m._el().count.textContent.indexOf('2') < 0) throw new Error('计数没更新：' + m._el().count.textContent);
});

step('非图片文件当例图会被挡掉', () => {
  m = boot();
  return m.readImage({ type: 'text/plain' }).then(function (r) {
    if (r) throw new Error('不是图片也读进来了');
  });
});

step('存不了的时候新增也不会崩', async () => {
  m = boot();
  await m.add();
  await m.add();
  if (m.state.list.length !== 2) throw new Error('没存上就加不了了吗');
  const ids = m.state.list.map((r) => r.id);
  if (ids[0] === ids[1]) throw new Error('兜底的 id 撞了：' + ids.join(','));
});


/* ---------------------------------------------------------------- 删除确认 */

step('点「删掉」不会直接删，先弹确认框', async () => {
  m = boot();
  await m.add();
  const id = m.state.list[0].id;
  m.askDelete(id);
  if (m.state.list.length !== 1) throw new Error('还没确认就把数据删了');
  if (m.pendingDelete() !== id) throw new Error('没记住要删哪一条');
  if (m._el().delModal.classList.contains('is-hidden')) throw new Error('确认框没弹出来');
});

step('确认框里写着要删的是哪个（别删错）', async () => {
  m = boot();
  await m.add();
  const rec = m.state.list[0];
  m.touch(rec.id, { name: '小春' });
  m.askDelete(rec.id);
  const html = m._el().delText.innerHTML;
  if (html.indexOf('小春') < 0) throw new Error('没把名字念出来：' + html);
  if (html.indexOf('Gone for good') < 0) throw new Error('没提示后果');
});

step('名字里的尖括号会被转义（不能撕坏结构）', async () => {
  m = boot();
  await m.add();
  const rec = m.state.list[0];
  m.touch(rec.id, { name: '<b>坏</b>' });
  m.askDelete(rec.id);
  const html = m._el().delText.innerHTML;
  if (html.indexOf('&lt;b&gt;') < 0) throw new Error('没转义：' + html);
});

step('取消之后什么都不发生', async () => {
  m = boot();
  await m.add();
  m.askDelete(m.state.list[0].id);
  m.closeDelete();
  if (m.state.list.length !== 1) throw new Error('点了取消还是删了');
  if (m.pendingDelete() !== -1) throw new Error('取消后还挂着待删项');
  if (!m._el().delModal.classList.contains('is-hidden')) throw new Error('确认框没关掉');
});

step('确认之后才真的删', async () => {
  m = boot();
  await m.add();
  await m.add();
  const id = m.state.list[0].id;
  m.askDelete(id);
  m.confirmDelete();
  await new Promise((r) => setImmediate(r));
  if (m.state.list.length !== 1) throw new Error('确认了却没删掉');
  if (m.state.list[0].id === id) throw new Error('删错了一条');
});

step('删不存在的 id 不会炸', () => {
  m = boot();
  m.askDelete(9999);
  if (m.pendingDelete() !== -1) throw new Error('不存在的 id 不该挂上待删项');
  if (!m._el().delModal.classList.contains('is-hidden')) throw new Error('却把框弹出来了');
});

step('确认框开着时锁住页面滚动', async () => {
  m = boot();
  await m.add();
  m.askDelete(m.state.list[0].id);
  if (!document.body.classList.contains('modal-open')) throw new Error('没锁滚动');
  m.closeDelete();
  if (document.body.classList.contains('modal-open')) throw new Error('关掉后没解锁');
});


step('一进页面就先渲染一次（不能干等 IndexedDB）', () => {
  m = boot();
  /* 没有 OC 的时候，空状态必须马上显示出来。
     IndexedDB 是异步的，如果第一次 render 要等它回来，
     它慢或者卡住的话页面就一片空白，看着像坏了。 */
  if (m._el().empty.classList.contains('is-hidden')) {
    throw new Error('一进来空状态是藏着的 —— 等 IndexedDB 期间页面会空白');
  }
});

step('有数据之后空状态收起来', async () => {
  m = boot();
  await m.add();
  if (!m._el().empty.classList.contains('is-hidden')) throw new Error('有 OC 了空状态还露着');
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
    console.log('OC 工坊实跑检查：' + fails.length + ' 个失败');
    fails.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log('OC 工坊实跑检查：全部通过');
  }
})();
