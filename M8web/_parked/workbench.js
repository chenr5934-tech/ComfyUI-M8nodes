(() => {
    const fileInput = document.getElementById("cropFile");
    const dropzone = document.getElementById("cropDropzone");
    const fileMeta = document.getElementById("cropFileMeta");
    const uploadPanel = document.getElementById("cropUploadPanel");
    const workspace = document.getElementById("cropWorkspace");
    const results = document.getElementById("cropResults");
    const source = document.getElementById("cropSource");
    const canvasFrame = document.getElementById("cropCanvas");
    const editorTitle = document.getElementById("crop-editor-title");
    const imageLabel = document.getElementById("cropImageLabel");
    const imageSize = document.getElementById("cropImageSize");
    const generateButton = document.getElementById("cropGenerate");
    const resetButton = document.getElementById("cropReset");
    const modeMaskButton = document.getElementById("cropModeMask");
    const modeSplitButton = document.getElementById("cropModeSplit");
    const modeQuadButton = document.getElementById("cropModeQuad");
    const modeNineButton = document.getElementById("cropModeNine");
    const modeStickerButton = document.getElementById("cropModeSticker");
    const secondRegionToggle = document.getElementById("cropSecondRegion");
    const secondRegionToggleWrap = document.getElementById("cropRegionToggleWrap");
    const status = document.getElementById("cropStatus");
    const resultGrid = document.getElementById("cropResultGrid");
    const downloadAll = document.getElementById("cropDownloadAll");
    const canvasHint = document.getElementById("cropCanvasHint");
    const maskSettings = document.getElementById("cropMaskSettings");
    const splitSummary = document.getElementById("cropSplitSummary");
    const quadSettings = document.getElementById("cropQuadSettings");
    const manualControls = [...document.querySelectorAll(".crop-manual-control")];
    const maskText = document.getElementById("cropMaskText");
    const maskTextHint = document.getElementById("cropMaskTextHint");
    const splitSummaryTitle = document.getElementById("cropSplitSummaryTitle");
    const gridSettingsTitle = document.getElementById("cropGridSettingsTitle");
    const gridSettingsCopy = document.getElementById("cropGridSettingsCopy");
    const stickerSettings = document.getElementById("cropStickerSettings");
    const stickerLayers = [...document.querySelectorAll("[data-sticker-layer]")];
    const stickerLayerList = document.getElementById("cropStickerLayerList");
    const stickerSummary = document.getElementById("cropStickerSummary");
    const stickerUpButton = document.getElementById("cropStickerUp");
    const stickerDownButton = document.getElementById("cropStickerDown");
    const stickerRemoveButton = document.getElementById("cropStickerRemove");
    const stickerClearButton = document.getElementById("cropStickerClear");
    const stickerName = document.getElementById("cropStickerName");
    const stickerSize = document.getElementById("cropStickerSize");
    const stickerSizeValue = document.getElementById("cropStickerSizeValue");
    const stickerRotation = document.getElementById("cropStickerRotation");
    const stickerRotationValue = document.getElementById("cropStickerRotationValue");
    const stickerCustomButton = document.getElementById("cropStickerCustom");
    const stickerPresetButton = document.getElementById("cropStickerPreset");
    const stickerResetButton = document.getElementById("cropStickerReset");
    const stickerModal = document.getElementById("cropStickerModal");
    const stickerModalClose = document.getElementById("cropStickerModalClose");
    const stickerModalCancel = document.getElementById("cropStickerModalCancel");
    const stickerModalApply = document.getElementById("cropStickerModalApply");
    const stickerFile = document.getElementById("cropStickerFile");
    const stickerDropzone = document.getElementById("cropStickerDropzone");
    const stickerFileName = document.getElementById("cropStickerFileName");
    const stickerPreviewWrap = document.getElementById("cropStickerPreviewWrap");
    const stickerModalPreview = document.getElementById("cropStickerModalPreview");
    const stickerEmptyState = document.getElementById("cropStickerEmptyState");
    const stickerPresetModal = document.getElementById("cropStickerPresetModal");
    const stickerPresetClose = document.getElementById("cropStickerPresetClose");
    const stickerPresetCancel = document.getElementById("cropStickerPresetCancel");
    const stickerPresetApply = document.getElementById("cropStickerPresetApply");
    const stickerPresetCards = [...document.querySelectorAll(".crop-sticker-preset-card")];
    const stickerTabPreset = document.getElementById("cropStickerTabPreset");
    const stickerTabMine = document.getElementById("cropStickerTabMine");
    const stickerPanelPreset = document.getElementById("cropStickerPanelPreset");
    const stickerPanelMine = document.getElementById("cropStickerPanelMine");
    const stickerMineLibrary = document.getElementById("cropStickerMineLibrary");
    const stickerMineEmpty = document.getElementById("cropStickerMineEmpty");
    const stickerMineCount = document.getElementById("cropStickerMineCount");
    const stickerMineNote = document.getElementById("cropStickerMineNote");
    const stickerLibraryStatus = document.getElementById("cropStickerLibraryStatus");
    const stickerSeed = document.getElementById("cropStickerSeed");
    const stickerImportButton = document.getElementById("cropStickerImport");
    const stickerExportButton = document.getElementById("cropStickerExport");
    const stickerImportFile = document.getElementById("cropStickerImportFile");
    const stickerRemember = document.getElementById("cropStickerRemember");
    const stickerRememberWrap = document.getElementById("cropStickerRememberWrap");
    const stickerStorageNote = document.getElementById("cropStickerStorageNote");
    const lineA = document.getElementById("cropLineA");
    const lineB = document.getElementById("cropLineB");
    const lineC = document.getElementById("cropLineC");
    const lineD = document.getElementById("cropLineD");
    const rangeA = document.getElementById("cropRangeA");
    const rangeB = document.getElementById("cropRangeB");
    const rangeC = document.getElementById("cropRangeC");
    const rangeD = document.getElementById("cropRangeD");
    const valueA = document.getElementById("cropValueA");
    const valueB = document.getElementById("cropValueB");
    const valueC = document.getElementById("cropValueC");
    const valueD = document.getElementById("cropValueD");
    const partA = document.getElementById("cropPartSizeA");
    const partB = document.getElementById("cropPartSizeB");
    const partC = document.getElementById("cropPartSizeC");
    const tintKeepA = document.querySelector(".crop-zone-keep-a");
    const tintRemoveA = document.querySelector(".crop-zone-remove-a");
    const tintKeepB = document.querySelector(".crop-zone-keep-b");
    const tintRemoveB = document.querySelector(".crop-zone-remove-b");
    const tintKeepC = document.querySelector(".crop-zone-keep-c");
    const zoneTextA = document.getElementById("cropZoneTextA");
    const zoneTextB = document.getElementById("cropZoneTextB");
    const secondRegionControls = [...document.querySelectorAll("[data-crop-region='second']")];

    if (!fileInput || !dropzone || !uploadPanel || !source || !modeMaskButton || !modeSplitButton || !modeQuadButton || !modeNineButton || !modeStickerButton || !canvasHint || !maskSettings || !splitSummary || !quadSettings || !stickerSettings || !stickerLayers.length || !maskText || !zoneTextA || !zoneTextB || !secondRegionToggle) return;

    const MIN_GAP = 1.5;
    let originalFile = null;
    let objectUrl = "";
    let imageWidth = 0;
    let imageHeight = 0;
    let cutA = 22;
    let cutB = 34;
    let cutC = 66;
    let cutD = 78;
    let dragLine = null;
    let outputUrls = [];
    let outputMode = "mask";
    let useSecondRegion = true;
    let stickerItems = [];
    let activeStickerId = "";
    let stickerDrag = null;
    let pendingStickerUrl = "";
    let pendingStickerName = "";
    let pendingStickerFile = null;
    let stickerSelection = null;

    /* ==========================================================
       个人贴纸库：存在用户本机浏览器的 IndexedDB 里
       - 换设备 / 清缓存前可以用「导出」备份，用「导入」还原
       - 不依赖服务器，所以部署到哪台机器都一样能用
       ========================================================== */
    const STICKER_DB_NAME = "nyacraft-sticker-library";
    const STICKER_DB_VERSION = 1;
    const STICKER_STORE = "stickers";
    const STICKER_SEED_FLAG = "nyacraft-sticker-seeded-v1";
    const STICKER_MAX_BYTES = 8 * 1024 * 1024;
    let stickerDbPromise = null;
    let personalStickers = [];
    let seedInFlight = false;

    function openStickerDb() {
        if (stickerDbPromise) return stickerDbPromise;
        stickerDbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === "undefined") {
                reject(new Error("浏览器不支持本地存储"));
                return;
            }
            const request = indexedDB.open(STICKER_DB_NAME, STICKER_DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STICKER_STORE)) {
                    const store = db.createObjectStore(STICKER_STORE, { keyPath: "id" });
                    store.createIndex("createdAt", "createdAt", { unique: false });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error("无法打开本地贴纸库"));
        });
        return stickerDbPromise;
    }

    function stickerDbRun(mode, action) {
        return openStickerDb().then((db) => new Promise((resolve, reject) => {
            let request;
            const tx = db.transaction(STICKER_STORE, mode);
            try {
                request = action(tx.objectStore(STICKER_STORE));
            } catch (error) {
                reject(error);
                return;
            }
            tx.oncomplete = () => resolve(request && "result" in request ? request.result : request);
            tx.onerror = () => reject(tx.error || new Error("本地贴纸库读写失败"));
            tx.onabort = () => reject(tx.error || new Error("本地贴纸库读写被中断"));
        }));
    }

    const stickerDbAll = () => stickerDbRun("readonly", (store) => store.getAll())
        .then((rows) => (Array.isArray(rows) ? rows : []).filter((row) => row && row.blob).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));

    const stickerDbPut = (record) => stickerDbRun("readwrite", (store) => store.put(record)).then(() => record);
    const stickerDbDelete = (id) => stickerDbRun("readwrite", (store) => store.delete(id));

    function setLibraryStatus(message, kind = "") {
        if (!stickerLibraryStatus) return;
        stickerLibraryStatus.textContent = message;
        stickerLibraryStatus.className = `crop-sticker-status${kind ? ` is-${kind}` : ""}`;
    }

    function readImageMeta(url) {
        return new Promise((resolve) => {
            const probe = new Image();
            probe.onload = () => resolve({ width: probe.naturalWidth || 0, height: probe.naturalHeight || 0 });
            probe.onerror = () => resolve({ width: 0, height: 0 });
            probe.src = url;
        });
    }

    function requestPersistentStorage() {
        if (!navigator.storage?.persist) return;
        navigator.storage.persist().then((granted) => {
            if (!granted && stickerMineNote) {
                stickerMineNote.textContent = "浏览器没有授予持久化权限：磁盘紧张或清理缓存时贴纸库可能被清空，建议偶尔「导出」备份一下。";
            }
        }).catch(() => { /* 不支持就算了 */ });
    }

    // 返回 true 表示确实新增了一条；重复、过大、非图片都返回 false
    async function saveStickerToLibrary(file, name) {
        if (!file || !String(file.type || "").startsWith("image/")) return false;
        if (file.size > STICKER_MAX_BYTES) {
            setLibraryStatus(`单张贴纸超过 ${Math.round(STICKER_MAX_BYTES / 1024 / 1024)} MB，没有记录进贴纸库。`, "error");
            return false;
        }
        const displayName = String(name || file.name || "贴纸").replace(/\.[^.]+$/, "") || "贴纸";
        if (personalStickers.some((item) => item.name === displayName && item.size === file.size)) return false;

        const probeUrl = URL.createObjectURL(file);
        const meta = await readImageMeta(probeUrl);
        URL.revokeObjectURL(probeUrl);

        const record = {
            id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `s-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name: displayName,
            size: file.size,
            type: file.type,
            width: meta.width,
            height: meta.height,
            createdAt: Date.now(),
            blob: file,
        };
        await stickerDbPut(record);
        personalStickers.push(record);
        requestPersistentStorage();
        return true;
    }

    function stickerFallbackName(record) {
        return record.width && record.height
            ? `${record.width}×${record.height} · ${formatBytes(record.size)}`
            : formatBytes(record.size);
    }

    function renderPersonalLibrary() {
        if (!stickerMineLibrary) return;
        stickerMineLibrary.querySelectorAll("[data-object-url]").forEach((node) => URL.revokeObjectURL(node.dataset.objectUrl));
        stickerMineLibrary.replaceChildren();

        personalStickers.forEach((record) => {
            const url = URL.createObjectURL(record.blob);

            const item = document.createElement("div");
            item.className = "crop-sticker-mine-item";

            const card = document.createElement("button");
            card.type = "button";
            card.className = "crop-sticker-preset-card";
            card.dataset.stickerKind = "mine";
            card.dataset.stickerId = record.id;
            card.dataset.stickerName = record.name;
            if (stickerSelection && stickerSelection.kind === "mine" && stickerSelection.id === record.id) card.classList.add("is-selected");

            const preview = document.createElement("span");
            preview.className = "crop-sticker-preset-preview";
            const image = document.createElement("img");
            image.src = url;
            image.dataset.objectUrl = url;
            image.alt = "";
            image.loading = "lazy";
            preview.appendChild(image);

            const label = document.createElement("strong");
            label.textContent = record.name;

            const meta = document.createElement("span");
            meta.className = "crop-sticker-mine-meta";
            meta.textContent = stickerFallbackName(record);

            card.append(preview, label, meta);

            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "crop-sticker-mine-delete";
            remove.dataset.deleteId = record.id;
            remove.setAttribute("aria-label", `从我的贴纸库删除 ${record.name}`);
            remove.textContent = "×";

            item.append(card, remove);
            stickerMineLibrary.appendChild(item);
        });

        if (stickerMineCount) stickerMineCount.textContent = String(personalStickers.length);
        stickerMineEmpty?.classList.toggle("is-hidden", personalStickers.length > 0);
        if (stickerExportButton) stickerExportButton.disabled = personalStickers.length === 0;
    }

    async function refreshPersonalLibrary() {
        try {
            personalStickers = await stickerDbAll();
        } catch (error) {
            personalStickers = [];
            if (stickerMineNote) stickerMineNote.textContent = "当前浏览器不允许本地存储，我的贴纸库暂时用不了（无痕模式常见）。";
            if (stickerImportButton) stickerImportButton.disabled = true;
            if (stickerExportButton) stickerExportButton.disabled = true;
        }
        renderPersonalLibrary();
        return personalStickers;
    }

    function selectSticker(selection) {
        stickerSelection = selection || null;
        document.querySelectorAll(".crop-sticker-preset-card").forEach((card) => {
            const isMine = card.dataset.stickerKind === "mine";
            const match = !!stickerSelection && (isMine
                ? stickerSelection.kind === "mine" && card.dataset.stickerId === stickerSelection.id
                : stickerSelection.kind === "preset" && card.dataset.stickerSrc === stickerSelection.src);
            card.classList.toggle("is-selected", match);
        });
        if (stickerPresetApply) stickerPresetApply.disabled = !stickerSelection;
    }

    function switchStickerTab(tab) {
        const isMine = tab === "mine";
        stickerTabPreset?.classList.toggle("is-active", !isMine);
        stickerTabMine?.classList.toggle("is-active", isMine);
        stickerTabPreset?.setAttribute("aria-selected", String(!isMine));
        stickerTabMine?.setAttribute("aria-selected", String(isMine));
        stickerPanelPreset?.classList.toggle("is-hidden", isMine);
        stickerPanelMine?.classList.toggle("is-hidden", !isMine);
    }

    async function seedFromPresets() {
        let added = 0;
        for (const card of stickerPresetCards) {
            const src = card.dataset.stickerSrc;
            if (!src) continue;
            try {
                const response = await fetch(src);
                if (!response.ok) continue;
                const blob = await response.blob();
                const name = card.dataset.stickerName || "预设贴纸";
                const isNew = await saveStickerToLibrary(new File([blob], `${name}.png`, { type: blob.type || "image/png" }), name);
                if (isNew) added += 1;
            } catch (error) { /* 单张失败就跳过 */ }
        }
        return added;
    }

    // 首次打开贴纸库时自动把预设塞一份进个人库，用户之后就有“初始带一点”的库存
    async function autoSeedOnce() {
        if (seedInFlight) return;
        try {
            if (localStorage.getItem(STICKER_SEED_FLAG)) return;
        } catch (error) {
            return;
        }
        seedInFlight = true;
        try {
            if (!personalStickers.length && stickerPresetCards.length) {
                const added = await seedFromPresets();
                await refreshPersonalLibrary();
                if (added) setLibraryStatus(`已把 ${added} 张预设贴纸放进「我的贴纸库」，以后可以直接选用。`, "success");
            }
            localStorage.setItem(STICKER_SEED_FLAG, "1");
        } catch (error) {
            /* 存不下就不存了 */
        } finally {
            seedInFlight = false;
        }
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error || new Error("读取失败"));
            reader.readAsDataURL(blob);
        });
    }

    async function importStickerPack(file) {
        let pack = null;
        try {
            pack = JSON.parse(await file.text());
        } catch (error) {
            return { added: 0, skipped: 0, broken: true };
        }
        const list = Array.isArray(pack) ? pack : (Array.isArray(pack?.stickers) ? pack.stickers : []);
        let added = 0;
        let skipped = 0;
        for (const entry of list) {
            if (!entry || typeof entry.dataUrl !== "string") { skipped += 1; continue; }
            try {
                const blob = await (await fetch(entry.dataUrl)).blob();
                const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "导入贴纸";
                const isNew = await saveStickerToLibrary(new File([blob], `${name}.png`, { type: blob.type || "image/png" }), name);
                if (isNew) added += 1;
                else skipped += 1;
            } catch (error) {
                skipped += 1;
            }
        }
        return { added, skipped, broken: false };
    }

    async function importStickerFiles(files) {
        let added = 0;
        let skipped = 0;
        let broken = false;
        for (const file of files) {
            if (!file) continue;
            const isPack = file.type === "application/json" || /\.json$/i.test(file.name);
            if (isPack) {
                const result = await importStickerPack(file);
                added += result.added;
                skipped += result.skipped;
                broken = broken || result.broken;
                continue;
            }
            if (!String(file.type || "").startsWith("image/")) { skipped += 1; continue; }
            const isNew = await saveStickerToLibrary(file, file.name);
            if (isNew) added += 1;
            else skipped += 1;
        }
        await refreshPersonalLibrary();
        if (broken && !added) {
            setLibraryStatus("贴纸包文件读不出来，确认是「导出」出来的那个 json。", "error");
        } else if (added) {
            setLibraryStatus(`已导入 ${added} 张贴纸到「我的贴纸库」${skipped ? `，跳过 ${skipped} 张重复或不支持的` : ""}。`, "success");
        } else {
            setLibraryStatus("没有新增贴纸：这些已经在库里了，或者文件格式不支持。", "error");
        }
        return added;
    }

    async function exportStickerPack() {
        if (!personalStickers.length) {
            setLibraryStatus("我的贴纸库还是空的，没有可以导出的内容。", "error");
            return;
        }
        setLibraryStatus("正在打包…");
        try {
            const stickers = [];
            for (const record of personalStickers) {
                stickers.push({
                    name: record.name,
                    type: record.blob.type || "image/png",
                    width: record.width || 0,
                    height: record.height || 0,
                    dataUrl: await blobToDataUrl(record.blob),
                });
            }
            const blob = new Blob([JSON.stringify({ type: "nyacraft-sticker-pack", version: 1, exportedAt: new Date().toISOString(), stickers })], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `nyacraft-stickers-${new Date().toISOString().slice(0, 10)}.json`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 5000);
            setLibraryStatus(`已导出 ${stickers.length} 张贴纸，换设备时用「导入」还原。`, "success");
        } catch (error) {
            setLibraryStatus("导出失败，请重试。", "error");
        }
    }

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const formatBytes = (bytes) => {
        if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };
    const formatDimensions = (width, height) => `${Math.round(width)} × ${Math.round(height)} px`;
    const setStatus = (message, kind = "") => {
        status.textContent = message;
        status.className = `crop-status${kind ? ` is-${kind}` : ""}`;
    };

    function updateMaskPreview() {
        const message = maskText.value.trim();
        zoneTextA.textContent = message;
        zoneTextB.textContent = useSecondRegion ? message : "";
    }

    /* ==========================================================
       贴纸图层：可以在同一张图上叠很多张，每张各自有位置 / 大小 / 旋转
       - stickerItems 数组顺序 = 叠放顺序（后面的盖在前面上面）
       - 每张贴纸对应一个 .crop-sticker-layer 节点
       ========================================================== */
    const STICKER_Z_BASE = 5;
    const STICKER_DEFAULT_SCALE = 28;

    function makeStickerId() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
        return `st-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    // 画布上用百分比定位，存的是相对原图的百分比，所以任何分辨率下位置都一致
    function stickerById(id) {
        return stickerItems.find((item) => item.id === id) || null;
    }

    function activeSticker() {
        return stickerById(activeStickerId);
    }

    // 节点跟着 item 走，不用索引去配，避免增删/重排后错位
    function createLayerNode() {
        const node = document.createElement("div");
        node.className = "crop-sticker-layer";
        node.dataset.stickerLayer = "";
        node.setAttribute("role", "button");
        const image = document.createElement("img");
        image.alt = "";
        image.draggable = false;
        const outline = document.createElement("span");
        outline.className = "crop-sticker-outline";
        outline.setAttribute("aria-hidden", "true");
        node.append(image, outline);
        node.addEventListener("pointerdown", startStickerDrag);
        node.addEventListener("pointermove", moveSticker);
        node.addEventListener("pointerup", stopStickerDrag);
        node.addEventListener("pointercancel", stopStickerDrag);
        node.addEventListener("keydown", handleStickerKey);
        canvasFrame.appendChild(node);
        return node;
    }

    function ensureLayerNode(item) {
        if (!item.node || !item.node.isConnected) item.node = createLayerNode();
        return item.node;
    }

    function applyStickerGeometry(item) {
        if (!item) return;
        const baseShortSide = Math.max(1, Math.min(imageWidth || 100, imageHeight || 100));
        const baseWidth = Math.max(1, imageWidth || 100);
        const widthPercent = baseShortSide * item.scale / baseWidth;
        const node = item.node;
        if (!node) return;
        node.style.left = `${item.x}%`;
        node.style.top = `${item.y}%`;
        node.style.width = `${widthPercent}%`;
        node.style.transform = `translate(-50%, -50%) rotate(${item.angle}deg)`;
        node.style.zIndex = String(STICKER_Z_BASE + stickerItems.indexOf(item));
    }

    function syncStickerControls() {
        const item = activeSticker();
        const has = !!item;
        const index = has ? stickerItems.indexOf(item) : -1;

        if (stickerSize) {
            stickerSize.disabled = !has;
            if (has) stickerSize.value = String(item.scale);
        }
        if (stickerRotation) {
            stickerRotation.disabled = !has;
            if (has) stickerRotation.value = String(item.angle);
        }
        if (stickerSizeValue) stickerSizeValue.textContent = has ? `${Math.round(item.scale)}%` : "--";
        if (stickerRotationValue) stickerRotationValue.textContent = has ? `${Math.round(item.angle)}°` : "--";
        if (stickerName) stickerName.textContent = has ? item.name : "未选择";
        if (stickerSummary) {
            stickerSummary.textContent = stickerItems.length
                ? `已放 ${stickerItems.length} 张${has ? ` · 正在编辑第 ${index + 1} 张` : ""}`
                : "还没有贴纸";
        }
        if (stickerUpButton) stickerUpButton.disabled = !has || index >= stickerItems.length - 1;
        if (stickerDownButton) stickerDownButton.disabled = !has || index <= 0;
        if (stickerRemoveButton) stickerRemoveButton.disabled = !has;
        if (stickerResetButton) stickerResetButton.disabled = !has;
        if (stickerClearButton) stickerClearButton.disabled = stickerItems.length === 0;
    }

    function renderStickerLayerList() {
        if (!stickerLayerList) return;
        stickerLayerList.querySelectorAll("[data-object-url]").forEach((node) => URL.revokeObjectURL(node.dataset.objectUrl));
        stickerLayerList.replaceChildren();

        // 列表按“从上到下”展示，也就是叠在最上面的排最前，符合图层面板直觉
        [...stickerItems].reverse().forEach((item) => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "crop-sticker-layer-chip";
            chip.dataset.stickerChipId = item.id;
            chip.title = `${item.name}（点击切换编辑）`;
            chip.setAttribute("aria-label", `编辑贴纸 ${item.name}`);
            chip.setAttribute("aria-pressed", String(item.id === activeStickerId));
            if (item.id === activeStickerId) chip.classList.add("is-selected");

            const image = document.createElement("img");
            image.alt = "";
            image.src = item.src;
            chip.appendChild(image);

            const badge = document.createElement("span");
            badge.className = "crop-sticker-layer-index";
            badge.textContent = String(stickerItems.indexOf(item) + 1);
            chip.appendChild(badge);

            stickerLayerList.appendChild(chip);
        });
    }

    // 把 stickerItems 同步到画布：节点、选中态、层级、控件数值
    function refreshStickerLayers() {
        if (!stickerItems.some((item) => item.id === activeStickerId)) {
            activeStickerId = stickerItems.length ? stickerItems[stickerItems.length - 1].id : "";
        }
        stickerItems.forEach((item) => {
            const node = ensureLayerNode(item);
            const image = node.querySelector("img");
            if (image && image.getAttribute("src") !== item.src) {
                image.src = item.src;
                image.alt = item.name;
            }
            const isActive = item.id === activeStickerId;
            node.dataset.stickerId = item.id;
            node.classList.remove("is-hidden");
            node.classList.toggle("is-selected", isActive);
            node.classList.toggle("is-inactive", !isActive);
            node.setAttribute("aria-label", `贴纸：${item.name}`);
            node.setAttribute("aria-pressed", String(isActive));
            node.tabIndex = isActive ? 0 : -1;
            applyStickerGeometry(item);
        });
        renderStickerLayerList();
        syncStickerControls();
        syncDefaultStickerAvailability();
    }

    function selectStickerLayer(id) {
        if (!stickerById(id)) return;
        activeStickerId = id;
        refreshStickerLayers();
    }

    function addStickerLayer({ src, name, scale = STICKER_DEFAULT_SCALE, x = 50, y = 50, angle = 0 }) {
        if (!src) return null;
        const item = {
            id: makeStickerId(),
            name: name || "贴纸",
            src,
            x,
            y,
            scale,
            angle,
            node: null,
        };
        stickerItems.push(item);
        activeStickerId = item.id;
        refreshStickerLayers();
        return item;
    }

    function removeStickerLayer(id) {
        const index = stickerItems.findIndex((item) => item.id === id);
        if (index < 0) return;
        const [removed] = stickerItems.splice(index, 1);
        // 只回收 blob: 开头的对象 URL，预设贴纸是服务器路径不能 revoke
        if (removed) {
            if (/^blob:/.test(removed.src)) URL.revokeObjectURL(removed.src);
            removed.node?.remove();
        }
        refreshStickerLayers();
    }

    function clearStickerLayers() {
        stickerItems.forEach((item) => {
            if (/^blob:/.test(item.src)) URL.revokeObjectURL(item.src);
            item.node?.remove();
        });
        stickerItems = [];
        activeStickerId = "";
        refreshStickerLayers();
    }

    // direction: 1 = 往前（更靠上、更晚绘制），-1 = 往后
    function moveStickerLayer(id, direction) {
        const index = stickerItems.findIndex((item) => item.id === id);
        if (index < 0) return;
        const target = index + direction;
        if (target < 0 || target >= stickerItems.length) return;
        const [item] = stickerItems.splice(index, 1);
        stickerItems.splice(target, 0, item);
        refreshStickerLayers();
        setStatus(`已调整图层顺序：当前贴纸在第 ${target + 1} 层（共 ${stickerItems.length} 层，数字越大越靠上）。`, "success");
    }

    function resetStickerTransform() {
        const item = activeSticker();
        if (!item) return;
        item.x = 50;
        item.y = 50;
        item.scale = STICKER_DEFAULT_SCALE;
        item.angle = 0;
        applyStickerGeometry(item);
        syncStickerControls();
        renderStickerLayerList();
    }

    function syncDefaultStickerAvailability() {
        // 预设贴纸已经在画布上放了一张之后，就不该再加第 2 张同样的
        const used = new Set(stickerItems.map((item) => item.src));
        stickerPresetCards.forEach((card) => {
            const src = card.dataset.stickerSrc;
            const already = used.has(src);
            card.classList.toggle("is-used", already);
            card.disabled = already;
            card.title = already ? "这张已经在图上了" : "";
        });
    }

    function setOutputMode(mode) {
        outputMode = ["split", "quad", "grid9", "sticker"].includes(mode) ? mode : "mask";
        const isMaskMode = outputMode === "mask";
        const isSplitMode = outputMode === "split";
        const isQuadMode = outputMode === "quad";
        const isNineMode = outputMode === "grid9";
        const isStickerMode = outputMode === "sticker";
        const isGridMode = isQuadMode || isNineMode;
        useSecondRegion = secondRegionToggle.checked;
        modeMaskButton.classList.toggle("is-active", isMaskMode);
        modeSplitButton.classList.toggle("is-active", isSplitMode);
        modeQuadButton.classList.toggle("is-active", isQuadMode);
        modeNineButton.classList.toggle("is-active", isNineMode);
        modeStickerButton.classList.toggle("is-active", isStickerMode);
        modeMaskButton.setAttribute("aria-pressed", String(isMaskMode));
        modeSplitButton.setAttribute("aria-pressed", String(isSplitMode));
        modeQuadButton.setAttribute("aria-pressed", String(isQuadMode));
        modeNineButton.setAttribute("aria-pressed", String(isNineMode));
        modeStickerButton.setAttribute("aria-pressed", String(isStickerMode));
        workspace.classList.toggle("is-mask-mode", isMaskMode);
        workspace.classList.toggle("is-quad-mode", isQuadMode);
        workspace.classList.toggle("is-grid9-mode", isNineMode);
        workspace.classList.toggle("is-sticker-mode", isStickerMode);
        workspace.classList.toggle("is-single-region", !useSecondRegion && !isGridMode && !isStickerMode);
        maskSettings.classList.toggle("is-hidden", !isMaskMode);
        splitSummary.classList.toggle("is-hidden", !isSplitMode);
        quadSettings.classList.toggle("is-hidden", !isGridMode);
        stickerSettings.classList.toggle("is-hidden", !isStickerMode);
        manualControls.forEach((control) => control.classList.toggle("is-hidden", isGridMode || isStickerMode));
        secondRegionControls.forEach((control) => control.classList.toggle("is-hidden", isGridMode || isStickerMode || !useSecondRegion));
        secondRegionToggle.disabled = isGridMode || isStickerMode;
        secondRegionToggleWrap?.classList.toggle("is-hidden", isGridMode || isStickerMode);
        resultGrid.classList.toggle("is-quad-results", isQuadMode);
        resultGrid.classList.toggle("is-nine-results", isNineMode);
        resultGrid.classList.toggle("is-two-results", !useSecondRegion && isSplitMode);
        splitSummary.classList.toggle("is-two-segments", !useSecondRegion);
        if (maskTextHint) maskTextHint.textContent = useSecondRegion ? "会同时显示在两个遮挡区域" : "显示在一个遮挡区域";
        if (splitSummaryTitle) splitSummaryTitle.textContent = useSecondRegion ? "保留三段" : "保留两段";
        if (editorTitle) {
            editorTitle.textContent = isQuadMode ? "预览4宫格分割" : isNineMode ? "预览9宫格分割" : isStickerMode ? "调整贴纸图层" : "标记要移除的区域";
        }
        if (gridSettingsTitle) gridSettingsTitle.textContent = isNineMode ? "自动9宫格" : "自动4宫格";
        if (gridSettingsCopy) gridSettingsCopy.textContent = isNineMode
            ? "无需手动选择分割线，将按横向与纵向三等分输出 9 张图片。"
            : "无需手动选择分割线，将输出左上、右上、左下、右下 4 张图片。";
        generateButton.innerHTML = isMaskMode
            ? '<span aria-hidden="true">✦</span> 生成整张图片'
            : isSplitMode
                ? `<span aria-hidden="true">✦</span> 生成${useSecondRegion ? "三" : "两"}张图片`
                : isNineMode
                    ? '<span aria-hidden="true">✦</span> 生成9宫格'
                    : isStickerMode
                        ? '<span aria-hidden="true">✦</span> 生成贴纸图片'
                        : '<span aria-hidden="true">✦</span> 生成4宫格';
        downloadAll.innerHTML = isMaskMode
            ? '<span aria-hidden="true">⇩</span> 下载图片'
            : isSplitMode
                ? '<span aria-hidden="true">⇩</span> 全部下载'
                : isNineMode
                    ? '<span aria-hidden="true">⇩</span> 下载9宫格'
                    : isStickerMode
                        ? '<span aria-hidden="true">⇩</span> 下载图片'
                        : '<span aria-hidden="true">⇩</span> 下载4宫格';
        canvasHint.textContent = isMaskMode
            ? useSecondRegion ? "拖动 A-D；A/B 与 C/D 之间会变成黑色文字块。" : "拖动 A-B；A/B 之间会变成黑色文字块。"
            : isSplitMode
                ? useSecondRegion ? "拖动 A-D；A/B 与 C/D 之间会被移除，其他三段会保留。" : "拖动 A-B；A/B 之间会被移除，其他两段会保留。"
                : isNineMode
                    ? "自动按横向与纵向三等分切分为 9 张，无需手动选择分割线。"
                    : isStickerMode
                        ? "拖动贴纸调整位置，可以在右侧切换正在编辑的那张、叠很多张贴纸。"
                        : "自动按图片中心横线与竖线切分为 4 张，无需手动选择分割线。";
        updateSegments();
        refreshStickerLayers();
    }

    secondRegionToggle.addEventListener("change", () => setOutputMode(outputMode));

    function clearOutputs() {
        outputUrls.forEach((url) => URL.revokeObjectURL(url));
        outputUrls = [];
        resultGrid.innerHTML = "";
        results.classList.add("is-hidden");
    }

    function updateSegments() {
        const lastPosition = 99;
        const maxA = useSecondRegion ? lastPosition - MIN_GAP * 3 : lastPosition - MIN_GAP;
        const maxB = useSecondRegion ? lastPosition - MIN_GAP * 2 : lastPosition;
        cutA = clamp(Number(cutA) || 22, 1, maxA);
        cutB = clamp(Number(cutB) || 34, cutA + MIN_GAP, maxB);
        if (useSecondRegion) {
            cutC = clamp(Number(cutC) || 66, cutB + MIN_GAP, lastPosition - MIN_GAP);
            cutD = clamp(Number(cutD) || 78, cutC + MIN_GAP, lastPosition);
        }

        const lines = [
            [lineA, cutA],
            [lineB, cutB],
            [lineC, cutC],
            [lineD, cutD],
        ];
        lines.forEach(([line, value]) => {
            line.style.top = `${value}%`;
            line.setAttribute("aria-valuenow", String(value));
        });

        tintKeepA.style.top = "0%";
        tintKeepA.style.height = `${cutA}%`;
        tintRemoveA.style.top = `${cutA}%`;
        tintRemoveA.style.height = `${cutB - cutA}%`;
        tintKeepB.style.top = `${cutB}%`;
        tintKeepB.style.height = `${useSecondRegion ? cutC - cutB : 100 - cutB}%`;
        tintRemoveB.style.top = `${cutC}%`;
        tintRemoveB.style.height = `${useSecondRegion ? cutD - cutC : 0}%`;
        tintKeepC.style.top = `${cutD}%`;
        tintKeepC.style.height = `${useSecondRegion ? 100 - cutD : 0}%`;
        zoneTextA.style.top = `${cutA}%`;
        zoneTextA.style.height = `${cutB - cutA}%`;
        zoneTextB.style.top = `${cutC}%`;
        zoneTextB.style.height = `${useSecondRegion ? cutD - cutC : 0}%`;

        const ranges = [
            [rangeA, 1, cutB - MIN_GAP, cutA],
            [rangeB, cutA + MIN_GAP, useSecondRegion ? cutC - MIN_GAP : lastPosition, cutB],
        ];
        if (useSecondRegion) {
            ranges.push(
                [rangeC, cutB + MIN_GAP, cutD - MIN_GAP, cutC],
                [rangeD, cutC + MIN_GAP, lastPosition, cutD],
            );
        }
        ranges.forEach(([range, min, max, value]) => {
            range.min = String(min);
            range.max = String(max);
            range.value = String(value);
        });
        [
            [valueA, cutA],
            [valueB, cutB],
            [valueC, cutC],
            [valueD, cutD],
        ].forEach(([output, value]) => {
            output.textContent = `${value.toFixed(1).replace(/\.0$/, "")}%`;
        });

        partC.parentElement?.classList.toggle("is-hidden", !useSecondRegion);
        if (imageWidth && imageHeight) {
            const heights = [cutA, cutC - cutB, 100 - cutD].map((part) => Math.max(1, Math.round(imageHeight * part / 100)));
            partA.textContent = formatDimensions(imageWidth, heights[0]);
            partB.textContent = formatDimensions(imageWidth, useSecondRegion ? heights[1] : Math.max(1, Math.round(imageHeight * (100 - cutB) / 100)));
            partC.textContent = formatDimensions(imageWidth, heights[2]);
        }
        updateMaskPreview();
    }

    function positionFromPointer(event) {
        const rect = canvasFrame.getBoundingClientRect();
        if (!rect.height) return null;
        return clamp(((event.clientY - rect.top) / rect.height) * 100, 1, 99);
    }

    function moveLine(value) {
        if (value === null) return;
        const limits = {
            a: [1, cutB - MIN_GAP],
            b: [cutA + MIN_GAP, useSecondRegion ? cutC - MIN_GAP : 99],
            c: [cutB + MIN_GAP, cutD - MIN_GAP],
            d: [cutC + MIN_GAP, 99],
        };
        const [min, max] = limits[dragLine] || [1, 99];
        if (dragLine === "a") cutA = clamp(value, min, max);
        if (dragLine === "b") cutB = clamp(value, min, max);
        if (dragLine === "c") cutC = clamp(value, min, max);
        if (dragLine === "d") cutD = clamp(value, min, max);
        updateSegments();
    }

    function startDrag(line, event) {
        dragLine = line;
        event.preventDefault();
        const lineElement = { a: lineA, b: lineB, c: lineC, d: lineD }[line];
        try {
            lineElement?.setPointerCapture?.(event.pointerId);
        } catch (error) { /* 捕获失败不阻断拖拽 */ }
        moveLine(positionFromPointer(event));
    }

    function stopDrag() { dragLine = null; }

    function handleKey(line, event) {
        const amount = event.shiftKey ? 5 : 1;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const values = { a: cutA, b: cutB, c: cutC, d: cutD };
        const previous = { a: 1, b: cutA + MIN_GAP, c: cutB + MIN_GAP, d: cutC + MIN_GAP }[line];
        const next = { a: cutB - MIN_GAP, b: useSecondRegion ? cutC - MIN_GAP : 99, c: cutD - MIN_GAP, d: 99 }[line];
        const current = values[line];
        values[line] = event.key === "Home" ? previous : event.key === "End" ? next : current + (event.key === "ArrowDown" ? amount : -amount);
        if (line === "a") cutA = values[line];
        if (line === "b") cutB = values[line];
        if (line === "c") cutC = values[line];
        if (line === "d") cutD = values[line];
        updateSegments();
    }

    async function loadFile(file) {
        if (!file || !file.type.startsWith("image/")) {
            setStatus("请选择图片文件。", "error");
            return;
        }
        if (file.size > 30 * 1024 * 1024) {
            setStatus("图片超过 30 MB，换一张较小的图片试试。", "error");
            return;
        }

        if (objectUrl) URL.revokeObjectURL(objectUrl);
        clearOutputs();
        originalFile = file;
        objectUrl = URL.createObjectURL(file);
        source.src = objectUrl;
        fileMeta.textContent = `${file.name} · ${formatBytes(file.size)}`;
        imageLabel.textContent = file.name;
        setStatus("正在读取图片…");

        try {
            await source.decode();
        } catch (error) {
            setStatus("图片读取失败，请换一种格式。", "error");
            return;
        }

        imageWidth = source.naturalWidth;
        imageHeight = source.naturalHeight;
        canvasFrame.style.setProperty("--image-ratio", `${imageWidth} / ${imageHeight}`);
        imageSize.textContent = formatDimensions(imageWidth, imageHeight);
        cutA = 22;
        cutB = 34;
        cutC = 66;
        cutD = 78;
        // 换图后贴纸位置是按百分比存的，不需要清空，只要重算一遍尺寸
        refreshStickerLayers();
        // Re-apply the selected mode and region toggle after a new image is loaded.
        // Loading a file used to refresh only the line positions, leaving stale C/D UI visible.
        setOutputMode(outputMode);
        uploadPanel.classList.add("is-collapsed");
        workspace.classList.remove("is-hidden");
        generateButton.disabled = false;
        setStatus("已读取，可以生成。", "success");
        workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function startStickerDrag(event) {
        if (outputMode !== "sticker") return;
        const node = event.currentTarget instanceof Element ? event.currentTarget : null;
        const item = node ? stickerById(node.dataset.stickerId) : null;
        if (!item) return;
        // 点哪张就切到哪张，不用先去列表里选
        if (item.id !== activeStickerId) selectStickerLayer(item.id);
        const rect = canvasFrame.getBoundingClientRect();
        stickerDrag = {
            pointerId: event.pointerId,
            id: item.id,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startX: item.x,
            startY: item.y,
            width: rect.width,
            height: rect.height,
        };
        // 指针捕获可能失败（合成事件、指针已释放、某些触屏环境），失败也要能继续拖
        try {
            node.setPointerCapture?.(event.pointerId);
        } catch (error) { /* 捕获不到就把监听留在自己身上，一样能拖 */ }
        node.classList.add("is-dragging");
        event.preventDefault();
    }

    function moveSticker(event) {
        if (!stickerDrag || event.pointerId !== stickerDrag.pointerId) return;
        const item = stickerById(stickerDrag.id);
        if (!item || !stickerDrag.width || !stickerDrag.height) return;
        item.x = clamp(stickerDrag.startX + (event.clientX - stickerDrag.startClientX) / stickerDrag.width * 100, -5, 105);
        item.y = clamp(stickerDrag.startY + (event.clientY - stickerDrag.startClientY) / stickerDrag.height * 100, -5, 105);
        applyStickerGeometry(item);
        event.preventDefault();
    }

    function stopStickerDrag(event) {
        if (!stickerDrag || (event.pointerId !== undefined && event.pointerId !== stickerDrag.pointerId)) return;
        const item = stickerById(stickerDrag.id);
        item?.node?.classList.remove("is-dragging");
        stickerDrag = null;
    }

    function handleStickerKey(event) {
        if (outputMode !== "sticker" || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        const item = activeSticker();
        if (!item) return;
        const amount = event.shiftKey ? 5 : 1;
        if (event.key === "ArrowLeft") item.x = clamp(item.x - amount, -5, 105);
        if (event.key === "ArrowRight") item.x = clamp(item.x + amount, -5, 105);
        if (event.key === "ArrowUp") item.y = clamp(item.y - amount, -5, 105);
        if (event.key === "ArrowDown") item.y = clamp(item.y + amount, -5, 105);
        applyStickerGeometry(item);
        event.preventDefault();
    }

    function clearPendingSticker() {
        if (pendingStickerUrl) URL.revokeObjectURL(pendingStickerUrl);
        pendingStickerUrl = "";
        pendingStickerName = "";
        pendingStickerFile = null;
        stickerFile.value = "";
        stickerModalPreview.removeAttribute("src");
        stickerModalPreview.alt = "";
        stickerPreviewWrap.classList.add("is-hidden");
        stickerEmptyState?.classList.remove("is-hidden");
        stickerFileName.textContent = "PNG、WebP、GIF 或 JPG";
        stickerModalApply.disabled = true;
    }

    function showPendingSticker() {
        stickerPreviewWrap.classList.remove("is-hidden");
        stickerEmptyState?.classList.add("is-hidden");
    }

    function updateStorageSupport() {
        const supported = typeof indexedDB !== "undefined";
        stickerRememberWrap?.classList.toggle("is-hidden", !supported);
        if (!supported) {
            if (stickerStorageNote) stickerStorageNote.textContent = "当前浏览器不支持本地存储，贴纸不会记录到贴纸库。";
            if (stickerMineNote) stickerMineNote.textContent = "当前浏览器不支持本地存储，我的贴纸库暂时用不了。";
        }
    }

    function openStickerModal() {
        clearPendingSticker();
        updateStorageSupport();
        stickerModal.classList.remove("is-hidden");
        document.body.classList.add("crop-modal-open");
        stickerModalClose.focus();
    }

    function closeStickerModal() {
        clearPendingSticker();
        stickerModal.classList.add("is-hidden");
        document.body.classList.remove("crop-modal-open");
        stickerCustomButton.focus();
    }

    async function previewCustomSticker(file) {
        if (!file || !file.type.startsWith("image/")) {
            clearPendingSticker();
            return;
        }
        if (pendingStickerUrl) URL.revokeObjectURL(pendingStickerUrl);
        pendingStickerUrl = URL.createObjectURL(file);
        pendingStickerName = file.name;
        pendingStickerFile = file;
        stickerModalPreview.src = pendingStickerUrl;
        stickerModalPreview.alt = "自定义贴纸预览";
        try {
            await stickerModalPreview.decode();
        } catch (error) {
            clearPendingSticker();
            stickerFileName.textContent = "图片读取失败，请换一张图片";
            return;
        }
        showPendingSticker();
        stickerFileName.textContent = `${file.name} · ${formatBytes(file.size)}`;
        stickerModalApply.disabled = false;
    }

    async function applyCustomSticker() {
        if (!pendingStickerUrl) return;
        const remember = !!stickerRemember?.checked && typeof indexedDB !== "undefined";
        const sourceFile = pendingStickerFile;
        const displayName = (pendingStickerName || "自定义贴纸").replace(/\.[^.]+$/, "") || "自定义贴纸";
        // pending 的 object URL 直接转交给新贴纸图层持有，这里不能再 revoke
        const nextSrc = pendingStickerUrl;
        pendingStickerUrl = "";
        pendingStickerFile = null;
        pendingStickerName = "";

        const item = addStickerLayer({ src: nextSrc, name: displayName });
        if (!item) {
            URL.revokeObjectURL(nextSrc);
            return;
        }
        stickerModal.classList.add("is-hidden");
        document.body.classList.remove("crop-modal-open");
        stickerFile.value = "";
        setStatus(stickerItems.length > 1 ? `已贴上第 ${stickerItems.length} 张贴纸。` : "贴纸已放上图片。", "success");
        stickerCustomButton.focus();

        if (remember && sourceFile) {
            try {
                const isNew = await saveStickerToLibrary(sourceFile, displayName);
                await refreshPersonalLibrary();
                setStatus(isNew ? `「${displayName}」已记录到我的贴纸库。` : `「${displayName}」已经在贴纸库里了。`, "success");
            } catch (error) {
                setStatus("记录到贴纸库失败，可能浏览器禁用了本地存储。", "error");
            }
        }
    }

    function openPresetLibrary() {
        // 打开时不再自动勾选，避免用户顺手点「贴到图片上」就把同一张叠两次
        selectSticker(null);
        setLibraryStatus("");
        switchStickerTab("preset");
        syncDefaultStickerAvailability();
        stickerPresetModal.classList.remove("is-hidden");
        document.body.classList.add("crop-modal-open");
        refreshPersonalLibrary().then(() => { void autoSeedOnce(); });
        stickerPresetClose.focus();
    }

    function closePresetLibrary() {
        stickerPresetModal.classList.add("is-hidden");
        document.body.classList.remove("crop-modal-open");
        stickerPresetButton.focus();
    }

    async function applyLibrarySelection() {
        if (!stickerSelection) {
            setLibraryStatus("先选一张贴纸。", "error");
            return;
        }
        // 同一次贴纸只能有一张；想叠第二张请换一张图
        if (stickerSelection.kind === "preset" && stickerItems.some((item) => item.src === stickerSelection.src)) {
            setLibraryStatus("这张已经在图上了，换一张试试（同一张不能重复叠）。", "error");
            return;
        }
        let nextSrc = stickerSelection.src || "";
        let createdObjectUrl = "";
        if (stickerSelection.kind === "mine") {
            const record = personalStickers.find((item) => item.id === stickerSelection.id);
            if (!record) {
                setLibraryStatus("这张贴纸已经不在库里了，刷新一下再看看。", "error");
                return;
            }
            createdObjectUrl = URL.createObjectURL(record.blob);
            nextSrc = createdObjectUrl;
        }
        if (!nextSrc) return;
        try {
            const probe = new Image();
            probe.src = nextSrc;
            await probe.decode();
        } catch (error) {
            if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
            setLibraryStatus("贴纸读取失败，换一张试试。", "error");
            return;
        }
        const item = addStickerLayer({ src: nextSrc, name: stickerSelection.name || "贴纸" });
        if (!item) {
            if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
            return;
        }
        closePresetLibrary();
        setStatus(stickerItems.length > 1 ? `已贴上第 ${stickerItems.length} 张贴纸。` : "贴纸已放上图片。", "success");
    }

    function buildCropCanvas(topPercent, bottomPercent) {
        const top = Math.round(imageHeight * topPercent / 100);
        const bottom = Math.round(imageHeight * bottomPercent / 100);
        const height = Math.max(1, bottom - top);
        const canvas = document.createElement("canvas");
        canvas.width = imageWidth;
        canvas.height = height;
        const context = canvas.getContext("2d", { alpha: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(source, 0, top, imageWidth, height, 0, 0, imageWidth, height);
        return canvas;
    }

    function buildQuadCanvas(left, top, width, height) {
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, width);
        canvas.height = Math.max(1, height);
        const context = canvas.getContext("2d", { alpha: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(source, left, top, width, height, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    function wrapCanvasText(context, message, maxWidth) {
        const lines = [];
        message.split(/\r?\n/).forEach((paragraph) => {
            let line = "";
            for (const character of paragraph) {
                const candidate = `${line}${character}`;
                if (line && context.measureText(candidate).width > maxWidth) {
                    lines.push(line);
                    line = character;
                } else {
                    line = candidate;
                }
            }
            if (line) lines.push(line);
        });
        return lines;
    }

    function drawMaskText(context, top, height) {
        const message = maskText.value.trim();
        if (!message || height < 1) return;

        const paddingX = Math.max(20, Math.round(imageWidth * 0.055));
        const paddingY = Math.max(10, Math.round(height * 0.13));
        const maxWidth = Math.max(1, imageWidth - paddingX * 2);
        const availableHeight = Math.max(1, height - paddingY * 2);
        const minFontSize = Math.max(8, Math.min(14, Math.floor(availableHeight * 0.65)));
        let fontSize = Math.max(minFontSize, Math.floor(Math.min(imageWidth * 0.055, height * 0.34, 72)));
        let lines = [];
        let lineHeight = fontSize * 1.35;

        do {
            context.font = `700 ${fontSize}px "Microsoft YaHei", "Segoe UI", sans-serif`;
            lines = wrapCanvasText(context, message, maxWidth);
            lineHeight = fontSize * 1.35;
            if (lines.length * lineHeight <= availableHeight || fontSize <= minFontSize) break;
            fontSize -= 2;
        } while (fontSize >= minFontSize);

        context.save();
        context.beginPath();
        context.rect(0, top, imageWidth, height);
        context.clip();
        context.fillStyle = "#ffffff";
        context.textAlign = "center";
        context.textBaseline = "middle";
        const firstY = top + height / 2 - ((lines.length - 1) * lineHeight) / 2;
        lines.forEach((line, index) => context.fillText(line, imageWidth / 2, firstY + index * lineHeight));
        context.restore();
    }

    function buildMaskedCanvas() {
        const canvas = document.createElement("canvas");
        canvas.width = imageWidth;
        canvas.height = imageHeight;
        const context = canvas.getContext("2d", { alpha: false });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(source, 0, 0, imageWidth, imageHeight);

        const maskRanges = useSecondRegion ? [[cutA, cutB], [cutC, cutD]] : [[cutA, cutB]];
        maskRanges.forEach(([topPercent, bottomPercent]) => {
            const top = Math.round(imageHeight * topPercent / 100);
            const bottom = Math.round(imageHeight * bottomPercent / 100);
            const height = Math.max(1, bottom - top);
            context.fillStyle = "#000000";
            context.fillRect(0, top, imageWidth, height);
            drawMaskText(context, top, height);
        });
        return canvas;
    }

    async function loadStickerImages() {
        // 先把所有贴纸解码好，避免合成阶段 picture 还没加载出来导致漏画
        const images = await Promise.all(stickerItems.map((item) => new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image.naturalWidth ? image : null);
            image.onerror = () => resolve(null);
            image.src = item.src;
        })));
        return images;
    }

    async function buildStickerCanvas() {
        const canvas = document.createElement("canvas");
        canvas.width = imageWidth;
        canvas.height = imageHeight;
        const context = canvas.getContext("2d", { alpha: true });
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(source, 0, 0, imageWidth, imageHeight);
        if (!stickerItems.length) return canvas;

        const images = await loadStickerImages();
        const baseShortSide = Math.min(imageWidth, imageHeight);
        // stickerItems 的顺序就是叠放顺序：先画的在下面
        stickerItems.forEach((item, index) => {
            const image = images[index];
            const naturalWidth = image?.naturalWidth || 0;
            const naturalHeight = image?.naturalHeight || 0;
            if (!naturalWidth || !naturalHeight) return;
            const drawWidth = baseShortSide * item.scale / 100;
            const drawHeight = drawWidth * naturalHeight / naturalWidth;
            const centerX = imageWidth * item.x / 100;
            const centerY = imageHeight * item.y / 100;
            context.save();
            context.translate(centerX, centerY);
            context.rotate(item.angle * Math.PI / 180);
            context.drawImage(image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
            context.restore();
        });
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("无法导出图片")), "image/png");
        });
    }

    async function generate() {
        if (!originalFile || !imageWidth || !imageHeight) return;
        generateButton.disabled = true;
        setStatus(outputMode === "mask" ? "正在生成整张图片…" : outputMode === "split" ? `正在生成${useSecondRegion ? "三" : "两"}张图片…` : outputMode === "grid9" ? "正在生成9宫格…" : outputMode === "sticker" ? "正在合成贴纸图片…" : "正在生成4宫格…");
        clearOutputs();
        const baseName = (originalFile.name.replace(/\.[^.]+$/, "") || "image").replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]+/g, "-").replace(/^-+|-+$/g, "") || "image";

        try {
            if (outputMode === "mask") {
                const blob = await canvasToBlob(buildMaskedCanvas());
                const url = URL.createObjectURL(blob);
                outputUrls.push(url);
                const card = document.createElement("article");
                card.className = "crop-result-card crop-result-card-full";
                card.innerHTML = `
                    <div class="crop-result-image-wrap"><img class="crop-result-image" src="${url}" alt="整图遮挡结果"></div>
                    <div class="crop-result-meta"><strong>整图遮挡结果</strong><span>${formatDimensions(imageWidth, imageHeight)}</span></div>
                    <a class="crop-result-download" href="${url}" download="${baseName}-masked.png"><span aria-hidden="true">⇩</span> 下载 PNG</a>
                `;
                resultGrid.appendChild(card);
                setStatus(`生成完成，已输出一张带${useSecondRegion ? "两个" : "一个"}黑色文字遮挡区域的图片。`, "success");
            } else if (outputMode === "sticker") {
                if (!stickerItems.length) {
                    setStatus("还没有放贴纸，先点「自定义贴纸」或「预设贴纸库」加一张。", "error");
                    results.classList.add("is-hidden");
                    return;
                }
                const blob = await canvasToBlob(await buildStickerCanvas());
                const url = URL.createObjectURL(blob);
                outputUrls.push(url);
                const card = document.createElement("article");
                card.className = "crop-result-card crop-result-card-full";
                card.innerHTML = `
                    <div class="crop-result-image-wrap"><img class="crop-result-image" src="${url}" alt="贴纸遮挡结果"></div>
                    <div class="crop-result-meta"><strong>贴纸遮挡结果</strong><span>${formatDimensions(imageWidth, imageHeight)}</span></div>
                    <a class="crop-result-download" href="${url}" download="${baseName}-sticker.png"><span aria-hidden="true">⇩</span> 下载 PNG</a>
                `;
                resultGrid.appendChild(card);
                setStatus(`生成完成，${stickerItems.length} 张贴纸已合并到原图。`, "success");
            } else if (outputMode === "quad" || outputMode === "grid9") {
                const gridSize = outputMode === "grid9" ? 3 : 2;
                const gridName = outputMode === "grid9" ? "9宫格" : "4宫格";
                const cells = [];
                for (let row = 0; row < gridSize; row += 1) {
                    for (let column = 0; column < gridSize; column += 1) {
                        const left = Math.floor(imageWidth * column / gridSize);
                        const top = Math.floor(imageHeight * row / gridSize);
                        const right = Math.floor(imageWidth * (column + 1) / gridSize);
                        const bottom = Math.floor(imageHeight * (row + 1) / gridSize);
                        const position = `${row + 1}-${column + 1}`;
                        const label = gridSize === 2
                            ? [["左上", "右上"], ["左下", "右下"]][row][column]
                            : `第 ${row * gridSize + column + 1} 格`;
                        cells.push([label, left, top, right - left, bottom - top, position]);
                    }
                }
                for (const [label, left, top, width, height, suffix] of cells) {
                    const blob = await canvasToBlob(buildQuadCanvas(left, top, width, height));
                    const url = URL.createObjectURL(blob);
                    outputUrls.push(url);
                    const card = document.createElement("article");
                    card.className = "crop-result-card crop-result-card-quad";
                    card.innerHTML = `
                        <div class="crop-result-image-wrap"><img class="crop-result-image" src="${url}" alt="${label}${gridName}图片"></div>
                        <div class="crop-result-meta"><strong>${label}</strong><span>${formatDimensions(width, height)}</span></div>
                        <a class="crop-result-download" href="${url}" download="${baseName}-${outputMode}-${suffix}.png"><span aria-hidden="true">⇩</span> 下载 PNG</a>
                    `;
                    resultGrid.appendChild(card);
                }
                setStatus(`生成完成，已自动输出${gridSize * gridSize}张${gridName}图片。`, "success");
            } else {
                const keptRanges = useSecondRegion ? [[0, cutA], [cutB, cutC], [cutD, 100]] : [[0, cutA], [cutB, 100]];
                for (let index = 0; index < keptRanges.length; index += 1) {
                    const [topPercent, bottomPercent] = keptRanges[index];
                    const blob = await canvasToBlob(buildCropCanvas(topPercent, bottomPercent));
                    const url = URL.createObjectURL(blob);
                    outputUrls.push(url);
                    const height = Math.max(1, Math.round(imageHeight * (bottomPercent - topPercent) / 100));
                    const card = document.createElement("article");
                    card.className = "crop-result-card";
                    card.innerHTML = `
                        <div class="crop-result-image-wrap"><img class="crop-result-image" src="${url}" alt="第 ${index + 1} 段裁剪结果"></div>
                        <div class="crop-result-meta"><strong>第 ${index + 1} 段</strong><span>${formatDimensions(imageWidth, height)}</span></div>
                        <a class="crop-result-download" href="${url}" download="${baseName}-part-${index + 1}.png"><span aria-hidden="true">⇩</span> 下载 PNG</a>
                    `;
                    resultGrid.appendChild(card);
                }
                setStatus(`生成完成，已移除${useSecondRegion ? "两个删除区域" : "一个删除区域"}，可下载${useSecondRegion ? "三" : "两"}张保留图片。`, "success");
            }
            results.classList.remove("is-hidden");
            results.scrollIntoView({ behavior: "smooth", block: "start" });
        } catch (error) {
            setStatus("生成失败，请换一张图片重试。", "error");
        } finally {
            generateButton.disabled = false;
        }
    }

    function reset() {
        fileInput.value = "";
        originalFile = null;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = "";
        source.removeAttribute("src");
        // 换图时把贴纸也一起清掉，避免上一批贴纸莫名其妙留到新图上
        clearStickerLayers();
        uploadPanel.classList.remove("is-collapsed");
        workspace.classList.add("is-hidden");
        clearOutputs();
        generateButton.disabled = true;
        fileMeta.textContent = "等待图片";
        imageSize.textContent = "--";
        setStatus("");
    }

    fileInput.addEventListener("change", () => loadFile(fileInput.files?.[0]));
    modeMaskButton.addEventListener("click", () => setOutputMode("mask"));
    modeSplitButton.addEventListener("click", () => setOutputMode("split"));
    modeQuadButton.addEventListener("click", () => setOutputMode("quad"));
    modeNineButton.addEventListener("click", () => setOutputMode("grid9"));
    modeStickerButton.addEventListener("click", () => setOutputMode("sticker"));
    ["dragenter", "dragover"].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add("is-dragover"); }));
    ["dragleave", "drop"].forEach((type) => dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove("is-dragover"); }));
    dropzone.addEventListener("drop", (event) => loadFile(event.dataTransfer?.files?.[0]));
    rangeA.addEventListener("input", () => { cutA = Number(rangeA.value); updateSegments(); });
    rangeB.addEventListener("input", () => { cutB = Number(rangeB.value); updateSegments(); });
    rangeC.addEventListener("input", () => { cutC = Number(rangeC.value); updateSegments(); });
    rangeD.addEventListener("input", () => { cutD = Number(rangeD.value); updateSegments(); });
    maskText.addEventListener("input", updateMaskPreview);
    stickerSize.addEventListener("input", () => {
        const item = activeSticker();
        if (!item) return;
        item.scale = Number(stickerSize.value);
        applyStickerGeometry(item);
        if (stickerSizeValue) stickerSizeValue.textContent = `${Math.round(item.scale)}%`;
    });
    stickerRotation.addEventListener("input", () => {
        const item = activeSticker();
        if (!item) return;
        item.angle = Number(stickerRotation.value);
        applyStickerGeometry(item);
        if (stickerRotationValue) stickerRotationValue.textContent = `${Math.round(item.angle)}°`;
    });
    // 图层列表：点缩略图切换当前编辑对象（动态节点用事件委托）
    stickerLayerList?.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const chip = target?.closest("[data-sticker-chip-id]");
        if (!chip) return;
        selectStickerLayer(chip.dataset.stickerChipId);
    });
    stickerUpButton?.addEventListener("click", () => { if (activeStickerId) moveStickerLayer(activeStickerId, 1); });
    stickerDownButton?.addEventListener("click", () => { if (activeStickerId) moveStickerLayer(activeStickerId, -1); });
    stickerRemoveButton?.addEventListener("click", () => {
        if (!activeStickerId) return;
        removeStickerLayer(activeStickerId);
        setStatus(stickerItems.length ? `已移除，还剩 ${stickerItems.length} 张贴纸。` : "贴纸已全部移除。", "success");
    });
    stickerClearButton?.addEventListener("click", () => {
        if (!stickerItems.length) return;
        clearStickerLayers();
        setStatus("已清空全部贴纸。", "success");
    });
    stickerCustomButton.addEventListener("click", openStickerModal);
    stickerPresetButton.addEventListener("click", openPresetLibrary);
    stickerResetButton.addEventListener("click", resetStickerTransform);
    stickerModalClose.addEventListener("click", closeStickerModal);
    stickerModalCancel.addEventListener("click", closeStickerModal);
    stickerModalApply.addEventListener("click", applyCustomSticker);
    stickerFile.addEventListener("change", () => previewCustomSticker(stickerFile.files?.[0]));
    ["dragenter", "dragover"].forEach((type) => stickerDropzone.addEventListener(type, (event) => {
        event.preventDefault();
        stickerDropzone.classList.add("is-dragover");
    }));
    ["dragleave", "drop"].forEach((type) => stickerDropzone.addEventListener(type, (event) => {
        event.preventDefault();
        stickerDropzone.classList.remove("is-dragover");
    }));
    stickerDropzone.addEventListener("drop", (event) => previewCustomSticker(event.dataTransfer?.files?.[0]));
    // 弹窗任意位置都可以接收拖入的图片
    ["dragenter", "dragover"].forEach((type) => stickerModal.addEventListener(type, (event) => {
        if (stickerModal.classList.contains("is-hidden")) return;
        event.preventDefault();
        stickerDropzone.classList.add("is-dragover");
    }));
    stickerModal.addEventListener("dragleave", (event) => {
        if (stickerModal.classList.contains("is-hidden") || event.target !== stickerModal) return;
        stickerDropzone.classList.remove("is-dragover");
    });
    stickerModal.addEventListener("drop", (event) => {
        if (stickerModal.classList.contains("is-hidden")) return;
        event.preventDefault();
        stickerDropzone.classList.remove("is-dragover");
        const dropTarget = event.target instanceof Element ? event.target : null;
        if (dropTarget && dropTarget.closest("#cropStickerDropzone")) return;
        previewCustomSticker(event.dataTransfer?.files?.[0]);
    });
    // 避免图片被拖到页面空白处时浏览器直接跳转打开图片
    ["dragover", "drop"].forEach((type) => window.addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest(".crop-dropzone, .crop-sticker-dropzone, .crop-sticker-modal")) return;
        event.preventDefault();
    }));
    stickerPresetCards.forEach((card) => card.addEventListener("click", () => {
        if (card.disabled) return;
        selectSticker({ kind: "preset", src: card.dataset.stickerSrc, name: card.dataset.stickerName });
    }));
    stickerPresetClose.addEventListener("click", closePresetLibrary);
    stickerPresetCancel.addEventListener("click", closePresetLibrary);
    stickerPresetApply.addEventListener("click", applyLibrarySelection);
    // 贴纸库分类切换
    stickerTabPreset?.addEventListener("click", () => switchStickerTab("preset"));
    stickerTabMine?.addEventListener("click", () => switchStickerTab("mine"));
    // 我的贴纸库：选中 / 删除（动态节点用事件委托）
    stickerMineLibrary?.addEventListener("click", async (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const deleteButton = target?.closest("[data-delete-id]");
        if (deleteButton) {
            const id = deleteButton.dataset.deleteId;
            try {
                await stickerDbDelete(id);
                personalStickers = personalStickers.filter((item) => item.id !== id);
            } catch (error) {
                setLibraryStatus("删除失败，请重试。", "error");
                return;
            }
            if (stickerSelection && stickerSelection.kind === "mine" && stickerSelection.id === id) selectSticker(null);
            renderPersonalLibrary();
            setLibraryStatus("已从「我的贴纸库」移除。", "success");
            return;
        }
        const card = target?.closest("[data-sticker-kind='mine']");
        if (!card) return;
        selectSticker({ kind: "mine", id: card.dataset.stickerId, name: card.dataset.stickerName });
    });
    // 导入 / 导出 / 用预设初始化个人库
    stickerImportButton?.addEventListener("click", () => stickerImportFile?.click());
    stickerImportFile?.addEventListener("change", async () => {
        const files = [...(stickerImportFile.files || [])];
        stickerImportFile.value = "";
        if (files.length) await importStickerFiles(files);
    });
    stickerExportButton?.addEventListener("click", exportStickerPack);
    stickerSeed?.addEventListener("click", async () => {
        stickerSeed.disabled = true;
        setLibraryStatus("正在复制预设贴纸…");
        const added = await seedFromPresets();
        await refreshPersonalLibrary();
        stickerSeed.disabled = false;
        setLibraryStatus(added ? `已存进 ${added} 张预设贴纸。` : "预设贴纸已经在库里了。", added ? "success" : "");
    });
    lineA.addEventListener("pointerdown", (event) => startDrag("a", event));
    lineB.addEventListener("pointerdown", (event) => startDrag("b", event));
    lineC.addEventListener("pointerdown", (event) => startDrag("c", event));
    lineD.addEventListener("pointerdown", (event) => startDrag("d", event));
    lineA.addEventListener("keydown", (event) => handleKey("a", event));
    lineB.addEventListener("keydown", (event) => handleKey("b", event));
    lineC.addEventListener("keydown", (event) => handleKey("c", event));
    lineD.addEventListener("keydown", (event) => handleKey("d", event));
    canvasFrame.addEventListener("pointermove", (event) => { if (dragLine) moveLine(positionFromPointer(event)); });
    canvasFrame.addEventListener("pointerup", stopDrag);
    canvasFrame.addEventListener("pointercancel", stopDrag);
    generateButton.addEventListener("click", generate);
    resetButton.addEventListener("click", reset);
    downloadAll.addEventListener("click", () => {
        const links = [...resultGrid.querySelectorAll(".crop-result-download")];
        links.forEach((link, index) => window.setTimeout(() => link.click(), index * 180));
    });
    window.addEventListener("beforeunload", () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (pendingStickerUrl) URL.revokeObjectURL(pendingStickerUrl);
        stickerItems.forEach((item) => { if (/^blob:/.test(item.src)) URL.revokeObjectURL(item.src); });
        outputUrls.forEach((url) => URL.revokeObjectURL(url));
    });
    // 把 crop.php 里直接渲染出来的预设贴纸读进数据模型，节点直接复用
    stickerLayers.forEach((node) => {
        const image = node.querySelector("img");
        const src = image?.getAttribute("src") || "";
        if (!src) {
            node.classList.add("is-hidden");
            return;
        }
        node.addEventListener("pointerdown", startStickerDrag);
        node.addEventListener("pointermove", moveSticker);
        node.addEventListener("pointerup", stopStickerDrag);
        node.addEventListener("pointercancel", stopStickerDrag);
        node.addEventListener("keydown", handleStickerKey);
        stickerItems.push({
            id: makeStickerId(),
            name: image.getAttribute("alt") || "预设贴纸",
            src,
            x: 50,
            y: 50,
            scale: STICKER_DEFAULT_SCALE,
            angle: 0,
            node,
        });
    });
    activeStickerId = stickerItems.length ? stickerItems[0].id : "";
    setOutputMode("mask");
    refreshStickerLayers();
})();

