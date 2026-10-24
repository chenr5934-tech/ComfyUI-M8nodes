# 🎨 ComfyUI-Danbooru-Gallery (M8 fork)

> **这是 [Aaalice233/ComfyUI-Danbooru-Gallery](https://github.com/Aaalice233/ComfyUI-Danbooru-Gallery) 的独立维护分支。**
> 上游已归档並把功能迁往 [ComfyUI-Aaalice-Nodes](https://github.com/Aaalice233/ComfyUI-Aaalice-Nodes)；
> 本分支继续在原有 23 节点架构上维护，**不与上游新仓库同步**。

面向 ComfyUI 的实用节点集合：Danbooru / Gelbooru 图像检索、提示词编辑与清洗、缓存管理、工作流辅助工具。

## ⚠️ 与上游新仓库互斥

本分支与 `ComfyUI-Aaalice-Nodes` 注册了**相同的节点 ID**（`PromptSelector`、`GroupIsEnabled`、`SimpleNotify`、`SimpleStringSplit` 等）。
**两者不可同时安装**，否则 ComfyUI 启动时节点会互相覆盖。二选一。

## 🚀 安装

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/chenr5934-tech/ComfyUI-Danbooru-Gallery-M8.git ComfyUI-Danbooru-Gallery-M8
cd ComfyUI-Danbooru-Gallery-M8
pip install -r requirements.txt
```

重启 ComfyUI 即可。

## 🛠️ 依赖与环境

- Python `>= 3.9`（代码使用了 `dict[str, Any]` 等 PEP 585 泛型，3.8 会直接 TypeError）
- 运行时依赖：`requests`、`aiohttp`、`aiosqlite`、`psutil`、`Pillow`、`torch`、`numpy`

## 🧠 节点清单（22 个）

### 🖼️ 图像与提示词核心

| 节点 | 说明 |
| --- | --- |
| `DanbooruGalleryNode` | D站画廊 |
| `PromptSelector` | 提示词选择器 |
| `PromptCleaningMaid` | 提示词清洁女仆 |
| `CharacterFeatureSwapNode` | 角色特征交换 |
| `MultiCharacterEditorNode` | 多角色编辑器 |

### 📂 图像输入输出与文件

| 节点 | 说明 |
| --- | --- |
| `SimpleLoadImage` | 简易加载图像 |
| `SaveImagePlus` | 保存图像增强版 |
| `SimpleImageCompare` | 简易图像对比 |
| `SimpleCheckpointLoaderWithName` | 简易 Checkpoint 加载器 |
| `ModelNameExtractor` | 模型名称提取器 |

### 🔧 工作流控制与字符串工具

| 节点 | 说明 |
| --- | --- |
| `ParameterControlPanel` | 参数控制面板 |
| `ParameterBreak` | 参数展开 |
| `SimpleStringSplit` | 简易字符串分隔 |
| `SimpleValueSwitch` | 简易值切换 |
| `EnumSwitch` | 枚举切换 |
| `WorkflowDescription` | 工作流说明 |
| `SimpleNotify` | 简易通知 |
| `ResolutionMasterSimplify` | 分辨率大师简化版 |

### 🧷 组管理

| 节点 | 说明 |
| --- | --- |
| `GroupMuteManager` | 组静音管理器 |
| `GroupIgnoreManager` | 组忽略管理器 |
| `GroupIsEnabled` | 组是否启用 |

### 🧪 修复类

| 节点 | 说明 |
| --- | --- |
| `VAEImageBatchFix` | VAE 图像批次修复 |

### 🧩 非节点型前端扩展

- `Quick Group Navigation`（快速组导航）
- 各节点的设置弹窗、缓存面板、多语言、日志上报

## 🔧 本分支做了什么

相对上游最后一代（v1.0.0），本分支做了四批改造：

### 1. 安全

| 修复 | 原问题 |
| --- | --- |
| 上传接口文件名净化 + 扩展名白名单 + realpath 兜底 | `ParameterControlPanel` 的上传路由直接拿 multipart 的 `filename` 拼路径落盘，而 ComfyUI 路由默认无鉴权，`../` 可越界写入 |
| 词库导入 zip-slip 防护 | `PromptSelector` 导入 zip 时，图片名取自 zip 内 JSON，可越界写出 preview 目录 |
| 重定向逐跳白名单复验 | 原白名单只校验初始 URL，302 跳到内网仍会回吐响应体（SSRF）；现已改为 `allow_redirects=False` + 手动逐跳校验（上限 5 跳） |

### 2. 修复"写着但没在跑"的功能

| 问题 | 影响 |
| --- | --- |
| 元数据采集的开关判定写错（`HF_HUB_DISABLE_TELEMETRY` 缺省值恰好让条件恒真） | **SaveImagePlus 的 steps / sampler / seed / 底模一直是空的**，日志却报"已加载"。现已由 `LORA_MANAGER_STANDALONE=1` 单一开关控制 |
| `logger` 从不读 `config.json` | `logging.level` / `console_output` / `components` 三项配置全部无效。现优先级：环境变量 > config.json > INFO |
| 入口 24 条裸 import | 缺任意一个可选依赖 → 全部节点消失且无提示。现逐模块容错，失败清单会打印出来 |
| `HotTagsCache` 在运行中的事件循环里恒返回 `[]` | 标签补全永远查不到本地库。已改为正确的 async 实现，并让插件里只剩一套标签搜索入口 |
| `TagSyncManager` 配置指向不存在的文件 | 同步参数全部落硬编码默认值，且会往包目录写文件。现统一读项目根 `config.json` |

### 3. 前端

- 组静音 / 组忽略两个管理器原本是 **2565 行 × 2、仅 18 行不同**的复制粘贴，已合并为 `js/group_tools/group_tools_core.js` + 两个 16 行薄壳，净减约 2500 行。
- 弹窗 ESC 监听改为 `js/utils/overlay_esc.js` 统一配对（包装 `overlay.remove()`），修掉了每次开关弹窗泄漏一个 `keydown` 闭包的问题。
- 新增 `tOrDefault(key, fallback)`，`t()` 的契约保持不变（避免影响 600+ 处无回退的调用）。
- 样式注入加 id 守卫，不再每次实例化都往 `<head>` 追加一份 CSS。

### 4. 工程

- 新增 `tests/`（41 个用例），`pytest.ini` 与 GitHub Actions。
- 修复 `tools/` 下三个因路径锚错 / 引用已删符号而跑不起来的脚本。

## ⚠️ 已知限制

- **Krita 联动已停用**：`OpenInKrita` / `FetchFromKrita` 两个节点及其 8 个后端路由已移除（回传链路在原始代码里就是断的：Krita 端 `createActions` 是空实现，且发 multipart 而后端等 JSON）。`krita_files/` 保留了 Krita 端插件源码，但已无后端对应。详见 `legacy/README.md`。
- **`HotTagsCache` 是单例，且模式由首次调用决定**。若把 `config.json` 的 `cache.use_database_query` 设为 `false`，标签搜索会走内存索引（需要先加载数据）。
- `py/shared/data/tags_cache.db` 不再随仓库分发，首次使用会由标签同步重建。

## 🧑‍💻 开发

```
__init__.py     插件入口、节点注册、全局路由
py/             Python 节点实现
js/             前端扩展（WEB_DIRECTORY）
tests/          回归测试
tools/          开发与运维脚本
legacy/         已停用模块的归档说明
```

### 跑测试

```bash
# 用标准库，无需装任何东西（aiosqlite 相关用例会自动跳过）
python -m unittest discover -s tests -t . -v

# 或用 pytest（必须带 --rootdir=tests：插件根的 __init__.py 会被 pytest 误当测试包导入）
python -m pytest -q --rootdir=tests tests
```

## 📄 许可证与致谢

MIT，见 [LICENSE](LICENSE)。

原始项目由 **[Aaalice233](https://github.com/Aaalice233)** 开发并维护，本分支在其最后一代代码基础上继续。
