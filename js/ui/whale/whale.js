/* ============================================================================
 * M8 小鲸鱼 · 挂件与入口
 *
 * 移植自 MeteorNOX/DeepSeek-Balance-Whale-Widget（MIT）。
 * 原版是 DSH Web 界面的右下角常驻挂件，这里改成 ComfyUI 的形态：
 *
 *     侧边栏「小鲸鱼」   设置面板：启用、密钥、模型、系统提示词、思考强度、
 *                        大小、音效、气泡、避让滚动条、用量、每轮消耗
 *     悬浮挂件          拖拽移动；左键刷新余额；右键呼出对话窗口；可缩放、有音效
 *     对话窗口          非模态、可拖拽、可缩放，能 / 引用 skill、能带图、能操作画布
 *
 * 原版有而这里**没搬**的：随机台词、四边吸附、左键吸附时的整体镜像翻转、rua.gif。
 * 要哪个再单独加。
 *
 * 事件隔离：挂件是浮在 canvas 上面的 DOM，指针事件必须拦住 ——
 * 不拦的话拖挂件会连带拖动画布、右键会弹出 ComfyUI 的节点菜单。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";
import { WhaleDialog } from "./dialog.js";
import { buildSettingsPanel } from "./settings.js";
import { WhaleMenu, peakLabels } from "./menu.js";
import { buildStatusLines, gifFallback, pickGroup, styleClass } from "./quips.js";

export const API_BASE = "/whale";
const SIDEBAR_ID = "m8-whale";
const WHALE_WIDTH = 116;
// 判定「点击」还是「拖拽」：位移的平方小于 9（直线距离 3px）算点击。
// 存平方是为了省掉每次 pointermove 都开一次根号 —— 那个回调触发得很密。
const DRAG_THRESHOLD_SQ = 9;
const BUBBLE_MS = 5200;

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui.M8Whale 段提供。 */
const T = M8.tFor("M8Whale");

// 缩放范围照搬原版：太小了看不清余额，太大了挡画布
const MIN_SCALE = 0.6;
const MAX_SCALE = 2.5;

// 两套音效，各两个文件（按下 / 松开）。名字是复制资产时改的，
// 保留原始文件名的可读性，也方便以后换成人声。
const SOUND_SETS = {
  duck: { press: "duck-press.mp3", release: "duck-release.mp3" },
  fx1: { press: "fx1-press.mp3", release: "fx1-release.mp3" },
};

/**
 * 气泡的形状。**这段是原版（MeteorNOX/DeepSeek-Balance-Whale-Widget）的原始数据，
 * 一个坐标都没改** —— 椭圆的横竖半径、尾巴那段的控制点、两个圆点的位置和大小，
 * 都是从它的 lib/index.js 里抄出来的。
 *
 * 坐标系是 1026 x 700：椭圆横半径 373、纵半径 232，尾巴是从椭圆下缘伸出去的
 * 一段弧（A 57 32 10 0 0 413 484），下面再跟两个递减的圆点。
 * 这种形状用 CSS 画不出来，只能走 SVG。
 *
 * 填色和描边走 CSS 变量（.m8-whale-shape 那几条规则），所以这里不写 fill/stroke。
 */
const BUBBLE_SVG = [
  '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">',
  '<path class="m8-whale-shape" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>',
  '<ellipse class="m8-whale-dot1" cx="352" cy="561" rx="37.5" ry="26"/>',
  '<ellipse class="m8-whale-dot2" cx="442" cy="646" rx="24.5" ry="18"/>',
  "</svg>",
].join("");

export function assetUrl(name) {
  return new URL(`./assets/${name}`, import.meta.url).href;
}

let cssInjected = false;

function injectCss() {
  if (cssInjected) return;
  cssInjected = true;
  try {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = new URL("./whale.css", import.meta.url).href;
    document.head.appendChild(link);
  } catch (exc) {
    M8.warn("小鲸鱼的样式没挂上：", exc);
  }
}

/* ---------------------------------------------------------------- 上下文 */

