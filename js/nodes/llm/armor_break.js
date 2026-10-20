/* ============================================================================
 * M8 · 破甲注入 —— 前端
 *
 * 加的东西：
 *   注入内容     折叠式只读框，显示当前真正会发出去的那段文本
 *   灌入预设     把当前档位 + 场景的原文填进「text」框，之后就在框里改
 *   恢复预设     清空「text」框，改回按档位拼
 *
 * **正文只能有一份。** 文案库在 m8/nodes/llm/armor_break/prompts.py，前端一个字
 * 都不抄 —— 抄了就是两份真相，改词要改两处，而且迟早对不上。
 * 所以「灌入预设」和「注入内容」都向后端要原文（GET /m8/armor/preset）。
 * 接口没起来时这两个按钮会报「接口没响应」，但节点照常能用：
 * 选档位走预设这条路完全不经过前端。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import { ComfyWidgets } from "/scripts/widgets.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8ArmorBreak";

const T = M8.tFor(NODE_TYPE);

M8.injectTheme();

function textOf(node, name) {
  return M8.findWidget(node, name)?.value || "";
}

/** setStatus 每次都重绘整个画布，所以同一个状态不重复刷。 */
function setBody(node, text) {
  if (node.m8ArmorNote === text) return;
  node.m8ArmorNote = text;
  M8.setStatus(node, "idle", text);
}

/** 逐字符回调的控件用它，避免边打字边重绘。 */
function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

/** 状态栏一句话：档位 · 场景，正文被改过时再挂一个「自定义」。 */
function describe(node) {
  // 只拼档位和场景的**取值**，不加装饰词 —— 它们本身就是下拉里的中文，
  // 过一层翻译反而会变成「档位：通用」这种和下拉对不上的说法。
  const level = M8.findWidget(node, "level")?.value;
  const scene = M8.findWidget(node, "scene")?.value;
  const base = [level, scene].filter(Boolean).join(" · ") || T("notReady", "还没选档位");

  const custom = textOf(node, "body").trim();
  return custom ? base + " · " + T("custom", "自定义 {n} 字", { n: custom.length }) : base;
}

/** 向后端要当前档位 + 场景的预设正文。 */
function fetchPreset(node) {
  return M8.apiGet("/armor/preset", {
    level: M8.findWidget(node, "level")?.value || "",
    scene: M8.findWidget(node, "scene")?.value || "",
  });
}

/** 当前真正会发出去的那段：改了正文就取正文，没改就取预设。 */
async function effectiveText(node) {
  const custom = textOf(node, "body").trim();
  if (custom) return custom;
  return (await fetchPreset(node)).text;
}

