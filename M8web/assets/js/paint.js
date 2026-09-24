/* ============================================================================
 * M8web · 图片工坊 / 文字与画笔
 *
 * 两个工具：
 *   文字 —— 在图上加字，可拖、可改字号颜色、可加黑边
 *   画笔 —— 按住直接画
 *
 * 一条贯穿全篇的规矩：**位置和尺寸一律存百分比，不存像素**。
 *   文字：x / y 是中心点百分比，size 是「字号占图宽的百分比」
 *   笔画：每个点也是百分比，粗细同样是占图宽的百分比
 * 这样显示尺寸换了（拉窗口、换显示器）、导出成原图尺寸，都能按同一套数换算，
 * 预览和导出才不会一个样。
 *
 * 笔画存的是**路径点**而不是画好的位图：导出时按原图尺寸重画，
 * 放大到 4000px 也是清晰的；直接缩放位图会糊。
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

const M8Paint = (() => {
  "use strict";

  const COLORS = ["#ffffff", "#000000", "#e53e3e", "#d69e2e", "#38a169", "#3182ce", "#805ad5", "#ff5ea8"];
  const FONT = "800 %spx MiSans, 'Microsoft YaHei', 'PingFang SC', sans-serif";
  const LINE_RATIO = 1.2;
  const DEFAULT_TEXT = "Click here to edit";
  const MIN_SIZE = 2;
  const MAX_SIZE = 20;

  const state = {
    img: null,
    mode: "text",        // text | brush
    color: "#ffffff",
    brushWidth: 6,       // 占图宽的百分比
    texts: [],           // [{ id, body, x, y, size, color, outline }]
    selected: -1,
    strokes: [],         // [{ color, width, points: [{x,y}] }]
    drawing: null,
    dragText: -1,
    moved: false,
    startX: 0,
    startY: 0,
    seq: 0,
    retry: 0,       // 容器宽度没就绪时的重试次数
    shot: "",
  };

  let el = {};

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ------------------------------------------------------------ 坐标 */

  function frameRect() {
    return el.frame ? el.frame.getBoundingClientRect() : { width: 0, height: 0, left: 0, top: 0 };
  }

  /* 把指针位置换算成图上的百分比坐标 */
  function pointAt(clientX, clientY) {
    const r = frameRect();
    if (!r.width || !r.height) return { x: 50, y: 50 };
    return {
      x: clamp(((clientX - r.left) / r.width) * 100, 0, 100),
      y: clamp(((clientY - r.top) / r.height) * 100, 0, 100),
    };
  }

  /* 画笔层的内部基准宽度。
     刻意**不**按容器实际像素去设 canvas 尺寸：那要读 getBoundingClientRect，
     而面板藏着的那些时候（或者无头环境里）它返回 0，画出来就是一团错的。
     固定 1200 宽、按图片比例算高，再让 CSS 拉伸铺满 —— 笔画坐标本来就是百分比，
     换算基准是多少都不影响成品；导出时又是按原图尺寸重绘的，清晰度也不受这里影响。 */
  const BASE_W = 1200;

  /* 字号换算：占图片宽度的百分比 → 当前显示宽度下的像素 */
  function px(percent) {
    return (frameRect().width * percent) / 100;
  }

  function baseHeight() {
    const W = state.img ? state.img.naturalWidth : 1;
    const H = state.img ? state.img.naturalHeight : 1;
    return Math.max(1, Math.round((BASE_W * H) / Math.max(1, W)));
  }

  /* ------------------------------------------------------------ 文字 */

  function addText(x, y) {
    state.seq += 1;
    const t = {
      id: state.seq,
      body: T("paintDefaultText", DEFAULT_TEXT),
      x: x === undefined ? 50 : x,
      y: y === undefined ? 50 : y,
      size: 7,
      color: state.color,
      outline: true,
    };
    state.texts.push(t);
    state.selected = state.texts.length - 1;
    render();
    setStatus(T("paintAdded", "Added. Edit it on the right, or drag it on the image to move it."));
    return t;
  }

  function currentText() {
    return state.texts[state.selected] || null;
  }

  function updateText(patch) {
    const t = currentText();
    if (!t) return;
    Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    render();
  }

  function removeText(i) {
    const idx = i === undefined ? state.selected : i;
    if (idx < 0 || idx >= state.texts.length) return;
    state.texts.splice(idx, 1);
    if (!state.texts.length) state.selected = -1;
    else if (state.selected >= state.texts.length) state.selected = state.texts.length - 1;
    render();
    setStatus(T("paintRemoved", "That text box was deleted."));
  }

  /* ------------------------------------------------------------ 画笔 */

  function startStroke(ev) {
    if (state.mode !== "brush") return;
    const p = pointAt(ev.clientX, ev.clientY);
    state.drawing = { color: state.color, width: state.brushWidth, points: [p] };
    state.strokes.push(state.drawing);
    renderStrokes();
  }

  function continueStroke(ev) {
    if (!state.drawing) return;
    state.drawing.points.push(pointAt(ev.clientX, ev.clientY));
    renderStrokes();
  }

  function endStroke() {
    if (!state.drawing) return;
    if (state.drawing.points.length < 1) {
      state.strokes.pop();
    }
    state.drawing = null;
  }

  function undoStroke() {
    if (!state.strokes.length) {
      setStatus(T("paintNoUndo", "There is no stroke left to undo."));
      return;
    }
    state.strokes.pop();
    renderStrokes();
    setStatus(T("paintUndone", "Undid one stroke."));
  }

  function clearStrokes() {
    state.strokes = [];
    state.drawing = null;
    renderStrokes();
    setStatus(T("paintStrokesCleared", "All strokes cleared."));
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderTools();
    renderColors();
    renderTexts();
    renderStrokes();
    syncInputs();
  }

  function renderTools() {
    if (el.textTools) el.textTools.classList.toggle("is-hidden", state.mode !== "text");
    if (el.brushTools) el.brushTools.classList.toggle("is-hidden", state.mode !== "brush");
    if (el.modeBox) {
      Array.prototype.forEach.call(el.modeBox.querySelectorAll("button"), function (b) {
        const on = b.dataset.mode === state.mode;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    if (el.frame) el.frame.dataset.mode = state.mode;
  }

  function renderColors() {
    const box = el.colors;
    if (!box) return;
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    COLORS.forEach(function (c) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch" + (c === state.color ? " on" : "");
      b.style.background = c;
      b.dataset.color = c;
      b.setAttribute("aria-label", T("paintColorAria", "Colour {c}", { c: c }));
      b.setAttribute("aria-pressed", c === state.color ? "true" : "false");
      b.addEventListener("click", function () {
        state.color = c;
        /* 选中的文字跟着换色，不然点了色板没反应会以为坏了 */
        const t = currentText();
        if (t && state.mode === "text") t.color = c;
        render();
      });
      frag.appendChild(b);
    });
    box.appendChild(frag);
  }

  function renderTexts() {
    const box = el.layer;
    if (!box) return;
    box.innerHTML = "";
    if (!state.img) return;
    /* 容器宽度还没就绪（面板刚显示 / 刚切过来）就先不画 ——
       按 0 算出来的字号全是下限值。等一拍再试，试几次还不给就放弃，
       免得变成无限递归。切过来时 m8studio:switch、尺寸变了 ResizeObserver
       也都会再喊一次 render。 */
    if (!frameRect().width) {
      if (state.retry < 10) {
        state.retry += 1;
        setTimeout(function () { render(); }, 16);
      }
      return;
    }
    state.retry = 0;
    const frag = document.createDocumentFragment();
    state.texts.forEach(function (t, i) {
      const node = document.createElement("div");
      node.className = "paint-text" + (i === state.selected ? " on" : "") + (t.outline ? " outline" : "");
      node.textContent = t.body || T("paintEmptyText", "(empty)");
      node.dataset.index = String(i);
      node.style.left = t.x + "%";
      node.style.top = t.y + "%";
      node.style.color = t.color;
      /* 字号 = 显示宽度 × 百分比，和 canvas 那边 W × size / 100 是同一套数 */
      node.style.fontSize = Math.max(8, px(t.size)) + "px";
      node.style.lineHeight = String(LINE_RATIO);
      node.addEventListener("pointerdown", function (ev) {
        if (state.mode !== "text") return;
        ev.stopPropagation();
        startDrag(i, ev);
      });
      frag.appendChild(node);
    });
    box.appendChild(frag);
  }

  /* 笔画每次都从路径重画一遍内容。存路径而不是存位图，导出时才能按原图尺寸重绘。 */
  function renderStrokes() {
    const cv = el.canvas;
    if (!cv) return;
    const h = baseHeight();
    if (cv.width !== BASE_W || cv.height !== h) {
      cv.width = BASE_W;
      cv.height = h;
    }
    const w = BASE_W;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    state.strokes.forEach(function (s) {
      paintStroke(ctx, s, w, h);
    });
  }

  /* 一条笔画。canvas 和导出共用这一个函数，所以样子肯定一致。 */
  function paintStroke(ctx, s, w, h) {
    if (!s.points.length) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(1, (w * s.width) / 100);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    s.points.forEach(function (p, i) {
      const x = (p.x / 100) * w;
      const y = (p.y / 100) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    /* 单点也画成一个圆点，不然点一下什么都没有 */
    if (s.points.length === 1) {
      const p = s.points[0];
      ctx.arc((p.x / 100) * w, (p.y / 100) * h, Math.max(1, (w * s.width) / 200), 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
      return;
    }
    ctx.stroke();
  }

  function syncInputs() {
    const t = currentText();
    if (el.body) el.body.value = t ? t.body : "";
    if (el.body) el.body.disabled = !t;
    if (el.size) el.size.value = String(t ? t.size : 7);
    if (el.sizeOut) el.sizeOut.textContent = (t ? t.size : 7) + "%";
    if (el.outline) el.outline.checked = t ? !!t.outline : true;
    if (el.removeBtn) el.removeBtn.disabled = !t;
    if (el.width) el.width.value = String(state.brushWidth);
    if (el.widthOut) el.widthOut.textContent = String(state.brushWidth);
  }

  /* ------------------------------------------------------------ 拖文字 */

  function startDrag(i, ev) {
    state.selected = i;
    state.dragText = i;
    state.moved = false;
    state.startX = ev ? ev.clientX : 0;
    state.startY = ev ? ev.clientY : 0;
    if (ev && ev.preventDefault) ev.preventDefault();
    render();
  }

  function onMove(ev) {
    if (state.dragText < 0) return;
    const t = state.texts[state.dragText];
    if (!t) return;
    if (!state.moved) {
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (Math.sqrt(dx * dx + dy * dy) < 4) return;
      state.moved = true;
    }
    const p = pointAt(ev.clientX, ev.clientY);
    t.x = p.x;
    t.y = p.y;
    /* 拖动时只挪这一个节点的位置，不整层重画 —— 重画会把手上抓着的节点换掉 */
    const node = el.layer.children[state.dragText];
    if (node) {
      node.style.left = t.x + "%";
      node.style.top = t.y + "%";
    }
  }

  function endDrag() {
    if (state.dragText < 0) return;
    state.dragText = -1;
    state.moved = false;
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

  /* 画一行文字，可带黑边。多行时以 (x,y) 为中心上下摊开。 */
  function paintText(ctx, t, W, H) {
    const body = String(t.body == null ? "" : t.body);
    if (!body) return;
    const size = Math.max(6, (W * t.size) / 100);
    const lines = body.split("\n");
    const lh = size * LINE_RATIO;
    const cx = (t.x / 100) * W;
    const cy = (t.y / 100) * H;
    const top = cy - ((lines.length - 1) * lh) / 2;
    ctx.font = FONT.replace("%s", String(Math.round(size)));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    lines.forEach(function (line, i) {
      const y = top + i * lh;
      if (t.outline) {
        ctx.lineWidth = Math.max(2, size * 0.16);
        ctx.strokeStyle = "rgba(0, 0, 0, 0.88)";
        ctx.strokeText(line, cx, y);
      }
      ctx.fillStyle = t.color;
      ctx.fillText(line, cx, y);
    });
  }

  function drawTo(cv) {
    const W = state.img.naturalWidth;
    const H = state.img.naturalHeight;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(state.img, 0, 0, W, H);
    /* 笔画按原图尺寸重绘：路径是矢量信息，放大不会糊 */
    state.strokes.forEach(function (s) { paintStroke(ctx, s, W, H); });
    state.texts.forEach(function (t) { paintText(ctx, t, W, H); });
    return cv;
  }

  function generate() {
    if (!state.img) return;
    if (!state.strokes.length && !state.texts.length) {
      setStatus(T("paintNothing", "Nothing written and nothing drawn, so there is nothing to generate."), true);
      return;
    }
    clearPreview();
    setStatus(T("busyGenerating", "Generating..."));
    const cv = document.createElement("canvas");
    drawTo(cv);
    const name = M8Studio.state.name + "-paint.png";
    if (typeof cv.toBlob !== "function") {
      setStatus(T("browserNoExport", "This browser cannot export."), true);
      return;
    }
    cv.toBlob(function (blob) {
      if (!blob) { setStatus(T("generateFailed", "Generation failed."), true); return; }
      state.shot = URL.createObjectURL(blob);
      showPreview(name, cv.width, cv.height);
    }, "image/png");
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
    im.alt = T("paintPreviewAlt", "Preview of the text and brush layers");
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
      el.previewNote.textContent = T("paintPreviewNote", "{texts} text boxes - {strokes} strokes",
        { texts: state.texts.length, strokes: state.strokes.length });
    }
    setStatus(T("previewReadyExport", "Done. Export it once it looks right."));
  }

  /* ------------------------------------------------------------ 入口 */

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function setMode(mode) {
    if (mode !== "text" && mode !== "brush") return;
    state.mode = mode;
    state.drawing = null;
    render();
  }

  function byId(id) { return document.getElementById(id); }

  function useImage(st) {
    state.img = st.img;
    state.texts = [];
    state.strokes = [];
    state.selected = -1;
    state.drawing = null;
    clearPreview();
    if (!st.img) {
      el.base.removeAttribute("src");
      render();
      return;
    }
    el.base.src = st.url;
    el.frame.style.aspectRatio = (st.img.naturalWidth || 1) + " / " + (st.img.naturalHeight || 1);
    render();
    setStatus(T("paintStatusHint", "In text mode, click to add a box; switch to brush mode and hold to draw."));
  }

  function init() {
    el = {
      panel: byId("paintPanel"),
      frame: byId("paintFrame"),
      base: byId("paintBase"),
      canvas: byId("paintCanvas"),
      layer: byId("textLayer"),
      modeBox: byId("paintMode"),
      textTools: byId("textTools"),
      brushTools: byId("brushTools"),
      addBtn: byId("textAdd"),
      body: byId("textBody"),
      size: byId("textSize"),
      sizeOut: byId("textSizeOut"),
      outline: byId("textOutline"),
      removeBtn: byId("textRemove"),
      width: byId("brushWidth"),
      widthOut: byId("brushWidthOut"),
      undoBtn: byId("brushUndo"),
      clearBtn: byId("brushClear"),
      colors: byId("paintColors"),
      generate: byId("paintGenerate"),
      change: byId("paintChange"),
      status: byId("paintStatus"),
      preview: byId("paintPreview"),
      previewGrid: byId("paintPreviewGrid"),
      previewNote: byId("paintPreviewNote"),
    };
    if (!el.panel || !el.frame) return;

    el.modeBox.addEventListener("click", function (ev) {
      const b = ev.target.closest ? ev.target.closest("button[data-mode]") : null;
      if (b) setMode(b.dataset.mode);
    });

    el.addBtn.addEventListener("click", function () { addText(); });
    el.body.addEventListener("input", function () { updateText({ body: el.body.value }); });
    el.size.addEventListener("input", function () {
      updateText({ size: parseInt(el.size.value, 10) || 7 });
    });
    el.outline.addEventListener("change", function () {
      updateText({ outline: !!el.outline.checked });
    });
    el.removeBtn.addEventListener("click", function () { removeText(); });

    el.width.addEventListener("input", function () {
      state.brushWidth = parseInt(el.width.value, 10) || 6;
      if (el.widthOut) el.widthOut.textContent = String(state.brushWidth);
    });
    el.undoBtn.addEventListener("click", undoStroke);
    el.clearBtn.addEventListener("click", clearStrokes);

    el.generate.addEventListener("click", generate);
    el.change.addEventListener("click", function () { M8Studio.reset(); });

    /* 画布上的按下：画笔模式开始画，文字模式在空白处加一条 */
    el.frame.addEventListener("pointerdown", function (ev) {
      if (!state.img) return;
      if (ev.target.closest && ev.target.closest(".paint-text")) return;
      if (state.mode === "brush") {
        ev.preventDefault();
        startStroke(ev);
        return;
      }
      /* 文字模式：点空白处就加一条在点的位置 */
      if (ev.target === el.frame || ev.target === el.base || ev.target === el.canvas) {
        addText(ev.clientX === undefined ? 50 : pointAt(ev.clientX, ev.clientY).x,
                ev.clientY === undefined ? 50 : pointAt(ev.clientX, ev.clientY).y);
      }
    });

    /* 全都挂 document：挂在画布上的话，指针一移出去笔画就断了 */
    document.addEventListener("pointermove", function (ev) {
      if (state.drawing) continueStroke(ev);
      else onMove(ev);
    });
    document.addEventListener("pointerup", function () {
      endStroke();
      endDrag();
    });
    document.addEventListener("pointercancel", function () {
      endStroke();
      endDrag();
    });

    /* 窗口尺寸变了要按新尺寸重排文字和笔画（它们是按百分比存的，得重算像素） */
    window.addEventListener("resize", function () {
      if (state.img) render();
    });

    /* 切回这个标签时重排一遍：藏着的那些时候容器尺寸是 0，算出来的都是兜底值。
       注意事件是同步派发的 —— 这一刻浏览器还没重排，量到的宽度仍是 0，
       所以要等一帧。 */
    window.addEventListener("m8studio:switch", function (ev) {
      if (!ev || !ev.detail || ev.detail.tool !== "paint") return;
      if (!state.img) return;
      /* 立即试一次，再等一拍补一次。
         用 setTimeout 而不是 requestAnimationFrame：无头浏览器里 rAF 要等渲染帧，
         它可能压根不来；而读 getBoundingClientRect 会强制同步重排，
         setTimeout 的回调里读到的尺寸一定是准的。 */
      render();
      setTimeout(function () { render(); }, 0);
    });

    /* 兜底：容器尺寸一变就重排。上面那条等一帧只覆盖「切标签」这一种情况，
       面板因为别的原因变宽变窄（侧栏收起、窗口拉伸、字体加载完）它就管不着了。 */
    if (typeof ResizeObserver === "function") {
      let lastW = 0;
      let lastH = 0;
      const ro = new ResizeObserver(function () {
        if (!state.img) return;
        const r = frameRect();
        /* 只在尺寸真的变了才重排 —— render 会改 DOM，不设闸门会自己触发自己 */
        if (Math.abs(r.width - lastW) < 1 && Math.abs(r.height - lastH) < 1) return;
        lastW = r.width;
        lastH = r.height;
        render();
      });
      ro.observe(el.frame);
    }

    M8Studio.onImage(useImage);
    render();
  }

  return {
    init: init,
    state: state,
    setMode: setMode,
    addText: addText,
    updateText: updateText,
    removeText: removeText,
    undoStroke: undoStroke,
    clearStrokes: clearStrokes,
    pointAt: pointAt,
    paintStroke: paintStroke,
    paintText: paintText,
    drawTo: drawTo,
    generate: generate,
    _setImage: function (img, url) { useImage({ img: img, url: url || "" }); },
    _startStroke: startStroke,
    _continueStroke: continueStroke,
    _endStroke: endStroke,
    _el: function () { return el; },
  };
})();
