/* ============================================================================
 * M8 · 大模型推理 —— 前端
 *
 * 加的东西：
 *   刷新模型     把当前 base_url + 密钥发给后端，拉回模型列表填进下拉
 *   保存密钥     把密钥存到服务端，然后清空输入框（这样它不会进工作流文件）
 *   思考过程     折叠式只读框，由 onExecuted 收到后端回传的 ui.m8 填充
 *   供应商联动   换供应商自动带出默认 base_url 和对应的思考参数说明
 *
 * 输出口只有 text 一个 —— 思考内容不走连线，走这个框。
 * 原因：接了提示词编码之类的下游时，思考过程混进正文只会污染结果。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import { ComfyWidgets } from "/scripts/widgets.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8LLMInference";

/* 和后端 m8/nodes/llm/llm_inference.py 里的 MODEL_PLACEHOLDER 必须逐字一致 */
const MODEL_PLACEHOLDER = "（点「刷新模型」拉取列表）";

M8.injectTheme();

/* 供应商档案是后端说了算的。这里只是缓存一份用于联动 base_url，
   拉不到也不影响 —— 用户手填地址照样能跑。 */
let providerCache = null;

async function loadProviders() {
  if (providerCache) return providerCache;
  try {
    const health = await M8.apiGet("/health");
    providerCache = {};
    for (const item of health.providerOptions || []) {
      providerCache[item.key] = item;
    }
  } catch (exc) {
    M8.warn("拉供应商档案失败，base_url 联动不可用：", exc.message);
    providerCache = {};
  }
  return providerCache;
}

function widgetValue(node, name) {
  return M8.findWidget(node, name)?.value;
}

async function refreshModels(node) {
  M8.setStatus(node, "busy", "拉取模型…");
  const result = await M8.apiPost("/llm/models", {
    provider: widgetValue(node, "provider"),
    baseUrl: widgetValue(node, "base_url"),
    apiKey: widgetValue(node, "api_key"),
    timeout: 30,
  });

  const modelWidget = M8.findWidget(node, "model");
  M8.setComboOptions(modelWidget, result.models);
  M8.setStatus(node, "ok", `${result.count} 个模型`);
  M8.notify(`拿到 ${result.count} 个模型，已填进下拉`, { kind: "ok", timeout: 2600 });
  app.graph?.setDirtyCanvas(true, true);
}

async function saveKey(node) {
  const provider = widgetValue(node, "provider");
  const keyWidget = M8.findWidget(node, "api_key");
  const value = (keyWidget?.value || "").trim();

  if (!value) {
    M8.notify("输入框是空的，没什么可存的", { kind: "warn" });
    return;
  }

  // baseUrl 一起存：服务端要记下这份密钥归哪个地址用，以后只有发往它才带上
  const baseUrl = (M8.findWidget(node, "base_url")?.value || "").trim();
  const result = await M8.apiPost("/keys/set", { provider, apiKey: value, baseUrl });
  // 存完就清空：留在框里会被写进工作流文件，分享出去就泄了
  keyWidget.value = "";
  M8.setStatus(node, "ok", `密钥已存 ${result.masked}`);
  M8.notify(`密钥已存到服务端（${result.masked}），输入框已清空`, {
    kind: "ok",
    hint: "以后这个节点留空就会自动用服务端这份，工作流文件里不会带明文",
    timeout: 5000,
  });
  app.graph?.setDirtyCanvas(true, true);
}

async function clearKey(node) {
  const provider = widgetValue(node, "provider");
  await M8.apiPost("/keys/set", { provider, apiKey: "" });
  M8.setStatus(node, "idle", "密钥已清除");
  M8.notify("服务端已存的密钥已清除", { kind: "warn" });
}

