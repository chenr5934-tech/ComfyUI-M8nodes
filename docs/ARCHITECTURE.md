# M8 节点包 · 架构约定

> 定死的规矩。写代码时不用再临时决定「这个逻辑放前端还是后端」。

---

## 一、前后端分工

原则：**后端管数据和真相，前端管手感和外观。**

| 事情 | 放哪 | 为什么 |
| --- | --- | --- |
| 调外部 API、读磁盘、存密钥 | 后端 | 浏览器有 CORS 限制，也读不了本地文件 |
| 输入校验、参数默认值 | 后端 | 服务端才是权威 |
| 按钮、状态显示、下拉刷新 | 前端 | 后端碰不到 DOM |
| 输入框即时反馈、拖拽 | 前端 | 每次按键都发请求是灾难 |
| 模型列表 | 后端拉、前端缓存 | 绕 CORS，并且能缓存 |

**判定法**：这个逻辑如果前端整个挂掉（比如用 API 模式跑工作流），还需要吗？

- 需要 → 后端
- 不需要 → 前端

---

## 二、注册机制

三层，各管各的：

```
根 __init__.py                 只做一件事：把各货架的 MAPPING 合并
   ↑
m8/nodes/<货架>/__init__.py     导出本货架的 NODE_CLASS_MAPPINGS
   ↑
m8/nodes/<货架>/<节点>.py       单个节点类
```

**加节点不用改根入口。** 货架自己会把它报上去。这是「货架」这个设计能成立的前提。

路由同理：`m8/server/routes.py` 收集各模块的 `register(server)` 函数，统一挂到 aiohttp。加接口不用动别处。

---

## 三、路由表

统一前缀 `/m8/`，格式 `/m8/<货架>/<动作>`。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/m8/llm/models` | 用给定 base_url + key 拉模型列表 |
| POST | `/m8/llm/test` | 连通性测试 |
| GET | `/m8/keys/list` | 各供应商已存密钥的**掩码**（不含明文） |
| POST | `/m8/keys/set` | 存 / 清供应商密钥（传空串即删除） |
| GET | `/m8/skills/list` | 已上传的 skill 文件列表 |
| POST | `/m8/skills/upload` | 上传 skill 文件（multipart） |
| POST | `/m8/skills/delete` | 删除 skill |
| GET | `/m8/skills/preview` | 预览 skill 主文件内容 |
| GET | `/m8/skills/tree` | 列出一个 skill 包的文件结构与内联情况 |
| GET | `/m8/whale/balance` | 查 DeepSeek 余额（密钥只从服务端读） |
| GET | `/m8/whale/history` | 读对话框的记录（存服务端，不存浏览器） |
| POST | `/m8/whale/history` | 覆盖保存对话记录 |
| POST | `/m8/whale/history/clear` | 清空对话记录 |
| GET | `/m8/whale/loras` | 列可用的 LoRA（给小鲸鱼挑用） |
| GET | `/m8/whale/usage` | 今日已用（余额差值记账） |
| POST | `/m8/whale/usage/reset` | 清空记账 |
| POST | `/m8/whale/chat` | 对话走一步（带历史、画布快照；可能回工具调用而非正文） |
| POST | `/m8/whale/settings` | 存小鲸鱼的设置（白名单 + 合并式保存） |
| GET | `/m8/whale/state` | 挂件启动时要的一切：有没有密钥、模型、设置 |
| GET | `/m8/cam/configs` | 列出已存的相机机位配置名 |
| POST | `/m8/cam/configs/save` | 存一份机位配置（一个配置一个 json 文件） |
| POST | `/m8/cam/configs/load` | 取一份配置的正文 |
| GET | `/m8/prompt/presets` | 列出已存的角色配置预设名 |
| POST | `/m8/prompt/presets/save` | 存一套角色配置为预设 |
| POST | `/m8/prompt/presets/load` | 取一套预设的正文 |
| POST | `/m8/prompt/presets/delete` | 删掉一套预设 |
| GET | `/m8/llm-local/models` | 列 `models/LLM` 里的 GGUF（前端「刷新模型」用） |
| GET | `/m8/data/{kind}` | 读一整类工作台数据（kind = oc / prompts / groups / stickers）。**数据在 `<ComfyUI>/models/M8data/webapp/` 下，不在浏览器里** —— 独立服务也读同一份 |
| POST | `/m8/data/{kind}/put` | 存一条（没带 id 就分配一个） |
| POST | `/m8/data/{kind}/delete` | 删一条 |
| POST | `/m8/data/{kind}/replace` | 整份换掉（导入备份走这条） |
| POST | `/m8/shortcut/desktop` | 往桌面放一个工作台快捷方式（写 .url；浏览器自己没这个权限，所以由后端代劳） |
| GET | `/m8/web/{path:.*}` | M8web 网页工作台的静态资源；空路径回 index.html（`{path:.*}` 是 aiohttp 的捕获语法，要它才能匹配多级子目录） |
| GET | `/m8/health` | 自检：货架加载状态、数据目录、版本 |

**约定**：

- 出参统一 JSON，中文不转义（`ensure_ascii=False`）
- 失败统一返回 `{"ok": false, "code": "M8-XXX-###", "error": "...", "hint": "..."}`
- 前端拿到 `code` 就能直接去 `docs/ERROR-PLAYBOOK.md` 查

---

## 四、数据存放

全部在 `m8/data/`（**不进 git**）：

```
m8/data/
├── credentials.json    供应商密钥（0600 权限）
├── settings.json       插件全局设置
├── whale-usage.json    小鲸鱼的用量记账（余额差值，跨天归档）
├── whale-history.json  对话框的记录（只留对话文本，图片剥离）
├── skills/             上传的 skill 包
│   └── <名字>/          一个 skill 一个目录
│       ├── SKILL.md     主文件，必需
│       └── references/  资源，可选
└── cache/              模型列表等缓存（可随时删）
```

**skill 为什么是目录**：skill 常常不只是一段提示词，还要带参考资料、模板、示例数据。
单文件装不下这些，「照着 references/xxx 里的风格写」这类指令就成了空话 ——
模型根本拿不到那个文件。

**资源怎么到模型手里**：ComfyUI 里的模型没有读文件的工具，所以资源必须在组装请求时
就内联进正文（`skills.read_bundle`）。两条护栏：单文件 64 KB、整包 256 KB；
超出的不展开，但会在正文末尾列出清单 —— 让模型知道自己缺什么，
不至于编一个「我已按参考文件写」的答案。

**兼容**：老的平铺 `.md` 仍能读（当作只有一个主文件的包），但保存一律走目录式。

**密钥规则**：

- 只在后端出现，绝不把明文回传给前端
- 前端只能拿到 `sk-****1234` 这种掩码
- 节点上的 API Key 输入框默认空；填了就存服务端，工作流里存的是引用而不是明文

---

## 四·五、本地模型的发现与缓存

本地大模型节点的模型是**用户自己往 `models/LLM` 里丢的**，不是插件装的。
这带来两个必须想清楚的点，都是实测过的（不是推测）：

**1. 新丢进去的文件不用重启 ComfyUI。**
`folder_paths.get_filename_list` 有一层文件列表缓存，但它带 mtime 校验 ——
会核对根目录和每个已知子目录的 mtime，对不上就重扫。实测：往 `models/LLM`
丢一个 `.gguf`，同一个进程里下一次调用就扫得到；放进新建的子目录同样扫得到；
删掉之后立刻消失。

**2. 卡点不在后端，在前端下拉。**
节点的 `INPUT_TYPES()` 只在**建节点时**被调一次，之后下拉里的候选就定住了。
所以新模型即使盘上有、后端也拿得到，界面上还是看不到。`js/nodes/llm/llm_local.js`
里的「刷新模型列表」按钮就是干这个的：走后端 `/m8/llm-local/models`（它调
`models.refresh()`，强迫那层缓存失效再重扫），拿到新列表直接换掉下拉的取值数组。

**3. mmproj 怎么配。**
规则只写一遍，前后端各一份实现（`models._pick_from` 和 `autoPickMmproj`），
用例共用 `tests/mmproj_cases.json` —— 分散就是风险，所以用一个文件把它们钉在一起。
优先级：**同目录** > 名字里共同特征词 + 参数规模（9b / 4b）> 只剩一个候选就用它 > 配不上就不配。
参数规模那条是补出来的：`9b` 只有两字符，会被「实词长度 >= 3」的下限滤掉，
结果同系列 4B 和 9B 同分，先到的 4B 赢 —— 不报错、只是识图结果莫名其妙。

---

## 五、错误体系

统一异常 `M8Error`，在 `m8/core/errors.py`：

```python
class M8Error(Exception):
    code: str      # "M8-LLM-001"
    message: str   # 给人看的一句话
    hint: str      # 怎么修
    detail: str    # 原始异常文本（可选）
