/**
 * Simple Load Image - 前端JavaScript扩展
 * 仅负责把后端推送的提示消息转成 Toast（Krita 集成已停用，见 legacy/js/open_in_krita/）
 */

import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";
import { globalToastManager } from "../global/toast_manager.js";
import { createLogger } from '../global/logger_client.js';

// 创建logger实例
const logger = createLogger('simple_load_image');

app.registerExtension({
    name: "simple_load_image",

    async init(app) {
        // 监听后端推送的Toast通知
        api.addEventListener("simple-load-image-notification", (event) => {
            const { message, type } = event.detail;
            const duration = type === "success" ? 3000 : 5000;
            globalToastManager.showToast(message, type || "info", duration);
        });
    },
});

logger.info("[SimpleLoadImage] Frontend extension loaded");
