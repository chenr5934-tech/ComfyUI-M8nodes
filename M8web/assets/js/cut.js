/* ============================================================================
 * M8web · 图片工坊 / 分段裁剪
 *
 * 一条规则贯穿全部：段的位置一律用「百分比」表示，不存像素。
 *   cuts[i]  = 第 i 条分割线所在位置的百分比（横切是 y%，竖切是 x%）
 *   muted[i] = 第 i 段是否屏蔽（长度 = 段数，比 cuts 多一个）
 * 这样切方向、缩放窗口、换显示器都不用重算；只有拖拽那一瞬间才需要
 * 拿容器的真实像素去夹边界。
 *
 * 另一个约定：段数 n 对应 n-1 条线。线和段都从这两组数推出来，
 * 任何改动都走 render() 整层重画 —— n 最大才 10，重画比做增量同步可靠得多。
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

const M8Cut = (() => {
  "use strict";

  const MIN_GAP_PX = 26;   // 两条线之间至少留这么多像素，不然圆点叠一起抓不住
  const MIN_SEG_PX = 8;    // 生成时小于这个尺寸的段直接跳过

  const state = {
    img: null,      // 已加载的 Image 对象（要它的 naturalWidth / naturalHeight）
    url: "",        // 预览用的 objectURL，换图时要 revoke
    name: "image",
    dir: "h",       // h = 横切（上下分段），v = 竖切（左右分段）
    count: 3,
    cuts: [],       // 长度 count - 1
    muted: [],      // 长度 count
    drag: -1,       // 正在拖第几条线，-1 表示没在拖
    shots: [],      // 预览产出的 { url, blob, name, w, h, no }
  };

  let el = {};

  /* ------------------------------------------------------------ 小工具 */

  function clampPct(v) { return Math.min(100, Math.max(0, v)); }

  /* 段的边界：count 段就有 count + 1 个边界，首尾固定是 0 和 100 */
  function bounds() {
    return [0].concat(state.cuts).concat([100]);
  }

  /* 把「段占比」换算成原图像素区域。预览显示尺寸、生成裁剪都用这一个地方算。 */
  function segRect(i) {
    const b = bounds();
    const a = b[i];
    const d = b[i + 1];
    const W = state.img ? state.img.naturalWidth : 0;
    const H = state.img ? state.img.naturalHeight : 0;
    let x, y, w, h;
    if (state.dir === "h") {
      x = 0;
      y = Math.round((a / 100) * H);
      w = W;
      h = Math.round((d / 100) * H) - y;
    } else {
      x = Math.round((a / 100) * W);
      y = 0;
      w = Math.round((d / 100) * W) - x;
      h = H;
    }
    /* 取整之后可能出现 0 或者越界，统一夹一下 */
    w = Math.max(0, Math.min(w, W - x));
    h = Math.max(0, Math.min(h, H - y));
    return { x: x, y: y, w: w, h: h };
  }

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  /* ------------------------------------------------------------ 状态改动 */

  /* 段数一变就重新等分。刻意**不**做「保留原来拖过的位置」：
     3 段改 4 段时如果留着旧的两条线，划分会变成 33 / 67 / 75 这种一头宽一头窄；
     更糟的是从少段往上加时，新线会插到旧线前面去，把 cuts 弄成乱序 ——
     段宽随即算出 0 甚至负数。等分的结果永远单调，用户也一眼看得懂。 */
  function setCount(n) {
    state.count = n;
    const cuts = [];
    for (let i = 1; i < n; i++) cuts.push((i / n) * 100);
    state.cuts = cuts;
    const mutes = [];
    for (let i = 0; i < n; i++) mutes.push(!!state.muted[i]);
    state.muted = mutes;
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

  function toggleMute(i) {
    state.muted[i] = !state.muted[i];
    render();
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderLines();
    renderTints();
    renderMutes();
    renderSegList();
    updateGenerate();
  }

  function renderLines() {
    const box = el.lines;
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.cuts.forEach(function (pos, i) {
      const line = document.createElement("div");
      line.className = "cut-line";
      line.dataset.index = String(i);
      if (state.dir === "h") line.style.top = pos + "%";
      else line.style.left = pos + "%";

      const knob = document.createElement("span");
      knob.className = "cut-knob";
      knob.setAttribute("role", "slider");
      knob.setAttribute("tabindex", "0");
      knob.setAttribute("aria-label", T("cutSplitLineAria", "Split line {n}", { n: i + 1 }));
      knob.setAttribute("aria-valuemin", "0");
      knob.setAttribute("aria-valuemax", "100");
      knob.setAttribute("aria-valuenow", String(Math.round(pos)));
      knob.addEventListener("pointerdown", function (ev) { startDrag(i, ev); });
      knob.addEventListener("keydown", function (ev) { onKey(i, ev); });
      line.appendChild(knob);
      frag.appendChild(line);
    });
    box.appendChild(frag);
  }

  function renderTints() {
    const box = el.tints;
    box.innerHTML = "";
    const b = bounds();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.count; i++) {
      const a = b[i];
      const d = b[i + 1];
      const t = document.createElement("div");
      t.className = "cut-tint" + (state.muted[i] ? " on" : "");
      if (state.dir === "h") {
        t.style.top = a + "%";
        t.style.height = (d - a) + "%";
        t.style.left = "0";
        t.style.right = "0";
      } else {
        t.style.left = a + "%";
        t.style.width = (d - a) + "%";
        t.style.top = "0";
        t.style.bottom = "0";
      }
      frag.appendChild(t);
    }
    box.appendChild(frag);
  }

  /* 屏蔽按钮贴在每段旁边（横切在右侧竖排、竖切在上侧横排）。
     对齐不靠像素：每个按钮的 flex 权重就是该段占比，段多高按钮就多高，
     缩放窗口也不会错位。 */
  function renderMutes() {
    const box = el.mutes;
    box.innerHTML = "";
    const b = bounds();
    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.count; i++) {
      const share = Math.max(0.1, b[i + 1] - b[i]);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cut-mute" + (state.muted[i] ? " on" : "");
      btn.style.flex = share + " 1 0";
      btn.dataset.index = String(i);
      btn.setAttribute("aria-pressed", state.muted[i] ? "true" : "false");
      btn.setAttribute("aria-label", T("cutPieceAria", "Piece {n}", { n: i + 1 })
        + (state.muted[i] ? T("cutPieceMuted", ", muted") : T("cutPieceNormal", ", exported as is")));
      const dot = document.createElement("span");
      dot.textContent = state.muted[i] ? "⊘" : "○";
      btn.appendChild(dot);
      btn.addEventListener("click", function () { toggleMute(i); });
      frag.appendChild(btn);
    }
    box.appendChild(frag);
  }

  function renderSegList() {
    const box = el.segList;
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < state.count; i++) {
      const r = segRect(i);
      const li = document.createElement("li");
      if (state.muted[i]) li.className = "off";
      const no = document.createElement("span");
      no.className = "seg-no";
      no.textContent = String(i + 1);
      const size = document.createElement("span");
      size.className = "seg-size";
      size.textContent = r.w + " × " + r.h;
      li.appendChild(no);
      li.appendChild(size);
      frag.appendChild(li);
    }
    box.appendChild(frag);
  }

  function activeIndexes() {
    const out = [];
    for (let i = 0; i < state.count; i++) if (!state.muted[i]) out.push(i);
    return out;
  }

  function updateGenerate() {
    if (!el.generate) return;
    const left = activeIndexes().length;
    el.generate.disabled = !state.img || left === 0;
    el.generate.textContent = left === 0
      ? T("cutAllMuted", "Everything is muted")
      : T("cutGenerateCount", "Generate preview ({n} pieces)", { n: left });
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
    let pos = (raw / size) * 100;

    /* 夹在相邻两条线之间，并且至少留 MIN_GAP_PX 像素 —— 夹的是像素不是百分比：
       横切竖切、窗口大小不同，同样百分比对应到的视觉距离差很远。 */
    const gap = (MIN_GAP_PX / size) * 100;
    const i = state.drag;
    const lo = i === 0 ? 0 : state.cuts[i - 1];
    const hi = i === state.cuts.length - 1 ? 100 : state.cuts[i + 1];
    pos = Math.min(Math.max(pos, lo + gap), hi - gap);
    if (!(pos > lo) || !(pos < hi)) return;

    state.cuts[i] = pos;
    /* 拖的过程中只挪位置，不整层重画 —— 重画会把手上抓着的圆点节点换掉，
       指针就丢了，表现为「拖一下断一下」。 */
    const line = el.lines.children[i];
    if (line) {
      if (state.dir === "h") line.style.top = pos + "%";
      else line.style.left = pos + "%";
      const knob = line.querySelector(".cut-knob");
      if (knob) knob.setAttribute("aria-valuenow", String(Math.round(pos)));
    }
    renderTints();
    renderMutes();
    renderSegList();
  }

  function endDrag() {
    if (state.drag < 0) return;
    state.drag = -1;
    render();
  }

  /* 键盘也能挪：一次 1%，按住 shift 走 5% */
  function onKey(i, ev) {
    const step = ev.shiftKey ? 5 : 1;
    let pos = null;
    if (ev.key === "ArrowUp" || ev.key === "ArrowLeft") pos = state.cuts[i] - step;
    else if (ev.key === "ArrowDown" || ev.key === "ArrowRight") pos = state.cuts[i] + step;
    else if (ev.key === "Home") pos = 0;
    else if (ev.key === "End") pos = 100;
    if (pos === null) return;
    ev.preventDefault();
    const rect = el.frame.getBoundingClientRect();
    const size = state.dir === "h" ? rect.height : rect.width;
    const gap = size ? (MIN_GAP_PX / size) * 100 : 2;
    const lo = i === 0 ? 0 : state.cuts[i - 1];
    const hi = i === state.cuts.length - 1 ? 100 : state.cuts[i + 1];
    state.cuts[i] = Math.min(Math.max(clampPct(pos), lo + gap), hi - gap);
    render();
  }

  /* ------------------------------------------------------------ 图片 */

  /* 图片由 M8Studio 统一管：上传、拖放、粘贴都在那边，工坊里几个功能共用同一张图。
     这边只接「图换了」的通知，然后按当前段数重建分割线。 */
  function useImage(st) {
    state.img = st.img;
    state.url = st.url || "";
    state.name = st.name || "image";
    state.cuts = [];
    state.muted = [];
    clearPreview();
    if (!st.img) {
      el.source.removeAttribute("src");
      render();
      return;
    }
    el.source.src = st.url;
    setCount(parseInt(el.count.value, 10) || 3);
    setStatus(T("cutStatusHint", "Drag the dot on a dashed line to move the split; click the circle beside a piece to mute it."));
  }

  /* ------------------------------------------------------------ 生成 */

  function clearPreview() {
    state.shots.forEach(function (s) {
      try { URL.revokeObjectURL(s.url); } catch (e) { /* 无所谓 */ }
    });
    state.shots = [];
    if (el.previewGrid) el.previewGrid.innerHTML = "";
    if (el.preview) el.preview.classList.add("is-hidden");
    if (el.previewNote) el.previewNote.textContent = "";
  }

  function generate() {
    if (!state.img) return;
    const idx = activeIndexes();
    if (!idx.length) {
      setStatus(T("cutNoExportable", "Every piece is muted, so there is nothing to export."), true);
      return;
    }
    clearPreview();
    setStatus(T("busyGenerating", "Generating..."));

    const total = idx.length;
    let done = 0;

    idx.forEach(function (i) {
      const r = segRect(i);
      if (r.w < MIN_SEG_PX || r.h < MIN_SEG_PX) {
        done += 1;
        return;
      }
      const cv = document.createElement("canvas");
      cv.width = r.w;
      cv.height = r.h;
      const ctx = cv.getContext("2d");
      ctx.drawImage(state.img, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      const name = state.name + "-part-" + (i + 1) + ".png";
      if (typeof cv.toBlob === "function") {
        cv.toBlob(function (blob) {
          if (blob) {
            state.shots.push({
              url: URL.createObjectURL(blob), blob: blob, name: name,
              w: r.w, h: r.h, no: i + 1,
            });
          }
          done += 1;
          if (done === total) finishPreview();
        }, "image/png");
      } else {
        done += 1;
        if (done === total) finishPreview();
      }
    });
  }

  function finishPreview() {
    state.shots.sort(function (a, b) { return a.no - b.no; });
    renderPreview();
    if (!state.shots.length) {
      setStatus(T("cutTooSmall", "Every piece is too small to cut anything usable."), true);
      return;
    }
    el.preview.classList.remove("is-hidden");
    el.previewNote.textContent = T("cutPreviewNote", "{n} images - muted pieces never show up here", { n: state.shots.length });
    setStatus(T("cutPreviewReady", "All done. Download them one by one, or export the lot."));
  }

  function renderPreview() {
    const box = el.previewGrid;
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.shots.forEach(function (s) {
      const card = document.createElement("div");
      card.className = "pv-card";

      const shot = document.createElement("div");
      shot.className = "pv-shot";
      const im = document.createElement("img");
      im.src = s.url;
      im.alt = T("cutPiecePreviewAlt", "Preview of piece {n}", { n: s.no });
      shot.appendChild(im);

      const meta = document.createElement("div");
      meta.className = "pv-meta";
      const tag = document.createElement("span");
      tag.className = "seg-no";
      tag.textContent = String(s.no);
      const size = document.createElement("span");
      size.className = "seg-size";
      size.textContent = s.w + " × " + s.h;
      meta.appendChild(tag);
      meta.appendChild(size);

      const save = document.createElement("a");
      save.className = "pv-save";
      save.href = s.url;
      save.download = s.name;
      save.textContent = T("cutDownloadOne", "Download this piece");

      card.appendChild(shot);
      card.appendChild(meta);
      card.appendChild(save);
      frag.appendChild(card);
    });
    box.appendChild(frag);
  }

  /* 逐个触发下载。浏览器可能弹一次「允许多文件下载」，那是浏览器行为，不是这里能绕的。 */
  function exportAll() {
    const links = el.previewGrid ? el.previewGrid.querySelectorAll(".pv-save") : [];
    if (!links.length) return;
    Array.prototype.forEach.call(links, function (a, i) {
      setTimeout(function () { a.click(); }, i * 220);
    });
  }

  /* ------------------------------------------------------------ 入口 */

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      panel: byId("cutPanel"),
      frame: byId("cutFrame"),
      source: byId("cutSource"),
      tints: byId("cutTints"),
      lines: byId("cutLines"),
      mutes: byId("cutMutes"),
      dirBox: byId("cutDir"),
      count: byId("cutCount"),
      countOut: byId("cutCountOut"),
      segList: byId("cutSegList"),
      generate: byId("cutGenerate"),
      change: byId("cutChange"),
      status: byId("cutStatus"),
      preview: byId("cutPreview"),
      previewGrid: byId("cutPreviewGrid"),
      previewNote: byId("cutPreviewNote"),
      exportBtn: byId("cutExport"),
    };
    if (!el.frame) return;
    el.dirBox.addEventListener("click", function (ev) {
      const b = ev.target.closest ? ev.target.closest("button[data-dir]") : null;
      if (b) setDir(b.dataset.dir);
    });

    el.count.addEventListener("input", function () {
      const n = Math.min(10, Math.max(2, parseInt(el.count.value, 10) || 2));
      el.countOut.textContent = T("cutPieceCount", "{n} pieces", { n: n });
      setCount(n);
    });

    el.generate.addEventListener("click", generate);
    if (el.exportBtn) el.exportBtn.addEventListener("click", exportAll);
    el.change.addEventListener("click", function () { M8Studio.reset(); });
    if (el.exportBtn) el.exportBtn.addEventListener("click", exportAll);

    /* 图片换了就重建分割线。图由 M8Studio 管，这里只订阅它的通知 */
    M8Studio.onImage(useImage);

    /* 拖拽监听挂 document —— 挂圆点上或者画布上的话，指针一移出那块区域
       move 就断了，表现为「拖到边缘卡住，得松开重按」。 */
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);

    el.countOut.textContent = T("cutPieceCount", "{n} pieces", { n: state.count });
    /* 先按段数把分割线建出来，再切方向 —— 不先建的话 cuts 是空数组，
       而 count 已经是 3，两份状态对不上，会渲染出一个横跨整图的「第 1 段」。 */
    setCount(state.count);
    setDir("h");
  }

  return {
    init: init,
    /* 下面这些是给测试用的：直接驱动状态，绕开真实指针事件 */
    state: state,
    setCount: setCount,
    setDir: setDir,
    toggleMute: toggleMute,
    bounds: bounds,
    segRect: segRect,
    activeIndexes: activeIndexes,
    _setImage: function (img, url, name) {
      useImage({ img: img, url: url || "", name: name || "image" });
    },
    _el: function () { return el; },
  };
})();
