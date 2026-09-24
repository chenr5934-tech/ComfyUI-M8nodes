/* ============================================================================
 * M8web · 混淆图的实跑检查
 *
 * 这一层全是纯函数（吃字节吐字节），所以测试直接造像素喂它，不需要浏览器。
 *
 * 最要紧的两条：
 *   1. 混淆完必须能原样还原 —— 一个字节都不能差
 *   2. 嵌套出来的图，掩护图的像素只能动最低位（动了高位肉眼就看得出）
 *
 * 用法：node tests/frontend_obfuscate.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/* 造确定性的测试图。用自己的 LCG，不依赖被测代码里的 PRNG。 */
function lcg(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeImage(w, h, seed) {
  const rng = lcg(seed);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = Math.floor(rng() * 256);
    data[i * 4 + 1] = Math.floor(rng() * 256);
    data[i * 4 + 2] = Math.floor(rng() * 256);
    /* alpha 也随机，这样顺便验证它也保住了 */
    data[i * 4 + 3] = Math.floor(rng() * 256);
  }
  return { data: data, width: w, height: h };
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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

const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/obfuscate.js'), 'utf8');
const m = new Function(src + '\n;return M8Obfuscate;')();

/* ---------------------------------------------------------------- 零件的零件 */

step('fnv1a：确定性、区分大小写、空输入不炸', () => {
  if (m.fnv1a(m.utf8Bytes('a')) !== m.fnv1a(m.utf8Bytes('a'))) throw new Error('不确定');
  if (m.fnv1a(m.utf8Bytes('a')) === m.fnv1a(m.utf8Bytes('A'))) {
    throw new Error('不区分大小写的话，密钥空间会白白少一半');
  }
  if (typeof m.fnv1a(new Uint8Array(0)) !== 'number') throw new Error('空输入出错');
});

step('mulberry32：可复现、值落在 [0,1)', () => {
  const a = m.mulberry32(1);
  const b = m.mulberry32(1);
  for (let i = 0; i < 200; i++) {
    const x = a();
    if (x !== b()) throw new Error('同一个种子的第 ' + i + ' 个数不一样');
    if (!(x >= 0 && x < 1)) throw new Error('超出 [0,1)：' + x);
  }
});

step('置换表：不重不漏，逆表真的互逆', () => {
  const p = m.makePermutation(500, m.mulberry32(12345));
  const seen = new Array(500).fill(false);
  for (let i = 0; i < p.length; i++) {
    const v = p[i];
    if (v < 0 || v >= 500) throw new Error('越界：' + v);
    if (seen[v]) throw new Error('重复：' + v);
    seen[v] = true;
  }
  const q = m.invertPermutation(p);
  for (let i = 0; i < p.length; i++) {
    if (q[p[i]] !== i) throw new Error('第 ' + i + ' 项逆回来对不上');
  }
});

step('块网格：铺满整图、不重叠、尺寸如实', () => {
  const bs = 32;
  const W = 100, H = 70;
  const blocks = m.blockGrid(W, H, bs);
  let covered = 0;
  for (const b of blocks) {
    if (b.x + b.w > W || b.y + b.h > H) throw new Error('块超出图外');
    if (b.w < 1 || b.h < 1) throw new Error('块尺寸小于 1');
    covered += b.w * b.h;
  }
  if (covered !== W * H) throw new Error('块没铺满：' + covered + ' vs ' + (W * H));
});

/* ---------------------------------------------------------------- 置乱 */

step('置乱可逆：1024x1024，块 64', () => {
  const img = makeImage(1024, 1024, 1);
  const o = { key: 'hunter2', blockSize: 64 };
  const sc = m.scramble(img, o);
  if (sc.length !== img.data.length) throw new Error('像素数变了');
  if (same(sc, img.data)) throw new Error('混淆了但图没变，等于没做');
  const back = m.unscramble({ data: sc, width: 1024, height: 1024 }, o);
  if (!same(back, img.data)) throw new Error('还原不回来');
});

step('置乱可逆：尺寸不能被块整除（100x70，块 32）', () => {
  const img = makeImage(100, 70, 7);
  const o = { key: 'k', blockSize: 32 };
  const sc = m.scramble(img, o);
  const back = m.unscramble({ data: sc, width: 100, height: 70 }, o);
  if (!same(back, img.data)) {
    throw new Error('边缘那些不满一格的块没处理对 —— 这是最容易出错的地方');
  }
});

step('置乱可逆：块大小 2 / 7 / 512 各种极端值', () => {
  for (const bs of [2, 7, 64, 512]) {
    const img = makeImage(33, 21, bs + 3);
    const o = { key: 'k', blockSize: bs };
    const sc = m.scramble(img, o);
    const back = m.unscramble({ data: sc, width: 33, height: 21 }, o);
    if (!same(back, img.data)) throw new Error('块大小 ' + bs + ' 还原不回来');
  }
});

step('块内打散：开着可逆，关掉也可逆，两者结果不同', () => {
  const img = makeImage(128, 128, 3);
  const on = { key: 'k', blockSize: 32, shufflePixels: true };
  const off = { key: 'k', blockSize: 32, shufflePixels: false };
  const a = m.scramble(img, on);
  const b = m.scramble(img, off);
  if (same(a, b)) throw new Error('开关没起作用');
  if (!same(m.unscramble({ data: a, width: 128, height: 128 }, on), img.data)) {
    throw new Error('开着的时候还原不回来');
  }
  if (!same(m.unscramble({ data: b, width: 128, height: 128 }, off), img.data)) {
    throw new Error('关掉的时候还原不回来');
  }
});

step('块内打散真的在干活（块间置换退化成恒等时只剩它）', () => {
  const img = makeImage(64, 64, 13);
  /* 块大小等于整图 → 只有一个块，块间置换退化成「自己换自己」。
     这时候有没有动静，全看块内打散 —— 正好拿它单独验这个开关。
     （第一版这条断言写反了，把「应该跟原图一样」写成了「如果一样就报错」，
       结果这条一直红着，代码其实是好的。） */
  const off = m.scramble(img, { key: 'k', blockSize: 64, shufflePixels: false });
  const on = m.scramble(img, { key: 'k', blockSize: 64, shufflePixels: true });
  if (!same(off, img.data)) {
    throw new Error('块内打散关着、又只有一个块，结果该跟原图一模一样');
  }
  if (same(on, img.data)) throw new Error('块内打散开着却什么都没变，这开关是假的');
  const o = { key: 'k', blockSize: 64, shufflePixels: true };
  if (!same(m.unscramble({ data: on, width: 64, height: 64 }, o), img.data)) {
    throw new Error('块内打散开着还原不回来');
  }
});

step('错密钥还原不出原图（密钥是真起作用的）', () => {
  const img = makeImage(64, 64, 5);
  const sc = m.scramble(img, { key: 'right', blockSize: 16 });
  const wrong = m.unscramble({ data: sc, width: 64, height: 64 }, { key: 'wrong', blockSize: 16 });
  if (same(wrong, img.data)) throw new Error('换个密钥也还原了，密钥等于没用');
});

step('同密钥同参数 → 结果逐字节一致（可复现）', () => {
  const img = makeImage(96, 96, 9);
  const o = { key: 'abc', blockSize: 24 };
  if (!same(m.scramble(img, o), m.scramble(img, o))) throw new Error('两次结果不一样，还原就无从谈起');
});

step('换块大小 / 换密钥 → 结果不同', () => {
  const img = makeImage(128, 128, 21);
  const a = m.scramble(img, { key: 'k', blockSize: 16 });
  const b = m.scramble(img, { key: 'k', blockSize: 64 });
  const c = m.scramble(img, { key: 'k2', blockSize: 16 });
  if (same(a, b)) throw new Error('换块大小没影响');
  if (same(a, c)) throw new Error('换密钥没影响');
});

step('中文密钥也能还原（UTF-8 编码对）', () => {
  const img = makeImage(64, 64, 31);
  const o = { key: '樱花粉的密码', blockSize: 32 };
  const sc = m.scramble(img, o);
  const back = m.unscramble({ data: sc, width: 64, height: 64 }, o);
  if (!same(back, img.data)) throw new Error('中文密钥还原不回来');
});

step('超小图不炸：1x1 / 2x2 / 3x5', () => {
  const sizes = [[1, 1], [2, 2], [3, 5]];
  for (const wh of sizes) {
    const w = wh[0], h = wh[1];
    const img = makeImage(w, h, w * 10 + h);
    const o = { key: 'k', blockSize: 64 };
    const sc = m.scramble(img, o);
    const back = m.unscramble({ data: sc, width: w, height: h }, o);
    if (!same(back, img.data)) throw new Error(w + 'x' + h + ' 还原不回来');
  }
});

step('图数据不完整时明确报错，不悄悄算错', () => {
  let msg = '';
  try { m.scramble({ data: new Uint8ClampedArray(4), width: 10, height: 10 }, { key: 'k' }); }
  catch (e) { msg = e.message; }
  if (!msg) throw new Error('数据不够却不报错');
});

step('指纹：混淆前后不一样，且可复现', () => {
  const img = makeImage(64, 64, 101);
  const f1 = m.fingerprint(img.data);
  const sc = m.scramble(img, { key: 'k' });
  const f2 = m.fingerprint(sc);
  if (f1 === f2) throw new Error('前后指纹一样，那密钥串就验不出配不配');
  if (f2 !== m.fingerprint(sc)) throw new Error('指纹不确定');
});

/* ---------------------------------------------------------------- 小番茄混淆 */

/* 这一组的重点不是「可逆」（那个和置乱一样好证），而是**和原版工具互通**：
   梦羽小番茄那个 HTML 混淆出来的图，这里要能解；这里混淆出来的，它也要能解。
   所以下面把原版那两个递归函数逐字抄了一份当参照物。 */

function refGilbert(W, H) {
  const coords = [];
  if (W >= H) refGen(0, 0, W, 0, 0, H, coords);
  else refGen(0, 0, 0, H, W, 0, coords);
  return coords;
}

function refGen(x, y, ax, ay, bx, by, coords) {
  const w = Math.abs(ax + ay);
  const h = Math.abs(bx + by);
  const dax = Math.sign(ax), day = Math.sign(ay);
  const dbx = Math.sign(bx), dby = Math.sign(by);
  if (h === 1) {
    for (let i = 0; i < w; i++) { coords.push([x, y]); x += dax; y += day; }
    return;
  }
  if (w === 1) {
    for (let i = 0; i < h; i++) { coords.push([x, y]); x += dbx; y += dby; }
    return;
  }
  let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2);
  let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);
  const w2 = Math.abs(ax2 + ay2);
  const h2 = Math.abs(bx2 + by2);
  if (2 * w > 3 * h) {
    if ((w2 % 2) && (w > 2)) { ax2 += dax; ay2 += day; }
    refGen(x, y, ax2, ay2, bx, by, coords);
    refGen(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by, coords);
  } else {
    if ((h2 % 2) && (h > 2)) { bx2 += dbx; by2 += dby; }
    refGen(x, y, bx2, by2, ax2, ay2, coords);
    refGen(x + bx2, y + by2, ax, ay, bx - bx2, by - by2, coords);
    refGen(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
      -bx2, -by2, -(ax - ax2), -(ay - ay2), coords);
  }
}

