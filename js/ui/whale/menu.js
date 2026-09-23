/* ============================================================================
 * M8 小鲸鱼 · 快捷调整菜单
 *
 * 鼠标滑到鲸鱼身上时，它右边会出现一个汉堡按钮；点开就是这个菜单。
 * 样式和值域全部取自原版（MeteorNOX/DeepSeek-Balance-Whale-Widget）：
 * 大小是 1–20 的刻度（不是倍率）、音量默认 90%、避让滚动条默认关着且宽度框置灰。
 *
 * 为什么不直接复用侧边栏那个设置面板：两者的定位不同。
 * 面板是"坐下来慢慢调"，字段全、有说明文字；这个菜单是"顺手拧一下"，
 * 只放最常动的几项，一行一个，不解释。所以它们各写各的，但读写的是同一份设置 ——
 * 每次打开菜单都按当前值重建控件，这样两边怎么改都不会打架。
 * ==========================================================================*/

import * as M8 from "../../m8_core.js";

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui.M8Whale 段提供。 */
const T = M8.tFor("M8Whale");

const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;
const SCALE_STEPS = 20;   // 数字框的刻度：1 对应最小，20 对应最大

/** 刻度（1-20）换算成倍率。原版的公式，一个数都没改。 */
export function stepToScale(step) {
  const clamped = Math.max(1, Math.min(SCALE_STEPS, Math.round(Number(step) || 1)));
  return MIN_SCALE + (clamped - 1) * (MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1);
}

/** 倍率换算回刻度。 */
export function scaleToStep(scale) {
  const value = Number(scale) || 1;
  const step = Math.round((value - MIN_SCALE) * (SCALE_STEPS - 1) / (MAX_SCALE - MIN_SCALE)) + 1;
  return Math.max(1, Math.min(SCALE_STEPS, step));
}

/** 峰谷提示有几种说法，这里只列合法的取值。 */
export const PEAK_MODES = ["default", "liangwen", "qiangqiang"];

/**
 * 峰谷提示的三种说法（原版文案）。
 *
 * 每次调用现取，不在模块顶层求值 —— 界面文案是异步拉回来的，顶层求值只会
 * 永远拿到代码里的英文原文，中文环境就换不过去。
 */
export function peakLabels(mode) {
  const all = {
    default: {
      on: T("peakDefaultOn", "Peak hours"),
      off: T("peakDefaultOff", "Off-peak"),
    },
    liangwen: {
      on: T("peakLiangwenOn", "Liang Wenfeng"),
      off: T("peakLiangwenOff", "Liang Wengu"),
    },
    qiangqiang: {
      on: T("peakQiangqiangOn", "!?Fengfeng?!"),
      off: T("peakQiangqiangOff", "!?Gugu?!"),
    },
  };
  return all[mode] || all.default;
}

/* ---------------------------------------------------------------- 小工具 */

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

function row(...children) {
  const box = document.createElement("div");
  box.className = "m8-whale-menu-row";
  for (const child of children) {
    box.appendChild(typeof child === "string" ? el("span", { textContent: child }) : child);
  }
  return box;
}

export class WhaleMenu {
  constructor(ctx) {
    this.ctx = ctx;
    this.open = false;

    this.el = document.createElement("div");
    this.el.className = "m8-whale-menu";
    document.body.appendChild(this.el);

    // 点菜单外面就收起来。用 pointerdown 的捕获阶段，
    // 这样点画布、点节点都算"外面"，不会漏。
    document.addEventListener("pointerdown", (event) => {
      if (!this.open) return;
      if (event.target?.closest?.(".m8-whale-menu") || event.target?.closest?.(".m8-whale-menu-btn")) return;
      this.hide();
    }, true);
  }

  get settings() {
    return this.ctx.settings || {};
  }

  /** 改完就存。存不上只记日志 —— 不该因为设置没落盘把菜单卡住。 */
  save(patch) {
    this.ctx.save(patch).catch((exc) => M8.warn("设置没存上：", exc.message));
  }

