/* ============================================================================
 * M8web · 图片工坊的公共部分
 *
 * 工坊下面挂着好几个功能（分段裁剪、分段遮挡、以后还有宫格、贴纸、画笔……）。
 * 它们共用同一张图和同一个上传入口，所以图片的加载、拖放、粘贴、以及
 * 功能标签的切换都收在这里，各功能只管自己那套参数和渲染。
 *
 * 各功能的接入方式：
 *   M8Studio.onImage(function (st) { ... });   // 图片换了就来通知
 *   M8Studio.tool;                             // 当前是哪个功能
 *   M8Studio.switchTo("mask");
 * ==========================================================================*/

const M8Studio = (() => {
  "use strict";

  const state = {
    img: null,     // 加载好的 Image（拿 naturalWidth / naturalHeight）
    url: "",       // objectURL，换图时要 revoke
    name: "image", // 去掉后缀的文件名，导出时当文件名前缀
    tool: "cut",   // 当前功能
  };

  const watchers = [];
  let el = {};

  function onImage(fn) { watchers.push(fn); }
  function notify() { watchers.forEach(function (fn) { fn(state); }); }

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  /* ------------------------------------------------------------ 图片 */

  function loadFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setStatus("这个文件不是图片。", true);
      return;
    }
    if (state.url) {
      try { URL.revokeObjectURL(state.url); } catch (e) { /* 无所谓 */ }
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      state.img = img;
      state.url = url;
      state.name = (file.name || "image").replace(/\.[^.]+$/, "");
      el.drop.classList.add("is-hidden");
      el.body.classList.remove("is-hidden");
      el.fileMeta.textContent = file.name + " · " + img.naturalWidth + " × " + img.naturalHeight;
      setStatus("");
      notify();
    };
    img.onerror = function () {
      setStatus("这张图读不出来，换一张试试。", true);
      try { URL.revokeObjectURL(url); } catch (e) { /* 无所谓 */ }
    };
    img.src = url;
  }

  function reset() {
    if (state.url) {
      try { URL.revokeObjectURL(state.url); } catch (e) { /* 无所谓 */ }
    }
    state.img = null;
    state.url = "";
    el.fileInput.value = "";
    el.fileMeta.textContent = "支持 JPG / PNG / WebP / GIF · 全程在本机处理，不上传";
    el.body.classList.add("is-hidden");
    el.drop.classList.remove("is-hidden");
    setStatus("");
    notify();
  }

  /* ------------------------------------------------------------ 功能切换 */

  function switchTo(tool) {
    if (!tool) return;
    state.tool = tool;
    Array.prototype.forEach.call(el.tabs.querySelectorAll("button"), function (b) {
      const on = b.dataset.tool === tool;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    Array.prototype.forEach.call(el.body.querySelectorAll(".shop-pane"), function (p) {
      p.classList.toggle("is-hidden", p.dataset.pane !== tool);
    });
    /* 通知各功能「轮到你了」。必须发 —— 面板藏着的那些功能拿到的是 0 尺寸，
       凡是按容器像素算字号/位置的地方（文字、遮罩上的字）都会按兜底值排一遍。
       切过来之后重排一次才对。 */
    window.dispatchEvent(new CustomEvent("m8studio:switch", { detail: { tool: tool } }));
  }

  /* ------------------------------------------------------------ 入口 */

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      tabs: byId("shopTabs"),
      drop: byId("studioDrop"),
      fileInput: byId("studioFile"),
      fileMeta: byId("studioFileMeta"),
      body: byId("studioBody"),
      status: byId("studioStatus"),
    };
    if (!el.drop || !el.tabs) return;

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.fileInput) el.fileInput.click();
    });
    el.fileInput.addEventListener("change", function () {
      loadFile(el.fileInput.files && el.fileInput.files[0]);
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
      if (files && files[0]) loadFile(files[0]);
    });

    /* Ctrl+V 直接粘一张图 */
    document.addEventListener("paste", function (ev) {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          const f = items[i].getAsFile();
          if (f) { loadFile(f); break; }
        }
      }
    });

    el.tabs.addEventListener("click", function (ev) {
      const b = ev.target.closest ? ev.target.closest("button[data-tool]") : null;
      if (!b || b.disabled) return;
      switchTo(b.dataset.tool);
    });

    switchTo(state.tool);
  }

  return {
    init: init,
    onImage: onImage,
    loadFile: loadFile,
    reset: reset,
    switchTo: switchTo,
    state: state,
    _el: function () { return el; },
  };
})();
