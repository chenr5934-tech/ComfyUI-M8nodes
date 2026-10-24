import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// 导入组件
import './character_editor.js';
import './mask_editor.js?v=20251012-0352';
import './output_area.js';
import './settings_menu.js';
import { globalMultiLanguageManager } from '../global/multi_language.js';
import { globalAutocompleteCache } from '../global/autocomplete_cache.js';
import { AutocompleteUI } from '../global/autocomplete_ui.js';
import { globalToastManager as toastManagerProxy } from '../global/toast_manager.js';
import { PresetManager } from './preset_manager.js';
import { createLogger } from '../global/logger_client.js';

// 创建logger实例
const logger = createLogger('multi_character_editor');

import '../global/color_manager.js';

/*
 * 多人提示词节点性能优化总结
 *
 * 已完成的优化工作：
 *
 * 1. CSS动画和过渡效果优化
 *    - 简化了复杂的渐变背景和阴影效果
 *    - 减少了不必要的动画和过渡
 *    - 移除了性能消耗大的光晕效果
 *    - 添加了 will-change 属性优化
 *
 * 2. Canvas渲染性能优化
 *    - 优化了网格绘制，只在可视区域内绘制
 *    - 简化了边框和蒙版绘制，移除了圆角
 *    - 降低了分辨率信息更新频率
 *    - 根据缩放级别调整渲染细节
 *
 * 3. 事件处理和DOM操作优化
 *    - 添加了鼠标移动和滚轮事件的节流处理
 *    - 优化了容器大小变化的处理
 *    - 使用事件委托减少事件监听器数量
 *    - 优化了拖拽事件处理
 *
 * 4. 渲染节流和防抖优化
 *    - 为角色列表渲染添加了防抖处理
 *    - 使用文档片段减少DOM操作
 *    - 优化了事件绑定，使用事件委托
 *    - 添加了渲染节流，限制最大渲染频率
 *
 * 优化效果：
 * - 减少了CPU和内存使用
 * - 提高了界面响应速度
 * - 降低了滚动和缩放时的卡顿
 * - 改善了整体用户体验
 */

