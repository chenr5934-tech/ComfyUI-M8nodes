/* ============================================================================
 * 主模型 ↔ mmproj 自动配对：前端这一半的检查。
 *
 * 规则在两处各写了一遍 —— 后端 m8/nodes/llm/llm_local/models.py 的 _pick_from，
 * 前端 js/nodes/llm/llm_local.js 的 autoPickMmproj。分散本身就是风险，所以
 * 用例放在 tests/mmproj_cases.json，Python 侧和这里各跑同一份，谁走偏谁红。
 *
 * 实际踩过：9b 被词长下限（>=3）滤掉，两个候选同分，qwen3.5-9b 的主模型
 * 配到了 qwen3.5-4B 的 mmproj 上。不识图、不报错，只是结果不对。
 *
 * 用法：node tests/frontend_mmproj.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const noop = () => {};
const CASES = JSON.parse(fs.readFileSync(path.join(__dirname, 'mmproj_cases.json'), 'utf8'));
const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'nodes', 'llm', 'llm_local.js'), 'utf8');

/* autoPickMmproj 没导出，靠末尾补一句 return 把它捞出来。
   import 行要剥掉 —— new Function 里不能有 import。 */
function loadApi() {
  const M8 = {
    COLOR: {}, log: noop, warn: noop, error: noop, notify: noop, notifyError: noop,
    apiGet: async () => ({ models: [], mmproj: [] }),
    apiPost: async () => ({}), apiUpload: async () => ({ files: [] }),
    attachMention: noop, attachMentionAutocomplete: noop,
    injectTheme: noop, escapeHtml: (s) => String(s),
    brand: noop, setStatus: noop, addButton: noop,
    setComboOptions: noop, relayout: noop, findWidget: () => null,
    onWidgetChange: noop, hideWidget: noop, showWidget: noop,
  };
  const app = { registerExtension: noop, graph: { setDirtyCanvas: noop } };
  const body = SRC.replace(/^import .*$/gm, '');
  // NO_MMPROJ 也一起带出来：它是模块里的常量，测试不该再抄一份字面量 ——
  // 抄一份的话界面文案一改这里就红，而它想验的其实是配对规则。
  return new Function('M8', 'app', body + '\nreturn { autoPickMmproj, dirOf, baseOf, NO_MMPROJ };')(M8, app);
}

/* 前端把「配不上」表示成下拉里的一个占位项，后端表示成 None —— 断言时对齐。
   值从模块里取，不在这里抄一份。 */

let api;
try {
  api = loadApi();
} catch (e) {
  console.log('  FAIL  模块加载抛错：' + e.message);
  process.exitCode = 1;
  return;
}

const NO_MMPROJ = api.NO_MMPROJ;
const num = (n) => String(n).padStart(2, ' ');
let bad = 0;
CASES.cases.forEach((c, i) => {
  const cands = c.cands || CASES.cands;
  const got = api.autoPickMmproj(c.model, cands);
  const want = c.expect === null ? NO_MMPROJ : c.expect;
  const ok = got === want;
  if (ok) {
    console.log('  OK    ' + num(i + 1) + '  ' + c.name);
  } else {
    bad++;
    console.log('  FAIL  ' + num(i + 1) + '  ' + c.name);
    console.log('          期望 ' + want);
    console.log('          实得 ' + got);
  }
});

console.log('');
console.log(bad
  ? ('mmproj 配对（前端）：' + bad + ' / ' + CASES.cases.length + ' 个失败')
  : ('mmproj 配对（前端）：' + CASES.cases.length + ' 个全部通过，与 tests/mmproj_cases.json 一致'));
process.exitCode = bad ? 1 : 0;