function setup(node) {
  M8.brand(node);

  // 控件标签：ComfyUI 渲染时取 widget.label ?? widget.name，所以设 label 就能把
  // body / extra 这种英文 key 换成看得懂的中文。**只设 label，不动顺序** ——
  // widgets_values 按索引存取，挪位置会让已保存的工作流值错位。
  // 顺序本身由后端的 INPUT_TYPES 决定：档位 → 场景 → 启用 → 正文 → 补充。
  const LABELS = {
    level: T("labelLevel", "强度档位"),
    scene: T("labelScene", "输出场景"),
    enabled: T("labelEnabled", "启用"),
    body: T("labelBody", "破甲正文"),
    extra: T("labelExtra", "补充指令"),
  };
  for (const [name, label] of Object.entries(LABELS)) {
    const widget = M8.findWidget(node, name);
    if (widget) widget.label = label;
  }

  M8.setStatus(node, "idle", describe(node));

  // ---- 注入内容只读框 ----------------------------------------------------
  const preview = ComfyWidgets["STRING"](node, "m8_armor_preview", ["STRING", { multiline: true }], app).widget;
  if (preview.inputEl) preview.inputEl.readOnly = true;
  preview.serialize = false;
  preview.serializeValue = async () => undefined;
  preview.value = T("previewPlaceholder", "（点这个按钮看当前会注入的文本）");
  M8.hideWidget(preview);

  const toggle = M8.addButton(node, T("preview", "注入内容"), async () => {
    if (!preview.m8Hidden) {
      M8.hideWidget(preview);
      M8.relayout(node);
      return;
    }
    try {
      preview.value = await effectiveText(node);
    } catch (exc) {
      preview.value = T("presetFailed", "取不到预设正文：{msg}", { msg: exc.message });
    }
    M8.showWidget(preview);
    M8.relayout(node);
  }, { tooltip: T("previewTip", "看当前会注入的文本。改了正文就显示改过的，没改就显示档位预设") });

  const fill = M8.addButton(node, T("fillPreset", "灌入预设"), async () => {
    const widget = M8.findWidget(node, "body");
    if (!widget) return;
    const had = (widget.value || "").trim();

    let result;
    try {
      result = await fetchPreset(node);
    } catch (exc) {
      M8.setStatus(node, "warn", T("noEndpoint", "接口没响应"));
      M8.notify(T("presetFailed", "取不到预设正文：{msg}", { msg: exc.message }), { kind: "warn" });
      return;
    }

    widget.value = result.text;
    if (!preview.m8Hidden) preview.value = result.text;
    M8.setStatus(node, "idle", describe(node));
    M8.notify(
      T("filled", "已把 {level} / {scene} 的正文填进正文框", { level: result.level, scene: result.scene }),
      {
        kind: "ok",
        hint: had
          ? T("filledOverwrote", "原来的内容被覆盖了。点「恢复预设」可以把正文框清空重来")
          : T("filledHint", "现在直接改框里的字就行 —— 改了之后这一档就以你的版本为准"),
        timeout: 6000,
      },
    );
    app.graph?.setDirtyCanvas(true, true);
  }, { tooltip: T("fillPresetTip", "把当前档位和场景的原文填进「text」框，然后随便改。不填就一直用预设") });

  const restore = M8.addButton(node, T("restore", "恢复预设"), async () => {
    const widget = M8.findWidget(node, "body");
    if (!widget) return;
    if (!(widget.value || "").trim()) {
      M8.notify(T("alreadyPreset", "正文框本来就是空的，走的已经是预设"), { kind: "info", timeout: 2800 });
      return;
    }
    widget.value = "";
    if (!preview.m8Hidden) preview.value = T("cleared", "已清空，改回按档位和场景拼");
    M8.setStatus(node, "idle", describe(node));
    M8.notify(T("resetDone", "正文已清空，重新按档位和场景拼"), { kind: "ok", timeout: 3000 });
    app.graph?.setDirtyCanvas(true, true);
  }, { tooltip: T("restoreTip", "清空「text」框，回到按档位和场景拼正文") });

  // 按钮只能追加在末尾，不许重排 widget：widgets_values 按索引存取，
  // 存的时候跳过 serialize:false、读的时候一个都不跳，挪顺序会让值整体错位。
  // 完整理由见 llm_inference.js 里那段注释。

  // 状态栏刷新分两档：
  //   下拉（档位 / 场景）是点选，变化不频繁，即时刷新；
  //   两个文本框是逐字符回调的，而 setStatus 内部每次都 setDirtyCanvas(true, true)
  //   全画布重绘 —— 上千字的正文边打边刷会明显卡。所以给它们套一层防抖。
  const refreshNow = () => setBody(node, describe(node));
  const refreshSoon = debounce(refreshNow, 260);

  for (const name of ["level", "scene"]) {
    M8.onWidgetChange(node, name, refreshNow);
  }
  for (const name of ["body", "extra"]) {
    M8.onWidgetChange(node, name, refreshSoon);
  }
}

function applyResult(node, payload) {
  const preview = M8.findWidget(node, "m8_armor_preview");
  // 用 in 判断而不是真值判断：档位选「关」时后端会回一个空串 preview，
  // 那也得把框清掉，否则上一次的正文会一直留在上面。
  if (preview && payload && "preview" in payload) {
    preview.value = payload.preview || T("previewEmpty", "（这次没有注入内容）");
  }

  if (payload?.chars) {
    M8.setStatus(node, "ok", describe(node) + " · " + T("charsUnit", "{n} 字", { n: payload.chars }));
  } else {
    M8.setStatus(node, "idle", describe(node) + " · " + T("empty", "没有注入"));
  }
}

app.registerExtension({
  name: "M8.M8ArmorBreak",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      // ComfyUI 有时把 ui 载荷包成数组，两种形状都接住
      const payload = Array.isArray(message?.m8) ? message.m8[0] : message?.m8;
      if (!payload) return;
      try {
        applyResult(this, payload);
      } catch (exc) {
        M8.error("处理破甲结果失败：", exc);
      }
    };

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        M8.error("破甲注入节点初始化失败：", exc);
      }
    };
  },
});
