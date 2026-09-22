/* ============================================================================
 * M8web · 混淆图（算法层）
 *
 * 两种模式，都是可逆的 —— 混淆完能原样解回来：
 *
 *   置乱（scramble）：把图按块打乱，块内像素再打散一遍。看着是乱码，一个字节不丢。
 *   嵌套（nest）：把一张秘密图塞进掩护图的低位。表面看还是掩护图，里面藏着另一张。
 *
 * 为什么能解回来：两种模式都只用了「置换」和「异或」这两类可逆运算，
 * 密钥决定具体的置换表和密钥流。同一个密钥 → 同一套表 → 逆着走一遍就还原。
 *
 * 尺寸规矩：
 *   置乱前后尺寸完全不变（块是跟着图切的，不是把图 padding 到整数倍再裁 —— 那样
 *   补零的像素会被搅进结果里，就不是无损了）。
 *   嵌套输出的是掩护图的尺寸；秘密图放不下时按面积等比缩，缩了多少写在报告里。
 *
 * 一条硬要求：混淆图必须存成 PNG。JPEG 有损，恰好会把低位压掉 ——
 * 低位正是嵌套藏东西的地方，压过之后谁都还原不了。
 *
 * 这一层是纯函数，不碰 DOM，测试直接拿字节喂它。
 * ==========================================================================*/

