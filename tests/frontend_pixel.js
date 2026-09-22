/* ============================================================================
 * M8web · 像素风转化的实跑检查
 *
 * 算法全是纯函数，测试直接造像素喂它。
 *
 * 最值钱的两条不变量：
 *   1. 纯色图经过任何一步都该还是那个纯色（能一口气抓出边界、取整、补零的错）
 *   2. 最近邻放大之后，每个放大块内部颜色必须完全一致（这是像素画的定义）
 *
 * 用法：node tests/frontend_pixel.js
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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
    data[i * 4 + 3] = 255;
  }
  return { data: data, width: w, height: h };
}

function solid(w, h, r, g, b) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
  }
  return { data: data, width: w, height: h };
}

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function isSolid(pixels, r, g, b, tol) {
  const t = tol === undefined ? 0 : tol;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i] - r) > t) return false;
    if (Math.abs(pixels[i + 1] - g) > t) return false;
    if (Math.abs(pixels[i + 2] - b) > t) return false;
  }
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

const src = fs.readFileSync(path.join(ROOT, 'M8web/assets/js/pixel.js'), 'utf8');
const m = new Function(src + '\n;return M8Pixel;')();

/* ---------------------------------------------------------------- 卷积 */

step('卷积：核都是归一化的（和等于 1）', () => {
  for (const k of [m.BOX3, m.GAUSS5]) {
    let s = 0;
    for (let i = 0; i < k.length; i++) s += k[i];
    if (Math.abs(s - 1) > 1e-9) throw new Error('核没归一化，和是 ' + s);
  }
});

step('卷积：尺寸不变，纯色图还是那个纯色', () => {
  const img = solid(16, 12, 200, 100, 50);
  for (const pair of [[m.BOX3, 1], [m.GAUSS5, 2]]) {
    const out = m.blur(img.data, 16, 12, pair[0], pair[1]);
    if (out.length !== img.data.length) throw new Error('尺寸变了');
    if (!isSolid(out, 200, 100, 50, 0.01)) throw new Error('纯色被卷积弄脏了');
  }
});

step('卷积：一个亮点会被摊成 3x3 的九分之一', () => {
  /* 5x5 全黑，正中间点亮。均值 3x3 两次一维过完，
     能量应该均匀摊在中心那 3x3 上，每格 255/9。 */
  const W = 5, H = 5;
  const data = new Uint8ClampedArray(W * H * 4);
  const c = (2 * W + 2) * 4;
  data[c] = 255; data[c + 1] = 255; data[c + 2] = 255; data[c + 3] = 255;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const out = m.blur(data, W, H, m.BOX3, 1);
  const expect = 255 / 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const o = ((2 + dy) * W + (2 + dx)) * 4;
      if (Math.abs(out[o] - expect) > 0.5) {
        throw new Error('中心 (' + dx + ',' + dy + ') 是 ' + out[o] + '，该是 ' + expect);
      }
    }
  }
  /* 再往外一圈必须还是 0 */
  const corner = (0 * W + 0) * 4;
  if (Math.abs(out[corner]) > 0.5) throw new Error('角落不该有能量，实际 ' + out[corner]);
});

step('卷积：边界用 clamp，图边不会发暗', () => {
  /* 整图同一个亮度的水平条纹，横卷之后边缘仍该是同值 */
  const W = 8, H = 4;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 250; data[i * 4 + 1] = 250; data[i * 4 + 2] = 250; data[i * 4 + 3] = 255;
  }
  const out = m.blur(data, W, H, m.GAUSS5, 2);
  if (!isSolid(out, 250, 250, 250, 0.01)) throw new Error('边缘发暗了，说明边界补的是 0 不是 clamp');
});

step('锐化：纯色图不该被锐化出噪声', () => {
  const img = solid(12, 12, 90, 140, 200);
  const out = m.unsharp(img.data, 12, 12, 0.6);
  if (!isSolid(out, 90, 140, 200, 0)) throw new Error('纯色被锐化出东西来了');
});

step('锐化：确实把对比拉开了', () => {
  /* 拿一条硬边来锐化。注意不能先模糊再锐化 —— 对已经平滑的图做 unsharp，
     本来就没多少可拉的（第一版就是这么写的，红了一条，是测试的问题不是代码的）。 */
  const W = 16, H = 16;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      const v = x < W / 2 ? 60 : 200;
      data[o] = v; data[o + 1] = v; data[o + 2] = v; data[o + 3] = 255;
    }
  }
  const after = m.unsharp(data, W, H, 1.0);
  const li = (8 * W + 7) * 4, ri = (8 * W + 8) * 4;
  const d0 = data[ri] - data[li];
  const d1 = after[ri] - after[li];
  if (!(d1 > d0)) throw new Error('锐化之后对比反而更小：' + d0 + ' -> ' + d1);
});

/* ---------------------------------------------------------------- 降维 */