function setup(node) {
  M8.brand(node);
  M8.setStatus(node, "idle", "未配置");

  // ---- 思考过程显示框 ----------------------------------------------------
  const thinkingBox = ComfyWidgets["STRING"](node, "m8_thinking", ["STRING", { multiline: true }], app).widget;
  if (thinkingBox.inputEl) thinkingBox.inputEl.readOnly = true;
  thinkingBox.serialize = false;
  thinkingBox.serializeValue = async () => undefined;
  thinkingBox.value = "";
  M8.hideWidget(thinkingBox);

  // ---- 按钮 --------------------------------------------------------------
  const refreshWidget = M8.addButton(node, "刷新模型", async () => {
    await refreshModels(node);
  }, { tooltip: "用当前的地址和密钥向后端要一份模型列表，填进下面的下拉" });

  const saveKeyWidget = M8.addButton(node, "保存密钥到服务端", async () => {
    await saveKey(node);
  }, { tooltip: "存到 m8/data/credentials.json 并清空输入框 —— 这样分享工作流不会泄漏密钥" });

  const clearKeyWidget = M8.addButton(node, "清除服务端密钥", async () => {
    await clearKey(node);
  }, { tooltip: "删掉服务端存的那份密钥" });

  const thinkingToggle = M8.addButton(node, "思考过程", async () => {
    const hidden = !!thinkingBox.m8Hidden;
    if (hidden) {
      M8.showWidget(thinkingBox);
      if (!thinkingBox.value) thinkingBox.value = "（运行一次之后，模型的思考过程会显示在这里）";
    } else {
      M8.hideWidget(thinkingBox);
    }
    M8.relayout(node);
  }, { tooltip: "展开 / 收起模型的思考过程（只影响显示，不影响 text 输出）" });

  // **不重排 widget。**
  //
  // ComfyUI 的 widgets_values 按索引读写，而且存取规则不对称：存的时候跳过
  // serialize:false 的控件（就是上面这些按钮），读的时候一个都不跳。
  // 所以只要挪动了顺序，存进去的数组和读回来的位置就整体错位 ——
  // 表现是重启后 temperature 变成 NaN、max_tokens 变成 0。
  //
  // 按钮只能追加在末尾，这是节点上的固定顺序：先 INPUT_TYPES 里的参数，
  // 再前端加的按钮和只读框。不好看，但值不会错。

  // ---- 对话提示词框里的 / 补全 -------------------------------------------
  // 打一个 / 就弹出已上传的 skill，继续打字会收缩范围，重合部分高亮。
  // 选中后写进框里的是 /名字 —— 后端认得这个语法，会把那份 skill 一起注入。
  M8.attachMentionAutocomplete(node, "user_prompt", {
    getItems: async () => (await M8.apiGet("/skills/list")).skills,
  });

  // ---- 供应商联动 --------------------------------------------------------
  M8.onWidgetChange(node, "provider", async (value) => {
    const map = await loadProviders();
    const profile = map[value];
    if (!profile) return;
    const baseWidget = M8.findWidget(node, "base_url");
    // 只有当地址是空的、或还是别家的默认地址时才覆盖 —— 不覆盖用户手填的
    const known = Object.values(map).map((p) => p.defaultBaseUrl).filter(Boolean);
    if (baseWidget && (!baseWidget.value || known.includes(baseWidget.value))) {
      baseWidget.value = profile.defaultBaseUrl || "";
    }
    M8.setStatus(node, "idle", profile.label);
    app.graph?.setDirtyCanvas(true, true);
  });

  // ---- 初始化：看看服务端有没有存过密钥 -----------------------------------
  loadProviders().then((map) => {
    const provider = widgetValue(node, "provider");
    const label = map[provider]?.label || provider || "未选供应商";
    M8.apiGet("/keys/list")
      .then((result) => {
        const masked = result.keys?.[provider];
        if (masked) {
          M8.setStatus(node, "ok", `${label} · ${masked}`);
        } else {
          M8.setStatus(node, "idle", `${label} · 待填密钥`);
        }
      })
      .catch(() => M8.setStatus(node, "warn", "接口没响应"));
  });
}

/** 收到执行结果：填思考框、更新状态。 */
function applyResult(node, payload) {
  const thinkingBox = M8.findWidget(node, "m8_thinking");
  if (thinkingBox) {
    if (payload.thinking) {
      thinkingBox.value = payload.thinking;
      // 只有内容真的来了才自动弹出来 —— 免得空框占地方
      if (thinkingBox.m8Hidden && M8.findWidget(node, "show_thinking")?.value !== false) {
        M8.showWidget(thinkingBox);
        M8.relayout(node);
      }
    } else if (!thinkingBox.value) {
      thinkingBox.value = "（这次没有思考内容 —— 模型没输出，或开关关着）";
    }
  }

  const usage = payload.usage || {};
  const parts = [];
  if (usage.total_tokens) parts.push(`${usage.total_tokens} tok`);
  else if (payload.chars) parts.push(`${payload.chars} 字`);
  M8.setStatus(node, "ok", parts.join(" · ") || payload.model || "完成");
  M8.log("执行完成：", payload.model, usage);
}

// reorderWidgets 已经删掉了。
//
// 它的用途是让按钮贴着相关参数排，好看。代价是真金白银的：
// ComfyUI 的 widgets_values 按**索引**读写，而且存的时候跳过 serialize:false
// 的控件、读的时候一个都不跳。挪动控件顺序 => 存进去的数组和读回来的位置
// 对不上 => 值整体错位（temperature 变 NaN、max_tokens 变 0）。
//
// 真要调整控件顺序，就去改后端 INPUT_TYPES 里的字段顺序 —— 那才是契约。

app.registerExtension({
  name: "M8.M8LLMInference",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    // 执行结果走 prototype 挂 —— 实例上没有 prototype，这事只能在注册阶段做
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      // 后端回的是 {"ui": {"m8": {...}}}；ComfyUI 有时会把它包成数组，两种都接住
      const payload = Array.isArray(message?.m8) ? message.m8[0] : message?.m8;
      // 先看一眼后端 ui 到底被 ComfyUI 包成了什么形状，定位完模型名丢字段的问题就撤掉
      M8.log("ui 原始消息:", JSON.stringify(message)?.slice(0, 400));
      if (!payload) return;
      try {
        applyResult(this, payload);
      } catch (exc) {
        M8.error("处理执行结果失败：", exc);
      }
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        M8.error("大模型推理节点初始化失败：", exc);
      }
    };
  },
});
