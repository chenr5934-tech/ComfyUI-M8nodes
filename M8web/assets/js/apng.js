/* ============================================================================
 * M8web · APNG 动图合成（算法层）
 *
 * 把若干张图拼成一个 APNG。整条链路没有黑箱：
 *
 *   每张图 -> canvas 统一尺寸 -> PNG 字节
 *          -> 解析出 IHDR + IDAT
 *          -> 按 APNG 规范重新装箱（acTL / fcTL / fdAT）
 *          -> 一个 .png 文件，播放器当动图放
 *
 * **为什么要自己装箱**：APNG 不是一个独立的容器格式，它就是 PNG 加几个块。
 * 第一帧沿用 PNG 原本的 IDAT，后续帧的数据放进 fdAT（多 4 字节序列号）。
 * 浏览器认不认，全看这些块的顺序和字段对不对，所以这一层必须自己写清楚。
 *
 * 核心函数 `build()` 是**纯函数**：吃单帧 PNG 的字节数组，吐 APNG 的字节数组，
 * 一次都不碰 DOM。测试里就是自己造几张小 PNG 喂进去验的，不用起浏览器 ——
 * 这条路子和 meta.js 的 parsePng 一样。
 *
 * 这一层不碰画布、不碰文件；拿图、缩放、编码成单帧 PNG 在页面那一层做。
 * ==========================================================================*/

/* 界面文案走 i18n.js。它是 module，而这些功能脚本是普通脚本，拿不到 import ——
   i18n.js 因此挂了一份到 window。

   用 var 而不是 const：普通脚本共享全局作用域，const 在这里重复声明会直接报
   "Identifier 'T' has already been declared"，一个页面同时加载几个脚本就白屏。
   var 重复声明是合法的，每个文件仍然自足，不依赖加载顺序。

   宿主对象用 globalThis 取而不是直接写 window：前端测试在 Node 里跑这些脚本，
   那边没有 window，直接解引用会当场 "window is not defined"。

   i18n 没加载成功时走这里的兜底：**必须自己填占位符** —— 直接返回 fallback 的话，
   界面上会原样显示 "{n} 帧" 这种花括号，比换不成中文更糟。 */
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

