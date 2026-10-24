// 【已停用】Krita 联动前端扩展（原 104 行）
// 停用原因：Krita 与 ComfyUI 的回传链路整体断链——
//   krita_files/open_in_krita/extension.py 的 createActions 是空实现，
//   communication.py 发的是 multipart 而后端 __init__.py 等的是 request.json()。
// 且维护者不使用 Krita，故摘除。后端路由与节点注册已同步移除。
// 原实现保留在 git 历史中（停用前最后一次提交）。
// 若要恢复：见 legacy/README.md。
export {};
