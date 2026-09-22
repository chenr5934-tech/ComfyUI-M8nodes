/* ============================================================================
 * M8 · 工作台入口按钮
 *
 * 在 ComfyUI 顶部那条菜单栏上加一个小按钮，点开 M8web（新标签页）。
 *
 * 为什么用「监听 + 重试」而不是只等 registerExtension：
 * 顶栏是 ComfyUI 自己渲染的，扩展加载完时它**可能还没建好**。
 * 不同版本挂载时机不一样，所以这里一边盯 DOM 变化、一边按节奏重试，
 * 谁先到位都能插进去；已经插过就不再插。
 * ==========================================================================*/

import { app } from "/scripts/app.js";

const BTN_ID = "m8-web-entry";
const WEB_PATH = "m8/web/index.html";

/* 用当前页面地址推，兼容别人把 ComfyUI 挂在子路径（比如 /comfy/）的情况 */
function webUrl() {
  const base = window.location.pathname.replace(/\/[^/]*$/, "/");
  return base + WEB_PATH;
}

function makeButton() {
  const b = document.createElement("a");
  b.id = BTN_ID;
  b.href = webUrl();
  b.target = "_blank";
  b.rel = "noopener";
  b.title = "打开 M8 工作台（新标签页）";
  b.textContent = "M8";
  b.style.cssText = [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "height:26px",
    "padding:0 10px",
    "margin:0 4px",
    "border-radius:6px",
    "font-size:12px",
    "font-weight:700",
    "letter-spacing:.4px",
    "text-decoration:none",
    "color:#0b0e13",
    "background:linear-gradient(135deg,#3ba99c,#e8a33d)",
    "cursor:pointer",
    "flex:none",
    "user-select:none",
  ].join(";");
  /* 别让点击冒泡到顶栏自己的处理上（有的版本点空白会开设置） */
  b.addEventListener("click", (ev) => ev.stopPropagation());
  return b;
}

/* 顶栏容器。**类名是从 ComfyUI 打包的 CSS 里查出来的**，不是猜的。
 *
 * 这个前端整体是个 Vue 应用（整页只有 `<div id="vue-app">` 一个挂载点），
 * 顶栏的类名是 `.comfyui-body-top` —— 和它并列的还有 body-left / -right / -bottom。
 * 之前凭印象写的 .comfyui-menu / .comfy-menu / #comfyui-menu 全都不存在，
 * 所以按钮一直没出现。后面的几个是备用，各版本叫法可能变。 */
const HOST_SELECTORS = [
  ".comfyui-body-top",
  "[class*='comfyui-body-top']",
  ".comfyui-body-topbar",
  "#vue-app > div > div:first-child",
];

function findHost() {
  for (const sel of HOST_SELECTORS) {
    let el = null;
    try {
      el = document.querySelector(sel);
    } catch (e) {
      continue;
    }
    if (el) return el;
  }
  return null;
}

function tryInsert() {
  if (document.getElementById(BTN_ID)) return true;

  const host = findHost();
  if (!host) return false;

  /* 插在一排图标按钮之前比较自然；找不到参照就追加到末尾。
     不依赖具体类名，只看它是不是个可点的东西。 */
  const anchor = host.querySelector(
    ".comfyui-button-group, .comfyui-button, button, [role='button']",
  );
  const b = makeButton();
  if (anchor && anchor.parentElement === host) host.insertBefore(b, anchor);
  else host.appendChild(b);
  return true;
}

function start() {
  if (tryInsert()) return;

  const obs = new MutationObserver(() => {
    if (tryInsert()) obs.disconnect();
  });
  obs.observe(document.body, { childList: true, subtree: true });

  /* 再兜一层定时重试：某些构建里顶栏的渲染不会触发 MutationObserver */
  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tryInsert()) {
      clearInterval(timer);
      obs.disconnect();
      return;
    }
    if (tries > 40) {
      clearInterval(timer);
      obs.disconnect();
      /* 试了 20 秒还是找不到顶栏 —— 与其静默失败，不如把现场打出来。
         这种问题只能靠日志定位：类名随版本变，猜是猜不中的。 */
      console.warn(
        "[M8] 没找到顶栏容器，工作台入口按钮没挂上。",
        "\n试过的选择器：", HOST_SELECTORS.join(" / "),
        "\n#vue-app 的直接子元素：",
        Array.from((document.getElementById("vue-app") || document.body).children)
          .map((c) => c.tagName + "." + (c.className || "(无类名)"))
          .join(" , "),
      );
    }
  }, 500);
}

app.registerExtension({
  name: "M8.WebEntry",
  async setup() {
    try {
      start();
    } catch (exc) {
      console.error("[M8] 工作台入口按钮挂载失败：", exc);
    }
  },
});
