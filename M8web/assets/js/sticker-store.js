/* ============================================================================
 * M8web · 贴纸库的存储层
 *
 * 数据存在服务器上的文件里（<ComfyUI>/models/M8data/webapp/stickers.json），
 * 不再用浏览器的 IndexedDB。原因见 app.js 里 M8Api 那段注释 —— 一句话：
 * IndexedDB 挂在「源」上，CUI 一关源就没了，换台机器也看不见。
 *
 * 方法名和以前完全一样（available / all / put / remove / clear），所以
 * 上层 sticker.js 一行都不用改。
 *
 * 后端不在的时候安静地退化成空结果 —— 贴纸库用不了，但整个工坊照常能用。
 * ==========================================================================*/

const M8StickerStore = (() => {
  "use strict";

  const KIND = "stickers";

  function available() {
    return typeof M8Api !== "undefined" && !!M8Api;
  }

  function all() {
    if (!available()) return Promise.resolve([]);
    return M8Api.list(KIND);
  }

  /* 存一张。返回新记录的 id（拿不到就返回 null） */
  function put(rec) {
    if (!available()) return Promise.resolve(null);
    return M8Api.put(KIND, rec).catch(function () { return null; });
  }

  function remove(id) {
    if (!available()) return Promise.resolve(false);
    return M8Api.del(KIND, id).catch(function () { return false; });
  }

  /* 清空整个库。导入备份的「替换」走这条 */
  function clear() {
    if (!available()) return Promise.resolve(0);
    return M8Api.replace(KIND, []).catch(function () { return 0; });
  }

  return {
    available: available,
    put: put,
    all: all,
    remove: remove,
    clear: clear,
  };
})();
