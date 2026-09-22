/* ============================================================================
 * M8web · OC 工坊
 *
 * 每个原创角色一条：左边例图、右边特征词，存在本机 IndexedDB 里，下次打开还在。
 *
 * 用 IndexedDB 而不是 localStorage：例图是一张张 dataURL，localStorage 那 5MB
 * 存两三个就满了，而且它只收字符串。
 *
 * 一个容易忽略的点：**编辑时不能整列重建**。重建会把正在输入的那个 textarea
 * 换掉，光标一丢、字就断了。所以增删才 render()，改动只更新那条的脏标记。
 * ==========================================================================*/

const M8OC = (() => {
  "use strict";

  /* 数据存在服务器文件里：<ComfyUI>/models/M8data/webapp/oc.json。
     以前用 IndexedDB，但那个挂在「源」上 —— CUI 一关源就没了，
     换台机器也看不见。原因详见 app.js 里 M8Api 那段。 */
  const KIND = "oc";
  /* 例图最长边压到这个尺寸：原图动辄几 MB，存几十个就把配额吃光了 */
  const MAX_SIDE = 1024;

  const state = {
    list: [],     // [{ id, name, prompt, image, at, updatedAt }]
    dirty: {},    // id -> true，只活在内存里，不写库
    ready: false,
  };

  let el = {};
  /* 点了「删掉」之后等着确认的那条。确认框只是一种拦截，
     真正落库还是走 removeOne()。 */
  let pendingDelete = -1;

  /* ------------------------------------------------------------ 存储 */

  function storeAvailable() {
    return typeof M8Api !== "undefined" && !!M8Api;
  }

  function loadAll() {
    if (!storeAvailable()) return Promise.resolve([]);
    return M8Api.list(KIND);
  }

  function saveRec(rec) {
    if (!storeAvailable()) return Promise.resolve(null);
    return M8Api.put(KIND, rec).then(function (id) {
      return id === undefined ? null : id;
    }).catch(function () { return null; });
  }

  function dropRec(id) {
    if (!storeAvailable()) return Promise.resolve(false);
    return M8Api.del(KIND, id).catch(function () { return false; });
  }

  /* ------------------------------------------------------------ 小工具 */

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }

  function find(id) {
    for (let i = 0; i < state.list.length; i++) {
      if (state.list[i].id === id) return state.list[i];
    }
    return null;
  }

  /* 例图压一下再存。超大图直接塞进 IndexedDB 会把配额吃光，
     而且展示用的缩略图本来也不需要原尺寸。 */
  function readImage(file) {
    return new Promise(function (resolve) {
      if (!file || !/^image\//.test(file.type || "")) {
        resolve("");
        return;
      }
      const fr = new FileReader();
      fr.onerror = function () { resolve(""); };
      fr.onload = function () {
        const dataUrl = String(fr.result || "");
        const im = new Image();
        im.onerror = function () { resolve(dataUrl); };
        im.onload = function () {
          const w = im.naturalWidth || 0;
          const h = im.naturalHeight || 0;
          if (!w || !h || Math.max(w, h) <= MAX_SIDE) {
            resolve(dataUrl);
            return;
          }
          const k = MAX_SIDE / Math.max(w, h);
          const cv = document.createElement("canvas");
          cv.width = Math.round(w * k);
          cv.height = Math.round(h * k);
          try {
            cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height);
            resolve(cv.toDataURL("image/png"));
          } catch (e) {
            resolve(dataUrl);
          }
        };
        im.src = dataUrl;
      };
      fr.readAsDataURL(file);
    });
  }

  /* 复制到剪贴板。优先用 clipboard API；http 下它不是安全上下文、或者老浏览器里
     根本没有，就退回到临时 textarea + execCommand。 */
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
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand && document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    if (!el.list) return;
    el.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    state.list.forEach(function (rec, i) { frag.appendChild(buildRow(rec, i)); });
    el.list.appendChild(frag);

    if (el.empty) el.empty.classList.toggle("is-hidden", state.list.length > 0);
    if (el.count) {
      el.count.textContent = state.list.length ? state.list.length + " 个 OC" : "还没有 OC";
    }
  }

  function buildRow(rec, index) {
    const row = document.createElement("div");
    row.className = "oc-row" + (state.dirty[rec.id] ? " dirty" : "");
    row.dataset.id = String(rec.id);

    /* --- 左：例图 --- */
    const photo = document.createElement("div");
    photo.className = "oc-photo";
    photo.title = "点一下传例图";
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.style.display = "none";
    input.addEventListener("change", function () {
      const f = input.files && input.files[0];
      input.value = "";
      if (f) setPhoto(rec.id, f);
    });
    photo.appendChild(input);

    if (rec.image) {
      const im = document.createElement("img");
      im.src = rec.image;
      im.alt = (rec.name || "OC " + (index + 1)) + " 的例图";
      photo.appendChild(im);
      const tools = document.createElement("div");
      tools.className = "oc-photo-tools";
      const swap = document.createElement("button");
      swap.type = "button";
      swap.textContent = "换图";
      swap.addEventListener("click", function (ev) {
        ev.stopPropagation();
        input.click();
      });
      const wipe = document.createElement("button");
      wipe.type = "button";
      wipe.textContent = "去掉";
      wipe.addEventListener("click", function (ev) {
        ev.stopPropagation();
        rec.image = "";
        markDirty(rec.id, true);
        saveOne(rec.id);
      });
      tools.appendChild(swap);
      tools.appendChild(wipe);
      photo.appendChild(tools);
    } else {
      const hint = document.createElement("div");
      hint.className = "oc-photo-hint";
      hint.innerHTML = '<span class="plus">＋</span><span>传一张例图</span>';
      photo.appendChild(hint);
    }
    photo.addEventListener("click", function () { input.click(); });
    row.appendChild(photo);

    /* --- 右：名字 + 特征词 --- */
    const body = document.createElement("div");
    body.className = "oc-body";

    const name = document.createElement("input");
    name.className = "oc-name";
    name.type = "text";
    name.value = rec.name || "";
    name.placeholder = "给这个 OC 起个名字";
    name.addEventListener("input", function () { touch(rec.id, { name: name.value }); });
    body.appendChild(name);

    const prompt = document.createElement("textarea");
    prompt.className = "oc-prompt";
    prompt.value = rec.prompt || "";
    prompt.placeholder = "把特征词写在这里：发色、瞳色、服装、体态、画风……";
    prompt.spellcheck = false;
    prompt.addEventListener("input", function () { touch(rec.id, { prompt: prompt.value }); });
    body.appendChild(prompt);

    const tools = document.createElement("div");
    tools.className = "oc-tools";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "primary";
    copy.textContent = "复制特征词";
    copy.addEventListener("click", function () { copyOne(rec.id); });

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", function () { saveOne(rec.id); });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删掉";
    /* 不直接删：先弹确认。一条里可能写着几十个字的特征词和一张例图，
       误点一下就没了。 */
    del.addEventListener("click", function () { askDelete(rec.id); });

    const st = document.createElement("span");
    st.className = "oc-state";
    st.textContent = state.dirty[rec.id] ? "有改动没保存" : "已保存";

    tools.appendChild(copy);
    tools.appendChild(save);
    tools.appendChild(del);
    tools.appendChild(st);
    body.appendChild(tools);
    row.appendChild(body);

    return row;
  }

  /* 只更新那一条的脏标记，不重建整列 ——
     重建会把正在输入的 textarea 换掉，光标一丢字就断了 */
  function markDirty(id, on) {
    state.dirty[id] = !!on;
    if (!el.list) return;
    const row = el.list.querySelector ? el.list.querySelector('[data-id="' + id + '"]') : null;
    if (!row) return;
    row.classList.toggle("dirty", !!on);
    const st = row.querySelector ? row.querySelector(".oc-state") : null;
    if (st) st.textContent = on ? "有改动没保存" : "已保存";
  }

  /* ------------------------------------------------------------ 操作 */

  function touch(id, patch) {
    const rec = find(id);
    if (!rec) return;
    Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
    markDirty(id, true);
  }

  function saveOne(id) {
    const rec = find(id);
    if (!rec) return Promise.resolve(false);
    rec.updatedAt = Date.now();
    return saveRec(rec).then(function () {
      markDirty(id, false);
      setStatus("存好了。");
      return true;
    });
  }

  function copyOne(id) {
    const rec = find(id);
    if (!rec) return;
    const text = rec.prompt || "";
    if (!text) {
      setStatus("这条还没写特征词。", true);
      return;
    }
    copyText(text).then(function () {
      setStatus("特征词复制好了，直接粘去用。");
    }).catch(function () {
      setStatus("复制没成功，手动选一下文本吧。", true);
    });
  }

  function setPhoto(id, file) {
    const rec = find(id);
    if (!rec) return;
    setStatus("正在读图…");
    readImage(file).then(function (dataUrl) {
      if (!dataUrl) {
        setStatus("这张图读不出来。", true);
        return;
      }
      rec.image = dataUrl;
      /* 图直接落盘：它不像文字那样能随手重打，丢了就没了 */
      rec.updatedAt = Date.now();
      return saveRec(rec).then(function () {
        markDirty(id, false);
        refreshRowMedia(id);
        setStatus("例图换好了。");
      });
    });
  }

  /* 换图只动这一条的图片区，不重建整列（免得把隔壁正在输入的内容打断） */
  function refreshRowMedia(id) {
    const rec = find(id);
    if (!rec || !el.list || !el.list.querySelector) return;
    const row = el.list.querySelector('[data-id="' + id + '"]');
    if (!row) return;
    const photo = row.querySelector(".oc-photo");
    if (!photo) return;
    const input = photo.querySelector('input[type="file"]');
    photo.innerHTML = "";
    if (input) photo.appendChild(input);
    const im = document.createElement("img");
    im.src = rec.image;
    im.alt = (rec.name || "OC") + " 的例图";
    photo.appendChild(im);
    const tools = document.createElement("div");
    tools.className = "oc-photo-tools";
    const swap = document.createElement("button");
    swap.type = "button";
    swap.textContent = "换图";
    swap.addEventListener("click", function (ev) {
      ev.stopPropagation();
      if (input) input.click();
    });
    const wipe = document.createElement("button");
    wipe.type = "button";
    wipe.textContent = "去掉";
    wipe.addEventListener("click", function (ev) {
      ev.stopPropagation();
      rec.image = "";
      saveRec(rec).then(function () { render(); });
    });
    tools.appendChild(swap);
    tools.appendChild(wipe);
    photo.appendChild(tools);
  }

  function add() {
    const rec = {
      name: "",
      prompt: "",
      image: "",
      at: Date.now(),
      updatedAt: Date.now(),
    };
    return saveRec(rec).then(function (id) {
      rec.id = typeof id === "number" ? id : (state.list.length ? Math.max.apply(null, state.list.map(function (r) { return r.id; })) + 1 : 1);
      state.list.push(rec);
      render();
      setStatus("加了一条，左边传例图、右边写特征词。");
      return rec;
    });
  }

  /* ------------------------------------------------------------ 删除确认 */

  function askDelete(id) {
    const rec = find(id);
    if (!rec) return;
    pendingDelete = id;
    if (el.delText) {
      /* 名字是用户自己输入的，拼进 HTML 前先转义 —— 不然名字里带个尖括号
         就能把这段结构撕坏。 */
      const who = rec.name ? rec.name : "这一条";
      el.delText.innerHTML =
        '要删掉 <b class="who">「' + esc(who) + '」</b> 吗？' +
        '<span class="sub">删了找不回来。例图和特征词都会一起没掉。</span>';
    }
    if (el.delModal) el.delModal.classList.remove("is-hidden");
    document.body.classList.add("modal-open");
    /* 焦点默认落在「取消」上：这个框弹出来是因为手滑，默认该是「算了」 */
    if (el.delCancel && el.delCancel.focus) el.delCancel.focus();
  }

  function closeDelete() {
    pendingDelete = -1;
    if (el.delModal) el.delModal.classList.add("is-hidden");
    document.body.classList.remove("modal-open");
  }

  function confirmDelete() {
    const id = pendingDelete;
    closeDelete();
    if (id >= 0) removeOne(id);
  }

  function removeOne(id) {
    const rec = find(id);
    if (!rec) return;
    state.list = state.list.filter(function (r) { return r.id !== id; });
    delete state.dirty[id];
    dropRec(id).then(function () { render(); });
    setStatus("删掉了。");
  }

  /* ------------------------------------------------------------ 备份 */

  /* 数据存在浏览器的 IndexedDB 里，而它挂在「源」（scheme + host + port）上。
     更新插件不影响它，但换成 localhost 打开、清浏览器数据、换台机器，就都看不见了。
     导出是唯一能兜住这些的办法。 */

  function backupOut() {
    if (!state.list.length) {
      setStatus("这里还没有东西可以导出。", true);
      return;
    }
    const text = M8Backup.envelope("oc", state.list);
    M8Backup.download(M8Backup.fileNameFor("oc"), text);
    setStatus("导出好了：" + state.list.length + " 个 OC，"
      + M8Backup.fmtSize(text.length) + "。存到一个安全的地方去。");
  }

  /* 连点两次会叠出两个确认框：第二个盖住第一个，关掉之后第一个还杵在那儿。
     导入本来就是重活，直接挡住重入。 */
  function busyModal() {
    return !!(typeof document !== "undefined" && document.querySelector
      && document.querySelector(".modal:not(.is-hidden)"));
  }

  function backupIn() {
    if (busyModal()) return;
    M8Backup.pickFile().then(function (f) {
      if (!f) return null;
      return M8Backup.readText(f).then(function (text) {
        const obj = M8Backup.parse(text);
        if (obj.kind !== "oc") {
          const other = M8Backup.KINDS[obj.kind];
          throw new Error("这份备份是「" + (other ? other.title : obj.kind) + "」的，不是 OC 工坊的。");
        }
        return M8Backup.confirmImport("OC 工坊", obj.data.length, state.list.length)
          .then(function (mode) {
            if (!mode) return null;
            return applyImport(obj.data, mode);
          });
      });
    }).catch(function (e) {
      setStatus(e && e.message ? e.message : "导入失败。", true);
    });
  }

  function applyImport(rows, mode) {
    if (mode === "replace") {
      const old = state.list.slice();
      return Promise.all(old.map(function (r) { return dropRec(r.id); }))
        .then(function () {
          return Promise.all(rows.map(function (r) {
            const c = Object.assign({}, r);
            delete c.id;
            return saveRec(c).then(function (key) { c.id = key; return c; });
          }));
        })
        .then(function (list) {
          state.list = list;
          state.dirty = {};
          render();
          setStatus("替换完成：现在有 " + list.length + " 个 OC。");
        });
    }
    const plan = M8Backup.mergeRows(state.list, rows, function (x) { return x.name; });
    return Promise.all(plan.fresh.map(function (c) {
      return saveRec(c).then(function (key) {
        c.id = key;
        state.list.push(c);
      });
    })).then(function () {
      render();
      setStatus("导入完成：新增 " + plan.fresh.length + " 个，跳过同名的 " + plan.skipped.length + " 个。");
    });
  }

  /* ------------------------------------------------------------ 入口 */

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      list: byId("ocList"),
      empty: byId("ocEmpty"),
      count: byId("ocCount"),
      addBtn: byId("ocAdd"),
      status: byId("ocStatus"),
      backupOut: byId("ocBackupOut"),
      backupIn: byId("ocBackupIn"),
      delModal: byId("ocDelModal"),
      delText: byId("ocDelText"),
      delX: byId("ocDelX"),
      delCancel: byId("ocDelCancel"),
      delOk: byId("ocDelOk"),
    };
    if (!el.list) return;

    el.addBtn.addEventListener("click", function () { add(); });
    if (el.backupOut) el.backupOut.addEventListener("click", backupOut);
    if (el.backupIn) el.backupIn.addEventListener("click", backupIn);

    /* 确认框的几条退出路径：X、取消、点遮罩、Esc */
    if (el.delX) el.delX.addEventListener("click", closeDelete);
    if (el.delCancel) el.delCancel.addEventListener("click", closeDelete);
    if (el.delOk) el.delOk.addEventListener("click", confirmDelete);
    if (el.delModal) {
      el.delModal.addEventListener("click", function (ev) {
        if (ev.target === el.delModal) closeDelete();
      });
    }
    document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      if (!el.delModal || el.delModal.classList.contains("is-hidden")) return;
      closeDelete();
    });

    /* 先渲染一次。IndexedDB 是异步的 —— 等它回来才第一次 render 的话，
       页面会先空白一会儿；它要是慢或者卡住，就一直空白着，
       用户会以为这个功能坏了。空状态本来也该在没数据时立刻显示出来。 */
    render();

    if (!storeAvailable()) {
      setStatus("这个浏览器不给存东西，这次加的内容关掉页面就没了。", true);
      return;
    }

    loadAll().then(function (rows) {
      state.list = (rows || []).filter(Boolean).sort(function (a, b) {
        return (b.at || 0) - (a.at || 0);
      });
      state.ready = true;
      render();
      /* 申请持久化存储：授予之后磁盘紧张时浏览器不会自动清掉这个源的数据。
         没授也不算失败 —— 导出备份那条路照旧管用，只是提醒一句。 */
      if (typeof M8Backup !== "undefined" && M8Backup.requestPersist) {
        M8Backup.requestPersist().then(function (r) {
          if (r && r.granted === false) {
            setStatus("浏览器没给持久化权限：磁盘紧张时这里的数据可能被清掉，记得偶尔导出备份。", true);
          }
        });
      }
    });
  }

  return {
    init: init,
    state: state,
    add: add,
    askDelete: askDelete,
    closeDelete: closeDelete,
    confirmDelete: confirmDelete,
    pendingDelete: function () { return pendingDelete; },
    removeOne: removeOne,
    touch: touch,
    saveOne: saveOne,
    copyOne: copyOne,
    setPhoto: setPhoto,
    copyText: copyText,
    readImage: readImage,
    _render: render,
    _el: function () { return el; },
  };
})();