  /** 每次打开都重建：值可能刚在侧边栏里被改过。 */
  render() {
    const s = this.settings;
    this.el.innerHTML = "";

    /* ---- 大小：滑块管倍率，数字框管刻度，两者联动 ---- */
    const scale = el("input", {
      type: "range",
      className: "m8-whale-range",
      min: String(MIN_SCALE), max: String(MAX_SCALE), step: "0.1",
      value: String(s.scale ?? 1.5),
    });
    const scaleNumber = el("input", {
      type: "number",
      className: "m8-whale-number",
      min: "1", max: String(SCALE_STEPS), step: "1",
      value: String(scaleToStep(s.scale ?? 1.5)),
    });

    const applyScale = (value) => {
      this.ctx.widget?.reflowWith({ scale: value });
      scale.value = String(value);
      scaleNumber.value = String(scaleToStep(value));
    };

    // 拖动全程关掉根元素的过渡。
    // 不关的话：CSS 过渡是在 JS 执行块之后才求值的，挂件会以**错误的位置为中心**
    // 缩放 —— 表现是滑块一拖，鲸鱼在原地乱抖。原版把这条写进了踩坑记录。
    const freezeTransition = () => { this.ctx.widget?.freeze(true); };
    const thawTransition = () => { this.ctx.widget?.freeze(false); };

    scale.addEventListener("pointerdown", freezeTransition);
    scale.addEventListener("input", () => {
      this.settings.scale = Number(scale.value);
      scaleNumber.value = String(scaleToStep(scale.value));
      this.ctx.widget?.reflowWith({ scale: Number(scale.value) });
    });
    scale.addEventListener("change", () => {
      thawTransition();
      this.save({ scale: Number(scale.value) });
    });

    scaleNumber.addEventListener("focus", freezeTransition);
    scaleNumber.addEventListener("blur", thawTransition);

    scaleNumber.addEventListener("input", () => {
      const value = stepToScale(scaleNumber.value);
      scale.value = String(value);
      this.settings.scale = value;
      this.ctx.widget?.reflowWith({ scale: value });
    });
    scaleNumber.addEventListener("change", () => {
      const value = stepToScale(scaleNumber.value);
      // 填了个越界的数就把框里显示的值拉回来，否则它会一直显示那个越界数
      scaleNumber.value = String(scaleToStep(value));
      this.save({ scale: value });
    });

    this.el.appendChild(row(T("size", "Size"), scale, scaleNumber));

    /* ---- 音效 ---- */
    const soundSelect = el("select", { className: "m8-whale-select" });
    soundSelect.appendChild(el("option", { value: "duck", textContent: T("soundDuck", "Duck") }));
    soundSelect.appendChild(el("option", { value: "fx1", textContent: T("soundFx1", "Effect 1") }));
    soundSelect.value = s.soundSet === "fx1" ? "fx1" : "duck";
    soundSelect.addEventListener("change", () => {
      this.settings.soundSet = soundSelect.value;
      this.save({ soundSet: soundSelect.value });
      this.ctx.widget?.playSound("press");
    });
    this.el.appendChild(row(T("sound", "Sound"), soundSelect));

    /* ---- 音量 ---- */
    const volume = el("input", {
      type: "range", className: "m8-whale-range",
      min: "0", max: "1", step: "0.05",
      value: String(s.volume ?? 0.9),
    });
    const volPct = el("span", { className: "m8-whale-volpct", textContent: `${Math.round((s.volume ?? 0.9) * 100)}%` });
    volume.addEventListener("input", () => {
      volPct.textContent = `${Math.round(Number(volume.value) * 100)}%`;
      this.settings.volume = Number(volume.value);
    });
    volume.addEventListener("change", () => this.save({ volume: Number(volume.value) }));
    this.el.appendChild(row(T("volume", "Volume"), volume, volPct));

    /* ---- 用量 ---- */
    const usageSelect = el("select", { className: "m8-whale-select" });
    usageSelect.appendChild(el("option", { value: "ledger", textContent: T("usageLedger", "Little Whale ledger (recommended)") }));
    const tokenOpt = el("option", { value: "token", textContent: T("usageToken", "Live tokens (not supported by this plugin)") });
    tokenOpt.disabled = true;
    usageSelect.appendChild(tokenOpt);
    usageSelect.value = "ledger";
    usageSelect.title = T("usageTokenTip", "The original's \"live tokens\" mode needs a platform session token, not an API key. Accounting is the only option here.");
    this.el.appendChild(row(T("usage", "Usage"), usageSelect));

    /* ---- 峰谷：只改说法，不改判断 ---- */
    const peakSelect = el("select", { className: "m8-whale-select" });
    for (const [value, label] of [
      ["default", T("peakDefault", "Default")],
      ["liangwen", T("peakLiangwen", "Liang Wenfeng valley")],
      ["qiangqiang", T("peakQiangqiang", "!?Qiangqiang?!")],
    ]) {
      peakSelect.appendChild(el("option", { value, textContent: label }));
    }
    peakSelect.value = PEAK_MODES.includes(s.peakMode) ? s.peakMode : "default";
    peakSelect.addEventListener("change", () => {
      this.settings.peakMode = peakSelect.value;
      this.save({ peakMode: peakSelect.value });
      // 立刻按新说法重描一次气泡上的那行
      this.ctx.widget?.refreshPeakLine?.();
    });
    this.el.appendChild(row(T("peak", "Peak / off-peak"), peakSelect));

    /* ---- 气泡 ---- */
    const bubble = el("input", { type: "checkbox", className: "m8-whale-check", checked: s.bubble !== false });
    bubble.title = T("bubbleTip", "Turn the thinking bubble on or off");
    bubble.addEventListener("change", () => {
      this.settings.bubble = bubble.checked;
      this.save({ bubble: bubble.checked });
      if (!bubble.checked) this.ctx.widget?.hideBubble();
    });
    this.el.appendChild(row(T("bubble", "Bubble"), bubble));

    /* ---- 每轮消耗提示 ---- */
    const turnCost = el("input", { type: "checkbox", className: "m8-whale-check", checked: s.turnCost !== false });
    const turnCostSecs = el("input", {
      type: "number", className: "m8-whale-number",
      min: "0", step: "1",
      value: String(Math.round((s.turnCostCloseMs ?? 5000) / 1000)),
      disabled: s.turnCost === false,
    });
    turnCostSecs.title = T("turnCostSecsTip", "Set 0 to stop auto-closing; click the bubble to dismiss it");
    const pushTurnCost = () => {
      const seconds = Math.max(0, Math.round(Number(turnCostSecs.value) || 0));
      this.settings.turnCostCloseMs = seconds * 1000;
      this.save({ turnCostCloseMs: seconds * 1000 });
    };
    turnCostSecs.addEventListener("change", pushTurnCost);
    turnCost.addEventListener("change", () => {
      this.settings.turnCost = turnCost.checked;
      turnCostSecs.disabled = !turnCost.checked;
      this.save({ turnCost: turnCost.checked });
    });
    this.el.appendChild(row(
      T("turnCost", "Per-turn cost"),
      turnCost,
      T("autoClose", "auto-close"),
      turnCostSecs,
      T("seconds", "s"),
    ));

    /* ---- 分隔线 ---- */
    this.el.appendChild(el("div", { className: "m8-whale-menu-sep" }));

    /* ---- 避让滚动条：勾了才能填宽度 ---- */
    const avoid = el("input", { type: "checkbox", className: "m8-whale-check", checked: s.avoidScrollbar === true });
    const avoidPx = el("input", {
      type: "number", className: "m8-whale-number",
      min: "0", step: "1",
      value: String(s.scrollbarWidth ?? 17),
      disabled: s.avoidScrollbar !== true,
    });
    const pushAvoid = () => {
      const width = Math.max(0, Math.round(Number(avoidPx.value) || 0));
      this.settings.avoidScrollbar = avoid.checked;
      this.settings.scrollbarWidth = width;
      this.save({ avoidScrollbar: avoid.checked, scrollbarWidth: width });
      this.ctx.widget?.reflowWith({});
    };
    avoidPx.addEventListener("change", pushAvoid);
    avoid.addEventListener("change", () => {
      avoidPx.disabled = !avoid.checked;
      pushAvoid();
    });
    this.el.appendChild(row(
      T("avoidScrollbar", "Avoid scrollbar"),
      avoid,
      T("width", "width"),
      avoidPx,
      "px",
    ));
  }

