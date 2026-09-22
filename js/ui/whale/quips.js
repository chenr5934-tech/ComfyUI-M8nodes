/* ============================================================================
 * M8 小鲸鱼 · 随机台词
 *
 * 点一下鲸鱼弹气泡看余额，再点一下气泡就换成一句台词 —— 原版的彩蛋。
 *
 * 台词内容和**权重**全部取自原项目 lib/index.js 的 RANDOM_GROUPS。
 * 注意：项目里那份规格文档写的是旧权重（20/7/7/3/1/1），代码里现在的值
 * 是 45/7/7/10/3/1 —— 以代码为准。
 *
 * 这个模块只负责「该显示什么」，渲染交给 whale.js ——
 * 它要用到挂件那边的资产路径，互相 import 会绕成环。
 * ==========================================================================*/

/** 三行样式：A=上行标签 / B=大号金额 / P=时段档 / C=下行小字。 */
const STYLE = { A: "label", B: "amount", P: "period", C: "hint" };

function center(style, text, color = "", wrap = false) {
  return [null, { t: text, s: style, c: color, w: wrap }, null];
}

function pickOne(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * 第一组（权重最高）：余额 + 时段 + 今日已用。
 *
 * 它其实是「正经信息」：峰谷那行按用户选的说法换词（默认 / 梁文峰谷 / !?强强?!），
 * 高峰红、空闲绿。所以这一组既是台词也是状态显示。
 */
function buildStatusLines(peak, labels, spentText) {
  return [
    { t: "当前时间段为:", s: "A", c: "" },
    { t: peak ? labels.on : labels.off, s: "P", c: peak ? "#e0433f" : "#2fa24c" },
    { t: spentText, s: "C", c: "" },
  ];
}

/**
 * 六组台词，按权重抽。数字是原代码里的 w。
 *
 * 后面几组带点私货（原作者的梗），但那本来就是这套挂件的性格 ——
 * 照搬是为了「以原项目为准」，不是我在编。
 */
export const RANDOM_GROUPS = [
  { w: 45, kind: "status" },
  { w: 7, kind: "lines", make: () => center("B", pickOne(["好模型... ↓", "好女孩...↓"])) },
  {
    w: 7,
    kind: "lines",
    make: () => center("A", pickOne([
      "不知道用户有什么用，先赶走吧~",
      "我...我...我也要挣钱吗？",
      "我去吃饭啦，测完叫我",
      "压力一只蓝色大肥鱼？！",
      "DeepSleep...",
      "坏了...用户彻底怒了！",
    ]), "", true),
  },
  { w: 10, kind: "gif" },
  {
    w: 3,
    kind: "lines",
    make: () => center("A", pickOne([
      "你目录里的dsh是什么...大烧货吗...?",
      "恭喜你实现token自由！token全跑了！",
      "真当我是便宜货啊...",
    ]), "", true),
  },
  { w: 1, kind: "lines", make: () => center("B", "哦鲸鲸... ") },
];

/** 加权抽一组。原版的抽法：先求总和，再一路减下去。 */
export function pickGroup() {
  const total = RANDOM_GROUPS.reduce((sum, item) => sum + item.w, 0);
  let roll = Math.random() * total;
  for (const item of RANDOM_GROUPS) {
    roll -= item.w;
    if (roll < 0) return item;
  }
  return RANDOM_GROUPS[RANDOM_GROUPS.length - 1];
}

/** gif 加载失败时的降级台词 —— 总比一个空白气泡强。 */
export function gifFallback() {
  return center("A", pickOne([
    "gif 加载失败了...",
    "今天没有动图给你看~",
    "呜呜 动图不见了...",
  ]), "", true);
}

export function styleClass(style) {
  return STYLE[style] || STYLE.A;
}

export { buildStatusLines };
