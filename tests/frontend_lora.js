/* ============================================================================
 * M8web · LoRA 解析的实跑检查
 *
 * 解析全是纯函数，所以这里**自己拼 safetensors 的 header** 来验，不用真模型文件。
 *
 * 两条主线：
 *   1. 小端 u64 的长度字段读得对、坏数据不硬解
 *   2. kohya 的 ss_ 参数、modelspec 命名空间、以及没见过的键都不能丢
 *
 * 另外「只读头部」这件事是行为约定，不靠测试保证 —— 它在 analyze() 里靠
 * file.slice(0, 8) 和 file.slice(8, 8+len) 两次切片实现，注释里写明了。
 *
 * 用法：node tests/frontend_lora.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const noop = () => {};

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: new Proxy({}, { get: () => '', set: () => true }),
    dataset: {}, children: [], attributes: {}, classSet: new Set(),
    textContent: '', value: '', type: '', id: '', className: '', files: null,
    addEventListener: noop, click: noop, select: noop,
    appendChild(c) { if (c && c.__fragment) { c.children.forEach((x) => this.children.push(x)); return c; } this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    querySelector: () => makeEl('h2'),
    querySelectorAll: () => [],
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
  Object.defineProperty(el, 'innerHTML', { get() { return html; }, set(v) { html = v; if (!v) el.children.length = 0; } });
  return el;
}

const byId = {};
function reg(id) { const e = makeEl('div'); e.id = id; byId[id] = e; return e; }

function boot() {
  for (const k of Object.keys(byId)) delete byId[k];
  globalThis.document = {
    createElement: (t) => makeEl(t),
    createDocumentFragment: () => { const f = makeEl('fragment'); f.__fragment = true; return f; },
    getElementById: (id) => byId[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    body: makeEl('body'),
    execCommand: () => true,
    addEventListener: noop,
  };
  for (const id of ['loraDrop', 'loraFile', 'loraHint', 'loraBody', 'loraPanels', 'loraAgain', 'loraStatus']) reg(id);
  globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/lora.js'), 'utf8');
  const api = new Function(src + '\n;return M8Lora;')();
  api.init();
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

/* 读文件是 Promise 链，同步 step 兜不住，得单独排队等。
   注意这里**只排队、不启动** —— 如果推进去就立刻跑，几个用例的 boot() 会
   同时执行完，共享的模块实例被最后一个覆盖，断言就会看错对象（踩过）。 */
const pending = [];
function astep(name, fn) { pending.push([name, fn]); }

/* 小端写一个 u64 到前 8 字节 */
function u64le(n) {
  const b = new Uint8Array(8);
  let v = n;
  for (let i = 0; i < 8; i++) { b[i] = v & 255; v = Math.floor(v / 256); }
  return b;
}

let m = null;

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Lora 没导出来');
});

/* ---------------------------------------------------------------- 长度字段 */

step('header 长度：小端 u64 读得对', () => {
  m = boot();
  if (m.headerLength(u64le(1234)) !== 1234) throw new Error('小数字读错');
  if (m.headerLength(u64le(0)) !== 0) throw new Error('0 该当成无效');
  if (m.headerLength(u64le(64 * 1024)) !== 64 * 1024) throw new Error('64KB 读错');
});

step('header 长度：大得离谱就当成不是 safetensors', () => {
  m = boot();
  const b = new Uint8Array(8).fill(0xff);
  if (m.headerLength(b) !== 0) throw new Error('这种长度该被挡掉，不然会去 slice 一个天文数字');
});

step('header 长度：字节不够或空输入返回 0', () => {
  m = boot();
  if (m.headerLength(new Uint8Array(4)) !== 0) throw new Error('4 字节也算数了');
  if (m.headerLength(null) !== 0) throw new Error('null 也算数了');
  if (m.headerLength(new Uint8Array(0)) !== 0) throw new Error('空也算数了');
});

/* ---------------------------------------------------------------- header */

step('header：读出 __metadata__ 和张量表', () => {
  m = boot();
  const json = JSON.stringify({
    __metadata__: { ss_network_dim: '32', ss_base_model_version: 'sdxl_base_v1-0' },
    'lora_unet_double_blocks_0_img_mod_lin': { dtype: 'F16', shape: [32, 1280], data_offsets: [0, 81920] },
    'lora_unet_double_blocks_0_txt_mod_lin': { dtype: 'F16', shape: [32, 1280], data_offsets: [81920, 163840] },
  });
  const h = m.parseHeader(json);
  if (!h) throw new Error('没解出来');
  if (!h.metadata) throw new Error('metadata 没解出来');
  if (h.metadata.ss_network_dim !== '32') throw new Error('metadata 内容不对');
  if (h.tensors.length !== 2) throw new Error('张量数：' + h.tensors.length);
  if (h.tensors[0].dtype !== 'F16') throw new Error('dtype 没读出来');
});