// 防抖函数
function debounce(func, delay) {
    let timeout;
    return function (...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// 节流函数
function throttle(func, delay) {
    let lastCall = 0;
    return function (...args) {
        const context = this;
        const now = Date.now();
        if (now - lastCall >= delay) {
            lastCall = now;
            return func.apply(context, args);
        }
    };
}

// 全局变量
let MultiCharacterEditorInstance = null;

// 主编辑器类
class MultiCharacterEditor {
    constructor(node, widgetName) {


        this.node = node;
        this.widgetName = widgetName;
        this.container = null;
        this.dataManager = null;
        this.eventBus = null;
        this.components = {};

        // 多语言管理器 - 绑定到'mce'命名空间
        this.languageManager = {
            // 创建一个包装器，自动使用mce命名空间
            t: (key) => globalMultiLanguageManager.t(`mce.${key}`),
            setLanguage: (lang) => globalMultiLanguageManager.setLanguage(lang),
            getLanguage: () => globalMultiLanguageManager.getLanguage(),
            getAvailableLanguages: () => globalMultiLanguageManager.getAvailableLanguages(),
            // 向后兼容的方法
            updateInterfaceTexts: () => {
                // 触发语言变化事件
                document.dispatchEvent(new CustomEvent('languageChanged', {
                    detail: { language: globalMultiLanguageManager.getLanguage() }
                }));
            }
        };
        this.toastManager = toastManagerProxy;

        // 节点状态存储键
        this.stateKey = 'multi_character_editor_state';

        /**
         * 显示弹出提示
         * @param {string} message - 提示消息
         * @param {string} type - 提示类型 (success, error, warning, info)
         * @param {number} duration - 显示时长（毫秒）
         */
        this.showToast = (message, type = 'info', duration = 3000) => {
            // 使用统一的弹出提示管理系统
            const nodeContainer = this.container;

            try {
                this.toastManager.showToast(message, type, duration, { nodeContainer });
            } catch (error) {
                logger.error('[MultiCharacterEditor] 显示提示失败:', error);
                // 回退到不传递节点容器的方式
                try {
                    this.toastManager.showToast(message, type, duration, {});
                } catch (fallbackError) {
                    logger.error('[MultiCharacterEditor] 回退方式也失败:', fallbackError);
                    // 最后的保险措施：使用浏览器原生alert
                    alert(`${type.toUpperCase()}: ${message}`);
                }
            }
        };

        this.init();
    }

    init() {
        this.createContainer();


        this.initManagers();


        this.createLayout();


        this.initComponents();


        this.bindEvents();


        this.loadInitialData();


        // 确保画布在初始化后正确渲染
        setTimeout(() => {

            this.ensureCanvasInitialized();
        }, 300);
    }

    createContainer() {
        this.container = document.createElement('div');
        this.container.className = 'mce-container';
        this.container.style.cssText = `
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            background: #1e1e2e;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            overflow: hidden;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            font-size: 13px;
            color: #E0E0E0;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            position: relative;
            animation: fadeIn 0.3s ease-out;
            will-change: auto;
            margin: 0 !important;
            padding: 0 !important;
        `;

        // 简化内部光晕效果，减少动画
        const glowEffect = document.createElement('div');
        glowEffect.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 1px;
            background: linear-gradient(90deg,
                transparent,
                rgba(255, 255, 255, 0.1),
                transparent);
            z-index: 10;
        `;
        this.container.appendChild(glowEffect);

        // 添加全局动画样式
        this.addGlobalAnimations();
    }

    addGlobalAnimations() {
        // 检查是否已添加动画样式
        if (document.querySelector('#mce-global-animations')) return;

        const style = document.createElement('style');
        style.id = 'mce-global-animations';
        style.textContent = `
            /* 响应式设计 */
            @media (max-width: 900px) {
                .mce-container {
                    width: 100% !important;
                    height: 100% !important;
                    border-radius: 0 !important;
                }
                
                .mce-character-editor {
                    width: 250px !important;
                }
            }
            
            @media (max-width: 768px) {
                .mce-main-area {
                    flex-direction: column !important;
                }
                
                .mce-character-editor {
                    width: 100% !important;
                    height: 200px !important;
                    border-right: none !important;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08) !important;
                }
                
                .mce-toolbar {
                    flex-wrap: wrap !important;
                    padding: 10px !important;
                }
                
                .mce-toolbar-section {
                    width: 100% !important;
                    margin-bottom: 8px !important;
                }
                
                .mce-toolbar-section-right {
                    margin-left: 0 !important;
                    width: 100% !important;
                    justify-content: space-between !important;
                }
            }
            
            /* 高对比度模式支持 */
            @media (prefers-contrast: high) {
                .mce-container {
                    border: 2px solid #ffffff !important;
                }
                
                .mce-button {
                    border: 2px solid #ffffff !important;
                }
                
                .mce-select, .mce-input {
                    border: 2px solid #ffffff !important;
                }
            }
            
            /* 减少动画模式支持 */
            @media (prefers-reduced-motion: reduce) {
                .mce-container,
                .mce-button,
                .mce-character-item,
                .mce-mask-item,
                .mce-edit-modal,
                .mce-settings-dialog,
                .mce-toast {
                    animation: none !important;
                    transition: none !important;
                }
            }
            
            /* 简化动画，提高性能 */
            @keyframes fadeIn {
                from {
                    opacity: 0;
                    transform: translateY(5px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            
            /* 为按钮添加简化悬停效果 */
            .mce-button {
                position: relative;
                overflow: hidden;
                will-change: transform;
            }
            
            /* 为模态框添加简化动画 */
            .mce-edit-modal {
                animation: fadeIn 0.2s ease-out;
            }
            
            .mce-edit-modal-content {
                animation: fadeIn 0.2s ease-out;
            }
            
            /* 为提示添加简化动画 - 移除，避免覆盖toast_manager.js中的样式 */
            /* .mce-toast {
                animation: fadeIn 0.2s ease-out;
            } */
            
            /* 为设置菜单添加简化动画 */
            .mce-settings-dialog {
                animation: fadeIn 0.2s ease-out;
            }
            
            /* 为加载状态添加简化动画 */
            .mce-loading {
                display: inline-block;
                width: 16px;
                height: 16px;
                border: 2px solid rgba(255, 255, 255, 0.3);
                border-radius: 50%;
                border-top-color: #7c3aed;
                animation: spin 1s linear infinite;
            }
            
            @keyframes spin {
                to {
                    transform: rotate(360deg);
                }
            }
            
            /* 性能优化：使用transform代替位置变化 */
            .mce-character-item {
                will-change: transform;
            }
            
            .mce-character-item:hover {
                transform: translateY(-1px);
            }
        `;
        document.head.appendChild(style);
    }

    initManagers() {


        this.dataManager = new DataManager(this);

        this.eventBus = new EventBus(this);


    }

    createLayout() {
        this.container.innerHTML = `
            <div class="mce-toolbar"></div>
            <div class="mce-main-area">
                <div class="mce-character-editor"></div>
                <div class="mce-mask-editor"></div>
            </div>
            <div class="mce-output-area"></div>
        `;
    }

    initComponents() {
        try {


            this.components.toolbar = new Toolbar(this);

            this.components.characterEditor = new CharacterEditor(this);

            // 初始化预设管理器
            this.presetManager = new PresetManager(this);

            this.components.maskEditor = new MaskEditor(this);

            // mask_editor.js已经有drawResolutionInfoOptimized，不需要劫持了

            this.components.outputArea = new OutputArea(this);


            this.components.settingsMenu = new SettingsMenu(this);



        } catch (error) {
            logger.error("[DEBUG] initComponents: 组件初始化过程中发生错误:", error);
            logger.error("[DEBUG] initComponents: 错误堆栈:", error.stack);
        }
    }

    bindEvents() {
        // 绑定全局事件
        this.eventBus.on('character:added', this.onCharacterAdded.bind(this));
        this.eventBus.on('character:updated', this.onCharacterUpdated.bind(this));
        this.eventBus.on('character:deleted', this.onCharacterDeleted.bind(this));
        this.eventBus.on('character:reordered', this.onCharacterReordered.bind(this));
        this.eventBus.on('mask:updated', this.onMaskUpdated.bind(this));
        this.eventBus.on('config:changed', this.onConfigChanged.bind(this));
        this.eventBus.on('config:restored', this.onConfigRestored.bind(this));

        // 🔧 新增：双向选择同步
        this.eventBus.on('character:selected', this.onCharacterSelected.bind(this));
        this.eventBus.on('character:deselected', this.onCharacterDeselected.bind(this));
        this.eventBus.on('mask:selected', this.onMaskSelected.bind(this));
        this.eventBus.on('mask:deselected', this.onMaskDeselected.bind(this));

        // 🔧 新增：点击编辑器外部时取消所有选择
        document.addEventListener('click', (e) => {
            // 如果点击的是编辑器外部，取消所有选择
            if (!this.container || !this.container.contains(e.target)) {
                this.clearAllSelections();
            }
        });

        // 🔧 关键修复：页面关闭前强制保存所有数据，防止角色列表丢失
        window.addEventListener('beforeunload', (e) => {
            try {
                const config = this.dataManager?.getConfig();
                if (config && config.characters && config.characters.length > 0) {
                    // 强制同步保存到节点状态
                    this.saveToNodeState(config);
                    // 同时保存到localStorage作为双重保障
                    this.saveToLocalStorage(config);
                    logger.info('[MultiCharacterEditor] beforeunload: 已强制保存数据，角色数量:', config.characters.length);
                }
            } catch (error) {
                logger.error('[MultiCharacterEditor] beforeunload保存失败:', error);
            }
        });
    }

    async loadInitialData() {
        try {

            // 从节点状态中加载配置
            let config = this.loadFromNodeState();

            // 如果节点状态中没有配置，尝试从localStorage恢复（仅作为备份）
            if ((!config || !config.characters || config.characters.length === 0)) {

                const localConfig = this.loadFromLocalStorage();
                if (localConfig && localConfig.characters && localConfig.characters.length > 0) {
                    config = localConfig;
                    logger.info('[MultiCharacterEditor] ✅ 从localStorage成功恢复角色数据，数量:', config.characters.length);

                    // 立即保存到节点状态
                    this.saveToNodeState(config);

                    // 🔧 新增：显示恢复成功提示
                    setTimeout(() => {
                        this.showToast(
                            `已从备份恢复 ${config.characters.length} 个角色`,
                            'success',
                            3000
                        );
                    }, 500);
                } else {

                }
            }

            if (config && config.characters && config.characters.length > 0) {
                // 🔧 关键修复：正确恢复角色数据到UI组件
                this.dataManager.config = { ...this.dataManager.config, ...config };

                // 🔧 关键修复：确保DataManager中的角色数组也正确更新
                this.dataManager.config.characters = [...config.characters];


                // 🔧 修复角色列表显示：逐个添加角色到UI
                setTimeout(() => {


                    // 🔧 关键修复：清空现有数据，避免重复
                    if (this.components.characterEditor) {
                        this.components.characterEditor.clearAllCharacters();
                        // 🔧 关键修复：直接设置角色数组
                        this.components.characterEditor.characters = [...config.characters];
                    }
                    if (this.components.maskEditor) {
                        this.components.maskEditor.clearAllMasks();
                    }

                    // 🔧 新增：修复颜色冲突
                    this.fixColorConflicts(config.characters);

                    config.characters.forEach((charData, index) => {
                        logger.info(`[DEBUG] loadInitialData: 恢复角色 ${index + 1}/${config.characters.length}`, {
                            id: charData.id,
                            name: charData.name,
                            hasMask: !!charData.mask,
                            color: charData.color
                        });

                        // 直接将角色数据添加到UI组件，不重复触发事件
                        if (this.components.characterEditor) {
                            this.components.characterEditor.addCharacterToUI(charData, false); // false表示不触发事件
                        } else {
                            logger.error('[MultiCharacterEditor] loadInitialData: characterEditor组件不存在');
                        }
                    });

                    // 强制刷新所有UI组件
                    if (this.components.characterEditor) {
                        this.components.characterEditor.updateUI();

                    }

                    // 🔧 关键修复：先初始化画布尺寸，再同步蒙版
                    if (this.components.maskEditor) {
                        // 使用带重试的方法强制重新初始化画布
                        this.components.maskEditor.resizeCanvasWithRetry();

                        // 🔧 延迟同步蒙版，确保画布尺寸已初始化
                        setTimeout(() => {
                            if (this.components.maskEditor) {
                                // 从角色数据同步蒙版（统一使用这个方法）
                                this.components.maskEditor.syncMasksFromCharacters();
                                this.components.maskEditor.scheduleRender();
                            }
                        }, 300);
                    }

                    // 确保画布正确显示
                    this.forceCanvasDisplay();

                    // 🔧 关键修复：延迟再次刷新，确保画布完全更新
                    setTimeout(() => {
                        if (this.components.maskEditor) {
                            this.components.maskEditor.resizeCanvas();
                            this.components.maskEditor.scheduleRender();
                            this.forceCanvasDisplay();

                        }
                    }, 200);

                    // 🔧 关键修复：验证数据恢复结果
                    setTimeout(() => {
                        const currentConfig = this.dataManager.getConfig();
                        const currentCount = currentConfig?.characters?.length || 0;


                        if (currentCount === 0 && config.characters.length > 0) {
                            logger.error('[MultiCharacterEditor] loadInitialData: 数据恢复失败，尝试强制恢复');
                            // 强制重新设置角色数据
                            this.dataManager.config.characters = [...config.characters];
                            if (this.components.characterEditor) {
                                this.components.characterEditor.characters = [...config.characters];
                                this.components.characterEditor.updateUI();
                            }
                        }
                    }, 300);


                }, 100);
            } else {

                // 即使没有角色数据，也要确保画布正确初始化
                setTimeout(() => {
                    if (this.components.maskEditor) {
                        // 🔧 使用带重试的方法确保画布正确初始化
                        this.components.maskEditor.resizeCanvasWithRetry();
                        this.components.maskEditor.scheduleRender();
                        this.forceCanvasDisplay();

                    } else {
                        logger.error('[MultiCharacterEditor] loadInitialData: maskEditor组件不存在，无法初始化画布');
                    }

                    // 🔧 修复：即使没有角色数据，也要渲染角色列表以显示全局提示词
                    if (this.components.characterEditor) {
                        this.components.characterEditor.updateUI();
                    }
                }, 200);
            }

            this.updateOutput();


            // 添加延迟验证，确保数据真正加载成功
            setTimeout(() => {
                this.validateDataIntegrity();
            }, 1000);

        } catch (error) {
            logger.error('[MultiCharacterEditor] loadInitialData: 加载初始数据失败:', error);
        }
    }

    // 🔧 新增：修复颜色冲突
    fixColorConflicts(characters) {
        if (!characters || !Array.isArray(characters)) {
            return;
        }

        try {
            // 重置颜色管理器以确保从干净状态开始
            if (window.MCE_ColorManager) {
                window.MCE_ColorManager.reset();
            }

            // 检查颜色冲突
            const usedColors = new Set();
            const conflictCharacters = [];

            characters.forEach(char => {
                if (!char.color || usedColors.has(char.color)) {
                    conflictCharacters.push(char);
                } else {
                    usedColors.add(char.color);
                    // 为有效颜色的角色注册颜色
                    if (window.MCE_ColorManager) {
                        window.MCE_ColorManager.getColorForId(char.id, true); // 强制分配颜色
                    }
                }
            });

            // 为冲突的角色分配新颜色
            if (conflictCharacters.length > 0) {
                logger.info(`[MultiCharacterEditor] 发现 ${conflictCharacters.length} 个角色颜色冲突，正在修复...`);

                conflictCharacters.forEach(char => {
                    if (window.MCE_ColorManager) {
                        const newColor = window.MCE_ColorManager.getColorForId(char.id, true);
                        char.color = newColor;
                        logger.info(`[MultiCharacterEditor] 已为角色 "${char.name}" (${char.id}) 分配新颜色: ${newColor}`);
                    } else {
                        // 回退方案：使用默认颜色
                        char.color = '#FF6B6B';
                        logger.warn(`[MultiCharacterEditor] ColorManager 未加载，为角色 "${char.name}" 使用默认颜色`);
                    }
                });

                // 保存修复后的配置
                if (this.dataManager) {
                    this.dataManager.config.characters = characters;
                    // 异步保存，避免阻塞UI
                    setTimeout(() => {
                        this.saveToNodeState(this.dataManager.getConfig());
                    }, 100);
                }
            } else {
                logger.info('[MultiCharacterEditor] 所有角色颜色正常，无需修复');
            }
        } catch (error) {
            logger.error('[MultiCharacterEditor] 修复颜色冲突失败:', error);
        }
    }

    // 验证数据完整性
    validateDataIntegrity() {
        try {


            const config = this.dataManager.getConfig();
            const nodeState = this.loadFromNodeState();





            let stateCharactersCount = 0;
            let stateConfig = null;

            if (nodeState) {
                stateConfig = nodeState;
                stateCharactersCount = stateConfig.characters?.length || 0;


            } else {

            }

            // 检查UI组件状态

            // 如果数据不一致，尝试修复
            if (config.characters && config.characters.length > 0) {
                if (!stateConfig || !stateConfig.characters || stateConfig.characters.length !== config.characters.length) {

                    this.saveToNodeState(config);

                    // 验证修复结果
                    setTimeout(() => {
                        const repairedState = this.loadFromNodeState();
                        const repairedCount = repairedState?.characters?.length || 0;

                    }, 100);
                }
            }


        } catch (error) {
            logger.error('[MultiCharacterEditor] validateDataIntegrity: 验证数据完整性失败:', error);
        }
    }


    addDefaultCharacter() {
        // 🔧 使用默认值创建角色
        const currentSyntaxMode = this.dataManager.config.syntax_mode || 'attention_couple';
        const defaultSyntaxType = currentSyntaxMode === 'regional_prompts' ? 'REGION' : 'COUPLE';

        const defaultCharacter = {
            name: '角色1',
            prompt: '1girl, solo',
            weight: 1.0,
            color: '#FF6B6B',
            syntax_type: defaultSyntaxType  // 🔧 根据当前语法模式设置
        };

        const newCharacter = this.dataManager.addCharacter({
            name: defaultCharacter.name,
            prompt: defaultCharacter.prompt || '',
            weight: defaultCharacter.weight || 1.0,
            color: defaultCharacter.color || '#FF6B6B',
            enabled: true,
            syntax_type: defaultCharacter.syntax_type  // 🔧 传递语法类型
        });



    }

    onCharacterAdded(character) {
        if (this.components.maskEditor) {
            this.components.maskEditor.addMask(character);

        } else {
            logger.error('[MultiCharacterEditor] onCharacterAdded: maskEditor组件不存在');
        }

        this.updateOutput();
        this.saveConfigDebounced();

        // 🔧 关键修复：立即保存到节点状态，确保数据不会丢失
        const config = this.dataManager.getConfig();


        // 🔧 关键修复：确保config包含完整的角色数据
        const enhancedConfig = this.ensureConfigCompleteness(config);


        this.saveToNodeState(enhancedConfig);


        // 🔧 关键修复：添加额外验证，确保数据真正保存
        setTimeout(() => {
            const savedConfig = this.loadFromNodeState();
            const savedCount = savedConfig?.characters?.length || 0;


            if (savedCount === 0 && config?.characters?.length > 0) {
                logger.error('[MultiCharacterEditor] onCharacterAdded: 保存验证失败，重新保存');
                this.saveToNodeState(enhancedConfig);
            }
        }, 100);

        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();
    }

    onCharacterUpdated(character) {

        if (this.components.maskEditor && character) {
            // 检查是否需要更新蒙版，避免循环调用
            const currentMask = this.components.maskEditor.masks.find(m => m.characterId === character.id);
            if (!currentMask || !this.masksEqual(currentMask, character.mask)) {
                this.components.maskEditor.updateMask(character.id, character.mask);
            }
        }
        // 对于频繁的更新，使用防抖而不是节流
        this.updateOutputDebounced();
        this.saveConfigDebounced();
        // 立即保存到节点状态，确保数据不会丢失
        this.saveToNodeState(this.dataManager.getConfig());

        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();

        // 添加额外的保存机制，确保数据持久化
        this.saveToNodeState(this.dataManager.getConfig());
    }

    // 比较两个蒙版是否相等
    masksEqual(mask1, mask2) {
        if (!mask1 && !mask2) return true;
        if (!mask1 || !mask2) return false;

        return mask1.x === mask2.x &&
            mask1.y === mask2.y &&
            mask1.width === mask2.width &&
            mask1.height === mask2.height &&
            mask1.feather === mask2.feather &&
            mask1.blend_mode === mask2.blend_mode;
    }

    // 保存到节点状态
    saveToNodeState(config) {
        try {
            if (!this.node || !this.node.id) {
                logger.error('[MultiCharacterEditor] saveToNodeState: 节点或节点ID不存在');
                return;
            }

            // 使用ComfyUI的节点状态存储机制
            if (!this.node.state) {
                this.node.state = {};
            }

            // 检查config的有效性
            if (!config) {
                logger.error('[MultiCharacterEditor] saveToNodeState: config为空，不保存');
                return;
            }

            // 🔧 关键修复：确保角色数据完整性
            const enhancedConfig = {
                ...config,
                // 确保characters数组存在且完整
                characters: config.characters || [],
                // 添加时间戳和版本标识
                timestamp: Date.now(),
                version: '1.1.0'
            };

            // 🔧 关键修复：深度验证角色数据
            if (enhancedConfig.characters && enhancedConfig.characters.length > 0) {
                enhancedConfig.characters = enhancedConfig.characters.map(char => {
                    const safeChar = {
                        id: char.id || `char_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        name: char.name || '未知角色',
                        prompt: char.prompt || '',
                        weight: char.weight || 1.0,
                        color: char.color || '#FF6B6B',
                        enabled: char.enabled !== false,
                        position: char.position || 0,
                        // 🔧 关键修复：保存FILL和羽化相关状态
                        use_fill: char.use_fill || false,
                        syntax_type: char.syntax_type || 'COUPLE',
                        use_mask_syntax: char.use_mask_syntax || false,
                        feather: char.feather || 0  // 🔧 修复：保存羽化值
                    };

                    // 深度复制蒙版数据
                    if (char.mask) {
                        safeChar.mask = {
                            id: char.mask.id || `mask_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                            characterId: safeChar.id,
                            // 🔧 关键修复：使用 ?? 而不是 ||，允许 0 值
                            x: char.mask.x ?? 0.1,
                            y: char.mask.y ?? 0.1,
                            width: char.mask.width ?? 0.3,
                            height: char.mask.height ?? 0.3,
                            feather: char.mask.feather || 0,
                            blend_mode: char.mask.blend_mode || 'normal',
                            zIndex: char.mask.zIndex || 0
                        };
                    }

                    return safeChar;
                });
            }

            // 检查是否有循环引用
            try {
                const configString = JSON.stringify(enhancedConfig);
                this.node.state[this.stateKey] = configString;


                // 🔧 关键修复：额外保存到widget作为备份
                if (this.node.widgets) {
                    const configWidget = this.node.widgets.find(w => w.name === 'mce_config');
                    if (configWidget) {
                        configWidget.value = configString;

                    }
                }

            } catch (serializeError) {
                logger.error('[MultiCharacterEditor] saveToNodeState: 配置序列化失败:', serializeError);
                // 尝试保存简化版本
                const safeConfig = {
                    version: '1.1.0',
                    syntax_mode: enhancedConfig.syntax_mode || 'attention_couple',
                    base_prompt: enhancedConfig.base_prompt || '',
                    global_prompt: enhancedConfig.global_prompt || '2girls',  // 🔧 保留全局提示词
                    global_use_fill: enhancedConfig.global_use_fill || false,  // 🔧 保留全局FILL状态
                    use_fill: enhancedConfig.use_fill !== undefined ? enhancedConfig.use_fill : false,  // 🔧 保留FILL状态
                    canvas: enhancedConfig.canvas || { width: 1024, height: 1024 },
                    characters: enhancedConfig.characters || [],
                    timestamp: Date.now()
                };
                this.node.state[this.stateKey] = JSON.stringify(safeConfig);

            }

            this.node.setDirtyCanvas(true, true);

            // 🔧 关键修复：每次保存节点状态时，同时备份到localStorage
            // 这样即使节点状态丢失，也能从localStorage恢复
            try {
                this.saveToLocalStorage(enhancedConfig);
                logger.debug('[MultiCharacterEditor] 已同步备份到localStorage');
            } catch (localStorageError) {
                logger.error('[MultiCharacterEditor] localStorage备份失败（非致命错误）:', localStorageError);
            }

        } catch (error) {
            logger.error('[MultiCharacterEditor] 保存到节点状态失败:', error);
            // 降级到localStorage
            this.saveToLocalStorage(config);
        }
    }

    // 从节点状态加载配置
    loadFromNodeState() {
        try {
            // 🔧 关键修复：延迟加载，确保节点状态完全初始化
            if (!this.node || !this.node.state) {

                // 延迟重试一次
                setTimeout(() => {
                    return this.retryLoadFromNodeState();
                }, 100);
                return null;
            }

            // 🔧 关键修复：优先从widget加载，作为备用机制
            let stateData = this.node.state[this.stateKey];
            if (!stateData && this.node.widgets) {
                const configWidget = this.node.widgets.find(w => w.name === 'mce_config');
                if (configWidget && configWidget.value) {
                    stateData = configWidget.value;

                }
            }

            if (!stateData) {

                return null;
            }



            if (stateData) {
                try {
                    const config = JSON.parse(stateData);

                    // 🔧 关键修复：验证并修复配置数据
                    const validatedConfig = this.validateAndFixConfig(config);

                    return validatedConfig;
                } catch (parseError) {
                    logger.error('[MultiCharacterEditor] loadFromNodeState: 配置解析失败:', parseError);


                    // 🔧 关键修复：尝试从localStorage恢复
                    const localConfig = this.loadFromLocalStorage();
                    if (localConfig && localConfig.characters && localConfig.characters.length > 0) {

                        return localConfig;
                    }
                }
            }
        } catch (error) {
            logger.error('[MultiCharacterEditor] 从节点状态加载配置失败:', error);
        }
        return null;
    }

    // 🔧 新增：重试加载节点状态
    retryLoadFromNodeState() {
        try {
            if (!this.node || !this.node.state || !this.node.state[this.stateKey]) {

                return null;
            }

            const stateData = this.node.state[this.stateKey];


            if (stateData) {
                const config = JSON.parse(stateData);

                return this.validateAndFixConfig(config);
            }
        } catch (error) {
            logger.error('[MultiCharacterEditor] retryLoadFromNodeState: 重试失败:', error);
        }
        return null;
    }

    // 🔧 新增：验证并修复配置数据
    validateAndFixConfig(config) {
        try {
            if (!config) {
                logger.warn('[MultiCharacterEditor] validateAndFixConfig: 配置为空，返回默认配置');
                return this.getDefaultConfig();
            }

            // 🔧 关键修复：深度验证并修复canvas配置
            let canvasConfig = { width: 1024, height: 1024 };
            if (config.canvas) {
                canvasConfig = {
                    width: (config.canvas.width && config.canvas.width > 0) ? config.canvas.width : 1024,
                    height: (config.canvas.height && config.canvas.height > 0) ? config.canvas.height : 1024
                };
            }

            // 确保基础结构存在
            const fixedConfig = {
                version: config.version || '1.0.0',
                syntax_mode: config.syntax_mode || 'attention_couple',
                base_prompt: config.base_prompt || '',
                global_prompt: config.global_prompt || '2girls',  // 🔧 保留全局提示词
                use_fill: config.use_fill !== undefined ? config.use_fill : false,  // 🔧 保留FILL状态（后端兼容）
                global_use_fill: config.global_use_fill !== undefined ? config.global_use_fill : false,  // 🔧 关键修复：保留全局FILL状态
                canvas: canvasConfig,
                characters: [],
                settings: config.settings || { language: 'zh-CN' }
            };

            // 🔧 修复：验证并修复角色数据，包含语法类型迁移
            if (config.characters && Array.isArray(config.characters)) {
                const syntaxMode = fixedConfig.syntax_mode;
                fixedConfig.characters = config.characters.map((char, index) => {
                    // 🔧 语法类型迁移逻辑
                    let syntaxType = char.syntax_type;
                    if (!syntaxType) {
                        // 旧数据迁移：根据语法模式和 use_mask_syntax 推断语法类型
                        if (syntaxMode === 'attention_couple') {
                            syntaxType = 'COUPLE';
                        } else if (syntaxMode === 'regional_prompts') {
                            // 如果有旧的 use_mask_syntax 字段，使用它来判断
                            syntaxType = (char.use_mask_syntax !== false) ? 'MASK' : 'REGION';
                        } else {
                            syntaxType = 'COUPLE'; // 默认值
                        }
                    }

                    return {
                        id: char.id || `char_${Date.now()}_${index}`,
                        name: char.name || `角色${index + 1}`,
                        prompt: char.prompt || '',
                        weight: char.weight || 1.0,
                        color: char.color || this.generateColor(),
                        enabled: char.enabled !== false,
                        position: char.position || index,
                        mask: char.mask || null,
                        syntax_type: syntaxType,  // 🔧 设置语法类型
                        use_mask_syntax: char.use_mask_syntax !== false,  // 🔧 保持向后兼容
                        use_fill: char.use_fill || false,  // 🔧 保存FILL状态
                        feather: char.feather || 0  // 🔧 修复：保存羽化值
                    };
                });
            }


            return fixedConfig;
        } catch (error) {
            logger.error('[MultiCharacterEditor] validateAndFixConfig: 修复配置失败:', error);
            return this.getDefaultConfig();
        }
    }

    // 🔧 新增：获取默认配置
    getDefaultConfig() {
        return {
            version: '1.0.0',
            syntax_mode: 'attention_couple',
            base_prompt: '',
            global_prompt: '2girls',  // 🔧 新增：全局提示词
            use_fill: false,  // 🔧 FILL默认关闭（后端兼容）
            global_use_fill: false,  // 🔧 关键修复：全局FILL状态
            canvas: { width: 1024, height: 1024 },
            characters: [],
            settings: { language: 'zh-CN' }
        };
    }

    // 🔧 新增：生成颜色（使用颜色管理器确保唯一性）
    generateColor(id = null) {
        if (!window.MCE_ColorManager) {
            // 如果颜色管理器未加载，返回默认颜色
            logger.warn('[MCE] ColorManager not loaded, using fallback color');
            return '#FF6B6B';
        }

        if (id) {
            // 为指定ID分配颜色
            return window.MCE_ColorManager.getColorForId(id);
        } else {
            // 获取下一个唯一颜色
            return window.MCE_ColorManager.getNextUniqueColor();
        }
    }

    // 🔧 新增：确保配置完整性
    ensureConfigCompleteness(config) {
        try {
            if (!config) {
                return this.getDefaultConfig();
            }

            // 🔧 关键修复：深度验证并修复canvas配置
            let canvasConfig = { width: 1024, height: 1024 };
            if (config.canvas) {
                canvasConfig = {
                    width: (config.canvas.width && config.canvas.width > 0) ? config.canvas.width : 1024,
                    height: (config.canvas.height && config.canvas.height > 0) ? config.canvas.height : 1024
                };
            }

            // 创建增强的配置对象
            const enhancedConfig = {
                ...config,
                // 确保基础结构存在
                version: config.version || '1.1.0',
                syntax_mode: config.syntax_mode || 'attention_couple',
                base_prompt: config.base_prompt || '',
                global_prompt: config.global_prompt || '2girls',  // 🔧 保留全局提示词
                use_fill: config.use_fill !== undefined ? config.use_fill : false,  // 🔧 保留FILL状态
                canvas: canvasConfig,
                settings: config.settings || { language: 'zh-CN' },
                // 🔧 关键修复：确保characters数组存在且完整
                characters: []
            };

            // 深度验证和修复角色数据
            if (config.characters && Array.isArray(config.characters)) {


                enhancedConfig.characters = config.characters.map((char, index) => {
                    const safeChar = {
                        id: char.id || `char_${Date.now()}_${index}`,
                        name: char.name || `角色${index + 1}`,
                        prompt: char.prompt || '',
                        weight: char.weight || 1.0,
                        color: char.color || this.generateColor(),
                        enabled: char.enabled !== false,
                        position: char.position || index
                    };

                    // 深度复制蒙版数据
                    if (char.mask) {
                        safeChar.mask = {
                            id: char.mask.id || `mask_${Date.now()}_${index}`,
                            characterId: safeChar.id,
                            x: char.mask.x || 0.1,
                            y: char.mask.y || 0.1,
                            width: char.mask.width || 0.3,
                            height: char.mask.height || 0.3,
                            feather: char.mask.feather || 0,
                            blend_mode: char.mask.blend_mode || 'normal',
                            zIndex: char.mask.zIndex || 0
                        };
                    }

                    return safeChar;
                });


            } else {
                logger.warn('[MultiCharacterEditor] ensureConfigCompleteness: 角色数组不存在或无效');
            }

            // 添加时间戳和版本标识
            enhancedConfig.timestamp = Date.now();
            enhancedConfig.version = '1.1.0';

            return enhancedConfig;
        } catch (error) {
            logger.error('[MultiCharacterEditor] ensureConfigCompleteness: 配置完整性检查失败:', error);
            return this.getDefaultConfig();
        }
    }

    // 保存到localStorage作为备份
    saveToLocalStorage(config) {
        try {
            const configToSave = config || this.dataManager.getConfig();
            const key = `multi_character_editor_backup_${this.node.id}`;
            localStorage.setItem(key, JSON.stringify(configToSave));
            // 配置已保存到localStorage备份
        } catch (error) {
            logger.error('[MultiCharacterEditor] 保存到localStorage失败:', error);
        }
    }

    // 从localStorage恢复配置
    loadFromLocalStorage() {
        try {
            const key = `multi_character_editor_backup_${this.node.id}`;
            const backupData = localStorage.getItem(key);
            if (backupData) {
                const config = JSON.parse(backupData);
                // 从localStorage恢复配置成功
                return config;
            }
        } catch (error) {
            logger.error('从localStorage恢复配置失败:', error);
        }
        return null;
    }

    onCharacterDeleted(characterId) {
        this.components.maskEditor.removeMask(characterId);
        this.updateOutput();
        this.saveConfigDebounced();
        // 立即保存到节点状态，确保数据不会丢失
        this.saveToNodeState(this.dataManager.getConfig());
        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();
    }

    onCharacterReordered(characters) {
        this.updateOutput();
        this.saveConfigDebounced();
        // 立即保存到节点状态，确保数据不会丢失
        this.saveToNodeState(this.dataManager.getConfig());
        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();
    }

    onMaskUpdated(mask) {
        // 蒙版更新可能很频繁，使用防抖
        this.updateOutputDebounced();
        this.saveConfigDebounced();
        // 立即保存到节点状态，确保数据不会丢失
        this.saveToNodeState(this.dataManager.getConfig());
        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();
    }

    onConfigChanged(config) {
        this.updateOutput();
        // 通知蒙版编辑器画布尺寸已变化
        if (this.components.maskEditor) {
            this.components.maskEditor.resizeCanvas();
            this.components.maskEditor.scheduleRender();
        }

        this.saveConfigDebounced();
        // 立即保存到节点状态，确保数据不会丢失
        this.saveToNodeState(this.dataManager.getConfig());
        // 移除重复的保存调用，避免数据嵌套
        // this.saveConfigImmediate();
    }

    // 新增：处理从onConfigure恢复的配置
    onConfigRestored(config) {
        // 使用 requestAnimationFrame 确保在 DOM 更新后执行 UI 恢复
        requestAnimationFrame(() => {
            if (this.components.characterEditor) {
                this.components.characterEditor.clearAllCharacters();
                if (config.characters) {
                    config.characters.forEach(char => {
                        this.components.characterEditor.addCharacterToUI(char, false);
                    });
                }
            }

            // 🔧 关键修复：先更新 toolbar，确保画布配置正确
            if (this.components.toolbar) {
                this.components.toolbar.updateUI(config);
            }

            // 🔧 关键修复：延迟添加蒙版，等待画布完全初始化
            setTimeout(() => {
                if (this.components.maskEditor) {
                    // 🔧 关键修复：彻底清空蒙版数据
                    this.components.maskEditor.masks = [];
                    this.components.maskEditor.selectedMask = null;

                    // 直接从角色数据重建蒙版
                    config.characters.forEach(char => {
                        if (char.mask && char.enabled) {
                            const mask = { ...char.mask, characterId: char.id };
                            this.components.maskEditor.masks.push(mask);
                        }
                    });

                    this.components.maskEditor.scheduleRender();
                }
            }, 200);

            this.updateOutput();
            // 移除不稳定的forceCanvasDisplay和handleResize
            // this.forceCanvasDisplay();

            // onResize回调会在节点尺寸确定后被调用，届时再调整大小

        });
    }

    // 🔧 新增：当角色被选中时，同步选择对应的蒙版
    onCharacterSelected(characterId) {
        if (this.components.maskEditor) {
            this.components.maskEditor.selectMaskByCharacterId(characterId);
        }
    }

    // 🔧 新增：当角色取消选择时，同步取消蒙版选择
    onCharacterDeselected() {
        if (this.components.maskEditor) {
            this.components.maskEditor.deselectMask();
        }
    }

    // 🔧 新增：当蒙版被选中时，同步选择对应的角色
    onMaskSelected(characterId) {
        if (this.components.characterEditor) {
            // 检查当前是否已选中该角色，避免循环触发
            if (this.components.characterEditor.selectedCharacterId !== characterId) {
                this.components.characterEditor.selectedCharacterId = characterId;
                this.components.characterEditor.updateCharacterSelection();
            }
        }
    }

    // 🔧 新增：当蒙版取消选择时，同步取消角色选择
    onMaskDeselected() {
        if (this.components.characterEditor) {
            this.components.characterEditor.deselectCharacter();
        }
    }

    // 🔧 新增：清除所有选择状态
    clearAllSelections() {
        if (this.components.characterEditor && this.components.characterEditor.selectedCharacterId) {
            this.components.characterEditor.deselectCharacter();
        }
        if (this.components.maskEditor && this.components.maskEditor.selectedMask) {
            this.components.maskEditor.deselectMask();
        }
    }

    updateOutput() {
        try {
            // 🔧 关键修复：同时更新预览和节点输出值
            const config = this.dataManager.getConfig();
            const generatedPrompt = this.generatePrompt(config);

            // 更新预览显示
            if (this.components && this.components.outputArea && this.components.outputArea.updatePrompt) {
                this.components.outputArea.updatePrompt(generatedPrompt);
            }

            // 🔧 关键修复：更新节点的实际输出值，确保输出引脚获取到正确的值
            if (this.node) {
                // 方法1：更新所有相关的widget
                if (this.node.widgets) {
                    // 查找输出相关的widget
                    const promptWidget = this.node.widgets.find(w =>
                        w.name === 'generated_prompt' ||
                        w.name === 'prompt' ||
                        w.name === 'output_prompt' ||
                        w.type === 'text' && w.name.includes('prompt')
                    );

                    if (promptWidget) {
                        promptWidget.value = generatedPrompt;
                        logger.info('[MultiCharacterEditor] 已更新节点输出widget:', promptWidget.name, '值:', generatedPrompt.slice(0, 100) + '...');
                    }
                }

                // 基本缓存更新

                // 🔧 关键修复：强制更新所有输出相关的属性
                if (this.node.widgets) {
                    this.node.widgets.forEach(widget => {
                        if (widget.name === 'generated_prompt' ||
                            widget.name === 'prompt' ||
                            widget.name === 'output_prompt' ||
                            (widget.type === 'text' && widget.name.includes('prompt'))) {
                            widget.value = generatedPrompt;
                            // 触发widget值更新事件
                            if (widget.callback) {
                                widget.callback(generatedPrompt);
                            }
                        }

                        // 🔧 关键修复：更新use_fill参数（后端期望的全局FILL参数名）
                        if (widget.name === 'use_fill') {
                            const globalUseFill = config.global_use_fill || false;
                            widget.value = globalUseFill;
                        }

                        // 🔧 关键修复：更新mce_config，包含完整配置
                        if (widget.name === 'mce_config') {
                            // 确保配置中包含后端需要的所有字段
                            const backendConfig = {
                                ...config,
                                use_fill: config.global_use_fill || false,  // 后端期望的全局FILL参数
                                characters: config.characters?.map(char => ({
                                    ...char,
                                    use_fill: char.use_fill || false  // 确保角色级别的use_fill传递到后端
                                })) || []
                            };

                            widget.value = JSON.stringify(backendConfig, null, 2);
                        }
                    });
                }

                // 基本的节点状态更新完成
            }

        } catch (error) {
            logger.warn('[MultiCharacterEditor] updateOutput 失败:', error);
        }
        // 🔧 关键修复：避免在updateOutput中重复保存，防止数据嵌套
        // this.saveToNodeState(config);
    }

    // 添加节流的更新输出方法
    updateOutputThrottled = throttle(function () {
        this.updateOutput();
    }, 200);

    // 添加防抖的更新输出方法，用于频繁变化的场景
    updateOutputDebounced = debounce(function () {
        this.updateOutput();
    }, 300);

    generatePrompt(config) {
        // 使用本地提示词生成器生成提示词
        if (!config) return '';

        // 确保base_prompt不为null或undefined
        const basePrompt = config.base_prompt !== null && config.base_prompt !== undefined ? config.base_prompt : '';
        const globalPrompt = config.global_prompt || '';
        const globalUseFill = config.global_use_fill || false;
        const characters = config.characters || [];

        // 如果没有角色，直接返回基础提示词 + 全局提示词（包括FILL处理）
        if (!characters || characters.length === 0) {
            let result = basePrompt;
            if (globalPrompt) {
                result = result ? `${result} ${globalPrompt}` : globalPrompt;
            }
            // 🔧 修复：没有角色时也要考虑全局FILL标记
            if (globalUseFill) {
                result = result ? `${result} FILL()` : 'FILL()';
            }
            return result;
        }

        // 过滤启用的角色
        const enabledCharacters = characters.filter(char => char.enabled !== false);
        if (!enabledCharacters || enabledCharacters.length === 0) {
            let result = basePrompt;
            if (globalPrompt) {
                result = result ? `${result} ${globalPrompt}` : globalPrompt;
            }
            // 🔧 修复：没有启用角色时也要考虑全局FILL标记
            if (globalUseFill) {
                result = result ? `${result} FILL()` : 'FILL()';
            }
            return result;
        }

        // 生成蒙版数据
        const masks = this.generateMasks(enabledCharacters);

        // 根据语法模式生成提示词
        if (config.syntax_mode === "attention_couple") {
            return this.generateAttentionCouple(basePrompt, globalPrompt, masks, globalUseFill, enabledCharacters);
        } else if (config.syntax_mode === "regional_prompts") {
            return this.generateRegionalPrompts(basePrompt, globalPrompt, masks);
        } else {
            // 默认使用attention_couple
            return this.generateAttentionCouple(basePrompt, globalPrompt, masks, globalUseFill, enabledCharacters);
        }
    }

    // 生成蒙版数据
    generateMasks(characters) {
        const masks = [];
        for (const char of characters) {
            if (!char.mask) continue;

            // 确保坐标值有效
            const x = Math.max(0.0, Math.min(1.0, char.mask.x || 0.0));
            const y = Math.max(0.0, Math.min(1.0, char.mask.y || 0.0));
            const width = Math.max(0.01, Math.min(1.0 - x, char.mask.width || 0.5));
            const height = Math.max(0.01, Math.min(1.0 - y, char.mask.height || 0.5));

            masks.push({
                prompt: char.prompt || '',
                weight: char.weight || 1.0,
                x1: x,
                y1: y,
                x2: x + width,
                y2: y + height,
                feather: char.feather || char.mask.feather || 0,  // 🔧 修复：从char.feather获取羽化值
                blend_mode: char.mask.blend_mode || 'normal',
                use_fill: char.use_fill || false,  // 添加角色的FILL状态
                syntax_type: char.syntax_type || 'REGION'  // 🔧 修复：传递语法类型
            });
        }
        return masks;
    }

    // 生成Attention Couple语法
    generateAttentionCouple(basePrompt, globalPrompt, masks, globalUseFill, enabledCharacters) {
        if (!masks || masks.length === 0) {
            // 没有角色时，合并基础提示词和全局提示词
            let result = basePrompt;
            if (globalPrompt) {
                result = result ? `${result} ${globalPrompt}` : globalPrompt;
            }
            // 如果全局开启了FILL，添加FILL()
            if (globalUseFill) {
                result = result ? `${result} FILL()` : 'FILL()';
            }
            return result || '';
        }

        const maskStrings = [];
        for (const mask of masks) {
            if (!mask.prompt || !mask.prompt.trim()) continue;

            // 确保坐标在有效范围内
            let x1 = Math.max(0.0, Math.min(1.0, mask.x1));
            let x2 = Math.max(0.0, Math.min(1.0, mask.x2));
            let y1 = Math.max(0.0, Math.min(1.0, mask.y1));
            let y2 = Math.max(0.0, Math.min(1.0, mask.y2));

            // 确保x2 > x1且y2 > y1
            if (x2 <= x1) {
                x2 = Math.min(1.0, x1 + 0.1);
            }
            if (y2 <= y1) {
                y2 = Math.min(1.0, y1 + 0.1);
            }

            // 使用完整格式：MASK(x1 x2, y1 y2, weight)
            const weight = mask.weight || 1.0;
            let maskParams = `${x1.toFixed(2)} ${x2.toFixed(2)}, ${y1.toFixed(2)} ${y2.toFixed(2)}, ${weight.toFixed(2)}`;

            let maskStr = `COUPLE MASK(${maskParams}) ${mask.prompt}`;

            // 🔧 如果该角色开启了FILL，在该角色提示词后添加FILL()
            if (mask.use_fill) {
                maskStr += ' FILL()';
            }

            // 添加羽化（简化语法，一个值表示所有边缘）
            // 羽化值为像素值，0表示不使用羽化
            const featherValue = parseInt(mask.feather) || 0;
            if (featherValue > 0) {
                maskStr += ` FEATHER(${featherValue})`;
            }

            maskStrings.push(maskStr);
        }

        // 🔧 合并基础提示词和全局提示词
        let finalBasePrompt = '';
        if (basePrompt && basePrompt.trim()) {
            finalBasePrompt = basePrompt.trim();
        }
        if (globalPrompt && globalPrompt.trim()) {
            if (finalBasePrompt) {
                finalBasePrompt = finalBasePrompt + ' ' + globalPrompt.trim();
            } else {
                finalBasePrompt = globalPrompt.trim();
            }
        }

        // 构建结果
        const resultParts = [];

        // 🔧 添加基础提示词，如果全局开启了FILL则添加FILL()
        if (finalBasePrompt) {
            if (globalUseFill) {
                resultParts.push(finalBasePrompt + ' FILL()');
            } else {
                resultParts.push(finalBasePrompt);
            }
        } else if (globalUseFill) {
            // 🔧 修复：即使没有基础提示词，如果全局开启了FILL也要添加
            resultParts.push('FILL()');
        }

        // 添加角色提示词
        if (maskStrings.length > 0) {
            resultParts.push(...maskStrings);
        }

        return resultParts.join(' ').trim();
    }

    // 生成Regional Prompts语法
    generateRegionalPrompts(basePrompt, globalPrompt, masks) {
        if (!masks || masks.length === 0) {
            // 没有角色时，合并基础提示词和全局提示词
            let result = basePrompt;
            if (globalPrompt) {
                result = result ? `${result} ${globalPrompt}` : globalPrompt;
            }
            return result || '';
        }

        const maskStrings = [];
        for (const mask of masks) {
            if (!mask.prompt || !mask.prompt.trim()) continue;

            // 根据文档，权重应该是MASK的第3个参数：MASK(x1 x2, y1 y2, weight, op)
            // 确保坐标在有效范围内
            let x1 = Math.max(0.0, Math.min(1.0, mask.x1));
            let x2 = Math.max(0.0, Math.min(1.0, mask.x2));
            let y1 = Math.max(0.0, Math.min(1.0, mask.y1));
            let y2 = Math.max(0.0, Math.min(1.0, mask.y2));

            // 确保x2 > x1且y2 > y1
            if (x2 <= x1) {
                x2 = Math.min(1.0, x1 + 0.1);
            }
            if (y2 <= y1) {
                y2 = Math.min(1.0, y1 + 0.1);
            }

            // 🔧 修复：根据角色的语法类型生成 MASK 或 AREA 语法
            const weight = mask.weight || 1.0;
            let maskParams = `${x1.toFixed(2)} ${x2.toFixed(2)}, ${y1.toFixed(2)} ${y2.toFixed(2)}, ${weight.toFixed(2)}`;

            // 根据 syntax_type 决定使用 MASK 还是 AREA
            const syntaxKeyword = (mask.syntax_type === 'MASK') ? 'MASK' : 'AREA';
            let maskStr = `${mask.prompt} ${syntaxKeyword}(${maskParams})`;

            // 添加羽化（简化语法，一个值表示所有边缘）
            // 羽化值为像素值，0表示不使用羽化
            const featherValue2 = parseInt(mask.feather) || 0;
            if (featherValue2 > 0) {
                maskStr += ` FEATHER(${featherValue2})`;
            }

            maskStrings.push(maskStr);
        }

        // 🔧 合并基础提示词和全局提示词
        let finalBasePrompt = '';
        if (basePrompt && basePrompt.trim()) {
            finalBasePrompt = basePrompt.trim();
        }
        if (globalPrompt && globalPrompt.trim()) {
            if (finalBasePrompt) {
                finalBasePrompt = finalBasePrompt + ' ' + globalPrompt.trim();
            } else {
                finalBasePrompt = globalPrompt.trim();
            }
        }

        // 构建结果
        const resultParts = [];

        // 添加合并后的基础提示词（如果有）
        if (finalBasePrompt) {
            resultParts.push(finalBasePrompt);
        }

        // 添加角色提示词
        if (maskStrings.length > 0) {
            if (resultParts.length > 0) {
                resultParts.push("AND " + maskStrings.join(" AND "));
            } else {
                resultParts.push(maskStrings.join(" AND "));
            }
        }

        return resultParts.join(" ").trim();
    }

    updateWidgetValue(config) {
        // 修复数据嵌套问题：确保config是干净的对象
        let cleanConfig = config;

        // 检查config是否已经是字符串（避免重复序列化）
        if (typeof config === 'string') {
            try {
                cleanConfig = JSON.parse(config);

            } catch (e) {
                logger.error('[MultiCharacterEditor] 解析字符串config失败:', e);
                return; // 如果无法解析，直接返回
            }
        }

        // 🔧 彻底修复数据嵌套问题
        cleanConfig = config;

        // 深度检查并修复嵌套序列化
        if (cleanConfig && cleanConfig.canvas && typeof cleanConfig.canvas === 'string') {

            // 如果canvas被序列化为字符串，说明数据损坏，重置为默认配置
            cleanConfig = {
                version: '1.0.0',
                syntax_mode: 'attention_couple',
                base_prompt: '',
                canvas: { width: 1024, height: 1024 },
                characters: cleanConfig.characters || [],
                settings: {
                    language: 'zh-CN',
                    theme: {
                        primaryColor: '#743795',
                        backgroundColor: '#2a2a2a',
                        secondaryColor: '#333333'
                    }
                }
            };
        }

        // 🔧 最简单的验证：确保config是有效对象
        if (!cleanConfig || typeof cleanConfig !== 'object') {
            logger.error('[MultiCharacterEditor] config无效，使用默认配置');
            cleanConfig = {
                version: '1.0.0',
                syntax_mode: 'attention_couple',
                base_prompt: '',
                canvas: { width: 1024, height: 1024 },
                characters: [],
                settings: { language: 'zh-CN' }
            };
        }

        // 确保基础结构存在
        if (!cleanConfig.canvas || typeof cleanConfig.canvas !== 'object') {
            cleanConfig.canvas = { width: 1024, height: 1024 };
        }
        if (!Array.isArray(cleanConfig.characters)) {
            cleanConfig.characters = [];
        }

        // 保存到节点状态
        this.saveToNodeState(cleanConfig);


    }

    async saveConfig() {
        try {
            // 开始保存配置
            // 保存到服务器文件
            const success = await this.dataManager.saveConfig();
            // 服务器保存结果

            // 同时保存到节点状态中，确保工作流保存时数据不丢失
            this.saveToNodeState(this.dataManager.getConfig());
            // 节点状态已更新
        } catch (error) {
            logger.error('保存配置失败:', error);
        }
    }

    // 立即保存配置，不使用防抖
    async saveConfigImmediate() {
        try {
            // 立即保存配置开始
            // 保存到服务器文件
            const success = await this.dataManager.saveConfig();
            // 立即保存服务器结果

            // 同时保存到节点状态中，确保工作流保存时数据不丢失
            this.saveToNodeState(this.dataManager.getConfig());
            // 立即保存节点状态已更新
        } catch (error) {
            logger.error('立即保存配置失败:', error);
        }
    }


    // 处理节点大小变化 - 修复竞态条件
    handleResize = debounce(function (size) {
        if (!this.container || !size || !this.components.maskEditor) {
            return;
        }

        const [nodeWidth, nodeHeight] = size;

        if (nodeWidth < 100 || nodeHeight < 100) {
            return;
        }

        // 调整大小处理
        // 确保主容器填满节点
        this.container.style.width = `100%`;
        this.container.style.height = `100%`;

        // 🔧 使用requestAnimationFrame确保DOM更新完成
        requestAnimationFrame(() => {
            if (!this.components.maskEditor) {
                logger.error('[MultiCharacterEditor] MultiCharacterEditor.handleResize: maskEditor组件不存在');
                return;
            }

            try {
                // 🔧 关键修复：强制容器布局完成后再调整画布
                const maskContainer = this.components.maskEditor.container;
                if (maskContainer) {
                    // 强制布局重新计算
                    maskContainer.style.display = 'none';
                    maskContainer.offsetHeight; // 触发重排
                    maskContainer.style.display = '';

                    // 确保容器样式正确
                    maskContainer.style.cssText = `
                        position: relative !important;
                        overflow: hidden !important;
                        width: 100% !important;
                        height: 100% !important;
                        display: flex !important;
                        flex-direction: column !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        background: #1a1a2e !important;
                        border-radius: 0 !important;
                        gap: 0 !important;
                        align-items: stretch !important;
                        justify-content: flex-start !important;
                    `;
                }

                // 🔧 关键修复：使用requestAnimationFrame确保DOM布局完成
                requestAnimationFrame(() => {
                    if (this.components.maskEditor && this.components.maskEditor.resizeCanvas) {
                        try {
                            this.components.maskEditor.resizeCanvas();
                            this.components.maskEditor.scheduleRender();

                        } catch (error) {
                            logger.error('[MultiCharacterEditor] MultiCharacterEditor.handleResize: maskEditor.resizeCanvas执行失败', error);
                        }
                    }
                });

            } catch (error) {
                logger.error('[MultiCharacterEditor] MultiCharacterEditor.handleResize: 处理节点大小变化时发生错误', error);
            }
        });

        this.setDirtyCanvas(true, true);
        this.adjustToastPosition();
    }, 100); // 防抖延迟100ms

    // 调整弹出提示位置到节点顶部
    adjustToastPosition() {
        if (this.toastManager && this.container) {
            // 添加调试日志
            // 调整提示位置
            try {
                this.toastManager.adjustPositionToNode(this.container);
            } catch (error) {
                logger.error('调整提示位置失败:', error);
            }
        } else {
            // 无法调整提示位置
        }
    }


    // 设置画布脏标记
    setDirtyCanvas(dirtyForeground, dirtyBackground) {
        if (this.node && this.node.setDirtyCanvas) {
            this.node.setDirtyCanvas(dirtyForeground, dirtyBackground);
        }
    }

    // 确保画布已正确初始化
    ensureCanvasInitialized() {
        try {
            if (this.components.maskEditor) {
                // 🔧 使用带重试的画布调整方法，确保容器尺寸有效
                this.components.maskEditor.resizeCanvasWithRetry();
                this.components.maskEditor.scheduleRender();

                // 强制触发一次画布更新
                setTimeout(() => {
                    if (this.components.maskEditor && this.components.maskEditor.canvas) {
                        this.components.maskEditor.scheduleRender();
                        this.forceCanvasDisplay();
                    }
                }, 100);
            }
        } catch (error) {
            logger.error('[MultiCharacterEditor] 确保画布初始化失败:', error);
        }
    }

    // 新增：强制画布显示
    forceCanvasDisplay() {
        try {


            if (!this.components.maskEditor) {
                logger.error('[MultiCharacterEditor] forceCanvasDisplay: maskEditor组件不存在');
                return;
            }

            if (!this.components.maskEditor.canvas) {
                logger.error('[MultiCharacterEditor] forceCanvasDisplay: canvas元素不存在');
                return;
            }

            const canvas = this.components.maskEditor.canvas;
            const container = this.components.maskEditor.container;

            // 强制设置显示属性
            canvas.style.display = 'block !important';
            canvas.style.visibility = 'visible !important';
            canvas.style.opacity = '1 !important';

            if (container) {
                container.style.display = 'block !important';
                container.style.visibility = 'visible !important';
                container.style.opacity = '1 !important';

            }

            // 确保画布在DOM中正确渲染
            setTimeout(() => {
                if (this.components.maskEditor && this.components.maskEditor.ensureCanvasVisible) {
                    this.components.maskEditor.ensureCanvasVisible();

                }
            }, 50);


        } catch (error) {
            logger.error('[MultiCharacterEditor] forceCanvasDisplay失败:', error);
        }
    }

    // 🔧 新增：直接渲染缩放比例信息，绕过MaskEditor的渲染流程
    renderZoomInfo() {
        try {
            if (!this.components.maskEditor || !this.components.maskEditor.canvas) {
                logger.error('[MultiCharacterEditor] renderZoomInfo: maskEditor或canvas不存在');
                return;
            }

            const canvas = this.components.maskEditor.canvas;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                logger.error('[MultiCharacterEditor] renderZoomInfo: 无法获取canvas上下文');
                return;
            }

            // 保存当前状态并设置变换矩阵考虑DPR
            ctx.save();
            const dpr = window.devicePixelRatio || 1;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            // 获取画布配置和缩放信息
            const config = this.dataManager.getConfig();
            if (!config || !config.canvas) {
                ctx.restore();
                logger.error('[MultiCharacterEditor] renderZoomInfo: 无法获取画布配置');
                return;
            }

            const maskEditor = this.components.maskEditor;
            // 计算实际画布内容区域的右下角位置（考虑offset和scale）
            const canvasContentRight = maskEditor.offset.x + config.canvas.width * maskEditor.scale;
            const canvasContentBottom = maskEditor.offset.y + config.canvas.height * maskEditor.scale;
            const displayWidth = canvasContentRight;
            const displayHeight = canvasContentBottom;

            logger.info('[DEBUG] renderZoomInfo: 容器尺寸信息', {
                displayWidth: displayWidth,
                displayHeight: displayHeight,
                canvasWidth: canvas.width,
                canvasHeight: canvas.height
            });

            // 获取当前缩放比例
            const scale = this.components.maskEditor.scale || 1;
            const zoomLevel = Math.round(scale * 100);
            const zoomText = `缩放: ${zoomLevel}%`;
            const resolutionText = `${config.canvas.width}x${config.canvas.height}`;

            // 设置文本样式
            ctx.font = '12px Arial';
            ctx.fillStyle = '#CCCCCC';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';

            // 根据字体大小自适应边距和行高
            const margin = 10;
            const lineHeight = 16;
            const textX = displayWidth - margin;
            const textY = displayHeight - margin;

            logger.info('[DEBUG] renderZoomInfo: 文本位置', {
                textX: textX,
                textY: textY,
                zoomText: zoomText,
                resolutionText: resolutionText,
                displayWidth: displayWidth,
                displayHeight: displayHeight,
                offsetX: maskEditor.offset.x,
                offsetY: maskEditor.offset.y,
                scale: maskEditor.scale
            });

            // 绘制缩放比例文本
            ctx.fillText(zoomText, textX, textY);

            // 绘制分辨率文本
            ctx.fillText(resolutionText, textX, textY - lineHeight);

            // 恢复上下文状态
            ctx.restore();

        } catch (error) {
            logger.error('[MultiCharacterEditor] renderZoomInfo: 渲染缩放比例信息失败:', error);
        }
    }

    onConfigure(config) {
        if (!this.multiCharacterEditorInstance || !this.multiCharacterEditorInstance.isReady) {
            setTimeout(() => this.onConfigure(config), 50);
            return;
        }

        if (config && config.multi_character_editor) {
            const data = config.multi_character_editor;

            if (this.validateConfiguration(data)) {

                // 更新Widget值
                if (data.widgets) {
                    for (const key in data.widgets) {
                        if (this.widgets[key]) {
                            this.widgets[key].value = data.widgets[key];
                        }
                    }
                }

                // 恢复画布尺寸
                if (this.multiCharacterEditorInstance && this.multiCharacterEditorInstance.components.maskEditor && typeof this.multiCharacterEditorInstance.components.maskEditor.resizeCanvasWithRetry === 'function') {
                    this.multiCharacterEditorInstance.components.maskEditor.resizeCanvasWithRetry(data.canvas_width, data.canvas_height);
                }

                // 恢复配置数据
                if (data.config_data) {
                    this.dataManager.updateConfig(data.config_data);
                }

                // 恢复后强制刷新一次画布和坐标系
                if (data.config_data && data.config_data.image_size) {
                    const { width, height } = data.config_data.image_size;
                    this.multiCharacterEditorInstance.forceInitializeCoordinateSystem(width, height);
                }
            }
        }
    }
}

// 数据管理器
class DataManager {
    constructor(editor) {
        this.editor = editor;
        this.config = {
            version: '1.0.0',
            syntax_mode: 'attention_couple',
            base_prompt: '',
            global_prompt: '2girls',  // 🔧 修复：添加默认全局提示词
            canvas: {
                width: 1024,
                height: 1024
            },
            characters: [],
            settings: {
                language: 'zh-CN',
                theme: {
                    primaryColor: '#743795',
                    backgroundColor: '#2a2a2a',
                    secondaryColor: '#333333'
                }
            }
        };
        this.nextId = 1;
    }

    async loadConfig() {
        try {

            // 在节点独立模式下，不从服务器加载配置，只使用默认配置
            // 这样可以避免多个节点之间的状态覆盖问题
            return this.config;
        } catch (error) {
            logger.error('[DataManager] 加载配置失败:', error);
        }
        return this.config;
    }

    async saveConfig() {
        try {

            // 在节点独立模式下，不保存配置到服务器文件
            // 配置只会保存在节点widget中，随工作流文件保存

            return true;
        } catch (error) {
            logger.error('[DataManager] 保存配置失败:', error);
            return false;
        }
    }

    addCharacter(data = {}) {
        // 数据验证和修复
        if (!Array.isArray(this.config.characters)) {
            this.config.characters = [];
        }

        // 如果角色数量异常，重置数据
        if (this.config.characters.length > 1000) {
            this.config.characters = [];
            this.nextId = 1;
        }

        try {
            // 确保 data 对象存在
            const safeData = data || {};

            let characterId = safeData.id;

            if (!characterId) {
                characterId = this.generateId('char');
            }

            if (!characterId) {
                characterId = `char_backup_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            }

            // 🔧 修复：根据当前语法模式设置正确的语法类型（切换到区域提示词时默认使用MASK）
            const currentSyntaxMode = this.config.syntax_mode || 'attention_couple';
            const defaultSyntaxType = currentSyntaxMode === 'regional_prompts' ? 'MASK' : 'COUPLE';

            const character = {
                id: characterId,
                name: safeData.name || `角色${this.config.characters.length + 1}`,
                prompt: safeData.prompt || '',
                enabled: safeData.enabled !== undefined ? safeData.enabled : true,
                weight: safeData.weight || 1.0,
                color: safeData.color || this.generateColor(characterId),
                position: safeData.position || this.config.characters.length,
                mask: safeData.mask || null,
                template: safeData.template || '',
                syntax_type: safeData.syntax_type || defaultSyntaxType,  // 🔧 新增：设置语法类型
                use_mask_syntax: safeData.use_mask_syntax !== false,  // 🔧 向后兼容字段
                use_fill: safeData.use_fill || false,  // 🔧 保存FILL状态
                feather: safeData.feather || 0  // 🔧 修复：保存羽化值
            };

            this.config.characters.push(character);

            logger.info('[DataManager] addCharacter: 角色已添加到配置', {
                id: character.id,
                name: character.name,
                totalCharacters: this.config.characters.length
            });

            if (this.editor && this.editor.eventBus) {
                this.editor.eventBus.emit('character:added', character);
            }

            // 🔧 关键修复：确保角色数据立即保存到节点状态
            if (this.editor && this.editor.saveToNodeState) {
                // 使用setTimeout确保事件处理完成后再保存
                setTimeout(() => {
                    const config = this.getConfig();


                    // 确保配置完整性
                    const enhancedConfig = this.editor.ensureConfigCompleteness ?
                        this.editor.ensureConfigCompleteness(config) : config;

                    this.editor.saveToNodeState(enhancedConfig);
                }, 10);
            }

            return character;
        } catch (error) {
            // 尝试创建最小可用角色
            try {
                const safeData = data || {};

                const fallbackCharacter = {
                    id: `char_fallback_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                    name: safeData.name || '新角色',
                    prompt: safeData.prompt || '',
                    enabled: true,
                    weight: 1.0,
                    color: '#FF6B6B',
                    position: this.config.characters.length,
                    mask: null,
                    template: ''
                };

                this.config.characters.push(fallbackCharacter);

                if (this.editor && this.editor.eventBus) {
                    this.editor.eventBus.emit('character:added', fallbackCharacter);
                }

                return fallbackCharacter;
            } catch (fallbackError) {
                // 最后的保险措施
                try {
                    const emergencyCharacter = {
                        id: `char_emergency_${Date.now()}`,
                        name: '紧急角色',
                        prompt: '',
                        enabled: true,
                        weight: 1.0,
                        color: '#FF6B6B',
                        position: this.config.characters.length,
                        mask: null,
                        template: ''
                    };

                    this.config.characters.push(emergencyCharacter);

                    if (this.editor && this.editor.eventBus) {
                        this.editor.eventBus.emit('character:added', emergencyCharacter);
                    }

                    return emergencyCharacter;
                } catch (emergencyError) {
                    throw emergencyError;
                }
            }
        }
    }

    updateCharacter(characterId, updates) {
        const index = this.config.characters.findIndex(c => c.id === characterId);
        if (index !== -1) {
            // 🔧 调试FILL更新
            if (updates.hasOwnProperty('use_fill')) {
                logger.info(`[DataManager] 更新角色FILL状态: ${this.config.characters[index].name} (${characterId})`, {
                    旧状态: this.config.characters[index].use_fill,
                    新状态: updates.use_fill
                });
            }

            this.config.characters[index] = { ...this.config.characters[index], ...updates };
            const character = this.config.characters[index];

            logger.info(`[DataManager] 角色已更新: ${character.name}`, updates);
            this.editor.eventBus.emit('character:updated', character);
            return character;
        }
        logger.warn(`[DataManager] 未找到角色: ${characterId} (可能已被删除)`);
        return null;
    }

    deleteCharacter(characterId) {
        const index = this.config.characters.findIndex(c => c.id === characterId);
        if (index !== -1) {
            const character = this.config.characters[index];

            // 🔧 释放角色的颜色
            if (window.MCE_ColorManager) {
                window.MCE_ColorManager.releaseColor(characterId);
                logger.info(`[DataManager] 已释放角色 ${characterId} 的颜色: ${character.color}`);
            }

            this.config.characters.splice(index, 1);
            // 重新排序
            this.config.characters.forEach((char, idx) => {
                char.position = idx;
            });
            this.editor.eventBus.emit('character:deleted', characterId);
            return character;
        }
        return null;
    }

    reorderCharacters(fromIndex, toIndex) {
        const characters = [...this.config.characters];
        const [moved] = characters.splice(fromIndex, 1);
        characters.splice(toIndex, 0, moved);

        // 更新位置
        characters.forEach((char, idx) => {
            char.position = idx;
        });

        this.config.characters = characters;
        this.editor.eventBus.emit('character:reordered', characters);
    }

    updateCharacterMask(characterId, mask) {
        return this.updateCharacter(characterId, { mask });
    }

    updateConfig(updates) {
        // 🔧 调试全局FILL更新
        if (updates.hasOwnProperty('global_use_fill')) {
            logger.info(`[DataManager] 更新全局FILL状态:`, {
                旧状态: this.config.global_use_fill,
                新状态: updates.global_use_fill
            });
        }

        this.config = { ...this.config, ...updates };
        logger.info('[DataManager] 配置已更新:', updates);
        this.editor.eventBus.emit('config:changed', this.config);
    }

    generateId(prefix) {
        try {
            const timestamp = Date.now();
            const random = Math.random().toString(36).substr(2, 9);
            const id = `${prefix}_${timestamp}_${random}`;
            return id;
        } catch (error) {
            // 降级方案：使用简单的递增ID
            try {
                return `${prefix}_${this.nextId++}_${Date.now()}`;
            } catch (fallbackError) {
                // 最后的保险措施
                return `${prefix}_emergency_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
            }
        }
    }

    generateColor(id = null) {
        try {
            if (!window.MCE_ColorManager) {
                logger.warn('[MCE] ColorManager not loaded, using fallback color');
                return '#FF6B6B';
            }

            if (id) {
                // 为指定ID分配颜色
                return window.MCE_ColorManager.getColorForId(id);
            } else {
                // 获取下一个唯一颜色
                return window.MCE_ColorManager.getNextUniqueColor();
            }
        } catch (error) {
            logger.error('[MCE] Error generating color:', error);
            return '#FF6B6B'; // 默认颜色
        }
    }

    getConfig() {
        return this.config;
    }

    getCharacter(characterId) {
        return this.config.characters.find(c => c.id === characterId);
    }

    getCharacters() {
        return this.config.characters;
    }
}

// 事件总线
class EventBus {
    constructor(editor) {
        this.editor = editor;
        this.events = {};
    }

    on(event, callback) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(callback);
    }

    off(event, callback) {
        if (this.events[event]) {
            const index = this.events[event].indexOf(callback);
            if (index > -1) {
                this.events[event].splice(index, 1);
            }
        }
    }

    emit(event, data) {
        if (this.events[event]) {
            this.events[event].forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    logger.error(`事件处理错误 (${event}):`, error);
                }
            });
        }
    }
}

