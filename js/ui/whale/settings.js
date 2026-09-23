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

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui.M8Whale 段提供。 */
const T = M8.tFor("M8Whale");

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
// 这个函数一次都没被调用过。

export function buildSettingsPanel(root, ctx) {
  root.innerHTML = "";
  root.classList.add("m8-whale-panel");

  const settings = ctx.settings || {};

  /* ---- 抬头 ---- */
  const head = document.createElement("h3");
  const avatar = el("img", { src: assetUrl("whale.png"), alt: "" });
  head.appendChild(avatar);
  head.appendChild(document.createTextNode(T("title", "Little Whale")));
  root.appendChild(head);

  const statusLine = el("div", { className: "m8-whale-hint" });
  statusLine.textContent = ctx.state?.hasKey
    ? T("keyConfigured", "Key configured {masked}", { masked: ctx.state.masked })
    : T("noKey", "No API key yet - balance and chat will not work");
  root.appendChild(statusLine);

  root.appendChild(el("hr", { className: "m8-whale-sep" }));

  /* ---- 启用 ---- */
  const enabled = el("input", { type: "checkbox", checked: settings.enabled !== false });
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "m8-whale-switch";
  enabledLabel.appendChild(enabled);
  enabledLabel.appendChild(document.createTextNode(T("showWidget", "Show the widget")));
  root.appendChild(field(
    T("widgetLabel", "Widget"),
    enabledLabel,
    T("widgetHint", "Turning this off hides the widget in the bottom-right corner. This sidebar page stays, so you can bring it back any time."),
  ));

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
  root.appendChild(field(T("sizeLabel", "Size"), scaleRow, T("sizeHint", "Multiplier against the widget's original size.")));
  scale.addEventListener("input", () => {
    scaleLabel.textContent = `${Number(scale.value).toFixed(1)}×`;
    ctx.settings.scale = Number(scale.value);
    ctx.widget?.reflow();
  });
  scale.addEventListener("change", () => ctx.save({ scale: Number(scale.value) }));

  const bubble = el("input", { type: "checkbox", checked: settings.bubble !== false });
  root.appendChild(switchField(
    T("bubbleLabel", "Bubble"),
    bubble,
    T("bubbleHint", "Turning this off stops the widget from showing bubbles, error notices included."),
  ));
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
  avoidLabel.appendChild(document.createTextNode(T("avoid", "Avoid")));
  avoidRow.appendChild(avoidLabel);
  avoidRow.appendChild(avoidWidth);
  root.appendChild(field(
    T("avoidScrollbarLabel", "Avoid the scrollbar"),
    avoidRow,
    T("avoidScrollbarHint", "Gap kept on the right edge, in pixels. Browsers and zoom levels pack scrollbars differently, so this is yours to set."),
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
  root.appendChild(switchField(
    T("soundLabel", "Sound"),
    soundOn,
    T("soundHint", "Plays on press and release."),
  ));
  soundOn.addEventListener("change", () => ctx.save({ sound: soundOn.checked }));

  const soundSet = el("select");
  for (const [value, label] of [
    ["duck", T("soundDuck", "Duck")],
    ["fx1", T("soundFx1", "Effect 1")],
  ]) {
    soundSet.appendChild(el("option", { value, textContent: label }));
  }
  soundSet.value = settings.soundSet === "fx1" ? "fx1" : "duck";
  root.appendChild(field(T("soundSetLabel", "Sound set"), soundSet, ""));
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
  root.appendChild(field(T("volumeLabel", "Volume"), volumeRow, ""));
  volume.addEventListener("input", () => {
    volumeLabel.textContent = `${Math.round(Number(volume.value) * 100)}%`;
    ctx.settings.volume = Number(volume.value);
  });
  volume.addEventListener("change", () => ctx.save({ volume: Number(volume.value) }));

  /* ---- 密钥 ---- */
  const keyInput = el("input", {
    type: "password",
    placeholder: ctx.state?.hasKey
      ? T("keyPlaceholderSet", "One is already stored; a new one replaces it")
      : "sk-...",
  });
  const keySave = el("button", { textContent: T("save", "Save"), className: "-primary" });
  const keyRow = document.createElement("div");
  keyRow.className = "m8-whale-row";
  keyRow.appendChild(keyInput);
  keyRow.appendChild(keySave);

  root.appendChild(field(
    "DeepSeek API Key",
    keyRow,
    T("keyHint", "Stored server-side in m8/data/credentials.json and never sent back to the browser. Press Save when done."),
  ));

  keySave.addEventListener("click", async () => {
    const value = keyInput.value.trim();
    if (!value) {
      M8.notify(T("keyEmpty", "The input is empty"), { kind: "warn" });
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
      statusLine.textContent = T("keyConfigured", "Key configured {masked}", { masked: state.masked });
      M8.notify(T("keySaved", "Key saved ({masked})", { masked: state.masked }), { kind: "ok" });
    } catch (exc) {
      M8.notifyError(exc, T("actionSaveKey", "Save key"));
    }
  });

  /* ---- 模型 ---- */
  const modelSelect = el("select");
  const refreshModels = el("button", { textContent: T("refresh", "Refresh") });
  const modelRow = document.createElement("div");
  modelRow.className = "m8-whale-row";
  modelRow.appendChild(modelSelect);
  modelRow.appendChild(refreshModels);

  root.appendChild(field(
    T("modelLabel", "Model"),
    modelRow,
    T("modelHint", "Leave it blank and chat uses the first model in the list."),
  ));

  const fillModels = (models, current) => {
    modelSelect.innerHTML = "";
    modelSelect.appendChild(el("option", { value: "", textContent: T("modelAuto", "(auto: first in the list)") }));
    for (const name of models) {
      modelSelect.appendChild(el("option", { value: name, textContent: name }));
    }
    if (current && models.includes(current)) modelSelect.value = current;
    else if (current) {
      // 存的模型现在拉不到了（下架了？），仍然列出来，别悄悄把人的选择抹掉
      modelSelect.appendChild(el("option", {
        value: current,
        textContent: T("modelMissing", "{name} (not in the list)", { name: current }),
      }));
      modelSelect.value = current;
    }
  };
  fillModels([], settings.model);

  refreshModels.addEventListener("click", async () => {
    refreshModels.disabled = true;
    refreshModels.textContent = T("fetching", "Fetching...");
    try {
      const data = await M8.apiPost("/llm/models", { provider: "deepseek" });
      fillModels(data.models, modelSelect.value || settings.model);
      M8.notify(T("gotModels", "Got {n} models", { n: data.count }), { kind: "ok", timeout: 2400 });
    } catch (exc) {
      M8.notifyError(exc, T("actionFetchModels", "Fetch model list"));
    } finally {
      refreshModels.disabled = false;
      refreshModels.textContent = T("refresh", "Refresh");
    }
  });

  modelSelect.addEventListener("change", () => ctx.save({ model: modelSelect.value }));

  /* ---- 系统提示词 ---- */
  const prompt = el("textarea", {
    value: settings.systemPrompt || "",
    placeholder: T("promptPlaceholder", "Sets the whale's persona and output style. Leave it blank for a plain assistant."),
  });
  root.appendChild(field(
    T("promptLabel", "System prompt"),
    prompt,
    T("promptHint", "Sent with every turn in the dialog."),
  ));
  prompt.addEventListener("change", () => ctx.save({ systemPrompt: prompt.value }));

  /* ---- 思考强度 ---- */
  const thinking = el("select");
  const options = ctx.state?.thinkingOptions || ["off"];
  for (const item of options) {
    thinking.appendChild(el("option", { value: item, textContent: item }));
  }
  thinking.value = settings.thinking || options[0];
  root.appendChild(field(
    T("thinkingLabel", "Thinking effort"),
    thinking,
    T("thinkingHint", "If the provider rejects this parameter it is dropped and the request retried once; the log says so."),
  ));
  thinking.addEventListener("change", () => ctx.save({ thinking: thinking.value }));

  /* ---- 数值 ---- */
  const number = (value, min, max, step) =>
    el("input", { type: "number", value: String(value), min: String(min), max: String(max), step: String(step) });

  const temperature = number(settings.temperature ?? 1, 0, 2, 0.05);
  root.appendChild(field(
    T("temperatureLabel", "Temperature"),
    temperature,
    T("temperatureHint", "Lower for steady work like writing prompts, higher for casual chat."),
  ));
  temperature.addEventListener("change", () => ctx.save({ temperature: Number(temperature.value) }));

  const maxTokens = number(settings.maxTokens ?? 4096, 16, 131072, 16);
  root.appendChild(field(
    T("maxTokensLabel", "Max answer length"),
    maxTokens,
    T("maxTokensHint", "This is a ceiling, not a target; normal answers do not fill it."),
  ));
  maxTokens.addEventListener("change", () => ctx.save({ maxTokens: Number(maxTokens.value) }));

  const timeout = number(settings.timeout ?? 120, 5, 3600, 5);
  root.appendChild(field(
    T("timeoutLabel", "Timeout (seconds)"),
    timeout,
    T("timeoutHint", "Give slower models a larger value."),
  ));
  timeout.addEventListener("change", () => ctx.save({ timeout: Number(timeout.value) }));

  /* ---- 余额 ---- */
  const refresh = number(settings.refreshSeconds ?? 60, 0, 3600, 10);
  root.appendChild(field(
    T("refreshLabel", "Balance refresh interval (seconds)"),
    refresh,
    T("refreshHint", "Set 0 to stop refreshing automatically and only check when you click."),
  ));
  refresh.addEventListener("change", () => ctx.save({ refreshSeconds: Number(refresh.value) }).then(() => ctx.widget?.startTimer()));

  const historyLimit = number(settings.historyLimit ?? 20, 2, 60, 2);
  root.appendChild(field(
    T("historyLabel", "Chat history length"),
    historyLimit,
    T("historyHint", "How many turns of context the dialog carries. More than you need just burns tokens."),
  ));
  historyLimit.addEventListener("change", () => ctx.save({ historyLimit: Number(historyLimit.value) }));

  /* ---- 用量 ---- */
  const usageLine = el("div", { className: "m8-whale-hint" });
  root.appendChild(field(
    T("usageLabel", "Used today"),
    usageLine,
    T("usageHint", "Accounted from balance deltas: every balance check compares against the last one and adds any decrease."),
  ));

  const refreshUsage = async () => {
    try {
      const data = await M8.apiGet(`${API_BASE}/usage`);
      const money = `${data.usage.currency === "CNY" ? "¥" : ""}${Number(data.usage.spent || 0).toFixed(4)}`;
      const peak = data.pricing?.peak
        ? T("peakOn", " · peak hours now (2x the off-peak rate)")
        : T("peakOff", " · off-peak now");
      usageLine.textContent = T("usageLine", "{date}: {money} (from {n} samples){peak}", {
        date: data.date,
        money,
        n: data.usage.samples,
        peak,
      });
    } catch (exc) {
      usageLine.textContent = T("usageError", "Cannot read: {message}", { message: exc.message });
    }
  };
  refreshUsage();

  const resetUsage = el("button", { textContent: T("resetUsage", "Reset accounting") });
  root.appendChild(field("", resetUsage, ""));
  resetUsage.addEventListener("click", async () => {
    try {
      await M8.apiPost(`${API_BASE}/usage/reset`);
      await refreshUsage();
      M8.notify(T("usageReset", "Today's usage has been reset"), { kind: "ok", timeout: 2000 });
    } catch (exc) {
      M8.notifyError(exc, T("actionResetUsage", "Reset accounting"));
    }
  });

  /* ---- 每轮消耗 ---- */
  const turnCost = el("input", { type: "checkbox", checked: settings.turnCost !== false });
  root.appendChild(switchField(
    T("turnCostLabel", "Per-turn cost"),
    turnCost,
    T("turnCostHint", "After every turn, the widget bubble shows what that turn cost."),
  ));
  turnCost.addEventListener("change", () => ctx.save({ turnCost: turnCost.checked }));

  const turnCostClose = number(settings.turnCostCloseMs ?? 4000, 0, 60000, 500);
  root.appendChild(field(
    T("turnCostCloseLabel", "Auto-close the cost bubble (ms)"),
    turnCostClose,
    T("turnCostCloseHint", "Set 0 to keep it open until you click it."),
  ));
  turnCostClose.addEventListener("change", () => ctx.save({ turnCostCloseMs: Number(turnCostClose.value) }));

  /* ---- 动作 ---- */
  const actions = document.createElement("div");
  actions.className = "m8-whale-row";

  const checkBalance = el("button", { textContent: T("checkBalance", "Check balance") });
  const resetPos = el("button", { textContent: T("resetPos", "Reset widget position") });
  actions.appendChild(checkBalance);
  actions.appendChild(resetPos);
  root.appendChild(actions);

  checkBalance.addEventListener("click", async () => {
    try {
      const data = await M8.apiGet(`${API_BASE}/balance`);
      const primary = data.balance?.primary;
      M8.notify(
        primary
          ? `${primary.currency} ${primary.total}`
          : T("noBalance", "No balance data"),
        {
          kind: primary ? "ok" : "warn",
          hint: T("fetchedAt", "Checked at {time}", { time: data.balance?.fetchedAt || "" }),
        },
      );
    } catch (exc) {
      M8.notifyError(exc, T("actionCheckBalance", "Check balance"));
    }
  });

  resetPos.addEventListener("click", async () => {
    await ctx.save({ position: null });
    ctx.widget?.place(
      window.innerWidth - 140,
      window.innerHeight - 200,
    );
    M8.notify(T("posReset", "Widget moved back"), { kind: "ok", timeout: 2000 });
  });

  root.appendChild(field(T("actionsLabel", "Actions"), actions, ""));
}

export default { buildSettingsPanel };
