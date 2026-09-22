/* ============================================================================
 * M8web · 旧数据搬运的实跑检查
 *
 * 这里没有 indexedDB（Node 环境和老浏览器都是这样），所以能测的是「退化得对不对」：
 * 查不了就说查不了，别去打扰用户，也别假装搬成功了。
 *
 * 真搬一次的效果在浏览器里验过（造旧库 → scan → run → dropOld → 服务器读到）。
 *
 * 用法：node tests/frontend_migrate.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const fails = [];
function step(name, fn) {
  try { fn(); console.log('  OK    ' + name); }
  catch (e) { fails.push(name + ' -> ' + e.message); console.log('  FAIL  ' + name + ' -> ' + e.message); }
}
/* 只排队，不执行 —— 创建时就跑的话几条会同时开工，互相盖状态 */
const steps = [];
function astep(name, fn) { steps.push([name, fn]); }

const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/migrate.js'), 'utf8');
const m = new Function(src + '\n;return M8Migrate;')();

step('四类旧数据都登记了', () => {
  const kinds = m.OLD.map((o) => o.kind).sort();
  const want = ['groups', 'oc', 'prompts', 'stickers'];
  if (kinds.join(',') !== want.join(',')) throw new Error('实际 ' + kinds.join(','));
  m.OLD.forEach((o) => {
    if (!o.db || !o.store || !o.label) throw new Error(o.kind + ' 缺字段');
  });
});

const noStore = typeof indexedDB === 'undefined';


  astep('没有 indexedDB 时 scan 返回 null（表示「不知道」，不是「没有」）', () => {
    if (!noStore) return;
    return m.scan().then((r) => {
      scanResult = r;
      if (r !== null) throw new Error('该返回 null，实际 ' + JSON.stringify(r));
    });
  }),
  astep('没有 indexedDB 时 dropOld 安静地什么都不做', () => {
    if (!noStore) return;
    return m.dropOld();
  }),
  astep('搬空的进去也是 0 条，不炸', () => {
    return m.run([]).then((n) => {
      if (n !== 0) throw new Error('空列表该是 0，实际 ' + n);
    });
  }),
  astep('run 会逐类调 replace，条数加起来对', () => {
    const calls = [];
    globalThis.M8Api = {
      replace: (kind, rows) => { calls.push(kind + ':' + rows.length); return Promise.resolve(rows.length); },
    };
    return m.run([
      { kind: 'oc', rows: [{}, {}] },
      { kind: 'prompts', rows: [{}] },
    ]).then((n) => {
      if (n !== 3) throw new Error('该搬 3 条，实际 ' + n);
      if (calls.join(' ') !== 'oc:2 prompts:1') throw new Error('调用顺序不对：' + calls.join(' '));
      delete globalThis.M8Api;
    });
  }),
  astep('中途失败会把错抛出来，不假装搬完了', () => {
    globalThis.M8Api = {
      replace: () => Promise.reject(new Error('服务没在跑')),
    };
    return m.run([{ kind: 'oc', rows: [{}] }]).then(
      () => { delete globalThis.M8Api; throw new Error('该抛错却没抛'); },
      (e) => {
        delete globalThis.M8Api;
        if (String(e.message).indexOf('服务没在跑') < 0) throw new Error('错传丢了：' + e.message);
      },
    );
  });

/* 顺序跑，一条一条来。这几条会改 globalThis.M8Api，并发起来会互相盖。 */
(async () => {
  for (const pair of steps) {
    try {
      await pair[1]();
      console.log('  OK    ' + pair[0]);
    } catch (e) {
      fails.push(pair[0] + ' -> ' + e.message);
      console.log('  FAIL  ' + pair[0] + ' -> ' + e.message);
    }
  }
})().then(() => {
  console.log('');
  if (fails.length) {
    console.log('旧数据搬运实跑检查：' + fails.length + ' 个失败');
    fails.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log('旧数据搬运实跑检查：全部通过');
  }
});
