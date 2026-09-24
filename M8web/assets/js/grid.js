/* ============================================================================
 * M8web · 图片工坊 / 宫格拼图
 *
 * 导入多张图，按顺序填进 n × n 的格子，合成**一张**拼图。
 *   - 张数 1 ~ 25（5×5 就是上限）
 *   - 网格 1×1 ~ 5×5 任选；导入的张数超出当前格子时会自动换到装得下的最小网格
 *   - 每格按「裁满不留空」填（cover）：保持原图比例、居中裁掉多余的部分，
 *     而不是拉变形 —— 拉变形是拼图里最难看的错法
 *   - 格子不够时留透明，多出来的图不会画进去（缩略图上标灰提示）
 *
 * 这块和工坊里其它功能不一样：它们共用 studio.js 那张单图，
 * 而这里需要一次拿很多张，所以自己管上传。
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

const M8Grid = (() => {
  "use strict";

  const MIN_N = 1;
  const MAX_N = 5;
  const MAX_IMAGES = MAX_N * MAX_N;   // 25
  const CELL = 512;                   // 导出时每格的边长，5×5 出来就是 2560

  const state = {
    images: [],   // [{ id, url, image, w, h }] 顺序就是填格顺序
    n: 3,
    seq: 0,
    shot: "",
    drag: -1,     // 正在拖第几张
    dropAt: -1,   // 松手会插到第几位
    moved: false, // 是否真的移动过（用来把「点击」和「拖拽」分开）
    startX: 0,
    startY: 0,
  };

  let el = {};
  /* 已经交给 Image 去加载、但还没落地的张数。
     不能拿 images.length 加「本批已接受数」来判断上限 —— 图片加载可能是同步完成的
     （测试桩就是），那时 images.length 已经含了本批前面的那些，再加一遍就是重复计数。 */
  let pending = 0;

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function capacity() { return state.n * state.n; }

  /* 只把装得下的那些算进拼图 */
  function usedImages() { return state.images.slice(0, capacity()); }

  /* ------------------------------------------------------------ 裁满一格 */

  /* 把图按比例放大到刚好盖住 w×h，再居中裁。返回要传给 drawImage 的源矩形。 */
  function coverRect(iw, ih, w, h) {
    if (!iw || !ih || !w || !h) return null;
    const k = Math.max(w / iw, h / ih);
    const sw = w / k;
    const sh = h / k;
    return { x: (iw - sw) / 2, y: (ih - sh) / 2, w: sw, h: sh };
  }

  function drawCover(ctx, img, x, y, w, h) {
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const r = coverRect(iw, ih, w, h);
    if (!r) return false;
    ctx.drawImage(img, r.x, r.y, r.w, r.h, x, y, w, h);
    return true;
  }

  /* ------------------------------------------------------------ 导入 */

  function addFiles(files) {
    if (!files || !files.length) return;
    const list = Array.prototype.slice.call(files);
    let skipped = 0;
    let took = 0;

    list.forEach(function (f) {
      if (!f || !/^image\//.test(f.type || "")) { skipped += 1; return; }
      /* 满 25 张就不再收 —— 上限是 5×5 */
      if (state.images.length + pending >= MAX_IMAGES) { skipped += 1; return; }
      took += 1;
      pending += 1;
      const url = URL.createObjectURL(f);
      const im = new Image();
      im.onload = function () {
        pending -= 1;
        state.images.push({
          id: ++state.seq,
          url: url,
          image: im,
          w: im.naturalWidth,
          h: im.naturalHeight,
        });
        autoFit();
        render();
      };
      im.onerror = function () {
        pending -= 1;
        setStatus(T("gridImageBroken", "One image could not be read, so it was skipped."), true);
        try { URL.revokeObjectURL(url); } catch (e) { /* 无所谓 */ }
      };
      im.src = url;
    });

    if (skipped) {
      setStatus(T("gridSkipped",
        "{n} images were not added: either they are not images, or the limit of {max} is already reached.",
        { n: skipped, max: MAX_IMAGES }), true);
    } else if (took) {
      setStatus(T("gridReading", "Reading {n} images...", { n: took }));
    }
  }

  /* 导入后张数超出当前格子时，自动换到装得下的最小网格。
     不然导了 9 张却停在 2×2，用户会以为只认了 4 张。 */
  function autoFit() {
    const need = Math.ceil(Math.sqrt(state.images.length));
    const want = clamp(need, MIN_N, MAX_N);
    if (want > state.n) setNQuiet(want);
  }

  function removeImage(i) {
    if (i < 0 || i >= state.images.length) return;
    const gone = state.images.splice(i, 1)[0];
    if (gone) {
      try { URL.revokeObjectURL(gone.url); } catch (e) { /* 无所谓 */ }
    }
    clearPreview();
    render();
  }

  function clearAll() {
    state.images.forEach(function (im) {
      try { URL.revokeObjectURL(im.url); } catch (e) { /* 无所谓 */ }
    });
    state.images = [];
    el.files.value = "";
    clearPreview();
    render();
    setStatus(T("gridCleared", "Cleared. Pick your images again."));
  }

  /* 把某张往前挪一位（缩略图上点箭头用） */
  function moveImage(i, delta) {
    const j = i + delta;
    if (i < 0 || i >= state.images.length) return;
    if (j < 0 || j >= state.images.length) return;
    const tmp = state.images[i];
    state.images[i] = state.images[j];
    state.images[j] = tmp;
    clearPreview();
    render();
  }

  /* ------------------------------------------------------------ 重排序 */

  /* 把第 from 张挪到第 to 位。用的是**插入**而不是交换：
     「把第 5 张拖到最前面」时，其它图应该顺延一位，而不是跟它互换位置。 */
  function moveTo(from, to) {
    const total = state.images.length;
    if (from < 0 || from >= total) return false;
    const dst = clamp(to, 0, total - 1);
    if (dst === from) return false;
    const item = state.images.splice(from, 1)[0];
    state.images.splice(dst, 0, item);
    clearPreview();
    render();
    setStatus(T("gridMoved", "Moved image {from} to position {to}.", { from: from + 1, to: dst + 1 }));
    return true;
  }

  function indexAt(x, y) {
    const kids = el.thumbs ? el.thumbs.children : [];
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (!r || !r.width) continue;
      if (x >= r.left && x <= r.left + r.width && y >= r.top && y <= r.top + r.height) return i;
    }
    return -1;
  }

  function clearDropMarks() {
    if (!el.thumbs) return;
    Array.prototype.forEach.call(el.thumbs.children, function (k) {
      k.classList.remove("drop-target", "dragging");
    });
  }

  function startDrag(i, ev) {
    if (!state.images.length) return;
    state.drag = i;
    state.dropAt = i;
    state.moved = false;
    state.startX = ev ? ev.clientX : 0;
    state.startY = ev ? ev.clientY : 0;
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  function onMove(ev) {
    if (state.drag < 0) return;
    /* 先看有没有真的动过：没动就当成一次点击，不触发重排，
       否则想点删除按钮时手一抖就把顺序改了。 */
    if (!state.moved) {
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (Math.sqrt(dx * dx + dy * dy) < 6) return;
      state.moved = true;
      const me = el.thumbs.children[state.drag];
      if (me) me.classList.add("dragging");
    }
    const idx = indexAt(ev.clientX, ev.clientY);
    if (idx < 0 || idx === state.dropAt) return;
    state.dropAt = idx;
    Array.prototype.forEach.call(el.thumbs.children, function (k, i) {
      k.classList.toggle("drop-target", i === idx && i !== state.drag);
    });
  }

  function endDrag() {
    if (state.drag < 0) return;
    const from = state.drag;
    const to = state.dropAt;
    const moved = state.moved;
    state.drag = -1;
    state.dropAt = -1;
    state.moved = false;
    clearDropMarks();
    if (!moved || to < 0 || to === from) return;
    moveTo(from, to);
  }

  /* ------------------------------------------------------------ 网格 */

  function setNQuiet(n) {
    state.n = clamp(Math.round(n), MIN_N, MAX_N);
    syncPicker();
  }

  function setN(n) {
    setNQuiet(n);
    clearPreview();
    render();
  }

  function syncPicker() {
    if (!el.picker) return;
    Array.prototype.forEach.call(el.picker.querySelectorAll("button"), function (b) {
      const on = parseInt(b.dataset.n, 10) === state.n;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderBoard();
    renderThumbs();
    updateGenerate();
  }

  /* 预览就是「拼好的样子」：一个 n 列的网格，每格一张 cover 的图。
     比在图上画几条线直观得多 —— 用户要看到的就是最终那张拼图。 */
  function renderBoard() {
    const box = el.board;
    if (!box) return;
    box.innerHTML = "";
    const n = state.n;
    const total = n * n;
    box.style.gridTemplateColumns = "repeat(" + n + ", 1fr)";
    const frag = document.createDocumentFragment();
    for (let i = 0; i < total; i++) {
      const cell = document.createElement("div");
      cell.className = "board-cell";
      const im = state.images[i];
      if (im) {
        const node = document.createElement("img");
        node.src = im.url;
        node.alt = T("gridImageAlt", "Image {n}", { n: i + 1 });
        cell.appendChild(node);
      } else {
        cell.classList.add("empty");
      }
      frag.appendChild(cell);
    }
    box.appendChild(frag);
    if (el.empty) el.empty.classList.toggle("is-hidden", state.images.length > 0);
  }

  function renderThumbs() {
    const box = el.thumbs;
    if (!box) return;
    box.innerHTML = "";
    const total = capacity();
    const frag = document.createDocumentFragment();
    state.images.forEach(function (im, i) {
      const cell = document.createElement("div");
      /* 超出格子的标灰：它们不会出现在拼图里 */
      cell.className = "thumb" + (i >= total ? " over" : "");
      cell.title = T("gridImageAlt", "Image {n}", { n: i + 1 }) +
        (i >= total
          ? T("gridThumbOver", " (outside the grid, so it will not be in the collage)")
          : T("gridThumbSort", " - hold and drag to reorder"));
      cell.addEventListener("pointerdown", function (ev) {
        /* 点在删除钮上就别开始拖，不然想删却把顺序改了 */
        if (ev.target && ev.target.closest && ev.target.closest(".thumb-del")) return;
        startDrag(i, ev);
      });

      const img = document.createElement("img");
      img.src = im.url;
      img.alt = T("gridImageAlt", "Image {n}", { n: i + 1 });
      cell.appendChild(img);

      const no = document.createElement("span");
      no.className = "thumb-no";
      no.textContent = String(i + 1);
      cell.appendChild(no);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "thumb-del";
      del.textContent = "×";
      del.setAttribute("aria-label", T("gridRemoveAria", "Remove image {n}", { n: i + 1 }));
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        removeImage(i);
      });
      cell.appendChild(del);
      frag.appendChild(cell);
    });
    box.appendChild(frag);

    if (el.count) {
      const n = state.images.length;
      el.count.textContent = n + " / " + total
        + (n > total ? T("gridCountOver", " (only the first {n} are used)", { n: total }) : "");
    }
  }

  function updateGenerate() {
    if (!el.generate) return;
    const n = state.n;
    const usable = Math.min(state.images.length, n * n);
    el.generate.disabled = usable === 0;
    el.generate.textContent = usable === 0
      ? T("gridGenerateEmpty", "Import images first")
      : T("gridGenerateSized", "Build the grid ({n}x{n})", { n: n });
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
    const n = state.n;
    const side = n * CELL;
    cv.width = side;
    cv.height = side;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, side, side);
    usedImages().forEach(function (im, i) {
      const r = Math.floor(i / n);
      const c = i % n;
      drawCover(ctx, im.image, c * CELL, r * CELL, CELL, CELL);
    });
    return cv;
  }

  function generate() {
    const usable = Math.min(state.images.length, capacity());
    if (!usable) {
      setStatus(T("gridStatusImportFirst", "Import some images first."), true);
      return;
    }
    clearPreview();
    setStatus(T("gridAssembling", "Assembling..."));
    const cv = document.createElement("canvas");
    drawTo(cv);
    const name = "collage-" + state.n + "x" + state.n + ".png";
    if (typeof cv.toBlob !== "function") {
      setStatus(T("browserNoExport", "This browser cannot export."), true);
      return;
    }
    cv.toBlob(function (blob) {
      if (!blob) { setStatus(T("gridFailed", "Could not build the collage."), true); return; }
      state.shot = URL.createObjectURL(blob);
      showPreview(name, cv.width, cv.height, usable);
    }, "image/png");
  }

  function showPreview(name, w, h, used) {
    const box = el.previewGrid;
    box.innerHTML = "";
    const card = document.createElement("div");
    card.className = "pv-card";
    const shot = document.createElement("div");
    shot.className = "pv-shot";
    const im = document.createElement("img");
    im.src = state.shot;
    im.alt = T("gridPreviewAlt", "Preview of the collage");
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
    save.textContent = T("gridExportImage", "Export this collage");
    card.appendChild(shot);
    card.appendChild(meta);
    card.appendChild(save);
    box.appendChild(card);
    el.preview.classList.remove("is-hidden");
    if (el.previewNote) {
      const n = state.n;
      const empty = n * n - used;
      el.previewNote.textContent = T("gridPreviewNote", "{n}x{n} - {used} images used", { n: n, used: used })
        + (empty > 0 ? T("gridPreviewNoteEmpty", " - {empty} cells left empty", { empty: empty }) : "");
    }
    setStatus(T("gridPreviewReady", "Built. Export it once it looks right."));
  }

  /* ------------------------------------------------------------ 入口 */

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      panel: byId("gridPanel"),
      frame: byId("gridFrame"),
      board: byId("gridBoard"),
      empty: byId("gridEmpty"),
      picker: byId("gridPicker"),
      drop: byId("gridDrop"),
      files: byId("gridFiles"),
      count: byId("gridCount"),
      thumbs: byId("gridThumbs"),
      generate: byId("gridGenerate"),
      clear: byId("gridClear"),
      status: byId("gridStatus"),
      preview: byId("gridPreview"),
      previewGrid: byId("gridPreviewGrid"),
      previewNote: byId("gridPreviewNote"),
    };
    if (!el.panel || !el.frame) return;

    el.picker.addEventListener("click", function (ev) {
      const b = ev.target.closest ? ev.target.closest("button[data-n]") : null;
      if (b) setN(parseInt(b.dataset.n, 10));
    });

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.files) el.files.click();
    });
    el.files.addEventListener("change", function () {
      addFiles(el.files.files);
      /* 清掉 value，同一个文件才能再选一次 */
      el.files.value = "";
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
      const dt = ev.dataTransfer;
      if (dt && dt.files) addFiles(dt.files);
    });

    /* 一次粘好几张也收 */
    document.addEventListener("paste", function (ev) {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          const f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) addFiles(files);
    });

    el.generate.addEventListener("click", generate);
    el.clear.addEventListener("click", clearAll);

    /* 拖拽排序：move/up 都挂 document —— 挂在缩略图上的话，
       指针一移出那一格就断了，拖到隔壁格子是不会生效的。 */
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);

    syncPicker();
    render();
  }

  return {
    init: init,
    state: state,
    setN: setN,
    capacity: capacity,
    usedImages: usedImages,
    coverRect: coverRect,
    addFiles: addFiles,
    removeImage: removeImage,
    moveImage: moveImage,
    moveTo: moveTo,
    startDrag: startDrag,
    onDragMove: onMove,
    endDrag: endDrag,
    clearAll: clearAll,
    generate: generate,
    _drawTo: drawTo,
    _addImage: function (img, url) {
      state.images.push({ id: ++state.seq, url: url || "blob:x", image: img, w: img.naturalWidth, h: img.naturalHeight });
      autoFit();
      render();
    },
    _el: function () { return el; },
  };
})();