step('header：没有 __metadata__ 也算解出来了（张量表还在）', () => {
  m = boot();
  const h = m.parseHeader(JSON.stringify({ a: { dtype: 'F32', shape: [1] } }));
  if (!h) throw new Error('整个返回 null 了 —— 没有 metadata 的模型也该能看张量表');
  if (h.metadata !== null) throw new Error('metadata 该是 null');
  if (h.tensors.length !== 1) throw new Error('张量表没解出来');
});

step('header：坏 JSON 返回 null，不抛', () => {
  m = boot();
  if (m.parseHeader('{ 这不是 json') !== null) throw new Error('坏 JSON 解出来了');
  if (m.parseHeader('') !== null) throw new Error('空串解出来了');
  if (m.parseHeader(null) !== null) throw new Error('null 解出来了');
  if (m.parseHeader('null') !== null) throw new Error('字面 null 解出来了');
});

step('header：后面跟了填充字节也能解（找最后一个花括号收尾）', () => {
  m = boot();
  const json = JSON.stringify({ __metadata__: { a: '1' } }) + '   ';
  const h = m.parseHeader(json);
  if (!h || !h.metadata || h.metadata.a !== '1') throw new Error('带尾巴就解不出来了');
});

/* ---------------------------------------------------------------- 标签频率 */

step('标签频率：字符串化的 JSON 能解，并按次数排序', () => {
  m = boot();
  const raw = JSON.stringify({
    '1_girl': { '1girl': 320, solo: 280, 'silver hair': 120, smile: 90 },
  });
  const g = m.parseTagFrequency(raw);
  if (!g || g.length !== 1) throw new Error('没解出来');
  if (g[0].tags.length !== 4) throw new Error('标签数：' + g[0].tags.length);
  if (g[0].tags[0].tag !== '1girl') throw new Error('没按次数排：' + g[0].tags[0].tag);
  if (g[0].tags[0].count !== 320) throw new Error('次数读错：' + g[0].tags[0].count);
  if (g[0].tags[3].tag !== 'smile') throw new Error('末尾排序不对：' + g[0].tags[3].tag);
});

step('标签频率：多个数据集分成多组', () => {
  m = boot();
  const raw = JSON.stringify({
    '1_girl': { '1girl': 10 },
    '2_bg': { forest: 5 },
  });
  const g = m.parseTagFrequency(raw);
  if (!g || g.length !== 2) throw new Error('组数：' + (g ? g.length : 'null'));
});

step('标签频率：坏 JSON / 空值返回 null', () => {
  m = boot();
  if (m.parseTagFrequency('{ 坏的') !== null) throw new Error('坏 JSON 解了');
  if (m.parseTagFrequency('') !== null) throw new Error('空串解了');
  if (m.parseTagFrequency(null) !== null) throw new Error('null 解了');
  if (m.parseTagFrequency('{}') !== null) throw new Error('空对象该返回 null');
});

/* ---------------------------------------------------------------- 提取 */

step('提取：kohya 的 ss_ 参数挑得出来', () => {
  m = boot();
  const info = m.extract({
    ss_network_dim: '32',
    ss_network_alpha: '16',
    ss_learning_rate: '0.0001',
    ss_base_model_version: 'sdxl_base_v1-0',
    ss_max_train_steps: '3000',
    ss_optimizer: 'AdamW8bit',
  });
  const names = info.fields.map((f) => f[0]);
  for (const want of ['Dimension (dim)', 'Alpha', 'Learning rate', 'Base model version', 'Training steps', 'Optimizer']) {
    if (names.indexOf(want) < 0) throw new Error('少了 ' + want + '（实际：' + names.join(',') + '）');
  }
});

step('提取：modelspec 命名空间单独归一类', () => {
  m = boot();
  const info = m.extract({ 'modelspec.architecture': 'stable-diffusion-xl-v1-base/lora' });
  if (!info.spec.length) throw new Error('modelspec 没归到 spec，跑到 others 去了');
  if (info.spec[0][0] !== 'Architecture') throw new Error('wrong label: ' + info.spec[0][0]);
});

