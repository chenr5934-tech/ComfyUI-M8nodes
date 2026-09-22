/* ============================================================================
 * M8web · 提示词归纳
 *
 * 一张卡 = 一条概念提示词（构图、光影、质感、画风这种），带名字和备注，
 * 并且归到一个分类里。内容存在本机 IndexedDB，下次打开还在。
 *
 * 和 OC 工坊的区别：那边一条对应一个角色（要配例图），这边是纯文本，
 * 所以多了「分类」这一层 —— 分类本身也是一条记录，单独一个 store，
 * 这样新建了还没放东西的空分类也能留住。
 *
 * 两个还是一样的铁规矩：
 *   1. 用 IndexedDB，不用 localStorage。卡片会越攒越多，localStorage 那 5MB 撑不住。
 *   2. **编辑时不能整列重建**。重建会把正在输入的 textarea 换掉，光标一丢字就断了。
 *      所以只有增删和切分类才 render()，改动只更新那一条的脏标记。
 *
 * groupId 的约定：0 = 未分类。IndexedDB 的 autoIncrement 从 1 开始，
 * 所以 0 这个值不会和任何真分类撞上。
 * ==========================================================================*/

const M8Prompts = (() => {
  "use strict";

  /* 数据存在服务器文件里：<ComfyUI>/models/M8data/webapp/{prompts,groups}.json。
     以前用 IndexedDB，但那个挂在「源」上 —— CUI 一关源就没了，换台机器也看不见。
     原因详见 app.js 里 M8Api 那段。

     这两个名字要和后端的 KINDS 对齐（oc / prompts / groups / stickers）。 */
  const CARDS = "prompts";
  const GROUPS = "groups";
  /* 例图最长边压到这个尺寸：原图动辄几 MB，存几十张就把配额吃光了 */
  const MAX_SIDE = 1024;

  /* 筛选用的：null = 全部，0 = 未分类，其他 = 具体分类的 id */
  const FILTER_ALL = null;
  const FILTER_NONE = 0;

  const state = {
    cards: [],
    groups: [],
    filter: FILTER_ALL,
    dirty: {},
    ready: false,
  };

  let el = {};
  /* 点了「删掉」之后等着确认的那个。确认框只是拦截，真正落库还是走 dropCard/dropGroup */
  let pendingCard = -1;
  let pendingGroup = -1;
  /* 改名弹窗回调。项目里别处没用 window.prompt —— 那个在无头浏览器里直接返回 null，
     而且样式不受控，所以这里用自己的一层弹窗。 */
  let nameOnOk = null;

  /* ------------------------------------------------------------ 存储 */

  function storeAvailable() {
    return typeof M8Api !== "undefined" && !!M8Api;
  }

  function loadCards() {
    if (!storeAvailable()) return Promise.resolve([]);
    return M8Api.list(CARDS);
  }
  function loadGroups() {
    if (!storeAvailable()) return Promise.resolve([]);
    return M8Api.list(GROUPS);
  }
  /* 存一条。返回最终的 id（拿不到就是 null）—— 调用方靠它判断有没有存上 */
  function saveCard(rec) {
    if (!storeAvailable()) return Promise.resolve(null);
    return M8Api.put(CARDS, rec).then(function (id) {
      return id === undefined ? null : id;
    }).catch(function () { return null; });
  }
  function saveGroup(rec) {
    if (!storeAvailable()) return Promise.resolve(null);
    return M8Api.put(GROUPS, rec).then(function (id) {
      return id === undefined ? null : id;
    }).catch(function () { return null; });
  }
  function dropCard(id) {
    if (!storeAvailable()) return Promise.resolve(false);
    return M8Api.del(CARDS, id).catch(function () { return false; });
  }
  function dropGroup(id) {
    if (!storeAvailable()) return Promise.resolve(false);
    return M8Api.del(GROUPS, id).catch(function () { return false; });
  }

  /* ------------------------------------------------------------ 派生（纯函数） */

  function groupOf(rec) {
    const g = rec && rec.groupId;
    return typeof g === "number" && g > 0 ? g : 0;
  }

  function countIn(cards, gid) {
    let n = 0;
    for (let i = 0; i < cards.length; i++) {
      if (groupOf(cards[i]) === gid) n++;
    }
    return n;
  }

  /* filter 传 null 就是不过滤。注意别写成「假值就不过滤」——
     0 恰好是「未分类」，那样筛未分类会失效。 */
  function filterCards(cards, filter) {
    if (filter === null || filter === undefined) return cards.slice();
    return cards.filter(function (c) { return groupOf(c) === filter; });
  }

  function groupNameOf(groups, gid) {
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].id === gid) return groups[i].name || "";
    }
    return "";
  }

  /* 分类重名会让下拉框分不清，所以自动加个后缀 */
  function uniqueName(groups, base) {
    const want = String(base || "新分类").trim() || "新分类";
    let name = want;
    let n = 2;
    while (groups.some(function (g) { return (g.name || "") === name; })) {
      name = want + " " + n;
      n++;
    }
    return name;
  }

  /* ------------------------------------------------------------ 小工具 */

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function byId(id) { return document.getElementById(id); }

  function findCard(id) {
    for (let i = 0; i < state.cards.length; i++) {
      if (state.cards[i].id === id) return state.cards[i];
    }
    return null;
  }

  function findGroup(id) {
    for (let i = 0; i < state.groups.length; i++) {
      if (state.groups[i].id === id) return state.groups[i];
    }
    return null;
  }

  /* 例图压一下再存。超大图直接塞进 IndexedDB 会把配额吃光，
     而且卡片左边那块也就两百来像素，原尺寸没必要。 */
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
      } catch (e) { reject(e); }
    });
  }

  function now() { return Date.now(); }

  /* ------------------------------------------------------------ 渲染 */

  function render() {
    renderGroups();
    renderCards();
    if (el.count) {
      const n = state.cards.length;
      el.count.textContent = n ? "一共 " + n + " 张" : "";
    }
  }

  function chip(label, value, count, removable) {
    const box = document.createElement("span");
    box.className = "pg-chip" + (state.filter === value ? " is-on" : "");

    const b = document.createElement("button");
    b.type = "button";
    b.className = "pg-chip-btn";
    const t = document.createElement("span");
    t.textContent = label;
    const num = document.createElement("em");
    num.className = "pg-chip-num";
    num.textContent = String(count);
    b.appendChild(t);
    b.appendChild(num);
    b.addEventListener("click", function () {
      state.filter = value;
      render();
    });
    box.appendChild(b);

    if (removable) {
      const x = document.createElement("button");
      x.type = "button";
      x.className = "pg-chip-x";
      x.title = "删掉这个分类（里面的卡片会变成未分类）";
      x.textContent = "×";
      x.addEventListener("click", function (ev) {
        ev.stopPropagation();
        askDeleteGroup(value, label);
      });
      box.appendChild(x);
    }
    return box;
  }

  function renderGroups() {
    if (!el.groups) return;
    el.groups.innerHTML = "";

    el.groups.appendChild(chip("全部", FILTER_ALL, state.cards.length, false));
    state.groups.forEach(function (g) {
      const c = chip(g.name || "未命名", g.id, countIn(state.cards, g.id), true);
      /* 双击分类名就地改名 */
      const btn = c.querySelector(".pg-chip-btn");
      if (btn) {
        btn.title = "点一下筛选，双击改名字";
        btn.addEventListener("dblclick", function (ev) {
          ev.stopPropagation();
          askRenameGroup(g.id);
        });
      }
      el.groups.appendChild(c);
    });
    el.groups.appendChild(chip("未分类", FILTER_NONE, countIn(state.cards, FILTER_NONE), false));

    const add = document.createElement("button");
    add.type = "button";
    add.className = "pg-add";
    add.id = "pgAddGroup";
    add.textContent = "＋ 新建分类";
    add.addEventListener("click", newGroup);
    el.groups.appendChild(add);
  }

  function renderCards() {
    if (!el.list) return;
    el.list.innerHTML = "";
    const list = filterCards(state.cards, state.filter);

    if (!list.length) {
      if (el.empty) el.empty.classList.remove("is-hidden");
    } else if (el.empty) {
      el.empty.classList.add("is-hidden");
    }
    list.forEach(function (rec) { el.list.appendChild(buildCard(rec)); });
  }

  /* 左：例图。换图和去掉之后要能只重建这一块，所以单独拎出来。 */
  function buildPhoto(rec) {
    const photo = document.createElement("div");
    photo.className = "pg-photo";
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
      im.alt = (rec.name || "这张卡") + " 的例图";
      photo.appendChild(im);

      const tools = document.createElement("div");
      tools.className = "pg-photo-tools";

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
        rec.updatedAt = now();
        saveCard(rec).then(function () {
          refreshRowMedia(rec.id);
          setStatus("例图去掉了。");
        });
      });

      tools.appendChild(swap);
      tools.appendChild(wipe);
      photo.appendChild(tools);
    } else {
      const hint = document.createElement("div");
      hint.className = "pg-photo-hint";
      const plus = document.createElement("span");
      plus.className = "plus";
      plus.textContent = "＋";
      const label = document.createElement("span");
      label.textContent = "传一张效果图";
      hint.appendChild(plus);
      hint.appendChild(label);
      photo.appendChild(hint);
    }

    photo.addEventListener("click", function () { input.click(); });
    return photo;
  }

  function buildCard(rec) {
    const row = document.createElement("div");
    row.className = "pg-row" + (state.dirty[rec.id] ? " dirty" : "");
    row.dataset.id = String(rec.id);

    /* --- 左：例图 --- */
    row.appendChild(buildPhoto(rec));

    /* --- 右：名字、分类、提示词、备注、按钮 --- */
    const wrapper = document.createElement("div");
    wrapper.className = "pg-body";

    const head = document.createElement("div");
    head.className = "pg-row-head";

    const name = document.createElement("input");
    name.className = "pg-name";
    name.type = "text";
    name.value = rec.name || "";
    name.placeholder = "给这张卡起个名字，比如「仰拍构图」";
    name.addEventListener("input", function () { touch(rec.id, { name: name.value }); });
    head.appendChild(name);

    const sel = document.createElement("select");
    sel.className = "pg-group";
    const blank = document.createElement("option");
    blank.value = "0";
    blank.textContent = "未分类";
    sel.appendChild(blank);
    state.groups.forEach(function (g) {
      const o = document.createElement("option");
      o.value = String(g.id);
      o.textContent = g.name || "未命名";
      sel.appendChild(o);
    });
    sel.value = String(groupOf(rec));
    sel.title = "把这张卡存进哪个分类";
    sel.addEventListener("change", function () {
      touch(rec.id, { groupId: Number(sel.value) || 0 });
    });
    head.appendChild(sel);
    wrapper.appendChild(head);

    /* --- 提示词 --- */
    const ta = document.createElement("textarea");
    ta.className = "pg-text";
    ta.value = rec.text || "";
    ta.placeholder = "概念提示词写在这里，比如：from below, low angle, looking up, dramatic perspective";
    ta.spellcheck = false;
    ta.addEventListener("input", function () { touch(rec.id, { text: ta.value }); });
    wrapper.appendChild(ta);

    /* --- 备注 --- */
    const note = document.createElement("textarea");
    note.className = "pg-note";
    note.rows = 2;
    note.value = rec.note || "";
    note.placeholder = "备注（可选）：什么时候用、权重给多少、和哪些词冲突";
    note.addEventListener("input", function () { touch(rec.id, { note: note.value }); });
    wrapper.appendChild(note);

    /* --- 工具条 --- */
    const tools = document.createElement("div");
    tools.className = "pg-tools";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "primary";
    copy.textContent = "复制提示词";
    copy.addEventListener("click", function () { copyOne(rec.id); });

    const cp = document.createElement("button");
    cp.type = "button";
    cp.textContent = "连名字一起复制";
    cp.addEventListener("click", function () { copyOne(rec.id, true); });

    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "保存";
    save.addEventListener("click", function () { saveOne(rec.id); });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "danger";
    del.textContent = "删掉";
    /* 不直接删：先弹确认。一条里可能攒了几百个字的提示词，误点一下就没了 */
    del.addEventListener("click", function () { askDeleteCard(rec.id); });

    const st = document.createElement("span");
    st.className = "pg-state";
    st.textContent = state.dirty[rec.id] ? "有改动没保存" : "已保存";

    tools.appendChild(copy);
    tools.appendChild(cp);
    tools.appendChild(save);
    tools.appendChild(del);
    tools.appendChild(st);
    wrapper.appendChild(tools);
    row.appendChild(wrapper);

    return row;
  }

  /* 换图只动这一条的图片区，不重建整列 —— 免得把隔壁正在输入的内容打断 */
  function refreshRowMedia(id) {
    const rec = findCard(id);
    if (!rec || !el.list || !el.list.querySelector) return;
    const row = el.list.querySelector('[data-id="' + id + '"]');
    if (!row) return;
    const old = row.querySelector(".pg-photo");
    if (!old) return;
    row.replaceChild(buildPhoto(rec), old);
  }

  function setPhoto(id, file) {
    const rec = findCard(id);
    if (!rec) return;
    setStatus("正在读图…");
    readImage(file).then(function (dataUrl) {
      if (!dataUrl) {
        setStatus("这张图读不出来。", true);
        return;
      }
      rec.image = dataUrl;
      rec.updatedAt = now();
      /* 图直接落盘，不标脏 —— 它不像文字那样能随手重打，丢了就没了。
         所以保存按钮管不着它，传上来即生效。 */
      return saveCard(rec).then(function () {
        markDirty(id, false);
        refreshRowMedia(id);
        setStatus("例图换好了。");
      });
    });
  }

  /* 只更新那一条的脏标记，不重建整列 ——
     重建会把正在输入的 textarea 换掉，光标一丢字就断了 */
  function markDirty(id, on) {
    state.dirty[id] = !!on;
    if (!el.list) return;
    const row = el.list.querySelector ? el.list.querySelector('[data-id="' + id + '"]') : null;
    if (!row) return;
    row.classList.toggle("dirty", !!on);
    const st = row.querySelector ? row.querySelector(".pg-state") : null;
    if (st) st.textContent = on ? "有改动没保存" : "已保存";
  }

  /* ------------------------------------------------------------ 交互 */

  function touch(id, patch) {
    const rec = findCard(id);
    if (!rec) return;
    Object.keys(patch).forEach(function (k) { rec[k] = patch[k]; });
    rec.updatedAt = now();
    markDirty(id, true);
  }

  function saveOne(id) {
    const rec = findCard(id);
    if (!rec) return;
    saveCard(rec).then(function () {
      markDirty(id, false);
      setStatus("存好了。");
      /* 分类归属或者名字可能变了，计数和筛选条要跟着更新 */
      renderGroups();
    });
  }

  function copyOne(id, withName) {
    const rec = findCard(id);
    if (!rec) return;
    const text = String(rec.text || "");
    if (!text.trim()) {
      setStatus("这张卡还没写提示词。", true);
      return;
    }
    const payload = withName && rec.name ? rec.name + "\n" + text : text;
    copyText(payload)
      .then(function () { setStatus(withName ? "连名字一起复制好了。" : "复制好了。"); })
      .catch(function () { setStatus("复制没成功，手动选一下吧。", true); });
  }

  function newCard() {
    const rec = {
      name: "",
      text: "",
      note: "",
      image: "",
      /* 正在筛某个分类时，新建的直接归到那个分类里，省一步 */
      groupId: typeof state.filter === "number" ? state.filter : 0,
      at: now(),
      updatedAt: now(),
    };
    saveCard(rec).then(function (key) {
      if (key === null || key === undefined) {
        /* 措辞和 init 里那条保持一致 —— 同一个原因，别让用户看到两种说法 */
        setStatus("这个浏览器不给存东西（隐身模式？），这张卡关掉就没了。", true);
        return;
      }
      rec.id = key;
      state.cards.push(rec);
      render();
      setStatus("新建了一张，写完记得点保存。");
    });
  }

  function newGroup() {
    const rec = { name: uniqueName(state.groups, "新分类"), at: now() };
    saveGroup(rec).then(function (key) {
      if (key === null || key === undefined) {
        setStatus("这个浏览器不给存东西（隐身模式？），分类加不进去。", true);
        return;
      }
      rec.id = key;
      state.groups.push(rec);
      /* 不切筛选。切过去的话当前这一列会突然变空（新分类里当然还没东西），
         看着像卡片丢了 —— 实测踩到过。分类条上一直看得到它，用户自己会切。 */
      render();
      setStatus("分类建好了。");
      askRenameGroup(key, "这个分类叫什么？");
    });
  }

  function askRenameGroup(gid, title) {
    const g = findGroup(gid);
    if (!g) return;
    openNameModal(title || "给这个分类改个名字", g.name || "", function (name) {
      const clean = String(name).trim();
      if (!clean || clean === g.name) return;
      g.name = clean;
      saveGroup(g).then(function () {
        render();
        setStatus("分类改好了。");
      });
    });
  }

  /* ------------------------------------------------------------ 改名弹窗 */

  function openNameModal(title, value, onOk) {
    if (!el.nameModal) { onOk(String(value || "")); return; }
    if (el.nameTitle) el.nameTitle.textContent = title;
    if (el.nameInput) el.nameInput.value = value || "";
    nameOnOk = onOk;
    el.nameModal.classList.remove("is-hidden");
    document.body.style.overflow = "hidden";
    if (el.nameInput && el.nameInput.focus) el.nameInput.focus();
    if (el.nameInput && el.nameInput.select) el.nameInput.select();
  }

  function closeNameModal() {
    if (!el.nameModal) return;
    el.nameModal.classList.add("is-hidden");
    document.body.style.overflow = "";
    nameOnOk = null;
  }

  function confirmName() {
    const v = el.nameInput ? String(el.nameInput.value).trim() : "";
    const fn = nameOnOk;
    closeNameModal();
    /* 空名字就当没改，别把分类弄成没名字的 */
    if (fn && v) fn(v);
  }

  /* ------------------------------------------------------------ 删除确认 */

  function openModal(title, text) {
    if (!el.delModal) return;
    if (el.delTitle) el.delTitle.textContent = title;
    if (el.delText) el.delText.textContent = text;
    el.delModal.classList.remove("is-hidden");
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    if (!el.delModal) return;
    el.delModal.classList.add("is-hidden");
    document.body.style.overflow = "";
    pendingCard = -1;
    pendingGroup = -1;
  }

  function askDeleteCard(id) {
    const rec = findCard(id);
    if (!rec) return;
    pendingCard = id;
    pendingGroup = -1;
    const name = rec.name || "这张没名字";
    const n = String(rec.text || "").length;
    openModal("删掉这张卡？", "「" + name + "」里写着 " + n + " 个字的提示词，删了找不回来。");
  }

  function askDeleteGroup(gid, label) {
    const n = countIn(state.cards, gid);
    pendingCard = -1;
    pendingGroup = gid;
    openModal(
      "删掉这个分类？",
      "「" + label + "」里现在有 " + n + " 张卡。分类删掉之后，那些卡会变成未分类，不会被一起删掉。"
    );
  }

  function confirmDelete() {
    if (pendingCard >= 0) {
      const id = pendingCard;
      pendingCard = -1;
      dropCard(id).then(function () {
        state.cards = state.cards.filter(function (c) { return c.id !== id; });
        delete state.dirty[id];
        closeModal();
        render();
        setStatus("删掉了。");
      });
      return;
    }
    if (pendingGroup > 0) {
      const gid = pendingGroup;
      pendingGroup = -1;
      /* 先把里面的卡摘出来，再删分类。反过来的话中途失败会留下一堆指着空分类的卡 */
      const affected = state.cards.filter(function (c) { return groupOf(c) === gid; });
      affected.forEach(function (c) { c.groupId = 0; });
      Promise.all(affected.map(function (c) { return saveCard(c); })).then(function () {
        return dropGroup(gid);
      }).then(function () {
        state.groups = state.groups.filter(function (g) { return g.id !== gid; });
        if (state.filter === gid) state.filter = FILTER_ALL;
        closeModal();
        render();
        setStatus("分类删掉了，里面那 " + affected.length + " 张卡变成未分类了。");
      });
      return;
    }
    closeModal();
  }

  /* ------------------------------------------------------------ 备份 */

  /* 数据存在浏览器的 IndexedDB 里，而它挂在「源」（scheme + host + port）上。
     更新插件不影响它，但换成 localhost 打开、清浏览器数据、换台机器，就都看不见了。

     这一页比别处多一层：卡片归属的分类也得一起搬。搬的时候 groupId 要重新对一遍 ——
     备份里的分类 id 和现在库里的 id 没有任何关系，不管的话卡片会指向不存在的分类。 */

  function backupOut() {
    if (!state.cards.length && !state.groups.length) {
      setStatus("这里还没有东西可以导出。", true);
      return;
    }
    const text = M8Backup.envelope("prompts", state.cards, { groups: state.groups });
    M8Backup.download(M8Backup.fileNameFor("prompts"), text);
    setStatus("导出好了：" + state.cards.length + " 张卡、"
      + state.groups.length + " 个分类，" + M8Backup.fmtSize(text.length) + "。");
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
        if (obj.kind !== "prompts") {
          const other = M8Backup.KINDS[obj.kind];
          throw new Error("这份备份是「" + (other ? other.title : obj.kind) + "」的，不是提示词归纳的。");
        }
        return M8Backup.confirmImport("提示词归纳", obj.data.length, state.cards.length)
          .then(function (mode) {
            if (!mode) return null;
            const gs = (obj.extra && obj.extra.groups) || [];
            return applyImport(obj.data, gs, mode);
          });
      });
    }).catch(function (e) {
      setStatus(e && e.message ? e.message : "导入失败。", true);
    });
  }

  function applyImport(rows, backupGroups, mode) {
    if (mode === "replace") {
      const oldCards = state.cards.slice();
      const oldGroups = state.groups.slice();
      return Promise.all(oldCards.map(function (c) { return dropCard(c.id); }))
        .then(function () {
          return Promise.all(oldGroups.map(function (g) { return dropGroup(g.id); }));
        })
        .then(function () {
          /* 分类全部重建，顺手记下 旧 id -> 新 id */
          const map = {};
          return Promise.all(backupGroups.map(function (g) {
            const c = { name: g.name || "新分类", at: now() };
            return saveGroup(c).then(function (key) {
              c.id = key;
              map[g.id] = key;
              return c;
            });
          })).then(function (made) { return { map: map, groups: made }; });
        })
        .then(function (made) {
          const cards = M8Backup.remapCards(rows, made.map);
          return Promise.all(cards.map(function (c) {
            return saveCard(c).then(function (key) { c.id = key; return c; });
          })).then(function (list) {
            state.cards = list;
            state.groups = made.groups;
            state.filter = FILTER_ALL;
            state.dirty = {};
            render();
            setStatus("替换完成：现在有 " + list.length + " 张卡、"
              + made.groups.length + " 个分类。");
          });
        });
    }

    /* 合并：分类同名的复用现有的，卡片同名的跳过 */
    const plan = M8Backup.planGroups(backupGroups, state.groups);
    return Promise.all(plan.toCreate.map(function (g) {
      const c = { name: g.name, at: now() };
      return saveGroup(c).then(function (key) {
        c.id = key;
        state.groups.push(c);
        plan.map[g.oldId] = key;
        return c;
      });
    })).then(function () {
      const remapped = M8Backup.remapCards(rows, plan.map);
      const merged = M8Backup.mergeRows(state.cards, remapped, function (x) { return x.name; });
      return Promise.all(merged.fresh.map(function (c) {
        return saveCard(c).then(function (key) {
          c.id = key;
          state.cards.push(c);
        });
      })).then(function () {
        render();
        setStatus("导入完成：新增 " + merged.fresh.length + " 张卡、"
          + plan.toCreate.length + " 个分类，跳过同名 " + merged.skipped.length + " 张。");
      });
    });
  }

  /* ------------------------------------------------------------ 入口 */

  function init() {
    el = {
      count: byId("pgCount"),
      add: byId("pgAddCard"),
      groups: byId("pgGroups"),
      list: byId("pgList"),
      empty: byId("pgEmpty"),
      status: byId("pgStatus"),
      delModal: byId("pgDelModal"),
      delTitle: byId("pgDelTitle"),
      delText: byId("pgDelText"),
      delOk: byId("pgDelOk"),
      delCancel: byId("pgDelCancel"),
      delX: byId("pgDelX"),
      backupOut: byId("pgBackupOut"),
      backupIn: byId("pgBackupIn"),
      nameModal: byId("pgNameModal"),
      nameTitle: byId("pgNameTitle"),
      nameInput: byId("pgNameInput"),
      nameOk: byId("pgNameOk"),
      nameCancel: byId("pgNameCancel"),
      nameX: byId("pgNameX"),
    };
    if (!el.list) return;

    /* 先同步渲染一次空列，再等 IndexedDB —— 它慢或者卡住时页面不至于一直白着 */
    render();

    if (el.add) el.add.addEventListener("click", newCard);
    if (el.backupOut) el.backupOut.addEventListener("click", backupOut);
    if (el.backupIn) el.backupIn.addEventListener("click", backupIn);
    if (el.delOk) el.delOk.addEventListener("click", confirmDelete);
    if (el.delCancel) el.delCancel.addEventListener("click", closeModal);
    if (el.delX) el.delX.addEventListener("click", closeModal);
    if (el.delModal) {
      el.delModal.addEventListener("click", function (ev) {
        if (ev.target === el.delModal) closeModal();
      });
    }
    if (el.nameOk) el.nameOk.addEventListener("click", confirmName);
    if (el.nameCancel) el.nameCancel.addEventListener("click", closeNameModal);
    if (el.nameX) el.nameX.addEventListener("click", closeNameModal);
    if (el.nameModal) {
      el.nameModal.addEventListener("click", function (ev) {
        if (ev.target === el.nameModal) closeNameModal();
      });
    }
    if (el.nameInput) {
      el.nameInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); confirmName(); }
      });
    }

    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") { closeModal(); closeNameModal(); }
    });

    Promise.all([loadCards(), loadGroups()]).then(function (res) {
      state.cards = res[0] || [];
      state.groups = res[1] || [];
      state.ready = true;
      render();
      if (!storeAvailable()) {
        setStatus("这个浏览器不给存东西（隐身模式？），这次加的内容关掉就没了。", true);
        return;
      }
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
    /* 纯函数，测试直接用 */
    groupOf: groupOf,
    countIn: countIn,
    filterCards: filterCards,
    groupNameOf: groupNameOf,
    uniqueName: uniqueName,
    readImage: readImage,
    FILTER_ALL: FILTER_ALL,
    FILTER_NONE: FILTER_NONE,
  };
})();
