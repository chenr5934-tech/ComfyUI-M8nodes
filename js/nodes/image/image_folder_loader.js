/* ============================================================================
 * M8 · 图像文件夹加载 —— 前端
 *
 * 后端只认一个路径字符串。让用户手打 Windows 路径不现实，所以这儿补两样：
 *   浏览文件夹    走本机目录树挑一个目录，挑完顺手数一下这一层有几张图
 *   数一数        重数一遍（往里丢了几张、换了格式之后用）
 *
 * 为什么要先数：文件夹填错、指到空目录，是这类节点最常见的一次白跑 ——
 * 排进队列、跑完整个工作流，最后报一句「这个文件夹里没有图片」。
 * 在这儿点一下就看得见，不用等。
 *
 * **不重排 widget**（理由同 llm_inference.js）：widgets_values 按索引存取，
 * 挪顺序会让值整体错位。按钮只能追加在末尾。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8ImageFolderLoader";

/* 界面文案：中文直接写在代码里，locales/zh/main.json 的 ui 段是同一份副本。 */
const T = M8.tFor(NODE_TYPE);

M8.injectTheme();

/** 长路径会把状态栏撑爆，只留最后两段。 */
function shortPath(raw) {
  const parts = String(raw || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return String(raw || "");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : parts.join("/");
}

/** 状态栏摘要：挑的是哪、含不含子文件夹、这次取几张。 */
function summarize(node) {
  const path = String(M8.findWidget(node, "folder")?.value || "").trim();
  if (!path) {
    M8.setStatus(node, "idle", T("noFolder", "还没选文件夹"));
    return;
  }

  const bits = [shortPath(path)];
  if (M8.findWidget(node, "recursive")?.value) bits.push(T("recursive", "含子文件夹"));
  const count = Number(M8.findWidget(node, "limit")?.value) || 0;
  bits.push(count > 0 ? T("limited", "本次取 {n} 张", { n: count }) : T("allOf", "全部"));
  bits.push(T("walk", "逐张下发"));
  M8.setStatus(node, "ok", bits.join(" · "));
}

/**
 * 数这个目录直属有几张图（不递归 —— 递归要给整棵树走一遍，太重）。
 * 返回 -1 表示数不出来（路径不存在、没权限），此时状态栏已经把原因写着了。
 */
async function countImages(node, folder) {
  M8.setStatus(node, "busy", T("counting", "数图中…"));
  try {
    const resp = await M8.apiGet("/image/dirs", { path: folder, prefer: "input" });
    const total = Number(resp.count) || 0;
    const subs = (resp.dirs || []).length;
    if (total > 0) {
      M8.setStatus(node, "ok", T("counted", "{n} 张图 · {s} 个子文件夹", { n: total, s: subs }));
    } else {
      M8.setStatus(node, "warn", T("emptyHere", "这一层没有图片（子文件夹 {s} 个）", { s: subs }));
    }
    return total;
  } catch (exc) {
    M8.setStatus(node, "err", exc?.message || String(exc));
    M8.warn("数图失败：", exc);
    return -1;
  }
}

/**
 * 执行完的回报，只用来写状态栏。
 *
 * 逐张下发是 ComfyUI 自己做的：后端把图像输出成 list（表达式就是 `OUTPUT_IS_LIST`），
 * 引擎看到下游节点收到 list，就按项把它展开执行 N 次（execution.py 的
 * `_async_map_node_over_list`）。所以这里不用、也不该再去排队列 —— 排了反而会把
 * 用户的队列刷成 N 条。
 */
function applyResult(node, payload) {
  const count = Number(payload?.count) || 0;
  const total = Number(payload?.total) || 0;

  if (!count) {
    M8.setStatus(node, "warn", T("readNone", "这一批没读到图"));
    return;
  }

  M8.setStatus(node, "ok", T("readAll", "下发 {n} 张 · 共 {total} 张", {
    n: count,
    total,
  }));
}

function setup(node) {
  M8.brand(node);
  summarize(node);

  M8.addButton(node, T("browse", "浏览文件夹"), () => {
    const folder = M8.findWidget(node, "folder");
    M8.browseFolder({
      path: String(folder?.value || "").trim(),
      prefer: "input",
      onPick: (picked) => {
        if (folder) folder.value = picked;
        summarize(node);
        countImages(node, picked);
        app.graph?.setDirtyCanvas(true, true);
      },
    });
  }, {
    tooltip: T("browseTip", "从 ComfyUI 的 input 目录开始，可以顺着上一级一路走到硬盘根。挑完会数一下这一层有几张图"),
  });

  M8.addButton(node, T("check", "数一数"), async () => {
    const path = String(M8.findWidget(node, "folder")?.value || "").trim();
    if (!path) {
      M8.notify(T("pickFirst", "先选一个文件夹"), { kind: "warn" });
      return;
    }
    await countImages(node, path);
  }, {
    tooltip: T("checkTip", "只数这一层。想看整棵树有多少张，把「含子文件夹」打开跑一次，日志里会打印总数"),
  });

  // 换目录、开关递归、改张数，都跟着更新摘要
  M8.onWidgetChange(node, "folder", () => summarize(node));
  M8.onWidgetChange(node, "recursive", () => summarize(node));
  M8.onWidgetChange(node, "limit", () => summarize(node));
}

app.registerExtension({
  name: "M8.M8ImageFolderLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        M8.error("图像文件夹加载节点初始化失败：", exc);
      }
    };

    // 后端把「这一批是从第几张开始的、还有没有下一批」放在 ui.m8 里回报。
    // 存图节点用的是同一个 ui.m8 键，两个节点可能出现在同一条链上，所以按字段认领自己的回报。
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const list = Array.isArray(message?.m8) ? message.m8 : [message?.m8];
      const payload = list.find((item) => item && item.next !== undefined && item.total !== undefined);
      if (!payload) return;
      try {
        applyResult(this, payload);
      } catch (exc) {
        M8.error("读图结果回写状态栏失败", exc);
      }
    };
  },
});
