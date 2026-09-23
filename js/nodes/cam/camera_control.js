/* ============================================================================
 * M8 · 相机控制 —— 前端
 *
 * 界面照 BSK_相机控制 做（用户指定），三维球面视图 + 四个滑块 + 提示词预览。
 *
 * ## 操作（和 BSK 一致，另按用户要求补了滚轮调远近）
 *   左键拖画布    抓住世界旋转（水平环形，不跳变）
 *   滚轮          调远近
 *   右键拖        调远近（BSK 的原始方式，保留）
 *   Shift + 滚轮  调翻滚
 *   方向键        X / Y 微调（Shift 步长加大）
 *   [ ]           Z 微调
 *   , .           翻滚微调
 *
 * ## 三维是怎么回事
 * 不是平面装饰，是真投影：世界坐标 → 球面 → 透视除法。
 * 主体在 (0, K, 0)，相机在半径 R 的球面上，方位角由 pos_x 给、俯仰角由 pos_y 给。
 * 轨道画两遍 —— 先画后半（会被球挡住那半），再画前半，中间夹着主体，
 * 于是就有了前后关系。相机图标本身会按 roll 旋转。
 *
 * ## 隐藏 widget
 * 原生那五个（pos_x/y/z/roll/config）会被藏起来，但**只在面板挂载成功之后**才藏。
 * 顺序反过来的话，面板一旦没挂上，节点就成一个点不动的方块了。
 * 数值仍由它们承载和保存，只是不再让你手填。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8CameraControl";

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui 段提供。 */
const T = M8.tFor(NODE_TYPE);

/* 画布的逻辑尺寸。投影公式里那堆 280 / 250 / 380 全是按这个尺寸推出来的，改这里等于改整套透视。 */
const W = 560;
const H = 500;
/* 主体中心离地高度（世界坐标）。相机绕它转。 */
const K = 0.7;
/* 垂直偏移：让整个球在画布里居中。即 380 * -0.275。 */
const OFF_Y = 380 * -0.275;
/* 焦距：透视除法分子上的那个系数。 */
const FOCAL = 380;

const AZ_POLE = 0.9;
const ELEV_EYE_MAX = 0.2;

/* ---------------------------------------------------------------------------
 * 配色（取自 BSK，保持一致）
 * ------------------------------------------------------------------------- */
const PALETTE = {
  orbitAz: "rgba(77, 208, 225, 0.4)",
  orbitAzHot: "rgba(77, 208, 225, 0.7)",
  orbitEl: "rgba(255, 138, 76, 0.45)",
  orbitElHot: "rgba(255, 138, 76, 0.7)",
  axisUp: "rgba(120, 220, 255, 0.95)",
  axisDown: "rgba(120, 220, 255, 0.45)",
  axisFlat: "rgba(190, 190, 210, 0.8)",
  front: "#ffd166",
  ball: "rgba(77, 208, 225, 1)",
  ballTop: "rgba(150, 230, 255, 1)",
  center0: "#9af0fa",
  center1: "#2f8a93",
  camBody0: "#ffa66a",
  camBody1: "#e06a30",
  camGlow: "255, 138, 76",
  behind: "#ff8a4c",
  roll: "#c792ea",
  hint: "rgba(255, 255, 255, 0.62)",
};

/* ---------------------------------------------------------------------------
 * 默认配置。**必须和后端 node.py 的 DEFAULT_CONFIG 逐字一致** ——
 * 两边不一致会出现「面板显示的值和实际输出的权重对不上」这种极难查的问题。
 * tests/smoke_import.py 会比对 tag。
 * ------------------------------------------------------------------------- */
const DEFAULT_CONFIG = {
  weight_min: 0.1,
  weight_max: 10.0,
  no_weight: false,
  no_weight_threshold: 0.5,
  azimuth: {
    enabled: true,
    weight: 10.0,
    deadzone_ratio: 0.2,
    directions: {
      front: { tag: "from front", enabled: true },
      back: { tag: "from behind", enabled: true },
      left: { tag: "from right", enabled: true },
      right: { tag: "from left", enabled: true },
    },
  },
  elevation: {
    enabled: true,
    extra: 10.0,
    eye_peak: 3.0,
    categories: {
      bird: { tag: "directly above, from above, aerial view,", enabled: true },
      high: { tag: "high angle, from above", enabled: true },
      eye: { tag: "eye-level", enabled: true },
      low: { tag: "low angle, from below,", enabled: true },
      worm: { tag: "directly below", enabled: true },
    },
  },
  distance: {
    enabled: true,
    extra: 0.0,
    categories: {
      ecu: { tag: "extreme close-up", enabled: true },
      cu: { tag: "close-up", enabled: true },
      medium: { tag: "medium shot", enabled: true },
      full: { tag: "full body", enabled: true },
      wide: { tag: "wide shot", enabled: true },
    },
  },
  tilt: {
    enabled: true,
    deadzone: 0.15,
    extra: 0.0,
    dutch_tag: "dutch angle",
  },
  extra_master: 1.0,
  drag_step: 0.004,
  wheel_step: 0.0003,
  extras: {
    lens: { enabled: false, value: "85mm lens" },
    dof: { enabled: false, value: "shallow depth of field", weight: 1.3 },
    movement: { enabled: false, value: "handheld camera" },
    composition: { enabled: false, value: "rule of thirds" },
    style: { enabled: false, value: "cinematic" },
  },
};

const DIST_RANGES = {
  ecu: [0.7, 1.0],
  cu: [0.2, 0.7],
  medium: [-0.2, 0.2],
  full: [-0.7, -0.2],
  wide: [-1.0, -0.7],
};
const DIST_FAR_STRONGER = new Set(["medium", "full", "wide"]);

/* 下面几张标签表用的是 getter 而不是普通属性。

   为什么：界面文案走 T()，而 T() 要等异步拉完中文才有值。普通属性在模块加载那
   一刻就求值定死了，那时中文还没到 —— 表里永远是英文，之后再也不会更新。getter
   每次访问才求值，所以取到的一直是当前语言。 */
