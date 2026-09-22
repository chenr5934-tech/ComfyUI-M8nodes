/* ============================================================================
 * M8 小鲸鱼 · 画布桥接
 *
 * 两件事：
 *   1. 把画布拍成快照发给后端 —— 模型要有节点编号和参数名才敢改东西
 *   2. 执行模型要求的工具 —— 读队列、改参数、排队、停任务
 *
 * 为什么工具在前端跑：这些能力只存在于浏览器这边。后端拿不到 app.graph，
 * 也没有 ComfyUI 的 api 对象。硬搬过去就得自己解析工作流、绕过 ComfyUI
 * 自己的校验，最后还会因为版本差异到处裂。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import * as M8 from "../../m8_core.js";

const MAX_NODES = 60;
const MAX_WIDGETS = 16;
const MAX_VALUE_CHARS = 300;

/** 拍一张画布快照。给模型看的，所以要克制体积：节点和参数都截断。 */
export function snapshotCanvas() {
  const graph = app.graph;
  const nodes = [];
  const selected = [];

  for (const node of graph?._nodes || []) {
    if (nodes.length >= MAX_NODES) break;
    if (node.mode === 4) continue;   // 4 = 已静音，模型看不到也没意义

    const widgets = [];
    for (const widget of node.widgets || []) {
      if (widgets.length >= MAX_WIDGETS) break;
      if (!widget.name || widget.serialize === false) continue;
      const value = widget.value;
      // 只发标量。数组和对象（比如 batch 里的张量）发过去只会撑爆上下文
      if (value === null || value === undefined) continue;
      if (typeof value === "object") continue;
      widgets.push({ name: widget.name, value: String(value).slice(0, MAX_VALUE_CHARS) });
    }

    nodes.push({
      id: node.id,
      type: node.type,
      title: node.title || "",
      widgets,
    });
    if (node.is_selected) selected.push(node.id);
  }

  return { nodes, selected, count: (graph?._nodes || []).length };
}

/* ---------------------------------------------------------------- 工具实现 */