var M8Apng = (function () {
  "use strict";

  var SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

  /* APNG 的延迟是分数：delay_num / delay_den 秒。
     用 100 做分母（百分之一秒），这是 APNG 圈子里的惯例，解码器都支持。
     分子是 16 位无符号 —— 65535/100 = 655.35 秒，够长了，不用管溢出。 */
  var DELAY_DEN = 100;

  /* 每帧时长只能是 10ms 的整数倍 —— 分母是 100，一个分子刻度就是 10ms。
     所以**在这里就把值对齐**，而不是让「界面上写 25ms、文件里实际 30ms」。

     这个精度损失是格式固有的，不是实现问题：APNG 没有毫秒这个单位。
     对齐之后「显示的值」和「解码器读出来的值」永远相等，用户不会看到
     一个对不上的数字。 */
  var DELAY_QUANTUM_MS = 1000 / DELAY_DEN;

  /* 每帧时长的上下限（毫秒）。
     下限取 20ms：很多解码器把 delay=0 当成「用默认值」或者直接跳过那一帧，
     用户拖到最快会看到「有几帧不见了」。20ms = 50fps，比这更快人眼也分不出。 */
  var MIN_DELAY_MS = 20;
  var MAX_DELAY_MS = 10000;

  /* ---------------------------------------------------------------- CRC32 */

  /* PNG 每个块都要带 CRC32（多项式 0xEDB88320，标准的那张表）。 */
  var CRC_TABLE = null;

  function crcTable() {
    if (CRC_TABLE) return CRC_TABLE;
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
    return table;
  }

  /** 算一段字节的 CRC32。范围是 [start, end)，默认整段。 */
  function crc32(bytes, start, end) {
    var table = crcTable();
    var lo = start === undefined ? 0 : start;
    var hi = end === undefined ? bytes.length : end;
    var c = 0xffffffff;
    for (var i = lo; i < hi; i++) {
      c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------------------------------------------------------------- 字节读写 */

  /* PNG 的块长度和所有整数**都是大端**（和 TIFF 相反 —— 这个项目里两种格式
     同时存在，写错一次就会得到「解析器看着没错但数据是反的」那种错）。 */
  function readU32(bytes, pos) {
    return ((bytes[pos] << 24) | (bytes[pos + 1] << 16) |
            (bytes[pos + 2] << 8) | bytes[pos + 3]) >>> 0;
  }

  function writeU32(out, pos, value) {
    out[pos] = (value >>> 24) & 0xff;
    out[pos + 1] = (value >>> 16) & 0xff;
    out[pos + 2] = (value >>> 8) & 0xff;
    out[pos + 3] = value & 0xff;
  }

  function writeU16(out, pos, value) {
    out[pos] = (value >>> 8) & 0xff;
    out[pos + 1] = value & 0xff;
  }

  function bytesOf(text) {
    var out = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
    return out;
  }

  /**
   * 组装一个 PNG 块：长度(4) + 类型(4) + 数据 + CRC(4)。
   *
   * **CRC 只覆盖「类型 + 数据」，不含长度那 4 个字节。** 这是最容易写错的一处 ——
   * 把长度也算进去，块头看着完全正常，解码器却会在第一个块就报 CRC 错。
   */
  function makeChunk(type, data) {
    var payload = data || new Uint8Array(0);
    var out = new Uint8Array(12 + payload.length);
    writeU32(out, 0, payload.length);
    var typeBytes = bytesOf(type);
    out[4] = typeBytes[0]; out[5] = typeBytes[1];
    out[6] = typeBytes[2]; out[7] = typeBytes[3];
    out.set(payload, 8);
    writeU32(out, 8 + payload.length, crc32(out, 4, 8 + payload.length));
    return out;
  }

  /* ---------------------------------------------------------------- 解析单帧 PNG */

  /**
   * 从一份 PNG 字节里取出 IHDR 和全部 IDAT。
   *
   * 坏数据一律**安静地少给点信息**（返回 null 或提前收工），不抛异常 ——
   * 和 meta.js 的解析器一个原则：坏文件不该让整个界面炸掉。
   *
   * @returns {width, height, bitDepth, colorType, interlace, idat: Uint8Array[]}
   */
  function parsePng(bytes) {
    if (!bytes || bytes.length < 8 + 25) return null;
    for (var i = 0; i < 8; i++) {
      if (bytes[i] !== SIGNATURE[i]) return null;
    }

    var out = { width: 0, height: 0, bitDepth: 0, colorType: 0, interlace: 0, idat: [] };
    var pos = 8;
    var guard = 0;
    var seenIhdr = false;

    while (pos + 8 <= bytes.length && guard < 4000) {
      guard += 1;
      var len = readU32(bytes, pos);
      // 长度明显是坏的（比剩下的字节还长）就停手，别继续读越界
      if (len > bytes.length - pos - 8) break;
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var data = bytes.subarray(pos + 8, pos + 8 + len);
      pos += 12 + len;

      if (type === "IHDR" && len >= 13) {
        out.width = readU32(data, 0);
        out.height = readU32(data, 4);
        out.bitDepth = data[8];
        out.colorType = data[9];
        // data[10] 是压缩方法、data[11] 是过滤方法，规范里都只能是 0
        out.interlace = data[12];
        seenIhdr = true;
      } else if (type === "IDAT") {
        out.idat.push(data);
      } else if (type === "IEND") {
        break;
      }
    }

    if (!seenIhdr || !out.width || !out.height || !out.idat.length) return null;
    return out;
  }

  /** 把一帧的结构信息拉成一行，用来比对两帧兼不兼容。 */
  function frameShape(info) {
    return [info.width, info.height, info.bitDepth, info.colorType, info.interlace].join("x");
  }

  /* ---------------------------------------------------------------- 组装 APNG */

  /**
   * 把若干单帧 PNG 拼成一个 APNG。**纯函数，不碰 DOM。**
   *
   * @param frames  [{ png: Uint8Array }]，至少一帧
   * @param opts    { delayMs, loops }
   *                  delayMs 每帧显示多久（毫秒），会被夹到 [20, 10000]
   *                  loops   循环次数，0 = 无限
   * @returns Uint8Array 完整的 APNG 字节
   */
  function build(frames, opts) {
    if (!frames || !frames.length) {
      throw new Error(T("apngNoFrames", "一帧都没有，没法合成。"));
    }

    var settings = opts || {};
    var delayMs = Math.round(Number(settings.delayMs));
    if (!isFinite(delayMs) || delayMs <= 0) delayMs = 100;
    delayMs = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, delayMs));
    delayMs = Math.round(delayMs / DELAY_QUANTUM_MS) * DELAY_QUANTUM_MS;
    var delayNum = delayMs / DELAY_QUANTUM_MS;        // 百分之一秒
    var loops = Math.max(0, Math.round(Number(settings.loops) || 0));

    // 1) 逐帧解析，顺便确认它们彼此兼容
    var parsed = [];
    for (var i = 0; i < frames.length; i++) {
      var info = parsePng(frames[i] && frames[i].png);
      if (!info) {
        throw new Error(T("apngBadFrame", "第 {n} 帧不是合法的 PNG，合不了。", { n: i + 1 }));
      }
      if (info.interlace !== 0) {
        /* APNG 规范要求帧是非交错的。canvas 出来的 PNG 本来就是非交错，
           所以撞上这条基本意味着有人塞了别的工具生成的图进来。 */
        throw new Error(T("apngInterlaced", "第 {n} 帧是交错 PNG，APNG 不支持。", { n: i + 1 }));
      }
      if (parsed.length && frameShape(info) !== frameShape(parsed[0])) {
        /* 尺寸或色彩格式不一致 —— APNG 只允许一个 IHDR，所有帧共用它。
           页面那一层会把每帧都画到同一尺寸的画布上，所以正常走不到这儿；
           走到了说明调用方绕过了那一层。 */
        throw new Error(T("apngSizeMismatch",
          "第 {n} 帧的尺寸或色彩格式和第一帧对不上，所有帧必须一致。", { n: i + 1 }));
      }
      parsed.push(info);
    }

    var head = parsed[0];

    // 2) IHDR 整块照搬第一帧 —— 不是重新构造，省得漏掉某个字段
    var ihdr = new Uint8Array(13);
    writeU32(ihdr, 0, head.width);
    writeU32(ihdr, 4, head.height);
    ihdr[8] = head.bitDepth;
    ihdr[9] = head.colorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    var parts = [];
    var push = function (bytes) { parts.push(bytes); };

    // 3) 签名 + IHDR
    push(new Uint8Array(SIGNATURE));
    push(makeChunk("IHDR", ihdr));

    // 4) acTL：帧数 + 循环次数（0 = 无限）
    var actl = new Uint8Array(8);
    writeU32(actl, 0, parsed.length);
    writeU32(actl, 4, loops);
    push(makeChunk("acTL", actl));

    /* 5) 帧数据。
       序列号由 fcTL 和 fdAT **共用**一个递增计数器 —— IDAT 不占号。
       第一帧的数据还是走 IDAT（这样不支持 APNG 的解码器也能看到一张静态图），
       第二帧起才用 fdAT，每个 fdAT 前面多 4 字节序列号。 */
    var seq = 0;

    function frameControl(index) {
      var fctl = new Uint8Array(26);
      writeU32(fctl, 0, seq++);
      writeU32(fctl, 4, head.width);
      writeU32(fctl, 8, head.height);
      writeU32(fctl, 12, 0);            // x_offset
      writeU32(fctl, 16, 0);            // y_offset
      writeU16(fctl, 20, delayNum);     // delay_num
      writeU16(fctl, 22, DELAY_DEN);    // delay_den
      fctl[24] = 0;                     // dispose_op: 0 = 不处理，下一帧直接盖上去
      fctl[25] = 0;                     // blend_op:   0 = 覆盖（源 alpha 混合）
      return makeChunk("fcTL", fctl);
    }

    push(frameControl(0));
    for (var j = 0; j < head.idat.length; j++) push(makeChunk("IDAT", head.idat[j]));

    for (var k = 1; k < parsed.length; k++) {
      push(frameControl(k));
      var frame = parsed[k];
      for (var m = 0; m < frame.idat.length; m++) {
        var data = frame.idat[m];
        var fdat = new Uint8Array(4 + data.length);
        writeU32(fdat, 0, seq++);
        fdat.set(data, 4);
        push(makeChunk("fdAT", fdat));
      }
    }

    push(makeChunk("IEND", new Uint8Array(0)));

    // 6) 拼起来
    var total = 0;
    for (var p = 0; p < parts.length; p++) total += parts[p].length;
    var out = new Uint8Array(total);
    var at = 0;
    for (var q = 0; q < parts.length; q++) {
      out.set(parts[q], at);
      at += parts[q].length;
    }
    return out;
  }

  /**
   * 把速度倍率换算成每帧时长（毫秒）。
   *
   * 界面上给的是「倍率」（0.25× ~ 4×），因为它比毫秒直观：拖到 2× 就是快一倍，
   * 不用去想「100ms 和 200ms 哪个快」。基准 100ms ≈ 10fps。
   */
  function delayFromSpeed(speed, baseMs) {
    var s = Number(speed);
    if (!isFinite(s) || s <= 0) s = 1;
    var base = Number(baseMs);
    if (!isFinite(base) || base <= 0) base = 100;
    var ms = Math.max(MIN_DELAY_MS, Math.min(MAX_DELAY_MS, Math.round(base / s)));
    // 和 build() 用同一套对齐 —— 界面上显示的就是文件里的
    return Math.round(ms / DELAY_QUANTUM_MS) * DELAY_QUANTUM_MS;
  }

  /** 一个 APNG 字节串里有多少帧。解析失败返回 0。 */
  function countFrames(bytes) {
    if (!bytes || bytes.length < 8) return 0;
    var pos = 8;
    var n = 0;
    var guard = 0;
    while (pos + 8 <= bytes.length && guard < 4000) {
      guard += 1;
      var len = readU32(bytes, pos);
      if (len > bytes.length - pos - 8) break;
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      if (type === "fcTL") n += 1;
      pos += 12 + len;
      if (type === "IEND") break;
    }
    return n;
  }

  /** 读出每个 fcTL 记的延迟（毫秒）。测试用，也用来在界面上显示实际时长。 */
  function readDelays(bytes) {
    var out = [];
    if (!bytes || bytes.length < 8) return out;
    var pos = 8;
    var guard = 0;
    while (pos + 8 <= bytes.length && guard < 4000) {
      guard += 1;
      var len = readU32(bytes, pos);
      if (len > bytes.length - pos - 8) break;
      var type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
      var data = bytes.subarray(pos + 8, pos + 8 + len);
      if (type === "fcTL" && len >= 26) {
        var num = (data[20] << 8) | data[21];
        var den = (data[22] << 8) | data[23];
        out.push(den > 0 ? Math.round((num / den) * 1000) : 0);
      }
      pos += 12 + len;
      if (type === "IEND") break;
    }
    return out;
  }

  /* ================================================================ 页面层 */

  /* 到这一层才开始碰 DOM。上面的都是纯函数，测试直接从外面调。 */

  var el = null;
  var state = {
    first: null,        // { file, url, w, h }
    rest: [],           // [{ file, url, id }]
    out: null,          // 合成出来的 APNG 字节
    outUrl: null,       // 预览用的 blob URL
  };
  var seqId = 0;

  function byId(id) {
    return typeof document === "undefined" ? null : document.getElementById(id);
  }

  function setStatus(text, kind) {
    if (!el || !el.status) return;
    el.status.textContent = text || "";
    el.status.dataset.kind = kind || "";
  }

  function isImage(file) {
    if (!file) return false;
    if (file.type && /^image\//.test(file.type)) return true;
    // 有些系统拖进来的文件没有 type，退回看扩展名
    return /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name || "");
  }

  /**
   * 算出源图画到目标画布上的位置和大小。**纯函数。**
   *
   * 返回 [dx, dy, dw, dh]。cover 模式下这个矩形会**超出画布**，靠画布自己裁掉 ——
   * 所以这里不需要额外算裁剪，只要把中心对齐就行。
   */
  function fitRect(srcW, srcH, dstW, dstH, mode) {
    if (!srcW || !srcH) return [0, 0, dstW, dstH];
    if (mode === "stretch") return [0, 0, dstW, dstH];
    var scale = mode === "cover"
      ? Math.max(dstW / srcW, dstH / srcH)
      : Math.min(dstW / srcW, dstH / srcH);
    var w = srcW * scale;
    var h = srcH * scale;
    return [(dstW - w) / 2, (dstH - h) / 2, w, h];
  }

  /**
   * 一张图 -> 单帧 PNG 的字节。
   *
   * 走 canvas 是为了**统一尺寸和格式**：APNG 只有一份 IHDR，所有帧必须一模一样，
   * 而用户丢进来的图尺寸和色彩类型通常各不相同。
   */
  async function fileToPng(file, dstW, dstH, mode) {
    var bitmap = await createImageBitmap(file);
    try {
      var canvas = document.createElement("canvas");
      canvas.width = dstW;
      canvas.height = dstH;
      var ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      var r = fitRect(bitmap.width, bitmap.height, dstW, dstH, mode);
      ctx.drawImage(bitmap, r[0], r[1], r[2], r[3]);

      var blob = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) {
          if (b) resolve(b);
          else reject(new Error(T("apngEncodeFailed", "这张图编码不成 PNG。")));
        }, "image/png");
      });
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      if (bitmap && bitmap.close) bitmap.close();
    }
  }

  /** 输出尺寸：首图的尺寸乘上缩放档。 */
  function targetSize() {
    var factor = Number(el.scale.value) || 1;
    var w = Math.max(1, Math.round(state.first.w * factor));
    var h = Math.max(1, Math.round(state.first.h * factor));
    return [w, h];
  }

  function currentDelay() {
    return M8Apng.delayFromSpeed(Number(el.speed.value) || 1);
  }

  function releaseUrl(url) {
    if (url && typeof URL !== "undefined" && URL.revokeObjectURL) URL.revokeObjectURL(url);
  }

  /* ---------------------------------------------------------------- 导入 */

  async function setFirst(file) {
    if (!isImage(file)) {
      setStatus(T("apngNotImage", "这个文件不是图片，换一张。"), "warn");
      return;
    }
    var bitmap = await createImageBitmap(file);
    var w = bitmap.width;
    var h = bitmap.height;
    if (bitmap.close) bitmap.close();

    releaseUrl(state.first && state.first.url);
    state.first = { file: file, url: URL.createObjectURL(file), w: w, h: h };

    el.firstThumb.src = state.first.url;
    el.firstThumb.classList.remove("is-hidden");
    el.firstIco.classList.add("is-hidden");
    dropText(el.firstDrop, true);
    updateSizeOut();
    setStatus("");
  }

  function addRest(files) {
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      if (!isImage(files[i])) continue;
      seqId += 1;
      state.rest.push({ file: files[i], url: URL.createObjectURL(files[i]), id: seqId });
      added += 1;
    }
    if (!added) {
      setStatus(T("apngNotImage", "这个文件不是图片，换一张。"), "warn");
      return;
    }
    renderStrip();
    setStatus(T("apngAdded", "又放进 {n} 张。", { n: added }));
  }

  /** 把上传区中间那两行字收起来（放上图之后就不需要提示了）。 */
  function dropText(drop, hide) {
    var kids = drop.querySelectorAll("strong, small");
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("is-hidden", !!hide);
    }
  }

  function updateSizeOut() {
    if (!el.sizeOut) return;
    if (!state.first) {
      el.sizeOut.textContent = T("apngSizeNone", "先选首图");
      return;
    }
    var s = targetSize();
    el.sizeOut.textContent = s[0] + " × " + s[1];
  }

  /* ---------------------------------------------------------------- 缩略图条 */

  function renderStrip() {
    el.strip.innerHTML = "";

    state.rest.forEach(function (item, index) {
      var node = document.createElement("div");
      node.className = "apng-item";
      node.draggable = true;
      node.dataset.index = String(index);
      // 序号从 2 开始 —— 首图是第 1 帧，这里全都排在它后面
      node.innerHTML = '<img src="' + item.url + '" alt=""><i>' + (index + 2) + "</i>";

      var del = document.createElement("button");
      del.type = "button";
      del.textContent = "×";
      del.title = T("apngRemove", "移掉这一张");
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        removeRest(index);
      });
      node.appendChild(del);

      node.addEventListener("dragstart", function (ev) {
        dragFrom = index;
        node.classList.add("is-dragging");
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
      });
      node.addEventListener("dragend", function () {
        node.classList.remove("is-dragging");
        dragFrom = null;
      });
      node.addEventListener("dragover", function (ev) {
        ev.preventDefault();
        node.classList.add("is-over");
      });
      node.addEventListener("dragleave", function () {
        node.classList.remove("is-over");
      });
      node.addEventListener("drop", function (ev) {
        ev.preventDefault();
        node.classList.remove("is-over");
        if (dragFrom === null || dragFrom === index) return;
        moveRest(dragFrom, index);
      });

      el.strip.appendChild(node);
    });

    el.restCount.textContent = String(state.rest.length);
  }

  var dragFrom = null;

  function moveRest(from, to) {
    var item = state.rest.splice(from, 1)[0];
    state.rest.splice(to, 0, item);
    renderStrip();
  }

  function removeRest(index) {
    var gone = state.rest.splice(index, 1)[0];
    releaseUrl(gone && gone.url);
    renderStrip();
  }

  /* ---------------------------------------------------------------- 合成 */

  async function run() {
    if (!state.first) {
      setStatus(T("apngNeedFirst", "先选一张首图 —— 它决定尺寸，也是第一帧。"), "warn");
      return;
    }
    if (!state.rest.length) {
      setStatus(T("apngNeedRest", "后面至少再放一张，一张图动不起来。"), "warn");
      return;
    }

    el.go.disabled = true;
    setStatus(T("apngWorking", "正在合成…"));

    try {
      var size = targetSize();
      var mode = el.fit.value;
      var frames = [];

      frames.push({ png: await fileToPng(state.first.file, size[0], size[1], mode) });
      for (var i = 0; i < state.rest.length; i++) {
        setStatus(T("apngWorkingN", "正在合成… {a}/{b}", { a: i + 2, b: state.rest.length + 1 }));
        frames.push({ png: await fileToPng(state.rest[i].file, size[0], size[1], mode) });
      }

      var bytes = M8Apng.build(frames, {
        delayMs: currentDelay(),
        loops: Math.max(0, Number(el.loops.value) || 0),
      });

      releaseUrl(state.outUrl);
      state.out = bytes;
      state.outUrl = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));

      el.out.src = state.outUrl;
      el.body.classList.remove("is-hidden");
      el.save.classList.remove("is-hidden");
      renderMeta(bytes, size, frames.length);
      setStatus(T("apngDone", "合成好了：{n} 帧。", { n: frames.length }), "ok");
    } catch (exc) {
      setStatus(String((exc && exc.message) || exc), "err");
    } finally {
      el.go.disabled = false;
    }
  }

  function renderMeta(bytes, size, frameCount) {
    if (!el.meta) return;
    var kb = Math.round(bytes.length / 1024);
    var per = currentDelay();
    var total = per * frameCount / 1000;
    var rows = [
      [T("apngMetaFrames", "帧数"), String(frameCount)],
      [T("apngMetaSize", "尺寸"), size[0] + " × " + size[1]],
      [T("apngMetaDelay", "每帧停留"), per + " ms"],
      [T("apngMetaTotal", "一轮时长"), total.toFixed(2) + " s"],
      [T("apngMetaBytes", "文件大小"), kb >= 1024 ? (kb / 1024).toFixed(2) + " MB" : kb + " KB"],
    ];
    el.meta.innerHTML = rows.map(function (r) {
      return '<div class="kv-row"><span>' + r[0] + "</span><b>" + r[1] + "</b></div>";
    }).join("");
  }

  function save() {
    if (!state.out || !state.outUrl) return;
    var a = document.createElement("a");
    a.href = state.outUrl;
    var d = new Date();
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    a.download = "m8-anim-" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function reset() {
    releaseUrl(state.first && state.first.url);
    state.rest.forEach(function (it) { releaseUrl(it.url); });
    releaseUrl(state.outUrl);
    state.first = null;
    state.rest = [];
    state.out = null;
    state.outUrl = null;
    seqId = 0;

    if (el.firstThumb) { el.firstThumb.removeAttribute("src"); }
    if (el.firstThumb) el.firstThumb.classList.add("is-hidden");
    if (el.firstIco) el.firstIco.classList.remove("is-hidden");
    dropText(el.firstDrop, false);
    renderStrip();
    updateSizeOut();
    el.body.classList.add("is-hidden");
    el.save.classList.add("is-hidden");
    setStatus("");
  }

  /** 给一个上传区挂上：点击选择 / 拖放 / 高亮。 */
  function bindDrop(drop, input, onFiles) {
    drop.addEventListener("click", function (ev) {
      if (ev.target !== input) input.click();
    });
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      input.value = "";
      if (files.length) onFiles(files);
    });
    ["dragenter", "dragover"].forEach(function (t) {
      drop.addEventListener(t, function (ev) {
        ev.preventDefault();
        drop.classList.add("over");
      });
    });
    ["dragleave", "dragend"].forEach(function (t) {
      drop.addEventListener(t, function () { drop.classList.remove("over"); });
    });
    drop.addEventListener("drop", function (ev) {
      ev.preventDefault();
      drop.classList.remove("over");
      var dt = ev.dataTransfer;
      var files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
      if (files.length) onFiles(files);
    });
  }

  function init() {
    el = {
      firstDrop: byId("apngFirstDrop"),
      firstFile: byId("apngFirstFile"),
      firstThumb: byId("apngFirstThumb"),
      firstIco: byId("apngFirstIco"),
      restDrop: byId("apngRestDrop"),
      restFile: byId("apngRestFile"),
      restCount: byId("apngRestCount"),
      strip: byId("apngStrip"),
      speed: byId("apngSpeed"),
      speedOut: byId("apngSpeedOut"),
      delayOut: byId("apngDelayOut"),
      fit: byId("apngFit"),
      scale: byId("apngScale"),
      sizeOut: byId("apngSizeOut"),
      loops: byId("apngLoops"),
      go: byId("apngGo"),
      save: byId("apngSave"),
      clear: byId("apngClear"),
      body: byId("apngBody"),
      out: byId("apngOut"),
      meta: byId("apngMeta"),
      status: byId("apngStatus"),
    };
    // 页面上没有这套元素（比如测试里只加载脚本）就直接收工
    if (!el.firstDrop || !el.go) return;

    bindDrop(el.firstDrop, el.firstFile, function (files) { setFirst(files[0]); });
    bindDrop(el.restDrop, el.restFile, addRest);

    el.speed.addEventListener("input", updateSpeed);
    el.scale.addEventListener("change", updateSizeOut);
    el.go.addEventListener("click", run);
    el.save.addEventListener("click", save);
    el.clear.addEventListener("click", reset);

    /* 改了速度就把上一次的结果下掉 —— 预览里那张动图的节奏已经不是新参数了，
       留着会让人以为改参数没用。 */
    el.fit.addEventListener("change", invalidate);
    el.loops.addEventListener("change", invalidate);

    updateSpeed();
    updateSizeOut();
    renderStrip();
  }

  function updateSpeed() {
    var speed = Number(el.speed.value) || 1;
    el.speedOut.textContent = speed.toFixed(2) + "×";
    el.delayOut.textContent = String(currentDelay());
    invalidate();
  }

  function invalidate() {
    if (state.out && el.body && !el.body.classList.contains("is-hidden")) {
      setStatus(T("apngParamsChanged", "参数变了，点「合成 APNG」重新算一遍。"));
    }
  }

  return {
    // 常量（测试和页面都用得到）
    SIGNATURE: SIGNATURE,
    MIN_DELAY_MS: MIN_DELAY_MS,
    MAX_DELAY_MS: MAX_DELAY_MS,
    DELAY_DEN: DELAY_DEN,
    DELAY_QUANTUM_MS: DELAY_QUANTUM_MS,
    // 纯函数
    crc32: crc32,
    makeChunk: makeChunk,
    parsePng: parsePng,
    frameShape: frameShape,
    build: build,
    delayFromSpeed: delayFromSpeed,
    countFrames: countFrames,
    readDelays: readDelays,
    fitRect: fitRect,
    // 页面
    init: init,
  };
})();
