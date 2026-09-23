/* ============================================================================
 * 前端实跑检查：真的把每个节点的 setup() 执行一遍。
 *
 * 为什么需要它：
 *   node --check 只验语法。引用了一个不存在的变量（比如某个局部量在作用域外
 *   被使用）语法完全合法，但一按鼠标就 ReferenceError。这类问题
 *   smoke_import.py 也抓不到 —— 那是静态断言，不会真的执行前端代码。
 *
 *   实际踩过：multi_character.js 的 pointerdown 里引用了不存在的 view / local，
 *   表现是「画布拖不动」，而所有静态检查一路绿灯。
 *
 * 做法：造一套最小 DOM stub，注入假的 M8 与 app，然后：
 *   1. 加载前端模块（抓顶层构建期错误）
 *   2. 拿到它注册的 extension
 *   3. 造一个假节点，触发 beforeRegisterNodeDef → onNodeCreated → setup
 *   4. 检查执行期间有没有被 catch 住的内部错误
 *
 * 用法：node tests/frontend_setup.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------- DOM stub */

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
    textContent: '', value: '', checked: false, type: '',
    min: '', max: '', step: '', placeholder: '', title: '',
    disabled: false, readOnly: false, tabIndex: 0, selectedIndex: 0,
    clientWidth: 420, clientHeight: 260, offsetWidth: 420, offsetHeight: 260,
    scrollHeight: 900, scrollTop: 0, width: 800, height: 600, innerHTML: '',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    remove: noop, addEventListener: noop, removeEventListener: noop, focus: noop, click: noop, select: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] || null; },
    hasAttribute(k) { return k in this.attributes; },
    querySelector: () => makeEl('div'),
    querySelectorAll: () => [],
    contains: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 260, right: 420, bottom: 260 }),
    getContext() {
      const ctx = { canvas: el, measureText: () => ({ width: 40 }) };
      ctx.createLinearGradient = () => ({ addColorStop: noop });
      ctx.createRadialGradient = () => ({ addColorStop: noop });
      return new Proxy(ctx, { get: (t, k) => (k in t ? t[k] : noop), set: () => true });
    },
    get firstChild() { return this.children[0] || makeEl('div'); },
  };
  return el;
}

function installGlobals() {
  globalThis.document = {
    createElement: (t) => makeEl(t),
    createTextNode: (t) => ({ textContent: t }),
    body: makeEl('body'), head: makeEl('head'),
    getElementById: () => null,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null,
  };
  globalThis.window = {
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
    addEventListener: noop, removeEventListener: noop,
    confirm: () => false, prompt: () => null,
    LiteGraph: undefined,
  };
  globalThis.requestAnimationFrame = (fn) => { fn(0); return 1; };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.Option = function (text, value) { const o = makeEl('option'); o.textContent = text; o.value = value; return o; };
  /* ComfyUI 注入的全局：前端用它造多行输入框 */
  /* 注意形状：真实实现返回的是**包着 widget 的对象**，调用处写的是
     ComfyWidgets["STRING"](...).widget。直接返回 widget 本身的话，
     调用处会拿到 undefined.widget，报错信息看着像是节点的问题，其实是桩不对。 */
  const mkWidget = (name, value, type) => ({ widget: { name, value, options: {}, type, inputEl: null } });
  globalThis.ComfyWidgets = {
    STRING: (node, name) => mkWidget(name, '', 'string'),
    INT: (node, name) => mkWidget(name, 0, 'number'),
    FLOAT: (node, name) => mkWidget(name, 0, 'number'),
    BOOLEAN: (node, name) => mkWidget(name, false, 'toggle'),
  };
  globalThis.LiteGraph = undefined;
  globalThis.navigator = { clipboard: { writeText: async () => {}, readText: async () => '' } };
}

/* ---------------------------------------------------------------- 假 M8 */

function stubM8(log) {
  return {
    COLOR: { primary: '#1', primaryDim: '#2', accent: '#3', ok: '#4', warn: '#5', err: '#6', text: '#7', dim: '#8' },
    log: (...a) => log.push(['log', ...a]),
    warn: (...a) => log.push(['warn', ...a]),
    error: (...a) => log.push(['error', ...a]),
    /* 桩要覆盖 m8_core.js 的**全部**导出。少一个，节点那边就会在初始化时抛
       "xxx is not a function"，而那是桩的问题、不是节点的问题 ——
       报出来会误导。导出清单见 m8_core.js 末尾的 export。 */
    notify: noop, notifyError: noop,
    apiGet: async () => ({ files: [], skills: [] }),
    apiPost: async () => ({}),
    apiUpload: async () => ({ files: [] }),
    attachMention: noop, attachMentionAutocomplete: noop,
    injectTheme: noop, escapeHtml: (s) => String(s),
    /* i18n：桩里一律走英文原文（第三个参数），这样断言的还是代码里写的那份 */
    isChinese: () => false, loadUiStrings: async () => ({}),
    t: (key, fallback) => fallback, tFor: () => (key, fallback) => fallback,
    brand: noop, setStatus: noop, addButton: noop,
    setComboOptions: noop, relayout: noop,
    findWidget: (node, name) => (node._widgets || {})[name] || null,
    onWidgetChange: noop, hideWidget: (w) => { if (w) w.hidden = true; }, showWidget: noop,
  };
}

