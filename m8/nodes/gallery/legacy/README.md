# legacy — 已停用的模块归档

本目录记录已从运行路径上摘除、但可能在将来恢复的模块。
**注意**：这些模块目前仍未从原位置物理删除（本机沙箱不允许 shell 移动/删除该子树下的文件），
但已确认**没有任何代码引用它们**，也不参与 ComfyUI 的加载。

## Krita 联动（2026-xx 停用）

| 原路径 | 现状 | 说明 |
| --- | --- | --- |
| `__init__.py` 的 `open_in_krita` 导入 / 节点映射 / 8 个 API 路由 / 启动时自动安装插件 | **已删除** | 见 git 历史 |
| `js/open_in_krita/open_in_krita.js`（104 行） | **已清空为 stub** | 会被 `WEB_DIRECTORY` 加载，故必须无害化 |
| `js/open_in_krita/setup_dialog.js`（360 行） | **已清空为 stub** | 同上 |
| `py/open_in_krita/`（6 文件约 1269 行） | 原地保留、无引用 | 不被任何模块 import，不影响运行 |
| `krita_files/`（1275 行，Krita 端插件源码） | 原地保留 | 给 Krita 用户的插件，与 ComfyUI 运行无关 |

停用原因：Krita→ComfyUI 回传链路整体断链
（`krita_files/open_in_krita/extension.py` 的 `createActions` 是空实现；
`communication.py` 发 multipart，而 `__init__.py` 用 `await request.json()` 接收），
且节点功能长期无人使用。

恢复方式：从 git 历史取回被删除的 `__init__.py` 片段与两个 js 文件原文，
再把 `py/open_in_krita/` 的包重新纳入导入。

## 手工清理清单（需要文件管理器或管理员权限）

本机沙箱限制了 shell 对该子树的移动/删除，以下操作请手工执行或在权限更高的终端里执行：

```powershell
$root = "<ComfyUI>\custom_nodes\ComfyUI-M8nodes\m8\nodes\gallery"
Move-Item "$root\py\open_in_krita" "$root\legacy\py\open_in_krita"
```