// 工具栏组件
class Toolbar {
    constructor(editor) {
        this.editor = editor;
        this.container = editor.container.querySelector('.mce-toolbar');
        this.languageManager = editor.languageManager;
        this.init();
    }

    init() {
        this.createToolbar();
        this.bindEvents();
        this.updateTexts();

        // 监听语言变化事件
        document.addEventListener('languageChanged', () => {
            this.updateTexts();
        });
    }

    createToolbar() {
        this.container.innerHTML = `
            <div class="mce-toolbar-section">
                <label class="mce-toolbar-label">${this.languageManager.t('syntaxMode')}:</label>
                <select id="mce-syntax-mode" class="mce-select">
                    <option value="attention_couple">${this.languageManager.t('attentionCouple')}</option>
                    <option value="regional_prompts">${this.languageManager.t('regionalPrompts')}</option>
                </select>
            </div>
            <div class="mce-toolbar-section">
                <button id="mce-refresh-canvas" class="mce-button mce-button-icon" title="${this.languageManager.t('refreshCanvas')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M23 4v6h-6"></path>
                        <path d="M1 20v-6h6"></path>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                    </svg>
                    <span>${this.languageManager.t('buttonTexts.refreshCanvas')}</span>
                </button>
            </div>
            <div class="mce-toolbar-section mce-toolbar-section-right">
                <button id="mce-preset-management" class="mce-button mce-button-icon" title="${this.languageManager.t('presetManagement')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="3" y="3" width="7" height="7"></rect>
                        <rect x="14" y="3" width="7" height="7"></rect>
                        <rect x="14" y="14" width="7" height="7"></rect>
                        <rect x="3" y="14" width="7" height="7"></rect>
                    </svg>
                    <span>${this.languageManager.t('presetManagement')}</span>
                </button>
                <button id="mce-syntax-docs" class="mce-button mce-button-icon" title="${this.languageManager.t('syntaxDocs')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                        <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                    <span>${this.languageManager.t('syntaxDocs')}</span>
                </button>
                <button id="mce-language-toggle" class="mce-button mce-button-icon" title="${this.languageManager.t('languageSettings')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M5 8l6 6"></path>
                        <path d="M4 14l6-6 2-3"></path>
                        <path d="M2 5h12"></path>
                        <path d="M7 2h1"></path>
                        <path d="M22 22l-5-10-5 10"></path>
                        <path d="M14 18h6"></path>
                    </svg>
                    <span>${this.languageManager.t('languageSettings')}</span>
                </button>
                <button id="mce-settings" class="mce-button mce-button-icon" title="${this.languageManager.t('settings')}">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                    <span>${this.languageManager.t('settings')}</span>
                </button>
            </div>
        `;

        this.addStyles();
    }