const AXIS_LABELS = {
  get x() { return T("axis.x", "Left / Right (X)"); },
  get y() { return T("axis.y", "Up / Down (Y)"); },
  get z() { return T("axis.z", "Near / Far (Z)"); },
  get roll() { return T("axis.roll", "Roll"); },
};
const EXTRA_LABELS = {
  get lens() { return T("extra.lens", "Lens"); },
  get dof() { return T("extra.dof", "Depth"); },
  get movement() { return T("extra.movement", "Camera move"); },
  get composition() { return T("extra.composition", "Composition"); },
  get style() { return T("extra.style", "Style"); },
};
const FIELD_LABELS = {
  get front() { return T("field.front", "Front"); },
  get back() { return T("field.back", "Back"); },
  get left() { return T("field.left", "Left"); },
  get right() { return T("field.right", "Right"); },
  get bird() { return T("field.bird", "Bird's eye"); },
  get high() { return T("field.high", "High angle"); },
  get eye() { return T("field.eye", "Eye level"); },
  get low() { return T("field.low", "Low angle"); },
  get worm() { return T("field.worm", "Worm's eye"); },
  get ecu() { return T("field.ecu", "Extreme close-up"); },
  get cu() { return T("field.cu", "Close-up"); },
  get medium() { return T("field.medium", "Medium shot"); },
  get full() { return T("field.full", "Full shot"); },
  get wide() { return T("field.wide", "Wide shot"); },
};
const LENS_OPTIONS = [
  "85mm lens", "50mm lens", "35mm lens", "24mm lens",
  "wide angle lens", "fisheye lens", "telephoto lens", "macro lens",
];

/* ---------------------------------------------------------------------------
 * 算法（预览用，与后端 node.py 对应）
 * ------------------------------------------------------------------------- */

const clamp = (v, lo, hi) => Math.min(Math.max(lo, v), hi);
const fmtWeight = (w) => Number(w).toFixed(2);
const splitTags = (tag) => String(tag || "").split(",").map((t) => t.trim()).filter(Boolean);
const emitWeighted = (tag, w) => splitTags(tag).map((t) => "(" + t + ":" + fmtWeight(w) + ")");
const emitPlain = (tag) => splitTags(tag);

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function mergeDefaults(cfg, base) {
  for (const [key, value] of Object.entries(base)) {
    if (!(key in cfg)) {
      cfg[key] = value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
    } else if (value && typeof value === "object" && cfg[key] && typeof cfg[key] === "object") {
      mergeDefaults(cfg[key], value);
    }
  }
  return cfg;
}

/* 前端读配置是宽容的：坏 JSON 就用默认值继续画；报错交给后端执行时抛 M8-CAM-001。 */
function loadConfig(raw) {
  if (!raw || !String(raw).trim()) return cloneDefault();
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return cloneDefault();
    return mergeDefaults(cfg, cloneDefault());
  } catch {
    return cloneDefault();
  }
}

const num = (cfg, key, fallback) => {
  const v = Number(cfg?.[key]);
  return Number.isFinite(v) ? v : fallback;
};

function elevationKey(y) {
  if (y > 0.7) return "bird";
  if (y > ELEV_EYE_MAX) return "high";
  if (y >= 0) return "eye";
  if (y >= -0.7) return "low";
  return "worm";
}

function elevationWeight(cfg, y) {
  const key = elevationKey(y);
  const elev = cfg.elevation || {};
  if (key === "eye") {
    const peak = num(elev, "eye_peak", 3.0);
    return peak + (1 - peak) * clamp(y / ELEV_EYE_MAX, 0, 1);
  }
  const k = 1 + num(cfg, "extra_master", 1) * num(elev, "extra", 0);
  if (k <= 0) return 0;
  return Math.abs(y) * k;
}

function distanceKey(z) {
  if (z > 0.7) return "ecu";
  if (z > 0.2) return "cu";
  if (z >= -0.2) return "medium";
  if (z >= -0.7) return "full";
  return "wide";
}

function extrasParts(cfg, weighted) {
  const parts = [];
  const extras = cfg.extras || {};
  for (const key of ["lens", "dof", "movement", "composition", "style"]) {
    const item = extras[key];
    if (!item || !item.enabled) continue;
    const value = String(item.value || "").trim();
    if (!value) continue;
    parts.push(weighted && key === "dof"
      ? "(" + value + ":" + fmtWeight(item.weight ?? 1.3) + ")"
      : value);
  }
  return parts;
}

/* 无权重模式：纯 tag。方位只报主导，平视/中景默认档不输出。与后端同名逻辑一致。 */
function computePlainPrompt(x, y, z, roll, cfg) {
  const parts = [];
  const threshold = num(cfg, "no_weight_threshold", 0.5);

  const az = cfg.azimuth || {};
  if (az.enabled !== false) {
    const angle = x * Math.PI;
    const raw = {
      front: Math.max(0, Math.cos(angle)),
      back: Math.max(0, -Math.cos(angle)),
      left: Math.max(0, -Math.sin(angle)),
      right: Math.max(0, Math.sin(angle)),
    };
    const total = raw.front + raw.back + raw.left + raw.right;
    if (total > 0) for (const k of Object.keys(raw)) raw[k] /= total;
    const gate = clamp((1 - Math.abs(y)) / (1 - AZ_POLE), 0, 1);
    if (gate > 0) {
      const usable = [];
      for (const name of ["front", "back", "left", "right"]) {
        const dir = (az.directions || {})[name];
        if (!dir || dir.enabled === false) continue;
        usable.push([name, raw[name]]);
      }
      let dom = null, best = -1;
      for (const [name, ratio] of usable) if (ratio > best) { best = ratio; dom = name; }
      if (dom && best > 0) parts.push(...emitPlain(az.directions[dom].tag));
      for (const [name, ratio] of usable) {
        if (name !== dom && ratio >= threshold) parts.push(...emitPlain(az.directions[name].tag));
      }
    }
  }

  const elev = cfg.elevation || {};
  if (elev.enabled !== false) {
    const key = elevationKey(y);
    const cat = (elev.categories || {})[key];
    if (key !== "eye" && cat && cat.tag && cat.enabled !== false) parts.push(...emitPlain(cat.tag));
  }

  const dist = cfg.distance || {};
  if (dist.enabled !== false) {
    const key = distanceKey(z);
    const cat = (dist.categories || {})[key];
    if (key !== "medium" && cat && cat.tag && cat.enabled !== false) parts.push(...emitPlain(cat.tag));
  }

  const tilt = cfg.tilt || {};
  if (tilt.enabled !== false && Math.abs(roll) >= num(tilt, "deadzone", 0.15)) {
    parts.push(...emitPlain(tilt.dutch_tag));
  }

  parts.push(...extrasParts(cfg, false));
  const joined = parts.join(", ");
  return joined ? joined + "," : "";
}

