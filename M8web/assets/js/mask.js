/* ============================================================================
 * M8web · 图片工坊 / 分段遮挡
 *
 * 在图上盖 n 条纯黑条，条上写一句话，最后导出**一整张**图（不是切段）。
 *
 * 和分段裁剪的三处不同：
 *   1. 位置存的是每条**中心**（centers[i]），不是分割线 —— 条是有厚度的
 *   2. 条之间**允许重叠**（想连成一片就拖到一起），只夹在图片范围内
 *   3. 竖遮时文字整体转 90° —— 竖条又高又窄，横排的话一行只塞得下三四个字，
 *      那句带颜文字的话会被切碎；转过来之后沿条的长方向排，一次读完
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

const M8Mask = (() => {
  "use strict";

  const DEFAULT_TEXT = "Rather not see it, so it is gone. Ciallo~ (∠・ω< )⌒☆";
  const MIN_COUNT = 1;     // 最少一条 —— 只想盖一条也应该可以
  const MAX_COUNT = 10;
  const MIN_THICK = 3;
  const MAX_THICK = 40;
  /* 字号下限。再小就没人看得清了，所以缩到这儿还装不下时宁可让它略微露出条外，
     也不裁掉 —— 这块的要求是整句话必须显示全。 */
  const MIN_SIZE = 6;

  const state = {
    img: null,
    dir: "h",          // h = 横遮（水平黑条），v = 竖遮（竖直黑条）
    count: 3,
    thick: 12,         // 每条厚度，占图片短边的百分比
    text: DEFAULT_TEXT,
    centers: [],       // 每条中心位置，百分比（横遮是 y，竖遮是 x）
    drag: -1,
    tight: false,      // 文字是不是已经缩到下限还排不下（用来给提示）
    shot: "",          // 预览图的 objectURL
  };

  let el = {};
  let measureCtx = null;

  /* ------------------------------------------------------------ 小工具 */

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* 量文字宽度用的离屏画布。惰性创建：模块加载时不一定已经有 document */
  function getMeasure() {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    return measureCtx;
  }

  /* 每条的中心：默认在 n 等分的中间，所以是 (i + 0.5) / n */
  function evenCenters(n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(((i + 0.5) / n) * 100);
    return out;
  }

  /* 一条遮罩在原图上的像素区域。生成和尺寸显示都走这里。 */
  function rectOf(i) {
    const W = state.img ? state.img.naturalWidth : 0;
    const H = state.img ? state.img.naturalHeight : 0;
    const c = state.centers[i];
    const t = state.thick;
    if (c === undefined) return { x: 0, y: 0, w: 0, h: 0 };
    if (state.dir === "h") {
      const y = ((c - t / 2) / 100) * H;
      const h = (t / 100) * H;
      return { x: 0, y: y, w: W, h: h };
    }
    const x = ((c - t / 2) / 100) * W;
    const w = (t / 100) * W;
    return { x: x, y: 0, w: w, h: H };
  }

  /* ------------------------------------------------------------ 文字排版 */

  /* 把一句话塞进 w×h 的框里：先猜一个字号，再逐像素缩小直到装得下。
     返回 { size, lines } —— 抽成纯函数是为了能单独测，不用真画布。 */
  function fitText(ctx, text, w, h) {
    const pad = Math.min(6, Math.max(2, h * 0.12));
    const availW = Math.max(1, w - pad * 2);
    const availH = Math.max(1, h - pad * 2);
    /* 起手值给大一点没关系，反正下面会缩；但别大到迭代几十次 */
    let size = Math.max(MIN_SIZE, Math.min(availH * 0.9, availW * 0.5));

    for (;;) {
      /* 量的时候统一用 use 而不是 size：递减到下限以下的那一轮也要按下限来量，
         否则返回值会比下限还小一截（实测到过 7.68px）。 */
      const use = Math.max(MIN_SIZE, size);
      ctx.font = "800 " + Math.round(use) + "px MiSans, 'Microsoft YaHei', sans-serif";
      const lines = wrapText(ctx, text, availW);
      const need = lines.length * use * 1.22;
      if (need <= availH || use <= MIN_SIZE) {
        /* 不做行数截断 —— 截掉就是「没显示全」，而这里的要求是整句都要在。
           fits 只是告诉调用方「是不是真装下了」，装不下时提示用户加厚遮罩。 */
        return { size: use, lines: lines, fits: need <= availH };
      }
      size -= 1;
    }
  }

  /* 逐字量宽度换行。中文没有词边界，按字断就好 */
  function wrapText(ctx, text, maxW) {
    const lines = [];
    let line = "";
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") { lines.push(line); line = ""; continue; }
      const test = line + ch;
      if (line && ctx.measureText(test).width > maxW) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    lines.push(line);
    return lines;
  }

  /* 在 (x,y,w,h) 里居中画一段文字。竖遮时外面会先转坐标系再调它 */
  function paintText(ctx, x, y, w, h, text) {
    const fit = fitText(ctx, text, w, h);
    if (!fit.lines.length) return fit;
    ctx.font = "800 " + Math.round(fit.size) + "px MiSans, 'Microsoft YaHei', sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lh = fit.size * 1.22;
    const top = y + h / 2 - ((fit.lines.length - 1) * lh) / 2;
    for (let i = 0; i < fit.lines.length; i++) {
      ctx.fillText(fit.lines[i], x + w / 2, top + i * lh);
    }
    return fit;
  }

  /* ------------------------------------------------------------ 状态改动 */

  function setCount(n) {
    state.count = clamp(Math.round(n), MIN_COUNT, MAX_COUNT);
    state.centers = evenCenters(state.count);
    render();
  }

  function setDir(dir) {
    if (dir !== "h" && dir !== "v") return;
    state.dir = dir;
    el.panel.dataset.dir = dir;
    Array.prototype.forEach.call(el.dirBox.querySelectorAll("button"), function (b) {
      const on = b.dataset.dir === dir;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    render();
  }

  function setThick(t) {
    state.thick = clamp(t, MIN_THICK, MAX_THICK);
    render();
  }

  function setText(t) {
    state.text = String(t == null ? "" : t);
    render();
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderStrips();
    renderInfo();
    if (el.thickOut) el.thickOut.textContent = state.thick + "%";
  }

  function renderStrips() {
    const box = el.strips;
    box.innerHTML = "";
    if (!state.img) return;

    const rect = el.frame.getBoundingClientRect();
    const frag = document.createDocumentFragment();

    state.centers.forEach(function (c, i) {
      const strip = document.createElement("div");
      strip.className = "mask-strip";
      strip.dataset.index = String(i);
      strip.setAttribute("role", "slider");
      strip.setAttribute("tabindex", "0");
      strip.setAttribute("aria-label", T("maskBandAria", "Band {n}", { n: i + 1 }));
      strip.setAttribute("aria-valuemin", "0");
      strip.setAttribute("aria-valuemax", "100");
      strip.setAttribute("aria-valuenow", String(Math.round(c)));

      if (state.dir === "h") {
        strip.style.top = (c - state.thick / 2) + "%";
        strip.style.height = state.thick + "%";
        strip.style.left = "0";
        strip.style.right = "0";
      } else {
        strip.style.left = (c - state.thick / 2) + "%";
        strip.style.width = state.thick + "%";
        strip.style.top = "0";
        strip.style.bottom = "0";
      }

      const stripW = rect.width;
      const stripH = rect.height;
      const thickPx = state.dir === "h" ? stripH * state.thick / 100 : stripW * state.thick / 100;
      const lenPx = state.dir === "h" ? stripW : stripH;
      /* 竖遮时文字要整体转 90 度，所以可用的「宽」是条的长边 */
      const availW = state.dir === "h" ? stripW : stripH;
      const availH = thickPx;

      const label = document.createElement("span");
      label.className = "mask-label";
      if (state.text) {
        /* 用真测量排版，不用「一个字约等于 0.58 个字宽」那种估算法 ——
           中文是全角，一个字差不多就是一个字号宽，估算出来的字号会大一截，
           整句就被裁掉了。这里交给 fitText：先猜再缩，缩到整句都排得下。 */
        const fit = fitText(getMeasure(), state.text, availW, availH);
        label.style.fontSize = fit.size + "px";
        label.textContent = fit.lines.join("\n");
        state.tight = !fit.fits;
      } else {
        label.textContent = "";
        state.tight = false;
      }

      /* 竖条又高又窄，横排一行只塞得下三四个字，那句带颜文字的话会被切碎。
         办法是把盒子摆成「横躺着的条」再整体转 90 度，文字就沿着条的长方向排。
         必须用像素定宽高 —— transform 只转视觉、不改布局盒，
         盒还是窄的话 overflow:hidden 会先把文字裁掉，转完什么都看不见。 */
      if (state.dir === "v") {
        label.classList.add("rotated");
        label.style.position = "absolute";
        label.style.left = "50%";
        label.style.top = "50%";
        label.style.width = Math.max(20, lenPx) + "px";
        label.style.height = Math.max(14, thickPx) + "px";
        label.style.transform = "translate(-50%, -50%) rotate(90deg)";
      }
      strip.appendChild(label);

      strip.addEventListener("pointerdown", function (ev) { startDrag(i, ev); });
      strip.addEventListener("keydown", function (ev) { onKey(i, ev); });
      frag.appendChild(strip);
    });
    box.appendChild(frag);
  }

  function renderInfo() {
    if (!el.countOut) return;
    el.countOut.textContent = T("maskBandCount", "{n} bands", { n: state.count });
    if (!el.info) return;
    if (!state.img) { el.info.textContent = ""; return; }
    const r = rectOf(0);
    const one = state.dir === "h"
      ? T("maskPixelTall", "{n} px tall", { n: Math.round(r.h) })
      : T("maskPixelWide", "{n} px wide", { n: Math.round(r.w) });
    let text = T("maskInfo", "{n} bands - {one} each - about {pct}% covered in total",
      { n: state.count, one: one, pct: Math.round(state.count * state.thick) });
    /* 字号已经缩到下限还是排不下时说清楚，别让用户以为是自己没看见 */
    if (state.tight) text += T("maskTightNote", " - the text runs long and the font is already at its smallest; thicker bands read better");
    el.info.textContent = text;
  }

  /* ------------------------------------------------------------ 拖拽 */

  function startDrag(i, ev) {
    if (!state.img) return;
    state.drag = i;
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  function onMove(ev) {
    if (state.drag < 0 || !state.img) return;
    const rect = el.frame.getBoundingClientRect();
    const size = state.dir === "h" ? rect.height : rect.width;
    if (!size) return;
    const raw = state.dir === "h" ? ev.clientY - rect.top : ev.clientX - rect.left;
    /* 只夹边界：条的中心要保证整条都还在图里。
       条之间**不**互相挡 —— 想连成一片就拖到一起，那是允许的 */
    const half = state.thick / 2;
    const pos = clamp((raw / size) * 100, half, 100 - half);

    state.centers[state.drag] = pos;
    const strip = el.strips.children[state.drag];
    if (strip) {
      if (state.dir === "h") strip.style.top = (pos - half) + "%";
      else strip.style.left = (pos - half) + "%";
      strip.setAttribute("aria-valuenow", String(Math.round(pos)));
    }
    renderInfo();
  }

  function endDrag() {
    if (state.drag < 0) return;
    state.drag = -1;
  }

  function onKey(i, ev) {
    const step = ev.shiftKey ? 5 : 1;
    let pos = null;
    if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") pos = state.centers[i] - step;
    else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") pos = state.centers[i] + step;
    if (pos === null) return;
    ev.preventDefault();
    const half = state.thick / 2;
    state.centers[i] = clamp(pos, half, 100 - half);
    renderStrips();
    renderInfo();
  }

  /* ------------------------------------------------------------ 生成 */

  function clearPreview() {
    if (state.shot) {
      try { URL.revokeObjectURL(state.shot); } catch (e) { /* 无所谓 */ }
    }
    state.shot = "";
    if (el.previewGrid) el.previewGrid.innerHTML = "";
    if (el.preview) el.preview.classList.add("is-hidden");
  }

  function drawTo(cv) {
    const W = state.img.naturalWidth;
    const H = state.img.naturalHeight;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(state.img, 0, 0, W, H);

    state.centers.forEach(function (c, i) {
      const r = rectOf(i);
      ctx.fillStyle = "#000000";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (!state.text) return;
      if (state.dir === "h") {
        paintText(ctx, r.x, r.y, r.w, r.h, state.text);
      } else {
        /* 竖条：把坐标系转 90 度，于是「可用宽度」变成了条的长边 */
        ctx.save();
        ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
        ctx.rotate(Math.PI / 2);
        paintText(ctx, -r.h / 2, -r.w / 2, r.h, r.w, state.text);
        ctx.restore();
      }
    });
    return cv;
  }

  function generate() {
    if (!state.img) return;
    clearPreview();
    setStatus(T("busyGenerating", "Generating..."));
    const cv = document.createElement("canvas");
    drawTo(cv);
    const name = M8Studio.state.name + "-masked.png";
    if (typeof cv.toBlob === "function") {
      cv.toBlob(function (blob) {
        if (!blob) { setStatus(T("generateFailed", "Generation failed."), true); return; }
        state.shot = URL.createObjectURL(blob);
        showPreview(name, cv.width, cv.height);
      }, "image/png");
    } else {
      setStatus(T("browserNoExport", "This browser cannot export."), true);
    }
  }

  function showPreview(name, w, h) {
    const box = el.previewGrid;
    box.innerHTML = "";
    const card = document.createElement("div");
    card.className = "pv-card";

    const shot = document.createElement("div");
    shot.className = "pv-shot";
    const im = document.createElement("img");
    im.src = state.shot;
    im.alt = T("maskPreviewAlt", "Preview of the covered image");
    shot.appendChild(im);

    const meta = document.createElement("div");
    meta.className = "pv-meta";
    const tag = document.createElement("span");
    tag.className = "seg-size";
    tag.textContent = w + " × " + h;
    meta.appendChild(tag);

    const save = document.createElement("a");
    save.className = "pv-save";
    save.href = state.shot;
    save.download = name;
    save.textContent = T("exportThisImage", "Export this image");

    card.appendChild(shot);
    card.appendChild(meta);
    card.appendChild(save);
    box.appendChild(card);
    el.preview.classList.remove("is-hidden");
    if (el.previewNote) {
      el.previewNote.textContent = T("maskPreviewNote", "{n} bands", { n: state.count })
        + (state.text ? "" : T("maskPreviewNoteNoText", " - no text written"));
    }
    setStatus(T("previewReadyExport", "Done. Export it once it looks right."));
  }

  /* ------------------------------------------------------------ 入口 */

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function byId(id) { return document.getElementById(id); }

  function useImage(st) {
    state.img = st.img;
    if (!st.img) {
      state.centers = [];
      clearPreview();
      render();
      return;
    }
    el.source.src = st.url;
    /* 给容器定死图片比例：<img> 解码是异步的，那一刻容器高度还是 0，
       而黑条上的字号是按容器像素算的 —— 不先定比例，第一版会全按兜底字号排。 */
    const W = st.img.naturalWidth || 1;
    const H = st.img.naturalHeight || 1;
    el.frame.style.aspectRatio = W + " / " + H;
    state.centers = evenCenters(state.count);
    clearPreview();
    render();
    setStatus(T("maskStatusHint", "Drag a band to move it; bands can overlap each other."));
  }

  function init() {
    el = {
      panel: byId("maskPanel"),
      frame: byId("maskFrame"),
      source: byId("maskSource"),
      strips: byId("maskStrips"),
      dirBox: byId("maskDir"),
      count: byId("maskCount"),
      countOut: byId("maskCountOut"),
      thick: byId("maskThick"),
      thickOut: byId("maskThickOut"),
      text: byId("maskText"),
      info: byId("maskInfo"),
      generate: byId("maskGenerate"),
      status: byId("maskStatus"),
      preview: byId("maskPreview"),
      previewGrid: byId("maskPreviewGrid"),
      previewNote: byId("maskPreviewNote"),
    };
    if (!el.panel || !el.frame) return;

    /* 默认那句文案得跟着界面语言走。模块顶层拿不到 window.M8I18n（本文件先于
       i18n.js 执行），所以等到 init 这一步才换成译文。 */
    state.text = T("maskDefaultText", DEFAULT_TEXT);
    if (el.text) el.text.value = state.text;

    el.dirBox.addEventListener("click", function (ev) {
      const b = ev.target.closest ? ev.target.closest("button[data-dir]") : null;
      if (b) setDir(b.dataset.dir);
    });

    el.count.addEventListener("input", function () {
      const n = parseInt(el.count.value, 10) || 3;
      setCount(n);
    });

    el.thick.addEventListener("input", function () {
      const t = parseInt(el.thick.value, 10) || 12;
      setThick(t);
    });

    if (el.text) {
      el.text.addEventListener("input", function () { setText(el.text.value); });
    }

    el.generate.addEventListener("click", generate);

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);

    /* 图片真正解码完再排一次版：容器比例是提前定死的，
       但确切的像素尺寸要等它落地才算得准。 */
    el.source.addEventListener("load", function () { render(); });

    /* 切回这个标签时也重排一次 —— 面板藏着的那些时候容器宽度是 0，
       黑条上的字号会全按兜底值排（这是同一类坑，遮罩这边一起堵上）。 */
    window.addEventListener("m8studio:switch", function (ev) {
      if (!ev || !ev.detail || ev.detail.tool !== "mask") return;
      if (!state.img) return;
      /* 立即试一次，再等一拍补一次 —— 无头浏览器里 rAF 可能等不到渲染帧 */
      render();
      setTimeout(function () { render(); }, 0);
    });

    if (typeof ResizeObserver === "function") {
      let lw = 0;
      let lh = 0;
      const ro = new ResizeObserver(function () {
        if (!state.img) return;
        const r = el.frame.getBoundingClientRect();
        if (Math.abs(r.width - lw) < 1 && Math.abs(r.height - lh) < 1) return;
        lw = r.width;
        lh = r.height;
        render();
      });
      ro.observe(el.frame);
    }

    M8Studio.onImage(useImage);
    setDir("h");
    setCount(state.count);
    setThick(state.thick);
  }

  return {
    init: init,
    state: state,
    setCount: setCount,
    setDir: setDir,
    setThick: setThick,
    setText: setText,
    evenCenters: evenCenters,
    rectOf: rectOf,
    fitText: fitText,
    wrapText: wrapText,
    generate: generate,
    _setImage: function (img, url) { useImage({ img: img, url: url || "" }); },
    _drawTo: drawTo,
    _el: function () { return el; },
  };
})();
