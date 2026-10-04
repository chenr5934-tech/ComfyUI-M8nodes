/* ============================================================================
 * M8web · APNG 合成的实跑检查
 *
 * 编码器是纯函数（吃单帧 PNG 的字节，吐 APNG 的字节），所以测试里**自己造 PNG**
 * 喂进去就行，不用真图片、不用浏览器。这和 meta.js 那套解析器的验法一样。
 *
 * 造数据时用的 CRC32 是**本文件独立实现的一份**，不调用被测代码 ——
 * 否则「自己算的 CRC 自己验」，写错了也测不出来。两份对得上才算数。
 *
 * 手法是「结构验证」而不是「解码验证」：这里没有解码器，所以验的是
 * 块顺序、序列号连号、CRC 对不对、长度加不加得起来。这已经能抓住
 * APNG 里最容易写错的几处（CRC 范围、fdAT 的序列号从哪开始、第一帧走不走 IDAT）。
 *
 * 用法：node tests/frontend_apng.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let fails = 0;
const steps = [];
function test(name, fn) { steps.push({ name, fn }); }
function ok(cond, what) { if (!cond) throw new Error(what || '断言失败'); }
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((what || '值不对') + '：期望 ' + b + '，实际 ' + a);
}

/* ---------------------------------------------------------------- 独立 CRC32 */

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function myCrc(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_T[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- 造 PNG */

function u32(v) {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
}

function chunk(type, data) {
  const body = [].concat(...type.split('').map((c) => [c.charCodeAt(0)]), data);
  const len = u32(data.length);
  const all = len.concat(body);
  const crc = u32(myCrc(new Uint8Array(all), 4, all.length));
  return new Uint8Array(all.concat(crc));
}

/**
 * 造一份结构合法、但 IDAT 内容是随便填的 PNG。
 * 被测代码只读 IHDR 和收集 IDAT，不解压 —— 所以内容不重要。
 */
function makePng(opts) {
  const o = opts || {};
  const w = o.width === undefined ? 4 : o.width;
  const h = o.height === undefined ? 3 : o.height;
  const colorType = o.colorType === undefined ? 6 : o.colorType;
  const interlace = o.interlace === undefined ? 0 : o.interlace;
  const idatBytes = o.idatBytes || [1, 2, 3, 4, 5, 6, 7, 8];

  const ihdr = new Uint8Array([]
    .concat(u32(w), u32(h), [8, colorType, 0, 0, interlace]));

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Array.from(ihdr)),
  ];
  // 可以切成多块 IDAT —— 真实文件常这样，装箱时要把它们全收齐
  const slices = o.idatSlices || 1;
  for (let i = 0; i < slices; i++) {
    const per = Math.ceil(idatBytes.length / slices);
    parts.push(chunk('IDAT', idatBytes.slice(i * per, (i + 1) * per)));
  }
  parts.push(chunk('IEND', []));

  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ---------------------------------------------------------------- 加载被测代码 */

const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/apng.js'), 'utf8');
const A = new Function(src + '\n;return M8Apng;')();

/* ---------------------------------------------------------------- 拆块工具 */

/** 把一份 PNG/APNG 拆成 [{type, data, len, crcOk}]。长度坏掉就停。 */
function chunksOf(bytes) {
  const out = [];
  if (!bytes || bytes.length < 8) return out;
  let pos = 8;
  let guard = 0;
  while (pos + 8 <= bytes.length && guard < 5000) {
    guard += 1;
    const len = (bytes[pos] << 24 | bytes[pos + 1] << 16 | bytes[pos + 2] << 8 | bytes[pos + 3]) >>> 0;
    if (len > bytes.length - pos - 8) break;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    const stored = (bytes[pos + 8 + len] << 24 | bytes[pos + 9 + len] << 16 |
                    bytes[pos + 10 + len] << 8 | bytes[pos + 11 + len]) >>> 0;
    out.push({
      type,
      len,
      data,
      crcOk: stored === myCrc(bytes, pos + 4, pos + 8 + len),
    });
    pos += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/* ================================================================ CRC32 */

test('crc32：对得上标准测试向量', () => {
  // "123456789" 的 CRC32 是 0xCBF43926，这是这个算法的标准向量
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => c + 48));
  eq(A.crc32(bytes), 0xcbf43926, 'CRC32("123456789")');
  eq(A.crc32(new Uint8Array(0)), 0, '空输入的 CRC32 是 0');
});

/* ================================================================ makeChunk */

test('makeChunk：长度 / 类型 / CRC 都对', () => {
  const c = A.makeChunk('tEXt', new Uint8Array([1, 2, 3]));
  eq(c.length, 12 + 3, '总长 = 12 + 数据长');
  eq(Array.from(c.subarray(4, 8)), [116, 69, 88, 116], '类型是 tEXt 的 ASCII');
  eq(myCrc(c, 4, c.length - 4), (c[c.length - 4] << 24 | c[c.length - 3] << 16 |
     c[c.length - 2] << 8 | c[c.length - 1]) >>> 0, 'CRC 覆盖 type + data');
});

test('makeChunk：CRC 不把长度字段算进去', () => {
  /* 这是最容易写错的一处：长度也算进去的话，块头看着完全正常，
     解码器却会在第一个块就报 CRC 错。 */
  const a = A.makeChunk('abcd', new Uint8Array([9]));
  const crcA = (a[a.length - 4] << 24 | a[a.length - 3] << 16 | a[a.length - 2] << 8 | a[a.length - 1]) >>> 0;
  eq(crcA, myCrc(a, 4, a.length - 4), 'CRC 从类型开始算');
  ok(crcA !== myCrc(a, 0, a.length - 4), '把长度也算进去会得到另一个值（说明这个区分有效）');
});

/* ================================================================ parsePng */

test('parsePng：读出 IHDR，收齐多块 IDAT', () => {
  const png = makePng({ width: 7, height: 5, colorType: 6, idatSlices: 3 });
  const info = A.parsePng(png);
  ok(info, '应该解析成功');
  eq([info.width, info.height], [7, 5], '尺寸');
  eq(info.colorType, 6, '色彩类型');
  eq(info.bitDepth, 8, '位深');
  eq(info.interlace, 0, '非交错');
  eq(info.idat.length, 3, '三块 IDAT 都要收齐');
});

test('parsePng：坏数据一律安静地返回 null，不抛', () => {
  const cases = [
    [null, 'null'],
    [new Uint8Array(0), '空'],
    [new Uint8Array([1, 2, 3]), '太短'],
    [new Uint8Array(30), '野数据'],
    [makePng().subarray(0, 20), '截断到只剩签名和半个 IHDR'],
  ];
  for (const [bytes, label] of cases) {
    let got;
    try { got = A.parsePng(bytes); } catch (e) { throw new Error(label + ' 抛了异常：' + e.message); }
    eq(got, null, label + ' 应该返回 null');
  }
});

test('parsePng：长度字段坏掉时不会读越界', () => {
  // 把 IHDR 的长度字段改成一个大得离谱的值
  const png = makePng();
  const broken = new Uint8Array(png);
  broken[8] = 0xff; broken[9] = 0xff; broken[10] = 0xff; broken[11] = 0xff;
  let got;
  try { got = A.parsePng(broken); } catch (e) { throw new Error('抛了异常：' + e.message); }
  eq(got, null, '长度坏掉应该停手返回 null');
});

/* ================================================================ build：单帧 */

test('build：单帧的块顺序是 签名 IHDR acTL fcTL IDAT IEND', () => {
  const apng = A.build([{ png: makePng() }], { delayMs: 100 });
  const types = chunksOf(apng).map((c) => c.type);
  eq(types, ['IHDR', 'acTL', 'fcTL', 'IDAT', 'IEND'], '块顺序');
  eq(A.countFrames(apng), 1, '帧数');
});

test('build：每个块的 CRC 都对', () => {
  const apng = A.build([{ png: makePng() }, { png: makePng() }], { delayMs: 100 });
  const bad = chunksOf(apng).filter((c) => !c.crcOk);
  eq(bad.map((c) => c.type), [], 'CRC 不对的块');
});

test('build：IHDR 的内容整块照搬第一帧', () => {
  const apng = A.build([{ png: makePng({ width: 12, height: 9, colorType: 6 }) }], {});
  const ihdr = chunksOf(apng).find((c) => c.type === 'IHDR');
  const w = (ihdr.data[0] << 24 | ihdr.data[1] << 16 | ihdr.data[2] << 8 | ihdr.data[3]) >>> 0;
  const h = (ihdr.data[4] << 24 | ihdr.data[5] << 16 | ihdr.data[6] << 8 | ihdr.data[7]) >>> 0;
  eq([w, h], [12, 9], '尺寸');
  eq(ihdr.data[8], 8, '位深');
  eq(ihdr.data[9], 6, '色彩类型');
  eq([ihdr.data[10], ihdr.data[11], ihdr.data[12]], [0, 0, 0], '压缩/过滤/交错三个字段都归零');
});

test('build：acTL 里的帧数和循环次数', () => {
  const apng = A.build([{ png: makePng() }, { png: makePng() }, { png: makePng() }], { loops: 3 });
  const actl = chunksOf(apng).find((c) => c.type === 'acTL');
  const frames = (actl.data[0] << 24 | actl.data[1] << 16 | actl.data[2] << 8 | actl.data[3]) >>> 0;
  const plays = (actl.data[4] << 24 | actl.data[5] << 16 | actl.data[6] << 8 | actl.data[7]) >>> 0;
  eq([frames, plays], [3, 3], '帧数 / 循环次数');

  const once = A.build([{ png: makePng() }], { loops: 0 });
  const actl0 = chunksOf(once).find((c) => c.type === 'acTL');
  eq([actl0.data[4], actl0.data[5], actl0.data[6], actl0.data[7]], [0, 0, 0, 0], '0 表示无限循环');
});

/* ================================================================ build：多帧 */

test('build：第一帧走 IDAT，第二帧起走 fdAT', () => {
  /* 第一帧沿用 IDAT 有个实际好处：不支持 APNG 的解码器会把它当一张普通
     静态图显示，而不是报错。 */
  const apng = A.build([
    { png: makePng({ idatBytes: [10, 11] }) },
    { png: makePng({ idatBytes: [20, 21] }) },
  ], {});
  const types = chunksOf(apng).map((c) => c.type);
  eq(types, ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND'], '块顺序');

  const all = chunksOf(apng);
  eq(all.find((c) => c.type === 'IDAT').len, 2, '第一帧的数据在 IDAT 里');
  const fdat = all.find((c) => c.type === 'fdAT');
  eq(fdat.len, 2 + 4, 'fdAT 比原数据多 4 字节序列号');
  eq(Array.from(fdat.data.subarray(4)), [20, 21], 'fdAT 前 4 字节是序列号，后面才是像素数据');
});

test('build：序列号由 fcTL 和 fdAT 共用，IDAT 不占号', () => {
  const apng = A.build([
    { png: makePng() }, { png: makePng() }, { png: makePng() },
  ], {});
  const seq = [];
  for (const c of chunksOf(apng)) {
    if (c.type === 'fcTL' || c.type === 'fdAT') {
      seq.push((c.data[0] << 24 | c.data[1] << 16 | c.data[2] << 8 | c.data[3]) >>> 0);
    }
  }
  // 三帧：fcTL(帧0)=0, fcTL(帧1)=1, fdAT(帧1)=2, fcTL(帧2)=3, fdAT(帧2)=4
  eq(seq, [0, 1, 2, 3, 4], '序列号必须连号，中间不能断');
});

test('build：多块 IDAT 的帧，fdAT 也是多块', () => {
  const apng = A.build([
    { png: makePng({ idatSlices: 2 }) },
    { png: makePng({ idatSlices: 3 }) },
  ], {});
  const types = chunksOf(apng).map((c) => c.type);
  eq(types.filter((t) => t === 'IDAT').length, 2, '第一帧的两块 IDAT');
  eq(types.filter((t) => t === 'fdAT').length, 3, '第二帧的三块 fdAT');
});

/* ================================================================ 延迟 / 速度 */

test('build：延迟写进每个 fcTL，读回来一致', () => {
  const apng = A.build([
    { png: makePng() }, { png: makePng() }, { png: makePng() },
  ], { delayMs: 2500 });
  eq(A.readDelays(apng), [2500, 2500, 2500], '三帧的延迟都要一样');

  const fctl = chunksOf(apng).filter((c) => c.type === 'fcTL')[0];
  const num = (fctl.data[20] << 8) | fctl.data[21];
  const den = (fctl.data[22] << 8) | fctl.data[23];
  eq([num, den], [250, 100], '2500ms = 250/100 秒（延迟是分数，分母固定 100）');
});

test('delayFromSeconds：秒换算成毫秒', () => {
  eq(A.delayFromSeconds(1), 1000, '1 秒');
  eq(A.delayFromSeconds(2), 2000, '2 秒（默认档）');
  eq(A.delayFromSeconds(2.5), 2500, '2.5 秒');
  eq(A.delayFromSeconds(7), 7000, '7 秒');
  eq(A.delayFromSeconds(10), 10000, '10 秒');
});

test('delayFromSeconds：夹在 [1 秒, 10 秒] 之间，非法输入退回默认', () => {
  /* 这个区间是给「幻灯片式」动图用的：几张图轮播，每张停一会儿让人看清。
     100ms 那一档（10fps）属于动画片的速度，放到图集上快得看不清 ——
     第一版就是拿倍率算的（基准 100ms），实机用下来反馈「太快」。 */
  eq(A.MIN_DELAY_MS, 1000, '下限 1 秒');
  eq(A.MAX_DELAY_MS, 10000, '上限 10 秒');
  eq(A.DEFAULT_DELAY_MS, 2000, '默认 2 秒');

  eq(A.delayFromSeconds(0.1), 1000, '比 1 秒还快就停在 1 秒');
  eq(A.delayFromSeconds(99), 10000, '比 10 秒还慢就停在 10 秒');
  eq(A.delayFromSeconds(0), 2000, '0 退回默认');
  eq(A.delayFromSeconds(-3), 2000, '负数退回默认');
  eq(A.delayFromSeconds(NaN), 2000, 'NaN 退回默认');
  eq(A.delayFromSeconds(undefined), 2000, 'undefined 退回默认');
});

test('delayFromSeconds：结果落在 10ms 刻度上', () => {
  // APNG 的延迟单位是百分之一秒，任何值落到文件里都只能是 10ms 的倍数
  for (const s of [1, 1.5, 2, 2.5, 3.4, 7.7, 10]) {
    eq(A.delayFromSeconds(s) % 10, 0, s + ' 秒的结果必须是 10 的倍数');
  }
  eq(A.delayFromSeconds(3.4), 3400, '3.4 秒');
  eq(A.delayFromSeconds(7.7), 7700, '7.7 秒');
});

test('build：写进去的时长和解码器读出来的一致', () => {
  /* 界面上的秒数和文件里的 delay 必须是同一个值 —— 显示归显示、文件归文件的话，
     用户按显示的秒数去数，会发现对不上。 */
  for (const sec of [1, 2, 2.5, 5, 10]) {
    const want = A.delayFromSeconds(sec);
    const apng = A.build([{ png: makePng() }], { delayMs: want });
    eq(A.readDelays(apng), [want], sec + ' 秒时写进去和读回来要一样');
  }
});

test('build：不传时长就用默认的 2 秒', () => {
  eq(A.readDelays(A.build([{ png: makePng() }], {})), [2000], '不传');
  eq(A.readDelays(A.build([{ png: makePng() }], { delayMs: 0 })), [2000], '传 0');
  eq(A.readDelays(A.build([{ png: makePng() }], { delayMs: NaN })), [2000], '传 NaN');
  eq(A.readDelays(A.build([{ png: makePng() }], { delayMs: 500 })), [A.MIN_DELAY_MS], '500ms 被抬到 1 秒下限');
  eq(A.readDelays(A.build([{ png: makePng() }], { delayMs: 999999 })), [A.MAX_DELAY_MS], '过大被压到 10 秒上限');
});

/* ================================================================ 校验与拒绝 */

test('build：尺寸不一致就拒绝，并说清是第几帧', () => {
  let msg = '';
  try {
    A.build([{ png: makePng({ width: 4, height: 4 }) }, { png: makePng({ width: 9, height: 4 }) }], {});
  } catch (e) { msg = e.message; }
  ok(/2/.test(msg), '报错里要指出是第几帧，实际：' + msg);
});

test('build：色彩格式不一致也拒绝', () => {
  /* APNG 只有一份 IHDR，所有帧共用。RGB(2) 和 RGBA(6) 每像素字节数都不同，
     硬拼出来的文件解码器读不了。 */
  let threw = false;
  try {
    A.build([{ png: makePng({ colorType: 6 }) }, { png: makePng({ colorType: 2 }) }], {});
  } catch (e) { threw = true; }
  ok(threw, 'RGB 和 RGBA 混用应该被拒绝');
});

test('build：交错 PNG 拒绝（APNG 不支持）', () => {
  let threw = false;
  try {
    A.build([{ png: makePng({ interlace: 1 }) }], {});
  } catch (e) { threw = true; }
  ok(threw, '交错帧应该被拒绝');
});

test('build：坏帧和不存在的帧都拒绝', () => {
  for (const frames of [null, [], undefined]) {
    let threw = false;
    try { A.build(frames, {}); } catch (e) { threw = true; }
    ok(threw, '空帧列表应该被拒绝：' + JSON.stringify(frames));
  }
  let threw = false;
  try { A.build([{ png: new Uint8Array([1, 2, 3]) }], {}); } catch (e) { threw = true; }
  ok(threw, '不是 PNG 的帧应该被拒绝');
});

/* ================================================================ 缩放矩形 */

test('fitRect：contain 完整放下，短边贴边、居中留边', () => {
  // 源 100×50（2:1），目标 200×200 → 按 2 倍放到 200×100，上下各留 50
  eq(A.fitRect(100, 50, 200, 200, 'contain'), [0, 50, 200, 100], '横向的源');
  // 源 50×100（1:2）→ 100×200，左右各留 50
  eq(A.fitRect(50, 100, 200, 200, 'contain'), [50, 0, 100, 200], '纵向的源');
});

test('fitRect：cover 填满，多出来的部分靠画布裁掉', () => {
  // 源 100×50 → 按 4 倍放到 400×200，左右各超 100（负偏移）
  eq(A.fitRect(100, 50, 200, 200, 'cover'), [-100, 0, 400, 200], '横向的源');
  eq(A.fitRect(50, 100, 200, 200, 'cover'), [0, -100, 200, 400], '纵向的源');
});

test('fitRect：stretch 铺满，不管比例', () => {
  eq(A.fitRect(100, 50, 200, 200, 'stretch'), [0, 0, 200, 200], '拉伸');
  eq(A.fitRect(7, 3, 64, 64, 'stretch'), [0, 0, 64, 64], '任意比例都铺满');
});

test('fitRect：尺寸一样时三种方式结果相同', () => {
  eq(A.fitRect(64, 64, 64, 64, 'contain'), [0, 0, 64, 64], 'contain');
  eq(A.fitRect(64, 64, 64, 64, 'cover'), [0, 0, 64, 64], 'cover');
});

test('fitRect：源尺寸是 0 时退回铺满，不产生 NaN', () => {
  /* 除零会得到 Infinity/NaN，画到 canvas 上就是「什么都没有」——
     那是张读不出来的图，而不是一个能看出来的错。 */
  for (const bad of [[0, 0], [0, 10], [10, 0]]) {
    const r = A.fitRect(bad[0], bad[1], 200, 100, 'contain');
    eq(r, [0, 0, 200, 100], bad.join('x') + ' 应该退回铺满');
    for (const v of r) ok(isFinite(v), '不能出现 NaN/Infinity');
  }
});

/* ================================================================ 端到端 */

test('端到端：三帧合成后的整体结构自洽', () => {
  const apng = A.build([
    { png: makePng({ width: 6, height: 4 }) },
    { png: makePng({ width: 6, height: 4 }) },
    { png: makePng({ width: 6, height: 4 }) },
  ], { delayMs: 1500, loops: 0 });

  // 签名
  eq(Array.from(apng.subarray(0, 8)), A.SIGNATURE, 'PNG 签名');
  // 块类型全部是 4 个 ASCII 字母
  for (const c of chunksOf(apng)) {
    ok(/^[A-Za-z]{4}$/.test(c.type), '块类型应该是 4 个字母：' + c.type);
    ok(c.crcOk, c.type + ' 的 CRC 不对');
  }
  // 每个块的 12 + len 加起来正好等于文件长度
  let sum = 8;
  for (const c of chunksOf(apng)) sum += 12 + c.len;
  eq(sum, apng.length, '块长度之和 = 文件长度');
  eq(A.countFrames(apng), 3, '帧数');
  eq(A.readDelays(apng), [1500, 1500, 1500], '每帧延迟');
});

test('端到端：帧数从 1 到 8 都能合成', () => {
  for (let n = 1; n <= 8; n++) {
    const frames = [];
    for (let i = 0; i < n; i++) frames.push({ png: makePng({ idatBytes: [i, i + 1, i + 2] }) });
    const apng = A.build(frames, { delayMs: 2000 });
    eq(A.countFrames(apng), n, n + ' 帧的帧数');
    eq(A.readDelays(apng).length, n, n + ' 帧的延迟条数');
  }
});

/* ---------------------------------------------------------------- 跑 */

(async () => {
  for (const s of steps) {
    try {
      await s.fn();
      console.log('  OK    ' + s.name);
    } catch (e) {
      fails += 1;
      console.log('  FAIL  ' + s.name + ' -> ' + e.message);
    }
  }
  console.log('');
  if (fails) {
    console.log('APNG 合成实跑检查：' + fails + ' / ' + steps.length + ' 个失败');
    process.exitCode = 1;
  } else {
    console.log('APNG 合成实跑检查：' + steps.length + ' 个全部通过');
  }
})();