function computePrompt(x, y, z, roll, cfg) {
  if (cfg.no_weight) return computePlainPrompt(x, y, z, roll, cfg);

  const wmin = num(cfg, "weight_min", 0.1);
  const wmax = num(cfg, "weight_max", 10);
  const parts = [];

  const az = cfg.azimuth || {};
  if (az.enabled !== false) {
    const angle = x * Math.PI;
    const raw = {
      front: Math.max(0, Math.cos(angle)),
      back: Math.max(0, -Math.cos(angle)),
      left: Math.max(0, -Math.sin(angle)),
      right: Math.max(0, Math.sin(angle)),
    };
    const total = raw.front + raw.back + raw.left + raw.right;
    if (total > 0) for (const k of Object.keys(raw)) raw[k] /= total;
    const gate = clamp((1 - Math.abs(y)) / (1 - AZ_POLE), 0, 1);
    const budget = num(az, "weight", 10) * gate;
    const floor = num(az, "deadzone_ratio", 0.2);
    for (const name of ["front", "back", "left", "right"]) {
      const dir = (az.directions || {})[name];
      if (!dir || dir.enabled === false) continue;
      const ratio = raw[name];
      const w = ratio * budget;
      if (ratio <= 0 || w < floor) continue;
      parts.push(...emitWeighted(dir.tag, clamp(w, wmin, wmax)));
    }
  }

  const elev = cfg.elevation || {};
  if (elev.enabled !== false) {
    const key = elevationKey(y);
    const cat = (elev.categories || {})[key];
    if (cat && cat.tag && cat.enabled !== false) {
      const w = elevationWeight(cfg, y);
      if (w > 0) parts.push(...emitWeighted(cat.tag, clamp(w, wmin, wmax)));
    }
  }

  const dist = cfg.distance || {};
  if (dist.enabled !== false) {
    const key = distanceKey(z);
    const cat = (dist.categories || {})[key];
    if (cat && cat.tag && cat.enabled !== false) {
      const [start, end] = DIST_RANGES[key];
      const frac = DIST_FAR_STRONGER.has(key)
        ? clamp((end - z) / (end - start), 0, 1)
        : clamp((z - start) / (end - start), 0, 1);
      const w = 1 + frac * num(cfg, "extra_master", 1) * num(dist, "extra", 0);
      parts.push(...emitWeighted(cat.tag, clamp(w, wmin, wmax)));
    }
  }

  const tilt = cfg.tilt || {};
  if (tilt.enabled !== false && Math.abs(roll) >= num(tilt, "deadzone", 0.15)) {
    const w = clamp(1 + num(cfg, "extra_master", 1) * num(tilt, "extra", 0), wmin, wmax);
    parts.push(...emitWeighted(tilt.dutch_tag, w));
  }

  parts.push(...extrasParts(cfg, true));
  const joined = parts.join(", ");
  return joined ? joined + "," : "";
}

/* ---------------------------------------------------------------------------
 * 三维投影
 * ------------------------------------------------------------------------- */

/* 世界坐标 → 屏幕坐标。
 * (4 - z) 是相机到点的距离，除它就是透视 —— 离得远的自然变小、往中心收。
 * 1.8 是观察高度，OFF_Y 把整个球往下挪一点让它在画布里居中。 */
function project(x, y, z) {
  const d = 4 - z;
  if (d < 0.1) return null;
  return {
    sx: W / 2 + (x / d) * FOCAL,
    sy: H / 2 - ((y - 1.8) / d) * FOCAL + OFF_Y,
    depth: d,
  };
}

/* 相机位姿：把 (pos_x, pos_y, pos_z) 变成球面上的一个点。
 * 半径随 pos_z 变（推远 = 球变大 = 相机离主体远），
 * 方位角 = pos_x * π，俯仰角 = pos_y * π/2 并夹在 ±90°（越过极点会翻面）。 */
