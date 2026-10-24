# M8 · 代码规范

> 风格上不折腾，只有几条硬要求。第一条是目录约定，它比风格重要得多。

---

## 目录约定：一个功能一个文件夹

```
m8/nodes/<货架>/                 货架：按「在工作流里干的活」划分
├── __init__.py                  货架收集器：扫下面的功能文件夹，不含任何节点代码
└── <功能>/                       功能：一个节点一个文件夹
    ├── __init__.py              注册出口：只导出本功能自己的 MAPPING
    └── node.py                  节点实现

js/nodes/<货架>/<功能>.js         前端增强：文件名和功能文件夹逐字一致
```

**六条规矩，前五条有测试守着：**

0. **前端永远不许改 `node.widgets` 的顺序。**
   ComfyUI 的 `widgets_values` 是按**索引**读写的数组，而且两边规则不对称：
   存的时候跳过 `serialize:false` 的控件（前端加的按钮、只读框），读的时候一个都不跳。
   只要挪动过顺序，存进去的数组和读回来的位置就对不上，节点上的值会整体错位
   （报过：温度变 NaN、max_tokens 变 0）。
   想让控件按某个顺序排，就去改后端 `INPUT_TYPES` 的字段顺序 —— 那才是契约。


1. **货架根目录不许放裸的 .py**（`__init__.py` 除外）。节点必须待在自己的功能文件夹里。
2. **一个功能文件夹只装这一个功能的东西。** 这个节点专属的解析器、schema、单测、素材都放进去，不要跨文件夹借。
3. **功能包的 `__init__.py` 只导出自己的节点。** 顺手把别人的也注册进来，会让「改一个只翻一个文件夹」失效：你改 A，B 跟着变，而且看不出来。
4. **前后端命名逐字一致**：`m8/nodes/llm/llm_inference/` 对应 `js/nodes/llm/llm_inference.js`。
5. **加功能不碰别人的文件。** 只需要新建文件夹，两层 `__init__.py` 都不用改。

**为什么要这么严**：这套结构的唯一目的是「改一个功能只翻一个文件夹」。
只要破例一次，找东西就得靠全局搜索，结构就白搭了 ——
所以破例这件事不靠自觉，由测试来挡。

**不属于任何货架怎么办**：开一个新货架，**别硬塞**。
判断依据是「它在工作流里干的活」。新货架要同时登记到
`docs/ROADMAP.md`、`m8/core/errors.py` 的货架白名单、`docs/ERROR-PLAYBOOK.md` 三处。

---

## 唯一的例外：`gallery` 货架

`m8/nodes/gallery/` 是**整包合并进来的第三方项目**（原来的 ComfyUI-Danbooru-Gallery），
19 个节点、20 多个模块、自己的一套 `py/` 和 `js/` 结构。

它**不遵守**上面这些约定，这是有意的、也是被批准的：

| 约定 | 它怎么做的 | 为什么允许 |
| --- | --- | --- |
| 一个功能一个文件夹 | 内部保留自己的 `py/<模块>/` | 20 多个模块互相 import，拆开等于重写 |
| `js/nodes/<货架>/<功能>.js` | 放在 `js/gallery/<模块>/` | 它自己的相对导入（`../global/xxx.js`）依赖这个层次 |
| 统一 `/m8/` 路由前缀 | 用 `/danbooru_gallery/*` 等历史前缀 | 改前缀要动它几十处前端调用，收益为零 |
| 抛 `M8Error` + 错误码 | 用它自己的 `[Danbooru-Gallery]` 日志 | 同上 |

**代价要说清楚**：它是这个仓库里唯一「不能靠约定推断结构」的地方。改它之前先读它的
`README.md` 和 `py/`，别指望 M8 的规矩在这儿管用。

**测试怎么处理的**：`tests/smoke_import.py` 的 `MERGED_SHELVES = {"gallery"}` 让目录约定
检查跳过它；路由检查只看 `/m8/` 前缀；节点检查只看 `M8*` 开头的类名。
`registry` 那条加载路径**不跳过** —— 它照样会被 `load_shelf("gallery")` 收进来。

---

## 文件头

每个 `.py` 文件开头写一段 docstring，说清**这个文件负责什么、不负责什么**。
别写「节点定义」这种废话标题，要写取舍：

```python
"""大模型推理节点。

只做三件事：组装请求、发出去、解析回来。
供应商差异不在这里处理，全部收在 server/providers.py —— 本文件里不许出现
if 供应商 == ... 这种分支。
"""
```

---

## Python

| 项 | 要求 |
| --- | --- |
| 类型标注 | 函数签名尽量带。用 `from __future__ import annotations` |
| 字符串 | 统一双引号 |
| 缩进 | 4 空格 |
| 日志 | 走 `m8/core/log.py` 的 `log()`，不要裸 `print` |
| 异常 | 对外抛 `M8Error`，不用裸 `Exception` |
| 阻塞 IO | 在 aiohttp handler 里跑阻塞请求要用 `asyncio.to_thread`，别卡住 ComfyUI 的事件循环 |

