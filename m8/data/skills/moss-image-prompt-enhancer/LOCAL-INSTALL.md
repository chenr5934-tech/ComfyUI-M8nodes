# 本地安装记录（非上游文件）

上游：https://github.com/OpenMOSS/MOSS-Image/tree/main/skills/moss-image-prompt-enhancer
来源 commit：`1f808b7c4cfd9b72e7d81bbda9b067bc4d306114`（2026-10-16）

## 安装位置：一个真身 + 两个 junction

真身放在 `~/.claude/skills/`，另两处是目录 junction，指向同一个 bundle。
改任何一处即三处同步生效，不要在其中一处单独改文件。

| 使用者 | 路径 | 类型 |
| --- | --- | --- |
| Claude Code | `~/.claude/skills/moss-image-prompt-enhancer` | 真身 |
| dsh（网页 / 桌面） | `~/.dsh/skills/moss-image-prompt-enhancer` | junction → 真身 |
| dsh 共享 agent 根 | `~/.agents/skills/moss-image-prompt-enhancer` | junction → 真身 |

为什么这样摆：dsh 的 `dsh-skill-filesystem` 按 rank 扫描
`<project>/.dsh/skills`(100)、`<project>/.agents/skills`(200)、`customSkillDirs`(300)、
`~/.dsh/skills`(400)、`~/.agents/skills`(500)，**不扫 `~/.claude/skills`**；
Claude Code 只扫 `~/.claude/skills`。这台机器原本就有
`~/.agents/skills ↔ ~/.claude/skills` 的一套 junction 桥，本 skill 沿用同一惯例。
同名条目按 rank 去重，因此 400 与 500 两处不会重复出现。

## 相对上游的本地补丁

共 3 处，都是本机可用性修复，不影响 skill 逻辑：

1. `SKILL.md` frontmatter `description` 追加中文触发词（MOSS-Image 提示词、caption 扩写、
   layout 排版等）。上游只有英文描述，中文提问时触发率偏低。`name` 未改动。
2. `SKILL.md` 的 "Compile and deliver" 段追加 Windows 执行注记。上游全篇教 `python3`，
   而本机 `python3` 解析到 Microsoft Store 占位符 `WindowsApps\python3.exe`，
   **静默退出、零输出**，会导致「看起来跑了、实际什么都没生成」。必须用 `python`。
3. `scripts/test_compile_prompt.py` 补齐 5 处编码参数（3 处 `subprocess.run` 加
   `encoding="utf-8"`，2 处 `Path.read_text` 加 `encoding="utf-8"`）。上游漏写，
   在中文 Windows 上 `read_text()` 按 GBK 解码 UTF-8 产物，测试报
   `UnicodeDecodeError: 'gbk' codec can't decode byte 0x80`。
   `scripts/compile_prompt.py` 本身读写均已显式 UTF-8，无此问题。

## 验证方式

```powershell
python -B "$env:USERPROFILE\.claude\skills\moss-image-prompt-enhancer\scripts\test_compile_prompt.py"
```

期望：`Ran 8 tests ... OK`。

端到端冒烟：拿 `references/layout.md` 里 1536×1024 的样例 draft 编译，
第一个 item 的 bbox 应输出 `[-288,-592,352,32]`（`abs_centralized` / `yxyx`），
与上游文档描述逐位一致。

## 更新上游

重新 clone / 拉取后，把新 bundle 覆盖到真身路径，然后用 `git diff` 思路重新套用上面
3 处补丁，并重跑测试。
