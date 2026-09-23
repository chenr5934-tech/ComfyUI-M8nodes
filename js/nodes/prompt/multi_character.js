/* ============================================================================
 * M8 · 多角色编辑 —— 前端
 *
 * 分块编辑：每个角色一张卡片（提示词 + 画面区域 + 混合权重 + 羽化），
 * 上面一块画布把各角色的区域画成可拖拽的框 —— 位置这种事，拖比填数字快得多。
 *
 * 参考 ComfyUI-Danbooru-Gallery 的多角色编辑器。它那几处坑在前端这边也有对应：
 *   - 它改配置只往 mce_config 里塞 JSON，没有「改坏了会怎样」的反馈；
 *     这里每次改动都重新算一遍预览，坏值当场在预览框里显示成错误行。
 *   - 它没有区域可视化，只能填 x/y/w/h 四个数字。
 *
 * 原生 widget（format / use_fill / config / base_prompt）会被藏起来，
 * 但**只在面板挂载成功之后**才藏 —— 顺序反了，面板一旦没挂上，节点就点不动了。
 * 数值仍由它们承载和保存。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8MultiCharacter";

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui 段提供。 */
const T = M8.tFor(NODE_TYPE);

const FORMATS = ["attn", "regional", "plain"];
/* 这两张表用 getter：T() 要等异步拉完中文才有值，普通属性在模块加载那一刻就
   定死了，永远是英文。getter 每次访问才求值。 */
const FORMAT_LABELS = {
  get attn() { return T("format.attn", "Attention Couple"); },
  get regional() { return T("format.regional", "Regional Prompts"); },
  get plain() { return T("format.plain", "Plain text"); },
};
const FORMAT_HINTS = {
  get attn() { return T("formatHint.attn", "Emits COUPLE(x1 x2, y1 y2, weight) syntax for comfyui-prompt-control"); },
  get regional() { return T("formatHint.regional", "Emits prompt MASK(...) joined with AND, for Regional Prompts"); },
  get plain() { return T("formatHint.plain", "Just joins the prompts with commas: no region syntax, no third-party nodes"); },
};

/* 和颜色一样，这些参数决定框怎么画。改这里等于改整套几何。 */
const MIN_SPAN = 0.01;
const WEIGHT_MIN = 0.05;
const WEIGHT_MAX = 2.0;
const FEATHER_MAX = 512;
/* 画布的最小高度。宽度跟着节点走，比例跟着 width/height 输入走，
 * 实际绘制尺寸每一帧从 DOM 读 —— 遮罩存的是 0-1 归一化坐标，
 * 所以画布怎么缩放都不会让框和画面错位。 */
const CANVAS_MIN_H = 320;
const DEFAULT_W = 1024;
const DEFAULT_H = 1024;

/* 每个角色一个颜色，画布上的框和卡片左边那条色带用它。
 * 取的是能互相区分、又都不刺眼的中间调。 */
const ROLE_COLORS = [
  "#3ba99c", "#e8a33d", "#7aa2f7", "#c678dd",
  "#e06a30", "#56b6c2", "#98c379", "#e06c75",
];

const DEFAULT_CHARACTERS = [
  { enabled: true, name: "Character 1", prompt: "", x: 0.0, y: 0.0, w: 0.5, h: 1.0, weight: 1.0, feather: 0, fill: false },
  { enabled: true, name: "Character 2", prompt: "", x: 0.5, y: 0.0, w: 0.5, h: 1.0, weight: 1.0, feather: 0, fill: false },
];

const DEFAULT_CONFIG = {
  format: "regional",
  base: "",
  global: "",
  use_fill: false,
  characters: DEFAULT_CHARACTERS,
};

const clamp = (v, lo, hi) => Math.min(Math.max(lo, v), hi);
/** 单个角色会长成什么样。和 renderPreview 用同一套规则，只是只算一条。 */
function previewOne(cfg, char, index) {
  const prompt = String(char.prompt || "").trim();
  if (char.enabled === false) return T("disabled", "(disabled, not in the output)");
  if (!prompt) return T("emptyPrompt", "(no prompt yet)");

  const mode = FORMATS.includes(cfg.format) ? cfg.format : "regional";
  if (mode === "plain") return prompt;

  const r = regionOf(char);
  const shaped = {
    x1: r.x1, x2: r.x2, y1: r.y1, y2: r.y2,
    weight: clamp(num(char.weight, 1), WEIGHT_MIN, WEIGHT_MAX),
    feather: Math.round(clamp(num(char.feather, 0), 0, FEATHER_MAX)),
  };

  let piece = mode === "attn"
    ? "COUPLE(" + boxOf(shaped) + ") " + prompt
    : prompt + " MASK(" + boxOf(shaped) + ")";
  if (mode === "attn" && char.fill) piece += " FILL()";
  if (shaped.feather > 0) piece += " FEATHER(" + shaped.feather + ")";
  return piece;
}


function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

/* 前端读配置是宽容的：坏 JSON 就用默认值继续画。
 * 报错交给后端 —— 它执行时会抛 M8-PROMPT-001，那才是该让用户看见的地方。 */
function loadConfig(raw) {
  if (!raw || !String(raw).trim()) return cloneDefault();
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cloneDefault();
    const base = cloneDefault();
    for (const [key, value] of Object.entries(base)) {
      if (!(key in cfg)) cfg[key] = value;
    }
    if (!Array.isArray(cfg.characters)) cfg.characters = cloneDefault().characters;
    return cfg;
  } catch {
    return cloneDefault();
  }
}

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/* ---------------------------------------------------------------------------
 * 预览用渲染（与后端 node.py 对应）。和后端算法必须一致，否则预览框里
 * 显示的东西和真正输出的对不上 —— 那比没有预览更糟。
 * ------------------------------------------------------------------------- */

function regionOf(char) {
  let x = clamp(num(char.x, 0), 0, 1);
  let y = clamp(num(char.y, 0), 0, 1);
  const w = num(char.w, 1);
  const h = num(char.h, 1);
  let x2 = clamp(x + w, 0, 1);
  let y2 = clamp(y + h, 0, 1);
  if (x2 - x < MIN_SPAN) { x = Math.min(x, 1 - MIN_SPAN); x2 = x + MIN_SPAN; }
  if (y2 - y < MIN_SPAN) { y = Math.min(y, 1 - MIN_SPAN); y2 = y + MIN_SPAN; }
  return { x1: x, x2, y1: y, y2 };
}

function activeCharacters(cfg) {
  const list = Array.isArray(cfg.characters) ? cfg.characters : [];
  return list
    .map((char, index) => ({ char, index }))
    .filter(({ char }) => char && char.enabled !== false && String(char.prompt || "").trim())
    .map(({ char, index }) => {
      const r = regionOf(char);
      return {
        index,
        name: char.name || T("character", "Character") + " " + (index + 1),
        prompt: String(char.prompt || "").trim(),
        weight: clamp(num(char.weight, 1), WEIGHT_MIN, WEIGHT_MAX),
        feather: Math.round(clamp(num(char.feather, 0), 0, FEATHER_MAX)),
        fill: !!char.fill,
        ...r,
      };
    });
}

function boxOf(c) {
  return c.x1.toFixed(2) + " " + c.x2.toFixed(2) + ", " + c.y1.toFixed(2) + " " + c.y2.toFixed(2) + ", " + c.weight.toFixed(2);
}

function headOf(cfg) {
  return [cfg.base, cfg.global]
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .join(" ");
}