const HANDLERS = {
  async get_queue() {
    const res = await api.fetchApi("/queue");
    const data = await res.json();
    const running = data.queue_running || [];
    const pending = data.queue_pending || [];
    const lines = [`正在跑 ${running.length} 个，排队 ${pending.length} 个`];
    for (const item of [...running, ...pending].slice(0, 8)) {
      // 队列项是数组：[number, prompt_id, prompt, extra, outputs]
      const number = Array.isArray(item) ? item[0] : "?";
      const id = Array.isArray(item) ? item[1] : "?";
      lines.push(`- #${number}（${String(id).slice(0, 8)}）`);
    }
    return lines.join("\n");
  },

  async interrupt() {
    await api.fetchApi("/interrupt", { method: "POST" });
    return "已发送中断请求，正在跑的任务会停下。";
  },

  async clear_queue() {
    await api.fetchApi("/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    return "等待中的队列已清空（正在跑的不受影响）。";
  },

  async set_node_widget({ node_id, widget, value } = {}) {
    const node = app.graph?.getNodeById?.(node_id) || (app.graph?._nodes || []).find((n) => n.id === node_id);
    if (!node) return `找不到编号为 ${node_id} 的节点。`;

    const target = (node.widgets || []).find((w) => w.name === widget);
    if (!target) {
      const names = (node.widgets || []).map((w) => w.name).filter(Boolean).join("、");
      return `节点 #${node_id} 上没有叫 ${widget} 的参数。它有的是：${names || "（没有参数）"}`;
    }

    const before = target.value;
    target.value = value;
    // 通知 ComfyUI 值变了：有的节点靠回调联动（比如 Model/LoRA 的联动下拉）
    try {
      target.callback?.(value, app.canvas, node, [0, 0], null);
    } catch (exc) {
      M8.warn("参数回调抛了异常，值已经改上了：", exc);
    }
    app.graph.setDirtyCanvas(true, true);

    return `已把节点 #${node_id} 的 ${widget} 从「${String(before).slice(0, 60)}」改成「${String(value).slice(0, 60)}」。`;
  },

  async list_loras() {
    const data = await M8.apiGet("/whale/loras");
    if (!data.count) return "这台机器上没有装 LoRA（models/loras 目录是空的）。";

    // LoRA 目录动辄上百个，全塞进上下文不划算。列一截，并说清还有多少 ——
    // 模型知道自己没看全，才会在需要时说「我看到的只是前 N 个」。
    const MAX = 120;
    const shown = data.loras.slice(0, MAX);
    const tail = data.count > MAX ? `\n（还有 ${data.count - MAX} 个没列出来，需要的话让用户说个关键词）` : "";
    return `共 ${data.count} 个 LoRA：\n${shown.join("\n")}${tail}`;
  },

  async get_recent_errors() {
    const res = await api.fetchApi("/history");
    const history = await res.json();

    const failures = [];
    for (const [promptId, item] of Object.entries(history || {})) {
      const status = item?.status;
      if (!status || status.status_str === "success") continue;
      for (const entry of status.messages || []) {
        if (!Array.isArray(entry) || entry[0] !== "execution_error") continue;
        const payload = entry[1] || {};
        failures.push({
          promptId,
          nodeId: payload.node_id,
          nodeType: payload.node_type,
          message: payload.exception_message || "",
          type: payload.exception_type || "",
          traceback: (payload.traceback || []).slice(-4).join("\n"),
        });
      }
    }

    if (!failures.length) {
      // 说清楚查的是哪儿 —— 「没报错」和「没查到」是两件事
      return "最近的任务记录里没有失败。如果刚看到报错，可能是它发生在更早的记录里，或者已经被清掉了。";
    }

    const recent = failures.slice(-5);
    const lines = [`找到 ${recent.length} 条失败记录（最近的排后面）：`];
    for (const item of recent) {
      lines.push("");
      lines.push(`- 任务 ${String(item.promptId).slice(0, 8)}`);
      if (item.nodeType) lines.push(`  节点：${item.nodeType}${item.nodeId != null ? " (#" + item.nodeId + ")" : ""}`);
      if (item.type) lines.push(`  异常类型：${item.type}`);
      if (item.message) lines.push(`  信息：${String(item.message).slice(0, 400)}`);
      if (item.traceback) lines.push(`  末尾堆栈：\n${String(item.traceback).slice(0, 700)}`);
    }
    return lines.join("\n");
  },

  async queue_prompt() {
    // 用 ComfyUI 自己的提交路径：参数校验、缺模型提示、错误弹窗全都照旧生效。
    // 绕过去自己 POST /prompt 的话，这些保护就都没了。
    await app.queuePrompt(0, 1);
    return "已提交排队。";
  },
};

/** 工具在界面上显示的名字。 */
export const TOOL_LABELS = {
  get_queue: "看队列",
  interrupt: "中断任务",
  clear_queue: "清空队列",
  set_node_widget: "改参数",
  queue_prompt: "提交排队",
  list_loras: "翻 LoRA",
  get_recent_errors: "查报错",
};

/** 会改变状态、值得在对话里留痕的工具。 */
const MUTATING = new Set(["interrupt", "clear_queue", "set_node_widget", "queue_prompt"]);

/**
 * 执行一次工具调用。
 *
 * 返回给模型看的文本结果。失败不抛 —— 把错误原文交给模型，
 * 它自己会决定是换参数重试还是告诉用户做不到。
 */
export async function runToolCall(call) {
  const name = call?.function?.name;
  const handler = HANDLERS[name];
  if (!handler) return `没有叫 ${name} 的工具。`;

  let args = {};
  const rawArgs = call.function?.arguments;
  if (typeof rawArgs === "string" && rawArgs.trim()) {
    try {
      args = JSON.parse(rawArgs);
    } catch {
      return `工具参数不是合法 JSON：${String(rawArgs).slice(0, 200)}`;
    }
  } else if (rawArgs && typeof rawArgs === "object") {
    args = rawArgs;
  }

  try {
    return await handler(args);
  } catch (exc) {
    M8.warn(`工具 ${name} 执行失败：`, exc);
    return `执行失败：${exc?.message || exc}`;
  }
}

// isMutating 删掉了：写的时候想用它区分「会改状态的工具」，
// 但真正需要区分的地方（工具描述、对话里的留痕）各有各的判断，
// 没人调它。留着是误导。
