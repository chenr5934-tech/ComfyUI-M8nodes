/* ============================================================================
 * 前端地基实跑检查：真的把 m8_core.js 跑起来，验证几个"逻辑对、行为错"的点。
 *
 * 为什么单独一份：
 *   frontend_setup.js 把 M8 整个换成桩 —— 它验的是"节点初始化不炸"。
 *   而颜色被覆盖、尺寸被压回去这类问题，恰恰发生在 m8_core 自己的实现里，
 *   桩越完整越测不出来。所以这里不注入桩，直接把 m8_core.js 的源码当函数体
 *   执行，拿到真的 brand / setStatus / syncImageInputs。
 *
 * 实际踩过的两条，都是所有者实机发现的：
 *   1. 右键换过的节点颜色，切一次工作流页就变回去 —— setStatus 无条件写 node.color。
 *   2. 手动拉大的节点，接一根线就缩回最小尺寸 —— syncImageInputs 里
 *      setSize(computeSize())，而 computeSize() 是"至少多大"，不是"应该多大"。
 *
 * 用法：node tests/frontend_core.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const noop = () => {};

/* ---------------------------------------------------------------- 环境桩 */

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {}, children: [],
    appendChild(c) { this.children.push(c); return c; },
    remove: noop, setAttribute: noop, addEventListener: noop,
  };
  return el;
}

function loadCore() {
  globalThis.document = { head: makeEl('head'), body: makeEl('body'), createElement: makeEl };
  globalThis.window = { LiteGraph: undefined };
  globalThis.navigator = { language: 'en' };

  const file = path.resolve(__dirname, '..', 'js', 'm8_core.js');
  let src = fs.readFileSync(file, 'utf8');

  // 三条 import 拿不到真东西；export 全部剥掉，靠 return 把要测的取出来
  src = src
    .replace(/^import .*$/gm, '')
    .replace(/\bexport\s+/g, '')
    // import.meta 只在 module 里合法，new Function 里是语法错误 —— 喂个假 URL
    .split('import.meta.url')
    .join('"file:///stub/m8_core.js"');

  const factory = new Function('app', 'api', src + `
    return { brand, setStatus, syncImageInputs, labelWidgets, findWidget, COLOR };
  `);

  const app = {
    graph: { setDirtyCanvas: noop },
    extensionManager: null,
    registerExtension: noop,
  };
  const api = { fetchApi: async () => ({ ok: true, text: async () => '{}' }) };
  return factory(app, api);
}

/* ---------------------------------------------------------------- 假节点 */

function makeNode({ size = [320, 200], inputs = [], widgets = [] } = {}) {
  return {
    id: 1,
    size: [...size],
    inputs: inputs.map((name) => ({ name, type: 'IMAGE', link: null })),
    widgets,
    flags: {},
    setSize(next) { this.size = [...next]; },
    computeSize() {
      // 造一个"至少这么大"的下限：随口数增长，和真 LiteGraph 的方向一致
      const height = 80 + this.inputs.length * 22 + this.widgets.length * 24;
      return [220, height];
    },
    addInput(name, type) { this.inputs.push({ name, type, link: null }); },
    removeInput(index) { this.inputs.splice(index, 1); },
  };
}

const SLOTS = ['image', ...Array.from({ length: 7 }, (_, i) => `image_${i + 2}`)];

/* ---------------------------------------------------------------- 断言 */

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('  OK    ' + name);
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? ' → ' + detail : ''));
  }
}

/* ---------------------------------------------------------------- 跑 */

console.log('前端地基实跑检查（js/m8_core.js）');
console.log('');

const M8 = loadCore();
const { brand, setStatus, syncImageInputs, labelWidgets, COLOR } = M8;