/* 原版 encryptImage / decryptImage 里那个循环，原样搬过来 */
function refTomato(img, inverse) {
  const W = img.width, H = img.height, n = W * H;
  const curve = refGilbert(W, H);
  const off = Math.round((Math.sqrt(5) - 1) / 2 * n);
  const out = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < n; i++) {
    const o = curve[i], p = curve[(i + off) % n];
    const op = 4 * (o[0] + o[1] * W), np = 4 * (p[0] + p[1] * W);
    if (inverse) out.set(img.data.slice(np, np + 4), op);
    else out.set(img.data.slice(op, op + 4), np);
  }
  return out;
}

step('小番茄：曲线确实把每个像素恰好走一遍', () => {
  const sizes = [[1, 1], [2, 2], [2, 3], [3, 3], [5, 5], [1, 7], [7, 1], [3, 5], [10, 4], [16, 16]];
  for (const wh of sizes) {
    const w = wh[0], h = wh[1];
    const c = m.gilbertCurve(w, h);
    if (c.length !== w * h * 2) throw new Error(w + 'x' + h + ' 点数不对：' + (c.length / 2));
    const seen = new Set();
    for (let i = 0; i < c.length; i += 2) {
      const x = c[i], y = c[i + 1];
      if (x < 0 || x >= w || y < 0 || y >= h) throw new Error(w + 'x' + h + ' 越界：' + x + ',' + y);
      seen.add(x + ',' + y);
    }
    if (seen.size !== w * h) throw new Error(w + 'x' + h + ' 有重复或遗漏');
  }
});