step('提取：没见过的新参数也留着，不丢', () => {
  m = boot();
  const info = m.extract({ ss_some_brand_new_param: 'abc' });
  if (!info.others.length) throw new Error('新参数被吞了');
  if (info.others[0][0] !== 'ss_some_brand_new_param') throw new Error('键名不对');
});

step('提取：超长的值会截断（别把页面撑爆）', () => {
  m = boot();
  const info = m.extract({ ss_huge: 'x'.repeat(5000) });
  if (info.others[0][1].length > 600) throw new Error('没截断，长度 ' + info.others[0][1].length);
});

step('提取：标签频率也会一并解出来', () => {
  m = boot();
  const info = m.extract({
    ss_network_dim: '16',
    ss_tag_frequency: JSON.stringify({ '1_girl': { '1girl': 50 } }),
  });
  if (!info.tagGroups) throw new Error('标签频率没解出来');
  if (info.tagGroups[0].tags[0].tag !== '1girl') throw new Error('内容不对');
});

step('提取：没有 metadata 返回 null', () => {
  m = boot();
  if (m.extract(null) !== null) throw new Error('null 该返回 null');
});

step('提取：空 metadata 不炸，各列表都是空的', () => {
  m = boot();
  const info = m.extract({});
  if (!info) throw new Error('空对象该返回结构');
  if (info.fields.length || info.spec.length || info.others.length || info.tagGroups) {
    throw new Error('空 metadata 不该挑出任何东西');
  }
});

/* ---------------------------------------------------------------- 分组与真实噪音 */

/* 下面这几条都是照本机 774 个真 LoRA 的实际形状补的。 */

step('分组：键落到对应的卡里，空组不出现', () => {
  m = boot();
  const info = m.extract({
    ss_network_dim: '32',
    ss_enable_bucket: 'True',
    ss_loss_type: 'l2',
    ss_max_grad_norm: '1.0',
  });
  const titles = info.groups.map((g) => g.title);
  for (const want of ['Training parameters', 'Dataset and captions', 'Noise and sampling', 'Training run']) {
    if (titles.indexOf(want) < 0) throw new Error('少了「' + want + '」这张卡：' + titles.join(','));
  }
  /* 每张出现的卡都必须真的有内容 */
  info.groups.forEach((g) => {
    if (!g.pairs.length) throw new Error('「' + g.title + '」是空卡');
  });
  /* 只有训练参数那一组同时挂在 fields 上 */
  if (info.fields !== info.groups[0].pairs) throw new Error('fields 和第一组对不上');
});

step('synonym keys: writing both shows it once, and the old name alone still shows', () => {
  m = boot();
  /* 真文件里 ss_steps 和 ss_max_train_steps 同时存在、值还一样 */
  const both = m.extract({ ss_steps: '3000', ss_max_train_steps: '3000' });
  const shown = both.groups[0].pairs.filter((p) => p[0] === 'Training steps');
  if (shown.length !== 1) throw new Error('training steps shown ' + shown.length + ' times');
  if (shown[0][1] !== '3000') throw new Error('wrong value: ' + shown[0][1]);

  /* 只有旧名时，值要能回落到主键的位置上显示 */
  const legacy = m.extract({ ss_num_epochs: '10' });
  const ep = legacy.groups[0].pairs.filter((p) => p[0] === 'Epochs');
  if (!ep.length) throw new Error('the legacy ss_num_epochs alone showed no epoch count');
  /* 而且旧名不该再在「其他参数」里冒一遍 */
  if (legacy.others.some((p) => p[0] === 'ss_num_epochs')) {
    throw new Error('旧名在主键位置上显示过了，却又列进了其他参数');
  }
  /* 主键也在时，旧名同样不该冒出来 */
  const dup = m.extract({ ss_steps: '500', ss_max_train_steps: '500' });
  if (dup.others.some((p) => p[0] === 'ss_max_train_steps')) {
    throw new Error('同义键没被吸收，重复出现在其他参数里');
  }
});

step('kohya 的字符串 None 当没值，布尔值的 True/False 要保留', () => {
  m = boot();
  const info = m.extract({
    ss_unet_lr: 'None',
    ss_noise_offset: 'None',
    ss_min_snr_gamma: 'None',
    ss_flip_aug: 'False',
    ss_enable_bucket: 'True',
  });
  const flat = {};
  info.groups.forEach((g) => g.pairs.forEach((p) => { flat[p[0]] = p[1]; }));
  if ('UNet learning rate' in flat) throw new Error('None was shown as a real value');
  if ('Noise offset' in flat) throw new Error('None was shown as a real value');
  if ('Min-SNR gamma' in flat) throw new Error('None was shown as a real value');
  if (flat['Flip augmentation'] !== 'False') throw new Error('False is real information and must not be swallowed');
  if (flat['Bucketing'] !== 'True') throw new Error('True is real information and must not be swallowed');
});

