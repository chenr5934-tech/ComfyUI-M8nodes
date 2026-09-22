/* ============================================================================
 * M8web · 图片工坊 / 贴纸遮挡
 *
 * 三块东西：
 *   1. 抠图 —— 把和取样色相近的像素变透明（内置的「去同色背景」）
 *   2. 贴纸 —— 处理完的图贴在底图上，可拖、可滚轮缩放、可删除
 *   3. 合成 —— 生成一张新图导出
 *
 * 抠图的像素运算抽成了纯函数 keyPixels()，因为它是最容易写错的一块
 * （容差怎么映射、边缘要不要过渡），纯函数才能单独测。
 * ==========================================================================*/

const M8Sticker = (() => {
  "use strict";

  const MIN_SCALE = 4;
  const MAX_SCALE = 120;
  const DEFAULT_SCALE = 22;
  /* RGB 空间里两个颜色能差多远：sqrt(3 * 255^2) */
  const MAX_DIST = Math.sqrt(3 * 255 * 255);
  /* 抠图预览的画布上限，太大的图缩下来处理，免得卡 */
  const PREVIEW_MAX = 720;

  /* 内置贴纸。是文件不是 dataURL —— 走静态资源加载，不占存储空间，也删不掉。 */
  const BUILTIN = [
    { id: "builtin-default", name: "默认贴纸", url: "../assets/stickers/default-sticker.png", builtin: true },
  ];

  const state = {
    img: null,
    stickers: [],   // 已经贴到画面上的：[{ id, url, image, x, y, scale, ratio }]
    library: [],    // 贴纸库里的：内置那张 + 以前存下来的
    selected: -1,
    drag: null,
    seq: 0,
    shot: "",
  };

  /* 模态框里正在处理的那张图 */
  const draft = {
    image: null,
    url: "",
    base: null,     // 未处理的原始像素。每次都从它重算，不叠加，不会越抠越糊
    target: null,   // 取到的背景色 [r,g,b]
    tol: 32,
    cleared: 0,
  };

  let el = {};

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* ------------------------------------------------------------ 抠图 */

  /* 把和 target 相近的像素抹成透明，返回抹掉多少个像素。
     边缘留一档过渡：不留的话抠出来是一圈硬锯齿，贴到图上很脏。 */
  function keyPixels(data, target, tol) {
    const limit = (clamp(tol, 0, 100) / 100) * MAX_DIST;
    /* 容差拉到 0 时界限就是 0，意思是「只抹和取样色一模一样的像素」。
       这里不能把过渡带兜到 1 —— 那样判定式会变成 dist <= -1，等于什么都不做，
       而用户把容差归零恰恰就是想要最严格的抠法。 */
    const soft = limit > 1 ? limit * 0.18 : 0;
    const tr = target[0];
    const tg = target[1];
    const tb = target[2];
    let cleared = 0;
    for (let i = 0; i < data.length; i += 4) {
      const dr = data[i] - tr;
      const dg = data[i + 1] - tg;
      const db = data[i + 2] - tb;
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      if (dist <= limit - soft) {
        if (data[i + 3] !== 0) { data[i + 3] = 0; cleared += 1; }
      } else if (soft > 0 && dist < limit) {
        /* 过渡带：越靠近边界越接近原样 */
        const k = (dist - (limit - soft)) / soft;
        data[i + 3] = Math.round(data[i + 3] * k);
      }
    }
    return cleared;
  }

  /* ------------------------------------------------------------ 模态 */

  function setTip(text) {
    if (el.keyTip) el.keyTip.textContent = text || "";
  }

  function openModal() {
    el.modal.classList.remove("is-hidden");
    document.body.classList.add("modal-open");
    resetDraft();
    setTip("先选一张贴纸图片。");
  }

  function closeModal() {
    el.modal.classList.add("is-hidden");
    document.body.classList.remove("modal-open");
    resetDraft();
  }

  function resetDraft() {
    if (draft.url) {
      try { URL.revokeObjectURL(draft.url); } catch (e) { /* 无所谓 */ }
    }
    draft.image = null;
    draft.url = "";
    draft.base = null;
    draft.target = null;
    draft.cleared = 0;
    el.file.value = "";
    el.stage.classList.add("is-hidden");
    el.tools.classList.add("is-hidden");
    el.drop.classList.remove("is-hidden");
    el.apply.disabled = true;
    if (el.canvas) {
      el.canvas.width = 1;
      el.canvas.height = 1;
    }
    updateKeyInfo();
  }

  function loadStickerFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setTip("这个文件不是图片。");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      if (draft.url) {
        try { URL.revokeObjectURL(draft.url); } catch (e) { /* 无所谓 */ }
      }
      draft.image = img;
      draft.url = url;
      drawDraft();
      el.drop.classList.add("is-hidden");
      el.stage.classList.remove("is-hidden");
      el.tools.classList.remove("is-hidden");
      el.apply.disabled = false;
      setTip("点图上要去掉的背景色 —— 想换颜色就再点一下。");
    };
    img.onerror = function () {
      setTip("这张图读不出来，换一张。");
      try { URL.revokeObjectURL(url); } catch (e) { /* 无所谓 */ }
    };
    img.src = url;
  }

  /* 把贴纸画进预览画布，并把未处理的像素存下来 */
  function drawDraft() {
    const img = draft.image;
    if (!img) return;
    const nw = img.naturalWidth || img.width || 1;
    const nh = img.naturalHeight || img.height || 1;
    const k = Math.min(1, PREVIEW_MAX / Math.max(nw, nh));
    const w = Math.max(1, Math.round(nw * k));
    const h = Math.max(1, Math.round(nh * k));
    const cv = el.canvas;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    draft.base = ctx.getImageData(0, 0, w, h);
    draft.target = null;
    draft.cleared = 0;
    applyKey();
  }

  /* 每次重算都从 draft.base 出发 —— 在已经抠过的图上再抠会越抠越花 */
  function applyKey() {
    if (!draft.base) return;
    const w = draft.base.width;
    const h = draft.base.height;
    const ctx = el.canvas.getContext("2d");
    const out = ctx.createImageData(w, h);
    out.data.set(draft.base.data);
    draft.cleared = 0;
    if (draft.target) draft.cleared = keyPixels(out.data, draft.target, draft.tol);
    ctx.putImageData(out, 0, 0);
    updateKeyInfo();
  }

  function updateKeyInfo() {
    if (!el.keyInfo) return;
    if (!draft.base) { el.keyInfo.textContent = ""; return; }
    if (!draft.target) {
      el.keyInfo.textContent = "还没取色 —— 抠图不做任何事";
      return;
    }
    el.keyInfo.textContent = "取样 rgb(" + draft.target.join(", ") + ") · 抹掉 " + draft.cleared + " 个像素";
  }

  /* 在画布上点一下取色。必须从 draft.base 取，不能从画布取 ——
     画布上那块背景可能已经被抠成透明了，再取就是黑的。 */
  function pickAt(clientX, clientY) {
    if (!draft.base) return;
    const cv = el.canvas;
    const rect = cv.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = Math.floor(((clientX - rect.left) / rect.width) * cv.width);
    const y = Math.floor(((clientY - rect.top) / rect.height) * cv.height);
    if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) return;
    const i = (y * cv.width + x) * 4;
    const d = draft.base.data;
    draft.target = [d[i], d[i + 1], d[i + 2]];
    applyKey();
    setTip("点别的颜色可以重新取；容差调大能抹掉更多相近色。");
  }

  /* ------------------------------------------------------------ 贴纸库 */

  /* 存储层可能整个不在（隐身模式、老浏览器、Node 测试环境），
     所以一律用这个守卫，而不是直接摸 M8StickerStore —— 那会 ReferenceError。 */
  function storeReady() {
    return typeof M8StickerStore !== "undefined" && !!M8StickerStore && M8StickerStore.available();
  }

  function loadLibrary() {
    state.library = BUILTIN.slice();
    renderLibrary();
    updateLibNote();
    if (!storeReady()) return;
    M8StickerStore.all().then(function (rows) {
      const list = (rows || []).filter(function (r) { return r && r.data; });
      /* 新的排在前面 */
      list.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      list.forEach(function (r) {
        state.library.push({
          id: r.id,
          name: r.name || ("贴纸 " + r.id),
          url: r.data,
          builtin: false,
        });
      });
      renderLibrary();
      updateLibNote();
    });
  }

  function updateLibNote() {
    if (!el.libNote) return;
    const mine = state.library.filter(function (x) { return !x.builtin; }).length;
    if (!storeReady()) {
      el.libNote.textContent = "这个浏览器不给存东西，导入的贴纸这次用完就没了。";
      return;
    }
    el.libNote.textContent = "共 " + state.library.length + " 张 · 我导入的 " + mine +
      " 张（自动存下来，下次还在）";
  }

  function renderLibrary() {
    const box = el.lib;
    if (!box) return;
    box.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.library.forEach(function (item) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "lib-item" + (item.builtin ? " builtin" : "");
      cell.dataset.id = String(item.id);
      cell.title = item.name + (item.builtin ? "（内置）" : " · 点一下贴上去");
      const im = document.createElement("img");
      im.src = item.url;
      im.alt = item.name;
      cell.appendChild(im);
      cell.addEventListener("click", function () { useLibraryItem(item); });
      if (!item.builtin) {
        const del = document.createElement("span");
        del.className = "lib-del";
        del.textContent = "×";
        del.title = "从库里删掉";
        del.addEventListener("click", function (ev) {
          ev.stopPropagation();
          removeLibraryItem(item);
        });
        cell.appendChild(del);
      }
      frag.appendChild(cell);
    });
    box.appendChild(frag);
  }

  function useLibraryItem(item) {
    if (!state.img) {
      setStatus("先选一张底图，再挑贴纸。", true);
      return;
    }
    const im = new Image();
    im.onload = function () { addSticker(im, item.url); };
    im.onerror = function () { setStatus("这张贴纸加载不出来。", true); };
    im.src = item.url;
  }

  /* 存进库。存不下就安静跳过 —— 贴纸已经贴到画面上了，不该因为存储失败而失败。 */
  function saveToLibrary(dataUrl, name) {
    if (!storeReady()) return;
    M8StickerStore.put({
      data: dataUrl,
      name: name || "我的贴纸",
      at: Date.now(),
    }).then(function () { loadLibrary(); });
  }

  function removeLibraryItem(item) {
    if (!item || item.builtin) return;
    if (!storeReady()) return;
    M8StickerStore.remove(item.id).then(function () {
      loadLibrary();
      setStatus("从库里删掉了。");
    });
  }

  /* ------------------------------------------------------------ 备份 */

  /* 贴纸库也存在浏览器的 IndexedDB 里，跟 OC、提示词同一个道理：
     更新插件不动它，但换源、清浏览器数据、换机器就没了。

     只导自己导入的 —— 内置那几张是代码里带的，备份它们没意义。 */

  function backupOut() {
    if (!storeReady()) {
      setStatus("这个浏览器不给存东西，也就没有什么可导出的。", true);
      return;
    }
    M8StickerStore.all().then(function (rows) {
      const list = (rows || []).filter(function (r) { return r && r.data; });
      if (!list.length) {
        setStatus("贴纸库里还没有你自己导入的贴纸（内置那几张不用备份）。", true);
        return;
      }
      const text = M8Backup.envelope("stickers", list);
      M8Backup.download(M8Backup.fileNameFor("stickers"), text);
      setStatus("导出好了：" + list.length + " 张，"
        + M8Backup.fmtSize(text.length) + "。存到一个安全的地方去。");
    });
  }

  /* 连点两次会叠出两个确认框：第二个盖住第一个，关掉之后第一个还杵在那儿。
     导入本来就是重活，直接挡住重入。 */
  function busyModal() {
    return !!(typeof document !== "undefined" && document.querySelector
      && document.querySelector(".modal:not(.is-hidden)"));
  }

  function backupIn() {
    if (busyModal()) return;
    if (!storeReady()) {
      setStatus("这个浏览器不给存东西，导进来也留不住。", true);
      return;
    }
    M8Backup.pickFile().then(function (f) {
      if (!f) return null;
      return M8Backup.readText(f).then(function (text) {
        const obj = M8Backup.parse(text);
        if (obj.kind !== "stickers") {
          const other = M8Backup.KINDS[obj.kind];
          throw new Error("这份备份是「" + (other ? other.title : obj.kind) + "」的，不是贴纸库的。");
        }
        return M8StickerStore.all().then(function (current) {
          const have = (current || []).filter(function (r) { return r && r.data; });
          return M8Backup.confirmImport("贴纸库", obj.data.length, have.length)
            .then(function (mode) {
              if (!mode) return null;
              if (mode === "replace") {
                return M8StickerStore.clear().then(function () {
                  return writeAll(obj.data);
                }).then(function (n) {
                  loadLibrary();
                  setStatus("替换完成：现在有 " + n + " 张。");
                });
              }
              const plan = M8Backup.mergeRows(have, obj.data, function (x) { return x.name; });
              return writeAll(plan.fresh).then(function (n) {
                loadLibrary();
                setStatus("导入完成：新增 " + n + " 张，跳过同名 " + plan.skipped.length + " 张。");
              });
            });
        });
      });
    }).catch(function (e) {
      setStatus(e && e.message ? e.message : "导入失败。", true);
    });
  }

  /* 逐张写回去。id 一律丢掉让库重新分配 —— 备份里的 id 和现在库里的没有关系 */
  function writeAll(rows) {
    const list = rows || [];
    return Promise.all(list.map(function (r) {
      const c = Object.assign({}, r);
      delete c.id;
      return M8StickerStore.put(c);
    })).then(function () { return list.length; });
  }

  /* ------------------------------------------------------------ 贴纸 */

  function updateCount() {
    if (!el.count) return;
    if (!state.img) { el.count.textContent = "还没有贴纸。"; return; }
    if (!state.stickers.length) {
      el.count.textContent = "还没有贴纸。导入一张图片，可以在框里把背景抠掉。";
      return;
    }
    el.count.textContent = state.stickers.length + " 张贴纸 · 导出的是一整张图";
  }

  function addSticker(image, url) {
    state.seq += 1;
    const nw = image.naturalWidth || image.width || 1;
    const nh = image.naturalHeight || image.height || 1;
    state.stickers.push({
      id: state.seq,
      image: image,
      url: url,
      x: 50,
      y: 50,
      scale: DEFAULT_SCALE,
      ratio: nh / nw,
    });
    state.selected = state.stickers.length - 1;
    render();
    setStatus("贴纸加好了，拖它挪位置，滚轮缩放。");
  }

  function removeSticker(i) {
    const idx = i === undefined ? state.selected : i;
    if (idx < 0 || idx >= state.stickers.length) return;
    state.stickers.splice(idx, 1);
    if (!state.stickers.length) state.selected = -1;
    else if (state.selected >= state.stickers.length) state.selected = state.stickers.length - 1;
    render();
    setStatus("删掉了。");
  }

  /* 挪到最上层：几张叠在一起时，越靠后的画在越上面 */
  function moveFront(i) {
    const idx = i === undefined ? state.selected : i;
    if (idx < 0 || idx >= state.stickers.length) return;
    const s = state.stickers.splice(idx, 1)[0];
    state.stickers.push(s);
    state.selected = state.stickers.length - 1;
    render();
  }

  function setScale(v) {
    const s = state.stickers[state.selected];
    if (!s) return;
    s.scale = clamp(v, MIN_SCALE, MAX_SCALE);
    renderLayer();
    renderInspector();
    if (el.scaleOut) el.scaleOut.textContent = Math.round(s.scale) + "%";
    if (el.scale) el.scale.value = String(Math.round(s.scale));
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderLayer();
    renderInspector();
    updateCount();
  }

  function renderLayer() {
    const box = el.layer;
    if (!box) return;
    box.innerHTML = "";
    if (!state.img) return;
    const frag = document.createDocumentFragment();
    state.stickers.forEach(function (s, i) {
      const node = document.createElement("img");
      node.className = "sticker-item" + (i === state.selected ? " on" : "");
      node.src = s.url;
      node.alt = "贴纸 " + (i + 1);
      node.dataset.index = String(i);
      node.style.left = s.x + "%";
      node.style.top = s.y + "%";
      /* 宽度用百分比：跟着底图的显示尺寸走，缩放窗口不会跑偏 */
      node.style.width = s.scale + "%";
      node.draggable = false;
      node.addEventListener("pointerdown", function (ev) { startDrag(i, ev); });
      node.addEventListener("wheel", function (ev) { onWheel(i, ev); }, { passive: false });
      frag.appendChild(node);
    });
    box.appendChild(frag);
  }

  function renderInspector() {
    if (!el.edit) return;
    const s = state.stickers[state.selected];
    const has = !!s;
    el.edit.classList.toggle("is-hidden", !has);
    if (el.empty) el.empty.classList.toggle("is-hidden", has);
    if (!has) return;
    if (el.scaleOut) el.scaleOut.textContent = Math.round(s.scale) + "%";
    if (el.scale) el.scale.value = String(Math.round(s.scale));
  }

  /* ------------------------------------------------------------ 拖与缩放 */

  function startDrag(i, ev) {
    if (!state.img) return;
    if (ev && ev.preventDefault) ev.preventDefault();
    state.selected = i;
    state.drag = i;
    render();
  }

  function onMove(ev) {
    if (state.drag === null || !state.img) return;
    const rect = el.frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const s = state.stickers[state.drag];
    if (!s) return;
    s.x = clamp(((ev.clientX - rect.left) / rect.width) * 100, 0, 100);
    s.y = clamp(((ev.clientY - rect.top) / rect.height) * 100, 0, 100);
    const node = el.layer.children[state.drag];
    if (node) {
      node.style.left = s.x + "%";
      node.style.top = s.y + "%";
    }
  }

  function endDrag() {
    if (state.drag === null) return;
    state.drag = null;
    renderInspector();
  }

  function onWheel(i, ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    const s = state.stickers[i];
    if (!s) return;
    state.selected = i;
    const step = ev && ev.deltaY < 0 ? 1.08 : 1 / 1.08;
    s.scale = clamp(s.scale * step, MIN_SCALE, MAX_SCALE);
    renderLayer();
    renderInspector();
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

  /* 把底图和所有贴纸画到一张画布上。贴纸的尺寸按原图像素算，
     和预览里的百分比是同一套比例。 */
  function drawTo(cv) {
    const W = state.img.naturalWidth;
    const H = state.img.naturalHeight;
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext("2d");
    ctx.drawImage(state.img, 0, 0, W, H);
    state.stickers.forEach(function (s) {
      const w = (W * s.scale) / 100;
      const h = w * s.ratio;
      ctx.drawImage(s.image, (s.x / 100) * W - w / 2, (s.y / 100) * H - h / 2, w, h);
    });
    return cv;
  }

  function generate() {
    if (!state.img) return;
    if (!state.stickers.length) {
      setStatus("还没贴任何贴纸。", true);
      return;
    }
    clearPreview();
    setStatus("正在生成…");
    const cv = document.createElement("canvas");
    drawTo(cv);
    const name = M8Studio.state.name + "-sticker.png";
    if (typeof cv.toBlob !== "function") {
      setStatus("这个浏览器不支持导出。", true);
      return;
    }
    cv.toBlob(function (blob) {
      if (!blob) { setStatus("生成失败。", true); return; }
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
    im.alt = "贴纸遮挡预览";
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
    save.textContent = "导出这张图";
    card.appendChild(shot);
    card.appendChild(meta);
    card.appendChild(save);
    box.appendChild(card);
    el.preview.classList.remove("is-hidden");
    if (el.previewNote) el.previewNote.textContent = state.stickers.length + " 张贴纸已合成";
    setStatus("生成好了，确认没问题就导出。");
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
    /* 换底图就把贴纸清掉：上一张图上的位置对这张没有意义 */
    state.stickers = [];
    state.selected = -1;
    clearPreview();
    if (!st.img) {
      el.base.removeAttribute("src");
      render();
      return;
    }
    el.base.src = st.url;
    el.frame.style.aspectRatio = (st.img.naturalWidth || 1) + " / " + (st.img.naturalHeight || 1);
    render();
    setStatus("");
  }

  function init() {
    el = {
      panel: byId("stickerPanel"),
      frame: byId("stickerFrame"),
      base: byId("stickerBase"),
      layer: byId("stickerLayer"),
      importBtn: byId("stickerImport"),
      count: byId("stickerCount"),
      lib: byId("stickerLib"),
      libNote: byId("stickerLibNote"),
      backupOut: byId("stickerBackupOut"),
      backupIn: byId("stickerBackupIn"),
      empty: byId("stickerEmpty"),
      edit: byId("stickerEdit"),
      scale: byId("stickerScale"),
      scaleOut: byId("stickerScaleOut"),
      front: byId("stickerFront"),
      remove: byId("stickerRemove"),
      generate: byId("stickerGenerate"),
      change: byId("stickerChange"),
      status: byId("stickerStatus"),
      preview: byId("stickerPreview"),
      previewGrid: byId("stickerPreviewGrid"),
      previewNote: byId("stickerPreviewNote"),
      /* 模态 */
      modal: byId("stickerModal"),
      modalX: byId("stickerModalX"),
      drop: byId("stickerDrop"),
      file: byId("stickerFile"),
      stage: byId("keyStage"),
      canvas: byId("stickerCanvas"),
      keyTip: byId("keyTip"),
      tools: byId("keyTools"),
      tol: byId("keyTol"),
      tolOut: byId("keyTolOut"),
      keyReset: byId("keyReset"),
      keyInfo: byId("keyInfo"),
      cancel: byId("stickerCancel"),
      apply: byId("stickerApply"),
    };
    if (!el.panel || !el.frame) return;

    /* --- 模态 --- */
    el.importBtn.addEventListener("click", openModal);
    el.modalX.addEventListener("click", closeModal);
    el.cancel.addEventListener("click", closeModal);
    el.modal.addEventListener("click", function (ev) {
      /* 点遮罩空白处也关掉，但点对话框本身不关 */
      if (ev.target === el.modal) closeModal();
    });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && !el.modal.classList.contains("is-hidden")) closeModal();
    });

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.file) el.file.click();
    });
    el.file.addEventListener("change", function () {
      loadStickerFile(el.file.files && el.file.files[0]);
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
      const files = ev.dataTransfer && ev.dataTransfer.files;
      if (files && files[0]) loadStickerFile(files[0]);
    });

    el.canvas.addEventListener("click", function (ev) { pickAt(ev.clientX, ev.clientY); });
    el.tol.addEventListener("input", function () {
      draft.tol = parseInt(el.tol.value, 10) || 0;
      if (el.tolOut) el.tolOut.textContent = String(draft.tol);
      applyKey();
    });
    el.keyReset.addEventListener("click", function () {
      draft.target = null;
      draft.cleared = 0;
      applyKey();
      setTip("还原了。重新点一下要去掉的背景色。");
    });
    el.apply.addEventListener("click", function () {
      if (!draft.base) return;
      const url = el.canvas.toDataURL("image/png");
      const im = new Image();
      im.onload = function () {
        addSticker(im, url);
        /* 同时存进库，下次打开还在。存储失败不影响这次 —— 图已经贴上了。 */
        saveToLibrary(url);
        closeModal();
      };
      im.src = url;
    });

    if (el.tolOut) el.tolOut.textContent = String(draft.tol);

    /* --- 贴纸 --- */
    el.scale.addEventListener("input", function () {
      setScale(parseInt(el.scale.value, 10) || DEFAULT_SCALE);
    });
    el.front.addEventListener("click", function () { moveFront(); });
    el.remove.addEventListener("click", function () { removeSticker(); });
    el.generate.addEventListener("click", generate);
    el.change.addEventListener("click", function () { M8Studio.reset(); });

    /* 点空白处取消选中 */
    el.frame.addEventListener("pointerdown", function (ev) {
      if (ev.target === el.frame || ev.target === el.base) {
        state.selected = -1;
        render();
      }
    });

    /* Delete / Backspace 删掉选中的贴纸 */
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Delete" && ev.key !== "Backspace") return;
      const t = ev.target;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (state.selected < 0) return;
      ev.preventDefault();
      removeSticker();
    });

    /* 拖拽一律挂 document —— 挂贴纸上，指针一移出去就断 */
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", endDrag);
    document.addEventListener("pointercancel", endDrag);

    if (el.backupOut) el.backupOut.addEventListener("click", backupOut);
    if (el.backupIn) el.backupIn.addEventListener("click", backupIn);

    M8Studio.onImage(useImage);
    render();
    /* 贴纸库是异步读出来的（IndexedDB）：先把内置那张画上，读到了再补齐 */
    loadLibrary();

    /* 申请持久化存储：授予之后磁盘紧张时浏览器不会自动清掉这个源的数据。
       没授也不算失败 —— 导出备份那条路照旧管用，只是提醒一句。 */
    if (typeof M8Backup !== "undefined" && M8Backup.requestPersist) {
      M8Backup.requestPersist().then(function (r) {
        if (r && r.granted === false && el.libNote) {
          el.libNote.textContent = "浏览器没给持久化权限：磁盘紧张时贴纸库可能被清掉，记得偶尔导出备份。";
        }
      });
    }
  }

  return {
    init: init,
    state: state,
    keyPixels: keyPixels,
    addSticker: addSticker,
    removeSticker: removeSticker,
    moveFront: moveFront,
    setScale: setScale,
    generate: generate,
    _setImage: function (img, url) { useImage({ img: img, url: url || "" }); },
    _setSelected: function (i) { state.selected = i; render(); },
    _drawTo: drawTo,
    _draft: draft,
    _openModal: openModal,
    _closeModal: closeModal,
    _loadSticker: loadStickerFile,
    _applyKey: applyKey,
    _pickAt: pickAt,
    _loadLibrary: loadLibrary,
    _renderLibrary: renderLibrary,
    _useLibraryItem: useLibraryItem,
    _saveToLibrary: saveToLibrary,
    _removeLibraryItem: removeLibraryItem,
    _updateKeyInfo: updateKeyInfo,
    _el: function () { return el; },
  };
})();
