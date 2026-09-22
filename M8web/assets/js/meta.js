/* ============================================================================
 * M8web · 图片元数据解析
 *
 * 拖一张图进来，把能读的都读出来。全程在浏览器里，图片不上传。
 *
 * 三块解析，全部抽成纯函数（吃 Uint8Array，吐对象），这样才能拿构造出来的
 * 字节流单独测，不用真去准备一堆图片：
 *   parsePng()    PNG 的 chunk —— ComfyUI 就是把自己的 workflow 塞在这里的
 *   parseJpeg()   JPEG 的 EXIF —— 相机参数
 *   extractComfy() 从 workflow 的 JSON 里挑出模型、采样器、步数、种子这些
 *
 * PRIME 规则：坏文件、截断文件、根本不是图片的文件，一律安静地少给点信息，
 * 不许抛异常 —— 解析器最忌讳因为一个字节不对就整个崩掉。
 * ==========================================================================*/

const M8Meta = (() => {
  "use strict";

  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

  const COLOR_TYPES = {
    0: "灰度",
    2: "RGB",
    3: "索引色",
    4: "灰度 + Alpha",
    6: "RGBA",
  };

  /* EXIF 标签表。只列真要给人看的那些，光名字没意义的 tag 不占版面。 */
  const EXIF_TAGS = {
    0x010F: "相机厂商",
    0x0110: "相机型号",
    0x0112: "方向",
    0x011A: "水平分辨率",
    0x011B: "垂直分辨率",
    0x0128: "分辨率单位",
    0x0131: "软件",
    0x0132: "修改时间",
    0x829A: "曝光时间",
    0x829D: "光圈",
    0x8822: "曝光程序",
    0x8827: "ISO",
    0x9003: "拍摄时间",
    0x9004: "数字化时间",
    0x9201: "快门速度",
    0x9202: "光圈值",
    0x9204: "曝光补偿",
    0x9207: "测光模式",
    0x9209: "闪光灯",
    0x920A: "焦距",
    0x9286: "用户注释",
    0xA001: "色彩空间",
    0xA002: "像素宽",
    0xA003: "像素高",
    0xA405: "等效焦距",
    0xA434: "镜头型号",
  };

  const GPS_TAGS = {
    0x0000: "GPS 版本",
    0x0001: "纬度参考",
    0x0002: "纬度",
    0x0003: "经度参考",
    0x0004: "经度",
    0x0005: "海拔参考",
    0x0006: "海拔",
    0x0007: "时间",
  };

  const ORIENT = {
    1: "正常",
    2: "水平镜像",
    3: "旋转 180°",
    4: "垂直镜像",
    5: "顺时针 90° + 镜像",
    6: "顺时针 90°",
    7: "逆时针 90° + 镜像",
    8: "逆时针 90°",
  };

  /* ------------------------------------------------------------ 字节小工具 */

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  /* 按 latin1 解字节（PNG 的 tEXt 是 latin1，关键字必须是 ASCII） */
  function latin1(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  /* iTXt 里的正文是 UTF-8。解不出来就退回 latin1，总比没有强。 */
  function utf8(b) {
    if (typeof TextDecoder === "function") {
      try { return new TextDecoder("utf-8").decode(b); } catch (e) { /* 退回 */ }
    }
    return latin1(b);
  }

  function hex(b) {
    let s = "";
    for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }

  /* ------------------------------------------------------------ PNG */

  /* PNG = 8 字节签名 + 一串 chunk；每块是 [长度 4][类型 4][数据][CRC 4]。
     ComfyUI 的生成参数和工作流就躺在 tEXt 里，关键字分别是 prompt 和 workflow。 */
  function parsePng(bytes) {
    if (!bytes || bytes.length < 8) return null;
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== PNG_SIG[i]) return null;
    }
    const out = { info: {}, texts: {}, chunks: [] };
    let pos = 8;
    let guard = 0;
    while (pos + 8 <= bytes.length && guard < 500) {
      guard += 1;
      const len = readU32(bytes, pos);
      const type = latin1(bytes.subarray(pos + 4, pos + 8));
      if (len > bytes.length) break;                 // 长度明显是坏的，别继续
      const data = bytes.subarray(pos + 8, pos + 8 + len);
      out.chunks.push({ type: type, len: len });

      if (type === "IHDR" && len >= 13) {
        out.info.width = readU32(data, 0);
        out.info.height = readU32(data, 4);
        out.info.depth = data[8];
        out.info.colorType = data[9];
        out.info.interlace = data[12];
      } else if (type === "tEXt") {
        const s = latin1(data);
        const k = s.indexOf("\u0000");
        if (k > 0) out.texts[s.slice(0, k)] = s.slice(k + 1);
      } else if (type === "iTXt") {
        /* keyword\0 flag(1) method(1) lang\0 translated\0 text */
        const s = latin1(data);
        const k = s.indexOf("\u0000");
        if (k > 0) {
          const flag = data[k + 1];
          let p = k + 3;
          for (let n = 0; n < 2 && p < data.length; n++) {
            while (p < data.length && data[p] !== 0) p++;
            p++;
          }
          const body = data.subarray(p);
          out.texts[s.slice(0, k)] = flag ? "(压缩内容)" : utf8(body);
        }
      } else if (type === "zTXt") {
        /* keyword\0 method(1) 压缩数据 —— 不引 zlib 解不开，只记个名 */
        const s = latin1(data);
        const k = s.indexOf("\u0000");
        if (k > 0) out.texts[s.slice(0, k)] = "(压缩内容，没解)";
      } else if (type === "IEND") {
        break;
      }
      pos += 12 + len;
    }
    return out;
  }

  /* ------------------------------------------------------------ JPEG / EXIF */

  /* JPEG 是一串 [FF marker][长度][数据]。EXIF 在 APP1（FFE1）里，
     跳过 6 个字节的 "Exif\0\0" 之后就是一份 TIFF 结构。 */
  function parseJpeg(bytes) {
    if (!bytes || bytes.length < 4) return null;
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    let pos = 2;
    let guard = 0;
    while (pos + 4 <= bytes.length && guard < 200) {
      guard += 1;
      if (bytes[pos] !== 0xff) { pos += 1; continue; }
      const marker = bytes[pos + 1];
      /* 无参数的标记 */
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
        continue;
      }
      if (marker === 0xda) break;   // SOS 之后是压缩数据，没标记了
      const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (len < 2) break;
      const seg = bytes.subarray(pos + 4, pos + 2 + len);
      if (marker === 0xe1 && seg.length > 6 && latin1(seg.subarray(0, 4)) === "Exif") {
        const exif = parseTiff(seg.subarray(6));
        if (exif) return exif;
      }
      pos += 2 + len;
    }
    return null;
  }

  function parseTiff(t) {
    if (!t || t.length < 8) return null;
    /* II = 小端，MM = 大端 */
    const le = t[0] === 0x49 && t[1] === 0x49;
    const be = t[0] === 0x4d && t[1] === 0x4d;
    if (!le && !be) return null;
    const u16 = function (o) {
      if (o + 2 > t.length) return 0;
      return le ? (t[o] | (t[o + 1] << 8)) : ((t[o] << 8) | t[o + 1]);
    };
    const u32 = function (o) {
      if (o + 4 > t.length) return 0;
      return le
        ? ((t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0)
        : (((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
    };
    if (u16(2) !== 0x002a) return null;

    const out = { tags: {}, gps: {} };
    const ifd0 = u32(4);
    let gpsPtr = 0;

    function readIfd(offset, into, gps) {
      if (!offset || offset + 2 > t.length) return;
      const count = u16(offset);
      if (count > 512) return;   // 明显是坏的
      for (let i = 0; i < count; i++) {
        const e = offset + 2 + i * 12;
        if (e + 12 > t.length) return;
        const tag = u16(e);
        const type = u16(e + 2);
        const num = u32(e + 4);
        const valueAt = e + 8;
        let value = null;
        try {
          value = readValue(type, num, valueAt, u32);
        } catch (err) {
          value = null;
        }
        if (gps) {
          if (GPS_TAGS[tag]) out.gps[GPS_TAGS[tag]] = value;
        } else {
          if (tag === 0x8825) gpsPtr = u32(valueAt);
          else if (EXIF_TAGS[tag] && value !== null && value !== "") out.tags[EXIF_TAGS[tag]] = value;
        }
      }
      return u32(offset + 2 + count * 12);   // 下一个 IFD
    }

    function readValue(type, num, at, u32f) {
      const size = type === 1 || type === 2 || type === 7 ? 1 : type === 3 ? 2 : type === 4 || type === 9 ? 4 : type === 5 || type === 10 ? 8 : 0;
      if (!size) return null;
      const total = size * num;
      const off = total > 4 ? u32f(at) : at;
      if (off + total > t.length) return null;
      if (type === 2) {
        let s = "";
        for (let i = 0; i < num; i++) {
          const c = t[off + i];
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      if (type === 1 || type === 7) {
        return num === 1 ? t[off] : "(二进制 " + num + " 字节)";
      }
      if (type === 3) {
        return num === 1 ? u16(off) : "(数组)";
      }
      if (type === 4) {
        return num === 1 ? u32f(off) : "(数组)";
      }
      if (type === 5 || type === 10) {
        const n = u32f(off);
        const d = u32f(off + 4);
        if (!d) return null;
        return { n: n, d: d };
      }
      return null;
    }

    /* 既然是个 IFD，顺手把 Exif 子目录也读一下（光圈、ISO 那些在这儿） */
    function findExifPtr() {
      const count = u16(ifd0);
      for (let i = 0; i < count; i++) {
        const e = ifd0 + 2 + i * 12;
        if (e + 12 > t.length) break;
        if (u16(e) === 0x8769) return u32(e + 8);
      }
      return 0;
    }

    readIfd(ifd0, out.tags, false);
    const exifPtr = findExifPtr();
    if (exifPtr) readIfd(exifPtr, out.tags, false);
    if (gpsPtr) readIfd(gpsPtr, out.gps, true);

    return out;
  }

  /* ------------------------------------------------------------ ComfyUI */

  /* ComfyUI 把 workflow 存成 { "3": { class_type, inputs }, ... }。
     这里把散在各节点里的关键参数挑出来，顺便统计用了哪些节点类型。 */
  function extractComfy(jsonText) {
    let data = null;
    if (typeof jsonText === "string") {
      try { data = JSON.parse(jsonText); } catch (e) { return null; }
    } else {
      data = jsonText;
    }
    if (!data || typeof data !== "object") return null;

    /* 两种可能：本身就带 nodes 数组（导出格式），或者就是那个节点字典 */
    const nodes = Array.isArray(data.nodes) ? data.nodes : data;
    const keys = Object.keys(nodes);
    if (!keys.length) return null;

    const out = { count: 0, kinds: {}, models: [], loras: [], samplers: [], prompts: [], sizes: [] };
    const bump = function (o, k) { o[k] = (o[k] || 0) + 1; };

    for (let i = 0; i < keys.length; i++) {
      const node = nodes[keys[i]];
      if (!node || typeof node !== "object") continue;
      const kind = node.class_type || node.type || "";
      if (!kind) continue;
      out.count += 1;
      bump(out.kinds, kind);
      const inp = node.inputs || node.widgets_values || {};

      if (/CheckpointLoader/i.test(kind) && inp.ckpt_name) out.models.push(String(inp.ckpt_name));
      if (/LoraLoader/i.test(kind) && inp.lora_name) out.loras.push(String(inp.lora_name));
      if (/KSampler/i.test(kind)) {
        if (inp.sampler_name) out.samplers.push(String(inp.sampler_name));
        if (inp.scheduler) out.samplers.push(String(inp.scheduler));
        out.steps = inp.steps !== undefined ? inp.steps : out.steps;
        out.cfg = inp.cfg !== undefined ? inp.cfg : out.cfg;
        out.seed = inp.seed !== undefined ? inp.seed : out.seed;
        out.denoise = inp.denoise !== undefined ? inp.denoise : out.denoise;
      }
      if (/EmptyLatentImage|EmptySD3LatentImage/i.test(kind)) {
        if (inp.width && inp.height) out.sizes.push(inp.width + " × " + inp.height);
      }
      if (/CLIPTextEncode|T5TextEncode/i.test(kind) && typeof inp.text === "string" && inp.text.trim()) {
        out.prompts.push(inp.text.trim());
      }
    }
    out.models = out.models.filter(function (v, i, a) { return a.indexOf(v) === i; });
    out.loras = out.loras.filter(function (v, i, a) { return a.indexOf(v) === i; });
    return out;
  }

  /* ------------------------------------------------------------ 渲染 */

  let el = {};
  let lastUrl = "";

  function setStatus(text, warn) {
    if (!el.status) return;
    el.status.textContent = text || "";
    el.status.classList.toggle("warn", !!warn);
  }

  function card(title, tag) {
    const box = document.createElement("section");
    box.className = "info-card";
    const h = document.createElement("h2");
    h.textContent = title;
    if (tag) {
      const t = document.createElement("span");
      t.className = "info-tag";
      t.textContent = tag;
      h.appendChild(t);
    }
    box.appendChild(h);
    return box;
  }

  function kv(pairs) {
    const dl = document.createElement("dl");
    dl.className = "kv";
    pairs.forEach(function (p) {
      if (p[1] === undefined || p[1] === null || p[1] === "") return;
      const dt = document.createElement("dt");
      dt.textContent = p[0];
      const dd = document.createElement("dd");
      dd.textContent = String(p[1]);
      dl.appendChild(dt);
      dl.appendChild(dd);
    });
    return dl;
  }

  function copyButton(text) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "复制";
    b.addEventListener("click", function () {
      M8Meta.copyText(text).then(function () {
        setStatus("复制好了。");
      }).catch(function () {
        setStatus("复制没成功，手动选一下吧。", true);
      });
    });
    return b;
  }

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(2) + " MB";
  }

  function paramsGrid(pairs) {
    const box = document.createElement("div");
    box.className = "param-grid";
    pairs.forEach(function (p) {
      if (p[1] === undefined || p[1] === null || p[1] === "") return;
      const cell = document.createElement("div");
      cell.className = "param-cell" + (p[2] ? " wide" : "");
      const b = document.createElement("b");
      b.textContent = p[0];
      const s = document.createElement("span");
      s.textContent = String(p[1]);
      cell.appendChild(b);
      cell.appendChild(s);
      box.appendChild(cell);
    });
    return box;
  }

  function codeBlock(text) {
    const pre = document.createElement("pre");
    pre.className = "code-block";
    /* 太长的 JSON 截一下，不然一个几十万字的工作流会把页面卡住 */
    const LIMIT = 200000;
    pre.textContent = text.length > LIMIT ? text.slice(0, LIMIT) + "\n…（太长，截断了）" : text;
    return pre;
  }

  function render(result) {
    const panels = el.panels;
    panels.innerHTML = "";

    /* --- 文件信息 --- */
    const fileCard = card("文件");
    fileCard.appendChild(kv([
      ["文件名", result.file.name],
      ["格式", result.file.format],
      ["大小", fmtSize(result.file.size)],
      ["尺寸", result.file.width && result.file.height
        ? result.file.width + " × " + result.file.height + " 像素" : ""],
      ["位深", result.file.depth ? result.file.depth + " bit" : ""],
      ["色彩", result.file.colorType || ""],
    ]));
    panels.appendChild(fileCard);

    /* --- ComfyUI 生成参数 --- */
    if (result.comfy) {
      const c = result.comfy;
      const cCard = card("生成参数", "ComfyUI");
      cCard.appendChild(paramsGrid([
        ["模型", c.models.length ? c.models.join("\n") : "", true],
        ["LoRA", c.loras.length ? c.loras.join("\n") : "", true],
        ["采样器", c.samplers.length ? c.samplers.join(" · ") : ""],
        ["步数", c.steps],
        ["CFG", c.cfg],
        ["种子", c.seed],
        ["降噪", c.denoise],
        ["画布", c.sizes.length ? c.sizes.join(" · ") : ""],
        ["节点数", c.count],
      ]));
      panels.appendChild(cCard);

      /* --- 提示词 --- */
      if (c.prompts.length) {
        const pCard = card("提示词");
        const actions = document.createElement("div");
        actions.className = "card-actions";
        actions.appendChild(copyButton(c.prompts.join("\n\n---\n\n")));
        pCard.querySelector("h2").appendChild(actions);
        c.prompts.forEach(function (t, i) {
          const pre = document.createElement("pre");
          pre.className = "code-block";
          pre.style.maxHeight = "160px";
          pre.textContent = (c.prompts.length > 1 ? "【" + (i + 1) + "】\n" : "") + t;
          pCard.appendChild(pre);
        });
        panels.appendChild(pCard);
      }

      /* --- 原始工作流 --- */
      if (result.workflowText) {
        const wCard = card("工作流 JSON");
        const acts = document.createElement("div");
        acts.className = "card-actions";
        const fold = document.createElement("button");
        fold.type = "button";
        fold.textContent = "展开 / 收起";
        fold.addEventListener("click", function () { wCard.classList.toggle("folded"); });
        acts.appendChild(fold);
        acts.appendChild(copyButton(result.workflowText));
        wCard.querySelector("h2").appendChild(acts);
        wCard.classList.add("folded");
        wCard.appendChild(codeBlock(result.workflowText));
        panels.appendChild(wCard);
      }
    }

    /* --- EXIF --- */
    if (result.exif) {
      const rows = [];
      Object.keys(result.exif.tags).forEach(function (k) {
        let v = result.exif.tags[k];
        if (k === "方向" && ORIENT[v]) v = ORIENT[v];
        if (v && typeof v === "object" && v.n !== undefined) {
          v = v.d > 1 ? (v.n / v.d).toFixed(2).replace(/\.?0+$/, "") : v.n;
        }
        rows.push([k, v]);
      });
      const gpsRows = Object.keys(result.exif.gps).map(function (k) {
        return ["GPS · " + k, result.exif.gps[k]];
      });
      if (rows.length || gpsRows.length) {
        const eCard = card("EXIF", "相机信息");
        eCard.appendChild(kv(rows.concat(gpsRows)));
        panels.appendChild(eCard);
      }
    }

    /* --- 其他文本块 --- */
    const others = Object.keys(result.texts || {}).filter(function (k) {
      return k !== "prompt" && k !== "workflow";
    });
    if (others.length) {
      const oCard = card("内嵌文本");
      others.forEach(function (k) {
        const h = document.createElement("p");
        h.className = "info-note";
        h.style.marginBottom = "6px";
        h.textContent = k;
        oCard.appendChild(h);
        const pre = document.createElement("pre");
        pre.className = "code-block";
        pre.style.maxHeight = "140px";
        pre.textContent = String(result.texts[k] || "").slice(0, 4000);
        oCard.appendChild(pre);
      });
      panels.appendChild(oCard);
    }

    /* --- 什么都没有 --- */
    if (!panels.children.length) {
      const nCard = card("没读到什么");
      const p = document.createElement("p");
      p.className = "info-note";
      p.textContent = "这张图里没有生成参数，也没有 EXIF。可能是被截图工具或社交平台处理过 —— 它们通常会把这些信息抹掉。";
      nCard.appendChild(p);
      panels.appendChild(nCard);
    }
  }

  /* ------------------------------------------------------------ 主流程 */

  function readFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "")) {
      setStatus("这不是图片文件。", true);
      return;
    }
    if (lastUrl) {
      try { URL.revokeObjectURL(lastUrl); } catch (e) { /* 无所谓 */ }
      lastUrl = "";
    }
    lastUrl = URL.createObjectURL(file);
    el.thumb.src = lastUrl;
    el.name.textContent = file.name || "(没有名字)";
    setStatus("正在解析…");

    const name = (file.name || "").toLowerCase();
    const format = /\.png$/.test(name) || file.type === "image/png" ? "PNG"
      : /\.jpe?g$/.test(name) || file.type === "image/jpeg" ? "JPEG"
      : /\.webp$/.test(name) ? "WebP"
      : /\.gif$/.test(name) ? "GIF"
      : (file.type || "未知").replace("image/", "").toUpperCase();

    Promise.resolve()
      .then(function () {
        return file.arrayBuffer ? file.arrayBuffer() : null;
      })
      .then(function (buf) {
        const bytes = buf ? new Uint8Array(buf) : null;
        const result = {
          file: { name: file.name, size: file.size, format: format },
          texts: {},
        };

        if (bytes) {
          const png = parsePng(bytes);
          if (png) {
            result.file.width = png.info.width;
            result.file.height = png.info.height;
            result.file.depth = png.info.depth;
            result.file.colorType = COLOR_TYPES[png.info.colorType] || ("类型 " + png.info.colorType);
            result.texts = png.texts;
            /* ComfyUI 把工作流塞在 workflow 里，API 格式的参数塞在 prompt 里 */
            result.workflowText = png.texts.workflow || "";
            const comfy = extractComfy(png.texts.prompt || png.texts.workflow || "");
            if (comfy) result.comfy = comfy;
          } else {
            const exif = parseJpeg(bytes);
            if (exif) result.exif = exif;
          }
        }

        /* 尺寸没从 PNG 头拿到就从 <img> 补 —— 这是唯一需要等解码的地方 */
        if (!result.file.width && el.thumb) {
          result.file.width = el.thumb.naturalWidth || 0;
          result.file.height = el.thumb.naturalHeight || 0;
        }

        return result;
      })
      .then(function (result) {
        el.drop.classList.add("is-hidden");
        el.body.classList.remove("is-hidden");
        render(result);
        const bits = [];
        if (result.comfy) bits.push("生成参数");
        if (result.workflowText) bits.push("工作流");
        if (result.exif) bits.push("EXIF");
        setStatus(bits.length ? "读到了：" + bits.join(" · ") : "这张图里没读到元数据。");
      })
      .catch(function (e) {
        setStatus("解析出错了：" + (e && e.message ? e.message : "未知原因"), true);
      });
  }

  function reset() {
    if (lastUrl) {
      try { URL.revokeObjectURL(lastUrl); } catch (e) { /* 无所谓 */ }
      lastUrl = "";
    }
    el.file.value = "";
    el.body.classList.add("is-hidden");
    el.drop.classList.remove("is-hidden");
    el.again.classList.add("is-hidden");
    setStatus("");
  }

  /* ------------------------------------------------------------ 复制 */

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

  /* ------------------------------------------------------------ 入口 */

  function byId(id) { return document.getElementById(id); }

  function init() {
    el = {
      drop: byId("metaDrop"),
      file: byId("metaFile"),
      hint: byId("metaHint"),
      body: byId("metaBody"),
      thumb: byId("metaThumb"),
      name: byId("metaName"),
      panels: byId("metaPanels"),
      again: byId("metaAgain"),
      status: byId("metaStatus"),
    };
    if (!el.drop || !el.body) return;

    el.drop.addEventListener("click", function (ev) {
      if (ev.target !== el.file) el.file.click();
    });
    el.file.addEventListener("change", function () {
      const f = el.file.files && el.file.files[0];
      el.file.value = "";
      if (f) {
        readFile(f);
        el.again.classList.remove("is-hidden");
      }
    });
    el.again.addEventListener("click", reset);

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
      const f = dt && dt.files && dt.files[0];
      if (f) {
        readFile(f);
        el.again.classList.remove("is-hidden");
      }
    });

    /* 图片上直接 Ctrl+V 也收 */
    document.addEventListener("paste", function (ev) {
      const items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          const f = items[i].getAsFile();
          if (f) {
            readFile(f);
            el.again.classList.remove("is-hidden");
            break;
          }
        }
      }
    });
  }

  return {
    init: init,
    parsePng: parsePng,
    parseJpeg: parseJpeg,
    parseTiff: parseTiff,
    extractComfy: extractComfy,
    copyText: copyText,
    readFile: readFile,
    _render: render,
    _el: function () { return el; },
  };
})();
