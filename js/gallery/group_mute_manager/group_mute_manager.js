/**
 * 组静音管理器 - Group Mute Manager
 * 提供可视化的组 mute 控制和联动配置功能
 */

import { registerGroupToolsExtension } from '../group_tools/group_tools_core.js';

// 关闭组时把组内节点设为 LiteGraph.NEVER(2)
registerGroupToolsExtension({
    nodeName: 'GroupMuteManager',
    eventName: 'group-mute-changed',
    loggerName: 'group_mute_manager',
    displayName: '组静音管理器',
    disabledMode: 2,
    missingGroupLogLevel: 'warn',
});
