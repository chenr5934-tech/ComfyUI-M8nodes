/* ============================================================================
 * M8web · 把旧数据从浏览器搬出来
 *
 * 以前 OC 工坊、提示词归纳、贴纸库的数据存在浏览器的 IndexedDB 里。现在改成
 * 存服务器文件了（<ComfyUI>/models/M8data/webapp/*.json），于是升级之后
 * 旧数据会「看不见」—— 它还在浏览器里躺着，只是没人去读了。
 *
 * 这个脚本负责搬一次。**只在旧库里真的有东西时才提示**，搬完把旧库删掉，
 * 免得每次开页面都问。
 *
 * 为什么不能靠「导出备份」按钮救：那个按钮读的是新位置（服务器文件），
 * 旧数据它根本看不见。
 * ==========================================================================*/

const M8Migrate = (() => {
  "use strict";

  /* 旧库 → 新位置。一个旧库里可能有两个 store（提示词那张表就有卡片和分类） */
  const OLD = [
    { db: "m8web-oc", store: "ocs", kind: "oc", label: "OC Workshop" },
    { db: "m8web-prompts", store: "cards", kind: "prompts", label: "Prompt cards" },
    { db: "m8web-prompts", store: "groups", kind: "groups", label: "Prompt categories" },
    { db: "m8web-stickers", store: "stickers", kind: "stickers", label: "Stickers" },
  ];

  function canUse() {
    return typeof indexedDB !== "undefined" && !!indexedDB;
  }

  /* 先把库名列出来。库不在就别去 open —— 不带版本号地 open 会把它建出来，
     那就等于凭空造了三个空库，以后每次检查都以为有旧数据。 */
  function listDbs() {
    if (!canUse() || !indexedDB.databases) return Promise.resolve(null);
    return indexedDB.databases().then(function (list) {
      return (list || []).map(function (d) { return d.name; });
    }).catch(function () { return null; });
  }

  function readStore(dbName, storeName) {
    return new Promise(function (resolve) {
      if (!canUse()) { resolve([]); return; }
      let req;
      try { req = indexedDB.open(dbName); } catch (e) { resolve([]); return; }
      req.onerror = function () { resolve([]); };
      req.onsuccess = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve([]); return; }
        try {
          const tx = db.transaction(storeName, "readonly");
          const g = tx.objectStore(storeName).getAll();
          g.onsuccess = function () { db.close(); resolve(g.result || []); };
          g.onerror = function () { db.close(); resolve([]); };
        } catch (e) {
          db.close();
          resolve([]);
        }
      };
    });
  }

  /* 看看还有没有东西要搬。返回 [{kind, label, rows}]，空数组表示没得搬。
     拿不到库列表（老浏览器）时返回 null，表示「不知道」，别去打扰用户。 */
  function scan() {
    return listDbs().then(function (names) {
      if (names === null) return null;
      const out = [];
      const wanted = OLD.filter(function (o) { return names.indexOf(o.db) >= 0; });
      return wanted.reduce(function (chain, o) {
        return chain.then(function () {
          return readStore(o.db, o.store).then(function (rows) {
            const list = (rows || []).filter(function (r) { return r && typeof r === "object"; });
            if (list.length) out.push({ kind: o.kind, label: o.label, rows: list });
          });
        });
      }, Promise.resolve()).then(function () { return out; });
    });
  }

  /* 真的搬。逐类写进服务器文件 —— 用 replace 是刻意的：
     这时候服务器那边通常是空的，整份写过去最直接。 */
  function run(items) {
    const list = items || [];
    let moved = 0;
    return list.reduce(function (chain, item) {
      return chain.then(function () {
        return M8Api.replace(item.kind, item.rows).then(function (n) {
          moved += n;
        });
      });
    }, Promise.resolve()).then(function () { return moved; });
  }

  /* 搬完把旧库删掉。删不掉不算失败 —— 大不了下次再提示一遍。 */
  function dropOld() {
    const names = Array.from(new Set(OLD.map(function (o) { return o.db; })));
    return names.reduce(function (chain, name) {
      return chain.then(function () {
        return new Promise(function (resolve) {
          try {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = req.onerror = req.onblocked = function () { resolve(); };
          } catch (e) { resolve(); }
        });
      });
    }, Promise.resolve());
  }

  return {
    scan: scan,
    run: run,
    dropOld: dropOld,
    OLD: OLD,
  };
})();
