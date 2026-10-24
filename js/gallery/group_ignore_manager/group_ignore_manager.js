/**
 * 组忽略管理器 - Group Ignore Manager
 * 提供可视化的组 ignore 控制和联动配置功能
 */

import { registerGroupToolsExtension } from '../group_tools/group_tools_core.js';

// 关闭组时把组内节点设为 LiteGraph.BYPASS(4)
registerGroupToolsExtension({
    nodeName: 'GroupIgnoreManager',
    eventName: 'group-ignore-changed',
    loggerName: 'group_ignore_manager',
    displayName: '组忽略管理器',
    disabledMode: 4,
    missingGroupLogLevel: 'debug',
});