  show(anchorRect, buttonRect) {
    this.render();
    this.el.classList.add("-open");
    this.open = true;
    this.position(anchorRect, buttonRect);
  }

  hide() {
    this.el.classList.remove("-open");
    this.open = false;
  }

  toggle(anchorRect, buttonRect) {
    if (this.open) this.hide();
    else this.show(anchorRect, buttonRect);
  }

  /**
   * 菜单出现在按钮**上方**，贴着鲸鱼在这一侧的边。
   *
   * 鲸鱼在屏幕右半边时右对齐、在左半边时左对齐 —— 否则菜单会被推出屏幕。
   * transform-origin 跟着换，展开动画才是从贴着按钮的那个角长出来的。
   */
  position(anchorRect, buttonRect) {
    const viewportWidth = window.innerWidth;
    // 先量一次高度：还没显示时 offsetHeight 是 0，得先让它有布局
    this.el.style.visibility = "hidden";
    this.el.style.left = "0px";
    this.el.style.top = "0px";
    const height = this.el.offsetHeight || 220;
    this.el.style.visibility = "";

    const onLeft = anchorRect.left + anchorRect.width / 2 < viewportWidth / 2;
    if (onLeft) {
      this.el.style.left = `${buttonRect.left}px`;
      this.el.style.right = "auto";
      this.el.style.transformOrigin = "bottom left";
    } else {
      this.el.style.right = `${viewportWidth - buttonRect.right}px`;
      this.el.style.left = "auto";
      this.el.style.transformOrigin = "bottom right";
    }

    let top = buttonRect.top - height - 6;
    if (top < 8) top = buttonRect.bottom + 6;   // 上方放不下就翻到下面
    this.el.style.top = `${top}px`;
  }
}