const M8Obfuscate = (() => {
  "use strict";

  /* ------------------------------------------------------------ 字节与密钥 */

  function utf8Bytes(str) {
    const s = String(str == null ? "" : str);
    if (typeof TextEncoder === "function") return new TextEncoder().encode(s);
    /* 老环境兜底：手写一份，只管 BMP（够用，密钥本来就是人随手打的几个字） */
    const out = [];
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function utf8Text(bytes) {
    if (typeof TextDecoder === "function") return new TextDecoder("utf-8").decode(bytes);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* FNV-1a。密钥转种子、像素算指纹都用它 —— 一套算法，省得两处各自出岔子。 */
  function fnv1a(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function keySeed(key) { return fnv1a(utf8Bytes(key)); }

  /* mulberry32：短、够均匀、结果可复现。
     不能用 Math.random —— 那个每次都不一样，还原就无从谈起。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Fisher-Yates。返回置换表：位置 i 拿原来 p[i] 那一份。 */
  function makePermutation(n, rng) {
    const p = new Int32Array(n);
    for (let i = 0; i < n; i++) p[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    return p;
  }

  function invertPermutation(p) {
    const q = new Int32Array(p.length);
    for (let i = 0; i < p.length; i++) q[p[i]] = i;
    return q;
  }

  function copyPixels(pixels) {
    const out = new Uint8ClampedArray(pixels.length);
    out.set(pixels);
    return out;
  }

  /* ------------------------------------------------------------ 块的切法 */

  /* 按块大小切网格。最后一行 / 一列可能不满，各自记下真实尺寸。
     置换只在「同尺寸」的块之间做（见 groupBySize）—— 这样搬运不会越界，
     也不用把图 padding 到整数倍（补零的像素一旦被搅进来就不是无损了）。 */
  function blockGrid(W, H, bs) {
    const out = [];
    for (let y = 0; y < H; y += bs) {
      for (let x = 0; x < W; x += bs) {
        out.push({ x: x, y: y, w: Math.min(bs, W - x), h: Math.min(bs, H - y) });
      }
    }
    return out;
  }

  /* 按 w x h 分组，返回每组的块下标 */
  function groupBySize(blocks) {
    const map = {};
    const keys = [];
    blocks.forEach(function (b, i) {
      const k = b.w + "x" + b.h;
      if (!map[k]) { map[k] = []; keys.push(k); }
      map[k].push(i);
    });
    return keys.map(function (k) { return map[k]; });
  }

  /* 把一个块的内容搬到另一个块。两块尺寸必然相同（调用方按尺寸分过组）。 */
  function copyBlock(src, dst, from, to, W) {
    const rowBytes = src.w * 4;
    for (let r = 0; r < src.h; r++) {
      const s = ((src.y + r) * W + src.x) * 4;
      const d = ((dst.y + r) * W + dst.x) * 4;
      for (let c = 0; c < rowBytes; c++) to[d + c] = from[s + c];
    }
  }

  function moveBlocks(pixels, W, blocks, groups, perms, inverse) {
    const out = copyPixels(pixels);
    groups.forEach(function (idx, g) {
      const map = inverse ? invertPermutation(perms[g]) : perms[g];
      for (let i = 0; i < idx.length; i++) {
        copyBlock(blocks[idx[map[i]]], blocks[idx[i]], pixels, out, W);
      }
    });
    return out;
  }

  /* 块内打散。只把块搬家的话，大色块的图还能看出轮廓；每个块内的像素再洗一遍
     才是真乱码。种子跟块的位置绑定 —— 还原时同一个位置必须用同一张表。 */
  function shuffleInside(block, from, to, W, seedBase, inverse) {
    const n = block.w * block.h;
    const seed = (seedBase ^ Math.imul(block.x * 8191 + block.y * 131 + 1, 0x9e3779b1)) >>> 0;
    const perm = makePermutation(n, mulberry32(seed));
    const map = inverse ? invertPermutation(perm) : perm;

    /* 先整体读到临时数组再写回，否则会自己覆盖自己 */
    const tmp = new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i++) {
      const px = block.x + (i % block.w);
      const py = block.y + Math.floor(i / block.w);
      const off = (py * W + px) * 4;
      tmp[i * 4] = from[off];
      tmp[i * 4 + 1] = from[off + 1];
      tmp[i * 4 + 2] = from[off + 2];
      tmp[i * 4 + 3] = from[off + 3];
    }
    for (let i = 0; i < n; i++) {
      const s = map[i] * 4;
      const px = block.x + (i % block.w);
      const py = block.y + Math.floor(i / block.w);
      const off = (py * W + px) * 4;
      to[off] = tmp[s];
      to[off + 1] = tmp[s + 1];
      to[off + 2] = tmp[s + 2];
      to[off + 3] = tmp[s + 3];
    }
  }

  function shuffleAllBlocks(pixels, W, blocks, seedBase, inverse) {
    const out = copyPixels(pixels);
    /* 每个块只碰自己那点像素，块之间互不干扰，所以顺序无所谓 */
    for (let i = 0; i < blocks.length; i++) {
      shuffleInside(blocks[i], pixels, out, W, seedBase, inverse);
    }
    return out;
  }

  /* ------------------------------------------------------------ 置乱主流程 */

  const MIN_BLOCK = 2;
  const MAX_BLOCK = 512;

  function normalizeBlock(v) {
    const n = Math.round(Number(v) || 64);
    return Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, n));
  }

  /* direction = 1 混淆，-1 还原。返回新的像素数组，尺寸不变。
     两种方向都只做置换，所以整个过程严格可逆、一个字节不丢。
     顺带一提：块大小设得比图还大的时候，块间置换会退化成恒等（只有一个块），
     那会儿起作用的只剩块内打散 —— 两种参数都能出乱码，只是长相不同。 */
  function scramblePass(pixels, W, H, opts, direction) {
    if (!W || !H || !pixels || pixels.length < W * H * 4) {
      throw new Error("图片数据不完整");
    }
    const bs = normalizeBlock(opts && opts.blockSize);
    const usePixels = !(opts && opts.shufflePixels === false);
    const key = (opts && opts.key) || "";
    const blocks = blockGrid(W, H, bs);
    const groups = groupBySize(blocks);

    /* 每组顺序取置换。取用顺序必须写死，否则还原时复现不出同一套表。 */
    const rng = mulberry32(keySeed(key));
    const perms = groups.map(function (idx) { return makePermutation(idx.length, rng); });

    let cur = pixels;
    if (direction === 1) {
      if (usePixels) cur = shuffleAllBlocks(cur, W, blocks, keySeed(key), false);
      cur = moveBlocks(cur, W, blocks, groups, perms, false);
    } else {
      cur = moveBlocks(cur, W, blocks, groups, perms, true);
      if (usePixels) cur = shuffleAllBlocks(cur, W, blocks, keySeed(key), true);
    }
    return cur;
  }

  function scramble(image, opts) {
    return scramblePass(image.data, image.width, image.height, opts, 1);
  }

  function unscramble(image, opts) {
    return scramblePass(image.data, image.width, image.height, opts, -1);
  }

  /* 结果的指纹。密钥串里带上它，解混淆时先比一下 ——
     密钥串不是配这张图的当场就说清楚，省得用户对着乱码猜。 */
  function fingerprint(pixels) { return fnv1a(pixels); }

  /* ------------------------------------------------------------ 小番茄混淆 */

  /* 沿 Gilbert 曲线把整条像素序列循环移位一个固定量：黄金分割比 × 像素总数，取整。
     没有密钥 —— 这一条是刻意的，为了和梦羽小番茄原来那个 HTML 工具两边能互解：
     它混淆出来的图这里能解，这里混淆出来的它也能解。所以一个字的参数都别改。 */

  const GOLDEN = (Math.sqrt(5) - 1) / 2;

  /* 原版那两段递归一字未改，只把「往数组里 push 一个 [x, y]」换成写进 Int32Array：
     原版对 1024×1024 要现场建 100 万个两元素数组，又慢又占内存。
     交错存放 —— curve[2i] 是 x，curve[2i+1] 是 y。 */
  function gilbertCurve(W, H) {
    const out = new Int32Array(W * H * 2);
    let k = 0;

    function generate2d(x, y, ax, ay, bx, by) {
      const w = Math.abs(ax + ay);
      const h = Math.abs(bx + by);

      const dax = Math.sign(ax), day = Math.sign(ay);
      const dbx = Math.sign(bx), dby = Math.sign(by);

      if (h === 1) {
        for (let i = 0; i < w; i++) { out[k++] = x; out[k++] = y; x += dax; y += day; }
        return;
      }
      if (w === 1) {
        for (let i = 0; i < h; i++) { out[k++] = x; out[k++] = y; x += dbx; y += dby; }
        return;
      }

      let ax2 = Math.floor(ax / 2), ay2 = Math.floor(ay / 2);
      let bx2 = Math.floor(bx / 2), by2 = Math.floor(by / 2);

      const w2 = Math.abs(ax2 + ay2);
      const h2 = Math.abs(bx2 + by2);

      if (2 * w > 3 * h) {
        if ((w2 % 2) && (w > 2)) { ax2 += dax; ay2 += day; }
        generate2d(x, y, ax2, ay2, bx, by);
        generate2d(x + ax2, y + ay2, ax - ax2, ay - ay2, bx, by);
      } else {
        if ((h2 % 2) && (h > 2)) { bx2 += dbx; by2 += dby; }
        generate2d(x, y, bx2, by2, ax2, ay2);
        generate2d(x + bx2, y + by2, ax, ay, bx - bx2, by - by2);
        generate2d(x + (ax - dax) + (bx2 - dbx), y + (ay - day) + (by2 - dby),
          -bx2, -by2, -(ax - ax2), -(ay - ay2));
      }
    }

    if (W >= H) generate2d(0, 0, W, 0, 0, H);
    else generate2d(0, 0, 0, H, W, 0);
    return out;
  }

  /* inverse = false 混淆（i 处的像素搬到 i+off），true 还原（搬回来）。
     i → (i+off) % n 是双射，所以每个像素位置恰好被写一次，不留空洞。 */
  function tomatoShift(image, inverse) {
    const W = image.width, H = image.height;
    const n = W * H;
    if (!n || !image.data || image.data.length < n * 4) {
      throw new Error("图片数据不完整");
    }
    const curve = gilbertCurve(W, H);
    const off = Math.round(GOLDEN * n) % n;
    const src = image.data;
    const out = new Uint8ClampedArray(src.length);

    for (let i = 0; i < n; i++) {
      const a = i * 2;
      const b = ((i + off) % n) * 2;
      const pa = (curve[a] + curve[a + 1] * W) * 4;
      const pb = (curve[b] + curve[b + 1] * W) * 4;
      if (inverse) {
        out[pa] = src[pb]; out[pa + 1] = src[pb + 1];
        out[pa + 2] = src[pb + 2]; out[pa + 3] = src[pb + 3];
      } else {
        out[pb] = src[pa]; out[pb + 1] = src[pa + 1];
        out[pb + 2] = src[pa + 2]; out[pb + 3] = src[pa + 3];
      }
    }
    return out;
  }

  function tomato(image) { return tomatoShift(image, false); }
  function untomato(image) { return tomatoShift(image, true); }

  /* ------------------------------------------------------------ 嵌套（低位） */

  const HEAD_BYTES = 12;
  const MAGIC = [0x4d, 0x38, 0x48, 0x31];   /* "M8H1" */

  /* 掩护图每个像素让出 R/G/B 各一个低位 → 3 位/像素。
     头部 12 字节固定，剩下的全给秘密像素（一像素写 R/G/B 三字节）。 */
  function capacity(W, H) {
    const usable = W * H * 3 - HEAD_BYTES * 8;
    if (usable <= 0) return 0;
    return Math.floor(usable / 24);
  }

  /* 面积平均缩放。纯算术，不依赖 canvas —— 那样 Node 里也跑得出一样的结果。
     缩小时不会出锯齿；放大时退化成最近邻（够用）。 */
  function resample(src, sw, sh, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.floor(y * sh / dh);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sh / dh));
      for (let x = 0; x < dw; x++) {
        const x0 = Math.floor(x * sw / dw);
        const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sw / dw));
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = y0; sy < y1 && sy < sh; sy++) {
          for (let sx = x0; sx < x1 && sx < sw; sx++) {
            const o = (sy * sw + sx) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
            n++;
          }
        }
        const d = (y * dw + x) * 4;
        out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = a / n;
      }
    }
    return out;
  }

  /* 密钥流异或。同一密钥生成同一串，再异或一次就回来。 */
  function xorKeystream(bytes, key) {
    const rng = mulberry32((keySeed(key) ^ 0x5bf03635) >>> 0);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = bytes[i] ^ (Math.floor(rng() * 256) & 255);
    }
  }

  function writeLowBits(pixels, startBit, payload) {
    let bit = startBit;
    for (let i = 0; i < payload.length; i++) {
      const byte = payload[i];
      for (let b = 0; b < 8; b++) {
        const v = (byte >> (7 - b)) & 1;
        const off = Math.floor(bit / 3) * 4 + (bit % 3);
        pixels[off] = (pixels[off] & 0xfe) | v;
        bit++;
      }
    }
    return bit;
  }

  function readLowBits(pixels, startBit, count) {
    const out = new Uint8Array(count);
    let bit = startBit;
    for (let i = 0; i < count; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) {
        const off = Math.floor(bit / 3) * 4 + (bit % 3);
        v = (v << 1) | (pixels[off] & 1);
        bit++;
      }
      out[i] = v;
    }
    return out;
  }

  /* 把秘密图藏进掩护图。返回的图跟掩护图同尺寸，只有低位被动过 ——
     高七位原样，所以肉眼看还是那张掩护图。 */
  function embed(cover, secret, key) {
    const W = cover.width, H = cover.height;
    const cap = capacity(W, H);
    if (cap <= 0) throw new Error("掩护图太小，连一个秘密像素都放不下");

    let sw = secret.width, sh = secret.height;
    const area = sw * sh;
    if (area > cap) {
      const k = Math.sqrt(cap / area);
      sw = Math.max(1, Math.floor(sw * k));
      sh = Math.max(1, Math.floor(sh * k));
      while (sw * sh > cap) { if (sw >= sh) sw--; else sh--; }
    }
    const scaled = (sw === secret.width && sh === secret.height)
      ? secret.data
      : resample(secret.data, secret.width, secret.height, sw, sh);

    const need = HEAD_BYTES + sw * sh * 3;
    if (need * 8 > W * H * 3) throw new Error("装不下：容量算错了");

    const payload = new Uint8Array(need);
    payload[0] = MAGIC[0]; payload[1] = MAGIC[1]; payload[2] = MAGIC[2]; payload[3] = MAGIC[3];
    payload[4] = sw & 255; payload[5] = (sw >> 8) & 255;
    payload[6] = sh & 255; payload[7] = (sh >> 8) & 255;
    let p = HEAD_BYTES;
    for (let i = 0; i < sw * sh; i++) {
      payload[p++] = scaled[i * 4];
      payload[p++] = scaled[i * 4 + 1];
      payload[p++] = scaled[i * 4 + 2];
    }
    /* 整段加密，连头部一起 —— 密钥不对时读出来是白噪声，
       不会露出「这图里藏了东西」的痕迹。 */
    xorKeystream(payload, key);

    const out = copyPixels(cover.data);
    writeLowBits(out, 0, payload);

    return {
      data: out, width: W, height: H,
      report: {
        coverW: W, coverH: H,
        secretW: sw, secretH: sh,
        srcW: secret.width, srcH: secret.height,
        scaled: sw !== secret.width || sh !== secret.height,
        capacity: cap, used: sw * sh,
      },
    };
  }

  /* 从藏了东西的图里把秘密图取回来 */
  function extract(hidden, key) {
    const W = hidden.width, H = hidden.height;
    if (capacity(W, H) <= 0) throw new Error("这张图太小，里面装不下东西");

    const head = readLowBits(hidden.data, 0, HEAD_BYTES);
    xorKeystream(head, key);
    if (head[0] !== MAGIC[0] || head[1] !== MAGIC[1] || head[2] !== MAGIC[2] || head[3] !== MAGIC[3]) {
      throw new Error("签名对不上：密钥不对，或者这张图里本来就没有藏东西");
    }
    const sw = head[4] | (head[5] << 8);
    const sh = head[6] | (head[7] << 8);
    if (sw < 1 || sh < 1) throw new Error("头部里的尺寸不合法");
    const need = HEAD_BYTES + sw * sh * 3;
    if (need * 8 > W * H * 3) throw new Error("头部声明的尺寸超出了这张图的容量");

    const payload = readLowBits(hidden.data, 0, need);
    xorKeystream(payload, key);

    const out = new Uint8ClampedArray(sw * sh * 4);
    let p = HEAD_BYTES;
    for (let i = 0; i < sw * sh; i++) {
      out[i * 4] = payload[p++];
      out[i * 4 + 1] = payload[p++];
      out[i * 4 + 2] = payload[p++];
      out[i * 4 + 3] = 255;
    }
    return {
      data: out, width: sw, height: sh,
      report: { coverW: W, coverH: H, secretW: sw, secretH: sh },
    };
  }

  /* ------------------------------------------------------------ 密钥串 */

  /* 一串能直接复制粘贴的文本，打包了解混淆要的一切：模式、尺寸、块大小、指纹。
     把它和解混淆的密钥一起粘回去，就不用靠人去记当时用了什么参数。 */
  const TICKET_PREFIX = "M8K1.";

  function b64encode(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    const b = (typeof btoa === "function") ? btoa(s) : "";
    return b.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64decode(str) {
    const p = String(str).replace(/-/g, "+").replace(/_/g, "/");
    const pad = p + "====".slice(0, (4 - (p.length % 4)) % 4);
    const s = atob(pad);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function makeTicket(info) {
    return TICKET_PREFIX + b64encode(utf8Bytes(JSON.stringify(info)));
  }

  function readTicket(text) {
    const s = String(text == null ? "" : text).trim();
    if (s.indexOf(TICKET_PREFIX) !== 0) return null;
    try {
      return JSON.parse(utf8Text(b64decode(s.slice(TICKET_PREFIX.length))));
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------ 界面 */

  /* 注意：infoCard / kv / copyButton 这几块和 lora.js 里那份是重复的。
     先各写各的（改动小、风险低），等第三个页面也要用的时候抽成一个公共 js。 */

  let el = {};
  let busy = false;
  let fileA = null;
  let fileB = null;
  let previewA = null;   /* {url, w, h}，拖拽区里那张缩略图 */
  let previewB = null;
  let mode = "tomato";   /* 默认是小番茄 —— 那是这个工具的原始形态 */
  let dir = "lock";

  function byId(id) { return document.getElementById(id); }

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function infoCard(title, tag) {
    const box = document.createElement("section");
    box.className = "info-card";
    const h = document.createElement("h2");
    h.textContent = title;
    if (tag) {
      const t = document.createElement("span");
      t.className = "info-tag";
      t.textContent = tag;
      h.appendChild(t);
    }
    box.appendChild(h);
    return box;
  }

  function kv(pairs) {
    const dl = document.createElement("dl");
    dl.className = "kv";
    pairs.forEach(function (p) {
      if (p[1] === undefined || p[1] === null || p[1] === "") return;
      const dt = document.createElement("dt");
      dt.textContent = p[0];
      const dd = document.createElement("dd");
      dd.textContent = String(p[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  }

  function copyButton(text, label) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost-btn";
    b.textContent = label || "复制";
    b.addEventListener("click", function () {
      copyText(text).then(function () { setStatus("复制好了。"); })
        .catch(function () { setStatus("复制没成功，手动选一下吧。", true); });
    });
    return b;
  }

  function copyText(text) {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (e) { reject(e); }
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error("没有选中文件")); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("这个文件读不出图片内容"));
      };
      img.src = url;
    });
  }

  /* 画布 ↔ 像素。上层算法只认 {data, width, height}，所以只在这两个函数里碰 canvas。 */
  function toImage(source) {
    const c = document.createElement("canvas");
    c.width = source.width;
    c.height = source.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0);
    return ctx.getImageData(0, 0, source.width, source.height);
  }

  function toURL(image) {
    const c = document.createElement("canvas");
    c.width = image.width;
    c.height = image.height;
    const ctx = c.getContext("2d");
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
    return c.toDataURL("image/png");
  }

  function baseName(file) {
    const n = (file && file.name) || "image";
    return n.replace(/\.[^.]+$/, "");
  }

  /* ------------------------------------------------------------ 界面状态 */

  function refresh() {
    const nest = mode === "nest";
    const tomato = mode === "tomato";
    const lock = dir === "lock";

    Array.prototype.forEach.call(el.mode.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-mode") === mode);
    });
    Array.prototype.forEach.call(el.dir.querySelectorAll("button"), function (b) {
      b.classList.toggle("is-on", b.getAttribute("data-dir") === dir);
    });

    /* 小番茄没有密钥 —— 那是算法本身的样子，不是漏做 */
    el.keyField.classList.toggle("is-hidden", tomato);
    el.tomatoNote.classList.toggle("is-hidden", !tomato);
    /* 块大小和块内打散只有置乱用得上 */
    el.blockField.classList.toggle("is-hidden", tomato || nest);
    el.pixelsField.classList.toggle("is-hidden", tomato || nest);
    /* 第二张图只有「嵌套 + 混淆」要 */
    el.second.classList.toggle("is-hidden", !(nest && lock));
    /* 密钥串只有「置乱 + 解混淆」要用户填 */
    el.ticketBox.classList.toggle("is-hidden", !(mode === "scramble" && !lock));

    el.dropLabel.textContent = nest
      ? (lock ? "掩护图（当封面的那张）" : "藏了图的图")
      : (lock ? "要混淆的图" : "混淆图");

    el.keyWarn.classList.toggle("is-hidden", tomato || !!el.key.value);
    el.go.textContent = lock ? (nest ? "藏进去" : "打乱") : "解回来";

    paintNames();
  }

  /* 选完文件后把缩略图和名字换进拖拽区 —— 只写个文件名的话，
     用户看不出自己选的对不对，传错图是最常见的失误。 */
  function paintNames() {
    const lock = dir === "lock";

    el.thumb1.classList.toggle("is-hidden", !previewA);
    el.ico1.classList.toggle("is-hidden", !!previewA);
    if (previewA) el.thumb1.src = previewA.url;
    el.drop.querySelector("strong").textContent = fileA
      ? fileA.name
      : "点击选择、拖进来，或者 Ctrl+V 粘贴";
    el.hint.textContent = previewA
      ? previewA.w + " × " + previewA.h
      : (lock ? "PNG / JPEG / WebP" : "把要解的图放进来");

    if (el.drop2) {
      el.thumb2.classList.toggle("is-hidden", !previewB);
      el.ico2.classList.toggle("is-hidden", !!previewB);
      if (previewB) el.thumb2.src = previewB.url;
      el.drop2.querySelector("strong").textContent = fileB
        ? fileB.name
        : "点击选择、拖进来，或者 Ctrl+V 粘贴";
      el.hint2.textContent = previewB
        ? previewB.w + " × " + previewB.h + "，会按容量自动缩放"
        : "会按容量自动缩放";
    }
  }

  /* 生成缩略图。图先缩到最长边 320 —— 原图动辄几千像素，
     直接把原图塞进 <img> 会让页面背着几十 MB 的位图。 */
  function makeThumb(file) {
    return loadImage(file).then(function (img) {
      const W = img.naturalWidth, H = img.naturalHeight;
      const k = Math.min(1, 320 / Math.max(W, H));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(W * k));
      c.height = Math.max(1, Math.round(H * k));
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, c.width, c.height);
      return { url: c.toDataURL("image/png"), w: W, h: H };
    });
  }

  function pick(file, which) {
    if (which === 2) { fileB = file; previewB = null; }
    else { fileA = file; fileB = null; previewA = null; previewB = null; }
    setStatus(file ? "图已就位，可以开始了。" : "");
    paintNames();
    if (!file) return;
    /* 尺寸要等解码完才知道，所以异步补回来。比对一下 file 有没有被换掉，
       免得用户连点两次时先回来的那张盖住后选的那张。 */
    makeThumb(file).then(function (t) {
      if (which === 2 ? fileB === file : fileA === file) {
        if (which === 2) previewB = t; else previewA = t;
        paintNames();
      }
    }).catch(function () { /* 解码失败就算了，反正真正开始时还会再报一次 */ });
  }

  function reset() {
    fileA = null;
    fileB = null;
    previewA = null;
    previewB = null;
    el.file.value = "";
    if (el.file2) el.file2.value = "";
    el.out.removeAttribute("src");
    /* 缩略图的 src 也要摘掉：只是收起来的话，那张 dataURL 还挂在 img 上占内存 */
    if (el.thumb1) el.thumb1.removeAttribute("src");
    if (el.thumb2) el.thumb2.removeAttribute("src");
    el.panels.innerHTML = "";
    el.body.classList.add("is-hidden");
    el.again.classList.add("is-hidden");
    setStatus("");
    paintNames();
  }

  /* ------------------------------------------------------------ 四种打法 */

  function showResult(image, card, file) {
    el.out.src = toURL(image);
    el.meta.textContent = image.width + " × " + image.height + " · PNG";
    el.panels.innerHTML = "";
    el.panels.appendChild(card);
    el.body.classList.remove("is-hidden");
    return { image: image, file: file };
  }

  /* 结果卡的公共骨架：一段说明 + 一份键值表 + 一个下载按钮。
     按钮只建不绑 —— 这时候结果图的 dataURL 还没生成，绑上去会存出一个空文件。
     绑定统一交给 showResult 之后的 bindDownload。 */
  function resultCard(title, tag, note, pairs, downloadLabel) {
    const card = infoCard(title, tag);
    if (note) {
      const p = document.createElement("p");
      p.className = "info-note";
      p.textContent = note;
      card.appendChild(p);
    }
    if (pairs && pairs.length) card.appendChild(kv(pairs));
    const acts = document.createElement("div");
    acts.className = "card-actions";
    const b = document.createElement("button");
    b.type = "button";
    b.className = "gen-btn";
    b.textContent = downloadLabel;
    acts.appendChild(b);
    card.querySelector("h2").appendChild(acts);
    return card;
  }

  function saveDataURL(url, name) {
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  /* 小番茄这一种没有密钥、没有参数，所以两条分支特别短 */
  async function doTomatoLock() {
    const src = toImage(await loadImage(fileA));
    const out = tomato(src);
    const image = { data: out, width: src.width, height: src.height };

    const card = resultCard("小番茄混淆", "已打乱",
      "存成 PNG。解回来不用密钥也不用参数 —— 把这张图传回来点「解回来」就行。",
      [
        ["尺寸", src.width + " × " + src.height],
        ["算法", "沿 Gilbert 曲线循环移位"],
        ["移位量", "黄金分割 × 像素数（固定值）"],
        ["密钥", "无 —— 这一种本来就没有"],
      ],
      "下载混淆图");
    const card2 = infoCard("和原版工具互通");
    const p = document.createElement("p");
    p.className = "info-note";
    p.textContent = "这一种就是照梦羽小番茄那版算法搬过来的，参数一个字没改。"
      + "所以它混淆出来的图，这里能解；这里混淆出来的，它那边也能解。";
    card2.appendChild(p);
    const p2 = document.createElement("p");
    p2.className = "info-note";
    p2.textContent = "尺寸必须原样保留：解混淆是按像素数算移位量的，裁剪或缩放之后就对不上了。";
    card2.appendChild(p2);

    showResult(image, card);
    el.panels.appendChild(card2);
    bindDownload(card, baseName(fileA) + "-tomato.png");
    el.ticket.value = "";
  }

  async function doTomatoUnlock() {
    const src = toImage(await loadImage(fileA));
    const out = untomato(src);
    const image = { data: out, width: src.width, height: src.height };
    const card = resultCard("解回来了", "还原完成",
      "不用密钥。尺寸得和混淆时一致才行 —— 传原图，别裁剪也别缩放。",
      [
        ["尺寸", src.width + " × " + src.height],
        ["算法", "沿 Gilbert 曲线反向移位"],
      ],
      "下载还原图");
    showResult(image, card);
    bindDownload(card, baseName(fileA) + "-untomato.png");
  }

  async function doScrambleLock(key) {
    const opts = {
      key: key,
      blockSize: Number(el.block.value),
      shufflePixels: el.pixels.checked,
    };
    const src = toImage(await loadImage(fileA));
    const out = scramble(src, opts);
    const image = { data: out, width: src.width, height: src.height };
    const ticket = makeTicket({
      v: 1, mode: "scramble",
      w: src.width, h: src.height,
      bs: opts.blockSize, px: opts.shufflePixels,
      sum: fingerprint(out),
    });

    const card = resultCard("置乱结果", "打乱完成",
      "存成 PNG。要解回来，得用同一个密钥、同一个块大小，再把这串密钥串粘回去。",
      [
        ["尺寸", src.width + " × " + src.height],
        ["块大小", opts.blockSize + " px"],
        ["块内打散", opts.shufflePixels ? "开" : "关"],
        ["密钥", key ? "已填（" + key.length + " 个字）" : "没填 —— 谁拿到都能解"],
      ],
      "下载混淆图");
    const card2 = infoCard("密钥串", "解混淆时要用");
    const p = document.createElement("p");
    p.className = "info-note";
    p.textContent = "这串里打包了尺寸、块大小和指纹。解混淆时粘进去，就不用去记当时选了什么。"
      + "它不含密钥本身，所以可以和解混淆的密钥分开保存。";
    card2.appendChild(p);
    const box = document.createElement("textarea");
    box.className = "obf-ticket-out";
    box.readOnly = true;
    box.rows = 3;
    box.value = ticket;
    card2.appendChild(box);
    const acts = document.createElement("div");
    acts.className = "card-actions";
    acts.appendChild(copyButton(ticket, "复制密钥串"));
    card2.querySelector("h2").appendChild(acts);

    showResult(image, card);
    el.panels.appendChild(card2);
    bindDownload(card, baseName(fileA) + "-scrambled.png");
    el.ticket.value = ticket;
  }

  /* 下载按钮要等结果图的 dataURL 出来才绑得上，所以统一在 showResult 之后补 */
  function bindDownload(card, name) {
    const b = card.querySelector("h2 .card-actions .gen-btn");
    if (!b) return;
    b.addEventListener("click", function () { saveDataURL(el.out.src, name); });
  }

  async function doScrambleUnlock(key) {
    const src = toImage(await loadImage(fileA));
    const raw = el.ticket.value.trim();
    const t = raw ? readTicket(raw) : null;
    let opts;
    let note = "";

    if (t) {
      if (t.mode && t.mode !== "scramble") {
        throw new Error("这串密钥串是嵌套模式给的，现在选的是置乱。");
      }
      opts = { key: key, blockSize: t.bs || 32, shufflePixels: t.px !== false };
      /* 界面跟着串走 —— 用户多半想不起来当时选的块大小 */
      el.block.value = String(opts.blockSize);
      el.pixels.checked = opts.shufflePixels;

      if (t.w && (t.w !== src.width || t.h !== src.height)) {
        note = "密钥串里记的尺寸是 " + t.w + " × " + t.h + "，这张图是 "
          + src.width + " × " + src.height + " —— 是不是传错图了？";
      } else if (t.sum !== undefined && t.sum !== fingerprint(src.data)) {
        note = "指纹对不上：这串密钥串不是配这张图的，解出来多半还是乱码。";
      }
    } else {
      opts = {
        key: key,
        blockSize: Number(el.block.value),
        shufflePixels: el.pixels.checked,
      };
      note = raw ? "" : "没粘密钥串，那就按上面手填的块大小来 —— 得和混淆时用的一致。";
    }

    const out = unscramble(src, opts);
    const image = { data: out, width: src.width, height: src.height };
    const card = resultCard("解混淆结果", "还原完成", note, [
      ["尺寸", src.width + " × " + src.height],
      ["块大小", opts.blockSize + " px"],
      ["块内打散", opts.shufflePixels ? "开" : "关"],
      ["密钥", key ? "已填（" + key.length + " 个字）" : "没填"],
    ], "下载还原图");
    showResult(image, card);
    bindDownload(card, baseName(fileA) + "-unscrambled.png");
    if (note) setStatus(note, true);
  }

  async function doNestLock(key) {
    if (!fileB) throw new Error("嵌套混淆要两张图：掩护图，加一张要藏进去的秘密图。");
    const cover = toImage(await loadImage(fileA));
    const secret = toImage(await loadImage(fileB));
    const r = embed(cover, secret, key);

    const pairs = [
      ["掩护图", cover.width + " × " + cover.height],
      ["秘密图", r.report.secretW + " × " + r.report.secretH],
      ["这张图能藏", r.report.capacity.toLocaleString() + " 个像素"],
      ["实际用了", r.report.used.toLocaleString() + " 个像素"],
      ["密钥", key ? "已填（" + key.length + " 个字）" : "没填 —— 谁拿到都能取出来"],
    ];
    const note = r.report.scaled
      ? "秘密图原来是 " + r.report.srcW + " × " + r.report.srcH
        + "，按容量等比缩到了 " + r.report.secretW + " × " + r.report.secretH
        + " —— 取回来的是缩过之后那个尺寸。想要原尺寸，换一张更大的掩护图。"
      : "秘密图原样藏了进去，取回来逐像素一致。";

    const card = resultCard("嵌套结果", "藏好了", note, pairs, "下载这张图");
    const card2 = infoCard("怎么取回来");
    const p = document.createElement("p");
    p.className = "info-note";
    p.textContent = "换到「嵌套 · 解混淆」，把上面这张图传进去，填同一个密钥，就能取回秘密图。"
      + "这张图看着和掩护图一模一样 —— 只有每个像素的最低位被动过，肉眼分不出来。";
    card2.appendChild(p);

    showResult(r, card);
    el.panels.appendChild(card2);
    bindDownload(card, baseName(fileA) + "-nested.png");
  }

  async function doNestUnlock(key) {
    const src = toImage(await loadImage(fileA));
    const r = extract(src, key);
    const card = resultCard("取回的秘密图", "提取完成",
      "尺寸是当初藏进去时的大小；如果当时秘密图比容量大，这里就是缩过之后的尺寸。",
      [
        ["这张图", src.width + " × " + src.height],
        ["取回的", r.report.secretW + " × " + r.report.secretH],
        ["密钥", key ? "已填（" + key.length + " 个字）" : "没填"],
      ],
      "下载秘密图");
    showResult(r, card);
    bindDownload(card, baseName(fileA) + "-secret.png");
  }

  async function run() {
    if (busy) return;
    if (!fileA) { setStatus("先选一张图。", true); return; }
    const key = el.key.value;
    busy = true;
    setStatus("正在算…");
    try {
      if (mode === "tomato") {
        if (dir === "lock") await doTomatoLock();
        else await doTomatoUnlock();
      } else if (mode === "scramble") {
        if (dir === "lock") await doScrambleLock(key);
        else await doScrambleUnlock(key);
      } else {
        if (dir === "lock") await doNestLock(key);
        else await doNestUnlock(key);
      }
      if (!el.status.textContent || el.status.textContent === "正在算…") {
        setStatus(dir === "lock" ? "做完了。" : "解回来了。");
      }
    } catch (e) {
      setStatus(e && e.message ? e.message : "出错了。", true);
      busy = false;
      return;
    }
    busy = false;
    el.again.classList.remove("is-hidden");
  }

  /* ------------------------------------------------------------ 入口 */

  function init() {
    el = {
      mode: byId("obfMode"),
      dir: byId("obfDir"),
      key: byId("obfKey"),
      keyField: byId("obfKeyField"),
      keyWarn: byId("obfKeyWarn"),
      tomatoNote: byId("obfTomatoNote"),
      block: byId("obfBlock"),
      blockField: byId("obfBlockField"),
      pixels: byId("obfPixels"),
      pixelsField: byId("obfPixelsField"),
      dropLabel: byId("obfDropLabel"),
      drop: byId("obfDrop"),
      file: byId("obfFile"),
      hint: byId("obfHint"),
      thumb1: byId("obfThumb1"),
      ico1: byId("obfIco1"),
      second: byId("obfSecond"),
      drop2: byId("obfDrop2"),
      file2: byId("obfFile2"),
      hint2: byId("obfHint2"),
      thumb2: byId("obfThumb2"),
      ico2: byId("obfIco2"),
      ticketBox: byId("obfTicketBox"),
      ticket: byId("obfTicket"),
      go: byId("obfGo"),
      again: byId("obfAgain"),
      body: byId("obfBody"),
      out: byId("obfOut"),
      meta: byId("obfMeta"),
      panels: byId("obfPanels"),
      status: byId("obfStatus"),
    };
    if (!el.drop || !el.go) return;

    Array.prototype.forEach.call(el.mode.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () {
        mode = b.getAttribute("data-mode");
        refresh();
      });
    });
    Array.prototype.forEach.call(el.dir.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function () {
        dir = b.getAttribute("data-dir");
        refresh();
      });
    });

    el.key.addEventListener("input", refresh);
    el.go.addEventListener("click", run);
    el.again.addEventListener("click", reset);

    /* 拖拽区和文件选择：两个位置共用一套逻辑 */
    [[el.drop, el.file, 1], [el.drop2, el.file2, 2]].forEach(function (pair) {
      const zone = pair[0], input = pair[1], which = pair[2];
      if (!zone || !input) return;
      zone.addEventListener("click", function (ev) {
        if (ev.target !== input) input.click();
      });
      input.addEventListener("change", function () {
        const f = input.files && input.files[0];
        if (f) pick(f, which);
        else input.value = "";
      });
      ["dragenter", "dragover"].forEach(function (t) {
        zone.addEventListener(t, function (ev) {
          ev.preventDefault();
          zone.classList.add("over");
        });
      });
      ["dragleave", "dragend"].forEach(function (t) {
        zone.addEventListener(t, function () { zone.classList.remove("over"); });
      });
      zone.addEventListener("drop", function (ev) {
        ev.preventDefault();
        zone.classList.remove("over");
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) pick(f, which);
      });
    });

    /* 粘贴：默认填第一个位置；嵌套混淆时第一张已经有了，就填第二张 */
    document.addEventListener("paste", function (ev) {
      const files = ev.clipboardData && ev.clipboardData.files;
      if (!files || !files.length) return;
      const wantSecond = (mode === "nest" && dir === "lock" && fileA && !fileB);
      pick(files[0], wantSecond ? 2 : 1);
    });

    refresh();
  }

  return {
    init: init,
    /* 纯函数，测试直接用 */
    utf8Bytes: utf8Bytes,
    fnv1a: fnv1a,
    keySeed: keySeed,
    mulberry32: mulberry32,
    makePermutation: makePermutation,
    invertPermutation: invertPermutation,
    blockGrid: blockGrid,
    groupBySize: groupBySize,
    scramblePass: scramblePass,
    scramble: scramble,
    unscramble: unscramble,
    fingerprint: fingerprint,
    gilbertCurve: gilbertCurve,
    tomato: tomato,
    untomato: untomato,
    tomatoShift: tomatoShift,
    capacity: capacity,
    resample: resample,
    embed: embed,
    extract: extract,
    makeTicket: makeTicket,
    readTicket: readTicket,
    b64encode: b64encode,
    b64decode: b64decode,
  };
})();