/* 预览。返回 {text, error} —— 出错时把话说清楚，不静默回退成半截提示词。 */
function renderPreview(cfg) {
  const chars = activeCharacters(cfg);
  const head = headOf(cfg);
  const mode = FORMATS.includes(cfg.format) ? cfg.format : "regional";

  if (mode !== "plain" && !chars.length) {
    return { text: "", error: T("noneEnabled", "No character is enabled (each one needs a checkmark and a prompt)") };
  }

  if (mode === "plain") {
    const parts = [];
    if (head) parts.push(head);
    for (const c of chars) parts.push(c.prompt);
    return { text: parts.join(", ").trim(), error: "" };
  }

  if (mode === "attn") {
    const parts = [];
    if (head) parts.push(cfg.use_fill ? head + " FILL()" : head);
    else if (cfg.use_fill) parts.push("FILL()");
    for (const c of chars) {
      let piece = "COUPLE(" + boxOf(c) + ") " + c.prompt;
      if (c.fill) piece += " FILL()";
      if (c.feather > 0) piece += " FEATHER(" + c.feather + ")";
      parts.push(piece);
    }
    return { text: parts.join(" ").trim(), error: "" };
  }

  const pieces = chars.map((c) => {
    let piece = c.prompt + " MASK(" + boxOf(c) + ")";
    if (c.feather > 0) piece += " FEATHER(" + c.feather + ")";
    return piece;
  });
  const body = pieces.join(" AND ");
  return { text: (head ? head + " AND " + body : body).trim(), error: "" };
}



/* ---------------------------------------------------------------------------
 * 反向解析
 *
 * 把一段已经写好的区域提示词拆回角色块 —— 从别人的工作流或网上抄一段过来，
 * 粘进去就能接着改，不用一个数字一个数字重填。
 *
 * 参考项目也有这个（「解析提示词」），它支持的关键字更多（AREA / IMASK /
 * MASK_SIZE / 裸 MASK）。这里**只认我们自己会生成的那三种** ——
 * COUPLE(...)、COUPLE MASK(...)、MASK(...)。认不出来就返回 null 让调用方
 * 说清楚，绝不猜：猜错了用户会以为解析成功了，然后在错的基础上继续改。
 * ------------------------------------------------------------------------- */

/* 坐标段：x1 x2, y1 y2 [, weight] —— weight 可以缺省 */
const BOX_RE = "(-?[\\d.]+)\\s+(-?[\\d.]+)\\s*,\\s*(-?[\\d.]+)\\s+(-?[\\d.]+)(?:\\s*,\\s*(-?[\\d.]+))?";

function parsePromptText(text) {
  const src = String(text || "").trim();
  if (!src) return null;

  const featherRe = /FEATHER\(\s*(\d+)\s*\)/i;
  const fillRe = /FILL\(\)/i;

  /* 先找 COUPLE 形式，找不到再找裸 MASK —— 顺序不能反，
   * 因为 COUPLE MASK(...) 里也含 MASK(...)，先找 MASK 会把 COUPLE 拆散。 */
  let hits = [];
  let re = new RegExp("COUPLE\\s*(?:\\(|MASK\\()\\s*" + BOX_RE + "\\s*\\)", "gi");
  let m;
  while ((m = re.exec(src))) hits.push({ index: m.index, end: re.lastIndex, box: m.slice(1, 6) });

  if (!hits.length) {
    re = new RegExp("MASK\\(\\s*" + BOX_RE + "\\s*\\)", "gi");
    while ((m = re.exec(src))) hits.push({ index: m.index, end: re.lastIndex, box: m.slice(1, 6) });
  }
  if (!hits.length) return null;

  const characters = [];
  let base = "";

  /* 两种格式的记号位置是**反的**，切法必须分开：
   *   attn     COUPLE(...) 提示词 COUPLE(...) 提示词   记号在前
   *   regional 提示词 MASK(...) AND 提示词 MASK(...)    记号在后
   * 统一按「记号在前」切的话，regional 的提示词会整体错一位 —— 第一个角色
   * 会拿到第二个角色的文案，最后一个角色拿到空串。 */
  const regional = /\bAND\b/i.test(src) && !/COUPLE/i.test(src);

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    let body;

    if (regional) {
      // 记号**之前**那段才是这个角色的提示词
      const segStart = i === 0 ? 0 : hits[i - 1].end;
      let seg = src.slice(segStart, hit.index).trim();
      // 段落边界上的 AND 不属于任何一边。必须单独剥一次 ——
      // split(/\s+AND\s+/) 要求 AND 前后都有空白，段首那个匹配不到。
      seg = seg.replace(/^AND\s+/i, "").replace(/\s+AND$/i, "").trim();

      if (i === 0 && /\s+AND\s+/i.test(seg)) {
        /* 只有段 0 里**真的出现了 AND**，第一块才是基础词。
         *
         * 「castle AND girl MASK(...)」→ castle 是底子，girl 是角色 1
         * 「cat MASK(...)」            → 没有 AND，cat 就是角色 1 的提示词，
         *                                base 是空的
         * 不区分这两种，没写 base 的提示词会整个丢掉第一个角色。 */
        const parts = seg.split(/\s+AND\s+/i).map((s) => s.trim()).filter(Boolean);
        base = parts.shift() || "";
        seg = parts.join(" AND ");
      }
      body = seg;
    } else {
      // 记号**之后**那段才是这个角色的提示词
      const stop = i + 1 < hits.length ? hits[i + 1].index : src.length;
      body = src.slice(hit.end, stop).trim();
      body = body.replace(/^AND\s+/i, "").replace(/\s+AND$/i, "").trim();
      if (i === 0) {
        base = src.slice(0, hit.index).trim().replace(/\s*AND\s*$/i, "").trim();
      }
    }

    let feather = 0;
    const fm = body.match(featherRe);
    if (fm) {
      feather = Math.round(clamp(parseFloat(fm[1]) || 0, 0, FEATHER_MAX));
      body = body.replace(fm[0], "").trim();
    }

    let fill = false;
    if (fillRe.test(body)) {
      fill = true;
      body = body.replace(fillRe, "").trim();
    }

    const nums = hit.box.map((v) => parseFloat(v));
    const x1 = clamp(Number.isFinite(nums[0]) ? nums[0] : 0, 0, 1);
    const x2 = clamp(Number.isFinite(nums[1]) ? nums[1] : 1, 0, 1);
    const y1 = clamp(Number.isFinite(nums[2]) ? nums[2] : 0, 0, 1);
    const y2 = clamp(Number.isFinite(nums[3]) ? nums[3] : 1, 0, 1);
    const weight = clamp(Number.isFinite(nums[4]) ? nums[4] : 1, WEIGHT_MIN, WEIGHT_MAX);

    characters.push({
      enabled: true,
      name: T("character", "Character") + " " + (characters.length + 1),
      prompt: body,
      x: x1,
      y: y1,
      w: Math.max(MIN_SPAN, x2 - x1),
      h: Math.max(MIN_SPAN, y2 - y1),
      weight,
      feather,
      fill,
    });
  }

  return { base, characters };
}

/* ---------------------------------------------------------------------------
 * 语义体检
 *
 * 参考项目有一套语法校验（validatePromptSyntax 系列）。它做那件事是因为
 * 它的输出是**纯文本字符串**，用户还可能手改，所以得解析回来核对。
 *
 * 我们这里不需要语法校验：输出来自结构化的 characters，语法是拼不错的。
 * 但它的校验里有一部分是真正有价值的 —— **语义提醒**，比如「多个 FILL()
 * 通常只需要一个」。那类问题语法完全合法，界面也不报错，只有画面不对。
 * 下面做的是这一部分。
 * ------------------------------------------------------------------------- */

