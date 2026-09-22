/* ============================================================================
 * M8web · 图片元数据的实跑检查
 *
 * 解析器全是纯函数（吃 Uint8Array 吐对象），所以这里**自己造字节流**来验，
 * 不用去准备一堆真图片：
 *   makePng()  拼一个合法的 PNG（签名 + 若干 chunk）
 *   makeTiff() 拼一个最小的 EXIF（小端 TIFF + 一个 IFD）
 *
 * 最要紧的两条：能读出 ComfyUI 塞在 tEXt 里的 workflow，以及
 * 遇到坏字节不能崩（解析器崩掉是最难查的）。
 *
 * 用法：node tests/frontend_meta.js
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
    style: makeStyle(), dataset: {}, children: [], attributes: {}, classSet: new Set(),
    textContent: '', value: '', type: '', id: '', className: '', src: '', alt: '', files: null,
    naturalWidth: 1200, naturalHeight: 800,
    addEventListener: noop, click: noop, select: noop, focus: noop,
    appendChild(c) { if (c && c.__fragment) { c.children.forEach((x) => this.children.push(x)); return c; } this.children.push(c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; },
    remove: noop,
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; },
    removeAttribute(k) { delete this.attributes[k]; },
    querySelector: () => makeEl('span'),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
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
  for (const id of ['metaDrop', 'metaFile', 'metaHint', 'metaBody', 'metaThumb', 'metaName', 'metaPanels', 'metaAgain', 'metaStatus']) reg(id);
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: noop };
  globalThis.navigator = { clipboard: { writeText: () => Promise.resolve() } };
  const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/meta.js'), 'utf8');
  const api = new Function(src + '\n;return M8Meta;')();
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

/* ---------------------------------------------------------------- 造字节流 */

/* PNG 的块长度是**大端**，TIFF 是**小端** —— 两个格式刚好相反，
   共用一个写入函数就会构造出反的数据，然后得出「解析器坏了」这种假结论。
   我第一版就是这么栽的。 */
function w32(b, o, v) {
  b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255;
}
function w32le(b, o, v) {
  b[o] = v & 255; b[o + 1] = (v >>> 8) & 255; b[o + 2] = (v >>> 16) & 255; b[o + 3] = (v >>> 24) & 255;
}
function w16(b, o, v) { b[o] = v & 255; b[o + 1] = (v >> 8) & 255; }

function bytesOf(s) {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
}

/* PNG = 签名 + 一串 [长度4][类型4][数据][CRC4] */
function makePng(chunks) {
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  chunks.forEach(function (c) {
    const head = new Uint8Array(8);
    w32(head, 0, c.data.length);
    for (let i = 0; i < 4; i++) head[4 + i] = c.type.charCodeAt(i);
    parts.push(head, c.data, new Uint8Array(4));
  });
  let total = 0;
  parts.forEach(function (p) { total += p.length; });
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach(function (p) { out.set(p, at); at += p.length; });
  return out;
}

function ihdr(w, h, depth, colorType) {
  const d = new Uint8Array(13);
  w32(d, 0, w); w32(d, 4, h);
  d[8] = depth; d[9] = colorType;
  return d;
}

function textChunk(keyword, text) { return bytesOf(keyword + '\u0000' + text); }

/* 最小的合法 EXIF：小端 TIFF + 一个 IFD */
function makeTiff(entries) {
  const n = entries.length;
  const ifdSize = 2 + n * 12 + 4;
  let offset = 8 + ifdSize;
  const extras = [];
  const rows = entries.map(function (e) {
    let val = e.value || 0;
    if (e.data) {
      val = offset;
      extras.push({ at: offset, data: e.data });
      offset += e.data.length;
      if (offset % 2) { extras.push({ at: offset, data: new Uint8Array(1) }); offset += 1; }
    }
    return { tag: e.tag, type: e.type, count: e.count || 1, val: val };
  });
  const buf = new Uint8Array(offset);
  buf[0] = 0x49; buf[1] = 0x49;         // II = 小端（所以下面一律用 w32le）
  w16(buf, 2, 0x2A);
  w32le(buf, 4, 8);
  w16(buf, 8, n);
  let p = 10;
  rows.forEach(function (r) {
    w16(buf, p, r.tag); w16(buf, p + 2, r.type); w32le(buf, p + 4, r.count); w32le(buf, p + 8, r.val);
    p += 12;
  });
  w32le(buf, p, 0);
  extras.forEach(function (x) { buf.set(x.data, x.at); });
  return buf;
}

let m = null;

/* ---------------------------------------------------------------- PNG */

step('载入并初始化', () => {
  m = boot();
  if (!m) throw new Error('M8Meta 没导出来');
});

step('PNG：读出尺寸、位深、色彩类型', () => {
  m = boot();
  const png = m.parsePng(makePng([
    { type: 'IHDR', data: ihdr(1200, 800, 8, 6) },
    { type: 'IEND', data: new Uint8Array(0) },
  ]));
  if (!png) throw new Error('没解出来');
  if (png.info.width !== 1200 || png.info.height !== 800) {
    throw new Error('尺寸读错：' + png.info.width + 'x' + png.info.height);
  }
  if (png.info.depth !== 8) throw new Error('位深读错：' + png.info.depth);
  if (png.info.colorType !== 6) throw new Error('色彩类型读错：' + png.info.colorType);
});

