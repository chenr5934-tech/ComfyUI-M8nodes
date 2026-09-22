/* ============================================================================
 * M8 · Skill 装载 —— 前端
 *
 * 加了三样后端给不了的东西：
 *   上传 Skill    选单个 md 文件传上去（会自动包成目录式，主文件是 SKILL.md）
 *   上传整个包    选一个目录，连带 references/ scripts/ 一起搬过去
 *   刷新列表      重拉一遍已上传的 skill
 *
 * **节点上没有预览文本框**。要看 skill 写了什么，直接去 m8/data/skills/<名字>/
 * 打开那个目录 —— 那本来就是文件，用编辑器看比在节点上开个小窗强。
 * 节点上只留「它有多大、带了多少资源」这类一眼够用的信息，放在状态栏里。
 *
 * skill 是**目录**不是文件（见 docs/ARCHITECTURE.md），所以上传要能带资源。
 * 浏览器里选目录靠 input 的 webkitdirectory，读到的每个 File 都带
 * webkitRelativePath（形如 myskill/SKILL.md）—— 后端靠这个相对路径还原出结构。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8SkillLoader";

/* 和后端 m8/nodes/llm/skill_loader/node.py 里的 NO_SKILL 必须逐字一致 */
const NO_SKILL = "（还没有上传 skill）";

const FILE_ACCEPT = ".md,.markdown,.txt,.json,.yaml,.yml,.toml";

M8.injectTheme();

/**
 * 弹系统选择框。返回选中的 File 数组（取消则空数组）。
 *
 * directory=true 时选的是整个目录 —— 浏览器会把目录下所有文件都给你，
 * 每个都带 webkitRelativePath，那正是后端拼结构需要的东西。
 */
function pickFiles({ directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (directory) {
      input.webkitdirectory = true;
      input.directory = true;
    } else {
      input.accept = FILE_ACCEPT;
      input.multiple = true;
    }
    input.style.display = "none";
    document.body.appendChild(input);

    const finish = (files) => {
      input.remove();
      resolve(files || []);
    };

    input.addEventListener("change", () => finish([...input.files]));
    // 点取消时 change 不触发 —— 靠窗口重新获得焦点兜底，否则 Promise 永远悬着
    window.addEventListener(
      "focus",
      () => setTimeout(() => { if (document.body.contains(input)) finish([]); }, 400),
      { once: true },
    );

    input.click();
  });
}

/** 把列表写进下拉，并按需选中某一项。状态栏显示大小和资源数。 */
function applyList(node, items, select) {
  const widget = M8.findWidget(node, "skill");
  if (!widget) return;

  const names = (items || []).map((item) => item.name);
  M8.setComboOptions(widget, names.length ? names : [NO_SKILL]);

  if (select && names.includes(select)) {
    widget.value = select;
  }

  const current = (items || []).find((item) => item.name === widget.value);
  if (current) {
    const parts = [current.sizeText];
    if (current.resourceCount) parts.push(`${current.resourceCount} 个资源`);
    M8.setStatus(node, "ok", parts.join(" · "));
  } else {
    M8.setStatus(node, "idle", names.length ? `${names.length} 个可选` : "还没有 skill");
  }

  app.graph?.setDirtyCanvas(true, true);
}

async function doUpload(node, files) {
  if (!files.length) return;
  M8.setStatus(node, "busy", `上传 ${files.length} 个文件…`);
  const result = await M8.apiUpload("/skills/upload", files);
  const saved = result.skill;
  M8.notify(
    `已保存 ${saved.name}`,
    {
      kind: "ok",
      hint: `${saved.fileCount} 个文件 / ${saved.sizeText}，存在 m8/data/skills/${saved.name}/`,
      timeout: 5000,
    },
  );
  applyList(node, result.skills, saved.name);
}

/** 点一下看这个包带了什么。信息走通知，不占节点的地方。 */
async function showResources(node) {
  const widget = M8.findWidget(node, "skill");
  const name = widget?.value;
  if (!name || name === NO_SKILL) {
    M8.notify("还没选 skill", { kind: "warn" });
    return;
  }

  const tree = await M8.apiGet("/skills/tree", { name });
  const resources = tree.resources || [];
  if (!resources.length) {
    M8.notify(`${name} 是个纯文本包，没有附属文件`, { kind: "ok", timeout: 3000 });
    return;
  }

  const lines = [];
  if (tree.inlined?.length) {
    lines.push(`本次会内联 ${tree.inlined.length} 个：${tree.inlined.slice(0, 5).join("、")}`);
  }
  if (tree.skipped?.length) {
    lines.push(`${tree.skipped.length} 个未展开：${tree.skipped.slice(0, 3).join("、")}`);
  }
  lines.push(`共 ${resources.length} 个附属文件`);

  M8.notify(`${name} 的资源`, { kind: "info", hint: lines.join("；"), timeout: 9000 });
}

function setup(node) {
  M8.brand(node);
  M8.setStatus(node, "idle", "加载中…");

  const uploadFileWidget = M8.addButton(node, "上传 Skill", async () => {
    await doUpload(node, await pickFiles());
  }, { tooltip: "选一个 md 文件。会自动包成目录式（主文件叫 SKILL.md），以后要加资源随时补" });

  const uploadDirWidget = M8.addButton(node, "上传整个包", async () => {
    await doUpload(node, await pickFiles({ directory: true }));
  }, { tooltip: "选一个目录，连带 references/ scripts/ 一起搬过来。目录名就是 skill 名，里面要有 SKILL.md" });

  const refreshWidget = M8.addButton(node, "刷新列表", async () => {
    M8.setStatus(node, "busy", "刷新中…");
    const result = await M8.apiGet("/skills/list");
    applyList(node, result.skills);
    M8.notify(`skill 列表已更新：${result.skills.length} 个`, { kind: "ok", timeout: 2200 });
  }, { tooltip: "重新读一遍已上传的 skill 列表" });

  const infoWidget = M8.addButton(node, "资源清单", async () => {
    await showResources(node);
  }, { tooltip: "看这个包带了哪些附属文件、本次会内联几个（显示在通知里，不占节点的地方）" });

  // **不重排 widget**（理由见 llm_inference.js 里那段注释）：
  // widgets_values 按索引存取，且存的跳过 serialize:false、读的不跳，
  // 挪动顺序会让值整体错位。按钮只能追加在末尾。

  // 换 skill 时顺手更新状态栏（失败只记日志，不该挡着人画图）
  M8.onWidgetChange(node, "skill", () => {
    M8.apiGet("/skills/list")
      .then((result) => applyList(node, result.skills))
      .catch(() => {});
  });

  // 首次静默拉列表。这里失败不打扰用户 —— 接口没起来也不该挡着画图。
  M8.apiGet("/skills/list")
    .then((result) => {
      applyList(node, result.skills);
      M8.log(`skill 列表：${result.skills.length} 个`);
    })
    .catch((exc) => {
      M8.warn("首次拉 skill 列表失败：", exc.message);
      M8.setStatus(node, "warn", "接口没响应");
    });
}

// reorderWidgets 已经删掉了：ComfyUI 的 widgets_values 按索引存取，
// 挪动控件顺序会让存进去的值和读回来的位置整体错位。
// 真要调整控件顺序，就去改后端 INPUT_TYPES 里的字段顺序 —— 那是契约。

app.registerExtension({
  name: "M8.M8SkillLoader",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      try {
        setup(this);
      } catch (exc) {
        M8.error("Skill 装载节点初始化失败：", exc);
      }
    };
  },
});