    /**
     * 更新工具栏文本
     */
    updateTexts() {
        // 更新语法模式标签
        const syntaxModeLabel = this.container.querySelector('.mce-toolbar-label');
        if (syntaxModeLabel) {
            syntaxModeLabel.textContent = `${this.languageManager.t('syntaxMode')}:`;
        }

        // 更新语法模式选项
        const syntaxModeSelect = document.getElementById('mce-syntax-mode');
        if (syntaxModeSelect) {
            const attentionOption = syntaxModeSelect.querySelector('option[value="attention_couple"]');
            if (attentionOption) {
                attentionOption.textContent = this.languageManager.t('attentionCouple');
            }

            const regionalOption = syntaxModeSelect.querySelector('option[value="regional_prompts"]');
            if (regionalOption) {
                regionalOption.textContent = this.languageManager.t('regionalPrompts');
            }
        }

        // 更新刷新画布按钮的提示文本和文本
        const refreshButton = document.getElementById('mce-refresh-canvas');
        if (refreshButton) {
            refreshButton.title = this.languageManager.t('refreshCanvas');
            const span = refreshButton.querySelector('span');
            if (span) {
                span.textContent = this.languageManager.t('refreshCanvas');
            }
        }

        // 更新语言切换按钮的提示文本和文本
        const languageButton = document.getElementById('mce-language-toggle');
        if (languageButton) {
            languageButton.title = this.languageManager.t('languageSettings');
            const span = languageButton.querySelector('span');
            if (span) {
                span.textContent = this.languageManager.t('languageSettings');
            }
        }

        // 更新预设管理按钮的提示文本和文本
        const presetManagementButton = document.getElementById('mce-preset-management');
        if (presetManagementButton) {
            presetManagementButton.title = this.languageManager.t('presetManagement');
            const span = presetManagementButton.querySelector('span');
            if (span) {
                span.textContent = this.languageManager.t('presetManagement');
            }
        }

        // 更新语法文档按钮的提示文本和文本
        const syntaxDocsButton = document.getElementById('mce-syntax-docs');
        if (syntaxDocsButton) {
            syntaxDocsButton.title = this.languageManager.t('syntaxDocs');
            const span = syntaxDocsButton.querySelector('span');
            if (span) {
                span.textContent = this.languageManager.t('syntaxDocs');
            }
        }

        // 更新设置按钮的提示文本和文本
        const settingsButton = document.getElementById('mce-settings');
        if (settingsButton) {
            settingsButton.title = this.languageManager.t('settings');
            const span = settingsButton.querySelector('span');
            if (span) {
                span.textContent = this.languageManager.t('settings');
            }
        }
    }

