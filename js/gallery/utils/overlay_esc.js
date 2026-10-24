/**
 * 弹窗 / 浮层 ESC 关闭的配对辅助
 *
 * 以前的写法（本项目里重复出现 6 处）：
 *
 *   const escHandler = (e) => {
 *       if (e.key === 'Escape') {
 *           overlay.remove();
 *           document.removeEventListener('keydown', escHandler);
 *       }
 *   };
 *   document.addEventListener('keydown', escHandler);
 *
 * 这种写法只在 ESC 这一条关闭路径上解绑；点取消、点确认、点遮罩关闭时，
 * document 上会残留一个闭包，闭包又卡住整个 overlay，节点反复开关就线性泄漏。
 *
 * 本模块把注册和解绑配对起来：
 *   - 注册一次 document keydown；
 *   - 包装 overlay.remove()，任何走 overlay.remove() 的关闭路径都会自动解绑；
 *   - 返回幂等的 dispose()，供不经过 remove() 的关闭路径显式调用。
 *
 * 用法：
 *   bindEscDismiss(overlay);                                    // 关闭 = overlay.remove()
 *   bindEscDismiss(modal, { onEscape: () => closeModal() });    // 关闭 = 自定义函数
 */

// 已经包装过 remove() 的元素，避免重复包装
const patchedOverlays = new WeakSet();

/**
 * @param {HTMLElement} overlay - 覆盖层/弹窗元素
 * @param {object} [options]
 * @param {(e: KeyboardEvent) => void} [options.onEscape] - ESC 时的关闭动作，默认 overlay.remove()
 * @returns {() => void} dispose 函数（幂等）
 */
export function bindEscDismiss(overlay, options = {}) {
    let disposed = false;

    const dispose = () => {
        if (disposed) return;
        disposed = true;
        document.removeEventListener('keydown', handler);
    };

    const onEscape = typeof options.onEscape === 'function'
        ? options.onEscape
        : () => overlay.remove();

    const handler = (e) => {
        if (e.key !== 'Escape') return;
        dispose();
        onEscape(e);
    };

    document.addEventListener('keydown', handler);

    if (overlay && typeof overlay.remove === 'function' && !patchedOverlays.has(overlay)) {
        patchedOverlays.add(overlay);
        const originalRemove = overlay.remove;
        overlay.remove = function (...args) {
            dispose();
            return originalRemove.apply(this, args);
        };
    }

    return dispose;
}
