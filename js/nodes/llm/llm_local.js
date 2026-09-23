/* ============================================================================
 * M8 · 本地大模型推理 —— 前端
 *
 * 加的东西：
 *   刷新模型     重扫 models/LLM，把 GGUF 填进主模型下拉（模型是用户后放进去的，
 *                节点建好时那个目录可能还是空的）
 *   自动配 mmproj 换主模型时自动挑配套的多模态投影文件
 *
 * 不做的事：密钥、供应商联动 —— 那些是远程那个节点的东西，本地推理用不着。
 * ==========================================================================*/

import { app } from "/scripts/app.js";
import * as M8 from "../../m8_core.js";

const NODE_TYPE = "M8LLMLocal";

/* 界面文案：代码里只写英文（ComfyUI 审核的硬要求），中文由 locales/zh/main.json
   的 ui 段提供，取不到就用这里写的英文原文。见 m8_core.js 的 t()。 */
const T = M8.tFor(NODE_TYPE);
/* 和后端 m8/nodes/llm/llm_local/node.py 里的两个常量必须逐字一致 */
const PLACEHOLDER = "(no .gguf in models/LLM yet)";
const NO_MMPROJ = "(none, text only)";

M8.injectTheme();

/* 模型列表是后端扫目录得来的，前端只缓存一份。
   拉不到也不影响 —— 下拉里保留原来的值，照样能选已有模型。 */
let cache = null;

async function fetchList(force) {
  if (cache && !force) return cache;
  try {
    cache = await M8.apiGet("/llm-local/models");
  } catch (exc) {
    M8.warn("拉本地模型列表失败：", exc.message);
    cache = null;
  }
  return cache;
}

function findWidget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}

/* 下拉的取值在 ComfyUI 里就是个数组，直接换掉内容再让画布重画就行 */
function setOptions(widget, values, keep) {
  if (!widget) return;
  const old = widget.options && widget.options.values ? widget.options.values : [];
  const next = values.length ? values : [PLACEHOLDER];
  widget.options = widget.options || {};
  widget.options.values = next;
  if (keep && next.indexOf(widget.value) >= 0) return;
  widget.value = next[0];
}

/* 后端给的是 Windows 相对路径（qwen3.5-9b\mmproj-x.gguf），这里统一成 /
   分隔来比较，两种分隔符都吃。 */
function normPath(s) { return String(s == null ? "" : s).replace(/\\/g, "/"); }
function dirOf(s) {
  const t = normPath(s);
  const i = t.lastIndexOf("/");
  return i < 0 ? "" : t.slice(0, i).toLowerCase();
}
function baseOf(s) {
  const t = normPath(s);
  const i = t.lastIndexOf("/");
  return (i < 0 ? t : t.slice(i + 1)).toLowerCase().replace(/\.gguf$/, "");
}

/* 参数规模：9b / 4b / 1.5b。同系列不同大小的 mmproj 名字几乎一模一样，只有这个
   数字分得开，所以要单独放行 —— 9b 只有两字符，会被下面的长度下限滤掉。 */
const SIZE_RE = /^\d+(?:\.\d+)?b$/;

/* 按名字给主模型配一个 mmproj。规则和 backend 的 pick_mmproj 一致，改一边要改另一边：
     1. 同目录优先  2. 特征词 + 规模数字最多那个  3. 候选只剩一个就用它  4. 配不上就不配 */
function autoPickMmproj(modelName, mmprojs) {
  if (!mmprojs || !mmprojs.length) return NO_MMPROJ;

  const same = mmprojs.filter((c) => dirOf(c) === dirOf(modelName));
  const pool = same.length ? same : mmprojs;
  if (pool.length === 1) return pool[0];

  const words = baseOf(modelName).split(/[-_. ]+/).filter((w) =>
    w && ((w.length >= 3 && !/^\d+$/.test(w)) || SIZE_RE.test(w)));
  let best = "", bestScore = 0;
  for (const c of pool) {
    const low = baseOf(c);
    const score = words.filter((w) => low.indexOf(w) >= 0).length;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return best || NO_MMPROJ;
}

function hookNode(node) {
  if (!node || node.__m8LocalHooked) return;
  node.__m8LocalHooked = true;

  const modelW = findWidget(node, "model");
  const mmW = findWidget(node, "mmproj");
  const gpuW = findWidget(node, "gpu_layers");
  if (!modelW) return;

  /* 刷新按钮用 m8_core 里那个 addButton —— 它自带防重入和错误弹窗，
     还知道按钮不该写进工作流。自己调 addWidget 这些都得手写一遍。 */
  M8.addButton(node, T("refreshModels", "Refresh models"), async () => {
    const data = await fetchList(true);
    if (!data) throw new Error(T("noResponse", "No response from the backend; is ComfyUI running?"));
    setOptions(modelW, data.models || [], true);
    setOptions(mmW, [NO_MMPROJ].concat(data.mmproj || []), true);
    if (data.gpu === false && gpuW) {
      M8.warn(T("noGpu", "This llama-cpp-python has no GPU support, so "
        + "inference will run on the CPU. Install a CUDA build of the wheel to use the GPU."));
    }
    app.graph.setDirtyCanvas(true, true);
  });

  /* 换主模型时自动配 mmproj */
  const orig = modelW.callback;
  modelW.callback = function (value, ...rest) {
    if (typeof orig === "function") orig.call(this, value, ...rest);
    const mm = cache && cache.mmproj ? cache.mmproj : [];
    if (mmW && mm.length && mmW.value === NO_MMPROJ) {
      mmW.value = autoPickMmproj(value, mm);
      app.graph.setDirtyCanvas(true, true);
    }
  };

  /* 节点第一次上画布时把真实列表填进去（建节点时目录可能还是空的） */
  fetchList(false).then((data) => {
    if (!data) return;
    setOptions(modelW, data.models || [], true);
    setOptions(mmW, [NO_MMPROJ].concat(data.mmproj || []), true);
    app.graph.setDirtyCanvas(true, true);
  });
}

app.registerExtension({
  name: "M8.LLMLocal",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      hookNode(this);
      return r;
    };
  },
});