function inspectConfig(cfg, frame) {
  const issues = [];
  const chars = activeCharacters(cfg);
  const all = Array.isArray(cfg.characters) ? cfg.characters : [];
  const mode = FORMATS.includes(cfg.format) ? cfg.format : "regional";
  const minSide = Math.max(64, Math.min(frame.width, frame.height));

  /* 启用了但没填提示词 —— 它们不会进输出，用户可能以为进了 */
  const blank = all.filter((c) => c && c.enabled !== false && !String(c.prompt || "").trim()).length;
  if (blank > 0) {
    issues.push({ level: "info", text: T("blankInfo", "{n} enabled characters have no prompt and will not appear in the output", { n: blank }) });
  }

  /* FILL 重复。参考项目也报了这条 —— 多个 FILL 通常只有一个生效，
   * 剩下的是白写的，而且会让人误以为某个区域被填充了。 */
  const fillCount = chars.filter((c) => c.fill).length + (cfg.use_fill ? 1 : 0);
  if (fillCount > 1) {
    issues.push({ level: "warn", text: T("fillWarn", "There are {n} FILL() blocks; one is usually enough", { n: fillCount }) });
  }

  if (mode === "plain" && fillCount > 0) {
    issues.push({ level: "warn", text: T("fillPlainWarn", "Plain text format carries no region syntax, so FILL() will not appear in the output") });
  }

  /* 区域重叠。两个角色压在同一块上，各自的标签会互相干扰 ——
   * 这是「画面里多出来奇怪的东西」最常见的原因，但语法上完全合法。 */
  for (let i = 0; i < chars.length; i++) {
    for (let j = i + 1; j < chars.length; j++) {
      const a = chars[i];
      const b = chars[j];
      const ox = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const oy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (ox > 0.02 && oy > 0.02) {
        issues.push({
          level: "info",
          text: T("overlap", "\"{a}\" and \"{b}\" overlap by about {p}% of the frame; their tags will interfere with each other",
          { a: a.name, b: b.name, p: Math.round(ox * oy * 100) }),
        });
      }
    }
  }

  /* 羽化相对画面太大。羽化的单位是像素，所以「20」在 1024 上是细边，
   * 在 256 上就是糊掉一大片 —— 必须拿画面边长当参照才看得出来。 */
  const heavy = chars.filter((c) => c.feather > minSide * 0.12);
  if (heavy.length) {
    issues.push({
      level: "warn",
      text: T("featherWarn", "Feather is large relative to the frame for {names} (over 12% of the short side); edges will smear",
          { names: heavy.map((c) => "\"" + c.name + "\"").join(", ") }),
    });
  }

  return issues;
}

/* ---------------------------------------------------------------------------
 * 区域画布
 * ------------------------------------------------------------------------- */

/* 画布视口：屏幕坐标 = 画面坐标 × scale + offset。
 * 空白处拖拽平移、滚轮缩放 —— 和参考图一致。有了它才能把局部放大来精调框。 */
function screenToFrame(view, px, py, W, H) {
  return {
    x: (px - view.x) / Math.max(0.05, view.scale) / Math.max(1, W),
    y: (py - view.y) / Math.max(0.05, view.scale) / Math.max(1, H),
  };
}

function drawRegions(ctx, W, H, chars, selected, drawing, view) {
  ctx.clearRect(0, 0, W, H);

  // 底
  ctx.fillStyle = "#1a1f22";
  ctx.fillRect(0, 0, W, H);

  /* 视口之外的区域压暗一点，一眼看出"画面边界在这" ——
     放大之后如果没有这个，会分不清哪里是画面外。 */
  const vx = view.x;
  const vy = view.y;
  const vw = W * view.scale;
  const vh = H * view.scale;
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  if (vy > 0) ctx.fillRect(0, 0, W, Math.min(vy, H));
  if (vy + vh < H) ctx.fillRect(0, Math.max(vy + vh, 0), W, H - Math.max(vy + vh, 0));
  if (vx > 0) ctx.fillRect(0, Math.max(vy, 0), Math.min(vx, W), Math.min(vh, H - Math.max(vy, 0)));
  if (vx + vw < W) ctx.fillRect(Math.max(vx + vw, 0), Math.max(vy, 0), W - Math.max(vx + vw, 0), Math.min(vh, H - Math.max(vy, 0)));

  // 网格。网格跟着缩放走，不然放大后格线会变得极稀
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const gx = Math.round(vx + (vw / 4) * i) + 0.5;
    const gy = Math.round(vy + (vh / 4) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(gx, vy);
    ctx.lineTo(gx, vy + vh);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(vx, gy);
    ctx.lineTo(vx + vw, gy);
    ctx.stroke();
  }

  // 中线亮一点，那是五五分的参照
  ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
  ctx.beginPath();
  ctx.moveTo(Math.round(vx + vw / 2) + 0.5, vy);
  ctx.lineTo(Math.round(vx + vw / 2) + 0.5, vy + vh);
  ctx.moveTo(vx, Math.round(vy + vh / 2) + 0.5);
  ctx.lineTo(vx + vw, Math.round(vy + vh / 2) + 0.5);
  ctx.stroke();

  // 画面边框
  ctx.strokeStyle = "rgba(120, 200, 190, 0.35)";
  ctx.lineWidth = 1;
  ctx.strokeRect(vx + 0.5, vy + 0.5, vw - 1, vh - 1);

  chars.forEach((c, i) => {
    const color = ROLE_COLORS[c.index % ROLE_COLORS.length];
    const x = vx + c.x1 * vw;
    const y = vy + c.y1 * vh;
    const w = Math.max(1, (c.x2 - c.x1) * vw);
    const h = Math.max(1, (c.y2 - c.y1) * vh);
    const isSel = selected === i;

    ctx.fillStyle = color + "2e";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = isSel ? 3 : 1.8;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // 标签：编号 + 名字（名字太长就截断，框里放不下）
    const label = (i + 1) + (c.name ? " " + c.name : "");
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    const tw = Math.min(ctx.measureText(label).width, w - 10);
    if (tw > 12) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
      ctx.fillRect(x + 3, y + 3, tw + 8, 16);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, x + 7, y + 11, w - 14);
    }

    // 选中时右下角画个抓手，提示这里能缩放
    if (isSel) {
      ctx.fillStyle = color;
      ctx.fillRect(x + w - 9, y + h - 9, 7, 7);
    }
  });


  /* 正在拉的新框。虚线 + 半透明填充，和已有的实心框区分开。 */
  if (drawing) {
    const x = vx + drawing.x1 * vw;
    const y = vy + drawing.y1 * vh;
    const w = Math.max(1, (drawing.x2 - drawing.x1) * vw);
    const h = Math.max(1, (drawing.y2 - drawing.y1) * vh);
    ctx.fillStyle = "rgba(59, 169, 156, 0.18)";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = M8.COLOR.primary;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    const tip = T("canvasTip", "release to create a character");
    ctx.font = "600 11px ui-monospace, Consolas, monospace";
    const tw = ctx.measureText(tip).width;
    ctx.fillRect(x + 3, y + 3, tw + 10, 17);
    ctx.fillStyle = M8.COLOR.primary;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(tip, x + 8, y + 12);
  }

  // 坐标方向说明。画布比例是跟着 width/height 走的，所以不再假设它是正方形。
  ctx.fillStyle = "rgba(255, 255, 255, 0.28)";
  ctx.font = "10px ui-monospace, Consolas, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(T("wholeFrame", "whole frame: left to right = x, top to bottom = y"), W - 7, H - 5);
}

/* ---------------------------------------------------------------------------
 * 角色卡片
 * ------------------------------------------------------------------------- */

