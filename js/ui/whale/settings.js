/* ============================================================================
 * M8 小鲸鱼 · 侧边栏设置面板
 *
 * 放在 ComfyUI 的侧边栏里（app.extensionManager.registerSidebarTab）。
 * 用原生 DOM 搭，不引框架 —— 面板就这么点控件，为它拉一个运行时不值得。
 *
 * 保存策略：改完就存，没有「保存」按钮。密钥是例外 —— 它要回显掩码，
 * 所以走一个显式按钮，让人看见「存进去了」。
 *
 * 这一层是纯配置。对话本身在 dialog.js，挂件在 whale.js。
 * ==========================================================================*/

import * as M8 from "../../m8_core.js";
import { API_BASE, assetUrl } from "./whale.js";

/** 建一个带标签和说明的字段容器。 */
function field(label, control, hint) {
  const wrap = document.createElement("div");
  wrap.className = "m8-whale-field";

  const lab = document.createElement("label");
  lab.textContent = label;
  wrap.appendChild(lab);
  wrap.appendChild(control);

  if (hint) {
    const note = document.createElement("div");
    note.className = "m8-whale-hint";
    note.textContent = hint;
    wrap.appendChild(note);
  }
  return wrap;
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

/** 一个「复选框 + 文字」的开关。省得每处都写一遍。 */
function switchField(label, checkbox, hint) {
  const wrap = document.createElement("label");
  wrap.className = "m8-whale-switch";
  wrap.appendChild(checkbox);
  wrap.appendChild(document.createTextNode(label));
  return field("", wrap, hint);
}

// section 删掉了：原本想给面板分小节，实际用的是 field + hr 直接排，
// 这个函数一次都没被调用。

export function buildSettingsPanel(root, ctx) {
  root.innerHTML = "";
  root.classList.add("m8-whale-panel");

  const settings = ctx.settings || {};

  /* ---- 抬头 ---- */
  const head = document.createElement("h3");
  const avatar = el("img", { src: assetUrl("whale.png"), alt: "" });
  head.appendChild(avatar);
  head.appendChild(document.createTextNode("小鲸鱼"));
  root.appendChild(head);

  const statusLine = el("div", { className: "m8-whale-hint" });
  statusLine.textContent = ctx.state?.hasKey
    ? `已配置密钥 ${ctx.state.masked}`
    : "还没配密钥 —— 余额和对话都用不了";
  root.appendChild(statusLine);

  root.appendChild(el("hr", { className: "m8-whale-sep" }));

  /* ---- 启用 ---- */
  const enabled = el("input", { type: "checkbox", checked: settings.enabled !== false });
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "m8-whale-switch";
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(document.createTextNode("显示挂件"));
  root.appendChild(field("挂件", enabledLabel, "关掉之后右下角的挂件就收起来。侧边栏这一页始终留着，随时能开回来。"));

  enabled.addEventListener("change", async () => {
    await ctx.save({ enabled: enabled.checked });
    ctx.applyEnabled();
  });

  /* ---- 外观 ---- */
  const scale = el("input", {
    type: "range",
    min: "0.6", max: "2.5", step: "0.1",
    value: String(settings.scale ?? 1),
  });
  const scaleLabel = el("span", { textContent: `${(settings.scale ?? 1).toFixed(1)}×` });
  const scaleRow = document.createElement("div");
  scaleRow.className = "m8-whale-row";
  scaleRow.appendChild(scale);
  scaleRow.appendChild(scaleLabel);
  root.appendChild(field("大小", scaleRow, "挂件相对原始尺寸的倍数。"));
  scale.addEventListener("input", () => {
    scaleLabel.textContent = `${Number(scale.value).toFixed(1)}×`;
    ctx.settings.scale = Number(scale.value);
    ctx.widget?.reflow();
  });
  scale.addEventListener("change", () => ctx.save({ scale: Number(scale.value) }));

  const bubble = el("input", { type: "checkbox", checked: settings.bubble !== false });
  root.appendChild(switchField("气泡", bubble, "关掉之后挂件不再弹气泡（包括报错提示）。"));
  bubble.addEventListener("change", () => ctx.save({ bubble: bubble.checked }));

  const avoid = el("input", { type: "checkbox", checked: settings.avoidScrollbar !== false });
  const avoidWidth = el("input", {
    type: "number", min: "0", max: "60", step: "1",
    value: String(settings.scrollbarWidth ?? 17),
  });
  const avoidRow = document.createElement("div");
  avoidRow.className = "m8-whale-row";
  const avoidLabel = document.createElement("label");
  avoidLabel.className = "m8-whale-switch";
  avoidLabel.appendChild(avoid);
  avoidLabel.appendChild(document.createTextNode("避开"));
  avoidRow.appendChild(avoidLabel);
  avoidRow.appendChild(avoidWidth);
  root.appendChild(field(
    "避让滚动条",
    avoidRow,
    "贴右边时留出的宽度（px）。不同浏览器、不同缩放下滚动条不一样宽，所以让人自己填。",
  ));
  const pushAvoid = () => {
    ctx.settings.avoidScrollbar = avoid.checked;
    ctx.settings.scrollbarWidth = Number(avoidWidth.value) || 0;
    ctx.save({ avoidScrollbar: avoid.checked, scrollbarWidth: Number(avoidWidth.value) || 0 });
    ctx.widget?.reflow();
  };
  avoid.addEventListener("change", pushAvoid);
  avoidWidth.addEventListener("change", pushAvoid);

  /* ---- 音效 ---- */
  const soundOn = el("input", { type: "checkbox", checked: settings.sound !== false });
  root.appendChild(switchField("音效", soundOn, "按下和松开挂件时出声。"));
  soundOn.addEventListener("change", () => ctx.save({ sound: soundOn.checked }));

  const soundSet = el("select");
  for (const [value, label] of [["duck", "小黄鸭"], ["fx1", "音效1"]]) {
    soundSet.appendChild(el("option", { value, textContent: label }));
  }
  soundSet.value = settings.soundSet === "fx1" ? "fx1" : "duck";
  root.appendChild(field("音效集", soundSet, ""));
  soundSet.addEventListener("change", () => {
    ctx.save({ soundSet: soundSet.value });
    ctx.widget?.playSound("press");
  });

  const volume = el("input", {
    type: "range", min: "0", max: "1", step: "0.05",
    value: String(settings.volume ?? 0.5),
  });
  const volumeLabel = el("span", { textContent: `${Math.round((settings.volume ?? 0.5) * 100)}%` });
  const volumeRow = document.createElement("div");
  volumeRow.className = "m8-whale-row";
  volumeRow.appendChild(volume);
  volumeRow.appendChild(volumeLabel);
  root.appendChild(field("音量", volumeRow, ""));
  volume.addEventListener("input", () => {
    volumeLabel.textContent = `${Math.round(Number(volume.value) * 100)}%`;
    ctx.settings.volume = Number(volume.value);
  });
  volume.addEventListener("change", () => ctx.save({ volume: Number(volume.value) }));

  /* ---- 密钥 ---- */
  const keyInput = el("input", {
    type: "password",
    placeholder: ctx.state?.hasKey ? "已存了一份，填新的会覆盖" : "sk-...",
  });
  const keySave = el("button", { textContent: "保存", className: "-primary" });
  const keyRow = document.createElement("div");
  keyRow.className = "m8-whale-row";
  keyRow.appendChild(keyInput);
  keyRow.appendChild(keySave);

  root.appendChild(field(
    "DeepSeek API Key",
    keyRow,
    "存在服务端的 m8/data/credentials.json，不回传给浏览器。填完点保存。",
  ));

  keySave.addEventListener("click", async () => {
    const value = keyInput.value.trim();
    if (!value) {
      M8.notify("输入框是空的", { kind: "warn" });
      return;
    }
    try {
      // baseUrl 一起存：服务端要记下这份密钥归哪个地址用
      await M8.apiPost("/keys/set", {
        provider: "deepseek",
        apiKey: value,
        baseUrl: "https://api.deepseek.com/v1",
      });
      keyInput.value = "";
      const state = await ctx.loadState();
      statusLine.textContent = `已配置密钥 ${state.masked}`;
      M8.notify(`密钥已保存（${state.masked}）`, { kind: "ok" });
    } catch (exc) {
      M8.notifyError(exc, "保存密钥");
    }
  });

  /* ---- 模型 ---- */
  const modelSelect = el("select");
  const refreshModels = el("button", { textContent: "刷新" });
  const modelRow = document.createElement("div");
  modelRow.className = "m8-whale-row";
  modelRow.appendChild(modelSelect);
  modelRow.appendChild(refreshModels);

  root.appendChild(field(
    "模型",
    modelRow,
    "留空的话，对话时自动用列表里的第一个。",
  ));

  const fillModels = (models, current) => {
    modelSelect.innerHTML = "";
    modelSelect.appendChild(el("option", { value: "", textContent: "（自动，用列表第一个）" }));
    for (const name of models) {
      modelSelect.appendChild(el("option", { value: name, textContent: name }));
    }
    if (current && models.includes(current)) modelSelect.value = current;
    else if (current) {
      // 存的模型现在拉不到了（下架了？），仍然列出来，别悄悄把人的选择抹掉
      modelSelect.appendChild(el("option", { value: current, textContent: `${current}（列表里没有）` }));
      modelSelect.value = current;
    }
  };
  fillModels([], settings.model);

  refreshModels.addEventListener("click", async () => {
    refreshModels.disabled = true;
    refreshModels.textContent = "拉取中…";
    try {
      const data = await M8.apiPost("/llm/models", { provider: "deepseek" });
      fillModels(data.models, modelSelect.value || settings.model);
      M8.notify(`拿到 ${data.count} 个模型`, { kind: "ok", timeout: 2400 });
    } catch (exc) {
      M8.notifyError(exc, "拉模型列表");
    } finally {
      refreshModels.disabled = false;
      refreshModels.textContent = "刷新";
    }
  });

  modelSelect.addEventListener("change", () => ctx.save({ model: modelSelect.value }));

  /* ---- 系统提示词 ---- */
  const prompt = el("textarea", { value: settings.systemPrompt || "", placeholder: "给小鲸鱼定人格和输出格式。留空就是普通助手。" });
  root.appendChild(field("系统提示词", prompt, "对话框里每一轮都会带上它。"));
  prompt.addEventListener("change", () => ctx.save({ systemPrompt: prompt.value }));

  /* ---- 思考强度 ---- */
  const thinking = el("select");
  const options = ctx.state?.thinkingOptions || ["关"];
  for (const item of options) {
    thinking.appendChild(el("option", { value: item, textContent: item }));
  }
  thinking.value = settings.thinking || options[0];
  root.appendChild(field(
    "思考强度",
    thinking,
    "供应商不支持该参数时会自动去掉重试一次，日志里会说明。",
  ));
  thinking.addEventListener("change", () => ctx.save({ thinking: thinking.value }));

  /* ---- 数值 ---- */
  const number = (value, min, max, step) =>
    el("input", { type: "number", value: String(value), min: String(min), max: String(max), step: String(step) });

  const temperature = number(settings.temperature ?? 1, 0, 2, 0.05);
  root.appendChild(field("温度", temperature, "写提示词这类要稳的活儿调低，闲聊调高。"));
  temperature.addEventListener("change", () => ctx.save({ temperature: Number(temperature.value) }));

  const maxTokens = number(settings.maxTokens ?? 4096, 16, 131072, 16);
  root.appendChild(field("回答长度上限", maxTokens, "上限不是目标，正常回答不会一直写满。"));
  maxTokens.addEventListener("change", () => ctx.save({ maxTokens: Number(maxTokens.value) }));

  const timeout = number(settings.timeout ?? 120, 5, 3600, 5);
  root.appendChild(field("超时（秒）", timeout, "想得久的模型给大一点。"));
  timeout.addEventListener("change", () => ctx.save({ timeout: Number(timeout.value) }));

  /* ---- 余额 ---- */
  const refresh = number(settings.refreshSeconds ?? 60, 0, 3600, 10);
  root.appendChild(field("余额刷新间隔（秒）", refresh, "填 0 就不自动刷新，只在你点左右键的时候查。"));
  refresh.addEventListener("change", () => ctx.save({ refreshSeconds: Number(refresh.value) }).then(() => ctx.widget?.startTimer()));

  const historyLimit = number(settings.historyLimit ?? 20, 2, 60, 2);
  root.appendChild(field("对话历史条数", historyLimit, "对话框每次带上多少条上下文。太多只是白烧 token。"));
  historyLimit.addEventListener("change", () => ctx.save({ historyLimit: Number(historyLimit.value) }));

  /* ---- 用量 ---- */
  const usageLine = el("div", { className: "m8-whale-hint" });
  root.appendChild(field("今日已用", usageLine, "靠余额差值记账：每次查余额时和上一次比，变少了就累加。"));

  const refreshUsage = async () => {
    try {
      const data = await M8.apiGet(`${API_BASE}/usage`);
      const money = `${data.usage.currency === "CNY" ? "¥" : ""}${Number(data.usage.spent || 0).toFixed(4)}`;
      const peak = data.pricing?.peak ? " · 当前高峰时段（单价是空闲时段的 2 倍）" : " · 当前空闲时段";
      usageLine.textContent = `${data.date}：${money}（观测 ${data.usage.samples} 次）${peak}`;
    } catch (exc) {
      usageLine.textContent = `读不到：${exc.message}`;
    }
  };
  refreshUsage();

  const resetUsage = el("button", { textContent: "重置记账" });
  root.appendChild(field("", resetUsage, ""));
  resetUsage.addEventListener("click", async () => {
    try {
      await M8.apiPost(`${API_BASE}/usage/reset`);
      await refreshUsage();
      M8.notify("今日已用已重置", { kind: "ok", timeout: 2000 });
    } catch (exc) {
      M8.notifyError(exc, "重置记账");
    }
  });

  /* ---- 每轮消耗 ---- */
  const turnCost = el("input", { type: "checkbox", checked: settings.turnCost !== false });
  root.appendChild(switchField("每轮消耗提示", turnCost, "对话框里每回一轮，就在挂件气泡上显示这轮花了多少钱。"));
  turnCost.addEventListener("change", () => ctx.save({ turnCost: turnCost.checked }));

  const turnCostClose = number(settings.turnCostCloseMs ?? 4000, 0, 60000, 500);
  root.appendChild(field(
    "消耗气泡自动关闭（毫秒）",
    turnCostClose,
    "填 0 就不自动关，点一下才消失。",
  ));
  turnCostClose.addEventListener("change", () => ctx.save({ turnCostCloseMs: Number(turnCostClose.value) }));

  /* ---- 动作 ---- */
  const actions = document.createElement("div");
  actions.className = "m8-whale-row";

  const checkBalance = el("button", { textContent: "查一次余额" });
  const resetPos = el("button", { textContent: "挂件归位" });
  actions.appendChild(checkBalance);
  actions.appendChild(resetPos);
  root.appendChild(actions);

  checkBalance.addEventListener("click", async () => {
    try {
      const data = await M8.apiGet(`${API_BASE}/balance`);
      const primary = data.balance?.primary;
      M8.notify(
        primary ? `${primary.currency} ${primary.total}` : "没有余额数据",
        { kind: primary ? "ok" : "warn", hint: `查询时间 ${data.balance?.fetchedAt || ""}` },
      );
    } catch (exc) {
      M8.notifyError(exc, "查余额");
    }
  });

  resetPos.addEventListener("click", async () => {
    await ctx.save({ position: null });
    ctx.widget?.place(
      window.innerWidth - 140,
      window.innerHeight - 200,
    );
    M8.notify("挂件已归位", { kind: "ok", timeout: 2000 });
  });

  root.appendChild(field("操作", actions, ""));
}

export default { buildSettingsPanel };