step('小番茄：可逆（含不能整除、非方形、极小）', () => {
  const sizes = [[1, 1], [2, 2], [3, 5], [37, 53], [64, 64], [100, 70]];
  for (const wh of sizes) {
    const w = wh[0], h = wh[1];
    const img = makeImage(w, h, w * 7 + h);
    const sc = m.tomato(img);
    if (sc.length !== img.data.length) throw new Error(w + 'x' + h + ' 尺寸变了');
    /* 单像素图的例外：n=1 时移位量 round(0.618) % 1 = 0，置换退化成自映射，
       图当然不变。这是数学必然，不是 bug。n>=2 就一定会变。 */
    if (w * h > 1 && same(sc, img.data)) throw new Error(w + 'x' + h + ' 混淆了但图没变');
    const back = m.untomato({ data: sc, width: w, height: h });
    if (!same(back, img.data)) throw new Error(w + 'x' + h + ' 还原不回来');
  }
});

step('小番茄：和原版算法逐字节一致', () => {
  const sizes = [[16, 16], [37, 53], [23, 11]];
  for (const wh of sizes) {
    const w = wh[0], h = wh[1];
    const img = makeImage(w, h, w + h * 3);
    const mine = m.tomato(img);
    const theirs = refTomato(img, false);
    if (!same(mine, theirs)) throw new Error(w + 'x' + h + ' 混淆结果和原版不一样');
    const mineBack = m.untomato(img);
    const theirsBack = refTomato(img, true);
    if (!same(mineBack, theirsBack)) throw new Error(w + 'x' + h + ' 解混淆结果和原版不一样');
  }
});