step('内嵌缩略图不列出来，只报个数', () => {
  m = boot();
  const info = m.extract({
    'modelspec.thumbnail': 'data:image/jpeg;base64,' + 'A'.repeat(4000),
    ss_network_dim: '16',
  });
  if (info.others.some((p) => p[0] === 'modelspec.thumbnail')) {
    throw new Error('缩略图混进了其他参数，会把那张卡拉成一屏乱码');
  }
  if (info.skipped !== 1) throw new Error('没统计省略了几项：' + info.skipped);
});

step('空标签组丢干净（kohya 爱写 {"resized": {}}）', () => {
  m = boot();
  if (m.parseTagFrequency(JSON.stringify({ resized: {} })) !== null) {
    throw new Error('空组没丢，会画出一张空标签卡');
  }
  const mixed = m.parseTagFrequency(JSON.stringify({ resized: {}, img: { '1girl': 5 } }));
  if (!mixed || mixed.length !== 1) throw new Error('该只留非空的那一组');
  if (mixed[0].group !== 'img') throw new Error('留下的组不对：' + mixed[0].group);
});

step('训练耗时：两个时间都有才算，只有一个不算', () => {
  m = boot();
  const info = m.extract({
    ss_training_started_at: '1768106358.29',
    ss_training_finished_at: '1768110562.95',
  });
  const g = info.groups.filter((x) => x.title === 'Training run')[0];
  if (!g) throw new Error('no Training run card');
  const dur = g.pairs.filter((p) => p[0] === 'Training time')[0];
  if (!dur) throw new Error('the duration was not computed');
  if (dur[1] !== '1 h 10 min') throw new Error('computed wrongly: ' + dur[1]);

  const half = m.extract({ ss_training_started_at: '1768106358.29' });
  const gh = half.groups.filter((x) => x.title === 'Training run')[0];
  if (gh && gh.pairs.some((p) => p[0] === 'Training time')) throw new Error('a duration was computed from a start time alone');
  /* 时间戳本身也不该孤零零地掉进其他参数 */
  if (half.others.some((p) => p[0] === 'ss_training_started_at')) {
    throw new Error('the timestamp leaked into Other parameters');
  }
});

step('网络参数那串 JSON 拆成一条条', () => {
  m = boot();
  const info = m.extract({
    ss_network_args: JSON.stringify({ algo: 'lora', factor: 8, preset: 'anima_full', dropout: 0.05 }),
  });
  const g = info.groups.filter((x) => x.title === 'Noise and sampling')[0];
  if (!g) throw new Error('the card holding the network parameters never appeared');
  const names = g.pairs.map((p) => p[0]);
  for (const w of ['Network arg · algo', 'Network arg · factor', 'Network arg · preset', 'Network arg · dropout']) {
    if (names.indexOf(w) < 0) throw new Error('did not split out ' + w);
  }
  const algo = g.pairs.filter((p) => p[0].indexOf('Network arg ') === 0)[0];
  if (algo[1] !== 'lora') throw new Error('the split-out value was wrong: ' + algo[1]);
});

/* ---------------------------------------------------------------- 端到端 */

/* 造一个结构完全正确的 safetensors：8 字节小端长度 + JSON header + 假张量数据。
   假张量故意造得很大 —— 为的就是验「只读头部」这条承诺。 */
