/* ============================================================================
 * M8web · 备份（导出 / 导入）的实跑检查
 *
 * 这一层的活儿是「把数据安全地搬出去、再安全地搬回来」，所以重点在两处：
 *   1. 读回来的东西一律当不可信数据 —— 用户会选错文件，也可能手改过
 *   2. 合并时宁可重复也不许丢东西（这条比「去重干净」重要得多）
 *
 * 用法：node tests/frontend_backup.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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

const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/backup.js'), 'utf8');
const m = new Function(src + '\n;return M8Backup;')();

/* ---------------------------------------------------------------- 信封 */

step('导出再读回来，内容一字不差', () => {
  const rows = [{ id: 1, name: '甲', text: 'aaa' }, { id: 2, name: '乙', text: '' }];
  const back = m.parse(m.envelope('oc', rows));
  if (back.app !== 'm8web') throw new Error('app 不对：' + back.app);
  if (back.kind !== 'oc') throw new Error('kind 不对：' + back.kind);
  if (back.v !== 1) throw new Error('版本不对：' + back.v);
  if (back.count !== 2) throw new Error('计数不对：' + back.count);
  if (back.data.length !== 2) throw new Error('数据条数不对');
  if (back.data[1].name !== '乙') throw new Error('内容串了');
  if (typeof back.at !== 'string' || back.at.length < 10) throw new Error('没记导出时间');
});

step('带中文、换行和图片 dataURL 也往返得回来', () => {
  const rows = [{
    id: 7,
    name: '仰拍构图 · 逆光',
    text: 'from below,\nlow angle',
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==',
  }];
  const back = m.parse(m.envelope('prompts', rows));
  const r = back.data[0];
  if (r.name !== '仰拍构图 · 逆光') throw new Error('中文串了');
  if (r.text.indexOf('\n') < 0) throw new Error('换行丢了');
  if (r.image.indexOf('data:image/png') !== 0) throw new Error('图片字段丢了');
});

step('空数据也能导，不炸', () => {
  const back = m.parse(m.envelope('stickers', []));
  if (back.count !== 0 || back.data.length !== 0) throw new Error('空数据不对');
});

/* ---------------------------------------------------------------- 校验 */

step('读回来：坏文件都明确报错，不说「出错了」这种废话', () => {
  const cases = [
    ['这不是 json', 'JSON'],
    [JSON.stringify({ hello: 1 }), 'M8'],
    [JSON.stringify({ app: 'm8web', kind: 'oc', data: [] }), 'version number'],
    [JSON.stringify({ app: 'm8web', kind: 'oc', v: 99, data: [] }), 'newer version'],
    [JSON.stringify({ app: 'm8web', kind: '没有这个类型', v: 1, data: [] }), 'kind'],
    [JSON.stringify({ app: 'm8web', kind: 'oc', v: 1, data: '不是数组' }), 'no data'],
    [JSON.stringify({ app: 'm8web', kind: 'oc', v: 1 }), 'no data'],
    ['', 'JSON'],
    /* 注意 JSON.parse(null) 不是抛错 —— 它等于 JSON.parse("null")，返回 null，
       所以走的是「不是 M8 文件」那条分支。第一版这里期望写成了 JSON，红了一条。 */
    [null, 'M8'],
  ];
  for (const pair of cases) {
    let msg = '';
    try { m.parse(pair[0]); } catch (e) { msg = e.message; }
    if (!msg) throw new Error('这段该报错却没报：' + String(pair[0]).slice(0, 40));
    if (msg.indexOf(pair[1]) < 0) {
      throw new Error('报错该提到「' + pair[1] + '」，实际：' + msg);
    }
  }
});

/* ---------------------------------------------------------------- 合并 */