    addStyles() {
        // 已注入过就跳过，避免每次实例化都追加一份同样的 CSS（样式表不会随实例销毁）
        if (document.querySelector('#mce-main-area-styles')) return;

        const style = document.createElement('style');
        style.id = 'mce-main-area-styles';
        style.textContent = `
            .mce-main-area {
                flex: 1;
                display: flex;
                flex-direction: row;
                align-items: stretch;
                overflow: hidden;
                min-height: 0; /* 关键修复：允许子项在容器中正确缩放 */
                background: #1e1e2e;
                border-radius: 0;
                margin: 0 !important;
                padding: 0 !important;
                gap: 0 !important; /* 🔧 关键修复：移除列间距 */
                width: 100%;
                height: 100%;
            }
            
            .mce-character-editor {
                width: 320px;
                min-width: 320px;
                max-width: 320px;
                height: 100%;
                border-right: 1px solid rgba(255, 255, 255, 0.08);
                overflow: hidden;
                background: #2a2a3e;
                margin: 0 !important;
                padding: 0 !important;
                align-self: stretch;
                display: flex;
                flex-direction: column;
            }
            
            .mce-mask-editor {
                position: relative;
                background: #1a1a26;
                min-height: 0;
                min-width: 0;
                flex: 1;
                overflow: hidden;
                border-radius: 0; /* 🔧 关键修复：调整边框半径，与mce-main-area保持一致 */
                display: flex; /* 使用flex布局确保内容填满 */
                flex-direction: column;
                padding: 0 !important;
                margin: 0 !important;
                gap: 0 !important;
                align-items: stretch;
                justify-content: flex-start;
            }
            
            .mce-output-area {
                height: 150px;
                background: #2a2a3e;
                border-top: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 0 0 10px 10px; /* 🔧 关键修复：调整边框半径，与其他组件保持一致 */
                margin: 0; /* 🔧 关键修复：移除margin，确保填满整个节点 */
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.1);
            }
            
            .mce-toolbar {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 14px 20px;
                background: #2a2a3e;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                flex-shrink: 0;
                flex-wrap: wrap;
                position: relative;
                z-index: 5;
            }
            
            .mce-toolbar-section {
                display: flex;
                align-items: center;
                gap: 10px;
            }
            
            .mce-toolbar-section-right {
                margin-left: auto;
            }
            
            .mce-toolbar-label {
                font-size: 12px;
                color: rgba(224, 224, 224, 0.8);
                white-space: nowrap;
                font-weight: 500;
            }
            
            .mce-select, .mce-input {
                padding: 6px 12px;
                background: #1a1a26;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                color: #E0E0E0;
                font-size: 12px;
                transition: background-color 0.15s ease, border-color 0.15s ease;
                will-change: auto;
            }
            
            .mce-select:hover, .mce-input:hover {
                background: #262632;
                border-color: rgba(255, 255, 255, 0.15);
            }
            
            .mce-select:focus, .mce-input:focus {
                outline: none;
                border-color: #7c3aed;
                box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.2);
            }
            
            .mce-checkbox {
                width: 16px;
                height: 16px;
                margin: 0;
                vertical-align: middle;
                accent-color: #7c3aed;
            }
            
            .mce-checkbox-label {
                font-size: 12px;
                color: #E0E0E0;
                margin-left: 6px;
                cursor: pointer;
                user-select: none;
            }
            
            /* Switch开关样式 */
            .mce-switch {
                position: relative;
                display: inline-block;
                width: 44px;
                height: 22px;
                margin-right: 8px;
            }
            
            .mce-switch-input {
                opacity: 0;
                width: 0;
                height: 0;
            }
            
            .mce-switch-slider {
                position: absolute;
                cursor: pointer;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background-color: #444;
                transition: 0.3s;
                border-radius: 22px;
            }
            
            .mce-switch-slider:before {
                position: absolute;
                content: "";
                height: 16px;
                width: 16px;
                left: 3px;
                bottom: 3px;
                background-color: white;
                transition: 0.3s;
                border-radius: 50%;
            }
            
            .mce-switch-input:checked + .mce-switch-slider {
                background-color: #7c3aed;
            }
            
            .mce-switch-input:focus + .mce-switch-slider {
                box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.3);
            }
            
            .mce-switch-input:checked + .mce-switch-slider:before {
                transform: translateX(22px);
            }
            
            .mce-switch-label {
                font-size: 12px;
                color: #E0E0E0;
                vertical-align: middle;
                user-select: none;
            }
            
            .mce-button {
                padding: 8px 14px;
                background: #404054;
                border: 1px solid rgba(255, 255, 255, 0.1);
                border-radius: 6px;
                color: #E0E0E0;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background-color 0.15s ease, transform 0.1s ease;
                display: flex;
                align-items: center;
                gap: 6px;
                position: relative;
                overflow: hidden;
                will-change: transform;
            }
            
            .mce-button:hover {
                background: #4a4a5e;
                border-color: rgba(124, 58, 237, 0.4);
                transform: translateY(-1px);
            }
            
            .mce-button:active {
                transform: translateY(0);
            }
            
            .mce-button svg {
                flex-shrink: 0;
                transition: transform 0.1s ease;
            }
            
            .mce-button:hover svg {
                transform: scale(1.05);
            }
            
            .mce-button-icon {
                padding: 8px 12px;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                white-space: nowrap;
            }
            
            .mce-button-icon span {
                white-space: nowrap;
            }
            
            /* 增强按钮交互反馈 */
            .mce-button:focus {
                outline: none;
                box-shadow: 0 0 0 2px rgba(124, 58, 237, 0.5);
            }
            
            /* 🎨 预设管理按钮特殊样式 */
            #mce-preset-management {
                background: linear-gradient(135deg, #7c3aed 0%, #8b5cf6 100%);
                border: 2px solid rgba(139, 92, 246, 0.5);
                font-weight: 600;
            }
            
            #mce-preset-management:hover {
                background: linear-gradient(135deg, #8b5cf6 0%, #a78bfa 100%);
                transform: translateY(-1px);
            }
            
            #mce-preset-management svg {
                filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
            }
        `;

        document.head.appendChild(style);
    }