/* ---- 1. 颜色主权 ---- */
{
  const node = makeNode();
  brand(node);
  check('新建节点套上品牌色', node.color === COLOR.primary, String(node.color));

  setStatus(node, 'ok');
  check('状态色照常变（没人改过色时）', node.color === COLOR.ok, String(node.color));

  // 模拟用户右键 Colors 换成一个自己的颜色
  node.color = '#ff0000';
  setStatus(node, 'err');
  check('用户改过色后，状态色不再抢', node.color === '#ff0000', String(node.color));

  setStatus(node, 'idle');
  setStatus(node, 'busy');
  check('连续几次状态变化都不抢', node.color === '#ff0000', String(node.color));
}

/* ---- 2. 加载工作流：configure 写在 onNodeCreated 之后 ---- */
{
  const node = makeNode();
  brand(node);                       // onNodeCreated 那一轮
  setStatus(node, 'idle');
  node.color = '#3366cc';            // 工作流 configure 把存着的颜色写回来
  setStatus(node, 'ok');             // 之后异步回调才到
  check('工作流里存的颜色不被异步状态冲掉', node.color === '#3366cc', String(node.color));
}

/* ---- 3. 尺寸只增不减 ---- */
{
  const node = makeNode({ size: [520, 900] });
  syncImageInputs(node, SLOTS);
  check('手动拉大的尺寸不被连线压回去', node.size[0] === 520 && node.size[1] === 900,
    JSON.stringify(node.size));
}
{
  const node = makeNode({ size: [100, 100] });
  syncImageInputs(node, SLOTS);
  check('太小的尺寸会被撑到最小值', node.size[0] >= 220 && node.size[1] >= 100,
    JSON.stringify(node.size));
}

/* ---- 4. 图片口一个接一个长 ---- */
{
  const node = makeNode();
  syncImageInputs(node, SLOTS);
  const names = node.inputs.map((i) => i.name);
  check('默认只露一个口', names.length === 1 && names[0] === 'image', JSON.stringify(names));

  node.inputs[0].link = 42;          // 接上第一根线
  syncImageInputs(node, SLOTS);
  check('接满一个才长出下一个', node.inputs.map((i) => i.name).join(',') === 'image,image_2',
    JSON.stringify(node.inputs.map((i) => i.name)));

  node.inputs[1].link = 43;
  syncImageInputs(node, SLOTS);
  check('再满一个再长一个', node.inputs.map((i) => i.name).join(',') === 'image,image_2,image_3',
    JSON.stringify(node.inputs.map((i) => i.name)));

  node.inputs[1].link = null;        // 拔掉第二根
  syncImageInputs(node, SLOTS);
  check('拔掉后收回到对应的位置', node.inputs.map((i) => i.name).join(',') === 'image,image_2',
    JSON.stringify(node.inputs.map((i) => i.name)));
}

/* ---- 5. 接了线的口绝不被摘 ---- */
{
  const node = makeNode();
  syncImageInputs(node, SLOTS);
  node.inputs[0].link = 7;
  syncImageInputs(node, SLOTS);
  const connected = node.inputs.filter((i) => i.link != null).map((i) => i.name);
  check('已连线的口一个不少', connected.join(',') === 'image', JSON.stringify(connected));
}

/* ---- 6. 中文标签只改显示名 ---- */
{
  const widgets = [
    { name: 'folder', value: '' },
    { name: 'picked', value: '' },
    { name: 'index', value: 0 },
  ];
  const node = makeNode({ widgets });
  labelWidgets(node, { folder: '文件夹路径（按顺序读）', index: '从第几张开始（序号）' });
  check('label 挂上了', widgets[0].label === '文件夹路径（按顺序读）', String(widgets[0].label));
  check('内部名一个字不动', widgets[0].name === 'folder', String(widgets[0].name));
  check('没配的控件不受影响', widgets[1].label === undefined, String(widgets[1].label));
  check('不存在的控件静默跳过', widgets[2].label === '从第几张开始（序号）', String(widgets[2].label));
}

console.log('');
if (failures.length) {
  console.log('前端地基实跑检查：' + failures.length + ' 个失败');
  for (const f of failures) console.log('  - ' + f);
} else {
  console.log('前端地基实跑检查：' + passed + ' 个全部通过');
}
process.exitCode = failures.length ? 1 : 0;