step('合并：同名的跳过，其余当新记录，而且不带 id', () => {
  const existing = [{ id: 1, name: '仰拍' }, { id: 2, name: '俯拍' }];
  const incoming = [{ id: 1, name: '仰拍' }, { id: 1, name: '侧光' }, { id: 9, name: '逆光' }];
  const r = m.mergeRows(existing, incoming, (x) => x.name);
  if (r.fresh.length !== 2) throw new Error('该新增 2 条，实际 ' + r.fresh.length);
  if (r.skipped.length !== 1) throw new Error('该跳过 1 条，实际 ' + r.skipped.length);
  /* 这一条是本文件里最值钱的：第二条的 id 和第一条撞了，但名字不同，
     所以它必须被当成新记录。要是按 id 去重，用户真正想要的那条就被跳掉了。 */
  if (r.fresh[0].name !== '侧光') throw new Error('按 id 去重了 —— 撞 id 但名字不同的那条被跳掉了');
  if ('id' in r.fresh[0] || 'id' in r.fresh[1]) {
    throw new Error('新记录还带着 id，灌回库时会跟现有记录撞');
  }
});

step('合并：同一批里重复的也去掉', () => {
  const r = m.mergeRows([], [{ name: '甲' }, { name: '甲' }, { name: '乙' }], (x) => x.name);
  if (r.fresh.length !== 2) throw new Error('批内没去重，实际 ' + r.fresh.length);
  if (r.skipped.length !== 1) throw new Error('批内跳过数不对');
});

step('合并：没有可去重的字段时一律当新记录 —— 宁可重复也不许丢', () => {
  const r = m.mergeRows([{ name: '' }], [{ name: '' }, { name: '' }], (x) => x.name);
  if (r.fresh.length !== 2) throw new Error('空 key 时不该去重，实际留下 ' + r.fresh.length);
  if (r.skipped.length !== 0) throw new Error('空 key 时不该跳过任何一条');
});

step('合并：原来的记录一个都不动', () => {
  const existing = [{ id: 1, name: '甲' }];
  const snapshot = JSON.stringify(existing);
  m.mergeRows(existing, [{ name: '乙' }], (x) => x.name);
  if (JSON.stringify(existing) !== snapshot) throw new Error('把现有记录改了');
});

step('合并：进来的是空数组时什么都不发生', () => {
  const r = m.mergeRows([{ id: 1 }], [], (x) => x.id);
  if (r.fresh.length || r.skipped.length) throw new Error('空输入该什么都不做');
});

step('合并：不深拷也没关系 —— 但顶层字段不能共用引用', () => {
  const incoming = [{ name: '甲', nested: { a: 1 } }];
  const r = m.mergeRows([], incoming, (x) => x.name);
  r.fresh[0].name = '改了';
  if (incoming[0].name !== '甲') throw new Error('改动漏回源对象了');
});

/* ---------------------------------------------------------------- 分类跟着搬 */

step('分类计划：同名的复用现有的，其余记下来等着建', () => {
  const backup = [{ id: 1, name: '构图' }, { id: 2, name: '光影' }, { id: 3, name: '画风' }];
  const existing = [{ id: 10, name: '光影' }, { id: 11, name: '构图' }];
  const p = m.planGroups(backup, existing);
  if (p.map[1] !== 11) throw new Error('「构图」该复用现有 id 11，实际 ' + p.map[1]);
  if (p.map[2] !== 10) throw new Error('「光影」该复用现有 id 10，实际 ' + p.map[2]);
  if (p.map[3] !== undefined) throw new Error('「画风」是新的，不该在映射里');
  if (p.toCreate.length !== 1 || p.toCreate[0].name !== '画风') {
    throw new Error('该只新建「画风」，实际 ' + JSON.stringify(p.toCreate));
  }
  if (p.toCreate[0].oldId !== 3) throw new Error('新建的那条没记住旧 id，后面映射不回去');
});

step('分类计划：备份里没名字的分类也得有个落脚处', () => {
  const p = m.planGroups([{ id: 5, name: '' }], []);
  if (p.toCreate.length !== 1) throw new Error('没名字的分类也该建出来');
  if (!p.toCreate[0].name) throw new Error('该给个默认名字');
});

step('分类计划：备份里没有分类时不炸', () => {
  const p = m.planGroups(null, null);
  if (p.toCreate.length || Object.keys(p.map).length) throw new Error('空输入该什么都不做');
});