export const ctx = {
  state: null,
  settings: {},
  widget: null,
  dialog: null,

  get enabled() {
    return this.settings.enabled !== false;
  },

  /** 一个请求拿完启动要的一切（有没有密钥、设置）。 */
  async loadState() {
    const data = await M8.apiGet(`${API_BASE}/state`);
    this.state = data;
    this.settings = data.settings || {};
    return data;
  },

  /** 存设置。合并式：只传改动的那几项。 */
  async save(patch) {
    const data = await M8.apiPost(`${API_BASE}/settings`, patch);
    this.settings = data.settings || {};
    return this.settings;
  },

  /** 启用状态变了之后，挂件的去留。侧边栏永远留着 —— 不然关了就再也开不回来。 */
  applyEnabled() {
    if (!this.widget) return;
    if (this.enabled) this.widget.mount();
    else this.widget.unmount();
  },
};

/* ---------------------------------------------------------------- 挂件 */

class WhaleWidget {
  constructor() {
    this.mounted = false;
    this.timer = null;
    this.bubbleTimer = null;
    this.dragging = false;
    this.moved = false;
    this.x = 0;
    this.y = 0;
    this.sounds = new Map();     // 音频对象缓存，见 soundFor
    this.soundWarned = false;    // 播放失败的警告只打一次
    // 吸附状态：横纵两轴独立，所以角落能组合（left+top、right+bottom…）
    this.h = "";                 // "" | "left" | "right"
    this.v = "";                 // "" | "top" | "bottom"
    // 气泡的两个状态：是不是显示着、是不是已经切到台词了。
    // 必须在构造时就初始化 —— 读一个 undefined 不会报错，只会让判断静默为假，
    // 「点气泡切台词」就永远不触发，而且查不出原因。
    this.bubbleShown = false;
    this.quipActive = false;
    this.gifEl = null;
    this.gifFailed = false;

    this.el = document.createElement("div");
    this.el.className = "m8-whale";
    this.el.title = T("widgetTitle", "Left click: refresh balance - right click: open chat - drag to move");

    // body 层：按压的 Q 弹做在它身上。
    // 单开一层是必须的 —— root 要留着做左吸附的镜像翻转（scaleX(-1)），
    // 两个 transform 挤在同一个元素上时后者会把前者整个覆盖掉。
    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "m8-whale-body";

    const img = document.createElement("img");
    img.className = "m8-whale-img";
    img.src = assetUrl("whale.png");
    img.alt = T("widgetAlt", "Little Whale");
    img.draggable = false;
    this.bodyEl.appendChild(img);

    this.bubbleEl = document.createElement("div");
    this.bubbleEl.className = "m8-whale-bubble";
    // 首次点气泡切台词，再点关掉。原版的彩蛋就是这个节奏。
    this.bubbleEl.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!this.bubbleShown) return;
      if (!this.quipActive) {
        this.quipActive = true;
        this.showQuip();
      } else {
        this.hideBubble();
      }
    });
    this.bodyEl.appendChild(this.bubbleEl);

    this.el.appendChild(this.bodyEl);

    this.buildMenuButton();
    // 菜单挂在 body 上，不依赖挂件是否已 mount —— 构造时就建好，
    // 这样 unmount/mount 来回切也不会漏掉监听
    this.menu = new WhaleMenu(ctx);

    this.bind();
    // 这一行漏过一次：方法写好了没调，于是 pointermove 没人监听，
    // 按钮永远不出现。测试也只查了方法里用到的字符串，查不出「没被调用」。
    this.bindHover();
    this.applyScale();
  }

  /* ------------------------------------------------------------ 汉堡按钮 */

  buildMenuButton() {
    this.menuBtn = document.createElement("button");
    this.menuBtn.type = "button";
    this.menuBtn.className = "m8-whale-menu-btn";
    this.menuBtn.title = T("menuTip", "Menu");
    // 三条横线用三个 span 画，原版就是这么干的 —— 不用图标字体、不用图
    this.menuBtn.innerHTML = "<span></span><span></span><span></span>";

    // 挂件的 pointerdown 里有 preventDefault()，那会**吃掉后续的 click** ——
    // 按钮的 click 永远收不到，表现就是"点不开"。
    // 所以按钮必须在那之前把 pointerdown 截住，不让它冒泡到挂件。
    this.menuBtn.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
    });
    this.menuBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      this.toggleMenu();
    });
    this.el.appendChild(this.menuBtn);
  }

  /**
   * 鼠标滑到鲸鱼身上，按钮才出现。
   *
   * 原版用的是精确到轮廓的判定：把图片画进一张隐藏的 610×610 canvas，
   * 取那个像素的 alpha，大于 10 才算命中。这里用的是矩形 ——
   * 挂件本身就小，矩形和轮廓的差别不过几个像素，不值得为它多背一个 canvas。
   * 哪天觉得手感不对（比如透明边角处也触发），再照原版那套改。
   */
  isWhaleHit(event) {
    const rect = this.el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
  }

  bindHover() {
    document.addEventListener("pointermove", (event) => {
      // 菜单开着就让它一直显示 —— 鼠标移向菜单的路上不该闪一下
      if (this.menu?.open) return;
      this.menuBtn.classList.toggle("-visible", this.isWhaleHit(event));
    }, true);
  }

  toggleMenu() {
    if (!this.menu) return;
    const anchor = this.el.getBoundingClientRect();
    const button = this.menuBtn.getBoundingClientRect();
    this.menu.toggle(anchor, button);
  }

  /* ------------------------------------------------------------ 外观 */

  /** 缩放。CSS 变量挂在元素自己身上，不动全局。 */
  /**
   * 缩放。
   *
   * 不自己算宽度 —— 原版把尺寸整个交给了一条 CSS 公式：
   *
   *     --m8-whale-base: clamp(122px, min(250px, min(100vw,100vh)*0.28) * scale, 625px)
   *
   * 它同时管住了三件事：跟着视口缩（小窗口不溢出）、有上下限（太小看不清、
   * 太大挡画布）、乘用户设的倍率。JS 只把倍率写进去就行，其余交给 CSS。
   *
   * 气泡里所有字号都从 --m8-whale-u 推出来（base/1026），所以改一个变量，
   * 图形和文字等比一起变 —— 不需要分别调。
   */
  applyScale() {
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(ctx.settings?.scale) || 1));
    this.scale = scale;
    this.el.style.setProperty("--m8-whale-scale", String(scale));
  }

  /**
   * 拼一个思考气泡的内容：形状 + 三行文字。
   *
   * 文字压在椭圆的圆心（原版算好的 44.25% / 38%，见 CSS）。
   * 金额来自接口，过一遍转义 —— 它是拼进 innerHTML 的，
   * 虽然数据可信，但边界上的转义是习惯不是负担。
   */
  renderBubble({ label = T("balanceLabel", "DeepSeek balance"), symbol = "¥", amount = "—", hint = "", hintHtml = "" } = {}) {
    const esc = M8.escapeHtml;
    // hintHtml 是调用方自己拼好并转义过的（比如里面要带一个着色 span），
    // hint 是纯文本、由这里转义。两个都给，用哪个由调用方决定。
    const hintLine = hintHtml
      ? `<div class="m8-whale-bubble-hint">${hintHtml}</div>`
      : (hint ? `<div class="m8-whale-bubble-hint">${esc(hint)}</div>` : "");

    return [
      BUBBLE_SVG,
      '<div class="m8-whale-bubble-text">',
      `<div class="m8-whale-bubble-label">${esc(label)}</div>`,
      `<div class="m8-whale-bubble-amount"><span class="cur">${esc(symbol)}</span>${esc(amount)}</div>`,
      hintLine,
      "</div>",
    ].join("");
  }

  /* ------------------------------------------------------------ 音效 */

  /**
   * 取一个缓存好的 Audio 对象。
   *
   * **不能每次 new**：新建的对象要从头加载，而加载期间那一次用户手势已经过期，
   * 浏览器的自动播放策略就会拒绝这次 play()。表现是"时有时无"，
   * 而且第一次点往往没声、第二次才有。预加载一次、之后只重置 currentTime，
   * 声音才跟得上手指。
   */
  soundFor(file) {
    if (!this.sounds.has(file)) {
      const audio = new Audio(assetUrl(`sound/${file}`));
      audio.preload = "auto";
      try {
        audio.load();
      } catch {
        /* 预加载失败不影响后面 play() 时再试一次 */
      }
      this.sounds.set(file, audio);
    }
    return this.sounds.get(file);
  }

  preloadSounds() {
    for (const set of Object.values(SOUND_SETS)) {
      for (const file of Object.values(set)) this.soundFor(file);
    }
  }

  /** 播一次按压或松开的音效。 */
  playSound(kind) {
    const enabled = ctx.settings?.sound !== false;
    const volume = Number(ctx.settings?.volume ?? 0.9);
    if (!enabled || volume <= 0) return;

    const set = SOUND_SETS[ctx.settings?.soundSet] || SOUND_SETS.duck;
    const file = set[kind];
    if (!file) return;

    const audio = this.soundFor(file);
    audio.volume = Math.min(1, Math.max(0, volume));
    try {
      // 连点的时候从头播，否则第二次那下是哑的
      audio.currentTime = 0;
    } catch {
      /* 还没加载完，忽略 */
    }

    audio.play().catch((exc) => {
      // **只警告一次**。自动播放策略在没有用户手势时会拒绝，那是常态，
      // 每次都喊会把真正的问题淹掉 —— 但也绝不能像之前那样一声不吭：
      // 那样出了问题连"有没有试过播"都不知道。
      if (this.soundWarned) return;
      this.soundWarned = true;
      M8.warn(
        "音效播不出来：", exc?.name || exc?.message || exc,
        "—— 常见原因是浏览器拦了自动播放，或者音频文件没加载到（检查 js/ui/whale/assets/sound/ 在不在）",
      );
    });
  }

  bind() {
    this.el.addEventListener("pointerdown", (event) => {
      // 右键留给 contextmenu，不参与拖拽
      if (event.button !== 0) return;
      // 点在汉堡按钮上时不进入拖拽。上面那个 stopPropagation 已经拦了一道，
      // 这里是第二道 —— 万一哪天有人改了按钮的实现，别让"点按钮"又变成"拖挂件"。
      if (event.target?.closest?.(".m8-whale-menu-btn")) return;
      event.stopPropagation();
      event.preventDefault();

      this.dragging = true;
      this.moved = false;
      this.grabX = event.clientX - this.x;
      this.grabY = event.clientY - this.y;
      this.startX = this.x;   // 记起点，松手时按位移平方判是不是拖拽
      this.startY = this.y;
      this.el.classList.add("-dragging", "-press");
      this.playSound("press");
      this.el.setPointerCapture(event.pointerId);
    });

    this.el.addEventListener("pointermove", (event) => {
      if (!this.dragging) return;
      event.stopPropagation();
      const nx = event.clientX - this.grabX;
      const ny = event.clientY - this.grabY;

      // 位移的**平方**和阈值比：原版用的是 dx²+dy² < 9，也就是直线距离 3px。
      // 用平方是为了省掉每次 move 都开一次根号 —— 这个回调触发得很密。
      const dx = nx - this.startX;
      const dy = ny - this.startY;
      if (dx * dx + dy * dy > DRAG_THRESHOLD_SQ) {
        this.moved = true;
      }
      this.place(nx, ny);
    });

    this.el.addEventListener("pointerup", (event) => {
      if (!this.dragging) return;
      event.stopPropagation();
      this.dragging = false;
      this.el.classList.remove("-dragging", "-press");
      this.playSound("release");
      try { this.el.releasePointerCapture(event.pointerId); } catch { /* 已经释放了 */ }

      if (this.moved) {
        // 松手后先判定吸附 —— 去掉 -dragging 的同时 transition 恢复，
        // 挂件就会带着 0.3s 的动画滑向那条边
        this.settle();
      } else {
        this.refresh();
      }
    });

    this.el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      ctx.dialog?.toggle();
    });

    // 挂件上的滚轮不该滚动画布
    this.el.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  }

  /** 菜单改完设置后重新贴合：缩放换了尺寸，位置得跟着重算。 */
  reflowWith() {
    this.reflow();
  }

  /**
   * 临时关掉根元素的过渡。
   *
   * 拖滑块时用：CSS 过渡是在 JS 执行块之后才求值，不关的话挂件会以错误的位置
   * 为中心缩放，看着像在原地抖。松开就 thaw 回来，吸附滑动还需要它。
   */
  freeze(on) {
    this.el.style.transition = on ? "none" : "";
  }

  /** 峰谷说法换了，用上一次的数据重画那行 —— 不必再查一遍接口。 */
  refreshPeakLine() {
    if (this.lastBalance) this.renderBalanceBubble(this.lastBalance);
  }

  mount() {
    if (this.mounted) return;
    document.body.appendChild(this.el);
    this.mounted = true;
    this.preloadSounds();   // 先把音效加载好，第一下按下去才有声
    this.place(...this.restorePosition());
    this.startTimer();
    this.refresh({ quiet: true });
  }

  unmount() {
    if (!this.mounted) return;
    this.menu?.hide();
    this.el.remove();
    this.mounted = false;
    this.stopTimer();
    this.hideBubble();
  }

  /** 位置：设置里有就用设置里的（连同吸附状态），否则贴右下角。 */
  restorePosition() {
    const saved = ctx.settings?.position;
    if (saved) {
      // 吸附状态要一起恢复：否则重启后挂件虽然回到原位，
      // 但贴左缘的那只不会翻转，看着像是"镜像丢了"
      this.h = saved.h === "left" || saved.h === "right" ? saved.h : "";
      this.v = saved.v === "top" || saved.v === "bottom" ? saved.v : "";
      this.el.classList.toggle("-left", this.h === "left");
      if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        return [saved.x, saved.y];
      }
    }
    const gap = this.scrollbarGap();
    const size = this.el.offsetWidth || WHALE_WIDTH;
    this.h = "right";
    this.v = "bottom";
    return [window.innerWidth - size - gap, window.innerHeight - size];
  }

  /**
   * 贴着右边留出的空隙。
   *
   * 页面有竖滚动条时，把挂件摆在最右边会被滚动条压住一截 ——
   * 这也是原版「避让滚动条」那个开关的用途：开了之后按配置的宽度留白。
   * 宽度可以手填，因为不同浏览器、不同缩放下的滚动条宽度不一样。
   */
  scrollbarGap() {
    if (ctx.settings?.avoidScrollbar === false) return 0;
    const configured = Number(ctx.settings?.scrollbarWidth);
    return Number.isFinite(configured) && configured > 0 ? configured : 17;
  }

  place(x, y) {
    const gap = this.scrollbarGap();
    const width = this.el.offsetWidth || WHALE_WIDTH;
    const height = this.el.offsetHeight || WHALE_WIDTH;
    const maxX = Math.max(0, window.innerWidth - width - gap - 4);
    const maxY = Math.max(0, window.innerHeight - height - 4);
    this.x = Math.min(Math.max(0, x), maxX);
    this.y = Math.min(Math.max(0, y), maxY);
    this.el.style.left = `${this.x}px`;
    this.el.style.top = `${this.y}px`;
  }

  /* ------------------------------------------------------------ 吸附 */

  /**
   * 松手后判定贴到哪条边。
   *
   * 横纵两轴**各自独立**看过没过四分之一线 —— 所以四个角是自然组合出来的
   * （left+top、right+bottom…），不用单独写角落分支。
   *
   * 只有当中心点进了边缘那 1/4 区才吸附；落在中间区就停在释放点。
   * 原版就是这个规则：想放中间也能放，不会被硬拽到边上。
   */
  settle() {
    const rect = this.el.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    this.h = centerX < vw / 4 ? "left" : (centerX > vw * 3 / 4 ? "right" : "");
    this.v = centerY < vh / 4 ? "top" : (centerY > vh * 3 / 4 ? "bottom" : "");

    // 贴左缘时整幅镜像：鲸鱼转身朝右，像是靠在屏幕左边
    this.el.classList.toggle("-left", this.h === "left");

    this.applyAnchor();
    this.savePosition();
  }

  /**
   * 按锚点把挂件摆到该在的位置。
   *
   * 吸附过的轴重新贴边，没吸附的轴保持原位（只做视口钳制）。
   * 窗口 resize、改缩放、改避让宽度时都要重算一遍。
   */
  applyAnchor() {
    const size = this.el.offsetWidth || WHALE_WIDTH;
    const gap = this.scrollbarGap();
    let x = this.x;
    let y = this.y;

    if (this.h === "left") x = 0;
    else if (this.h === "right") x = window.innerWidth - size - gap;

    if (this.v === "top") y = 0;
    else if (this.v === "bottom") y = window.innerHeight - size;

    this.place(x, y);
  }

  /** 设置改了之后重新贴合一遍。缩放换了尺寸，位置得跟着重算。 */
  reflow() {
    this.applyScale();
    requestAnimationFrame(() => this.applyAnchor());
  }

  savePosition() {
    ctx.save({
      position: {
        x: Math.round(this.x),
        y: Math.round(this.y),
        h: this.h,      // 吸附状态一起存，否则重启后要重新拖一次才知道贴哪边
        v: this.v,
      },
    }).catch((exc) => {
      M8.warn("小鲸鱼位置没存上：", exc.message);
    });
  }

  startTimer() {
    this.stopTimer();
    const seconds = Number(ctx.settings?.refreshSeconds) || 60;
    if (seconds <= 0) return;
    this.timer = setInterval(() => this.refresh({ quiet: true }), seconds * 1000);
  }

  stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 查一次余额。quiet=true 时失败不弹气泡（后台轮询不该打扰人）。 */
  async refresh({ quiet = false } = {}) {
    if (!this.mounted) return;
    if (!quiet) this.showBubble(this.renderBubble({ amount: "…", hint: T("checking", "Checking...") }), 0);

    try {
      const data = await M8.apiGet(`${API_BASE}/balance`);
      // 留着给 refreshPeakLine 用：换峰谷说法时按新文案重画，不必再查一遍
      this.lastBalance = data;
      this.renderBalanceBubble(data);
    } catch (exc) {
      this.lastBalance = null;
      if (!quiet) {
        this.showBubble(
          this.renderBubble({
            amount: T("unavailable", "N/A"),
            hint: `${exc.code ? exc.code + " · " : ""}${exc.message}`.slice(0, 40),
          }),
          BUBBLE_MS * 1.6,
          "err",
        );
      }
      M8.warn("小鲸鱼查余额失败：", exc.code, exc.message);
    }
  }

  /**
   * 按一次查询结果画余额气泡。
   *
   * 第三行是「时段 + 今日已用」：光知道剩多少判断不了要不要充值，
   * 光知道今天花了多少又不知道贵不贵 —— 两个一起给才有用。
   * 时段那个词按 settings.peakMode 换说法（默认 / 梁文峰谷 / !?强强?!），
   * 高峰红、空闲绿，色值取自原版。
   */
  renderBalanceBubble(data) {
    const primary = data?.balance?.primary;
    if (!primary) {
      this.showBubble(
        this.renderBubble({ amount: "—", hint: T("noBalanceData", "The API returned no balance data") }),
        BUBBLE_MS,
        "err",
      );
      return;
    }

    const esc = M8.escapeHtml;
    const symbol = primary.currency === "CNY" ? "¥" : "";
    const peak = !!data.pricing?.peak;
    const labels = peakLabels(ctx.settings?.peakMode);

    const parts = [
      `<span class="${peak ? "m8-whale-peak-on" : "m8-whale-peak-off"}">`
      + `${esc(peak ? labels.on : labels.off)}</span>`,
    ];

    const spent = Number(data.usage?.spent || 0);
    if (spent > 0) {
      parts.push(T("spentToday", "Spent today {money}", { money: esc(symbol) + esc(spent.toFixed(2)) }));
    } else if (data.balance?.available === false) {
      parts.push(T("accountDisabled", "Account disabled"));
    }

    const amount = Number(primary.totalValue ?? primary.total ?? 0);
    const previous = this.lastAmount;

    this.showBubble(this.renderBubble({
      symbol,
      amount: primary.total,
      hintHtml: parts.join(" · "),
    }));

    // 余额真的变了才滚数字。首次显示（previous 是 undefined）和手动点开都不滚 ——
    // 数字凭空转一圈，看着像余额自己在动。
    if (typeof previous === "number" && Math.abs(previous - amount) > 0.0001) {
      this.rollAmount(previous, amount);
    }
    this.lastAmount = amount;
  }

  /**
   * 金额从旧值滚到新值 —— 700ms 三次方缓出。原版的数字动画。
   *
   * 只在**余额真的变了**的时候滚（自动刷新时）。第一次加载、手动点开，
   * 都是直接显示：数字凭空转一圈会让人以为余额在动。
   */
  rollAmount(from, to, ms = 700) {
    const el = this.bubbleEl.querySelector(".m8-whale-bubble-amount");
    if (!el) return;

    const start = performance.now();
    const span = el.querySelector(".cur");
    const symbol = span ? span.outerHTML : "";

    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      // 1-(1-t)^3：起步快、收尾慢，数字落定时有"刹住"的感觉
      const eased = 1 - Math.pow(1 - t, 3);
      const value = from + (to - from) * eased;
      el.innerHTML = symbol + value.toFixed(2);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------ 台词 */

  /** 把三行台词渲染进气泡。每行带自己的样式档（A/B/P/C）。 */
  renderLines(lines) {
    const esc = M8.escapeHtml;
    let html = "";
    for (const line of lines) {
      if (!line) continue;
      const cls = "m8-whale-bubble-" + styleClass(line.s) + (line.w ? " m8-whale-bubble-wrap" : "");
      const style = line.c ? ` style="color:${esc(line.c)}"` : "";
      html += `<div class="${cls}"${style}>${esc(line.t)}</div>`;
    }
    this.bubbleEl.innerHTML = BUBBLE_SVG + `<div class="m8-whale-bubble-text">${html}</div>`;
    this.hideGif();
  }

  /** gif 台词：只显示动图，三行文字让位。加载失败就降级成一句文字。 */
  showGif() {
    if (!this.gifEl) {
      this.gifEl = document.createElement("img");
      this.gifEl.className = "m8-whale-bubble-gif";
      this.gifEl.src = assetUrl("rua.gif");
      this.gifEl.alt = "";
      this.gifEl.draggable = false;
      this.gifEl.addEventListener("error", () => {
        this.gifFailed = true;
        // 别留一个白气泡 —— 换成文字台词
        if (this.quipActive) this.renderLines(gifFallback());
      });
      this.bubbleEl.appendChild(this.gifEl);
    }
    if (this.gifFailed) {
      this.renderLines(gifFallback());
      return;
    }
    this.bubbleEl.innerHTML = BUBBLE_SVG;
    this.bubbleEl.appendChild(this.gifEl);
    this.gifEl.style.display = "block";
  }

  hideGif() {
    if (this.gifEl) this.gifEl.style.display = "none";
  }

  /** 抽一组台词显示出来。 */
  showQuip() {
    const group = pickGroup();

    if (group.kind === "gif") {
      this.showGif();
      return;
    }
    if (group.kind === "lines") {
      this.renderLines(group.make());
      return;
    }

    // status：正常的三行信息（时段按用户选的说法换词）
    const data = this.lastBalance || {};
    const primary = data.balance?.primary;
    const symbol = primary?.currency === "CNY" ? "¥" : "";
    const spent = Number(data.usage?.spent || 0);
    const labels = peakLabels(ctx.settings?.peakMode);
    this.renderLines(buildStatusLines(
      !!data.pricing?.peak,
      labels,
      spent > 0
        ? T("spentToday", "Spent today {money}", { money: symbol + spent.toFixed(2) })
        : T("noSpendToday", "Nothing spent today"),
    ));
  }

  showBubble(html, ms = BUBBLE_MS, kind = "") {
    // 气泡开关关掉就什么都不弹。它是装饰性反馈，用户关了就是不想要。
    if (ctx.settings?.bubble === false) return;
    this.bubbleEl.innerHTML = html;
    this.bubbleEl.classList.toggle("-err", kind === "err");
    this.bubbleEl.classList.add("-show");
    // 每次重新弹气泡都重置台词状态：新的一次显示，第一次点还是「换台词」
    this.quipActive = false;
    this.gifEl = null;
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    if (ms > 0) {
      this.bubbleTimer = setTimeout(() => this.hideBubble(), ms);
    }
  }

  hideBubble() {
    this.bubbleEl.classList.remove("-show");
    if (this.bubbleTimer) clearTimeout(this.bubbleTimer);
    this.bubbleTimer = null;
  }
}