/* =========================================================
   图片工坊 · 工具切换
   ========================================================= */
(function () {
    const panes = [...document.querySelectorAll("[data-tool-pane]")];
    const tabs = [...document.querySelectorAll(".crop-tool-tab")];
    if (!panes.length || !tabs.length) return;

    const TOOL_KEY = "nyacraft-crop-tool";
    const TOOL_HINTS = {
        crop: "遮挡敏感区域、把长图切成几段、或者在两张图之间滑动对比",
        compare: "放入两张图，拖住中间那条线左右滑动；导出时两张都完整保留",
    };
    const toolHint = document.getElementById("cropToolHint");

    const setTool = (tool, remember) => {
        const name = tool === "compare" ? "compare" : "crop";
        tabs.forEach((tab) => {
            const on = tab.dataset.tool === name;
            tab.classList.toggle("is-active", on);
            tab.setAttribute("aria-selected", String(on));
        });
        panes.forEach((pane) => {
            pane.classList.toggle("is-hidden", pane.dataset.toolPane !== name);
        });
        if (toolHint) toolHint.textContent = TOOL_HINTS[name] || "";
        if (remember) {
            try { localStorage.setItem(TOOL_KEY, name); } catch (error) { /* 隐私模式可能禁用 */ }
        }
    };

    tabs.forEach((tab, index) => {
        tab.addEventListener("click", () => setTool(tab.dataset.tool, true));
        tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            const step = event.key === "ArrowLeft" ? -1 : 1;
            const next = tabs[(index + step + tabs.length) % tabs.length];
            if (!next) return;
            setTool(next.dataset.tool, true);
            next.focus();
            event.preventDefault();
        });
    });

    let saved = "crop";
    try { saved = localStorage.getItem(TOOL_KEY) || "crop"; } catch (error) { /* 忽略 */ }
    setTool(saved, false);
})();