step('降维：尺寸是向上取整，块不满也照样出格子', () => {
  const cases = [[100, 70, 32, 4, 3], [16, 16, 4, 4, 4], [10, 3, 4, 3, 1], [1, 1, 8, 1, 1]];
  for (const c of cases) {
    const r = m.downsample(new Uint8ClampedArray(c[0] * c[1] * 4), c[0], c[1], c[2]);
    if (r.width !== c[3] || r.height !== c[4]) {
      throw new Error(c.join('/') + ' 得到 ' + r.width + 'x' + r.height);
    }
  }
});

step('降维：纯色图降完还是那个色（边缘那个不满的块也是）', () => {
  const img = solid(100, 70, 33, 66, 99);
  const r = m.downsample(img.data, 100, 70, 32);
  if (!isSolid(r.data, 33, 66, 99, 0.01)) {
    throw new Error('边缘不满尺寸的块把颜色带偏了 —— 多半是按块面积除而不是按实际像素数除');
  }
});

step('降维：2x2 块的结果就是那四个像素的平均', () => {
  const W = 4, H = 4, bs = 2;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = i * 16; data[i * 4 + 3] = 255;
  }
  const r = m.downsample(data, W, H, bs);
  /* 左上那块是 0、1、4、5 号像素 */
  const expect = (0 * 16 + 1 * 16 + 4 * 16 + 5 * 16) / 4;
  if (Math.abs(r.data[0] - expect) > 0.01) {
    throw new Error('得到 ' + r.data[0] + '，该是 ' + expect);
  }
});

/* ---------------------------------------------------------------- 减色 */

step('减色：输出值全都落在台阶上', () => {
  const img = makeImage(32, 32, 5);
  const lv = 8;
  const stepv = 255 / (lv - 1);
  const out = m.quantize(img.data, lv);
  for (let i = 0; i < out.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = out[i + c];
      /* 容差得给到 0.5：台阶本身是小数（255/7 ≈ 36.43），
         最后一步 Math.round 落到整数上，必然偏一点。73 就是 2×36.43 取整的结果。 */
      if (Math.abs(v - Math.round(v / stepv) * stepv) > 0.5) {
        throw new Error('值 ' + v + ' 不在台阶上');
      }
    }
  }
});

step('减色：alpha 一个字节都不动', () => {
  const img = makeImage(16, 16, 7);
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = i % 256;
  const out = m.quantize(img.data, 4);
  for (let i = 3; i < img.data.length; i += 4) {
    if (out[i] !== img.data[i]) throw new Error('alpha 被改了');
  }
});

step('减色：levels=2 时只剩几档', () => {
  const img = makeImage(32, 32, 9);
  const out = m.quantize(img.data, 2);
  const seen = new Set();
  for (let i = 0; i < out.length; i += 4) seen.add(out[i]);
  if (seen.size > 2) throw new Error('2 档却出现了 ' + seen.size + ' 种值');
});

step('抖动：值也在台阶上，但和直接减色不是一回事', () => {
  const img = makeImage(32, 32, 11);
  const lv = 8;
  const stepv = 255 / (lv - 1);
  const a = m.quantize(img.data, lv);
  const b = m.dither(img.data, 32, 32, lv);
  for (let i = 0; i < b.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = b[i + c];
      if (Math.abs(v - Math.round(v / stepv) * stepv) > 0.5) throw new Error('抖动后有一个值脱了台阶');
    }
  }
  if (same(a, b)) throw new Error('抖动开着和关着结果一样，那这个开关是假的');
});

step('抖动：矩阵是 4x4 的 0..15 各一次', () => {
  const seen = new Set();
  for (let i = 0; i < m.BAYER4.length; i++) seen.add(m.BAYER4[i]);
  if (m.BAYER4.length !== 16 || seen.size !== 16) throw new Error('Bayer 矩阵不合法');
  for (let v = 0; v < 16; v++) if (!seen.has(v)) throw new Error('少了 ' + v);
});

/* ---------------------------------------------------------------- 放大 */

step('最近邻放大：每个放大块内部颜色完全一致', () => {
  const img = makeImage(4, 3, 13);
  const out = m.scaleNearest(img.data, 4, 3, 16, 12);   /* 放大 4 倍 */
  const zoom = 4, TW = 16;
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 16; x++) {
      const s = (Math.floor(y / zoom) * 4 + Math.floor(x / zoom)) * 4;
      const d = (y * TW + x) * 4;
      for (let c = 0; c < 4; c++) {
        if (out[d + c] !== img.data[s + c]) throw new Error('(' + x + ',' + y + ') 与源像素不一致');
      }
    }
  }
});

step('最近邻放大：不插值 —— 源图里没有的颜色不许出现', () => {
  const img = solid(2, 2, 10, 20, 30);
  const out = m.scaleNearest(img.data, 2, 2, 20, 20);
  if (!isSolid(out, 10, 20, 30, 0)) throw new Error('出现了插值色，那就不是最近邻了');
});

/* ---------------------------------------------------------------- 主流程 */

