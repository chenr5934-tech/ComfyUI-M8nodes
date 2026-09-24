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

/* 界面文案走 i18n.js。它是 module，而这些功能脚本是普通脚本，拿不到 import ——
   i18n.js 因此挂了一份到 window。

   用 var 而不是 const：普通脚本共享全局作用域，const 在这里重复声明会直接报
   "Identifier 'T' has already been declared"，一个页面同时加载几个脚本就白屏。
   var 重复声明是合法的，每个文件仍然自足，不依赖加载顺序。

   宿主对象用 globalThis 取而不是直接写 window：前端测试在 Node 里跑这些脚本，
   那边没有 window，直接解引用会当场 "window is not defined"。

   i18n 没加载成功时走这里的兜底：**必须自己填占位符** —— 直接返回 fallback 的话，
   界面上会原样显示 "{h} h {m} min" 这种花括号，比换不成中文更糟。 */
var T = function (key, fallback, vars) {
  var host = typeof globalThis !== "undefined" ? globalThis : {};
  var i18n = host.M8I18n;
  if (i18n && typeof i18n.t === "function") return i18n.t(key, fallback, vars);

  var text = fallback === undefined ? key : fallback;
  if (vars && typeof text === "string") {
    for (var k in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, k)) {
        text = text.split("{" + k + "}").join(String(vars[k]));
      }
    }
  }
  return text;
};

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
      throw new Error(T("pxIncomplete", "The image data is incomplete"));
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
      if (!f) { reject(new Error(T("pxNoFile", "No file was selected"))); return; }
      const url = URL.createObjectURL(f);
      const img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error(T("pxUnreadable", "No image could be read from this file")));
      };
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
      : T("dropPrompt", "Click to choose, drag it in, or paste with Ctrl+V");
    el.hint.textContent = thumb ? thumb.w + " × " + thumb.h : "PNG / JPEG / WebP";
  }

  function pick(f) {
    file = f;
    thumb = null;
    paint();
    setStatus(f ? T("pxReady", "The image is in place - you can convert it now.") : "");
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

  /* 风格名当场查表：这里是模块顶层，本文件先于 i18n.js 执行，
     顶层取值只会拿到 undefined。四个键和 pixel.html 的选项共用同一份译文。 */
  function styleLabel(style) {
    if (style === "clean") return T("pixelStyleClean", "Plain - no convolution");
    if (style === "standard") return T("pixelStyleStandard", "Standard - mean 3x3 antialiasing");
    if (style === "soft") return T("pixelStyleSoft", "Soft - Gaussian 5x5");
    if (style === "crisp") return T("pixelStyleCrisp", "Crisp - antialiasing + sharpening");
    return style;
  }

  async function run() {
    if (busy) return;
    if (!file) { setStatus(T("pxPickFirst", "Choose an image first."), true); return; }
    busy = true;
    setStatus(T("pxComputing", "Working it out..."));

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
      setStatus(e && e.message ? e.message : T("pxFailed", "Something went wrong."), true);
      busy = false;
      return;
    }

    const r = out.report;
    const url = toURL({ data: out.data, width: out.width, height: out.height });
    el.out.src = url;
    el.meta.textContent = T("pxMeta", "{outW} × {outH} · PNG (pixel size {pw} × {ph})", {
      outW: out.width,
      outH: out.height,
      pw: r.pixelW,
      ph: r.pixelH,
    });
    el.panels.innerHTML = "";

    const card = infoCard(T("pxCardTitle", "Pixel art"), T("pxCardTag", "Done"));
    const note = document.createElement("p");
    note.className = "info-note";
    note.textContent = T("pxNote",
      "Zoom into the result: every pixel should be a tidy square with hard edges, which is what nearest-neighbour gives you. If the edges look soft, something interpolated them.");
    card.appendChild(note);
    card.appendChild(kv([
      [T("pxSourceSize", "Source size"), r.srcW + " × " + r.srcH],
      [T("pxPixelSize", "Pixel size"), T("pxPixelSizeVal", "{w} × {h} ({n} pixel{plural})", {
        w: r.pixelW,
        h: r.pixelH,
        n: r.pixelW * r.pixelH,
        plural: r.pixelW * r.pixelH === 1 ? "" : "s",
      })],
      [T("pxOutputSize", "Output size"), out.width + " × " + out.height],
    ]));
    const acts = document.createElement("div");
    acts.className = "card-actions";
    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "gen-btn";
    dl.textContent = T("pxDownload", "Download the pixel art");
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

    const card2 = infoCard(T("pxHowTitle", "How this one was worked out"), T("pxHowTag", "Convolution chain"));
    card2.appendChild(kv([
      [T("pixelStyle", "Style"), styleLabel(r.style)],
      [T("pixelBlock", "Pixel block size"), T("pxBlockVal",
        "{n} px (every {n} × {n} source pixels become one)", { n: r.block })],
      [T("pixelLevels", "Colours"), r.levels > 0
        ? T("pxLevelsVal", "{n} steps per channel (up to {colors} colours)",
          { n: r.levels, colors: r.colors.toLocaleString() })
        : T("pxLevelsUnlimited", "No colour limit")],
      [T("pxDitherLabel", "Dithering"), r.levels > 0
        ? (r.dither ? T("pxDitherOn", "On (Bayer 4x4 ordered dither)") : T("pxDitherOff", "Off"))
        : "—"],
      [T("pixelZoom", "Upscale"), T("pxZoomVal", "{n}× nearest neighbour", { n: r.zoom })],
    ]));
    const p2 = document.createElement("p");
    p2.className = "info-note";
    p2.textContent = T("pxChain",
      "Chain: antialiasing convolution -> area-average downsample -> sharpening convolution -> colour reduction -> nearest-neighbour upscale. Picking \"Plain\" turns the two convolution steps off and goes straight to area averaging, which is how you can see what convolution was doing.");
    card2.appendChild(p2);

    el.panels.appendChild(card);
    el.panels.appendChild(card2);
    el.body.classList.remove("is-hidden");
    el.again.classList.remove("is-hidden");
    setStatus(T("pxDone", "Done"));
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
          setStatus(T("pxParamsChanged", "The parameters changed - click Convert to run it again."));
        }
      });
    });
    el.dither.addEventListener("change", function () {
      if (!el.body.classList.contains("is-hidden")) {
        setStatus(T("pxParamsChanged", "The parameters changed - click Convert to run it again."));
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