/* =========================================================
   图片工坊 · 图片对比
   两层图重叠，上层用 clip-path 裁切；拖动只改一个 CSS 变量。
   ========================================================= */
(function () {
    const stage = document.getElementById("cropCompareStage");
    if (!stage) return;

    const canvasEl = document.getElementById("cropCompareCanvas");
    const handle = document.getElementById("cropCompareHandle");
    const imgLeft = document.getElementById("cropCompareLeft");
    const imgRight = document.getElementById("cropCompareRight");
    const tagLeft = document.getElementById("cropCompareTagLeft");
    const tagRight = document.getElementById("cropCompareTagRight");
    const tagLeftInput = document.getElementById("cropCompareTagLeftInput");
    const tagRightInput = document.getElementById("cropCompareTagRightInput");
    const exportButton = document.getElementById("cropCompareExport");
    const statusEl = document.getElementById("cropCompareStatus");
    const clearButton = document.getElementById("cropCompareClearAll");

    const sides = {
        a: {
            file: document.getElementById("cropCompareFileA"),
            slot: document.getElementById("cropCompareSlotA"),
            thumb: document.getElementById("cropCompareThumbA"),
            empty: document.getElementById("cropCompareEmptyA"),
            meta: document.getElementById("cropCompareMetaA"),
            record: null,
        },
        b: {
            file: document.getElementById("cropCompareFileB"),
            slot: document.getElementById("cropCompareSlotB"),
            thumb: document.getElementById("cropCompareThumbB"),
            empty: document.getElementById("cropCompareEmptyB"),
            meta: document.getElementById("cropCompareMetaB"),
            record: null,
        },
    };

    const setStatus = (message) => { if (statusEl) statusEl.textContent = message || ""; };

    const paintSlot = (side) => {
        const item = sides[side];
        const record = item.record;
        if (record) {
            item.thumb.src = record.url;
            item.thumb.hidden = false;
            item.empty.hidden = true;
            item.meta.textContent = record.width + " × " + record.height;
            item.slot.classList.add("is-filled");
        } else {
            item.thumb.removeAttribute("src");
            item.thumb.hidden = true;
            item.empty.hidden = false;
            item.meta.textContent = "";
            item.slot.classList.remove("is-filled");
        }
    };

    const readImage = (file) => new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) {
            reject(new Error("只能放图片文件。"));
            return;
        }
        const url = URL.createObjectURL(file);
        const probe = new Image();
        probe.onload = () => resolve({ url, image: probe, width: probe.naturalWidth, height: probe.naturalHeight });
        probe.onerror = () => { URL.revokeObjectURL(url); reject(new Error("这张图读不出来，换一张试试。")); };
        probe.src = url;
    });

    const setPosition = (pct) => {
        const value = Math.max(0, Math.min(100, pct));
        canvasEl.style.setProperty("--compare-pos", value + "%");
        handle.setAttribute("aria-valuenow", String(Math.round(value)));
    };

    const syncTags = () => {
        const left = (tagLeftInput.value || "").trim();
        const right = (tagRightInput.value || "").trim();
        tagLeft.textContent = left;
        tagLeft.hidden = left === "";
        tagRight.textContent = right;
        tagRight.hidden = right === "";
    };

    const refresh = () => {
        const ready = Boolean(sides.a.record && sides.b.record);
        stage.classList.toggle("is-hidden", !ready);
        if (exportButton) exportButton.disabled = !ready;
        if (!ready) return;
        canvasEl.style.setProperty("--compare-ratio", String(sides.a.record.width / sides.a.record.height));
        imgLeft.src = sides.a.record.url;
        imgRight.src = sides.b.record.url;
        setPosition(50);
    };

    const place = (side, file) => {
        if (!file) return;
        readImage(file).then((record) => {
            const item = sides[side];
            if (item.record) URL.revokeObjectURL(item.record.url);
            item.record = record;
            paintSlot(side);
            setStatus("");
            refresh();
        }).catch((error) => setStatus(error.message || "图片读不出来。"));
    };

    const clearAll = () => {
        ["a", "b"].forEach((side) => {
            const item = sides[side];
            if (item.record) URL.revokeObjectURL(item.record.url);
            item.record = null;
            paintSlot(side);
        });
        imgLeft.removeAttribute("src");
        imgRight.removeAttribute("src");
        tagLeftInput.value = "";
        tagRightInput.value = "";
        syncTags();
        setStatus("");
        refresh();
        sides.a.slot.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    let dragging = false;
    const pctFromEvent = (event) => {
        const rect = canvasEl.getBoundingClientRect();
        if (!rect.width) return 50;
        return ((event.clientX - rect.left) / rect.width) * 100;
    };
    const startDrag = (event) => {
        if (!sides.a.record || !sides.b.record) return;
        dragging = true;
        canvasEl.classList.add("is-dragging");
        handle.focus({ preventScroll: true });
        setPosition(pctFromEvent(event));
        // 合成事件与已释放的指针会抛错，包一层免得整个拖拽失效
        try { handle.setPointerCapture(event.pointerId); } catch (error) { /* 忽略 */ }
        event.preventDefault();
    };
    const moveDrag = (event) => {
        if (!dragging) return;
        setPosition(pctFromEvent(event));
        event.preventDefault();
    };
    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        canvasEl.classList.remove("is-dragging");
    };

    const exportCompare = () => {
        if (!sides.a.record || !sides.b.record) return;
        const a = sides.a.record.image;
        const b = sides.b.record.image;
        // 两张统一到同一高度，各自按原始比例缩放，谁也不裁切
        const height = Math.min(1800, Math.max(a.naturalHeight, b.naturalHeight));
        const widthA = Math.max(1, Math.round(a.naturalWidth * (height / a.naturalHeight)));
        const widthB = Math.max(1, Math.round(b.naturalWidth * (height / b.naturalHeight)));
        const pad = Math.round(height * 0.024);
        const gap = Math.round(height * 0.024);
        const labelA = (tagLeftInput.value || "").trim();
        const labelB = (tagRightInput.value || "").trim();
        const hasLabel = labelA !== "" || labelB !== "";
        const labelBand = hasLabel ? Math.round(height * 0.062) : 0;

        const out = document.createElement("canvas");
        out.width = pad * 2 + widthA + gap + widthB;
        out.height = pad * 2 + height + labelBand;
        const ctx = out.getContext("2d");
        ctx.fillStyle = "#0d0f14";
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(a, pad, pad, widthA, height);
        ctx.drawImage(b, pad + widthA + gap, pad, widthB, height);

        if (hasLabel) {
            const fontSize = Math.round(height * 0.026);
            ctx.font = "700 " + fontSize + 'px "Microsoft YaHei", "Segoe UI", sans-serif';
            ctx.fillStyle = "#9aa3af";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            const baseline = pad + height + labelBand / 2;
            if (labelA) ctx.fillText(labelA, pad + widthA / 2, baseline);
            if (labelB) ctx.fillText(labelB, pad + widthA + gap + widthB / 2, baseline);
        }

        out.toBlob((blob) => {
            if (!blob) { setStatus("导出失败了，再试一次。"); return; }
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
            link.href = url;
            link.download = "compare-" + stamp + ".png";
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 4000);
            setStatus("已导出 " + out.width + " × " + out.height + " 的对比图。");
        }, "image/png");
    };

    ["a", "b"].forEach((side) => {
        const item = sides[side];
        item.file.addEventListener("change", () => {
            place(side, item.file.files && item.file.files[0]);
            item.file.value = "";
        });
        item.slot.addEventListener("dragover", (event) => {
            event.preventDefault();
            item.slot.classList.add("is-dragover");
        });
        item.slot.addEventListener("dragleave", () => item.slot.classList.remove("is-dragover"));
        item.slot.addEventListener("drop", (event) => {
            event.preventDefault();
            item.slot.classList.remove("is-dragover");
            const dropped = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
            if (dropped) place(side, dropped);
        });
    });

    handle.addEventListener("pointerdown", startDrag);
    canvasEl.addEventListener("pointerdown", (event) => {
        if (handle.contains(event.target)) return;
        startDrag(event);
    });
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);

    handle.addEventListener("keydown", (event) => {
        const current = Number(handle.getAttribute("aria-valuenow")) || 50;
        let next = null;
        if (event.key === "ArrowLeft") next = current - 2;
        else if (event.key === "ArrowRight") next = current + 2;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = 100;
        if (next === null) return;
        setPosition(next);
        event.preventDefault();
    });

    canvasEl.addEventListener("dblclick", () => setPosition(50));
    tagLeftInput.addEventListener("input", syncTags);
    tagRightInput.addEventListener("input", syncTags);
    if (exportButton) exportButton.addEventListener("click", exportCompare);
    if (clearButton) clearButton.addEventListener("click", clearAll);

    refresh();
})();