**节点类的固定形状**：

```python
class M8Xxx:
    @classmethod
    def INPUT_TYPES(cls): ...
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "execute"
    CATEGORY = "M8/货架名"
    DESCRIPTION = "一句话说明它干什么，显示在节点上。"

    @classmethod
    def VALIDATE_INPUTS(cls, **kwargs): ...   # 只在校验需要放行时写

    def execute(self, ...): ...
```

---

## JavaScript

| 项 | 要求 |
| --- | --- |
| 模块 | 用 `import { app } from "/scripts/app.js"`（相对路径在不同版本会崩） |
| 注册 | 一个节点一个 `app.registerExtension`，`name` 用 `M8.<类名>` |
| 只碰自己 | 前端只改 M8 自己的节点类型，**绝不 patch ComfyUI 内置节点** |
| 样式 | 颜色/圆角/间距一律用 `m8_theme.css` 的变量，不写死 |
| 公共件 | API 调用、通知、loading 都走 `m8_core.js`，不要在节点文件里各写一份 |
| 日志 | 走 `m8_core.js` 的 `log()`，前缀 `[M8]` |
| 控件显示名 | 要中文就挂 `widget.label`（走 `M8.labelWidgets`），**绝不改 `widget.name`** —— name 是工作流文件和接口里的键，改过的已存工作流整体错位 |

### 第三方数据源：只许进内存

接外部站点（图鉴、词典、图库）时，**一个字节都不许落盘，也不许进仓库**：

- 不写 `localStorage` / `IndexedDB` / 后端文件，不把数据当测试 fixture 提交
- 只放**内存**缓存（页面级 Map），刷新即失；图片一律热链，交给浏览器和上游 CDN 缓存
- 仓库里只放逻辑。这个插件是要开源给别人装的，任何打包进去的数据都变成别人的磁盘负担
- 抓外部图片的域名白名单**一项一项加**（`ALLOWED_MEDIA_SUFFIXES`），绝不写成通配 —— 那是 SSRF 防护，不是便利开关

### 两条「用户调过的东西不许冲掉」的硬规矩

都是实机被踩出来的，写在这免得再犯：

1. **颜色归用户。** `M8.brand()` 只上第一次色；发现 `node.color` 已经不是它上次写的值（用户右键换过色，或者工作流里存的是别的色），就永久收手。状态色让位 —— 拿视觉主权换一个状态提示不划算。
2. **尺寸只增不减。** `node.computeSize()` 是「至少多大」，不是「应该多大」。拿它去 `setSize` 会把用户拖出来的尺寸压回去。要动尺寸就取两者的并。

这两条都写在 `m8_core.js` 里，节点代码不要绕过去自己写 `node.color =` / `setSize(computeSize())`。

---

## 命名对照

| 对象 | 规范 | 例子 |
| --- | --- | --- |
> **界面文案一律中文，直接写在代码里。** 节点显示名、widget 标签、tooltip、
> 错误提示都算。写法是 `T("key", "中文")`。详见
> [ARCHITECTURE 的界面语言那节](ARCHITECTURE.md)。
>
> 2026-09 之前这里写的是英文 —— 那是为了过 ComfyUI-Manager 的审核
> （"write the node UI strings in English"）。现在不再为上架要求改变用户的界面
> 语言：这是给中文用户的工具，默认就该是中文，`locales/` 里那份只是同一份内容的副本。
>
> 显示名和 `CATEGORY` 改回中文**不影响老工作流**：`CATEGORY` 只决定右键菜单的
> 分组，节点类型名（`M8LLMInference` 这些）从头到尾没动过，已连线的工作流照常加载。

| 节点类 | `M8` + 大驼峰 | `M8LLMInference` |
| 节点显示名 | `M8 · 中文名` | `M8 · 大模型推理` |
| CATEGORY | `M8/<中文货架名>` | `M8/大模型` |
| 路由 | `/m8/<货架>/<动作>` | `/m8/llm/models` |
| 自定义连线类型 | `M8_` + 大写 | `M8_SKILL` |
| 错误码 | `M8-<货架>-###` | `M8-LLM-001` |
| 日志前缀 | `[M8][<货架>]` | `[M8][LLM]` |
| 前端文件 | 类名下划线小写 | `llm_inference.js` |

---

## 提交前自检

1. `python tests/smoke_import.py` 过
2. 新节点在 `docs/ROADMAP.md` 的货架表里登记过
3. 新失败路径在 `docs/ERROR-PLAYBOOK.md` 里占了一行
4. 没有把 API Key、路径、个人数据写进代码