function cameraPose(x, y, z) {
  const r = 1.7 - 0.75 * z;
  const az = x * Math.PI;
  const el = clamp((y * Math.PI) / 2, -Math.PI / 2, Math.PI / 2);
  return {
    x: r * Math.cos(el) * Math.sin(az),
    y: K + r * Math.sin(el),
    z: r * Math.cos(el) * Math.cos(az),
    R: r,
    az,
    el,
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* 画球面上的一个圈，按 back 决定只画前半还是后半 ——
 * 被球挡住那半必须断开，前后关系才立得住。
 * sample(t) 返回世界坐标 {x, y, z}，t 取 [0, 1]。
 * 判据用点的 z：z 为正表示在球的前侧。 */
function strokeArcOnSphere(ctx, back, sample, color, dash) {
  const STEPS = 50;
  ctx.beginPath();
  ctx.setLineDash(dash);
  let drawing = false;
  for (let i = 0; i <= STEPS; i++) {
    const p = sample(i / STEPS);
    const pt = project(p.x, p.y, p.z);
    const visible = pt && (p.z > 0 ? !back : back);
    if (visible) {
      if (drawing) ctx.lineTo(pt.sx, pt.sy);
      else { ctx.moveTo(pt.sx, pt.sy); drawing = true; }
    } else {
      drawing = false;
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

/* 三条轨道：赤道、过相机方位的子午圈、相机所在的俯仰圈。 */
function drawOrbits(ctx, back, pose, absolute) {
  const R = pose.R;

  strokeArcOnSphere(ctx, back, (t) => {
    const a = t * Math.PI * 2;
    return { x: R * Math.cos(a), y: K, z: R * Math.sin(a) };
  }, absolute ? PALETTE.orbitAzHot : PALETTE.orbitAz, [5, 7]);

  strokeArcOnSphere(ctx, back, (t) => {
    const a = -Math.PI / 2 + t * Math.PI;
    return {
      x: R * Math.cos(a) * Math.sin(pose.az),
      y: K + R * Math.sin(a),
      z: R * Math.cos(a) * Math.cos(pose.az),
    };
  }, absolute ? PALETTE.orbitElHot : PALETTE.orbitEl, [5, 6]);

  strokeArcOnSphere(ctx, back, (t) => {
    const a = t * Math.PI * 2;
    return {
      x: R * Math.cos(pose.el) * Math.cos(a),
      y: K + R * Math.sin(pose.el),
      z: R * Math.cos(pose.el) * Math.sin(a),
    };
  }, absolute ? PALETTE.orbitAzHot : PALETTE.orbitAz, [5, 6]);
}

/* 带光照的球。半径按深度缩 —— 这就是立体感的另一半来源。 */
function drawBall(ctx, x, y, z, color, label) {
  const p = project(x, y, z);
  if (!p) return;
  const r = clamp((2.5 / p.depth) * 9, 3.5, 16);
  const g = ctx.createRadialGradient(p.sx - 0.35 * r, p.sy - 0.35 * r, 0.2 * r, p.sx, p.sy, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.4, color);
  g.addColorStop(1, "rgba(0, 0, 0, 0.35)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
  ctx.fill();
  if (label) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    ctx.font = "700 " + Math.max(14, r + 6) + "px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, p.sx, p.sy - r - 9);
  }
}

/* 世界原点处那根坐标架：上下左右前后六个方向，前方特意用金黄标出来。 */
function drawAxes(ctx) {
  const o = project(0, K, 0);
  if (!o) return;
  const up = project(0, 1.25, 0);
  const down = project(0, K - 0.55, 0);
  const right = project(0.55, K, 0);
  const left = project(-0.55, K, 0);
  const front = project(0, K, 0.55);
  const back = project(0, K, -0.55);

  const line = (pt, color, width) => {
    if (!pt) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1.5;
    ctx.beginPath();
    ctx.moveTo(o.sx, o.sy);
    ctx.lineTo(pt.sx, pt.sy);
    ctx.stroke();
  };
  line(up, PALETTE.axisUp, 1.6);
  line(down, PALETTE.axisDown, 1.2);
  line(right, PALETTE.axisFlat, 1.2);
  line(left, PALETTE.axisFlat, 1.2);
  line(back, PALETTE.axisFlat, 1.2);
  line(front, PALETTE.front, 2.4);

  // 前方那根加个箭头，一眼看出哪边是"镜头朝向"
  if (front) {
    const a = Math.atan2(front.sy - o.sy, front.sx - o.sx);
    ctx.strokeStyle = PALETTE.front;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(front.sx, front.sy);
    ctx.lineTo(front.sx - 7 * Math.cos(a - Math.PI / 7), front.sy - 7 * Math.sin(a - Math.PI / 7));
    ctx.moveTo(front.sx, front.sy);
    ctx.lineTo(front.sx - 7 * Math.cos(a + Math.PI / 7), front.sy - 7 * Math.sin(a + Math.PI / 7));
    ctx.stroke();
  }
}

/* 主体：一个青蓝色球 + 地面投影椭圆，坐在世界中心。 */
function drawCenter(ctx) {
  const c = project(0, K, 0);
  if (!c) return;
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.beginPath();
  ctx.ellipse(c.sx, c.sy + 40, 20, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  const g = ctx.createRadialGradient(c.sx - 5, c.sy - 6, 3, c.sx, c.sy, 16);
  g.addColorStop(0, PALETTE.center0);
  g.addColorStop(1, PALETTE.center1);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(c.sx, c.sy, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

/* 相机本体。位置在球面上，朝向指着主体，roll 会把机身拧一下。 */
function drawCamera(ctx, pose, roll, absolute, posZ) {
  const p = project(pose.x, pose.y, pose.z);
  const c = project(0, K, 0);
  if (!p || !c) return;

  // 视线：从主体指向相机，黄虚线
  ctx.strokeStyle = "rgba(255, 209, 102, 0.7)";
  ctx.lineWidth = 2.5;
  ctx.setLineDash([5, 7]);
  ctx.beginPath();
  ctx.moveTo(p.sx, p.sy);
  ctx.lineTo(c.sx, c.sy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = PALETTE.front;
  ctx.beginPath();
  ctx.arc(c.sx, c.sy, 3, 0, Math.PI * 2);
  ctx.fill();

  // 朝内一点的点，用来算"相机指向主体"这个方向
  const inner = project(0.9 * pose.x, 0.9 * pose.y + 0.001, 0.9 * pose.z);
  if (!inner) return;
  const facing = Math.atan2(p.sy - inner.sy, p.sx - inner.sx);

  // 橙色光晕：相机在哪儿，哪儿就有光。
  // 机身尺寸随深度缩（远处小），再随距离档补一点 —— 凑近了该显得大。
  const scale = clamp(2.5 / p.depth, 0.5, 2);
  const r = Math.max(8, 14 * (1.4 - 0.45 * posZ) * scale);
  const glowR = 2.5 * r;
  const g = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, glowR);
  g.addColorStop(0, "rgba(" + PALETTE.camGlow + ", 0.55)");
  g.addColorStop(0.4, "rgba(" + PALETTE.camGlow + ", 0.18)");
  g.addColorStop(1, "rgba(" + PALETTE.camGlow + ", 0)");
  ctx.fillStyle = g;
  ctx.fillRect(p.sx - glowR, p.sy - glowR, glowR * 2, glowR * 2);

  if (absolute) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, 1.7 * r, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.save();
  ctx.translate(p.sx, p.sy);
  // 机身朝向主体，外加 roll 造成的拧转（roll 拉满 = 45°）
  ctx.rotate(facing + (roll * Math.PI) / 4);

  const bw = 1.8 * r;
  const bh = 1.2 * r;
  ctx.fillStyle = "rgba(0, 0, 0, 0.5)";
  roundRect(ctx, -bw / 2 + 1, -bh / 2 + 2, bw, bh, 3);
  ctx.fill();

  const body = ctx.createLinearGradient(0, -bh / 2, 0, bh / 2);
  body.addColorStop(0, PALETTE.camBody0);
  body.addColorStop(1, PALETTE.camBody1);
  ctx.fillStyle = body;
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 3);
  ctx.fill();

  // 镜头 + 一点反光
  ctx.fillStyle = "#0b0e13";
  ctx.beginPath();
  ctx.arc(0.4 * r, 0, 0.42 * r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
  ctx.beginPath();
  ctx.arc(0.35 * r, -0.1 * r, 0.12 * r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* 四个方位球 + 顶部/底部球，标上 F/B/L/R。 */
function drawFieldBalls(ctx, pose) {
  const R = pose.R;
  const ring = R * Math.cos(pose.el);
  const h = K + R * Math.sin(pose.el);
  drawBall(ctx, 0, K, R, PALETTE.ball, "F");
  drawBall(ctx, 0, K, -R, PALETTE.ball, "B");
  drawBall(ctx, R, K, 0, PALETTE.ball, "L");
  drawBall(ctx, -R, K, 0, PALETTE.ball, "R");
  if (ring > 0.05) {
    drawBall(ctx, 0, h, ring, PALETTE.ballTop, "");
    drawBall(ctx, 0, h, -ring, PALETTE.ballTop, "");
  }
}

/* ---------------------------------------------------------------------------
 * 面板零件
 * ------------------------------------------------------------------------- */

function el(tag, cssText) {
  const node = document.createElement(tag);
  if (cssText) node.style.cssText = cssText;
  return node;
}

const BTN_CSS = "background:rgb(0 0 0 / 12%);border:1px solid #00000061;color:#e6e6e6;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:13px;line-height:1.5;";
const INPUT_CSS = "background:rgb(0 0 0 / 23%);border:1px solid #3a3a3a;color:#e6e6e6;border-radius:4px;padding:3px 6px;box-sizing:border-box;font-size:13px;";
const LABEL_CSS = "font-size:13px;color:rgba(255,255,255,0.7);flex-shrink:0;";

function makeButton(label, onClick) {
  const b = el("button", BTN_CSS);
  b.type = "button";
  b.textContent = label;
  // 面板挂在节点上，点按钮别让画布把事件也收走
  b.addEventListener("pointerdown", (event) => event.stopPropagation());
  b.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return b;
}

/* 一行：标签 + 滑块 + 数字框。三者互相同步。 */
function makeSlider(label, value, onChange) {
  const row = el("div", "display:flex;align-items:center;gap:8px;");

  const name = el("span", LABEL_CSS + "width:64px;");
  name.textContent = label;

  const slider = el("input", "flex:1;min-width:0;");
  slider.type = "range";
  slider.min = "-1";
  slider.max = "1";
  slider.step = "0.01";
  slider.value = String(value);

  const box = el("input", INPUT_CSS + "width:64px;");
  box.type = "number";
  box.min = "-1";
  box.max = "1";
  box.step = "0.01";
  box.value = Number(value).toFixed(2);

  slider.addEventListener("input", () => {
    const v = clamp(parseFloat(slider.value) || 0, -1, 1);
    box.value = v.toFixed(2);
    onChange(v);
  });

  box.addEventListener("input", () => {
    let v = parseFloat(box.value);
    if (!Number.isFinite(v)) return;
    v = clamp(v, -1, 1);
    slider.value = String(v);
    onChange(v);
  });

  row.appendChild(name);
  row.appendChild(slider);
  row.appendChild(box);

  return {
    row,
    set(v) {
      slider.value = String(v);
      box.value = Number(v).toFixed(2);
    },
  };
}

/* 折叠区。默认收起 —— 不常改的东西不该一直占地方。 */
function makeFold(title, open) {
  const box = el("details", "border:1px solid #00000061;border-radius:6px;background:rgb(0 0 0 / 12%);");
  if (open) box.open = true;
  const sum = el("summary", "cursor:pointer;padding:5px 10px;font-size:13px;color:rgba(255,255,255,0.75);");
  sum.textContent = title;
  const body = el("div", "padding:6px 10px 10px;display:flex;flex-direction:column;gap:7px;box-sizing:border-box;width:100%;");
  box.appendChild(sum);
  box.appendChild(body);
  return { box, body };
}

/* 一行：启用勾选 + 名字 + 文本框。权重设置和自定义提示词里反复用。 */
function makeFieldRow(label, value, onInput, placeholder) {
  const row = el("div", "display:flex;align-items:center;gap:7px;");
  const cb = el("input", "flex-shrink:0;");
  cb.type = "checkbox";
  cb.checked = true;
  const name = el("span", "width:52px;font-size:12px;color:rgba(255,255,255,0.62);flex-shrink:0;");
  name.textContent = label;
  const input = el("input", INPUT_CSS + "flex:1;min-width:0;font-size:12px;");
  input.type = "text";
  input.value = value || "";
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener("input", () => onInput(cb.checked, input.value));
  cb.addEventListener("change", () => onInput(cb.checked, input.value));
  row.appendChild(cb);
  row.appendChild(name);
  row.appendChild(input);
  return { row, cb, input };
}

/* ---------------------------------------------------------------------------
 * 主面板
 * ------------------------------------------------------------------------- */

/* 这两条是字符串不是表，没法用 getter；改成函数，取的时候才是当前语言。
   用处都在同一段里（下面 hintEl.textContent 那几处）。 */
const hintRelative = () => T("hint.relative", "Drag the canvas: grabs the world and rotates it, no jumps");
const hintAbsolute = () => T("hint.absolute", "Drag the canvas: the pointer position is the parameter (absolute mapping)");

function setup(node) {
  const w = {
    x: M8.findWidget(node, "pos_x"),
    y: M8.findWidget(node, "pos_y"),
    z: M8.findWidget(node, "pos_z"),
    roll: M8.findWidget(node, "roll"),
    config: M8.findWidget(node, "config"),
  };
  if (!w.x || !w.y || !w.z || !w.roll || !w.config) {
    M8.warn("相机控制：找不到原生 widget，面板不挂载（不改动节点）");
    return;
  }

  const state = {
    x: Number(w.x.value) || 0,
    y: Number(w.y.value) || 0,
    z: Number(w.z.value) || 0,
    roll: Number(w.roll.value) || 0,
    cfg: loadConfig(w.config.value),
    absolute: false,
  };

  // width:100% + border-box：面板要正好占满节点宽度，多一个像素都会往外画
  const root = el("div", "display:flex;flex-direction:column;gap:8px;padding:2px 0;width:100%;box-sizing:border-box;");

  /* ---------------- 画布 + 覆盖层 ---------------- */
  const wrap = el("div", "position:relative;");
  // border 要算进宽度里（border-box），否则 1px 边框会把画布往右顶出节点
  const canvas = el("canvas", "display:block;width:100%;height:auto;aspect-ratio:560/500;border:1px solid #2a2f3a;border-radius:10px;cursor:crosshair;touch-action:none;user-select:none;outline:none;box-sizing:border-box;");
  canvas.tabIndex = 0;
  wrap.appendChild(canvas);

  const overlay = el("div", "position:absolute;left:0;right:0;top:0;padding:8px 10px;display:flex;justify-content:space-between;align-items:flex-start;pointer-events:none;");
  const hintEl = el("div", "color:" + PALETTE.hint + ";max-width:62%;font-size:13px;");
  hintEl.textContent = hintRelative();
  const readout = el("div", "display:flex;flex-direction:column;align-items:flex-end;gap:2px;");
  const azimuthEl = el("div", "color:" + PALETTE.behind + ";font-family:monospace;font-weight:700;font-size:13px;");
  azimuthEl.textContent = "FRONT · 0°";
  const rollEl = el("div", "color:" + PALETTE.roll + ";font-family:monospace;font-weight:700;font-size:13px;");
  rollEl.textContent = "ROLL: 0°";
  readout.appendChild(azimuthEl);
  readout.appendChild(rollEl);
  overlay.appendChild(hintEl);
  overlay.appendChild(readout);
  wrap.appendChild(overlay);
  root.appendChild(wrap);

  /* ---------------- 四个滑块 ---------------- */
  const sliders = {};
  for (const key of ["x", "y", "z", "roll"]) {
    const s = makeSlider(AXIS_LABELS[key], state[key], (v) => {
      state[key] = v;
      commit();
    });
    sliders[key] = s;
    root.appendChild(s.row);
  }

  /* ---------------- 拖拽模式 + 归位 ---------------- */
  const modeRow = el("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap;");
  const modeBtn = makeButton(T("relDrag", "Relative drag"), () => {
    state.absolute = !state.absolute;
    modeBtn.textContent = state.absolute ? T("absDrag", "Absolute drag") : T("relDrag", "Relative drag");
    hintEl.textContent = state.absolute ? hintAbsolute() : hintRelative();
    paint();
  });
  modeBtn.title = T("modeTip", "Relative: grabs the world and rotates it without jumps. Absolute: the pointer position is the parameter.");
  modeRow.appendChild(modeBtn);
  modeRow.appendChild(makeButton(T("reset", "Reset (X/Y/Z/R=0)"), () => {
    state.x = 0; state.y = 0; state.z = 0; state.roll = 0;
    commit();
  }));
  root.appendChild(modeRow);

  /* ---------------- 提示词预览 ---------------- */
  const previewLabel = el("div", "font-size:12px;color:rgba(255,255,255,0.55);");
  previewLabel.textContent = T("previewLabel", "Camera prompt");
  root.appendChild(previewLabel);

  const preview = el("textarea", "width:100%;min-height:52px;resize:vertical;font-size:13px;line-height:1.5;background:rgb(0 0 0 / 23%);border:1px solid #333;color:" + PALETTE.orbitAz + ";box-sizing:border-box;border-radius:6px;padding:6px;font-family:monospace;");
  preview.readOnly = true;
  root.appendChild(preview);

  /* ---------------- 按钮行 + 加载配置下拉 ---------------- */
  const bar = el("div", "display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:3px 6px;border:1px solid #00000061;border-radius:6px;background:rgb(0 0 0 / 12%);box-sizing:border-box;width:100%;");
  const presetSelect = el("select", INPUT_CSS + "flex:1 1 96px;min-width:96px;max-width:100%;");
  root.appendChild(bar);


  const ui = {
    w, state, root, canvas, hintEl, azimuthEl, rollEl, sliders,
    modeBtn, preview, bar, presetSelect,
  };

  /* ------------------------------------------------------------ 读数与重绘 */

  function updateReadout() {
    const deg = 180 * state.x;
    let text;
    if (Math.abs(state.x) > 0.85) text = "BEHIND · 180°";
    else if (state.x < -0.05) text = "LEFT " + Math.abs(deg).toFixed(0) + "°";
    else if (state.x > 0.05) text = "RIGHT " + deg.toFixed(0) + "°";
    else text = "FRONT · 0°";
    azimuthEl.textContent = text;
    rollEl.textContent = "ROLL: " + (45 * state.roll).toFixed(0) + "°";
  }

  function paint() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(W * dpr);
    if (canvas.width !== pw) {
      canvas.width = pw;
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 底：半透明黑 + 一点青光晕，让球看着浮在中间
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0000009e";
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, 225, 10, W / 2, 225, 230);
    glow.addColorStop(0, "rgba(77, 208, 225, 0.05)");
    glow.addColorStop(1, "rgba(77, 208, 225, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const pose = cameraPose(state.x, state.y, state.z);

    /* 画两遍轨道，中间夹着主体 —— 前后关系就是这么来的。
     * 相机在球背面时先画它（会被主体挡住），在正面时最后画（盖住主体）。 */
    drawOrbits(ctx, true, pose, state.absolute);
    if (pose.z < 0) drawCamera(ctx, pose, state.roll, state.absolute, state.z);
    drawCenter(ctx);
    drawAxes(ctx);
    drawOrbits(ctx, false, pose, state.absolute);
    drawFieldBalls(ctx, pose);
    if (pose.z >= 0) drawCamera(ctx, pose, state.roll, state.absolute, state.z);

    updateReadout();
    const text = computePrompt(state.x, state.y, state.z, state.roll, state.cfg);
    preview.value = text;
  }

  /** 把面板上的值写回原生 widget，并重画。
   *  只写值，不碰顺序、不碰选项 —— widgets_values 是按索引读写的。 */
  function commit() {
    w.x.value = Number(state.x.toFixed(4));
    w.y.value = Number(state.y.toFixed(4));
    w.z.value = Number(state.z.toFixed(4));
    w.roll.value = Number(state.roll.toFixed(4));
    for (const key of ["x", "y", "z", "roll"]) sliders[key].set(state[key]);
    paint();
    app.graph?.setDirtyCanvas(true, true);
  }

  /* ------------------------------------------------------------ 画布交互 */

  canvas.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    canvas.focus();

    if (event.button === 2) {
      // 右键拖：调远近（BSK 的原始方式）
      const startX = event.clientX;
      const baseZ = state.z;
      const step = clamp(Number(state.cfg.drag_step) || 0.004, 0.0005, 0.02);
      canvas.style.cursor = "ew-resize";
      hintEl.textContent = T("hintDrag", "drag left/right: distance");

      const move = (e) => {
        state.z = clamp(baseZ - (e.clientX - startX) * step, -1, 1);
        paint();
        sliders.z.set(state.z);
      };
      const up = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", up);
        canvas.style.cursor = "crosshair";
        hintEl.textContent = state.absolute ? hintAbsolute() : hintRelative();
        commit();
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", up);
      event.preventDefault();
      return;
    }

    if (event.button !== 0) return;

    const rect = canvas.getBoundingClientRect();
    const anchorX = event.clientX;
    const anchorY = event.clientY;
    const baseX = state.x;
    const baseY = state.y;
    canvas.style.cursor = "none";
    hintEl.textContent = state.absolute
        ? T("hintAbsActive", "absolute mapping: the pointer is the camera direction")
        : T("hintRelActive", "relative drag: grabs the world and rotates it");

    const apply = (e) => {
      if (state.absolute) {
        // 绝对：鼠标在画布里的位置直接就是参数
        const px = ((e.clientX - rect.left) / rect.width) * W;
        const py = ((e.clientY - rect.top) / rect.height) * H;
        state.x = clamp((px - W / 2) / (W / 2), -1, 1);
        state.y = clamp(-((py - H / 2) / (H / 2)), -1, 1);
      } else {
        // 相对：水平方向环形（绕一圈回到原点，不会在 180° 卡住），垂直线性
        let nx = baseX + (e.clientX - anchorX) / (rect.width / 2);
        nx = ((nx + 1) % 2 + 2) % 2 - 1;
        state.x = nx;
        state.y = clamp(baseY - (e.clientY - anchorY) / (rect.height / 2), -1, 1);
      }
      paint();
      sliders.x.set(state.x);
      sliders.y.set(state.y);
    };

    const up = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      canvas.style.cursor = "crosshair";
      hintEl.textContent = state.absolute ? hintAbsolute() : hintRelative();
      commit();
    };
    const move = (e) => apply(e);

    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
    apply(event);
    event.preventDefault();
  });

  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  /* 滚轮：直接调远近（用户要求）；按住 Shift 才是翻滚（BSK 原本的行为）。
   * 两个都留着 —— 滚轮调距离更顺手，Shift 留给倾斜。 */
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    event.stopPropagation();
    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 16;
    else if (event.deltaMode === 2) delta *= 100;

    if (event.shiftKey) {
      state.roll = clamp(state.roll - 0.002 * delta, -1, 1);
    } else {
      const step = clamp(Number(state.cfg.wheel_step) || 0.0003, 0.00005, 0.004);
      state.z = clamp(state.z - delta * step * 3, -1, 1);
    }
    commit();
  }, { passive: false });

  /* 键盘微调。焦点在这个画布上才生效，不影响别处。 */
  canvas.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    let handled = true;
    switch (event.key) {
      case "ArrowLeft": state.x = clamp(state.x - step, -1, 1); break;
      case "ArrowRight": state.x = clamp(state.x + step, -1, 1); break;
      case "ArrowUp": state.y = clamp(state.y + step, -1, 1); break;
      case "ArrowDown": state.y = clamp(state.y - step, -1, 1); break;
      case "[": state.z = clamp(state.z - step, -1, 1); break;
      case "]": state.z = clamp(state.z + step, -1, 1); break;
      case ",": state.roll = clamp(state.roll - step, -1, 1); break;
      case ".": state.roll = clamp(state.roll + step, -1, 1); break;
      default: handled = false;
    }
    if (handled) {
      event.preventDefault();
      commit();
    }
  });

  /* ------------------------------------------------------------ 按钮行 */

  presetSelect.appendChild(new Option(T("loadConfig", "Load config"), "", true, true));
  presetSelect.disabled = false;

  async function refreshPresets(select) {
    try {
      const data = await M8.apiGet("/cam/configs");
      const files = data.files || [];
      presetSelect.innerHTML = "";
      const head = new Option(T("loadConfig", "Load config"), "", true, true);
      head.disabled = true;
      presetSelect.appendChild(head);
      for (const name of files) presetSelect.appendChild(new Option(name, name));
      if (select && files.includes(select)) presetSelect.value = select;
    } catch (exc) {
      M8.warn("读配置列表失败：", exc.code, exc.message);
    }
  }

  bar.appendChild(makeButton(T("save", "Save"), async () => {
    const suggested = "camera_" + Date.now().toString().slice(-6);
    const name = window.prompt(T("promptName", "Config name (stored in m8/data/camera-configs/)"), suggested);
    if (name == null) return;
    const clean = String(name).trim();
    if (!clean) {
      M8.notify(T("nameRequired", "The name cannot be empty"), { kind: "warn" });
      return;
    }
    try {
      await M8.apiPost("/cam/configs/save", { name: clean, config: state.cfg });
      M8.notify(T("configSaved", "Config saved: {name}", { name: clean }), { kind: "ok", timeout: 3200 });
      await refreshPresets(clean);
    } catch (exc) {
      M8.notifyError(exc, T("savingConfig", "saving the camera config"));
    }
  }));

  bar.appendChild(makeButton(T("copy", "Copy"), async () => {
    const text = computePrompt(state.x, state.y, state.z, state.roll, state.cfg);
    if (!text) {
      M8.notify(T("nothingToCopy", "There is no prompt to copy yet"), { kind: "warn" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      M8.notify(T("copied", "Prompt copied"), { kind: "ok", timeout: 2600 });
    } catch (exc) {
      M8.warn("复制失败：", exc);
      M8.notify(T("clipboardBlocked", "The browser blocked the clipboard"),
        { kind: "warn", hint: T("clipboardBlockedHint", "Selecting it manually from the preview above works just as well") });
    }
  }));

  bar.appendChild(makeButton(T("paste", "Paste"), async () => {
    if (!navigator.clipboard?.readText) {
      M8.notify(T("noClipboard", "This environment cannot read the clipboard"), { kind: "warn" });
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      const cfg = JSON.parse(text);
      if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
        M8.notify(T("notAConfig", "The clipboard does not hold a config object"),
        { kind: "warn", hint: T("notAConfigHint", "It should be JSON in the form { ... }") });
        return;
      }
      w.config.value = text;
      state.cfg = loadConfig(text);
      commit();
      M8.notify(T("configFromClipboard", "Config loaded from the clipboard"), { kind: "ok", timeout: 2600 });
    } catch (exc) {
      M8.notify(T("badJsonClipboard", "The clipboard does not hold valid JSON"),
        { kind: "err", hint: String(exc.message || exc) });
    }
  }));

  bar.appendChild(makeButton(T("settings", "Settings"), () => {
    const cfg = JSON.stringify(state.cfg, null, 2);
    const text = window.prompt(T("promptConfig", "Camera config (JSON)"), cfg);
    if (text == null) return;
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        M8.notify(T("topLevelObject", "The config must be an object at the top level"), { kind: "warn" });
        return;
      }
      w.config.value = text;
      state.cfg = loadConfig(text);
      commit();
      M8.notify(T("configApplied", "Config applied"), { kind: "ok", timeout: 2600 });
    } catch (exc) {
      M8.notify(T("badJson", "That is not valid JSON"), { kind: "err", hint: String(exc.message || exc) });
    }
  }));

  bar.appendChild(presetSelect);

  presetSelect.addEventListener("change", async () => {
    const name = presetSelect.value;
    if (!name) return;
    try {
      const data = await M8.apiPost("/cam/configs/load", { name });
      w.config.value = JSON.stringify(data.config);
      state.cfg = loadConfig(w.config.value);
      commit();
      M8.notify(T("configLoaded", "Config loaded: {name}", { name }), { kind: "ok", timeout: 2600 });
    } catch (exc) {
      M8.notifyError(exc, T("loadingConfig", "loading the camera config"));
    }
  });

  /* ------------------------------------------------------------ 折叠区 */

  /* 权重设置：四条轴的总预算 + 死区 + 权重边界。 */
  const foldWeight = makeFold(T("foldWeights", "Weight settings"), false);
  const azRow = makeFieldRow(T("azBudget", "Direction budget"), "", (on, v) => {
    state.cfg.azimuth.enabled = on;
    state.cfg.azimuth.weight = parseFloat(v) || 10;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  azRow.cb.checked = state.cfg.azimuth.enabled !== false;
  azRow.input.value = String(state.cfg.azimuth.weight);
  foldWeight.body.appendChild(azRow.row);

  const dzRow = makeFieldRow(T("azDeadzone", "Direction dead zone"), "", (on, v) => {
    state.cfg.azimuth.deadzone_ratio = parseFloat(v) || 0.2;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  dzRow.input.value = String(state.cfg.azimuth.deadzone_ratio);
  foldWeight.body.appendChild(dzRow.row);

  const wminRow = makeFieldRow(T("weightMin", "Weight floor"), "", (on, v) => {
    state.cfg.weight_min = parseFloat(v) || 0.1;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  wminRow.input.value = String(state.cfg.weight_min);
  foldWeight.body.appendChild(wminRow.row);

  const wmaxRow = makeFieldRow(T("weightMax", "Weight ceiling"), "", (on, v) => {
    state.cfg.weight_max = parseFloat(v) || 10;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  wmaxRow.input.value = String(state.cfg.weight_max);
  foldWeight.body.appendChild(wmaxRow.row);

  const nwRow = makeFieldRow(T("noWeight", "No weighting"), "", (on) => {
    state.cfg.no_weight = on;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  nwRow.cb.checked = !!state.cfg.no_weight;
  nwRow.input.value = String(state.cfg.no_weight_threshold);
  nwRow.input.placeholder = T("minorThreshold", "minor-direction threshold");
  nwRow.input.addEventListener("input", () => {
    state.cfg.no_weight_threshold = parseFloat(nwRow.input.value) || 0.5;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  foldWeight.body.appendChild(nwRow.row);
  root.appendChild(foldWeight.box);

  /* 自定义提示词：五个开关各自的文案。 */
  const foldExtras = makeFold(T("foldCustom", "Custom prompt tags"), false);
  for (const key of ["lens", "dof", "movement", "composition", "style"]) {
    const item = state.cfg.extras[key] || {};
    const row = makeFieldRow(EXTRA_LABELS[key], item.value, (on, v) => {
      state.cfg.extras[key].enabled = on;
      state.cfg.extras[key].value = v;
      w.config.value = JSON.stringify(state.cfg);
      commit();
    });
    row.cb.checked = !!item.enabled;
    if (key === "lens") {
      const listId = "m8-cam-lens-list";
      if (!document.getElementById(listId)) {
        const dl = el("datalist", "");
        dl.id = listId;
        for (const opt of LENS_OPTIONS) dl.appendChild(new Option(opt, opt));
        document.body.appendChild(dl);
      }
      row.input.setAttribute("list", listId);
    }
    foldExtras.body.appendChild(row.row);
  }
  root.appendChild(foldExtras.box);

  /* 相机控制：各档的文案与开关。改词就在这里。 */
  const foldFields = makeFold(T("foldCamera", "Camera control"), false);
  const fieldGroups = [
    ["azimuth", "directions", T("fieldRow.azimuth", "Direction")],
    ["elevation", "categories", T("fieldRow.elevation", "Height")],
    ["distance", "categories", T("fieldRow.distance", "Distance")],
  ];
  for (const [section, table, title] of fieldGroups) {
    const head = el("div", "font-size:12px;color:rgba(255,255,255,0.5);margin-top:2px;");
    head.textContent = title;
    foldFields.body.appendChild(head);
    for (const [key, entry] of Object.entries(state.cfg[section][table])) {
      const row = makeFieldRow(FIELD_LABELS[key] || key, entry.tag, (on, v) => {
        state.cfg[section][table][key].enabled = on;
        state.cfg[section][table][key].tag = v;
        w.config.value = JSON.stringify(state.cfg);
        commit();
      });
      row.cb.checked = entry.enabled !== false;
      foldFields.body.appendChild(row.row);
    }
  }
  const tiltRow = makeFieldRow(T("fieldRow.tilt", "Tilt"), state.cfg.tilt.dutch_tag, (on, v) => {
    state.cfg.tilt.enabled = on;
    state.cfg.tilt.dutch_tag = v;
    w.config.value = JSON.stringify(state.cfg);
    commit();
  });
  tiltRow.cb.checked = state.cfg.tilt.enabled !== false;
  foldFields.body.appendChild(tiltRow.row);
  root.appendChild(foldFields.box);

  /* ------------------------------------------------------------ 挂载 */

  /* ---------------- 让节点跟着面板长 ---------------- */

  /* DOM widget 的高度**不会**自动把节点撑大 —— 不处理的话，面板内容会直接画到
     节点边框外面去（三维视图和展开的折叠区最明显）。
     fitNode 重算一次节点高度；ResizeObserver 盯住面板，内容一变就重算，
     所以拖滑块、展开折叠、改标签都不用单独管。
     合并到一帧里做，免得连续触发时反复 setSize 抖起来。 */
  let fitQueued = false;
  function fitNode() {
    // vue 节点模式下尺寸归前端框架管，插手反而会把它撑坏
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

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => fitNode());
    ro.observe(root);
    // 节点被删掉时把观察器摘掉，不然它会一直盯着一个已经不在的 DOM
    const onRemoved = node.onRemoved;
    node.onRemoved = function () {
      ro.disconnect();
      onRemoved?.apply(this, arguments);
    };
  }

  // 折叠区展开/收起时高度是跳变的，ResizeObserver 有时抓不到，单独再盯一次
  for (const box of [foldWeight.box, foldExtras.box, foldFields.box]) {
    box.addEventListener("toggle", () => fitNode());
  }

  const domWidget = node.addDOMWidget("m8_camera_panel", "div", root, { serialize: false });

  /* 显式告诉 ComfyUI 这块面板有多高。
     各版本对 DOM widget 高度的处理不完全一致，自己给一个最稳 ——
     算矮了内容就会画出节点边框，而那是一眼看得见的问题。 */
  domWidget.computeSize = () => [root.clientWidth || 0, Math.ceil(root.scrollHeight) || 0];

  /* 载入工作流会整块重建 widget，尺寸得跟着重算一遍 */
  const origConfigure = node.configure;
  node.configure = function () {
    const result = origConfigure?.apply(this, arguments);
    requestAnimationFrame(fitNode);
    return result;
  };

  // 首次挂载后立刻适配一次。等一帧是因为此刻 DOM 还没量到真实尺寸。
  requestAnimationFrame(fitNode);

  /* 原生 widget 被别的途径改过（载入工作流、后端回填）时，面板跟着走 */
  for (const key of ["x", "y", "z", "roll"]) {
    M8.onWidgetChange(node, "pos_" + key, () => {
      const v = Number(ui.w[key].value);
      if (!Number.isFinite(v) || Math.abs(v - state[key]) < 1e-9) return;
      state[key] = v;
      sliders[key].set(v);
      paint();
    });
  }
  M8.onWidgetChange(node, "config", () => {
    state.cfg = loadConfig(w.config.value);
    paint();
  });

  /* 面板挂成功了才藏原生 widget ——
   * 顺序反过来做的话，面板一旦没挂上，节点就成了个点不动的方块。 */
  for (const widget of Object.values(w)) M8.hideWidget(widget);

  refreshPresets();
  paint();
  M8.log("相机控制面板已挂载");
}

app.registerExtension({
  name: "M8.CameraControl",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        // 面板没挂上也要让节点能用 —— 原生那几个 widget 还在，只是没藏起来
        M8.error("相机控制面板挂载失败：", exc);
      }
    };
  },
});