    bindEvents() {
        // 使用setTimeout确保DOM元素已经创建
        setTimeout(() => {
            try {
                // 语法模式切换
                const syntaxMode = document.getElementById('mce-syntax-mode');
                if (syntaxMode) {
                    syntaxMode.addEventListener('change', (e) => {
                        const newSyntaxMode = e.target.value;

                        // 更新配置
                        this.editor.dataManager.updateConfig({ syntax_mode: newSyntaxMode });

                        // 立即刷新角色列表的语法类型
                        this.updateAllCharactersSyntaxType(newSyntaxMode);

                        // 刷新角色列表UI显示
                        if (this.editor.components.characterEditor) {
                            this.editor.components.characterEditor.renderCharacterList();
                        }

                        // 刷新提示词预览
                        if (this.editor.components.outputArea) {
                            this.editor.components.outputArea.updatePromptPreview();
                        }

                        // 显示切换成功提示
                        const modeName = newSyntaxMode === 'regional_prompts' ? '区域提示词' : '注意力耦合';
                        this.editor.languageManager.showMessage(`已切换到${modeName}模式`, 'success');
                    });
                }


                // 刷新画布
                const refreshCanvas = document.getElementById('mce-refresh-canvas');
                if (refreshCanvas) {
                    refreshCanvas.addEventListener('click', () => {
                        this.refreshCanvas();
                        this.languageManager.showMessage(this.languageManager.t('canvasRefreshed'), 'success');
                    });
                }

                // 语言切换
                const languageToggle = document.getElementById('mce-language-toggle');
                if (languageToggle) {
                    languageToggle.addEventListener('click', () => {
                        const currentLang = this.languageManager.getLanguage();
                        const newLang = currentLang === 'zh' ? 'en' : 'zh';

                        if (this.languageManager.setLanguage(newLang)) {
                            // 更新整个界面的文本
                            this.languageManager.updateInterfaceTexts();

                            this.languageManager.showMessage(
                                newLang === 'zh' ? this.languageManager.t('switchedToChinese') : this.languageManager.t('switchedToEnglish'),
                                'success'
                            );

                            // 更新智能补全缓存系统的语言
                            if (typeof globalAutocompleteCache !== 'undefined') {
                                globalAutocompleteCache.setLanguage(newLang);
                            }
                        }
                    });
                }

                // 语法文档
                const syntaxDocs = document.getElementById('mce-syntax-docs');
                if (syntaxDocs) {
                    syntaxDocs.addEventListener('click', () => {
                        this.showSyntaxDocs();
                    });
                }

                // 预设管理
                const presetManagement = document.getElementById('mce-preset-management');
                if (presetManagement) {
                    presetManagement.addEventListener('click', () => {
                        if (this.editor.presetManager) {
                            this.editor.presetManager.showPresetManagementPanel();
                        }
                    });
                }

                // 设置
                const settings = document.getElementById('mce-settings');
                if (settings) {
                    settings.addEventListener('click', () => {
                        this.showSettings();
                    });
                }


            } catch (error) {
                logger.error("绑定Toolbar事件时发生错误:", error);
            }
        }, 100); // 延迟100ms确保DOM完全渲染
    }


