# M8 · 报错排查手册

> **改报错先查这里。** 有错误码就直接跳行，不要重新推理一遍架构。

---

## 用法

ComfyUI 里的报错长这样：

```
[M8-LLM-001] 未配置 API Key
  修复：在 M8 · 大模型推理 节点上填入 API Key（保存到服务端，不写进工作流）
  详情：...
```

抓 `M8-XXX-###` 这个码，在下表里查，直接得到**文件 + 函数 + 原因 + 修法**。

控制台里搜 `[M8]` 能看到本插件的全部动作流水（每个货架一个前缀）。

---

## 错误码总表

### 地基 `M8-CORE-###` — `m8/core/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-CORE-001 | `core/registry.py: load_shelf` | 某个货架导入失败 | 看 detail 里的 ImportError 原文，通常是该货架文件语法错或少了 `__init__.py` |
| M8-CORE-002 | `core/registry.py: collect` | 节点类名重复 | 两个货架注册了同名节点，改成唯一名 |
| M8-CORE-003 | `core/config.py: load_settings` | 配置文件损坏 | 删掉 `m8/data/settings.json`，会自动重建 |
| M8-CORE-004 | `core/paths.py: data_dir` | 数据目录建不出来 | 检查 custom_nodes 目录写权限 |

### 接口 `M8-SRV-###` — `m8/server/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-SRV-001 | `server/router.py: register_all` | 路由挂载失败 | PromptServer 还没就位；重启 ComfyUI |
| M8-SRV-002 | `server/skills.py: upload` | 上传内容为空 | 选文件时确认文件非空 |
| M8-SRV-003 | `server/skills.py: upload` | 文件名非法（含路径分隔符） | 换个纯文件名，不要带斜杠或反斜杠 |
| M8-SRV-004 | `server/skills.py: upload` | 文件超出体积上限 | 默认 2 MB；skill 是提示词文本，不该这么大 |
| M8-SRV-005 | `server/skills.py: read_skill` | 指定的 skill 不存在 | 在节点上重新选一个，或重新上传 |
| M8-SRV-006 | `server/skills.py: _promote_main_file` | 上传的包里一个 .md 都没有 | 一个 skill 必须有一份正文。补一个 SKILL.md 再传 |

### 大模型 `M8-LLM-###` — `m8/nodes/llm/` + `m8/server/llm_api.py`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-LLM-001 | `llm_inference.py: execute` | 没填 API Key | 在节点上填 Key |
| M8-LLM-002 | `llm_api.py: build_url` | base_url 不是合法 URL | 检查是不是漏了 `https://`；默认 `https://api.deepseek.com/v1` |
| M8-LLM-003 | `llm_api.py: request` | 连不上（DNS / 代理 / 超时） | 检查网络与代理；调大节点上的 timeout |
| M8-LLM-004 | `llm_api.py: request` | 服务器返回非 200 | 看 detail 里的响应正文：401=Key 错，402=余额，404=地址写错，429=限流 |
| M8-LLM-005 | `llm_api.py: parse` | 响应不是预期 JSON | 该地址可能不是 OpenAI 兼容接口；换 base_url |
| M8-LLM-006 | `llm_api.py: list_models` | 拉不到模型列表 | 手动在 model 里填模型名也能跑；或换一个支持 `/models` 的端点 |
| M8-LLM-007 | `llm_inference.py: execute` | 两个提示词框都是空的 | 至少填对话提示词 |
| M8-LLM-008 | `llm_inference.py: pack_image` | 图片转码失败 | 图片张数 / 尺寸异常；检查上游图像节点输出 |
| M8-LLM-009 | `llm_inference.py: pack_audio` | 音频转换失败 | 确认音频采样率与波形张量正常 |
| M8-LLM-010 | `llm_inference.py: execute` | 该模型不支持图片 / 音频输入 | 断开图片 / 音频输入，或换多模态模型 |
| M8-LLM-011 | `skill_loader.py: load` | skill 文件读不到 | 文件被删了或路径失效，重新选 |
| M8-LLM-012 | `llm_inference.py: execute` | skill 内容超出上下文预算 | 换短一点的 skill，或调大 max_tokens |
| M8-LLM-013 | `llm_api.py: request` | 请求体过大（图片太多 / 太大） | 减少图片张数或先缩放 |

