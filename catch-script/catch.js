(function () {
    class CatCatcher {
        constructor() {
            this.settings = { watchedOnCaptureComplete: true, watchedOnTabClose: false, watchedOnNextVideo: false }; // Defaults, will be updated
            this.tabId = null;
            this.boundMessageHandler = this.handleBackgroundMessage.bind(this);

            console.log("CatCatch: Constructor - Initializing...");

            // 初始化属性
            this.enable = true;  // 捕获开关
            this.language = navigator.language;   // 语言设置
            this.isComplete = false; // 捕获完成标志
            this.catchMedia = [];   // 捕获的媒体数据
            this.mediaSize = 0; // 捕获的媒体数据大小
            this.setFileName = null;    // 文件名
            console.log(`CatCatch: Constructor - Initial state: enable=${this.enable}, isComplete=${this.isComplete}, catchMedia.length=${this.catchMedia.length}, mediaSize=${this.mediaSize}`);

            // 移动面板相关属性
            this.x = 0;
            this.y = 0;

            // 初始化语言
            if (window.CatCatchI18n) {
                if (!window.CatCatchI18n.languages.includes(this.language)) {
                    this.language = this.language.split("-")[0];
                    if (!window.CatCatchI18n.languages.includes(this.language)) {
                        this.language = "en";
                    }
                }
            }

            // 初始化组件
            // 删除iframe sandbox属性 避免 issues #576
            this.setupIframeProcessing();

            // 初始化 Trusted Types
            this.initTrustedTypes();

            // 创建和设置UI
            this.createUI();

            // 代理MediaSource方法
            this.proxyMediaSourceMethods();

            this.getSettingsAndTabId();
            window.addEventListener("message", this.boundMessageHandler);
        }

        getSettingsAndTabId() {
            // console.log("CatCatch (original): Requesting settings and tabId.");
            window.postMessage({
                action: "catCatchToBackground", // For content-script to pick up
                Message: "getCaptureSettings"   // Specific message for background.js
            }, "*");
        }

        handleBackgroundMessage(event) {
            // Check message source and if it's one of ours (relayed by content-script)
            if (event.source === window && event.data && event.data.catCatchInternalMessage) {
                const { action, command, filenameHint, settings, tabId } = event.data; // payload from content-script

                // console.log("CatCatch (original): Received internal message:", event.data);

                if (action === "receiveSettingsAndTabId") {
                    if (settings) {
                        this.settings = { ...this.settings, ...settings };
                        // console.log("CatCatch (original): Settings updated:", this.settings);
                    }
                    if (tabId) {
                        this.tabId = tabId;
                        // console.log("CatCatch (original): tabId set:", this.tabId);
                    }
                } else if (command === "triggerDownloadFromCache") {
                    // console.log("CatCatch (original): 'triggerDownloadFromCache' command received.");
                    if (this.catchMedia && this.catchMedia.length > 0 && this.catchMedia[0]?.bufferList?.length > 0) {
                        this.catchDownload(); // Call the original catchDownload method
                    } else {
                        // console.log("CatCatch (original): No data to download for 'triggerDownloadFromCache'.");
                    }
                } else if (command === "shutdown") {
                    // console.log("CatCatch (original): 'shutdown' command received.");
                    this.handleShutdown();
                }
            }
        }

        handleShutdown() {
            // console.log("CatCatch (original): Shutting down.");
            this.enable = false; // Stop further capturing/interactions in existing logic
            if (this.catCatch) { // this.catCatch is the main UI div
                this.catCatch.style.display = 'none'; // Hide UI
            }
            if (this.boundMessageHandler) {
                window.removeEventListener("message", this.boundMessageHandler);
            }
            // Note: The original script doesn't have other intervals like storageSaveInterval to clear.
        }

        /**
         * 设置iframe处理，删除sandbox属性
         * 解决 issues #576
         */
        setupIframeProcessing() {
            document.addEventListener('DOMContentLoaded', () => {
                const processIframe = (iframe) => {
                    if (iframe && iframe.hasAttribute && iframe.hasAttribute('sandbox')) {
                        const clonedIframe = iframe.cloneNode(true);
                        clonedIframe.removeAttribute('sandbox');
                        if (iframe.parentNode) {
                            iframe.parentNode.replaceChild(clonedIframe, iframe);
                        }
                    }
                };

                document.querySelectorAll('iframe').forEach(processIframe);

                const observer = new MutationObserver((mutationsList) => {
                    for (const mutation of mutationsList) {
                        if (mutation.type === 'childList') {
                            mutation.addedNodes.forEach(node => {
                                if (node.nodeName === 'IFRAME') {
                                    processIframe(node);
                                } else if (node.querySelectorAll) {
                                    node.querySelectorAll('iframe').forEach(processIframe);
                                }
                            });
                        }
                    }
                });
                observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
            });
        }

        /**
         * 初始化 Trusted Types
         */
        initTrustedTypes() {
            let createHTML = (string) => {
                try {
                    const fakeDiv = document.createElement('div');
                    fakeDiv.innerHTML = string;
                    createHTML = (string) => string;
                } catch (e) {
                    if (typeof trustedTypes !== 'undefined') {
                        const policy = trustedTypes.createPolicy('catCatchPolicy', { createHTML: (s) => s });
                        createHTML = (string) => policy.createHTML(string);
                        const _innerHTML = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
                        Object.defineProperty(Element.prototype, 'innerHTML', {
                            set: function (value) {
                                _innerHTML.set.call(this, createHTML(value));
                            }
                        });
                    } else {
                        console.warn("trustedTypes不可用，跳过安全策略设置");
                    }
                }
            };
            createHTML("<div></div>");
        }

        /**
         * 创建UI元素
         */
        createUI() {
            const buttonStyle = 'style="border:solid 1px #000;margin:2px;padding:2px;background:#fff;border-radius:4px;border:solid 1px #c7c7c780;color:#000;"';
            const checkboxStyle = 'style="-webkit-appearance: auto;"';

            this.catCatch = document.createElement("div");
            this.catCatch.setAttribute("id", "CatCatchCatch");
            const style = `
                display: flex;
                flex-direction: column;
                align-items: flex-start;`;
            this.catCatch.innerHTML = `<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYBAMAAAASWSDLAAAAKlBMVEUAAADLlROxbBlRAD16GS5oAjWWQiOCIytgADidUx/95gHqwwTx0gDZqwT6kfLuAAAACnRSTlMA/vUejV7kuzi8za0PswAAANpJREFUGNNjwA1YSxkYTEqhnKZLLi6F1w0gnKA1shdvHYNxdq1atWobjLMKCOAyC3etlVrUAOH4HtNZmLgoAMKpXX37zO1FwcZAwMDguGq1zKpFmTNnzqx0Bpp2WvrU7ttn9py+I8JgLn1R8Pad22vurNkjwsBReHv33junzuyRnOnMwNCSeFH27K5dq1SNgcZxFMnuWrNq1W5VkNntihdv7ToteGcT0C7mIkE1qbWCYjJnM4CqEoWKdoslChXuUgXJqIcLebiphSgCZRhaPDhcDFhdmUMCGIgEAFA+Uc02aZg9AAAAAElFTkSuQmCC" style="-webkit-user-drag: none;width: 20px;">
            <div id="catCatch" style="${style}">
                <div id="tips"></div>
                <button id="download" ${buttonStyle} data-i18n="downloadCapturedData">下载已捕获的数据</button>
                <button id="clean" ${buttonStyle} data-i18n="deleteCapturedData">删除已捕获数据</button>
                <div><button id="hide" ${buttonStyle} data-i18n="hide">隐藏</button><button id="close" ${buttonStyle} data-i18n="close">关闭</button></div>
                <label><input type="checkbox" id="autoDown" ${localStorage.getItem("CatCatchCatch_autoDown") || ""} ${checkboxStyle}><span data-i18n="automaticDownload">Automatic download</span></label>
                <label><input type="radio" name="mergeOptions" id="ffmpegMerge" ${localStorage.getItem("CatCatchCatch_ffmpegMerge") === "checked" ? "checked" : ""} ${checkboxStyle} value="ffmpeg"><span data-i18n="ffmpeg">Use ffmpeg for merging</span></label>
                <label><input type="radio" name="mergeOptions" id="localMerge" ${localStorage.getItem("CatCatchCatch_localMerge") === "checked" ? "checked" : ""} ${checkboxStyle} value="local"><span data-i18n="localMergeLabel">Merge Locally (MP4Box)</span></label>
                <label><input type="radio" name="mergeOptions" id="noMerge" ${localStorage.getItem("CatCatchCatch_noMerge") === "checked" || (!localStorage.getItem("CatCatchCatch_ffmpegMerge") && !localStorage.getItem("CatCatchCatch_localMerge")) ? "checked" : ""} ${checkboxStyle} value="none"><span data-i18n="downloadSeparateFiles">Download separate files</span></label>
                <label><input type="checkbox" id="autoToBuffered" ${checkboxStyle}><span data-i18n="autoToBuffered">Auto jump to buffered end</span></label>
                <label><input type="checkbox" id="checkHead" ${checkboxStyle}><span data-i18n="cleanupRedundantHeaderData">Cleanup redundant header data</span></label>
                <label><input type="checkbox" id="completeClearCache" ${localStorage.getItem("CatCatchCatch_completeClearCache") || ""} ${checkboxStyle}><span data-i18n="clearDataAfterDownload">Clear data after download</span></label>
                <details>
                    <summary data-i18n="fileName" id="summary">File Name Settings</summary>
                    <div style="font-weight:bold;"><span data-i18n="fileName">File Name</span>: </div><div id="fileName"></div>
                    <div style="font-weight:bold;"><span data-i18n="selector">Selector</span>: </div><div id="selector">Null</div>
                    <div style="font-weight:bold;"><span data-i18n="regular">Regex</span>: </div><div id="regular">Null</div>
                    <button id="setSelector" ${buttonStyle} data-i18n="usingSelector">Use Selector</button>
                    <button id="setRegular" ${buttonStyle} data-i18n="usingRegular">Use Regex</button>
                    <button id="setFileName" ${buttonStyle} data-i18n="customize">Customize</button>
                </details>
                <details>
                <summary data-i18n="test">Test</summary>
                    <button id="test" ${buttonStyle} data-i18n="test">Test</button>
                    <button id="restart" ${buttonStyle} data-i18n="capturedBeginning">Capture from Beginning</button>
                    <label><input type="checkbox" id="restartAlways" ${localStorage.getItem("CatCatchCatch_restart") || ""} ${checkboxStyle}><span data-i18n="alwaysCapturedBeginning">Always Capture from Beginning</span>(beta)</label>
                </details>
            </div>`;
            this.catCatch.style = `
                position: fixed;
                z-index: 999999;
                top: 10%;
                left: 90%;
                background: rgb(255 255 255 / 85%);
                border: solid 1px #c7c7c7;
                border-radius: 4px;
                color: rgb(26, 115, 232);
                padding: 5px 5px 5px 5px;
                font-size: 12px;
                font-family: "Microsoft YaHei", "Helvetica", "Arial", sans-serif;
                user-select: none;`;

            // *** START NEW CODE ***
            // Set initial minimized state AFTER base styles are applied
            const controlsPanel = this.catCatch.querySelector('#catCatch');
            if (controlsPanel) {
                controlsPanel.style.display = 'none';
            }
            this.catCatch.style.opacity = '0.5';
            // *** END NEW CODE ***

            // 创建 Shadow DOM
            this.createShadowRoot();

            // 初始化UI元素引用
            this.tips = this.catCatch.querySelector("#tips");
            this.fileName = this.catCatch.querySelector("#fileName");
            this.selector = this.catCatch.querySelector("#selector");
            this.regular = this.catCatch.querySelector("#regular");

            if (!this.tips || !this.fileName || !this.selector || !this.regular) {
                console.error("UI元素初始化失败，找不到必要的DOM元素");
            }

            // 初始化显示
            this.tips.innerHTML = this.i18n("waiting", "等待视频播放");
            this.selector.innerHTML = localStorage.getItem("CatCatchCatch_selector") ?? "Null";
            this.regular.innerHTML = localStorage.getItem("CatCatchCatch_regular") ?? "Null";

            // 绑定事件
            this.bindEvents();

            // 自动从头捕获设置
            if (localStorage.getItem("CatCatchCatch_restart") == "checked") {
                this.setupAutoRestart();
            }
        }

        /**
         * 创建 Shadow DOM
         * 解决 issues #693 安全使用attachShadow 从iframe中获取原生方法
         */
        createShadowRoot() {
            try {
                // 解决 issues #693 安全使用attachShadow 从iframe中获取原生方法
                const createSecureShadowRoot = (element, mode = 'closed') => {
                    const getPristineAttachShadow = () => {
                        try {
                            const iframe = document.createElement('iframe');
                            const parentNode = document.body || document.documentElement;
                            parentNode.appendChild(iframe);
                            const pristineMethod = iframe.contentDocument.createElement('div').attachShadow;
                            iframe.remove();
                            if (pristineMethod) return pristineMethod;
                        } catch (e) {
                            console.log("获取原生attachShadow方法失败:", e);
                        }
                        return Element.prototype.attachShadow;
                    };

                    const executor = Element.prototype.attachShadow.toString().includes('[native code]')
                        ? Element.prototype.attachShadow.bind(element)
                        : getPristineAttachShadow().bind(element);

                    try {
                        return executor({ mode });
                    } catch (e) {
                        console.error('Shadow DOM 创建失败:', e);
                        // 应急处理：降级方案
                        return document.createElement('div');
                    }
                };

                // 创建 Shadow DOM 放入CatCatch
                const divShadow = document.createElement('div');
                const shadowRoot = createSecureShadowRoot(divShadow);
                shadowRoot.appendChild(this.catCatch);

                // 页面插入Shadow DOM
                const htmlElement = document.getElementsByTagName('html')[0];
                if (htmlElement) {
                    htmlElement.appendChild(divShadow);
                } else {
                    document.appendChild(divShadow);
                }
            } catch (error) {
                console.error("创建Shadow DOM失败:", error);
                // 降级方案：直接添加到body
                try {
                    const body = document.body || document.documentElement;
                    body.appendChild(this.catCatch);
                } catch (e) {
                    console.error("降级添加UI也失败:", e);
                }
            }
        }

        /**
         * 绑定事件处理函数
         */
        bindEvents() {
            // 移动面板相关事件
            this.catCatch.addEventListener('mousedown', this.handleDragStart.bind(this));

            // 设置选项相关事件
            const autoDown = this.catCatch.querySelector("#autoDown");
            if (autoDown) autoDown.addEventListener('change', this.handleAutoDownChange.bind(this));

            // ربط معالج الحدث الجديد لأزرار الراديو
            const mergeOptions = this.catCatch.querySelectorAll("input[name='mergeOptions']");
            mergeOptions.forEach(radio => {
                radio.addEventListener('change', this.handleMergeOptionChange.bind(this));
            });

            const restartAlways = this.catCatch.querySelector("#restartAlways");
            if (restartAlways) restartAlways.addEventListener('change', this.handleRestartAlwaysChange.bind(this));

            // 按钮相关事件
            const clean = this.catCatch.querySelector("#clean");
            if (clean) clean.addEventListener('click', this.handleClean.bind(this));

            const download = this.catCatch.querySelector("#download");
            if (download) download.addEventListener('click', this.handleDownload.bind(this));

            const hide = this.catCatch.querySelector("#hide");
            if (hide) hide.addEventListener('click', this.handleHide.bind(this));

            const img = this.catCatch.querySelector("img");
            if (img) img.addEventListener('click', this.handleHide.bind(this));

            const close = this.catCatch.querySelector("#close");
            if (close) close.addEventListener('click', this.handleClose.bind(this));

            const restart = this.catCatch.querySelector("#restart");
            if (restart) restart.addEventListener('click', this.handleRestart.bind(this));

            const setFileName = this.catCatch.querySelector("#setFileName");
            if (setFileName) setFileName.addEventListener('click', this.handleSetFileName.bind(this));

            const test = this.catCatch.querySelector("#test");
            if (test) test.addEventListener('click', this.handleTest.bind(this));

            const summary = this.catCatch.querySelector("#summary");
            if (summary) summary.addEventListener('click', this.getFileName.bind(this));

            const completeClearCache = this.catCatch.querySelector("#completeClearCache");
            if (completeClearCache) completeClearCache.addEventListener('click', this.handleCompleteClearCache.bind(this));

            // 自动跳转到缓冲节点
            this.autoToBufferedFlag = true;
            const autoToBuffered = this.catCatch.querySelector("#autoToBuffered");
            if (autoToBuffered) autoToBuffered.addEventListener('click', this.handleAutoToBuffered.bind(this));

            // 文件名设置相关事件
            const setSelector = this.catCatch.querySelector("#setSelector");
            if (setSelector) setSelector.addEventListener('click', this.handleSetSelector.bind(this));

            const setRegular = this.catCatch.querySelector("#setRegular");
            if (setRegular) setRegular.addEventListener('click', this.handleSetRegular.bind(this));

            // i18n 处理
            this.applyI18n();
        }

        /**
         * 应用国际化文本
         */
        applyI18n() {
            if (window.CatCatchI18n) {
                this.catCatch.querySelectorAll('[data-i18n]').forEach((element) => {
                    if (element && element.dataset && element.dataset.i18n) {
                        element.innerHTML = window.CatCatchI18n[element.dataset.i18n][this.language] || element.innerHTML;
                    }
                });
                this.catCatch.querySelectorAll('[data-i18n-outer]').forEach((element) => {
                    if (element && element.dataset && element.dataset.i18nOuter) {
                        element.outerHTML = window.CatCatchI18n[element.dataset.i18nOuter][this.language] || element.outerHTML;
                    }
                });
            }
        }

        /**
         * 翻译函数
         * @param {String} key 
         * @param {String|null} original 原始文本
         * @returns 翻译后的文本
         */
        i18n(key, original = "") {
            if (!window.CatCatchI18n || !key || !window.CatCatchI18n[key]) { return original; }
            return window.CatCatchI18n[key][this.language] || original;
        }

        /**
         * 处理面板拖动事件
         * @param {MouseEvent} event
         */
        handleDragStart(event) {
            this.x = event.pageX - this.catCatch.offsetLeft;
            this.y = event.pageY - this.catCatch.offsetTop;

            const moveHandler = this.handleMove.bind(this);
            document.addEventListener('mousemove', moveHandler);

            document.addEventListener('mouseup', () => {
                document.removeEventListener('mousemove', moveHandler);
            }, { once: true });
        }

        /**
         * 处理面板移动事件
         * 通过鼠标事件更新面板位置
         * @param {MouseEvent} event 
         */
        handleMove(event) {
            if (!this.catCatch) return;
            this.catCatch.style.left = (event.pageX - this.x) + 'px';
            this.catCatch.style.top = (event.pageY - this.y) + 'px';
        }

        handleAutoDownChange(event) {
            localStorage.setItem("CatCatchCatch_autoDown", event.target.checked ? "checked" : "");
        }

        handleMergeOptionChange(event) {
            const selectedOption = event.target.value;
            localStorage.setItem("CatCatchCatch_ffmpegMerge", selectedOption === "ffmpeg" ? "checked" : "");
            localStorage.setItem("CatCatchCatch_localMerge", selectedOption === "local" ? "checked" : "");
            localStorage.setItem("CatCatchCatch_noMerge", selectedOption === "none" ? "checked" : "");

            // For older ffmpeg checkbox value, ensure it's cleared if a radio is selected
            // or set if ffmpeg radio is selected, for compatibility with existing logic that might still use it.
            // This part can be removed once all logic fully transitions to the new radio button values.
            if (selectedOption === "ffmpeg") {
                localStorage.setItem("CatCatchCatch_ffmpeg", "checked");
            } else {
                localStorage.removeItem("CatCatchCatch_ffmpeg");
            }
        }

        handleRestartAlwaysChange(event) {
            localStorage.setItem("CatCatchCatch_restart", event.target.checked ? "checked" : "");
        }

        /**
         * 处理清理缓存事件
         * @param {MouseEvent} event 
         */
        handleClean(event) {
            console.log("CatCatch: handleClean called.");
            if (window.confirm(this.i18n("clearCacheConfirmation", "确认清除缓存?"))) {
                console.log("CatCatch: Clearing cache confirmed by user.");
                this.clearCache();
                const $clean = this.catCatch.querySelector("#clean");
                if (!$clean) return;

                $clean.innerHTML = this.i18n("cleanupCompleted", "清理完成!");
                setTimeout(() => {
                    if ($clean) $clean.innerHTML = this.i18n("clearCache", "清理缓存");
                }, 1000);
            }
        }

        /**
         * 处理下载事件
         * @param {MouseEvent} event 
         */
        handleDownload(event) {
            try {
                if (this.isComplete || window.confirm(this.i18n("downloadConfirmation", "提前下载可能会造成数据混乱.确认？"))) {
                    this.catchDownload();
                }
            } catch (error) {
                console.error("下载处理失败:", error);
                alert(this.i18n("downloadError", "下载过程中出错，请查看控制台"));
            }
        }

        handleHide(event) {
            const catCatchElement = this.catCatch.querySelector('#catCatch');
            if (catCatchElement.style.display === "none") {
                catCatchElement.style.display = "flex";
                this.catCatch.style.opacity = "";
            } else {
                catCatchElement.style.display = "none";
                this.catCatch.style.opacity = "0.5";
            }
        }

        handleClose(event) {
            if (this.isComplete || window.confirm(this.i18n("closeConfirmation", "确认关闭?"))) {
                this.clearCache();
                this.enable = false;
                this.catCatch.style.display = "none";
                window.postMessage({ action: "catCatchToBackground", Message: "script", script: "catch.js", refresh: false });
            }
        }

        /**
         * 从头捕获
         * @param {MouseEvent} event 
         */
        handleRestart(event) {
            const checkHead = this.catCatch.querySelector("#checkHead");
            if (checkHead) checkHead.checked = true;

            // ----- بداية التعديل المقترح -----
            console.log("CatCatch: handleRestart called.");
            const checkHead = this.catCatch.querySelector("#checkHead");
            if (checkHead) checkHead.checked = true;

            // ----- بداية التعديل المقترح -----
            console.log("CatCatch: Restarting capture. Clearing all media.");
            this.catchMedia = []; // مسح كامل للبيانات الملتقطة
            this.mediaSize = 0;
            this.isComplete = false; // إعادة تعيين حالة الاكتمال
            if (this.tips) {
                this.tips.innerHTML = this.i18n("waiting", "等待视频播放");
            }
            console.log(`CatCatch: handleRestart - State after reset: isComplete=${this.isComplete}, catchMedia.length=${this.catchMedia.length}, mediaSize=${this.mediaSize}`);
            // ----- نهاية التعديل المقترح -----

            // clearCache() الأصلي قد لا يمسح كل شيء، لذا قمنا بالمسح المباشر أعلاه.
            // this.clearCache(); // يمكن إبقاؤه إذا كان يقوم بعمليات تنظيف أخرى ضرورية

            document.querySelectorAll("video").forEach((element) => {
                try { // إضافة try-catch هنا
                    element.currentTime = 0;
                    element.play();
                } catch (e) {
                    console.warn("CatCatch: Error trying to restart video:", e);
                }
            });
        }

        handleSetFileName(event) {
            this.setFileName = window.prompt(this.i18n("fileName", "输入文件名, 不包含扩展名"), this.setFileName ?? "");
            this.getFileName();
        }

        handleTest(event) {
            console.log("捕获的媒体数据:", this.catchMedia);
        }

        handleCompleteClearCache(event) {
            localStorage.setItem("CatCatchCatch_completeClearCache", event.target.checked ? "checked" : "");
        }

        /**
         * 自动缓冲尾
         * @param {MouseEvent} event 
         */
        handleAutoToBuffered(event) {
            if (!this.autoToBufferedFlag) return;
            this.autoToBufferedFlag = false;

            const $autoToBuffered = this.catCatch.querySelector("#autoToBuffered");
            if (!$autoToBuffered) return;

            const videos = document.querySelectorAll("video");
            for (let video of videos) {
                video.addEventListener("progress", (event) => {
                    try {
                        if (video.buffered && video.buffered.length > 0) {
                            const bufferedEnd = video.buffered.end(0);
                            if ($autoToBuffered.checked && bufferedEnd < video.duration) {
                                video.currentTime = bufferedEnd - 5;
                            }
                        }
                    } catch (error) {
                        console.error("处理缓冲进度失败:", error);
                    }
                });

                video.addEventListener("ended", () => {
                    $autoToBuffered.checked = false;
                });
            }
        }

        /**
         * CSS选择器 提取文件名
         * @param {MouseEvent} event 
         */
        handleSetSelector(event) {
            const result = window.prompt("Selector", localStorage.getItem("CatCatchCatch_selector") ?? "");
            if (result == null) return;

            if (result == "") {
                this.clearFileName("selector");
                return;
            }

            let title;
            try {
                title = document.querySelector(result);
            } catch (e) {
                this.clearFileName("selector", this.i18n("fileNameError", "选择器语法错误!"));
                return;
            }

            if (title && title.innerHTML) {
                this.selector.innerHTML = this.stringModify(result);
                localStorage.setItem("CatCatchCatch_selector", result);
                this.getFileName();
            } else {
                this.clearFileName("selector", this.i18n("fileNameError", "表达式错误, 无法获取或内容为空!"));
            }
        }
        /**
         * 正则 提取文件名
         * @param {MouseEvent} event 
         */
        handleSetRegular(event) {
            let result = window.prompt(this.i18n("regular", "文件名获取正则"), localStorage.getItem("CatCatchCatch_regular") ?? "");
            if (result == null) return;

            if (result == "") {
                this.clearFileName("regular");
                return;
            }

            try {
                new RegExp(result);
                this.regular.innerHTML = this.stringModify(result);
                localStorage.setItem("CatCatchCatch_regular", result);
                this.getFileName();
            } catch (e) {
                this.clearFileName("regular", this.i18n("fileNameError", "正则表达式错误"));
                console.log(e);
            }
        }

        /**
         * 核心函数 代理MediaSource方法
         */
        proxyMediaSourceMethods() {
            console.log("CatCatch: proxyMediaSourceMethods called.");
            // 代理 addSourceBuffer 方法
            window.MediaSource.prototype.addSourceBuffer = new Proxy(window.MediaSource.prototype.addSourceBuffer, {
                apply: (target, thisArg, argumentsList) => {
                    const newMimeType = argumentsList[0];
                    console.log(`CatCatch: addSourceBuffer called. MimeType: ${newMimeType}, Current isComplete: ${this.isComplete}, catchMedia length: ${this.catchMedia.length}`);

                    try {
                        // ----- بداية التعديل: تعليق الشرط مؤقتًا -----
                        // if (this.isComplete) {
                        //     console.log("CatCatch: addSourceBuffer - Clearing media because isComplete was true. (CONDITION TEMPORARILY DISABLED)");
                        //     this.catchMedia = [];
                        //     this.mediaSize = 0;
                        //     this.isComplete = false;
                        // }
                        // ----- نهاية التعديل -----

                        const result = Reflect.apply(target, thisArg, argumentsList);
                        console.log("CatCatch: addSourceBuffer - Original function called successfully.");

                        // 标题获取
                        setTimeout(() => { this.getFileName(); }, 2000);
                        this.tips.innerHTML = this.i18n("capturingData", "捕获数据中...");

                        this.catchMedia.push({ mimeType: newMimeType, bufferList: [] });
                        const index = this.catchMedia.length - 1;
                        console.log(`CatCatch: addSourceBuffer - Pushed new media object. Index: ${index}, catchMedia.length: ${this.catchMedia.length}`);

                        // 代理 appendBuffer 方法
                        result.appendBuffer = new Proxy(result.appendBuffer, {
                            apply: (target, thisArg, argumentsList) => {
                                const chunk = argumentsList[0];
                                // console.log(`CatCatch: appendBuffer called. Current enable: ${this.enable}, Chunk size: ${chunk ? chunk.byteLength : 'N/A'}`);
                                Reflect.apply(target, thisArg, argumentsList);

                                if (this.enable && chunk) {
                                    this.mediaSize += chunk.byteLength || 0;
                                    if (this.tips) {
                                        this.tips.innerHTML = this.i18n("capturingData", "捕获数据中...") + ": " + this.byteToSize(this.mediaSize);
                                    }
                                    this.catchMedia[index].bufferList.push(chunk);
                                    // console.log(`CatCatch: appendBuffer - Data pushed to bufferList. Index: ${index}, bufferList length: ${this.catchMedia[index].bufferList.length}, total mediaSize: ${this.mediaSize}`);
                                } else {
                                    // console.log(`CatCatch: appendBuffer - Not enabled or no chunk. Enable: ${this.enable}, Chunk: ${chunk}`);
                                }
                            }
                        });

                        return result;
                    } catch (error) {
                        console.error("CatCatch: addSourceBuffer proxy error:", error);
                        return Reflect.apply(target, thisArg, argumentsList); // Ensure original is still called on error
                    }
                }
            });

            // 代理 endOfStream 方法
            window.MediaSource.prototype.endOfStream = new Proxy(window.MediaSource.prototype.endOfStream, {
                apply: (target, thisArg, argumentsList) => {
                    console.log(`CatCatch: endOfStream called. Current enable: ${this.enable}`);
                    let originalResult;
                    try {
                        originalResult = Reflect.apply(target, thisArg, argumentsList);
                        console.log("CatCatch: endOfStream - Original function called.");

                        if (this.enable) {
                            this.isComplete = true;
                            console.log(`CatCatch: endOfStream - Set isComplete to true. Current tips: ${this.tips ? this.tips.innerHTML : 'N/A'}`);
                            if (this.tips) {
                                this.tips.innerHTML = this.i18n("captureCompleted", "捕获完成");
                            }
                            // MODIFIED PART: Use settings from background.js instead of localStorage
                            if (this.settings && this.settings.watchedOnCaptureComplete) {
                                console.log("CatCatch: endOfStream - watchedOnCaptureComplete is true, scheduling download.");
                                setTimeout(() => this.catchDownload(), 500);
                            }
                        } else {
                            console.log("CatCatch: endOfStream - Not enabled.");
                        }
                    } catch (error) {
                        console.error("CatCatch: endOfStream proxy error:", error);
                        if (originalResult === undefined) {
                           return Reflect.apply(target, thisArg, argumentsList);
                        }
                    }
                    return originalResult;
                }
            });
            console.log("CatCatch: proxyMediaSourceMethods finished setup.");
        }

        /**
         * 自动从头捕获
         * 监控DOM变化，自动重置视频播放位置
         */
        setupAutoRestart() {
            document.addEventListener('DOMContentLoaded', () => {
                document.querySelectorAll('video').forEach((video) => this.resetVideoPlayback(video));

                // 监控 DOM
                const observer = new MutationObserver(mutations => {
                    mutations.forEach(mutation => {
                        mutation.addedNodes.forEach(node => {
                            try {
                                if (node.tagName === 'VIDEO') {
                                    this.resetVideoPlayback(node);
                                } else if (node.querySelectorAll) {
                                    node.querySelectorAll('video').forEach(video => this.resetVideoPlayback(video));
                                }
                            } catch (error) {
                                console.error("处理新添加的视频节点失败:", error);
                            }
                        });
                    });
                });

                observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
            });
        }

        /**
         * 重置视频播放位置
         * @param {Object} video 
         */
        resetVideoPlayback(video) {
            if (!video) return;
            const timer = setInterval(() => {
                if (!video.paused) {
                    video.currentTime = 0;
                    const checkHead = this.catCatch.querySelector("#checkHead");
                    if (checkHead) checkHead.checked = true;
                    this.clearCache();
                    clearInterval(timer);
                }
            }, 500);

            // 5秒后如果还没有检测到播放，就清除定时器
            setTimeout(() => clearInterval(timer), 5000);

            video.addEventListener('play', () => {
                if (!video.isResetCatCatch) {
                    video.isResetCatCatch = true;
                    video.currentTime = 0;
                    const checkHead = this.catCatch.querySelector("#checkHead");
                    if (checkHead) checkHead.checked = true;
                    this.clearCache();
                }
            }, { once: true });
        }

        /**
         * 下载捕获的数据
         */
        catchDownload() {
            if (this.catchMedia.length == 0) {
                alert(this.i18n("noData", "没抓到有效数据"));
                return;
            }

            let downloadWithFFmpeg = this.catchMedia.length >= 2 && localStorage.getItem("CatCatchCatch_ffmpeg") == "checked";

            /**
             * 检查文件
             * 检查是否有头部文件 没有头部文件则提示 不使用ffmpeg合并
             * 检查是否有多个头部文件 根据用户选项 是否清理多于头部数据
             */
            const checkHead = this.catCatch.querySelector("#checkHead");
            // 仅确认一次是否清除多余头部数据
            let userConfirmedHeadChoice = false;

            for (let key in this.catchMedia) {
                if (!this.catchMedia[key]?.bufferList || this.catchMedia[key].bufferList.length <= 1) continue;
                let lastHeaderIndex = -1;

                // 遍历所有 buffer 寻找最后一个头部
                for (let i = 0; i < this.catchMedia[key].bufferList.length; i++) {
                    const data = new Uint8Array(this.catchMedia[key].bufferList[i]);

                    // 检查MP4格式的头部 (ftyp)
                    if (data.length > 8 &&
                        data[4] === 0x66 && // 'f'
                        data[5] === 0x74 && // 't'
                        data[6] === 0x79 && // 'y'
                        data[7] === 0x70)   // 'p'
                    {
                        lastHeaderIndex = i; // 持续更新直到找到最后一个头部
                    }
                    // 检查WebM格式的头部 (1A 45 DF A3)
                    else if (data.length > 4 &&
                        data[0] === 0x1A &&
                        data[1] === 0x45 &&
                        data[2] === 0xDF &&
                        data[3] === 0xA3) {
                        lastHeaderIndex = i; // 持续更新直到找到最后一个WebM头部
                    }
                }
                if (lastHeaderIndex == -1) {
                    alert(this.i18n("noHead", "没有检测到视频头部数据, 请使用本地工具处理"));
                    downloadWithFFmpeg = false; // 没有头部数据则不使用ffmpeg合并
                }
                if (lastHeaderIndex > 0) {
                    // 只有第一次遇到多余头部且用户尚未选择时才提示
                    if (!userConfirmedHeadChoice && !checkHead.checked) {
                        checkHead.checked = window.confirm(this.i18n("headData", "检测到多余头部数据, 是否清除?"));
                        userConfirmedHeadChoice = true; // 标记已经询问过用户
                    }

                    if (checkHead.checked) {
                        this.catchMedia[key].bufferList.splice(0, lastHeaderIndex); // 移除最后一个头部之前的所有元素
                    }
                }
            }

            // ----- بداية التعديل لتحديد طريقة التنزيل بناءً على أزرار الراديو -----
            const noMergeSelected = localStorage.getItem("CatCatchCatch_noMerge") === "checked";
            const localMergeSelected = localStorage.getItem("CatCatchCatch_localMerge") === "checked";
            const ffmpegMergeSelected = localStorage.getItem("CatCatchCatch_ffmpegMerge") === "checked";

            if (noMergeSelected) {
                console.log("CatCatch: Performing direct download (no merge selected).");
                this.downloadDirect();
            } else if (localMergeSelected && this.catchMedia.length >= 2) {
                console.log("CatCatch: Attempting local merge with MP4Box.");
                this.downloadWithLocalMP4Box();
            } else if (ffmpegMergeSelected && this.catchMedia.length >= 2) {
                console.log("CatCatch: Attempting merge with FFmpeg.");
                this.downloadWithFFmpeg();
            } else {
                // كخيار افتراضي إذا لم يتم تحديد أي شيء (لا ينبغي أن يحدث مع أزرار الراديو)
                // أو إذا لم يكن هناك ما يكفي من الوسائط للدمج
                console.log("CatCatch: Performing direct download (default or not enough media for merge).");
                this.downloadDirect();
            }
            // ----- نهاية التعديل -----
            console.log(`CatCatch: catchDownload - Merge options: noMerge=${noMergeSelected}, localMerge=${localMergeSelected}, ffmpegMerge=${ffmpegMergeSelected}`);
            console.log(`CatCatch: catchDownload - Current catchMedia length: ${this.catchMedia.length}`);

            if (this.isComplete) {
                // مسح ذاكرة التخزين المؤقت يتم الآن التعامل معه بشكل أكثر تحديدًا بعد نجاح العملية
                if (localStorage.getItem("CatCatchCatch_completeClearCache") == "checked") {
                    console.log("CatCatch: catchDownload - Clearing cache because isComplete and completeClearCache are true.");
                    this.clearCache();
                }
                if (this.tips) {
                    this.tips.innerHTML = this.i18n("downloadCompleted", "下载完毕...");
                }
            }
        }

        /**
         * 使用FFmpeg合并下载捕获的数据
         */
        downloadWithFFmpeg() {
            const media = [];
            for (let item of this.catchMedia) {
                if (!item || !item.bufferList || item.bufferList.length === 0) continue;

                const mime = (item.mimeType && item.mimeType.split(';')[0]) || 'video/mp4';
                const fileBlob = new Blob(item.bufferList, { type: mime });
                const type = mime.split('/')[0] || 'video';

                media.push({
                    data: (typeof chrome == "object") ? URL.createObjectURL(fileBlob) : fileBlob,
                    type: type
                });
            }

            if (media.length === 0) {
                alert(this.i18n("noData", "没有有效数据可下载"));
                return;
            }

            const title = this.fileName ? this.fileName.innerHTML.trim() : document.title;

            window.postMessage({
                action: "catCatchFFmpeg",
                use: "catchMerge",
                files: media,
                title: title,
                output: title,
                quantity: media.length
            });
        }
        /**
         * 直接下载捕获的数据
         */
        downloadDirect() {
            const a = document.createElement('a');
            let downloadCount = 0;

            for (let item of this.catchMedia) {
                if (!item || !item.bufferList || item.bufferList.length === 0) continue;

                const mime = (item.mimeType && item.mimeType.split(';')[0]) || 'video/mp4';
                const type = mime.split('/')[0] == "video" ? "mp4" : "mp3";
                const fileBlob = new Blob(item.bufferList, { type: mime });

                a.href = URL.createObjectURL(fileBlob);
                a.download = `${this.fileName ? this.fileName.innerHTML.trim() : document.title}.${type}`;
                a.click();

                // 释放URL对象以避免内存泄漏
                setTimeout(() => URL.revokeObjectURL(a.href), 100);
                downloadCount++;
            }

            a.remove();

            if (downloadCount === 0) {
                alert(this.i18n("noData", "没有有效数据可下载"));
            }
        }

        downloadWithLocalMP4Box() {
            if (this.catchMedia.length < 2) {
                alert(this.i18n("notEnoughDataForMerge", "لا توجد بيانات كافية (فيديو وصوت) للدمج المحلي."));
                return;
            }

            const filesForMerge = [];
            let videoStreamFound = false;
            let audioStreamFound = false;
            let tempTrackCounter = 0; // لتتبع المسارات بشكل أفضل

            for (let item of this.catchMedia) {
                if (!item || !item.bufferList || item.bufferList.length === 0) continue;

                const mime = (item.mimeType && item.mimeType.split(';')[0]) || 'application/octet-stream';
                const fileBlob = new Blob(item.bufferList, { type: mime });
                const dataUrl = URL.createObjectURL(fileBlob); //  مهم: إنشاء Blob URL
                let streamType = 'unknown';

                // تحديد نوع الدفق بشكل أدق
                if (mime.startsWith('video/')) {
                    streamType = 'video';
                    videoStreamFound = true;
                } else if (mime.startsWith('audio/')) {
                    streamType = 'audio';
                    audioStreamFound = true;
                } else {
                    // محاولة تخمين إذا كان لدينا بالفعل النوع الآخر ولم يتم العثور على هذا النوع بعد
                    if (tempTrackCounter === 0 && !videoStreamFound) { // أول مسار يمكن أن يكون فيديو
                        streamType = 'video';
                        videoStreamFound = true;
                         console.warn(`CatCatch: Mime type for local merge was ${mime}. Guessed as video (first track).`);
                    } else if (tempTrackCounter === 1 && videoStreamFound && !audioStreamFound) { // ثاني مسار يمكن أن يكون صوت
                        streamType = 'audio';
                        audioStreamFound = true;
                        console.warn(`CatCatch: Mime type for local merge was ${mime}. Guessed as audio (second track, video already found).`);
                    } else {
                        console.warn(`CatCatch: Unknown mime type for local merge: ${mime}. Could not reliably guess type.`);
                    }
                }

                filesForMerge.push({
                    dataUrl: dataUrl,
                    mimeType: mime,
                    type: streamType, // تحديد نوع الدفق بشكل صريح
                    // إضافة حجم الملف الأصلي لمساعدة background.js في حال احتاج إليه
                    originalSize: item.bufferList.reduce((acc, val) => acc + val.byteLength, 0)
                });
                tempTrackCounter++;
            }

            if (!videoStreamFound || !audioStreamFound) {
                 alert(this.i18n("videoAndAudioNeededForMerge", "مطلوب دفق فيديو ودفق صوتي واحد على الأقل للدمج المحلي."));
                 filesForMerge.forEach(f => URL.revokeObjectURL(f.dataUrl)); // تنظيف
                 return;
            }

            if (filesForMerge.length < 2) {
                alert(this.i18n("notEnoughValidStreams", "لا توجد تدفقات صالحة كافية للدمج."));
                filesForMerge.forEach(f => URL.revokeObjectURL(f.dataUrl)); // تنظيف
                return;
            }

            const title = this.fileName ? this.fileName.innerHTML.trim() : document.title;
            console.log("CatCatch: Sending merge request to background for local MP4Box:", JSON.stringify(filesForMerge.map(f => ({type: f.type, mime: f.mimeType, size: f.originalSize}))));

            // استخدام postMessage لإرسال الرسالة إلى content-script الذي سيرسلها إلى background.js
            window.postMessage({
                action: "catCatchToBackgroundRelay", //  إشارة إلى content-script
                payload: { // الحمولة الفعلية التي سيتم تمريرها إلى background.js
                    Message: "mergeCapturedAVRequest",
                    files: filesForMerge.map(f => ({ dataUrl: f.dataUrl, mimeType: f.mimeType, type: f.type })), // أرسل فقط ما يحتاجه background
                    filenameHint: title,
                    tabId: this.tabId
                }
            }, "*");

            //  لا تقم بمسح this.catchMedia هنا، انتظر ردًا أو تأكيدًا
            //  سيتم التعامل مع مسح البيانات عند اكتمال التنزيل بنجاح في background.js أو عبر رسالة تأكيد
            if (this.isComplete) {
               if (localStorage.getItem("CatCatchCatch_completeClearCache") == "checked") {
                   //  لا تقم بالمسح هنا، background سيطلب ذلك أو ستقوم به عند استلام تأكيد
                   // this.clearCache();
               }
               if (this.tips) {
                   this.tips.innerHTML = this.i18n("mergeRequestSent", "تم إرسال طلب الدمج المحلي...");
               }
            }
        }

        clearFileName(obj = "selector", warning = "") {
            localStorage.removeItem("CatCatchCatch_" + obj);
            const element = obj == "selector" ? this.selector : this.regular;
            if (element) element.innerHTML = this.i18n("notSet", "未设置");
            this.getFileName();
            if (warning) alert(warning);
        }

        /**
         * 清理缓存
         */
        clearCache() {
            this.mediaSize = 0;
            this.catchMedia = []; // المسح الكامل دائمًا عند استدعاء clearCache
            this.isComplete = false;
            // لا حاجة للاحتفاظ بالجزء الأول من البافر هنا، لأن هذا يتعارض مع هدفنا.
            // الكود القديم:
            // if (this.isComplete) {
            //     this.catchMedia = [];
            //     this.isComplete = false;
            //     return;
            // }
            // for (let key in this.catchMedia) {
            //     const media = this.catchMedia[key];
            //     if (media && media.bufferList && media.bufferList.length > 0) {
            //         const firstBuffer = media.bufferList[0];
            //         media.bufferList = [firstBuffer];
            //         this.mediaSize += firstBuffer ? (firstBuffer.byteLength || 0) : 0;
            //     }
            // }
            if (this.tips) { // تحديث الواجهة لتعكس المسح
                this.tips.innerHTML = this.i18n("waiting", "等待视频播放");
            }
            console.log(`CatCatch: clearCache - Cache cleared. isComplete=${this.isComplete}, catchMedia.length=${this.catchMedia.length}, mediaSize=${this.mediaSize}`);
        }

        byteToSize(byte) {
            if (!byte || byte < 1024) return "0KB";
            if (byte < 1024 * 1024) {
                return (byte / 1024).toFixed(1) + "KB";
            } else if (byte < 1024 * 1024 * 1024) {
                return (byte / 1024 / 1024).toFixed(1) + "MB";
            } else {
                return (byte / 1024 / 1024 / 1024).toFixed(1) + "GB";
            }
        }

        /**
         * 获取文件名
         */
        getFileName() {
            try {
                if (!this.fileName) return;

                if (this.setFileName) {
                    this.fileName.innerHTML = this.stringModify(this.setFileName);
                    return;
                }

                let name = "";
                const selectorKey = localStorage.getItem("CatCatchCatch_selector");
                if (selectorKey) {
                    const title = document.querySelector(selectorKey);
                    if (title && title.innerHTML) {
                        name = title.innerHTML;
                    }
                }

                const regularKey = localStorage.getItem("CatCatchCatch_regular");
                if (regularKey) {
                    const str = name == "" ? document.documentElement.outerHTML : name;
                    const reg = new RegExp(regularKey, "g");
                    let result = str.match(reg);
                    if (result) {
                        result = result.filter((item) => item !== "");
                        name = result.join("_");
                    }
                }

                this.fileName.innerHTML = name ? this.stringModify(name) : this.stringModify(document.title);
            } catch (error) {
                console.error("获取文件名失败:", error);
                if (this.fileName) this.fileName.innerHTML = this.stringModify(document.title);
            }
        }

        stringModify(str) {
            if (!str) return "untitled";

            return str.replace(/['\\:\*\?"<\/>\|~]/g, function (m) {
                return {
                    "'": '&#39;',
                    '\\': '&#92;',
                    '/': '&#47;',
                    ':': '&#58;',
                    '*': '&#42;',
                    '?': '&#63;',
                    '"': '&quot;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '|': '&#124;',
                    '~': '_'
                }[m];
            });
        }
    }

    // 创建并启动CatCatcher实例
    const catCatcher = new CatCatcher();
})();