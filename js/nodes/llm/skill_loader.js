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

/* 界面文案：代码里写英文，中文由 locales/zh/main.json 的 ui 段提供。 */
const T = M8.tFor(NODE_TYPE);

/* 和后端 m8/nodes/llm/skill_loader/node.py 里的 NO_SKILL 必须逐字一致 */
const NO_SKILL = "(no skill uploaded yet)";

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
    if (current.resourceCount) parts.push(T("resources", "{n} resources", { n: current.resourceCount }));
    M8.setStatus(node, "ok", parts.join(" · "));
  } else {
    M8.setStatus(node, "idle", names.length
      ? T("available", "{n} available", { n: names.length })
      : T("noSkills", "no skills yet"));
  }

  app.graph?.setDirtyCanvas(true, true);
}

async function doUpload(node, files) {
  if (!files.length) return;
  M8.setStatus(node, "busy", T("uploading", "Uploading {n} files...", { n: files.length }));
  const result = await M8.apiUpload("/skills/upload", files);
  const saved = result.skill;
  M8.notify(
    T("saved", "Saved {name}", { name: saved.name }),
    {
      kind: "ok",
      hint: T("savedHint", "{files} files / {size}, stored in m8/data/skills/{name}/",
        { files: saved.fileCount, size: saved.sizeText, name: saved.name }),
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
    M8.notify(T("pickFirst", "Pick a skill first"), { kind: "warn" });
    return;
  }

  const tree = await M8.apiGet("/skills/tree", { name });
  const resources = tree.resources || [];
  if (!resources.length) {
    M8.notify(T("textOnly", "{name} is a plain text pack with no attachments", { name }),
      { kind: "ok", timeout: 3000 });
    return;
  }

  const lines = [];
  if (tree.inlined?.length) {
    lines.push(T("inlined", "{n} will be inlined this run: {list}",
      { n: tree.inlined.length, list: tree.inlined.slice(0, 5).join(", ") }));
  }
  if (tree.skipped?.length) {
    lines.push(T("skipped", "{n} not expanded: {list}",
      { n: tree.skipped.length, list: tree.skipped.slice(0, 3).join(", ") }));
  }
  lines.push(T("totalFiles", "{n} attachments in total", { n: resources.length }));

  M8.notify(T("resourcesOf", "Contents of {name}", { name }),
    { kind: "info", hint: lines.join("; "), timeout: 9000 });
}

function setup(node) {
  M8.brand(node);
  M8.setStatus(node, "idle", T("loading", "Loading..."));

  const uploadFileWidget = M8.addButton(node, T("uploadSkill", "Upload skill"), async () => {
    await doUpload(node, await pickFiles());
  }, { tooltip: T("uploadSkillTip", "Pick a markdown file. It is wrapped into the folder layout automatically (main file named SKILL.md); add resources later any time.") });

  const uploadDirWidget = M8.addButton(node, T("uploadPack", "Upload whole pack"), async () => {
    await doUpload(node, await pickFiles({ directory: true }));
  }, { tooltip: T("uploadPackTip", "Pick a folder and references/ and scripts/ come along. The folder name becomes the skill name; it must contain SKILL.md.") });

  const refreshWidget = M8.addButton(node, T("refresh", "Refresh list"), async () => {
    M8.setStatus(node, "busy", T("refreshing", "Refreshing..."));
    const result = await M8.apiGet("/skills/list");
    applyList(node, result.skills);
    M8.notify(T("refreshed", "Skill list updated: {n}", { n: result.skills.length }),
      { kind: "ok", timeout: 2200 });
  }, { tooltip: T("refreshTip", "Re-read the list of uploaded skills.") });

  const infoWidget = M8.addButton(node, T("inventory", "Contents"), async () => {
    await showResources(node);
  }, { tooltip: T("inventoryTip", "See which attachments this pack carries and how many get inlined this run (shown in a notification, it does not take up node space).") });

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
      M8.setStatus(node, "warn", T("noEndpoint", "endpoint not responding"));
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