    refreshCanvas() {
        // 获取当前节点的画布宽度和高度引脚
        const node = this.editor.node;
        const canvasWidthWidget = node.widgets.find(w => w.name === 'canvas_width');
        const canvasHeightWidget = node.widgets.find(w => w.name === 'canvas_height');

        if (canvasWidthWidget && canvasHeightWidget) {
            const width = canvasWidthWidget.value;
            const height = canvasHeightWidget.value;

            // 🔧 关键修复：检查null、undefined和空字符串
            // 如果引脚值无效（null/undefined/空字符串/小于等于0），使用默认值1024
            const canvasWidth = (width !== null && width !== undefined && width !== "" && width > 0) ? width : 1024;
            const canvasHeight = (height !== null && height !== undefined && height !== "" && height > 0) ? height : 1024;

            // 更新配置中的画布尺寸
            this.editor.dataManager.updateConfig({
                canvas: {
                    ...this.editor.dataManager.config.canvas,
                    width: canvasWidth,
                    height: canvasHeight
                }
            });

            // 重置缩放和居中偏移
            if (this.editor.components.maskEditor) {
                const maskEditor = this.editor.components.maskEditor;
                const config = this.editor.dataManager.getConfig();

                if (config && config.canvas) {
                    const { width: canvasWidth, height: canvasHeight } = config.canvas;
                    const containerWidth = maskEditor.canvas.clientWidth || maskEditor.container.clientWidth || canvasWidth;
                    const containerHeight = maskEditor.canvas.clientHeight || maskEditor.container.clientHeight || canvasHeight;

                    // 设置缩放为1并计算居中偏移
                    maskEditor.scale = 1;
                    maskEditor.offset.x = (containerWidth - canvasWidth) / 2;
                    maskEditor.offset.y = (containerHeight - canvasHeight) / 2;

                    // 强制触发画布重新调整
                    setTimeout(() => {
                        maskEditor.resizeCanvas();
                        maskEditor.scheduleRender();
                    }, 100);
                }
            }

            // 额外刷新一次画布大小，确保从节点缓存的数据中获取最新的引脚值
            setTimeout(() => {
                this.refreshCanvasFromNodePins();
            }, 200);


        }
    }

    // 从节点引脚刷新画布大小
    refreshCanvasFromNodePins() {
        const node = this.editor.node;
        const canvasWidthWidget = node.widgets.find(w => w.name === 'canvas_width');
        const canvasHeightWidget = node.widgets.find(w => w.name === 'canvas_height');

        if (canvasWidthWidget && canvasHeightWidget) {
            const width = canvasWidthWidget.value;
            const height = canvasHeightWidget.value;

            // 🔧 关键修复：检查null、undefined和空字符串
            // 如果引脚值无效（null/undefined/空字符串/小于等于0），使用默认值1024
            const canvasWidth = (width !== null && width !== undefined && width !== "" && width > 0) ? width : 1024;
            const canvasHeight = (height !== null && height !== undefined && height !== "" && height > 0) ? height : 1024;

            // 检查画布尺寸是否需要更新
            const currentConfig = this.editor.dataManager.config.canvas;
            if (currentConfig.width !== canvasWidth || currentConfig.height !== canvasHeight) {
                // 更新配置中的画布尺寸
                this.editor.dataManager.updateConfig({
                    canvas: {
                        ...currentConfig,
                        width: canvasWidth,
                        height: canvasHeight
                    }
                });

                // 强制触发画布重新调整
                if (this.editor.components.maskEditor) {
                    setTimeout(() => {
                        this.editor.components.maskEditor.resizeCanvas();
                        this.editor.components.maskEditor.scheduleRender();
                    }, 100);
                }


            }
        }
    }


    async showSyntaxDocs() {
        // 根据当前语言设置显示对应版本的文档
        const currentLang = this.languageManager.getLanguage();
        const isZh = currentLang === 'zh' || currentLang === 'zh-CN';

        // 构建文档URL
        const docsUrl = isZh
            ? `/multi_character_editor/doc/complete_syntax_guide.md`
            : `/multi_character_editor/doc/complete_syntax_guide_en.md`;

        try {
            // 获取文档内容
            const response = await fetch(docsUrl);
            if (!response.ok) {
                throw new Error('Failed to load documentation');
            }

            const docsContent = await response.text();

            // 创建模态对话框显示文档
            this.createDocsModal(docsContent, isZh);

        } catch (error) {
            logger.error('Failed to load documentation:', error);
            this.languageManager.showMessage(
                isZh ? '加载文档失败' : 'Failed to load documentation',
                'error'
            );
        }
    }

    createDocsModal(content, isZh) {
        // 创建模态对话框
        const modal = document.createElement('div');
        modal.className = 'mce-docs-modal';
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease-out;
        `;

        // 创建内容容器
        const contentContainer = document.createElement('div');
        contentContainer.className = 'mce-docs-content';
        contentContainer.style.cssText = `
            width: 90%;
            max-width: 900px;
            height: 80%;
            max-height: 700px;
            background: #2a2a3e;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            display: flex;
            flex-direction: column;
            overflow: hidden;
            position: relative;
        `;

        // 创建标题栏
        const header = document.createElement('div');
        header.className = 'mce-docs-header';
        header.style.cssText = `
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            background: #1e1e2e;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            color: #E0E0E0;
        `;

        const title = document.createElement('h3');
        title.textContent = isZh ? '多人角色提示词语法指南' : 'Multi-Character Prompt Syntax Guide';
        title.style.cssText = `
            margin: 0;
            font-size: 16px;
            font-weight: 600;
        `;

        const closeButton = document.createElement('button');
        closeButton.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
        `;
        closeButton.style.cssText = `
            background: none;
            border: none;
            color: #E0E0E0;
            cursor: pointer;
            padding: 4px;
            border-radius: 4px;
            transition: background-color 0.15s ease;
        `;
        closeButton.addEventListener('click', () => {
            document.body.removeChild(modal);
        });
        closeButton.addEventListener('mouseenter', () => {
            closeButton.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
        });
        closeButton.addEventListener('mouseleave', () => {
            closeButton.style.backgroundColor = 'transparent';
        });

        header.appendChild(title);
        header.appendChild(closeButton);

        // 创建文档内容区域
        const docsArea = document.createElement('div');
        docsArea.className = 'mce-docs-area';
        docsArea.style.cssText = `
            flex: 1;
            padding: 20px;
            overflow-y: auto;
            color: #E0E0E0;
            font-size: 14px;
            line-height: 1.6;
            white-space: pre-wrap;
        `;

        // 将Markdown内容转换为HTML
        const htmlContent = this.markdownToHtml(content);
        docsArea.innerHTML = htmlContent;

        // 组装模态对话框
        contentContainer.appendChild(header);
        contentContainer.appendChild(docsArea);
        modal.appendChild(contentContainer);

        // 添加点击背景关闭功能
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
            }
        });

        // 添加到页面
        document.body.appendChild(modal);

        // 添加样式
        this.addDocsModalStyles();
    }

    markdownToHtml(markdown) {
        // 简单的Markdown到HTML转换
        let html = markdown;

        // 转换标题
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

        // 转换粗体
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

        // 转换代码块
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

        // 转换链接
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

        // 转换表格 - 简化处理，只处理基本的表格格式
        // 先将表格行转换为HTML
        html = html.replace(/^[|](.+)[|]$/gm, '<tr><td>$1</td></tr>');
        // 将每行的单元格分隔
        html = html.replace(/<tr><td>(.+?)<\/td><\/tr>/g, (match, content) => {
            const cells = content.split('|').map(cell => `<td>${cell.trim()}</td>`).join('');
            return `<tr>${cells}</tr>`;
        });
        // 添加表格标签
        html = html.replace(/(<tr>.*<\/tr>)/s, '<table><tbody>$1</tbody></table>');

        // 转换列表
        html = html.replace(/^- (.+)$/gim, '<li>$1</li>');
        html = html.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');

        // 转换段落
        html = html.replace(/\n\n/g, '</p><p>');
        html = '<p>' + html + '</p>';

        // 清理空段落
        html = html.replace(/<p><\/p>/g, '');
        html = html.replace(/<p>(<h[1-6]>)/g, '$1');
        html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
        html = html.replace(/<p>(<table>)/g, '$1');
        html = html.replace(/(<\/table>)<\/p>/g, '$1');
        html = html.replace(/<p>(<ul>)/g, '$1');
        html = html.replace(/(<\/ul>)<\/p>/g, '$1');
        html = html.replace(/<p>(<pre>)/g, '$1');
        html = html.replace(/(<\/pre>)<\/p>/g, '$1');

        return html;
    }

    addDocsModalStyles() {
        // 检查是否已添加样式
        if (document.querySelector('#mce-docs-modal-styles')) return;

        const style = document.createElement('style');
        style.id = 'mce-docs-modal-styles';
        style.textContent = `
            .mce-docs-modal h1, .mce-docs-modal h2, .mce-docs-modal h3 {
                color: #7c3aed;
                margin-top: 24px;
                margin-bottom: 16px;
            }
            
            .mce-docs-modal h1 {
                font-size: 24px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.1);
                padding-bottom: 8px;
            }
            
            .mce-docs-modal h2 {
                font-size: 20px;
            }
            
            .mce-docs-modal h3 {
                font-size: 18px;
            }
            
            .mce-docs-modal p {
                margin-bottom: 16px;
            }
            
            .mce-docs-modal code {
                background: rgba(124, 58, 237, 0.2);
                padding: 2px 6px;
                border-radius: 4px;
                font-family: 'Consolas', 'Monaco', monospace;
                font-size: 13px;
            }
            
            .mce-docs-modal pre {
                background: #1a1a26;
                padding: 16px;
                border-radius: 8px;
                overflow-x: auto;
                margin-bottom: 16px;
            }
            
            .mce-docs-modal pre code {
                background: none;
                padding: 0;
            }
            
            .mce-docs-modal table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 16px;
            }
            
            .mce-docs-modal th, .mce-docs-modal td {
                border: 1px solid rgba(255, 255, 255, 0.1);
                padding: 8px 12px;
                text-align: left;
            }
            
            .mce-docs-modal th {
                background: rgba(124, 58, 237, 0.2);
                font-weight: 600;
            }
            
            .mce-docs-modal ul {
                margin-bottom: 16px;
                padding-left: 24px;
            }
            
            .mce-docs-modal li {
                margin-bottom: 4px;
            }
            
            .mce-docs-modal a {
                color: #7c3aed;
                text-decoration: none;
            }
            
            .mce-docs-modal a:hover {
                text-decoration: underline;
            }
            
            .mce-docs-modal strong {
                color: #a78bfa;
            }
            
            /* 滚动条样式 */
            .mce-docs-area::-webkit-scrollbar {
                width: 8px;
            }
            
            .mce-docs-area::-webkit-scrollbar-track {
                background: rgba(255, 255, 255, 0.05);
                border-radius: 4px;
            }
            
            .mce-docs-area::-webkit-scrollbar-thumb {
                background: rgba(124, 58, 237, 0.5);
                border-radius: 4px;
            }
            
            .mce-docs-area::-webkit-scrollbar-thumb:hover {
                background: rgba(124, 58, 237, 0.7);
            }
        `;
        document.head.appendChild(style);
    }

    showSettings() {
        if (this.editor.components.settingsMenu) {
            this.editor.components.settingsMenu.show();
        }
    }

    updateUI(config) {


        // 确保config对象存在
        if (!config) {
            logger.warn('配置对象不存在，跳过UI更新');
            return;
        }

        // 更新语法模式
        const syntaxModeElement = document.getElementById('mce-syntax-mode');
        if (syntaxModeElement) {
            syntaxModeElement.value = config.syntax_mode || 'attention_couple';
        }

    }

    /**
     * 更新所有角色的语法类型
     * @param {string} syntaxMode - 新的语法模式 ('attention_couple' 或 'regional_prompts')
     */
    updateAllCharactersSyntaxType(syntaxMode) {
        try {
            const config = this.editor.dataManager.getConfig();
            if (!config || !config.characters || !Array.isArray(config.characters)) {
                logger.warn('[Toolbar] updateAllCharactersSyntaxType: 没有角色数据需要更新');
                return;
            }

            const isRegionalMode = syntaxMode === 'regional_prompts';
            let updatedCount = 0;

            // 更新所有角色的语法类型
            config.characters.forEach(character => {
                if (isRegionalMode) {
                    // 切换到区域提示词模式时，默认使用MASK（符合用户要求）
                    if (character.syntax_type !== 'REGION' && character.syntax_type !== 'MASK') {
                        character.syntax_type = 'MASK';  // 用户要求默认使用MASK
                        character.use_mask_syntax = true;
                        updatedCount++;
                    }
                } else {
                    // 切换到注意力耦合模式时，固定使用COUPLE
                    if (character.syntax_type !== 'COUPLE') {
                        character.syntax_type = 'COUPLE';
                        character.use_mask_syntax = true;
                        updatedCount++;
                    }
                }
            });

            // 保存更新后的配置
            if (updatedCount > 0) {
                this.editor.dataManager.updateConfig(config);
                logger.info(`[Toolbar] updateAllCharactersSyntaxType: 已更新 ${updatedCount} 个角色的语法类型`);
            }

        } catch (error) {
            logger.error('[Toolbar] updateAllCharactersSyntaxType 出错:', error);
            this.editor.languageManager.showMessage('更新角色语法类型时出错', 'error');
        }
    }
}