### 本地大模型 `M8-LLM-014~020` — `m8/nodes/llm/llm_local/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-LLM-014 | `llm_local/models.py: _full_path` | 模型文件找不到 | 往 `models/LLM` 放 .gguf；用 extra_model_paths.yaml 挂过去也行 |
| M8-LLM-015 | `llm_local/models.py: _load_llama` | llama-cpp-python 没装或者坏了 | `pip install llama-cpp-python`（要 GPU 就装 CUDA 版的 wheel） |
| M8-LLM-016 | `llm_local/models.py: make_chat_handler` | 这份 llama-cpp-python 不支持该多模态模型 | `pip install -U llama-cpp-python` |
| M8-LLM-017 | `llm_local/models.py: load` | 模型加载失败 | 确认 GGUF 完整、没在下载中、没被占用 |
| M8-LLM-018 | `llm_local/node.py: tensor_to_data_url` | 图片张量格式不对 | IMAGE 输入应为 [批, 高, 宽, 3]；确认 pillow / numpy 在 |
| M8-LLM-019 | `llm_local/node.py: run` | 提问、额外文本、图片全空 | 至少填一样 |
| M8-LLM-020 | `llm_local/node.py: run` | 推理过程报错 | 上下文不够调大「上下文长度」；显存放不下把「GPU 层数」改 0 |

### 界面 `M8-UI-###` — `m8/ui/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-UI-001 | `whale/balance.py: fetch_balance` | 服务端没存 DeepSeek 密钥 | 在侧边栏小鲸鱼的设置里填一份，或先在推理节点上存 |
| M8-UI-002 | `whale/balance.py: fetch_balance` | 余额接口请求失败 | 看 detail：401=密钥不对，403=密钥没权限，其余多半是网络或代理 |
| M8-UI-003 | `whale/balance.py: fetch_balance` | 响应结构不是预期形状 | 端点可能变了，detail 里是原始响应 |
| M8-UI-004 | `whale/__init__.py: available_loras` | 读不到 LoRA 列表 | 确认 `models/loras` 目录存在且有文件；detail 里是原始异常 |

### 相机 `M8-CAM-###` — `m8/nodes/cam/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-CAM-001 | `camera_control/node.py: _load_config`、`server/camera_configs.py: load` | config 那栏不是合法 JSON，或存下来的配置文件坏了 | 点节点面板的「设置」改回合法写法；坏掉的文件在 `m8/data/camera-configs/` 下 |
| M8-CAM-002 | `server/camera_configs.py: _safe_name` | 配置名里有路径分隔符或只剩点号 | 换成中英文、数字、下划线或连字符 |
| M8-CAM-003 | `server/camera_configs.py: config_dir / save / load` | 建目录或读写文件失败 | 检查 `m8/data/camera-configs/` 权限；detail 里是原始异常 |
| M8-CAM-004 | `server/camera_configs.py: save` | 配置超过 256 KB | 正常配置只有几 KB，确认没误传大文件 |
| M8-CAM-005 | `server/camera_configs.py: load` | 下拉里那个配置已经不在了 | 点下拉重新拉列表，或另存一份 |

### 提示词 `M8-PROMPT-###` — `m8/nodes/prompt/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-PROMPT-001 | `multi_character/node.py: _load` | config 那栏不是合法 JSON | 点节点面板的「设置」改回来，或点「重置」 |
| M8-PROMPT-002 | `multi_character/node.py: _characters` | 某个角色的坐标或权重不合法 | 看 detail 里指出的角色和字段；坐标 0-1、宽高 > 0 |
| M8-PROMPT-003 | `multi_character/node.py: execute` | 一个角色都没启用，却是区域语法 | 勾上至少一个角色，或把格式切成 plain |
| M8-PROMPT-004 | `multi_character/node.py: execute` | 输出格式写成了别的值 | 只能是 attn / regional / plain |
| M8-PROMPT-005 | `server/prompt_presets.py: _safe_name` | 预设名里有路径分隔符或只剩点号 | 换成中英文、数字、下划线或连字符 |
| M8-PROMPT-006 | `server/prompt_presets.py: save / load` | 预设目录建不出来或文件读写失败 | 检查 `m8/data/prompt-presets/` 权限；detail 里是原始异常 |
| M8-PROMPT-007 | `server/prompt_presets.py: load` | 下拉里那个预设已经不在了 | 点下拉重新拉列表，或另存一份 |

