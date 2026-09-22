# M8 · 发布流程

> 从「本机能跑」到「别人能装」。每次发版照着走一遍。

---

## 一、发版前检查

### 代码

- [ ] `python tests/smoke_import.py` 全过
- [ ] `docs/ROADMAP.md` 里对应版本的任务都打勾了
- [ ] 新节点的失败路径在 `docs/ERROR-PLAYBOOK.md` 里占了行
- [ ] `m8/core/errors.py` 的 `ERRORS` 和报错手册的码一一对应（测试会拦）
- [ ] 版本号在三个地方都改过了：`pyproject.toml`、根 `__init__.py` 的 `VERSION`、`m8/server/routes.py` 的 `VERSION`

### 仓库卫生

- [ ] `git status` 里没有 `m8/data/` 下的任何文件（密钥、上传的 skill、缓存）
- [ ] 没有 `__pycache__` / `*.pyc` 被提交
- [ ] 面向用户的文档里没有本机绝对路径：`README.md` / `README.en.md` / `docs/TESTING.md` / `docs/ERROR-PLAYBOOK.md`（`AGENTS.md` 是本机开发文档，**允许**带路径）
- [ ] 没有把 API Key 写进任何文件
- [ ] 第三方资产（小鲸鱼图片）的原许可证副本还在：`js/ui/whale/assets/LICENSE.txt`
      —— MIT 要求「在软件的实质部分中保留版权声明」，复制别人的图就得留着它

一键自查（在项目根跑）：

```bash
git status --short
git ls-files | grep -E "m8/data/|__pycache__|\.pyc$" && echo "!!! 有不该提交的东西" || echo "干净"
git grep -n -I -E "sk-[A-Za-z0-9]{16,}" && echo "!!! 疑似密钥" || echo "没有疑似密钥"
```

### 首次上架额外要做

- [ ] `pyproject.toml` 里 `[project.urls]` 的 `Repository` 填上仓库地址
- [ ] `README.md` 里的 clone 地址和真实仓库名一致
- [ ] 补截图：界面图放 `docs/images/`，在 `README.md` 的两个 `<!-- 截图位置 -->` 注释处插入
- [ ] `[tool.comfy]` 的 `Icon` 填一个图片 URL（可选，ComfyUI Manager 里显示用）
- [ ] GitHub 仓库简介（Description）与 Topics 填好：`comfyui` `comfyui-nodes` `llm` `deepseek`

---

## 二、版本号

语义化版本 `主.次.修`：

| 位置 | 什么时候动 |
| --- | --- |
| **修** | 修 bug、改报错文案、补文档 |
| **次** | 加新节点、加新接口、加新货架（向后兼容） |
| **主** | 改已有节点的输入输出签名、删节点、改接口路径（会破坏别人的工作流） |

**加节点是「次」不是「修」** —— 用户的节点菜单会变，值得一个版本号。

改版本号要同时改这三个地方（测试会检查它们是否一致）：

```
pyproject.toml              version = "0.1.0"
__init__.py                 VERSION = "0.1.0"
m8/server/routes.py         VERSION = "0.1.0"
```

---

## 三、发版步骤

```bash
# 1. 在项目根，全量验证
python tests/smoke_import.py

# 2. 改版本号（三处），更新 ROADMAP 的进度
# 3. 提交
git add -A
git status --short          # 再看一眼有没有多带东西
git commit -m "v0.2.0：加载器货架（底模 / LoRA / CLIP / VAE）"

# 4. 打标签并推
git tag -a v0.2.0 -m "v0.2.0"
git push origin main --tags
```

---

## 四、给别人的安装方式

**手动**（README 里已写）：

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/chenr5934-tech/ComfyUI-M8nodes.git
```

**ComfyUI Manager**：在 Manager 里搜仓库名即可，无需额外操作。

**ComfyUI Registry**（可选，想让节点出现在 registry.comfy.org 才做）：

`pyproject.toml` 里的 `[tool.comfy]` 就是给这个用的，字段已经备好：

```toml
[tool.comfy]
PublisherId = "m8"
DisplayName = "M8 Nodes"
Icon = ""
requires-comfyui = ">=0.3.0"
```

发布走官方的 `comfy-cli`（`comfy node publish`）。**具体参数以官方文档为准**，
这里不抄命令，免得文档过期把人带沟里。

---

## 五、发完之后

- [ ] 在干净的 ComfyUI 里装一次（别用开发目录那个 junction），确认没漏文件
- [ ] 确认 `m8/data/` 是插件运行时自己建的，不需要随仓库分发
- [ ] 更新 `docs/ROADMAP.md`，把发出去的版本标成「已发布」

**验证「干净环境能装」是唯一不能省的一步。**
开发机上永远有一堆隐式依赖（某个 pip 包、某个已存在的目录），
只有换一台机器装一次才能暴露出来。