step('PNG：读出 ComfyUI 塞的 prompt 和 workflow', () => {
  m = boot();
  const png = m.parsePng(makePng([
    { type: 'IHDR', data: ihdr(512, 512, 8, 6) },
    { type: 'tEXt', data: textChunk('prompt', '{"3":{"class_type":"KSampler"}}') },
    { type: 'tEXt', data: textChunk('workflow', '{"nodes":[{"id":1}]}') },
    { type: 'IEND', data: new Uint8Array(0) },
  ]));
  if (png.texts.prompt.indexOf('KSampler') < 0) throw new Error('没读到 prompt');
  if (png.texts.workflow.indexOf('nodes') < 0) throw new Error('没读到 workflow');
});

step('PNG：普通文本块也读出来', () => {
  m = boot();
  const png = m.parsePng(makePng([
    { type: 'IHDR', data: ihdr(64, 64, 8, 2) },
    { type: 'tEXt', data: textChunk('Software', 'M8 Test') },
    { type: 'IEND', data: new Uint8Array(0) },
  ]));
  if (png.texts.Software !== 'M8 Test') throw new Error('读成：' + png.texts.Software);
});

step('PNG：不是 PNG 就返回 null，别硬解', () => {
  m = boot();
  if (m.parsePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))) throw new Error('野数据被当成 PNG 了');
  if (m.parsePng(new Uint8Array(3))) throw new Error('太短的也算 PNG 了');
  if (m.parsePng(null)) throw new Error('null 也进去解了');
});

step('PNG：chunk 长度是坏的也不会卡死', () => {
  m = boot();
  const bad = makePng([
    { type: 'IHDR', data: ihdr(10, 10, 8, 6) },
    { type: 'tEXt', data: textChunk('x', 'y') },
  ]);
  /* 把第一个 chunk 的长度字段改成一个荒谬的大数 */
  w32(bad, 8, 0xFFFFFFF0);
  const t0 = Date.now();
  const png = m.parsePng(bad);
  if (Date.now() - t0 > 2000) throw new Error('卡住了');
  if (png === undefined) throw new Error('应当返回对象或 null，不能是 undefined');
});

step('PNG：截断的文件也能读出前面那部分', () => {
  m = boot();
  const full = makePng([
    { type: 'IHDR', data: ihdr(300, 200, 8, 6) },
    { type: 'tEXt', data: textChunk('prompt', '{"a":1}') },
    { type: 'IEND', data: new Uint8Array(0) },
  ]);
  const cut = full.subarray(0, full.length - 20);
  const png = m.parsePng(cut);
  if (!png) throw new Error('截断了就完全读不出来了吗');
  if (png.info.width !== 300) throw new Error('IHDR 该还是能读到的');
});

/* ---------------------------------------------------------------- ComfyUI */

step('工作流：挑出模型、采样器、步数、CFG、种子', () => {
  m = boot();
  const wf = {
    '3': { class_type: 'KSampler', inputs: { steps: 24, cfg: 7.5, seed: 12345, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1 } },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'animagineXL.safetensors' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: '1girl, solo' } },
    '7': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024 } },
  };
  const c = m.extractComfy(JSON.stringify(wf));
  if (!c) throw new Error('没解出来');
  if (c.steps !== 24) throw new Error('步数：' + c.steps);
  if (c.cfg !== 7.5) throw new Error('CFG：' + c.cfg);
  if (c.seed !== 12345) throw new Error('种子：' + c.seed);
  if (c.models[0] !== 'animagineXL.safetensors') throw new Error('模型：' + c.models.join(','));
  if (c.samplers.join('·') !== 'dpmpp_2m·karras') throw new Error('采样器：' + c.samplers.join(','));
  if (c.prompts[0] !== '1girl, solo') throw new Error('提示词：' + c.prompts.join('|'));
  if (c.sizes[0] !== '1024 × 1024') throw new Error('画布：' + c.sizes.join(','));
  if (c.count !== 4) throw new Error('节点数：' + c.count);
});

step('工作流：LoRA 也挑出来', () => {
  m = boot();
  const c = m.extractComfy(JSON.stringify({
    '5': { class_type: 'LoraLoader', inputs: { lora_name: 'add_detail.safetensors' } },
  }));
  if (c.loras[0] !== 'add_detail.safetensors') throw new Error('LoRA 没挑出来');
});

step('工作流：JSON 坏了返回 null，不抛异常', () => {
  m = boot();
  if (m.extractComfy('{ 这不是 json') !== null) throw new Error('坏 JSON 竟然解出来了');
  if (m.extractComfy('') !== null) throw new Error('空串也解了');
  if (m.extractComfy('null') !== null) throw new Error('null 也解了');
  if (m.extractComfy('[]') !== null) throw new Error('空数组也解了');
});

