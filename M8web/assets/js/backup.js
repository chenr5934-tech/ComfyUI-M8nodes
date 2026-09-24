/* ============================================================================
 * M8web · 备份（导出 / 导入）
 *
 * 为什么要这个：工作台的数据全在浏览器的 IndexedDB 里，而 IndexedDB 是挂在
 * **源**（scheme + host + port）上的，不是挂在插件目录上。所以：
 *
 *   - 更新插件：不受影响。换掉 custom_nodes 里的文件跟浏览器存储没关系。
 *   - 换成 localhost 打开：看不见了。127.0.0.1 和 localhost 是两个不同的源。
 *   - 清了浏览器数据 / 磁盘紧张被驱逐：没了。
 *   - 换浏览器或换电脑：本来就没有。
 *
 * 后三种只能靠「导出一份 json 存着」兜底。这是唯一能跨源、跨机器、
 * 抗清缓存的方案，所以三个有数据的功能页都接了它。
 *
 * 文件里就一个对象，图片以 dataURL 原样内嵌，所以导出来的 json 可能几十 MB ——
 * 这是有意的：备份就要有备份的质量，别偷偷降分辨率。
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

const M8Backup = (() => {
  "use strict";

  const APP = "m8web";
  const V = 1;

  /* 三类数据。kind 用来防止把 OC 的备份导进提示词页。

     title 写成 getter，而不是在这里直接取值：这里是模块顶层，本文件先于 i18n.js
     执行，当场取 window.M8I18n 只会拿到 undefined。getter 等到真正读它的那几处
     （拼「这份备份是 XX 的」那句报错）才查表，那时语言包早就绪了。 */
  const KINDS = {
    oc: { get title() { return T("feat.oc.name", "OC Workshop"); }, file: "m8-oc" },
    prompts: { get title() { return T("feat.prompts.name", "Prompt Collection"); }, file: "m8-prompts" },
    stickers: { get title() { return T("stickerLib", "Sticker library"); }, file: "m8-stickers" },
  };

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  /* 文件名带时间戳，免得导两次互相覆盖 */
  function stamp(d) {
    const t = d || new Date();
    return t.getFullYear() + pad(t.getMonth() + 1) + pad(t.getDate())
      + "-" + pad(t.getHours()) + pad(t.getMinutes());
  }

  function fileNameFor(kind, d) {
    const k = KINDS[kind] ? KINDS[kind].file : "m8-backup";
    return k + "-" + stamp(d) + ".json";
  }

  /* extra 用来装「主数据之外还得一起搬走的东西」。目前只有提示词归纳用得上 ——
     它除了卡片还有分类，不带过去的话卡片的 groupId 会指向不存在的分类。 */
  function envelope(kind, rows, extra) {
    const out = {
      app: APP,
      kind: kind,
      v: V,
      at: new Date().toISOString(),
      count: (rows || []).length,
      data: rows || [],
    };
    if (extra) out.extra = extra;
    return JSON.stringify(out, null, 2);
  }

  /* 读回来的东西一律当成不可信数据 —— 用户可能选错文件，也可能手改过 */
  function parse(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      throw new Error(T("backupNotJson", "This is not an M8 backup file (the JSON could not be read)."));
    }
    if (!obj || obj.app !== APP) {
      throw new Error(T("backupNotOurs", "This file was not exported by the M8 Workbench."));
    }
    if (typeof obj.v !== "number") {
      throw new Error(T("backupNoVersion", "The backup file carries no version number, so it cannot be trusted."));
    }
    if (obj.v > V) {
      throw new Error(T("backupNewerVersion", "This backup was exported by a newer version (v{v}), which this version cannot read.", { v: obj.v }));
    }
    if (!obj.kind || !KINDS[obj.kind]) {
      throw new Error(T("backupUnknownKind", "Unrecognised kind in the backup: ") + (obj.kind || T("backupKindEmpty", "(empty)")));
    }
    if (!Array.isArray(obj.data)) {
      throw new Error(T("backupNoData", "The backup holds no data."));
    }
    return obj;
  }

  function download(name, text) {
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    /* 立刻 revoke 会把下载掐断，延后一点再撒手 */
    setTimeout(function () {
      try { URL.revokeObjectURL(url); } catch (e) { /* 无所谓 */ }
    }, 5000);
  }

  /* 挑一个文件。注意用完必须把这个 input 从 body 上摘掉 ——
     它是现建的，每次调用都留一个的话会一直攒（审计时发现的）。

     用户点「取消」在多数浏览器里不触发任何事件，所以那个 Promise 会一直挂着。
     挂着的 Promise 不会造成泄漏（只有 input 会），所以这里不做超时兜底；
     真要处理取消得等 cancel 事件铺开，或者干脆换成常驻的 input 元素。 */
  function pickFile() {
    return new Promise(function (resolve) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json,.json";
      input.style.display = "none";
      function done(f) {
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(f || null);
      }
      input.addEventListener("change", function () {
        const f = input.files && input.files[0];
        done(f);
      });
      /* Chrome 113+ 有 cancel 事件；没有的浏览器上就什么都不发生 */
      input.addEventListener("cancel", function () { done(null); });
      document.body.appendChild(input);
      input.click();
    });
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onerror = function () { reject(new Error(T("fileUnreadable", "This file could not be read."))); };
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.readAsText(file);
    });
  }

  /* 合并：按 keyOf 去重，剩下的当新记录插进去。
     这里**不按 id 去重** —— 两个环境的 id 都是从 1 开始发的，一撞就会把
     用户真正想保留的那条当成重复跳掉。id 一律丢掉，让库重新分配。 */
  function mergeRows(existing, incoming, keyOf) {
    const seen = {};
    (existing || []).forEach(function (r) {
      const k = keyOf(r);
      if (k) seen[k] = true;
    });
    const fresh = [];
    const skipped = [];
    (incoming || []).forEach(function (r) {
      const k = keyOf(r);
      if (k && seen[k]) { skipped.push(r); return; }
      if (k) seen[k] = true;
      const copy = Object.assign({}, r);
      delete copy.id;
      fresh.push(copy);
    });
    return { fresh: fresh, skipped: skipped };
  }

  /* 分类要跟着卡片一起搬。搬的时候得把 groupId 重新对一遍 ——
     备份里的 id 和现在库里的 id 没有任何关系。

     同名分类复用现有的（不新建重复的），其余记下来等着建。
     返回 { map: 旧id->新id, toCreate: [{name, oldId}] } */
  function planGroups(backupGroups, existingGroups) {
    const map = {};
    const toCreate = [];
    const byName = {};
    (existingGroups || []).forEach(function (g) {
      if (g && g.name) byName[g.name] = g.id;
    });
    (backupGroups || []).forEach(function (g) {
      if (!g) return;
      const name = g.name || "";
      if (name && byName[name] !== undefined) {
        map[g.id] = byName[name];
      } else {
        toCreate.push({ name: name || T("backupNewGroup", "New group"), oldId: g.id });
      }
    });
    return { map: map, toCreate: toCreate };
  }

  /* 按映射表把卡片上的 groupId 换成新库里的 id。
     映射不到的（分类没跟过来、或者本来就没归类）一律当未分类 ——
     宁可丢归属，也不能让卡片指着一个不存在的分类。 */
  function remapCards(cards, map) {
    const m = map || {};
    return (cards || []).map(function (c) {
      const copy = Object.assign({}, c);
      delete copy.id;
      const old = c ? c.groupId : 0;
      copy.groupId = (old && m[old]) ? m[old] : 0;
      return copy;
    });
  }

  /* 申请持久化存储。授予之后，磁盘紧张时浏览器不会自动清掉这个源的数据。
     没授予也不影响使用 —— 那就只是「正常清理可能被清掉」，导出备份照旧管用。 */
  function requestPersist() {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.persist) {
      return Promise.resolve(null);
    }
    try {
      return navigator.storage.persist().then(function (granted) {
        return { granted: !!granted };
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* 已用 / 配额。让用户对「还能存多少」有个数 */
  function usage() {
    if (typeof navigator === "undefined" || !navigator.storage || !navigator.storage.estimate) {
      return Promise.resolve(null);
    }
    try {
      return navigator.storage.estimate().then(function (e) {
        return { used: e.usage || 0, quota: e.quota || 0 };
      }).catch(function () { return null; });
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  /* ------------------------------------------------------------ 导入确认 */

  /* 弹一句「合并还是替换」。这个框是现建的 —— 三个页面各写一套太啰嗦，
     而且样式全靠 shell.css 里的公共 .modal 那一套，不用担心各页不一致。
     返回 "merge" / "replace" / null（取消或关掉）。 */
  function confirmImport(title, incoming, existing) {
    return new Promise(function (resolve) {
      let done = false;
      function finish(v) {
        if (done) return;
        done = true;
        wrap.classList.add("is-hidden");
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        document.body.style.overflow = "";
        document.removeEventListener("keydown", onKey);
        resolve(v);
      }
      function onKey(ev) {
        if (ev.key === "Escape") finish(null);
      }

      const wrap = document.createElement("div");
      wrap.className = "modal";
      wrap.setAttribute("role", "dialog");
      wrap.setAttribute("aria-modal", "true");
      wrap.addEventListener("click", function (ev) {
        if (ev.target === wrap) finish(null);
      });

      const box = document.createElement("div");
      box.className = "modal-box sm";

      const head = document.createElement("header");
      head.className = "modal-head";
      const h2 = document.createElement("h2");
      h2.textContent = T("importTitle", "Import this backup?");
      const x = document.createElement("button");
      x.type = "button";
      x.className = "modal-x";
      x.setAttribute("aria-label", T("closeLabel", "Close"));
      x.textContent = "×";
      x.addEventListener("click", function () { finish(null); });
      head.appendChild(h2);
      head.appendChild(x);

      const body = document.createElement("div");
      body.className = "modal-body";
      const main = document.createElement("p");
      main.className = "modal-text";
      main.textContent = T("importBody",
        "This is a backup of {title} with {n} entries; this page currently holds {m}.",
        { title: title, n: incoming, m: existing });
      const sub = document.createElement("p");
      sub.className = "modal-text sub";
      sub.textContent = T("importBodySub",
        "Merge: entries with the same name are skipped, the rest come in as new ones, and nothing already here is touched."
        + " Replace: everything here is cleared out first, then these {n} entries are written in.",
        { n: incoming });
      body.appendChild(main);
      body.appendChild(sub);

      const foot = document.createElement("footer");
      foot.className = "modal-foot";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "ghost-btn";
      cancel.textContent = T("cancel", "Cancel");
      cancel.addEventListener("click", function () { finish(null); });
      const merge = document.createElement("button");
      merge.type = "button";
      merge.className = "ghost-btn";
      merge.textContent = T("importMerge", "Merge them in");
      merge.addEventListener("click", function () { finish("merge"); });
      const replace = document.createElement("button");
      replace.type = "button";
      replace.className = "gen-btn danger";
      replace.textContent = T("importReplace", "Clear and import");
      replace.addEventListener("click", function () { finish("replace"); });
      foot.appendChild(cancel);
      foot.appendChild(merge);
      foot.appendChild(replace);

      box.appendChild(head);
      box.appendChild(body);
      box.appendChild(foot);
      wrap.appendChild(box);
      document.body.appendChild(wrap);
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", onKey);
      if (merge.focus) merge.focus();
    });
  }

  function fmtSize(n) {
    if (!n) return "0 B";
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  return {
    APP: APP,
    V: V,
    KINDS: KINDS,
    stamp: stamp,
    fileNameFor: fileNameFor,
    envelope: envelope,
    parse: parse,
    download: download,
    pickFile: pickFile,
    readText: readText,
    mergeRows: mergeRows,
    planGroups: planGroups,
    remapCards: remapCards,
    confirmImport: confirmImport,
    requestPersist: requestPersist,
    usage: usage,
    fmtSize: fmtSize,
  };
})();