// 注册ComfyUI扩展
app.registerExtension({
    name: "Comfy.MultiCharacterEditor",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {

        if (nodeData.name === "MultiCharacterEditorNode") {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {

                if (onNodeCreated) {
                    onNodeCreated.apply(this, arguments);
                }

                // 设置节点初始大小和最小尺寸
                // 宽度：角色编辑器(550px) + 画布区域(至少600px) = 1150px
                // 高度：工具栏 + 画布 + 输出区域(250px) = 至少900px
                this.size = [1200, 950];
                this.min_size = [1200, 950];

                // 存储原始的computeSize方法
                const originalComputeSize = this.computeSize;

                // 重写computeSize方法以动态计算最小尺寸
                // 恢复原始的 computeSize
                this.computeSize = originalComputeSize;

                // 存储原始的onResize方法
                const originalOnResize = this.onResize;

                // 重写onResize方法以处理大小变化
                this.onResize = function (size) {
                    // 调用原始方法
                    if (originalOnResize) {
                        originalOnResize.call(this, size);
                    }

                    // 通知编辑器实例大小已变化
                    if (MultiCharacterEditorInstance) {
                        MultiCharacterEditorInstance.handleResize(size);
                    }
                };

                // 存储原始的onExecute方法
                const originalOnExecute = this.onExecuted;

                // 基本的节点创建完成，后端会处理输出

                // 重写onExecuted方法以在节点执行后刷新画布和更新输出
                this.onExecuted = function (output) {
                    // 调用原始方法
                    if (originalOnExecute) {
                        originalOnExecute.apply(this, arguments);
                    }

                    // 节点执行后刷新画布和更新预览
                    if (MultiCharacterEditorInstance) {
                        setTimeout(() => {
                            // 强制使用前端生成的提示词更新预览
                            MultiCharacterEditorInstance.updateOutput();

                            // 额外确保预览也更新
                            if (MultiCharacterEditorInstance.components.outputArea) {
                                MultiCharacterEditorInstance.components.outputArea.updatePromptPreview();
                            }
                        }, 100);
                    }

                    // 节点执行后刷新画布
                    if (MultiCharacterEditorInstance && MultiCharacterEditorInstance.components.toolbar) {
                        setTimeout(() => {
                            MultiCharacterEditorInstance.components.toolbar.refreshCanvas();
                        }, 100);
                    }
                };

                try {
                    // 隐藏非必要的widgets，保留必要的引脚
                    this.widgets.forEach(widget => {
                        // 保留画布宽度、高度和base_prompt引脚的显示
                        if (widget.name === 'canvas_width' || widget.name === 'canvas_height' || widget.name === 'base_prompt') {
                            return;
                        }

                        // 隐藏其他widgets
                        widget.computeSize = () => [0, -4];
                        widget.draw = () => { };
                        widget.type = "hidden";
                    });

                    // 创建编辑器实例，不依赖config_data widget
                    MultiCharacterEditorInstance = new MultiCharacterEditor(this, null);

                    // 添加防抖保存
                    MultiCharacterEditorInstance.saveConfigDebounced = debounce(() => {
                        MultiCharacterEditorInstance.saveConfig();
                    }, 1000);

                    // 添加DOM显示容器
                    this.addDOMWidget("multi_character_editor", "div", MultiCharacterEditorInstance.container);

                    // 添加一个隐藏的widget来保存和传递状态
                    const self = this;
                    if (!this.widgets) {
                        this.widgets = [];
                    }

                    let configWidget = this.widgets.find(w => w.name === "mce_config");
                    if (!configWidget) {
                        configWidget = this.addWidget("STRING", "mce_config", "", () => { }, {
                            multiline: true,
                            serialize: false, // Don't show it in the properties panel
                        });

                        configWidget.serialize_value = async (node, widget_slot) => {
                            // 当工作流被保存时，返回当前的配置
                            if (MultiCharacterEditorInstance && MultiCharacterEditorInstance.dataManager) {
                                const config = MultiCharacterEditorInstance.dataManager.getConfig();

                                return JSON.stringify(config, null, 2);
                            }
                            return "{}";
                        };
                        // 隐藏这个widget
                        if (configWidget.inputEl) {
                            configWidget.inputEl.style.display = "none";
                        }
                    }

                    // 不再需要config_data widget的初始化

                    // 初始化时读取宽高引脚的值
                    setTimeout(() => {
                        const canvasWidthWidget = this.widgets.find(w => w.name === 'canvas_width');
                        const canvasHeightWidget = this.widgets.find(w => w.name === 'canvas_height');

                        if (canvasWidthWidget && canvasHeightWidget && MultiCharacterEditorInstance) {
                            const width = canvasWidthWidget.value;
                            const height = canvasHeightWidget.value;

                            // 无论引脚值是否为null，都更新配置中的画布尺寸
                            // 如果引脚值为null，使用默认值1024
                            const canvasWidth = width !== null ? width : 1024;
                            const canvasHeight = height !== null ? height : 1024;

                            // 更新配置中的画布尺寸
                            MultiCharacterEditorInstance.dataManager.updateConfig({
                                canvas: {
                                    ...MultiCharacterEditorInstance.dataManager.config.canvas,
                                    width: canvasWidth,
                                    height: canvasHeight
                                }
                            });

                            // 强制触发画布重新调整
                            setTimeout(() => {
                                if (MultiCharacterEditorInstance.components.maskEditor) {
                                    MultiCharacterEditorInstance.components.maskEditor.resizeCanvas();
                                    MultiCharacterEditorInstance.components.maskEditor.scheduleRender();
                                }
                            }, 100);
                        }
                    }, 500);

                    // 重写onWidgetChanged方法来监听引脚值变化
                    const onWidgetChanged = this.onWidgetChanged;
                    this.onWidgetChanged = function (widget, value) {
                        if (onWidgetChanged) {
                            onWidgetChanged.apply(this, arguments);
                        }

                        // 当画布宽度或高度引脚值变化时，更新画布
                        if (widget.name === 'canvas_width' || widget.name === 'canvas_height') {
                            if (MultiCharacterEditorInstance) {
                                const canvasWidthWidget = this.widgets.find(w => w.name === 'canvas_width');
                                const canvasHeightWidget = this.widgets.find(w => w.name === 'canvas_height');

                                if (canvasWidthWidget && canvasHeightWidget) {
                                    const width = canvasWidthWidget.value;
                                    const height = canvasHeightWidget.value;

                                    // 无论引脚值是否为null，都更新配置中的画布尺寸
                                    // 如果引脚值为null，使用默认值1024
                                    const canvasWidth = width !== null ? width : 1024;
                                    const canvasHeight = height !== null ? height : 1024;

                                    // 更新配置中的画布尺寸
                                    MultiCharacterEditorInstance.dataManager.updateConfig({
                                        canvas: {
                                            ...MultiCharacterEditorInstance.dataManager.config.canvas,
                                            width: canvasWidth,
                                            height: canvasHeight
                                        }
                                    });

                                    // 立即强制触发画布重新调整，不使用延迟
                                    if (MultiCharacterEditorInstance.components.maskEditor) {
                                        const maskEditor = MultiCharacterEditorInstance.components.maskEditor;
                                        const config = MultiCharacterEditorInstance.dataManager.getConfig();

                                        if (config && config.canvas) {
                                            const { width: canvasWidth, height: canvasHeight } = config.canvas;
                                            const containerWidth = maskEditor.canvas.clientWidth || maskEditor.container.clientWidth || canvasWidth;
                                            const containerHeight = maskEditor.canvas.clientHeight || maskEditor.container.clientHeight || canvasHeight;

                                            // 重置缩放并设置居中偏移
                                            maskEditor.scale = 1;
                                            maskEditor.offset.x = (containerWidth - canvasWidth) / 2;
                                            maskEditor.offset.y = (containerHeight - canvasHeight) / 2;
                                        }

                                        // 立即调整画布大小
                                        MultiCharacterEditorInstance.components.maskEditor.resizeCanvas();

                                        // 立即触发重新渲染
                                        MultiCharacterEditorInstance.components.maskEditor.scheduleRender();

                                        // 添加额外的渲染调用，确保画布完全更新
                                        setTimeout(() => {
                                            if (MultiCharacterEditorInstance.components.maskEditor) {
                                                MultiCharacterEditorInstance.components.maskEditor.resizeCanvas();
                                                MultiCharacterEditorInstance.components.maskEditor.scheduleRender();
                                            }
                                        }, 50);
                                    }
                                }
                            }
                        }

                        // 当base_prompt引脚值变化时，更新配置并重新生成提示词
                        if (widget.name === 'base_prompt') {
                            if (MultiCharacterEditorInstance) {
                                // 更新配置中的base_prompt，处理null或undefined的情况
                                MultiCharacterEditorInstance.dataManager.updateConfig({
                                    base_prompt: (value !== null && value !== undefined) ? value : ''
                                });

                                // 立即更新输出
                                MultiCharacterEditorInstance.updateOutput();
                            }
                        }
                    };

                    // 强制节点重新计算大小，确保不小于最小尺寸
                    const computedSize = this.computeSize();
                    this.size = [
                        Math.max(computedSize[0], 1200),
                        Math.max(computedSize[1], 950)
                    ];
                    this.setDirtyCanvas(true, true);

                    // 初始化时触发一次大小调整
                    setTimeout(() => {
                        if (MultiCharacterEditorInstance) {
                            MultiCharacterEditorInstance.handleResize(this.size);
                        }
                    }, 100);


                } catch (error) {
                    logger.error("创建节点时发生错误:", error);
                }
            };

            const onNodeRemoved = nodeType.prototype.onNodeRemoved;
            nodeType.prototype.onNodeRemoved = function () {

                MultiCharacterEditorInstance = null;
                if (onNodeRemoved) {
                    onNodeRemoved.apply(this, arguments);
                }
            };

            // 关键修复：当工作流加载时，从widget恢复配置
            const onConfigure = nodeType.prototype.onConfigure;
            nodeType.prototype.onConfigure = function (info) {
                if (onConfigure) {
                    onConfigure.apply(this, arguments);
                }
                if (info.widgets_values && MultiCharacterEditorInstance) {
                    const configStr = info.widgets_values[this.widgets.findIndex(w => w.name === "mce_config")];
                    if (configStr) {
                        logger.info('[DEBUG] onConfigure: 开始恢复配置');
                        try {
                            const config = JSON.parse(configStr);
                            if (config) {
                                // 🔧 关键修复：验证并修复配置，确保canvas尺寸有效
                                const validatedConfig = MultiCharacterEditorInstance.validateAndFixConfig(config);
                                logger.info('[DEBUG] onConfigure: 配置验证成功', {
                                    charactersCount: validatedConfig.characters?.length || 0,
                                    canvasWidth: validatedConfig.canvas?.width,
                                    canvasHeight: validatedConfig.canvas?.height
                                });
                                // 使用DataManager恢复状态
                                MultiCharacterEditorInstance.dataManager.config = validatedConfig;

                                // 🔧 关键修复：将验证后的canvas尺寸写回到widget，确保widget值与配置一致
                                const canvasWidthWidget = this.widgets.find(w => w.name === 'canvas_width');
                                const canvasHeightWidget = this.widgets.find(w => w.name === 'canvas_height');
                                if (canvasWidthWidget && validatedConfig.canvas) {
                                    canvasWidthWidget.value = validatedConfig.canvas.width;
                                }
                                if (canvasHeightWidget && validatedConfig.canvas) {
                                    canvasHeightWidget.value = validatedConfig.canvas.height;
                                }
                                logger.info('[DEBUG] onConfigure: Widget值已更新', {
                                    canvasWidthValue: canvasWidthWidget?.value,
                                    canvasHeightValue: canvasHeightWidget?.value
                                });

                                // 强制刷新节点尺寸，确保不小于最小尺寸
                                this.size = [
                                    Math.max(this.size[0], 1200),
                                    Math.max(this.size[1], 950)
                                ];
                                this.setDirtyCanvas(true, true);

                                // 🔧 关键修复：先调整画布尺寸，再恢复配置
                                setTimeout(() => {
                                    logger.info('[DEBUG] onConfigure: 开始恢复画布尺寸');
                                    logger.info('[DEBUG] onConfigure: MultiCharacterEditorInstance:', !!MultiCharacterEditorInstance);
                                    logger.info('[DEBUG] onConfigure: components:', !!MultiCharacterEditorInstance?.components);
                                    logger.info('[DEBUG] onConfigure: maskEditor:', !!MultiCharacterEditorInstance?.components?.maskEditor);
                                    logger.info('[DEBUG] onConfigure: resizeCanvasWithRetry存在:', typeof MultiCharacterEditorInstance?.components?.maskEditor?.resizeCanvasWithRetry);

                                    if (MultiCharacterEditorInstance && MultiCharacterEditorInstance.components.maskEditor) {
                                        logger.info('[DEBUG] onConfigure: 准备调用 resizeCanvasWithRetry');
                                        // 强制重新计算画布尺寸，使用重试机制
                                        MultiCharacterEditorInstance.components.maskEditor.resizeCanvasWithRetry();
                                        logger.info('[DEBUG] onConfigure: resizeCanvasWithRetry 调用完成');
                                    } else {
                                        logger.error('[MultiCharacterEditor] onConfigure: 无法调用 resizeCanvasWithRetry，组件不存在');
                                    }
                                }, 100);

                                // 🔧 关键修复：等待画布尺寸初始化后，再恢复配置
                                setTimeout(() => {
                                    logger.info('[DEBUG] onConfigure: 开始恢复配置数据');
                                    // 触发UI更新（使用验证后的配置）
                                    // onConfigRestored 会在200ms后同步蒙版数据
                                    MultiCharacterEditorInstance.eventBus.emit('config:restored', validatedConfig);
                                }, 400);

                                // 🔧 额外的延迟渲染，再次确保蒙版位置正确
                                setTimeout(() => {
                                    if (MultiCharacterEditorInstance && MultiCharacterEditorInstance.components.maskEditor) {
                                        // 🔧 关键修复：在同步蒙版之前，强制重新初始化画布尺寸和坐标系统
                                        const maskEditor = MultiCharacterEditorInstance.components.maskEditor;
                                        const config = MultiCharacterEditorInstance.dataManager.getConfig();

                                        if (config && config.canvas && maskEditor.canvas) {
                                            const { width: canvasWidth, height: canvasHeight } = config.canvas;

                                            // 🔧 关键修复：使用 canvas 元素的 clientWidth/clientHeight
                                            // 因为 canvas 的显示尺寸是正确的，而容器可能受到其他因素影响
                                            const containerWidth = maskEditor.canvas.clientWidth || maskEditor.container.clientWidth;
                                            const containerHeight = maskEditor.canvas.clientHeight || maskEditor.container.clientHeight;

                                            logger.info('[DEBUG] onConfigure: 尺寸来源', {
                                                canvasClientWidth: maskEditor.canvas.clientWidth,
                                                canvasClientHeight: maskEditor.canvas.clientHeight,
                                                containerClientWidth: maskEditor.container.clientWidth,
                                                containerClientHeight: maskEditor.container.clientHeight,
                                                '使用': `${containerWidth}x${containerHeight}`
                                            });

                                            // 计算缩放比例并设置居中偏移
                                            maskEditor.scale = Math.min(containerWidth / canvasWidth, containerHeight / canvasHeight);
                                            // 计算居中位置的偏移量
                                            maskEditor.offset.x = (containerWidth - canvasWidth * maskEditor.scale) / 2;
                                            maskEditor.offset.y = (containerHeight - canvasHeight * maskEditor.scale) / 2;

                                            // 更新记录的容器尺寸
                                            maskEditor.lastContainerSize.width = containerWidth;
                                            maskEditor.lastContainerSize.height = containerHeight;

                                            logger.info('[DEBUG] onConfigure: 强制重新初始化坐标系统', {
                                                canvasSize: `${canvasWidth}x${canvasHeight}`,
                                                containerSize: `${containerWidth}x${containerHeight}`,
                                                scale: maskEditor.scale,
                                                offset: maskEditor.offset
                                            });
                                        }

                                        // 最后再同步一次，确保数据完全正确
                                        maskEditor.syncMasksFromCharacters();
                                        maskEditor.scheduleRender();
                                        logger.info('[DEBUG] onConfigure: 画布完全恢复，最终蒙版数量:',
                                            maskEditor.masks?.length || 0);
                                    }
                                }, 800);
                            }
                        } catch (e) {
                            logger.error("[DEBUG] onConfigure: Failed to parse config from widget.", e);
                        }
                    }
                }
            }
        }
    }
});