function makeSafetensors(meta, tensorBytes) {
  const header = {
    __metadata__: Object.assign({}, meta),
    lora_unet_double_blocks_0_img_mod_lin: { dtype: 'F16', shape: [32, 1280], data_offsets: [0, 81920] },
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const lenBuf = Buffer.alloc(8);
  lenBuf.writeBigUInt64LE(BigInt(json.length));
  return { buf: Buffer.concat([lenBuf, json, Buffer.alloc(tensorBytes, 0x5a)]), json: json };
}

function wrap(buf, name) {
  return new File([buf], name, { type: 'application/octet-stream' });
}

/* 把 slice 调用记下来，统计一共碰了多少字节 */
function spySlice(file) {
  const spans = [];
  const orig = file.slice.bind(file);
  file.slice = function (a, b) {
    const s = a === undefined ? 0 : a;
    const e = b === undefined ? file.size : b;
    spans.push([s, e]);
    return orig(a, b);
  };
  return spans;
}

const settle = () => new Promise((r) => setTimeout(r, 120));

astep('端到端：20MB 的模型只读头部，张量一个字节都不碰', async () => {
  const api = boot();
  const META = {
    ss_network_dim: '32',
    ss_network_alpha: '16',
    ss_learning_rate: '0.0001',
    ss_base_model_version: 'sdxl_base_v1-0',
    ss_max_train_steps: '3000',
    ss_tag_frequency: JSON.stringify({ '1_girl': { '1girl': 120, solo: 88 } }),
  };
  const made = makeSafetensors(META, 20 * 1024 * 1024);
  const file = wrap(made.buf, 'demo.safetensors');
  const spans = spySlice(file);

  api.analyze(file);
  await settle();

  if (spans.length !== 2) throw new Error('切了 ' + spans.length + ' 次，该是 2 次');
  if (spans[0][0] !== 0 || spans[0][1] !== 8) throw new Error('第一次该只切 0..8');
  if (spans[1][0] !== 8) throw new Error('第二次该从 8 开始');
  if (spans[1][1] !== 8 + made.json.length) throw new Error('第二次该只切到 header 末尾');

  const total = spans.reduce((s, p) => s + (p[1] - p[0]), 0);
  if (total !== 8 + made.json.length) throw new Error('读的总量不对：' + total);
  if (total > 64 * 1024) throw new Error('读了 ' + total + ' 字节，头部不该有这么大');
  if (total * 1000 > file.size) {
    throw new Error('读了 ' + total + ' / 文件 ' + file.size + '，不成比例 —— 可能在读张量');
  }
});

astep('端到端：读完之后把 input 清掉，不挂着文件引用', async () => {
  const api = boot();
  const made = makeSafetensors({ ss_network_dim: '8' }, 4096);
  const file = wrap(made.buf, 'demo.safetensors');
  byId.loraFile.value = 'C:\fakepath\demo.safetensors';
  api.analyze(file);
  await settle();
  if (byId.loraFile.value !== '') throw new Error('input 没清掉，值还挂着：' + byId.loraFile.value);
});

astep('端到端：读完面板填上了内容，重来按钮露出来', async () => {
  const api = boot();
  const made = makeSafetensors({ ss_network_dim: '32', ss_base_model_version: 'sdxl_base_v1-0' }, 2048);
  api.analyze(wrap(made.buf, 'demo.safetensors'));
  await settle();
  if (!byId.loraPanels.children.length) throw new Error('面板是空的，什么都没渲染');
  if (byId.loraBody.classSet.has('is-hidden')) throw new Error('结果区还藏着');
  if (byId.loraAgain.classSet.has('is-hidden')) throw new Error('重来按钮没露出来');
});

astep('端到端：不是 safetensors 的文件被挡下来，并且回到可再传的状态', async () => {
  const api = boot();
  const bad = Buffer.concat([Buffer.alloc(8, 0xff), Buffer.from('nope')]);
  api.analyze(wrap(bad, 'broken.safetensors'));
  await settle();
  if (byId.loraBody.classSet.has('is-hidden') === false) throw new Error('坏文件还把结果区打开了');
  if (byId.loraDrop.classSet.has('is-hidden')) throw new Error('拖拽区没恢复，用户没法重传');
  if (!/safetensors/.test(byId.loraStatus.textContent)) throw new Error('没给出可读的提示：' + byId.loraStatus.textContent);
});

astep('端到端：扩展名不对的直接拦下，根本不去读文件', async () => {
  const api = boot();
  const made = makeSafetensors({ ss_network_dim: '8' }, 1024);
  const file = wrap(made.buf, 'model.ckpt');
  const spans = spySlice(file);
  api.analyze(file);
  await settle();
  if (spans.length) throw new Error('扩展名不对却还是读了 ' + spans.length + ' 次');
  if (!/safetensors/.test(byId.loraStatus.textContent)) throw new Error('没提示只认 safetensors');
});

/* ---------------------------------------------------------------- 汇总 */

(async () => {
  for (const pair of pending) {
    try {
      await pair[1]();
      console.log('  OK    ' + pair[0]);
    } catch (e) {
      fails.push(pair[0] + ' -> ' + e.message);
      console.log('  FAIL  ' + pair[0] + ' -> ' + e.message);
    }
  }
  console.log('');
  if (fails.length) {
    console.log('LoRA 解析实跑检查：' + fails.length + ' 个失败');
    fails.forEach((f) => console.log('  * ' + f));
    process.exitCode = 1;
  } else {
    console.log('LoRA 解析实跑检查：全部通过');
  }
})();