### 网页 `M8-WEB-###` — `M8web/`

| 码 | 触发点 | 原因 | 修法 |
| --- | --- | --- | --- |
| M8-WEB-001 | `server/webapp.py: resolve` | 请求的网页资源路径跑到了 M8web 目录外面 | URL 里不要带 `..`；正常从首页点进去就好 |
| M8-WEB-002 | `server/webapp.py: resolve` | 请求了不允许的文件类型 | 只服务 html/css/js/图片/字体这类静态资源 |
| M8-WEB-003 | `server/webapp.py: serve` | M8web 里没有这个文件 | 从首页点进去；手输 URL 的话确认拼写 |
| M8-WEB-004 | `server/shortcut.py: make_shortcut` | 找不到桌面目录 | 确认当前用户有桌面；桌面被挪到 OneDrive 的话，先打开一次文件资源管理器让它建出来 |
| M8-WEB-005 | `server/shortcut.py: make_shortcut` | 传进来的地址不是 http/https | 正常从工作台页面点那个按钮就行，别手改请求 |
| M8-WEB-006 | `server/shortcut.py: make_shortcut` | 写 .url 文件失败 | 桌面上是不是已经有个同名的只读文件？删掉它再试 |
| M8-WEB-007 | `core/webdata.py: data_file` | 请求的数据类别不认识 | 只支持 oc / prompts / groups / stickers 这四类 |
| M8-WEB-008 | `core/webdata.py: ensure_dir` | 建不出工作台数据目录 | 检查 `<ComfyUI>/models/M8data` 的写权限；想换地方就设环境变量 M8_DATA_DIR |
| M8-WEB-009 | `core/webdata.py: write` | 写数据文件失败 | 检查磁盘空间和 `<ComfyUI>/models/M8data/webapp` 的写权限 |
| M8-WEB-010 | `core/webdata.py: put/replace` | 传进来要存的不是一条记录 | 这是内部调用写错了，不是你的操作问题；看 detail |

### 加载器 / 采样 / 判断 / 图像 / 文本

_v0.2 起随货架落地时补充。_

---

## 装好之后的第一次自检

重启 ComfyUI 后按这个顺序确认，出问题能一步定位到货架：

1. **看启动横幅**。控制台里搜 `[M8]`，应该看到：

```
[M8][CORE] 货架 llm：2 个节点 [M8LLMInference, M8SkillLoader]
[M8][SRV] 已挂载 9 条接口：/m8/llm/models, ...
==========================================================
  M8 节点包 v0.1.0
  货架：llm
  节点 2 个 / 接口 9 条
==========================================================
```

   - 完全没有 `[M8]` → 插件没被加载。检查插件目录还在不在 `custom_nodes/` 下面（目录名就是你 clone 或解压出来的那个）
   - 有横幅但节点数是 0 → 货架导入失败了，上面会有 `[M8-CORE-001]` 说明是哪个文件
   - 节点有、接口 0 条 → PromptServer 没就位，看 `[M8-SRV-001]`

2. **打开浏览器控制台**，搜 `[M8]`。应该有几行日志，没有红色的 `[M8]` 报错。

3. **右键菜单的节点列表**里搜 `M8`，应该能看到两个节点，分类在 `M8/大模型` 下。

4. **打一次体检接口**（浏览器地址栏直接开）：

```
http://127.0.0.1:8188/m8/health
```

   返回 `"ok": true` 且 `nodeCount` 是 2，就说明后端全通。

---

## 没有错误码怎么办

那是**未覆盖的路径**，按这个顺序处理：

1. 在控制台里找 `[M8]` 前缀的日志，看最后一条停在哪
2. 定位到货架和文件
3. 修好之后，**在该货架的码段里补一个新码**，并更新本表
4. 顺手把这次的原因写进「原因」列

下次同样的错就变成一次查表，不用再推理。这是这个文件存在的唯一意义。