```

**规则**：

1. 对外暴露的每一个失败路径都要有码。
2. 底层原始异常（URLError / HTTPError / JSONDecodeError）**必须**包装成 `M8Error` 再往外抛，原始文本放 `detail`。
3. 节点执行函数捕获 `M8Error`，转成 ComfyUI 能显示的消息：`[M8-LLM-001] 未配置 API Key | 修复：在节点上填入密钥`
4. 没有码的裸异常 = 债。修完必须补码。

---

## 六、视觉语言（参考 rgthree-comfy 的取向）

从 rgthree 学的是**取舍**，不是照抄它的架构（它用 TypeScript 编译链，对我们是负担）。

| 理念 | M8 的落地 |
| --- | --- |
| 节点自己就是界面 | 能用节点上的按钮解决的，不弹对话框 |
| 状态可见 | 节点顶部一条状态带：正常 / 运行中 / 错误，颜色区分 |
| 数据可刷新 | 需要联网或读盘的数据（模型列表 / skill 列表）在节点上给刷新按钮 + loading 态 |
| 少开窗 | 重量级内容用小面板，不用大模态 |
| 不抢焦点 | 通知从页面上方滑入，几秒后自动消失 |
| 设置集中 | 全局偏好在 ComfyUI 设置面板；节点上只放和当前任务有关的 |
| 报错可读 | 错误直接显示在节点上 + 悬停看 hint，不用去翻控制台 |

**视觉 token**（`js/m8_theme.css` 里定义，别在节点文件里写死颜色）：

```css
--m8-primary:  #3BA99C   /* 品牌主色，青绿 */
--m8-accent:   #E8A33D   /* 强调 / 进行中，琥珀 */
--m8-ok:       #4CAF7D
--m8-warn:     #E0A02E
--m8-err:      #E05C5C
--m8-bg:       #22282B
--m8-line:     #3A4247
```

品牌识别：M8 自己的节点头部一律加一条 teal 色带。看见青绿头 = 这是 M8 的节点。

---

## 七、零依赖

后端只用**标准库 + ComfyUI 自带**（aiohttp / torch / numpy / av）。

要加第三方依赖必须：写进 `requirements.txt`、在 README 说明、并确认秋叶整合包的 python 里装得上。

目前：**零新增依赖**。HTTP 请求用 `urllib.request`（标准库），不用 requests。