step('重映射：分类跟着过来了就换上新 id', () => {
  const cards = [{ id: 1, name: '甲', groupId: 1 }, { id: 2, name: '乙', groupId: 2 }];
  const out = m.remapCards(cards, { 1: 11, 2: 10 });
  if (out[0].groupId !== 11) throw new Error('第一条没换');
  if (out[1].groupId !== 10) throw new Error('第二条没换');
  if ('id' in out[0]) throw new Error('卡片还带着旧 id');
});

step('重映射：映射不到的当未分类，绝不让它指着不存在的分类', () => {
  const cards = [{ groupId: 99 }, { groupId: 0 }, {}, { groupId: null }];
  const out = m.remapCards(cards, { 1: 11 });
  out.forEach((c, i) => {
    if (c.groupId !== 0) throw new Error('第 ' + i + ' 条该变成未分类，实际 ' + c.groupId);
  });
  if (out.length !== 4) throw new Error('条数变了');
});

step('重映射：原来的卡片数组一个都不动', () => {
  const cards = [{ id: 1, groupId: 5 }];
  const snap = JSON.stringify(cards);
  m.remapCards(cards, { 5: 50 });
  if (JSON.stringify(cards) !== snap) throw new Error('把入参改了');
});

step('信封能带上额外的东西（分类），读回来也在', () => {
  const text = m.envelope('prompts', [{ name: '卡' }], { groups: [{ id: 1, name: '构图' }] });
  const back = m.parse(text);
  if (!back.extra || !back.extra.groups) throw new Error('extra 没带过去');
  if (back.extra.groups[0].name !== '构图') throw new Error('extra 内容串了');
  /* 不带 extra 的时候不该凭空多出一个字段 */
  const plain = m.parse(m.envelope('oc', []));
  if ('extra' in plain) throw new Error('没传 extra 却多出来一个字段');
});

/* ---------------------------------------------------------------- 小工具 */

step('文件名带时间戳，导两次不会互相覆盖', () => {
  const a = m.fileNameFor('oc', new Date(2026, 8, 21, 20, 30));
  if (a !== 'm8-oc-20260921-2030.json') throw new Error('文件名不对：' + a);
  const b = m.fileNameFor('prompts', new Date(2026, 0, 5, 9, 7));
  if (b !== 'm8-prompts-20260105-0907.json') throw new Error('补零不对：' + b);
  const c = m.fileNameFor('stickers', new Date(2026, 11, 31, 0, 0));
  if (c !== 'm8-stickers-20261231-0000.json') throw new Error('月底跨年不对：' + c);
  const d = m.fileNameFor('没有这种', new Date(2026, 0, 1, 0, 0));
  if (d.indexOf('m8-backup') !== 0) throw new Error('不认识的类型该给个兜底名：' + d);
});

step('三类数据的名字都在', () => {
  for (const k of ['oc', 'prompts', 'stickers']) {
    if (!m.KINDS[k]) throw new Error('少了 ' + k);
    if (!m.KINDS[k].title) throw new Error(k + ' 没有中文名');
    if (!m.KINDS[k].file) throw new Error(k + ' 没有文件名前缀');
  }
});

step('fmtSize 好读', () => {
  if (m.fmtSize(0) !== '0 B') throw new Error('0 不对：' + m.fmtSize(0));
  if (m.fmtSize(500) !== '500 B') throw new Error('小数字不对：' + m.fmtSize(500));
  if (m.fmtSize(2048) !== '2.0 KB') throw new Error('KB 不对：' + m.fmtSize(2048));
  if (m.fmtSize(5 * 1024 * 1024) !== '5.0 MB') throw new Error('MB 不对：' + m.fmtSize(5 * 1024 * 1024));
});

step('浏览器不提供持久化接口时安静地返回 null，不炸', () => {
  /* Node 里本来就没有 navigator.storage，正好是这个分支 */
  return m.requestPersist().then((r) => {
    if (r !== null) throw new Error('不支持时该返回 null，实际 ' + JSON.stringify(r));
    return m.usage();
  }).then((u) => {
    if (u !== null) throw new Error('不支持时该返回 null');
  });
});

console.log('');
if (fails.length) {
  console.log('备份实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('备份实跑检查：全部通过');
}