/* 每个节点要喂的假 widget（名字必须和后端 INPUT_TYPES 一致，否则 setup 会早退） */
const NODES = [
  { file: 'js/nodes/prompt/multi_character.js', type: 'M8MultiCharacter', widgets: ['format', 'use_fill', 'config', 'base_prompt', 'width', 'height'] },
  { file: 'js/nodes/cam/camera_control.js', type: 'M8CameraControl', widgets: ['pos_x', 'pos_y', 'pos_z', 'roll', 'config'] },
  { file: 'js/nodes/llm/llm_inference.js', type: 'M8LLMInference', widgets: ['user_prompt', 'system_prompt', 'temperature', 'max_tokens', 'api_key', 'model'] },
  { file: 'js/nodes/llm/skill_loader.js', type: 'M8SkillLoader', widgets: ['skill'] },
  { file: 'js/nodes/llm/llm_local.js', type: 'M8LLMLocal', widgets: ['model', 'system_prompt', 'user_prompt', 'extra_text'] },
];

async function checkOne(entry) {
  const log = [];
  const M8 = stubM8(log);
  let captured = null;
  const app = { registerExtension: (ext) => { captured = ext; }, graph: { setDirtyCanvas: noop } };

  const abs = path.resolve(__dirname, '..', entry.file);
  if (!fs.existsSync(abs)) return { ok: false, why: '文件不存在' };

  let src = fs.readFileSync(abs, 'utf8').replace(/^import .*$/gm, '');

  // 1. 加载模块（顶层有 import.meta 之类的话会在这里炸）
  try {
    new Function('M8', 'app', src)(M8, app);
  } catch (e) {
    return { ok: false, why: '模块加载抛错：' + e.message };
  }
  if (!captured) return { ok: false, why: '没有调用 registerExtension' };

  // 2. 触发节点创建
  const widgetMap = {};
  for (const name of entry.widgets) {
    widgetMap[name] = { name, value: name === 'format' ? 'attn' : (name === 'config' ? '{}' : ''), options: {} };
  }
  if (widgetMap.width) widgetMap.width.value = 1024;
  if (widgetMap.height) widgetMap.height.value = 1024;
  if (widgetMap.temperature) widgetMap.temperature.value = 1;

  const nodeType = { prototype: {} };
  try {
    await captured.beforeRegisterNodeDef(nodeType, { name: entry.type });
    const node = {
      widgets: Object.values(widgetMap), _widgets: widgetMap,
      size: [780, 600], properties: {},
      computeSize: () => [780, 900],
      setSize(s) { this.size = s; },
      addDOMWidget: () => ({ computeSize: () => [0, 0] }),
      /* 节点自己往身上加控件时用的。返回控件对象 —— 调用方会接着设
         serialize = false 之类，所以不能返回 undefined。 */
      addWidget(type, name, value, cb) {
        const w = { type, name, value, callback: cb, options: {} };
        this.widgets.push(w);
        this._widgets[name] = w;
        return w;
      },
      configure: noop, onRemoved: null,
    };
    nodeType.prototype.onNodeCreated.call(node);
  } catch (e) {
    return { ok: false, why: '节点创建抛错：' + e.message };
  }

  // 3. 面板自己 catch 住的错误也要报出来 —— 那些在浏览器里同样是红的
  const errs = log.filter((l) => l[0] === 'error');
  if (errs.length) {
    return { ok: false, why: '内部捕获：' + errs.map((e) => String(e[1]) + ' ' + (e[2] && e[2].message ? e[2].message : '')).join(' | ') };
  }
  return { ok: true, why: '' };
}

(async () => {
  let bad = 0;
  for (const entry of NODES) {
    installGlobals();
    const r = await checkOne(entry);
    const name = entry.file.split('/').pop();
    if (r.ok) {
      console.log('  OK    ' + name);
    } else {
      bad++;
      console.log('  FAIL  ' + name + ' → ' + r.why);
    }
  }
  console.log('');
  console.log(bad ? ('前端实跑检查：' + bad + ' 个失败') : '前端实跑检查：' + NODES.length + ' 个全部通过');
  process.exitCode = bad ? 1 : 0;
})();