const SMALL_INPUT = "background:rgb(0 0 0 / 23%);border:1px solid #3a3a3a;color:#e6e6e6;border-radius:4px;padding:2px 5px;box-sizing:border-box;font-size:12px;";


function el(tag, cssText) {
  const node = document.createElement(tag);
  if (cssText) node.style.cssText = cssText;
  return node;
}

const BTN_CSS = "background:rgb(0 0 0 / 12%);border:1px solid #00000061;color:#e6e6e6;border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px;line-height:1.5;";

function makeButton(label, onClick, title) {
  const b = el("button", BTN_CSS);
  b.type = "button";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("pointerdown", (event) => event.stopPropagation());
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}

/* ---------------------------------------------------------------------------
 * 主面板
 * ------------------------------------------------------------------------- */

function setup(node) {
  const w = {
    format: M8.findWidget(node, "format"),
    fill: M8.findWidget(node, "use_fill"),
    config: M8.findWidget(node, "config"),
    base: M8.findWidget(node, "base_prompt"),
    width: M8.findWidget(node, "width"),
    height: M8.findWidget(node, "height"),
  };
  if (!w.format || !w.fill || !w.config) {
    M8.warn("多角色编辑：找不到原生 widget，面板不挂载（不改动节点）");
    return;
  }

  const state = {
    cfg: loadConfig(w.config.value),
    selected: -1,
    /* 正在拖拽新框时是 {x1, y1, x2, y2}，松手就变成新角色 */
    drawing: null,
    /* 画布视口：空白处拖 = 平移，滚轮 = 缩放。放大才能精调靠得很近的两个框。 */
    view: { scale: 1, x: 0, y: 0 },
  };
  if (!FORMATS.includes(state.cfg.format)) state.cfg.format = String(w.format.value || "regional");
  if (!FORMATS.includes(state.cfg.format)) state.cfg.format = "regional";
  state.cfg.use_fill = !!w.fill.value;

  /* 布局照参考图：顶上一条工具栏，下面左边编角色、右边一整块画面。
   *
   * 两栏用 flex-wrap 而不是写死左右 —— 节点被拉窄时会自己叠成上下，
   * 不用写两套布局，也不用监听宽度（那会和节点尺寸互相触发）。
   * 两个基准宽度加起来超过容器就换行，这就是全部逻辑。 */
  const root = el("div", "display:flex;flex-direction:column;gap:8px;padding:2px 0;width:100%;box-sizing:border-box;");
  const toolbar = el("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap;box-sizing:border-box;width:100%;padding-bottom:6px;border-bottom:1px solid rgba(255,255,255,0.08);");
  /* 两栏**不换行**。之前用 flex-wrap + 两边各给 flex-basis（320 + 420），
     加起来超过节点可用宽度就直接叠成了上下 —— 画布跑到最底下去了。
     现在左栏定宽、右栏吃掉剩下的，窄了就各自压缩，位置关系不会变。 */
  const cols = el("div", "display:flex;flex-wrap:nowrap;gap:10px;width:100%;box-sizing:border-box;align-items:flex-start;");
  const leftCol = el("div", "display:flex;flex-direction:column;gap:8px;flex:0 1 300px;min-width:200px;box-sizing:border-box;");
  const rightCol = el("div", "display:flex;flex-direction:column;gap:8px;flex:1 1 auto;min-width:240px;box-sizing:border-box;");
  cols.appendChild(leftCol);
  cols.appendChild(rightCol);
  root.appendChild(toolbar);
  root.appendChild(cols);

  /* ---------------- 预览 ---------------- */
  const previewLabel = el("div", "font-size:12px;color:rgba(255,255,255,0.55);");
  previewLabel.textContent = T("previewLabel", "Output preview");
  rightCol.appendChild(previewLabel);

  const preview = el("textarea", "width:100%;min-height:56px;resize:vertical;box-sizing:border-box;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.5;background:rgb(0 0 0 / 23%);border:1px solid #333;color:#3ba99c;border-radius:6px;padding:6px;");
  preview.readOnly = true;
  rightCol.appendChild(preview);

  /* 语义体检结果。空着就完全不占地方（不显示「一切正常」那种废话 ——
     没消息本身就是好消息）。 */
  const issueBox = el("div", "display:flex;flex-direction:column;gap:4px;width:100%;box-sizing:border-box;");
  rightCol.appendChild(issueBox);

  /* ---------------- 格式与开关 ---------------- */
  const formatRow = el("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap;box-sizing:border-box;width:100%;");
  const formatLabel = el("span", "font-size:12px;color:rgba(255,255,255,0.62);flex-shrink:0;");
  formatLabel.textContent = T("formatLabel", "Output format");
  formatRow.appendChild(formatLabel);

  const formatSelect = el("select", SMALL_INPUT + "flex:1 1 130px;min-width:130px;max-width:100%;");
  for (const key of FORMATS) formatSelect.appendChild(new Option(FORMAT_LABELS[key], key));
  formatSelect.value = state.cfg.format;
  formatSelect.title = FORMAT_HINTS[state.cfg.format];
  formatRow.appendChild(formatSelect);
  toolbar.appendChild(formatRow);

  const fillRow = el("div", "display:flex;align-items:center;gap:6px;");
  const fillBox = el("input", "flex-shrink:0;");
  fillBox.type = "checkbox";
  fillBox.checked = state.cfg.use_fill;
  fillRow.appendChild(fillBox);
  const fillLabel = el("span", "font-size:12px;color:rgba(255,255,255,0.62);");
  fillLabel.textContent = T("fillLabel", "Let the base prompt fill areas no character covers (FILL, attn format only)");
  fillRow.appendChild(fillLabel);
  fillRow.title = T("fillLabel", "Let the base prompt fill areas no character covers (FILL, attn format only)");
  toolbar.appendChild(fillRow);

  /* ---------------- 区域画布 ---------------- */
  /* 画面标题行：左边写提示，右边标尺寸和缩放 —— 和参考图一样，
     尺寸和缩放挂在画布头上，一眼看得出当前在按多大的画面排布。 */
  const canvasHead = el("div", "display:flex;align-items:center;gap:8px;flex-wrap:wrap;box-sizing:border-box;width:100%;");
  const canvasLabel = el("div", "font-size:12px;color:rgba(255,255,255,0.55);");
  canvasLabel.textContent = T("canvasLabel", "Frame regions");
  canvasLabel.title = T("canvasTitle", "Drag empty space to create a character; drag a box to move it, drag its bottom-right corner to resize");
  /* 缩放 = 画布显示宽度 / 画面实际宽度。参考图上那句「缩放: 52%」就是它 ——
     有这个数才知道画布上 1 像素对应画面里多少。 */
  const zoomLabel = el("div", "font-family:ui-monospace,Consolas,monospace;font-size:11px;color:rgba(255,255,255,0.35);margin-left:auto;");
  zoomLabel.textContent = T("zoomLabel", "Zoom —");
  canvasHead.appendChild(canvasLabel);
  canvasHead.appendChild(zoomLabel);
  rightCol.appendChild(canvasHead);

  /* 画布包一层是为了把尺寸标签浮在上面 —— 标签不进画布，
     这样缩放/重绘都不用管它。 */
  const canvasWrap = el("div", "position:relative;width:100%;box-sizing:border-box;");
  /* 这里必须有一个**确定的高度来源**。
     之前把 height 拿掉、全指望 syncAspect() 事后设 aspect-ratio，
     结果它要是跑在布局之前，canvas 就塌成 0 高，整个画布看不见。
     写死一个初始比例，JS 再覆盖它。 */
  const canvas = el("canvas", "display:block;width:100%;aspect-ratio:1/1;min-height:" + CANVAS_MIN_H + "px;border:1px solid #2a2f3a;border-radius:10px;cursor:crosshair;touch-action:none;user-select:none;outline:none;box-sizing:border-box;");
  canvas.tabIndex = 0;
  canvasWrap.appendChild(canvas);

  const frameLabel = el("div", "position:absolute;right:8px;top:6px;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.6;color:rgba(255,255,255,0.5);background:rgba(0,0,0,0.5);padding:0 6px;border-radius:4px;pointer-events:none;box-sizing:border-box;");
  frameLabel.title = T("frameTitle", "Frame size, decided by the width / height inputs; the canvas is shown at this ratio");
  frameLabel.textContent = "1024 × 1024";
  canvasWrap.appendChild(frameLabel);
  rightCol.appendChild(canvasWrap);

  /* 预览挪到画布下面 —— 先 append 过，这里再 append 一次 DOM 会把它移过来。
     （用 insertBefore 也行，但那样得先记住兄弟节点，不如重挂一次直白。） */
  rightCol.appendChild(previewLabel);
  rightCol.appendChild(preview);

  /* ---------------- 角色卡片列表 ---------------- */
  const listLabel = el("div", "font-size:12px;color:rgba(255,255,255,0.55);margin-top:2px;");
  listLabel.textContent = T("listLabel", "Character editor");
  leftCol.appendChild(listLabel);

  const list = el("div", "display:flex;flex-direction:column;gap:7px;width:100%;box-sizing:border-box;");
  leftCol.appendChild(list);

  const addRow = el("div", "display:flex;gap:6px;flex-wrap:wrap;");
  leftCol.appendChild(addRow);

  /* ---------------- 基础与全局提示词 ---------------- */
  const baseFold = el("details", "border:1px solid #00000061;border-radius:6px;background:rgb(0 0 0 / 12%);box-sizing:border-box;width:100%;");
  const baseSum = el("summary", "cursor:pointer;padding:5px 10px;font-size:12px;color:rgba(255,255,255,0.72);");
  baseSum.textContent = T("baseSum", "Base + global prompt");
  baseFold.appendChild(baseSum);
  const baseBody = el("div", "padding:6px 10px 10px;display:flex;flex-direction:column;gap:6px;box-sizing:border-box;width:100%;");
  baseFold.appendChild(baseBody);

  const BASE_FIELD = SMALL_INPUT + "width:100%;min-height:44px;resize:vertical;font-family:inherit;";
  const baseTa = el("textarea", BASE_FIELD);
  baseTa.placeholder = T("basePlaceholder", "Base prompt: the backdrop of the whole frame (forest, indoors, colour tone...)");
  baseTa.value = String(state.cfg.base || "");
  baseBody.appendChild(baseTa);

  const globalTa = el("textarea", BASE_FIELD);
  globalTa.placeholder = T("globalPlaceholder", "Global prompt: appended after the base prompt, applies to every region");
  globalTa.value = String(state.cfg.global || "");
  baseBody.appendChild(globalTa);
  leftCol.appendChild(baseFold);


  const ui = {
    w, state, root, toolbar, cols, leftCol, rightCol,
    preview, formatSelect, fillBox,
    canvas, list, addRow, baseTa, globalTa, baseFold,
  };

  /* ------------------------------------------------------------ 重绘 */

  /* 自己往 config 里写值时把闸门拉下 —— 那个写入会触发 onWidgetChange，
     回调里为了「外部改了配置」而重建整个卡片列表。重建等于把正在编辑的
     输入框连焦点一起销毁，表现就是**打一个字就掉出编辑态**。
     只挡自己写的那一下，外部（载入工作流、后端回填）仍然照常重灌。 */
  let writingConfig = false;

  /** 把面板上的状态写回原生 widget。只写值，不碰顺序、不碰选项。 */
  function syncConfig() {
    writingConfig = true;
    try {
      w.config.value = JSON.stringify(state.cfg);
      if (w.format) w.format.value = state.cfg.format;
      if (w.fill) w.fill.value = state.cfg.use_fill;
    } finally {
      writingConfig = false;
    }
  }

  /** 当前画面尺寸（来自 width / height 输入）。 */
  function frameSize() {
    const width = Math.max(64, num(w.width?.value, DEFAULT_W));
    const height = Math.max(64, num(w.height?.value, DEFAULT_H));
    return { width, height };
  }

  /* 缩放 = 画布显示宽度 ÷ 画面实际宽度，再乘用户自己的放大倍数。
     有了滚轮缩放，这个数字会变，所以单独抽出来给两处调。 */
  function updateZoomLabel() {
    const width = Math.max(64, num(w.width?.value, DEFAULT_W));
    const shown = canvas.clientWidth || 0;
    const pct = shown > 0 ? Math.round((shown / width) * state.view.scale * 100) : 0;
    zoomLabel.textContent = pct > 0 ? T("zoom", "Zoom") + " " + pct + "%" : T("zoomLabel", "Zoom —");
  }

  /** 让画布的宽高比跟画面一致。不这么做的话，「占左三分之一」在宽画面上会看着不对。 */
  function syncAspect() {
    const { width, height } = frameSize();
    canvas.style.aspectRatio = width + " / " + height;
    canvas.style.minHeight = CANVAS_MIN_H + "px";
    frameLabel.textContent = width + " × " + height;
    updateZoomLabel();
  }

  function paintCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // 用 CSS 里的实际尺寸，不用固定值 —— 节点被拉宽、比例被改，这里都跟得上
    const cssW = canvas.clientWidth || 320;
    const cssH = canvas.clientHeight || CANVAS_MIN_H;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRegions(ctx, cssW, cssH, activeCharacters(state.cfg), state.selected, state.drawing, state.view);
  }


  function renderIssues() {
    const items = inspectConfig(state.cfg, frameSize());
    issueBox.innerHTML = "";
    for (const item of items) {
      const warn = item.level === "warn";
      const row = el(
        "div",
        "font-size:11px;line-height:1.45;padding:3px 7px;border-radius:4px;box-sizing:border-box;width:100%;" +
          (warn
            ? "background:rgba(224,160,46,0.14);border-left:2px solid " + M8.COLOR.warn + ";color:#e8c07a;"
            : "background:rgba(255,255,255,0.04);border-left:2px solid rgba(255,255,255,0.18);color:rgba(255,255,255,0.6);"),
      );
      row.textContent = item.text;
      issueBox.appendChild(row);
    }
  }

  function repaint() {
    paintCanvas();
    renderIssues();
    const result = renderPreview(state.cfg);
    if (result.error) {
      preview.value = "⚠ " + result.error;
      preview.style.color = M8.COLOR.warn;
    } else {
      preview.value = result.text;
      preview.style.color = M8.COLOR.primary;
    }
  }

  function commit() {
    syncConfig();
    repaint();
    app.graph?.setDirtyCanvas(true, true);
  }

  /* ------------------------------------------------------------ 卡片 */

  function cardColor(index) {
    return ROLE_COLORS[index % ROLE_COLORS.length];
  }

  function buildCard(char, index) {
    const color = cardColor(index);
    const card = el("div", "display:flex;flex-direction:column;gap:6px;padding:7px 8px 8px 10px;border:1px solid #00000061;border-left:3px solid " + color + ";border-radius:6px;background:rgb(0 0 0 / 14%);box-sizing:border-box;width:100%;");
    card.dataset.index = String(index);

    /* 第一行：勾选 + 名字 + 删除 */
    const head = el("div", "display:flex;align-items:center;gap:6px;");
    const cb = el("input", "flex-shrink:0;");
    cb.type = "checkbox";
    cb.checked = char.enabled !== false;
    cb.title = T("disableTip", "Disabled means this character stays out of the output, but its config is kept");
    cb.addEventListener("change", () => {
      char.enabled = cb.checked;
      commit();
      paintSelection();
    });
    head.appendChild(cb);

    const nameInput = el("input", SMALL_INPUT + "flex:1;min-width:0;");
    nameInput.type = "text";
    nameInput.value = String(char.name || T("character", "Character") + " " + (index + 1));
    nameInput.title = T("nameTip", "Only used to tell them apart on the panel; it never goes into the prompt");
    nameInput.addEventListener("input", () => {
      char.name = nameInput.value;
      commit();
    });
    head.appendChild(nameInput);

    head.appendChild(makeButton(T("remove", "Remove"), () => {
      state.cfg.characters.splice(index, 1);
      if (state.selected >= state.cfg.characters.length) state.selected = state.cfg.characters.length - 1;
      renderCards();
      commit();
    }, T("removeTip", "Remove this character from the list")));
    card.appendChild(head);

    /* 提示词 */
    const promptTa = el("textarea", SMALL_INPUT + "width:100%;min-height:46px;resize:vertical;font-family:inherit;line-height:1.45;");
    promptTa.placeholder = T("characterPromptPlaceholder", "This character's prompt (English tags work better, e.g. 1girl, red hair)");
    promptTa.value = String(char.prompt || "");
    promptTa.addEventListener("input", () => {
      char.prompt = promptTa.value;
      commit();
      paintSelection();
    });
    card.appendChild(promptTa);

    /* 位置 */
    const posRow = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;");
    for (const [key, label] of [["x", "x"], ["y", "y"], ["w", T("w", "w")], ["h", T("h", "h")]]) {
      const field = makeNumber(label, num(char[key], key === "w" || key === "h" ? 0.5 : 0), 0.01, null, null, (v) => {
        char[key] = clamp(v, 0, 1);
        commit();
        paintSelection();
      });
      posRow.appendChild(field.wrap);
    }
    card.appendChild(posRow);

    /* 权重与羽化 */
    const tuneRow = el("div", "display:flex;flex-wrap:wrap;gap:8px;align-items:center;");
    const wField = makeNumber(T("blendWeight", "Blend weight"), num(char.weight, 1), 0.05, null, null, (v) => {
      char.weight = clamp(v, WEIGHT_MIN, WEIGHT_MAX);
      commit();
    });
    wField.wrap.title = T("blendWeightTip", "This is the mask blend weight, not the prompt weight - it controls how strongly this region affects the image");
    tuneRow.appendChild(wField.wrap);

    const fField = makeNumber(T("feather", "Feather"), num(char.feather, 0), 1, 0, FEATHER_MAX, (v) => {
      char.feather = Math.round(clamp(v, 0, FEATHER_MAX));
      commit();
    });
    fField.wrap.title = T("featherTip", "How soft the region edge is, in pixels. Raise it if characters show visible seams; 5-15 is usually enough");
    tuneRow.appendChild(fField.wrap);

    const fillCb = el("input", "flex-shrink:0;");
    fillCb.type = "checkbox";
    fillCb.checked = !!char.fill;
    const fillWrap = el("label", "display:flex;align-items:center;gap:4px;font-size:11px;color:rgba(255,255,255,0.55);");
    fillWrap.title = T("fillTip", "Make this character's region fill the frame (FILL, attn format only)");
    fillWrap.appendChild(fillCb);
    fillWrap.appendChild(document.createTextNode("FILL"));
    fillCb.addEventListener("change", () => {
      char.fill = fillCb.checked;
      commit();
    });
    tuneRow.appendChild(fillWrap);
    card.appendChild(tuneRow);

    /* 这个角色会变成什么样 —— 直接标在卡片上，不用去预览框里找自己那一段。
       参考图里每条右侧那个「COUPLE」角标就是同一件事。 */
    const syntaxTag = el("div", "font-family:ui-monospace,Consolas,monospace;font-size:10px;line-height:1.5;color:rgba(255,255,255,0.38);word-break:break-all;border-top:1px dashed rgba(255,255,255,0.09);padding-top:5px;");
    syntaxTag.textContent = previewOne(state.cfg, char, index);
    syntaxTag.title = T("syntaxTip", "What this character produces in the current format");
    card.appendChild(syntaxTag);

    /* 点卡片 = 选中它，画布上对应的框会加粗。
       这两行是 buildCard 的收尾：监听 + **返回卡片本身**。
       加语法标签那次我把它们一起覆盖掉了，结果是 renderCards 拿到 undefined
       去 appendChild，整个面板挂载失败 —— 报错还是「parameter 1 is not of type 'Node'」，
       从字面完全看不出是少了 return。 */
    card.addEventListener("pointerdown", () => select(index));
    return card;
  }

  function renderCards() {
    list.innerHTML = "";
    const chars = Array.isArray(state.cfg.characters) ? state.cfg.characters : [];
    if (!chars.length) {
      const tip = el("div", "font-size:12px;color:rgba(255,255,255,0.45);padding:4px 2px;");
      tip.textContent = T("noCharacters", "No characters yet. Click Add character below to start.");
      list.appendChild(tip);
      return;
    }
    chars.forEach((char, index) => list.appendChild(buildCard(char, index)));
  }

  /** 选中某个角色：卡片高亮 + 画布上那个框加粗。 */
  function select(index) {
    state.selected = index;
    paintSelection();
  }

  function paintSelection() {
    paintCanvas();
    const cards = [...list.children];
    cards.forEach((card, i) => {
      if (!card.dataset) return;
      const isSel = String(state.selected) === card.dataset.index;
      card.style.background = isSel ? "rgb(59 169 156 / 12%)" : "rgb(0 0 0 / 14%)";
    });
  }

  /* ------------------------------------------------------------ 画布交互 */

  canvas.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    canvas.focus();
    if (event.button !== 0) return;

    const chars = activeCharacters(state.cfg);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || 1;
    const cssH = rect.height || 1;
    const view = state.view;
    /* 屏幕像素 → 画面坐标（0-1）。必须带上视口缩放和平移 ——
       否则一旦放大或平移过，命中的框和拖动的距离就全对不上了。 */
    const local = (e) => screenToFrame(view, e.clientX - rect.left, e.clientY - rect.top, cssW, cssH);
    const px = local(event).x;
    const py = local(event).y;

    // 从后往前测：后画的框在上层，先命中它
    let hit = -1;
    let onHandle = false;
    // 抓手在屏幕上是固定大小（12px），换算成画面单位要跟着缩放走
    const hx = 12 / Math.max(1, cssW * view.scale);
    const hy = 12 / Math.max(1, cssH * view.scale);
    for (let i = chars.length - 1; i >= 0; i--) {
      const c = chars[i];
      if (px >= c.x2 - hx && px <= c.x2 + hx && py >= c.y2 - hy && py <= c.y2 + hy) {
        hit = i;
        onHandle = true;
        break;
      }
      if (px >= c.x1 && px <= c.x2 && py >= c.y1 && py <= c.y2) {
        hit = i;
        break;
      }
    }

    /* 按在空白处 = **平移画布**（和参考图一致）。
     *
     * 之前这里做的是「拉框新建」，把平移的位置占掉了 —— 一旦放大，
     * 想挪一下视野都没地方按，这就是「难以平移」的来源。
     * 新建改走两条路：「添加角色」按钮，或者在空白处**双击**。 */
    if (hit < 0) {
      const startX = event.clientX;
      const startY = event.clientY;
      const baseX = view.x;
      const baseY = view.y;
      canvas.style.cursor = "grabbing";

      const onMove = (e) => {
        view.x = baseX + (e.clientX - startX);
        view.y = baseY + (e.clientY - startY);
        paintCanvas();
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        canvas.style.cursor = "crosshair";
        select(-1);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      event.preventDefault();
      return;
    }

    select(hit);
    const char = state.cfg.characters[chars[hit].index];
    const start = { x: num(char.x, 0), y: num(char.y, 0), w: num(char.w, 0.5), h: num(char.h, 0.5) };
    const grabX = px;
    const grabY = py;
    canvas.style.cursor = onHandle ? "nwse-resize" : "move";

    /* 拖动中只重画画布和预览，**不重建卡片** ——
     * 每帧重建整个 DOM 列表会拖到卡顿，而且输入框正在被编辑时会丢焦点。
     * 松手后再统一刷一次卡片，把新数值填进数字框。 */
    const onMove = (e) => {
      const pt = local(e);
      const nx = clamp(pt.x, 0, 1);
      const ny = clamp(pt.y, 0, 1);
      if (onHandle) {
        char.w = clamp(start.w + (nx - grabX), 0.02, Math.max(0.02, 1 - start.x));
        char.h = clamp(start.h + (ny - grabY), 0.02, Math.max(0.02, 1 - start.y));
      } else {
        char.x = clamp(start.x + (nx - grabX), 0, Math.max(0, 1 - start.w));
        char.y = clamp(start.y + (ny - grabY), 0, Math.max(0, 1 - start.h));
      }
      commit();
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      canvas.style.cursor = "crosshair";
      renderCards();
      paintSelection();
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    event.preventDefault();
  });

  /* 滚轮 = 缩放。**以光标为锚点** —— 缩的时候鼠标指着的那个点在画面上不动，
     这样「放大这块」的感觉才对；锚在画布中心的话，想看的地方会跑掉。 */
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const view = state.view;

    // 光标当前落在画面的哪个位置（0-1），缩放后要让它仍停在同一处
    const before = screenToFrame(view, mx, my, rect.width, rect.height);

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 100;
    view.scale = clamp(view.scale * Math.exp(-delta * 0.0015), 0.4, 8);

    const after = screenToFrame(view, mx, my, rect.width, rect.height);
    view.x += (after.x - before.x) * rect.width * view.scale;
    view.y += (after.y - before.y) * rect.height * view.scale;

    // 只重画：缩放不改变画面比例，不该去动 aspect-ratio
    paintCanvas();
    updateZoomLabel();
  }, { passive: false });

  /* 空白处**双击** = 就地新建一个框。
   * 平移和新建都想要空白处的拖拽，就让双击承担新建 —— 比来回点按钮快，
   * 而且新框直接落在你要的位置上。 */
  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const rect = canvas.getBoundingClientRect();
    const pt = screenToFrame(state.view, event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);

    // 新框以双击点为中心，默认占画面宽高的四分之一
    const w = 0.25;
    const h = 0.25;
    addCharacterWithRegion({
      x1: clamp(pt.x - w / 2, 0, 1 - w),
      y1: clamp(pt.y - h / 2, 0, 1 - h),
      x2: clamp(pt.x - w / 2, 0, 1 - w) + w,
      y2: clamp(pt.y - h / 2, 0, 1 - h) + h,
    });
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  /* ------------------------------------------------------------ 按钮与开关 */

  /* 新建角色的唯一入口 —— 画布上拉框和点按钮都走这里。
   * 一个角色配一个框，这是绑定关系的唯一来源：不存在「有角色没框」的状态。 */
  function addCharacterWithRegion(region) {
    const chars = state.cfg.characters;
    chars.push({
      enabled: true,
      name: T("character", "Character") + " " + (chars.length + 1),
      prompt: "",
      x: region.x1,
      y: region.y1,
      w: region.x2 - region.x1,
      h: region.y2 - region.y1,
      weight: 1.0,
      feather: 0,
      fill: false,
    });
    state.selected = chars.length - 1;
    renderCards();
    commit();
    paintSelection();
    fitNode();
  }

  addRow.appendChild(makeButton(T("addCharacter", "Add character"), () => {
    const chars = state.cfg.characters;
    // 按钮这条路没有鼠标位置可用，就按已有的块数均分摆一排，尽量不叠在一起
    const n = Math.min(chars.length + 1, 6);
    const slot = Math.min(chars.length, n - 1);
    addCharacterWithRegion({
      x1: slot / n,
      y1: 0,
      x2: (slot + 1) / n,
      y2: 1,
    });
  }, T("addCharacterTip", "Adds a character (a mask box is created for it automatically)")));

  addRow.appendChild(makeButton(T("reset", "Reset"), () => {
    if (!window.confirm(T("confirmReset", "Reset the character config back to the built-in two equal regions? Current content will be lost."))) return;
    state.cfg = cloneDefault();
    state.selected = -1;
    baseTa.value = "";
    globalTa.value = "";
    formatSelect.value = state.cfg.format;
    formatSelect.title = FORMAT_HINTS[state.cfg.format] || "";
    fillBox.checked = state.cfg.use_fill;
    renderCards();
    commit();
  }, T("resetTip", "Go back to the default two equal regions")));


  /* ------------------------------------------------------------ 预设 */

  /* 整套角色配置的存取，存服务端 —— 和相机配置同一套做法。
   * 不落 localStorage：那个东西会随清缓存、换浏览器 profile 一起消失，
   * 而且写失败时不给原因（这个坑小鲸鱼已经栽过一次）。 */
  const presetSelect = el("select", SMALL_INPUT + "flex:1 1 108px;min-width:108px;max-width:100%;");
  presetSelect.title = T("presetTip", "Load a saved character config preset");

  async function refreshPresets(select) {
    try {
      const data = await M8.apiGet("/prompt/presets");
      const files = data.files || [];
      presetSelect.innerHTML = "";
      const head = new Option(files.length ? T("loadPreset", "Load preset...") : T("noPresets", "(no presets yet)"), "", true, true);
      head.disabled = true;
      presetSelect.appendChild(head);
      for (const name of files) presetSelect.appendChild(new Option(name, name));
      if (select && files.includes(select)) presetSelect.value = select;
    } catch (exc) {
      M8.warn("读预设列表失败：", exc.code, exc.message);
    }
  }

  async function saveCurrentAsPreset() {
    const suggested = "roles_" + Date.now().toString().slice(-6);
    const input = window.prompt(T("promptPresetName", "Preset name (stored in m8/data/prompt-presets/)"), suggested);
    if (input == null) return;
    const name = String(input).trim();
    if (!name) {
      M8.notify(T("nameRequired", "The name cannot be empty"), { kind: "warn" });
      return;
    }
    try {
      await M8.apiPost("/prompt/presets/save", { name, config: state.cfg });
      M8.notify(T("presetSaved", "Preset saved: {name}", { name }), { kind: "ok", timeout: 3200 });
      await refreshPresets(name);
    } catch (exc) {
      M8.notifyError(exc, T("savingPreset", "saving the preset"));
    }
  }

  toolbar.appendChild(makeButton(T("parsePrompt", "Parse prompt"), () => {
    const text = window.prompt(T("parsePromptInput", "Paste a prompt with region syntax (COUPLE / MASK / FEATHER / FILL are supported)"), "");
    if (text == null || !text.trim()) return;
    const parsed = parsePromptText(text);
    if (!parsed) {
      M8.notify(T("noRegionSyntax", "No recognizable region syntax in that text"), {
        kind: "warn",
        hint: T("noRegionSyntaxHint", "It needs at least COUPLE(...) or MASK(...); plain text has nothing to parse"),
      });
      return;
    }
    state.cfg.base = parsed.base;
    state.cfg.characters = parsed.characters;
    state.selected = -1;
    baseTa.value = parsed.base;
    globalTa.value = "";
    renderCards();
    commit();
    paintSelection();
    M8.notify(T("parsed", "Parsed {n} characters", { n: parsed.characters.length }), { kind: "ok", timeout: 3200 });
  }, T("parsePromptTip", "Turns a region-style prompt you already wrote back into character blocks")));

  toolbar.appendChild(makeButton(T("savePreset", "Save preset"), saveCurrentAsPreset,
      T("savePresetTip", "Store the current character config on the server")));
  toolbar.appendChild(presetSelect);
  toolbar.appendChild(makeButton(T("delete", "Delete"), async () => {
    const name = presetSelect.value;
    if (!name || presetSelect.selectedIndex <= 0) {
      M8.notify(T("pickPreset", "Pick a preset from the dropdown first"), { kind: "warn" });
      return;
    }
    if (!window.confirm(T("confirmDelete", "Delete the preset \"{name}\"? This cannot be undone.", { name }))) return;
    try {
      await M8.apiPost("/prompt/presets/delete", { name });
      M8.notify(T("presetDeleted", "Preset deleted: {name}", { name }), { kind: "ok", timeout: 3000 });
      await refreshPresets();
    } catch (exc) {
      M8.notifyError(exc, T("deletingPreset", "deleting the preset"));
    }
  }, T("deleteTip", "Deletes the preset selected in the dropdown")));

  presetSelect.addEventListener("change", async () => {
    const name = presetSelect.value;
    if (!name || presetSelect.selectedIndex <= 0) return;
    try {
      const data = await M8.apiPost("/prompt/presets/load", { name });
      const cfg = data.config;
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        M8.notify(T("presetNotObject", "That preset does not hold a config object"),
      { kind: "err", hint: T("presetNotObjectHint", "Look at the file under m8/data/prompt-presets/") });
        return;
      }
      state.cfg = loadConfig(JSON.stringify(cfg));
      if (!FORMATS.includes(state.cfg.format)) state.cfg.format = "regional";
      state.selected = -1;
      formatSelect.value = state.cfg.format;
      formatSelect.title = FORMAT_HINTS[state.cfg.format] || "";
      fillBox.checked = !!state.cfg.use_fill;
      baseTa.value = String(state.cfg.base || "");
      globalTa.value = String(state.cfg.global || "");
      renderCards();
      commit();
      paintSelection();
      fitNode();
      M8.notify(T("presetLoaded", "Preset loaded: {name}", { name }), { kind: "ok", timeout: 2600 });
    } catch (exc) {
      M8.notifyError(exc, T("loadingPreset", "loading the preset"));
    }
  });

  refreshPresets();

  formatSelect.addEventListener("change", () => {
    state.cfg.format = formatSelect.value;
    formatSelect.title = FORMAT_HINTS[state.cfg.format] || "";
    commit();
  });

  fillBox.addEventListener("change", () => {
    state.cfg.use_fill = fillBox.checked;
    commit();
  });

  baseTa.addEventListener("input", () => {
    state.cfg.base = baseTa.value;
    commit();
  });

  globalTa.addEventListener("input", () => {
    state.cfg.global = globalTa.value;
    commit();
  });

  /* ------------------------------------------------------------ 挂载 */

  renderCards();

  /* 让节点跟着面板长。DOM widget 的高度不会自动带大节点，
   * 少了这套，卡片一多就会画出节点边框外面去。 */
  let fitQueued = false;
  function fitNode() {
    if (window.LiteGraph?.vueNodesMode) return;
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
      fitQueued = false;
      if (!node.size) return;
      const want = node.computeSize()[1];
      if (Math.abs(node.size[1] - want) > 1) {
        node.setSize([node.size[0], want]);
        app.graph?.setDirtyCanvas(true, true);
      }
    });
  }

  const domWidget = node.addDOMWidget("m8_prompt_panel", "div", root, { serialize: false });
  domWidget.computeSize = () => [root.clientWidth || 0, Math.ceil(root.scrollHeight) || 0];

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => fitNode());
    ro.observe(root);
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
      ro.disconnect();
      onRemoved?.apply(this, arguments);
    };
  }

  baseFold.addEventListener("toggle", () => fitNode());

  /* 画面尺寸变了，画布比例要跟着变 —— 不跟的话「占左三分之一」在宽画面上会看着不对。
     比例一变画布高度也变，所以顺手把节点尺寸也算一遍。 */
  for (const key of ["width", "height"]) {
    M8.onWidgetChange(node, key, () => {
      syncAspect();
      paintCanvas();
      fitNode();
    });
  }

  /* 原生 widget 被别的途径改过（载入工作流、后端回填）时，面板跟着走 */
  M8.onWidgetChange(node, "config", () => {
    if (writingConfig) return;   // 自己刚写进去的，不必回灌
    const next = loadConfig(w.config.value);
    state.cfg = next;
    formatSelect.value = state.cfg.format;
    fillBox.checked = !!state.cfg.use_fill;
    baseTa.value = String(state.cfg.base || "");
    globalTa.value = String(state.cfg.global || "");
    renderCards();
    repaint();
  });

  const origConfigure = node.configure;
  node.configure = function () {
    const result = origConfigure?.apply(this, arguments);
    requestAnimationFrame(fitNode);
    return result;
  };

  /* 面板挂成功了才藏原生 widget ——
   * 顺序反了的话，面板一旦没挂上，节点就成了个点不动的方块。
   *
   * **width / height 不藏**：藏掉 widget 的同时，那个入口的连线接点也没了，
   * 于是「从别的节点接画面尺寸过来」这条路直接消失。这两个本来就该既能手填、
   * 也能连线（ComfyUI 的 widget 默认就带接点，除非显式 forceInput）。
   * 它们留在节点上是可用的，只是不参与这个可视化面板。 */
  for (const [key, widget] of Object.entries(w)) {
    if (!widget) continue;
    if (key === "width" || key === "height") continue;
    M8.hideWidget(widget);
  }

  /* 首次挂载给一个够宽的尺寸。两栏在窄节点上会叠成上下，画布就变小了 ——
     而这个面板的重点恰恰是画布要够大。
     用 properties 记标记而不是实例属性：它会随工作流保存下来，
     所以用户把节点拉窄、存盘、重开，不会被又一次顶宽。 */
  node.properties = node.properties || {};
  if (!node.properties.m8PromptSized) {
    node.properties.m8PromptSized = true;
    if (node.size && node.size[0] < 780) {
      node.setSize([780, node.size[1] || 600]);
    }
  }

  syncAspect();
  repaint();
  requestAnimationFrame(fitNode);
  M8.log("多角色编辑面板已挂载");
}

app.registerExtension({
  name: "M8.MultiCharacter",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        // 面板没挂上也要让节点能用 —— 原生那几个 widget 还在，只是没藏起来
        M8.error("多角色编辑面板挂载失败：", exc);
      }
    };
  },
});
function makeNumber(label, value, step, min, max, onChange) {
  const wrap = el("label", "display:flex;align-items:center;gap:4px;font-size:11px;color:rgba(255,255,255,0.55);");
  const name = document.createTextNode(label);
  const input = el("input", SMALL_INPUT + "width:56px;");
  input.type = "number";
  input.step = String(step);
  if (min != null) input.min = String(min);
  if (max != null) input.max = String(max);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v)) return;
    onChange(v);
  });
  wrap.appendChild(name);
  wrap.appendChild(input);
  return { wrap, input };
}
