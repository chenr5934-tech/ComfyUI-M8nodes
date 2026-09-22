/* ============================================================================
 * 语法检查：所有前端 js 按 ES module 解析一遍。
 *
 * 为什么要单开一个：
 *   frontend_*.js 那些套件是「加载并执行」，但只有被测到的模块才会被加载。
 *   M8web 的页面脚本、界面扩展这几类平时没人碰 —— 语法错了在浏览器里
 *   就是白屏加控制台一行红字，而 node --check 也拦不住（它按 CommonJS 解析，
 *   见到 import 直接报错，只能说明「有 import」，说明不了文件本身有没有问题）。
 *
 * 做法：vm.SourceTextModule 只解析、不执行。不需要 DOM 桩，也不会因为
 * import 链没配齐而误报 —— 查的就是「这个文件是不是合法的 ESM」。
 *
 * 需要 --experimental-vm-modules，但不用你记：没带标志的话脚本自己补上重跑。
 *
 * 用法：node tests/syntax_check.js
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* 没开标志就自己带标志重跑一遍。宁可多 fork 一次，也不要「静默少查一项」。 */
if (typeof vm.SourceTextModule !== 'function') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(
    process.execPath,
    ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(r.status === null ? 1 : r.status);
}

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['js', 'M8web/assets/js'];

function collect(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) out.push(...collect(rel));
    else if (e.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const files = DIRS.flatMap(collect).sort();
if (!files.length) {
  console.log('一个 js 都没找到 —— 目录约定变了，这条检查已经失效了');
  process.exitCode = 1;
  return;
}

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (e) {
    bad++;
    console.log('  FAIL  ' + f + ' -> ' + e.message);
  }
}

console.log('');
console.log(bad
  ? ('语法检查：' + bad + ' / ' + files.length + ' 个文件有语法错')
  : ('语法检查：' + files.length + ' 个前端 js 全部是合法 ESM'));
process.exitCode = bad ? 1 : 0;