/* ---------------------------------------------------------------- 侧边栏 */

function registerSidebar() {
  const manager = app.extensionManager;
  if (!manager?.registerSidebarTab) {
    M8.warn("这个 ComfyUI 版本的侧边栏 API 不可用，小鲸鱼只能留在挂件上");
    return;
  }

  manager.registerSidebarTab({
    id: SIDEBAR_ID,
    icon: "pi pi-cloud",
    title: T("sidebarTitle", "Little Whale"),
    tooltip: T("sidebarTooltip", "DeepSeek balance and chat"),
    type: "custom",
    render(el) {
      buildSettingsPanel(el, ctx);
    },
  });
}

/* ---------------------------------------------------------------- 入口 */

app.registerExtension({
  name: "M8.Whale",
  async setup() {
    injectCss();
    try {
      await ctx.loadState();
    } catch (exc) {
      // 接口没起来不该拦着人画图：挂件仍然出来，只是查余额会报错
      M8.warn("小鲸鱼：没读到服务端状态", exc.message);
      ctx.settings = {};
    }

    registerSidebar();

    ctx.widget = new WhaleWidget();
    ctx.dialog = new WhaleDialog(ctx);
    ctx.applyEnabled();

    // resize 时不是「把挂件挪回原位」，而是「按锚点重新贴边」——
    // 贴着右缘的挂件在窗口变宽后应该继续贴着右缘，而不是停在原来的 x 上
    window.addEventListener("resize", () => ctx.widget?.applyAnchor());
    M8.log("小鲸鱼已就位");
  },
});