step('小番茄：两边能互解（原版混的这里能解，这里混的原版能解）', () => {
  const img = makeImage(48, 32, 4242);
  /* 原版混淆 → 我们解 */
  const theirs = refTomato(img, false);
  const back1 = m.untomato({ data: theirs, width: 48, height: 32 });
  if (!same(back1, img.data)) throw new Error('原版混淆出来的图，这里解不回来');
  /* 我们混淆 → 原版解 */
  const mine = m.tomato(img);
  const back2 = refTomato({ data: mine, width: 48, height: 32 }, true);
  if (!same(back2, img.data)) throw new Error('这里混淆出来的图，原版解不回来');
});

step('小番茄：连混两次不等于没混（移位不是自逆的）', () => {
  const img = makeImage(32, 32, 77);
  const once = m.tomato(img);
  const twice = m.tomato({ data: once, width: 32, height: 32 });
  if (same(twice, img.data)) throw new Error('连混两次就回来了，说明移位量挑得太凑巧');
  /* 但连解两次也不该回来 */
  const undo = m.untomato({ data: m.untomato({ data: twice, width: 32, height: 32 }), width: 32, height: 32 });
  if (!same(undo, img.data)) throw new Error('连混两次再连解两次应该还原');
});

step('小番茄：图数据不完整时明确报错', () => {
  let msg = '';
  try { m.tomato({ data: new Uint8ClampedArray(4), width: 8, height: 8 }); }
  catch (e) { msg = e.message; }
  if (!msg) throw new Error('数据不够却不报错');
});

/* ---------------------------------------------------------------- 嵌套 */

step('嵌套：容量内能逐像素无损取回', () => {
  const cover = makeImage(512, 512, 41);
  const secret = makeImage(128, 128, 42);
  const out = m.embed(cover, secret, 'k1');
  if (out.width !== 512 || out.height !== 512) throw new Error('输出尺寸该跟掩护图一致');
  const got = m.extract({ data: out.data, width: 512, height: 512 }, 'k1');
  if (got.width !== 128 || got.height !== 128) {
    throw new Error('取回的尺寸不对：' + got.width + 'x' + got.height);
  }
  for (let i = 0; i < 128 * 128; i++) {
    for (let c = 0; c < 3; c++) {
      if (got.data[i * 4 + c] !== secret.data[i * 4 + c]) {
        throw new Error('第 ' + i + ' 个像素的第 ' + c + ' 个通道对不上');
      }
    }
  }
});

step('嵌套：掩护图只有最低位被动过（高七位必须原样）', () => {
  const cover = makeImage(256, 256, 51);
  const secret = makeImage(64, 64, 52);
  const out = m.embed(cover, secret, 'k');
  let bad = 0;
  for (let i = 0; i < cover.data.length; i++) {
    if ((cover.data[i] & 0xfe) !== (out.data[i] & 0xfe)) bad++;
  }
  if (bad) throw new Error(bad + ' 个字节的高七位被改了 —— 那样肉眼看得出掩护图被动过');
});