step('主流程：输出尺寸 = 像素尺寸 × 放大倍数', () => {
  const img = makeImage(100, 70, 17);
  const r = m.toPixelArt(img, { block: 10, zoom: 1, style: 'clean' });
  const pw = Math.ceil(100 / 10), ph = Math.ceil(70 / 10);
  if (r.width !== pw || r.height !== ph) throw new Error('zoom=1 时得到 ' + r.width + 'x' + r.height);
  const r2 = m.toPixelArt(img, { block: 10, zoom: 4, style: 'clean' });
  if (r2.width !== pw * 4 || r2.height !== ph * 4) throw new Error('zoom=4 时尺寸不对');
  if (r2.report.pixelW !== pw || r2.report.pixelH !== ph) throw new Error('报告里的像素尺寸不对');
});

step('主流程：纯色图出来还是那个纯色（四种风格都不许弄脏）', () => {
  const img = solid(64, 48, 210, 30, 90);
  for (const style of m.STYLES) {
    for (const zoom of [1, 4]) {
      const r = m.toPixelArt(img, { block: 8, zoom: zoom, style: style, levels: 0 });
      if (!isSolid(r.data, 210, 30, 90, 0.51)) {
        throw new Error(style + ' / zoom ' + zoom + ' 把纯色弄脏了');
      }
    }
  }
});

step('主流程：放大之后每个像素块内部一致（这是像素画的定义）', () => {
  const img = makeImage(48, 32, 19);
  const r = m.toPixelArt(img, { block: 4, zoom: 5, style: 'standard', levels: 0 });
  /* 块的左上角：块号要乘回块尺寸才是它在输出里的起点。
     第一版拿 pixelW 当行距，第二版又只把块号当坐标，两次都错位，改对的是测试。 */
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const bx = Math.floor(x / 5) * 5;
      const by = Math.floor(y / 5) * 5;
      const base = (by * r.width + bx) * 4;
      const o = (y * r.width + x) * 4;
      if (o !== base) {
        for (let c = 0; c < 4; c++) {
          if (r.data[o + c] !== r.data[base + c]) {
            throw new Error('(' + x + ',' + y + ') 和它所在的那个块颜色不一样');
          }
        }
      }
    }
  }
});

step('主流程：减色之后颜色种类真的少了', () => {
  const img = makeImage(64, 64, 23);
  const free = m.toPixelArt(img, { block: 4, zoom: 1, style: 'clean', levels: 0 });
  const few = m.toPixelArt(img, { block: 4, zoom: 1, style: 'clean', levels: 4 });
  const count = (p) => {
    const s = new Set();
    for (let i = 0; i < p.length; i += 4) s.add(p[i] + ',' + p[i + 1] + ',' + p[i + 2]);
    return s.size;
  };
  const cf = count(free.data), cfew = count(few.data);
  if (!(cfew < cf)) throw new Error('减色后颜色没变少：' + cf + ' -> ' + cfew);
  if (cfew > 4 * 4 * 4) throw new Error('每通道 4 档，最多 64 种，实际 ' + cfew);
});

step('主流程：四种风格的卷积确实走出了不同结果', () => {
  const img = makeImage(64, 64, 29);
  const outs = m.STYLES.map((s) => m.toPixelArt(img, { block: 8, zoom: 1, style: s, levels: 0 }).data);
  for (let i = 0; i < outs.length; i++) {
    for (let j = i + 1; j < outs.length; j++) {
      if (same(outs[i], outs[j])) {
        throw new Error(m.STYLES[i] + ' 和 ' + m.STYLES[j] + ' 结果一模一样');
      }
    }
  }
});

step('主流程：块大小真的控制像素数', () => {
  const img = makeImage(96, 96, 31);
  const a = m.toPixelArt(img, { block: 4, zoom: 1, style: 'clean' });
  const b = m.toPixelArt(img, { block: 16, zoom: 1, style: 'clean' });
  if (a.report.pixelW !== 24 || a.report.pixelH !== 24) throw new Error('block=4 该是 24x24');
  if (b.report.pixelW !== 6 || b.report.pixelH !== 6) throw new Error('block=16 该是 6x6');
});

step('主流程：参数越界会被夹住，不炸', () => {
  const img = makeImage(32, 32, 37);
  const r1 = m.toPixelArt(img, { block: 0, zoom: 0, style: '没有这个', levels: -5 });
  if (!r1.width || !r1.height) throw new Error('夹出来是空的');
  const r2 = m.toPixelArt(img, { block: 9999, zoom: 9999 });
  if (!r2.width || !r2.height) throw new Error('上限没夹住');
  const r3 = m.toPixelArt(solid(1, 1, 5, 6, 7), {});
  if (r3.width < 1 || r3.height < 1) throw new Error('1x1 输入炸了');
});

step('主流程：图数据不完整时明确报错', () => {
  let msg = '';
  try { m.toPixelArt({ data: new Uint8ClampedArray(4), width: 8, height: 8 }, {}); }
  catch (e) { msg = e.message; }
  if (!msg) throw new Error('数据不够却不报错');
});

console.log('');
if (fails.length) {
  console.log('像素风转化实跑检查：' + fails.length + ' 个失败');
  fails.forEach((f) => console.log('  * ' + f));
  process.exitCode = 1;
} else {
  console.log('像素风转化实跑检查：全部通过');
}
