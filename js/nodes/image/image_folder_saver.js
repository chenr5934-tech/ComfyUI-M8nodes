/* ============================================================================
 * M8 · 文件夹存图 —— 前端
 *
 * 后端只认一个目标路径。没有目标目录就建 —— 但"建在哪"得让用户看见，
 * 所以这儿补三样：
 *   浏览目标文件夹  从 ComfyUI 的 output 目录开始挑（保存节点写在那儿才带预览）
 *   这个目录里有什么 数一下已有的图，覆盖前心里有数
 *   存完的回报       onExecuted 读 ui.m8，把"存了几张、存到哪"写回状态栏
 *
 * **不重排 widget**（理由同 llm_inference.js）：widgets_values 按索引存取，
 * 挪顺序会让值整体错位。按钮只能追加在末尾。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8ImageFolderSaver";

/* 界面文案：中文直接写在代码里，locales/zh/main.json 的 ui 段是同一份副本。 */
const T = M8.tFor(NODE_TYPE);

M8.injectTheme();

/** 长路径会把状态栏撑爆，只留最后两段。 */
function shortPath(raw) {
  const parts = String(raw || "").split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return String(raw || "");
  return parts.length > 2 ? ".../" + parts.slice(-2).join("/") : parts.join("/");
}

/** 状态栏摘要：存哪、什么格式、会不会覆盖。 */
function summarize(node) {
  const path = String(M8.findWidget(node, "output_folder")?.value || "").trim();
  const format = String(M8.findWidget(node, "format")?.value || "PNG");
  const overwrite = Boolean(M8.findWidget(node, "overwrite")?.value);
  const keep = Boolean(M8.findWidget(node, "keep_structure")?.value);

  if (!path) {
    M8.setStatus(node, "idle", T("noFolder", "还没定目标文件夹"));
    return;
  }

  const bits = [shortPath(path), format];
  if (!keep) bits.push(T("flat", "不保留子目录"));
  bits.push(overwrite ? T("overwrite", "同名覆盖") : T("addSuffix", "同名加序号"));
  M8.setStatus(node, "ok", bits.join(" · "));
}

/** 数一下目标目录里已经有多少张图。 */
async function countImages(node, folder) {
  M8.setStatus(node, "busy", T("counting", "数图中…"));
  try {
    const resp = await M8.apiGet("/image/dirs", { path: folder, prefer: "output" });
    const total = Number(resp.count) || 0;
    if (total > 0) {
      M8.setStatus(node, "warn", T("hasImages", "这个目录里已有 {n} 张图", { n: total }));
      M8.notify(T("hasImagesTitle", "目标目录不是空的"), {
        kind: "warn",
        hint: T("hasImagesHint", "已有 {n} 张图。没勾「同名覆盖」时会自动加序号，不会盖掉它们", { n: total }),
        timeout: 6000,
      });
    } else {
      M8.setStatus(node, "ok", T("emptyHere", "目录是空的（或还没建）"));
    }
    return total;
  } catch (exc) {
    // 目录还不存在是正常情况 —— 保存时会现建，不该按错误处理
    M8.setStatus(node, "warn", exc?.message || String(exc));
    M8.warn("数图失败：", exc);
    return -1;
  }
}

/** 执行完的回报：后端把摘要塞在 ui.m8 里（ComfyUI 有时包成数组，两种都接住）。 */
function applyResult(node, payload) {
  const saved = Number(payload?.saved) || 0;
  const folder = String(payload?.folder || "");
  const previews = Number(payload?.previews) || 0;

  if (!saved) {
    M8.setStatus(node, "warn", T("savedNone", "这次没有图可存"));
    return;
  }

  const bits = [T("saved", "存了 {n} 张", { n: saved })];
  if (folder) bits.push(shortPath(folder));
  if (previews < saved) bits.push(T("noPreview", "{n} 张不在 output 里，没预览", { n: saved - previews }));
  M8.setStatus(node, "ok", bits.join(" · "));
}

function setup(node) {
  M8.brand(node);
  summarize(node);

  M8.addButton(node, T("browse", "浏览目标文件夹"), () => {
    const widget = M8.findWidget(node, "output_folder");
    M8.browseFolder({
      path: String(widget?.value || "").trim(),
      prefer: "output",
      onPick: (picked) => {
        if (widget) widget.value = picked;
        summarize(node);
        app.graph?.setDirtyCanvas(true, true);
      },
    });
  }, {
    tooltip: T("browseTip", "从 ComfyUI 的 output 目录开始挑。挑不到想要的目录就直接填路径 —— 想建在哪就在哪个已存在的目录下面写名字，保存时会现建"),
  });

  M8.addButton(node, T("inspect", "目录里有什么"), async () => {
    const path = String(M8.findWidget(node, "output_folder")?.value || "").trim();
    if (!path) {
      M8.notify(T("pickFirst", "先定一个目标文件夹"), { kind: "warn" });
      return;
    }
    await countImages(node, path);
  }, {
    tooltip: T("inspectTip", "数一下这个目录里已经有多少张图。没勾「同名覆盖」时不会盖掉它们，只是让你先知道有多少"),
  });

  // 换目录、改格式、开关覆盖/保留结构，都跟着更新摘要
  M8.onWidgetChange(node, "output_folder", () => summarize(node));
  M8.onWidgetChange(node, "format", () => summarize(node));
  M8.onWidgetChange(node, "overwrite", () => summarize(node));
  M8.onWidgetChange(node, "keep_structure", () => summarize(node));
}

app.registerExtension({
  name: "M8.M8ImageFolderSaver",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        M8.error("文件夹存图节点初始化失败：", exc);
      }
    };

    // 执行结果走 prototype 挂 —— 实例上没有 prototype，这事只能在注册阶段做
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      // 读图节点用的是同一个 ui.m8 键，两个节点可能出现在同一条链上，所以按字段认领自己的回报。
      const list = Array.isArray(message?.m8) ? message.m8 : [message?.m8];
      const payload = list.find((item) => item && item.saved !== undefined);
      if (!payload) return;
      try {
        applyResult(this, payload);
      } catch (exc) {
        M8.error("处理保存结果失败：", exc);
      }
    };
  },
});
