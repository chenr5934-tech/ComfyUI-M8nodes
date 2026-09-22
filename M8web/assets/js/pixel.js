/* ============================================================================
 * M8web · 像素风转化（算法层）
 *
 * 把一张图变成像素画，整条链路都是普通卷积和逐像素运算，没有黑箱：
 *
 *   1. 抗锯齿卷积   对称一维核自己卷积自己（可分离），先横后竖
 *   2. 面积平均降维 每 block×block 个源像素平均成一个目标像素
 *   3. 锐化卷积     可选。unsharp：原图 + amount × (原图 − 模糊)
 *   4. 减色         每通道压到 levels 个台阶；配有序抖动（Bayer 4×4）
 *   5. 最近邻放大   硬边放大，不带任何插值 —— 这一步不做就不是像素画
 *
 * 为什么不用 canvas 的 drawImage 缩放：那个的插值方式各浏览器不一样，
 * 而且默认带平滑，出来的边是糊的。自己卷积 + 最近邻，结果才可控、可测。
 *
 * 这一层是纯函数，不碰 DOM。
 * ==========================================================================*/

const M8Pixel = (() => {
  "use strict";

  /* 一维核。都是归一化的（和为 1），对称，所以自己卷积自己就是 2D 核。 */
  const BOX3 = [1 / 3, 1 / 3, 1 / 3];
  const GAUSS5 = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];

  /* 有序抖动矩阵。比 Floyd-Steinberg 更适合像素风 ——
     它给的是规则的点状纹理，而不是随机噪声。 */
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  const STYLES = ["clean", "standard", "soft", "crisp"];

  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  /* Float32 中间结果转回 8 位。Uint8ClampedArray 自己会 clamp，不用手写。 */
  function toBytes(src) {
    const out = new Uint8ClampedArray(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out;
  }

  /* ------------------------------------------------------------ 卷积 */

  /* 可分离卷积：先横向再纵向。核长 2*radius+1。
     边界用 clamp（复制边缘像素）—— 用补零的话图边会暗一圈。
     返回 Float32Array，取整留到后面统一做，免得来回丢精度。 */
  function blur(pixels, W, H, kernel, radius) {
    const n = W * H * 4;
    const tmp = new Float32Array(n);
    const out = new Float32Array(n);

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = -radius; k <= radius; k++) {
          let sx = x + k;
          if (sx < 0) sx = 0; else if (sx >= W) sx = W - 1;
          const w = kernel[k + radius];
          const o = (y * W + sx) * 4;
          r += pixels[o] * w; g += pixels[o + 1] * w;
          b += pixels[o + 2] * w; a += pixels[o + 3] * w;
        }
        const d = (y * W + x) * 4;
        tmp[d] = r; tmp[d + 1] = g; tmp[d + 2] = b; tmp[d + 3] = a;
      }
    }

    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let k = -radius; k <= radius; k++) {
          let sy = y + k;
          if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1;
          const w = kernel[k + radius];
          const o = (sy * W + x) * 4;
          r += tmp[o] * w; g += tmp[o + 1] * w;
          b += tmp[o + 2] * w; a += tmp[o + 3] * w;
        }
        const d = (y * W + x) * 4;
        out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
      }
    }
    return out;
  }

  /* unsharp mask：原图 + amount × (原图 − 模糊)。
     降采样会把边磨圆，这一下把边重新咬回来，像素画才有脆感。 */
  function unsharp(pixels, W, H, amount) {
    const soft = blur(pixels, W, H, BOX3, 1);
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i++) {
      out[i] = pixels[i] + amount * (pixels[i] - soft[i]);
    }
    return out;
  }

  /* ------------------------------------------------------------ 降维 */

  /* 面积平均：每个目标像素 = 对应源块里所有像素的平均值。
     块不满时按实际像素数算（边缘那一条不会因为补零而发暗）。
     这一步本身就是「均值卷积 + 步长采样」，也就是池化。 */
  function downsample(src, W, H, block) {
    const bs = clampInt(block, 1, 512, 1);
    const dw = Math.ceil(W / bs), dh = Math.ceil(H / bs);
    const out = new Uint8ClampedArray(dw * dh * 4);

    for (let by = 0; by < dh; by++) {
      const y0 = by * bs;
      const y1 = Math.min(H, y0 + bs);
      for (let bx = 0; bx < dw; bx++) {
        const x0 = bx * bs;
        const x1 = Math.min(W, x0 + bs);
        let r = 0, g = 0, b = 0, a = 0, cnt = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const o = (y * W + x) * 4;
            r += src[o]; g += src[o + 1]; b += src[o + 2]; a += src[o + 3];
            cnt++;
          }
        }
        const d = (by * dw + bx) * 4;
        out[d] = r / cnt; out[d + 1] = g / cnt;
        out[d + 2] = b / cnt; out[d + 3] = a / cnt;
      }
    }
    return { data: out, width: dw, height: dh };
  }

  /* ------------------------------------------------------------ 减色 */

  /* 每通道压到 levels 个台阶。levels = 2 就是纯黑白，8 就是 512 色那种感觉。
     alpha 一个字节都不动。 */
  function quantize(pixels, levels) {
    const lv = clampInt(levels, 2, 255, 2);
    const step = 255 / (lv - 1);
    const out = new Uint8ClampedArray(pixels.length);
    for (let i = 0; i < pixels.length; i += 4) {
      out[i] = Math.round(Math.round(pixels[i] / step) * step);
      out[i + 1] = Math.round(Math.round(pixels[i + 1] / step) * step);
      out[i + 2] = Math.round(Math.round(pixels[i + 2] / step) * step);
      out[i + 3] = pixels[i + 3];
    }
    return out;
  }

  /* 有序抖动：按 Bayer 矩阵给每个像素加一点偏移再取整，
     于是相邻像素落在不同台阶上，整体看着像多出了中间色。 */
  function dither(pixels, W, H, levels) {
    const lv = clampInt(levels, 2, 255, 2);
    const step = 255 / (lv - 1);
    const out = new Uint8ClampedArray(pixels.length);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const bias = (BAYER4[(y % 4) * 4 + (x % 4)] / 16 - 0.5) * step;
        out[o] = Math.round((pixels[o] + bias) / step) * step;
        out[o + 1] = Math.round((pixels[o + 1] + bias) / step) * step;
        out[o + 2] = Math.round((pixels[o + 2] + bias) / step) * step;
        out[o + 3] = pixels[o + 3];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ 放大 */

  /* 最近邻放大。**这一步决定了像不像像素画** ——
     换成双线性，出来的就是一张糊图，只是分辨率低而已。 */
  function scaleNearest(src, sw, sh, dw, dh) {
    const TW = clampInt(dw, 1, 8192, 1);
    const TH = clampInt(dh, 1, 8192, 1);
    const out = new Uint8ClampedArray(TW * TH * 4);
    for (let y = 0; y < TH; y++) {
      let sy = Math.floor(y * sh / TH);
      if (sy >= sh) sy = sh - 1;
      for (let x = 0; x < TW; x++) {
        let sx = Math.floor(x * sw / TW);
        if (sx >= sw) sx = sw - 1;
        const s = (sy * sw + sx) * 4;
        const d = (y * TW + x) * 4;
        out[d] = src[s]; out[d + 1] = src[s + 1];
        out[d + 2] = src[s + 2]; out[d + 3] = src[s + 3];
      }
    }
    return out;
  }

  /* ------------------------------------------------------------ 主流程 */

  /* 风格就是「卷积那一段怎么走」：
       clean    不卷积，直接面积平均。拿来跟别的比，看卷积到底做了什么
       standard 均值 3×3 抗锯齿
       soft     高斯 5×5，更柔，适合照片
       crisp    均值 3×3 + 锐化，边最硬，适合线条画和二次元 */
  function toPixelArt(image, opts) {
    const o = opts || {};
    const W = image.width, H = image.height;
    if (!W || !H || !image.data || image.data.length < W * H * 4) {
      throw new Error("图片数据不完整");
    }
    const block = clampInt(o.block, 2, 64, 8);
    const style = STYLES.indexOf(o.style) >= 0 ? o.style : "standard";
    const useDither = !!o.dither;
    const zoom = clampInt(o.zoom, 1, 24, 1);
    /* levels 传 0 表示不限色 */
    const levels = o.levels === 0 || o.levels === "0" ? 0 : clampInt(o.levels, 2, 255, 0);

    let cur = toBytes(image.data);

    if (style === "soft") cur = toBytes(blur(cur, W, H, GAUSS5, 2));
    else if (style === "standard" || style === "crisp") cur = toBytes(blur(cur, W, H, BOX3, 1));

    const small = downsample(cur, W, H, block);

    let flat = small.data;
    if (style === "crisp" && small.width >= 3 && small.height >= 3) {
      flat = unsharp(flat, small.width, small.height, 0.6);
    }

    if (levels > 0) {
      flat = useDither
        ? dither(flat, small.width, small.height, levels)
        : quantize(flat, levels);
    }

    const outW = small.width * zoom;
    const outH = small.height * zoom;
    const big = zoom > 1 ? scaleNearest(flat, small.width, small.height, outW, outH) : flat;

    return {
      data: big, width: outW, height: outH,
      report: {
        srcW: W, srcH: H,
        pixelW: small.width, pixelH: small.height,
        block: block, zoom: zoom, style: style,
        levels: levels, dither: useDither && levels > 0,
        colors: levels > 0 ? levels * levels * levels : 0,
      },
    };
  }

  /* ------------------------------------------------------------ 界面 */

  /* 注意：loadImage / toImage / toURL / infoCard / kv 这几块和 lora.js、
     obfuscate.js 里那两份是重复的。三个页面都在用了，该抽一个公共 js 出来 ——
     这一步要动那两个已经测过的文件，所以留成单独一次改动，不混在这里。 */

  let el = {};
  let file = null;
  let thumb = null;
  let busy = false;

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

  function loadImage(f) {
    return new Promise(function (resolve, reject) {
      if (!f) { reject(new Error("没有选中文件")); return; }
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("这个文件读不出图片内容")); };
      img.src = url;
    });
  }

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

  function makeThumb(f) {
    return loadImage(f).then(function (img) {
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

  function paint() {
    el.thumb.classList.toggle("is-hidden", !thumb);
    el.ico.classList.toggle("is-hidden", !!thumb);
    if (thumb) el.thumb.src = thumb.url;
    el.drop.querySelector("strong").textContent = file
      ? file.name
      : "点击选择、拖进来，或者 Ctrl+V 粘贴";
    el.hint.textContent = thumb ? thumb.w + " × " + thumb.h : "PNG / JPEG / WebP";
  }

  function pick(f) {
    file = f;
    thumb = null;
    paint();
    setStatus(f ? "图已就位，可以转化了。" : "");
    if (!f) return;
    makeThumb(f).then(function (t) {
      if (file === f) { thumb = t; paint(); }
    }).catch(function () { /* 缩略图失败就算了，真正转化时还会再报一次 */ });
  }

  function reset() {
    file = null;
    thumb = null;
    el.file.value = "";
    el.out.removeAttribute("src");
    if (el.thumb) el.thumb.removeAttribute("src");
    el.panels.innerHTML = "";
    el.body.classList.add("is-hidden");
    el.again.classList.add("is-hidden");
    setStatus("");
    paint();
  }

  const STYLE_LABEL = {
    clean: "原味（不卷积）",
    standard: "标准（均值 3×3）",
    soft: "柔和（高斯 5×5）",
    crisp: "硬朗（抗锯齿 + 锐化）",
  };

  async function run() {
    if (busy) return;
    if (!file) { setStatus("先选一张图。", true); return; }
    busy = true;
    setStatus("正在算…");

    let out;
    try {
      const src = toImage(await loadImage(file));
      out = toPixelArt(src, {
        style: el.style.value,
        block: Number(el.block.value),
        levels: Number(el.levels.value),
        dither: el.dither.checked,
        zoom: Number(el.zoom.value),
      });
    } catch (e) {
      setStatus(e && e.message ? e.message : "出错了。", true);
      busy = false;
      return;
    }

    const r = out.report;
    const url = toURL({ data: out.data, width: out.width, height: out.height });
    el.out.src = url;
    el.meta.textContent = out.width + " × " + out.height + " · PNG"
      + "（像素尺寸 " + r.pixelW + " × " + r.pixelH + "）";
    el.panels.innerHTML = "";

    const card = infoCard("像素图", "转好了");
    const note = document.createElement("p");
    note.className = "info-note";
    note.textContent = "截图里放大看，每个像素应该是一个规整的方块，边界是硬的 —— "
      + "那说明用的是最近邻。要是边界发糊，那就是插值了。";
    card.appendChild(note);
    card.appendChild(kv([
      ["原始尺寸", r.srcW + " × " + r.srcH],
      ["像素尺寸", r.pixelW + " × " + r.pixelH + "（" + r.pixelW * r.pixelH + " 个像素）"],
      ["输出尺寸", out.width + " × " + out.height],
    ]));
    const acts = document.createElement("div");
    acts.className = "card-actions";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "gen-btn";
    dl.textContent = "下载像素图";
    dl.addEventListener("click", function () {
      const a = document.createElement("a");
      a.href = el.out.src;
      a.download = (file.name || "image").replace(/\.[^.]+$/, "") + "-pixel.png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    acts.appendChild(dl);
    card.querySelector("h2").appendChild(acts);

    const card2 = infoCard("这一张是怎么算的", "卷积链路");
    card2.appendChild(kv([
      ["风格", STYLE_LABEL[r.style] || r.style],
      ["像素块", r.block + " px（每 " + r.block + " × " + r.block + " 个原始像素合成一个）"],
      ["颜色", r.levels > 0 ? "每通道 " + r.levels + " 档（最多 " + r.colors.toLocaleString() + " 色）" : "不限色"],
      ["抖动", r.levels > 0 ? (r.dither ? "开（Bayer 4×4 有序抖动）" : "关") : "—"],
      ["放大", r.zoom + "× 最近邻"],
    ]));
    const p2 = document.createElement("p");
    p2.className = "info-note";
    p2.textContent = "链路：抗锯齿卷积 → 面积平均降维 → 锐化卷积 → 减色 → 最近邻放大。"
      + "选「原味」就是把卷积那两步关掉，直接面积平均，可以拿它对比卷积到底做了什么。";
    card2.appendChild(p2);

    el.panels.appendChild(card);
    el.panels.appendChild(card2);
    el.body.classList.remove("is-hidden");
    el.again.classList.remove("is-hidden");
    setStatus("转好了。");
    busy = false;
  }

  function init() {
    el = {
      style: byId("pxStyle"),
      block: byId("pxBlock"),
      levels: byId("pxLevels"),
      zoom: byId("pxZoom"),
      dither: byId("pxDither"),
      drop: byId("pxDrop"),
      file: byId("pxFile"),
      hint: byId("pxHint"),
      thumb: byId("pxThumb"),
      ico: byId("pxIco"),
      go: byId("pxGo"),
      again: byId("pxAgain"),
      body: byId("pxBody"),
      out: byId("pxOut"),
      meta: byId("pxMeta"),
      panels: byId("pxPanels"),
      status: byId("pxStatus"),
    };
    if (!el.drop || !el.go) return;

    el.go.addEventListener("click", run);
    el.again.addEventListener("click", reset);

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.file) el.file.click();
    });
    el.file.addEventListener("change", function () {
      const f = el.file.files && el.file.files[0];
      if (f) pick(f);
      else el.file.value = "";
    });
    ["dragenter", "dragover"].forEach(function (t) {
      el.drop.addEventListener(t, function (ev) {
        ev.preventDefault();
        el.drop.classList.add("over");
      });
    });
    ["dragleave", "dragend"].forEach(function (t) {
      el.drop.addEventListener(t, function () { el.drop.classList.remove("over"); });
    });
    el.drop.addEventListener("drop", function (ev) {
      ev.preventDefault();
      el.drop.classList.remove("over");
      const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) pick(f);
    });
    document.addEventListener("paste", function (ev) {
      const files = ev.clipboardData && ev.clipboardData.files;
      if (files && files.length) pick(files[0]);
    });

    /* 改了参数直接把上一次的结果下掉，免得用户以为看到的是新参数的 */
    [el.style, el.block, el.levels, el.zoom].forEach(function (s) {
      s.addEventListener("change", function () {
        if (!el.body.classList.contains("is-hidden")) {
          setStatus("参数变了，点「转化」重新算一次。");
        }
      });
    });
    el.dither.addEventListener("change", function () {
      if (!el.body.classList.contains("is-hidden")) {
        setStatus("参数变了，点「转化」重新算一次。");
      }
    });

    paint();
  }

  return {
    init: init,
    BOX3: BOX3,
    GAUSS5: GAUSS5,
    BAYER4: BAYER4,
    STYLES: STYLES,
    blur: blur,
    unsharp: unsharp,
    downsample: downsample,
    quantize: quantize,
    dither: dither,
    scaleNearest: scaleNearest,
    toPixelArt: toPixelArt,
  };
})();