step('工作流：节点类型统计', () => {
  m = boot();
  const c = m.extractComfy(JSON.stringify({
    '1': { class_type: 'KSampler' },
    '2': { class_type: 'KSampler' },
    '3': { class_type: 'VAEDecode' },
  }));
  if (c.kinds.KSampler !== 2) throw new Error('KSampler 计成 ' + c.kinds.KSampler);
  if (c.kinds.VAEDecode !== 1) throw new Error('VAEDecode 计成 ' + c.kinds.VAEDecode);
  if (c.count !== 3) throw new Error('总数 ' + c.count);
});

/* ---------------------------------------------------------------- EXIF */

step('EXIF：读出相机型号（ASCII 字段）', () => {
  m = boot();
  const tiff = makeTiff([
    { tag: 0x0110, type: 2, count: 8, data: bytesOf('TestCam\u0000') },
  ]);
  const exif = m.parseTiff(tiff);
  if (!exif) throw new Error('没解出来');
  if (exif.tags['相机型号'] !== 'TestCam') throw new Error('读成：' + exif.tags['相机型号']);
});

step('EXIF：读出 ISO（短整型）', () => {
  m = boot();
  const tiff = makeTiff([{ tag: 0x8827, type: 3, count: 1, value: 400 }]);
  const exif = m.parseTiff(tiff);
  if (exif.tags['ISO'] !== 400) throw new Error('读成：' + exif.tags['ISO']);
});

step('EXIF：读出光圈（有理数）', () => {
  m = boot();
  /* FNumber 是 type 5（有理数），8 字节：分子 + 分母，放不下 4 字节所以要另存 */
  const rat = new Uint8Array(8);
  w32le(rat, 0, 14);   // 14/10 = f/1.4
  w32le(rat, 4, 10);
  const tiff = makeTiff([{ tag: 0x829D, type: 5, count: 1, data: rat }]);
  const exif = m.parseTiff(tiff);
  const f = exif.tags['光圈'];
  if (!f || typeof f !== 'object') throw new Error('光圈没解成有理数：' + JSON.stringify(f));
  if (Math.abs(f.n / f.d - 1.4) > 0.001) throw new Error('光圈值不对：' + f.n + '/' + f.d);
});

step('EXIF：坏字节返回 null，不抛异常', () => {
  m = boot();
  if (m.parseTiff(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))) throw new Error('野数据被解了');
  if (m.parseTiff(new Uint8Array(2))) throw new Error('太短的也解了');
  if (m.parseTiff(null)) throw new Error('null 也解了');
  /* 字节序标记对、但魔数不对 */
  const t = new Uint8Array(16);
  t[0] = 0x49; t[1] = 0x49; w16(t, 2, 0x1234);
  if (m.parseTiff(t)) throw new Error('魔数不对也解了');
});

step('EXIF：截断的 TIFF 不会越界读', () => {
  m = boot();
  const full = makeTiff([{ tag: 0x0110, type: 2, count: 16, data: bytesOf('A-Very-Long-Camera\u0000') }]);
  const cut = full.subarray(0, 14);
  m.parseTiff(cut);   // 只要不抛就算过
});

step('JPEG：不是 JPEG 就返回 null', () => {
  m = boot();
  if (m.parseJpeg(new Uint8Array([1, 2, 3, 4]))) throw new Error('野数据被当成 JPEG');
  if (m.parseJpeg(null)) throw new Error('null 也解了');
});

step('JPEG：读到 EXIF 段就解出来', () => {
  m = boot();
  const tiff = makeTiff([{ tag: 0x0110, type: 2, count: 6, data: bytesOf('CamX\u0000\u0000') }]);
  const exifSeg = new Uint8Array(6 + tiff.length);
  exifSeg.set(bytesOf('Exif\u0000\u0000'), 0);
  exifSeg.set(tiff, 6);
  /* FFD8 + FFE1 + 长度 + Exif... + FFDA */
  const seg = new Uint8Array(4 + exifSeg.length + 2);
  seg[0] = 0xff; seg[1] = 0xd8;
  seg[2] = 0xff; seg[3] = 0xe1;
  w16(seg, 4, exifSeg.length + 2);
  seg.set(exifSeg, 6);
  seg[6 + exifSeg.length] = 0xff;
  seg[7 + exifSeg.length] = 0xda;
  const exif = m.parseJpeg(seg);
  if (!exif) throw new Error('没解出来');
  if (exif.tags['相机型号'] !== 'CamX') throw new Error('读成：' + exif.tags['相机型号']);
});

step('JPEG：坏的长度字段不会死循环', () => {
  m = boot();
  const bad = new Uint8Array(64);
  bad[0] = 0xff; bad[1] = 0xd8;
  bad[2] = 0xff; bad[3] = 0xe0;
  w16(bad, 4, 0);   // 长度为 0
  const t0 = Date.now();
  m.parseJpeg(bad);
  if (Date.now() - t0 > 2000) throw new Error('卡住了');
});

console.log('');
if (fails.length) {
  console.log('图片元数据实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('图片元数据实跑检查：全部通过');
}