step('嵌套：alpha 通道一个字节都不碰', () => {
  const cover = makeImage(128, 128, 55);
  const out = m.embed(cover, makeImage(32, 32, 56), 'k');
  for (let i = 3; i < cover.data.length; i += 4) {
    if (cover.data[i] !== out.data[i]) throw new Error('第 ' + i + ' 个 alpha 被改了');
  }
});

step('嵌套：秘密图太大时等比缩放，报告里说清楚', () => {
  const cover = makeImage(256, 256, 61);
  const secret = makeImage(400, 400, 62);
  const out = m.embed(cover, secret, 'k');
  if (!out.report.scaled) throw new Error('缩了却没在报告里说');
  if (out.report.secretW * out.report.secretH > out.report.capacity) {
    throw new Error('缩完还是超容量');
  }
  if (out.report.srcW !== 400 || out.report.srcH !== 400) throw new Error('报告里没记原尺寸');
  const got = m.extract({ data: out.data, width: 256, height: 256 }, 'k');
  if (got.width !== out.report.secretW || got.height !== out.report.secretH) {
    throw new Error('取回的尺寸和报告对不上');
  }
});

step('嵌套：密钥不对就报签名错，不吐一堆垃圾', () => {
  const cover = makeImage(128, 128, 71);
  const out = m.embed(cover, makeImage(32, 32, 72), 'right');
  let msg = '';
  try { m.extract({ data: out.data, width: 128, height: 128 }, 'wrong'); }
  catch (e) { msg = e.message; }
  if (!msg) throw new Error('错密钥居然没报错');
  if (msg.indexOf('Signature mismatch') < 0) throw new Error('报错信息没说清是签名问题：' + msg);
});

step('嵌套：从没藏东西的普通图里提取会明确失败', () => {
  const plain = makeImage(128, 128, 81);
  let msg = '';
  try { m.extract(plain, 'k'); } catch (e) { msg = e.message; }
  if (!msg) throw new Error('从普通图里居然提取成功了');
});

step('嵌套：掩护图太小会明确报错', () => {
  let msg = '';
  try { m.embed(makeImage(4, 4, 1), makeImage(8, 8, 2), 'k'); } catch (e) { msg = e.message; }
  if (!msg) throw new Error('这么小的掩护图居然没报错');
  if (msg.indexOf('too small') < 0) throw new Error('报错没说是容量问题：' + msg);
});

step('容量换算对得上', () => {
  /* 512x512 每个像素 3 位，去掉 12 字节头部 */
  const expect = Math.floor((512 * 512 * 3 - 96) / 24);
  if (m.capacity(512, 512) !== expect) throw new Error(m.capacity(512, 512) + ' vs ' + expect);
  if (m.capacity(2, 2) !== 0) throw new Error('这么小的图容量该是 0');
});

step('resample：同尺寸原样返回，缩小时不越界', () => {
  const src2 = makeImage(64, 64, 91);
  if (!same(m.resample(src2.data, 64, 64, 64, 64), src2.data)) throw new Error('同尺寸居然变了');
  const half = m.resample(src2.data, 64, 64, 16, 16);
  if (half.length !== 16 * 16 * 4) throw new Error('输出长度不对：' + half.length);
  for (let i = 0; i < half.length; i++) {
    if (!(half[i] >= 0 && half[i] <= 255)) throw new Error('越界：' + half[i]);
  }
});

/* ---------------------------------------------------------------- 密钥串 */

step('密钥串：往返一致，换成 URL 安全字符，坏串返回 null', () => {
  const t = m.makeTicket({ v: 1, mode: 'scramble', w: 1024, h: 768, bs: 64, sum: 123456 });
  const back = m.readTicket(t);
  if (!back || back.mode !== 'scramble' || back.w !== 1024 || back.sum !== 123456) {
    throw new Error('往返丢了信息');
  }
  if (t.indexOf('+') >= 0 || t.indexOf('/') >= 0 || t.indexOf('=') >= 0) {
    throw new Error('base64 里的 + / = 没换成安全字符，复制粘贴会出事');
  }
  if (m.readTicket('随便一串') !== null) throw new Error('没有前缀的串该返回 null');
  if (m.readTicket('M8K1.@@@@') !== null) throw new Error('坏 base64 该返回 null');

  /* 中文内容也要能往返 */
  const t2 = m.makeTicket({ note: '樱花粉' });
  const b2 = m.readTicket(t2);
  if (!b2 || b2.note !== '樱花粉') throw new Error('中文没往返回来');
});

console.log('');
if (fails.length) {
  console.log('混淆图实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('混淆图实跑检查：全部通过');
}
