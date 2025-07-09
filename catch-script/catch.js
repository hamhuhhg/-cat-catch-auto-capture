(function () {
    class CatCatcher {
        constructor() {
            this.settings = { watchedOnCaptureComplete: true, watchedOnTabClose: false, watchedOnNextVideo: false }; // Defaults, will be updated
            this.tabId = null;
            this.boundMessageHandler = this.handleBackgroundMessage.bind(this);
            this.captureDownloadMode = "ffmpeg"; // القيمة الافتراضية الأولية

            console.log("catch.js Start");

            // 初始化属性
            this.enable = true;  // 捕获开关
            this.language = navigator.language;   // 语言设置
            this.isComplete = false; // 捕获完成标志
            this.catchMedia = [];   // 捕获的媒体数据
            this.mediaSize = 0; // 捕获的媒体数据大小
            this.setFileName = null;    // 文件名
            this.currentCaptureSessionId = null; // إضافة معرف الجلسة

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
                        if (settings.captureDownloadMode) {
                            this.captureDownloadMode = settings.captureDownloadMode;
                            const radioButtons = this.catCatch.querySelectorAll('input[name="catCatchCaptureModeWidget"]');
                            radioButtons.forEach(radio => {
                                radio.checked = (radio.value === this.captureDownloadMode);
                            });
                        }
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
                <button id="download" ${buttonStyle} data-i18n="downloadCapturedData">تنزيل البيانات الملتقطة</button>
                <button id="clean" ${buttonStyle} data-i18n="deleteCapturedData">حذف البيانات الملتقطة</button>
                <div><button id="hide" ${buttonStyle} data-i18n="hide">إخفاء</button><button id="close" ${buttonStyle} data-i18n="close">إغلاق</button></div>

                <div style="margin-top: 5px; margin-bottom: 5px; border-top: 1px solid #ccc; padding-top: 5px;">
                  <div data-i18n="captureModeTitle" style="font-weight: bold; margin-bottom: 3px;">وضع التنزيل:</div>
                  <label style="display:block; margin-bottom:2px;"><input type="radio" name="catCatchCaptureModeWidget" value="ffmpeg" ${checkboxStyle}> <span data-i18n="captureModeFfmpegShort">FFMPEG</span></label>
                  <label style="display:block; margin-bottom:2px;"><input type="radio" name="catCatchCaptureModeWidget" value="mp4box" ${checkboxStyle}> <span data-i18n="captureModeMp4boxShort">MP4Box</span></label>
                  <label style="display:block;"><input type="radio" name="catCatchCaptureModeWidget" value="separate" ${checkboxStyle}> <span data-i18n="captureModeSeparateShort">منفصل</span></label>
                </div>

                <label><input type="checkbox" id="autoDown" ${localStorage.getItem("CatCatchCatch_autoDown") || ""} ${checkboxStyle}><span data-i18n="automaticDownload">تنزيل تلقائي عند الاكتمال</span></label>
                {/* <label><input type="checkbox" id="ffmpeg" ${localStorage.getItem("CatCatchCatch_ffmpeg") || ""} ${checkboxStyle}><span data-i18n="ffmpeg">استخدام ffmpeg للدمج</span></label> */} {/* تم استبداله بأزرار الراديو */}
                <label><input type="checkbox" id="autoToBuffered" ${checkboxStyle}><span data-i18n="autoToBuffered">قفز للمخزن المؤقت</span></label>
                <label><input type="checkbox" id="checkHead" ${checkboxStyle}><span data-i18n="cleanRedundantHeaders">تنظيف الرؤوس الإضافية</span></label>
                <label><input type="checkbox" id="completeClearCache" ${localStorage.getItem("CatCatchCatch_completeClearCache") || ""} ${checkboxStyle}><span data-i18n="clearCacheAfterDownload">مسح بعد اكتمال التنزيل</span></label>
                <details>
                    <summary data-i18n="fileName" id="summary">إعدادات اسم الملف</summary>
                    <div style="font-weight:bold;"><span data-i18n="fileName">اسم الملف</span>: </div><div id="fileName"></div>
                    <div style="font-weight:bold;"><span data-i18n="selector">التعبير</span>: </div><div id="selector">Null</div>
                    <div style="font-weight:bold;"><span data-i18n="regular">التعبير النمطي</span>: </div><div id="regular">Null</div>
                    <button id="setSelector" ${buttonStyle} data-i18n="usingSelector">استخلاص بالتعبير</button>
                    <button id="setRegular" ${buttonStyle} data-i18n="usingRegular">استخلاص بالنمط</button>
                    <button id="setFileName" ${buttonStyle} data-i18n="customize">تخصيص يدوي</button>
                </details>
                <details>
                <summary data-i18n="testSection">اختبار</summary>
                    <button id="test" ${buttonStyle}>اختبار</button>
                    <button id="restart" ${buttonStyle} data-i18n="capturedBeginning">التقاط من البداية</button>
                    <label><input type="checkbox" id="restartAlways" ${localStorage.getItem("CatCatchCatch_restart") || ""} ${checkboxStyle}><span data-i18n="alwaysCapturedBeginning">التقاط دائم من البداية</span> (تجريبي)</label>
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
            this.tips.innerHTML = this.i18n("waiting", "انتظار تشغيل الفيديو");
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

            // معالجة تغيير وضع الالتقاط والتنزيل في الواجهة المصغرة
            const captureModeRadiosWidget = this.catCatch.querySelectorAll('input[name="catCatchCaptureModeWidget"]');
            captureModeRadiosWidget.forEach(radio => {
                radio.addEventListener('change', (event) => {
                    if (event.target.checked) {
                        this.captureDownloadMode = event.target.value;
                        // إرسال التغيير إلى background.js لتحديث الإعدادات العامة
                        window.postMessage({
                            action: "catCatchToBackground", // لـ content-script
                            Message: "setCaptureDownloadMode", // لـ background.js
                            mode: this.captureDownloadMode
                        }, "*");
                        console.log("CatCatch Widget: Capture mode changed to", this.captureDownloadMode);
                    }
                });
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

        handleFfmpegChange(event) {
            // localStorage.setItem("CatCatchCatch_ffmpeg", event.target.checked ? "checked" : ""); // تم استبداله
        }

        handleRestartAlwaysChange(event) {
            localStorage.setItem("CatCatchCatch_restart", event.target.checked ? "checked" : "");
        }

        /**
         * 处理清理缓存事件
         * @param {MouseEvent} event 
         */
        handleClean(event) {
            if (window.confirm(this.i18n("clearCacheConfirmation", "تأكيد مسح ذاكرة التخزين المؤقت؟"))) { // ترجمة
                this.clearCache(true); // مسح كامل عند الضغط على الزر
                const $clean = this.catCatch.querySelector("#clean");
                if (!$clean) return;

                $clean.innerHTML = this.i18n("cleanupCompleted", "اكتمل التنظيف!");
                setTimeout(() => {
                    if ($clean) $clean.innerHTML = this.i18n("deleteCapturedData", "حذف البيانات الملتقطة"); // النص الأصلي للزر
                }, 1000);
            }
        }

        /**
         * 处理下载事件
         * @param {MouseEvent} event 
         */
        handleDownload(event) {
            try {
                if (this.isComplete || window.confirm(this.i18n("downloadConfirmation", "التنزيل المسبق قد يتسبب في فوضى البيانات. تأكيد؟"))) { // ترجمة
                    this.catchDownload();
                }
            } catch (error) {
                console.error("下载处理失败:", error);
                alert(this.i18n("downloadError", "حدث خطأ أثناء التنزيل، يرجى مراجعة وحدة التحكم")); // ترجمة
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
            if (this.isComplete || window.confirm(this.i18n("closeConfirmation", "تأكيد الإغلاق؟"))) { // ترجمة
                this.clearCache(true); // مسح كامل عند الإغلاق
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

            this.clearCache(true); // مسح كامل عند إعادة التشغيل
            document.querySelectorAll("video").forEach((element) => {
                element.currentTime = 0;
                element.play();
            });
        }

        handleSetFileName(event) {
            this.setFileName = window.prompt(this.i18n("fileNamePrompt", "أدخل اسم الملف (بدون امتداد):"), this.setFileName ?? ""); // ترجمة
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
            const result = window.prompt(this.i18n("selectorPrompt", "محدد CSS لاسم الملف:"), localStorage.getItem("CatCatchCatch_selector") ?? ""); // ترجمة
            if (result == null) return;

            if (result == "") {
                this.clearFileName("selector");
                return;
            }

            let title;
            try {
                title = document.querySelector(result);
            } catch (e) {
                this.clearFileName("selector", this.i18n("fileNameErrorSelector", "خطأ في صيغة المحدد!")); // ترجمة
                return;
            }

            if (title && title.innerHTML) {
                this.selector.innerHTML = this.stringModify(result);
                localStorage.setItem("CatCatchCatch_selector", result);
                this.getFileName();
            } else {
                this.clearFileName("selector", this.i18n("fileNameErrorContent", "خطأ في التعبير، لا يمكن الحصول على المحتوى أو أنه فارغ!")); // ترجمة
            }
        }
        /**
         * 正则 提取文件名
         * @param {MouseEvent} event 
         */
        handleSetRegular(event) {
            let result = window.prompt(this.i18n("regularPrompt", "تعبير نمطي لاسم الملف:"), localStorage.getItem("CatCatchCatch_regular") ?? ""); // ترجمة
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
                this.clearFileName("regular", this.i18n("fileNameErrorRegex", "خطأ في صيغة التعبير النمطي!")); // ترجمة
                console.log(e);
            }
        }

        /**
         * 核心函数 代理MediaSource方法
         */
        proxyMediaSourceMethods() {
            // 代理 addSourceBuffer 方法
            window.MediaSource.prototype.addSourceBuffer = new Proxy(window.MediaSource.prototype.addSourceBuffer, {
                apply: (target, thisArg, argumentsList) => {
                    try {
                        const result = Reflect.apply(target, thisArg, argumentsList);

                        // 标题获取
                        setTimeout(() => { this.getFileName(); }, 2000);
                        this.tips.innerHTML = this.i18n("capturingData", "يتم التقاط البيانات..."); // ترجمة

                        // إدارة معرف الجلسة
                        if (this.catchMedia.length === 0 || this.isComplete) {
                            if (this.isComplete) {
                                this.clearCache(true);
                            }
                            this.isComplete = false;
                            this.currentCaptureSessionId = Date.now().toString();
                            console.log("CatCatch: New capture session started with ID:", this.currentCaptureSessionId);
                        }

                        this.catchMedia.push({
                            mimeType: argumentsList[0],
                            bufferList: [],
                            sessionId: this.currentCaptureSessionId
                        });
                        const index = this.catchMedia.length - 1;

                        // 代理 appendBuffer 方法
                        result.appendBuffer = new Proxy(result.appendBuffer, {
                            apply: (target, thisArg, argumentsList) => {
                                Reflect.apply(target, thisArg, argumentsList);

                                if (this.enable && argumentsList[0]) {
                                    this.mediaSize += argumentsList[0].byteLength || 0;
                                    if (this.tips) {
                                        this.tips.innerHTML = this.i18n("capturingData", "يتم التقاط البيانات...") + ": " + this.byteToSize(this.mediaSize); // ترجمة
                                    }
                                    this.catchMedia[index].bufferList.push(argumentsList[0]);
                                }
                            }
                        });

                        return result;
                    } catch (error) {
                        console.error("addSourceBuffer 代理错误:", error);
                        return Reflect.apply(target, thisArg, argumentsList);
                    }
                }
            });

            // 代理 endOfStream 方法
            window.MediaSource.prototype.endOfStream = new Proxy(window.MediaSource.prototype.endOfStream, {
                apply: (target, thisArg, argumentsList) => {
                    try {
                        Reflect.apply(target, thisArg, argumentsList);

                        if (this.enable) {
                            this.isComplete = true;
                            if (this.tips) {
                                this.tips.innerHTML = this.i18n("captureCompleted", "اكتمل الالتقاط"); // ترجمة
                            }
                            if (this.settings && this.settings.watchedOnCaptureComplete) {
                                setTimeout(() => this.catchDownload(), 500);
                            }
                        }
                    } catch (error) {
                        console.error("CatCatch: endOfStream proxy error:", error);
                        return Reflect.apply(target, thisArg, argumentsList);
                    }
                }
            });
        }

        /**
         * 自动从头捕获
         * 监控DOM变化，自动重置视频播放位置
         */
        setupAutoRestart() {
            document.addEventListener('DOMContentLoaded', () => {
                document.querySelectorAll('video').forEach((video) => this.resetVideoPlayback(video));

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
                    this.clearCache(true); // مسح كامل عند إعادة التشغيل
                    clearInterval(timer);
                }
            }, 500);

            setTimeout(() => clearInterval(timer), 5000);

            video.addEventListener('play', () => {
                if (!video.isResetCatCatch) {
                    video.isResetCatCatch = true;
                    video.currentTime = 0;
                    const checkHead = this.catCatch.querySelector("#checkHead");
                    if (checkHead) checkHead.checked = true;
                    this.clearCache(true); // مسح كامل عند إعادة التشغيل
                }
            }, { once: true });
        }

        /**
         * 下载捕获的数据
         */
        catchDownload() {
            const activeMedia = this.catchMedia.filter(item => item.sessionId === this.currentCaptureSessionId);

            if (activeMedia.length === 0) {
                alert(this.i18n("noData", "لا توجد بيانات ملتقطة للجلسة الحالية. يرجى التأكد من أن الفيديو يعمل وأنه يتم التقاطه."));
                if (this.catchMedia.length > 0 && !this.currentCaptureSessionId) {
                    console.warn("CatCatch: No active session ID, but catchMedia is not empty. This might be old data.");
                    alert(this.i18n("noActiveSession", "لا توجد جلسة التقاط نشطة. قد تكون هذه بيانات قديمة."));
                }
                return;
            }

            let performMerge = this.captureDownloadMode === "ffmpeg" || this.captureDownloadMode === "mp4box";

            if (performMerge && activeMedia.length > 0) {
                const checkHead = this.catCatch.querySelector("#checkHead");
                let userConfirmedHeadChoice = false;
                let hasValidStreamsForMerging = true;

                for (let key in activeMedia) {
                    const currentStream = activeMedia[key];
                    if (!currentStream?.bufferList || currentStream.bufferList.length === 0) {
                        if (currentStream.mimeType?.startsWith("video/") || currentStream.mimeType?.startsWith("audio/")) {
                            console.warn(`CatCatch: Stream ${currentStream.mimeType} for session ${this.currentCaptureSessionId} has no buffers.`);
                        }
                        continue;
                    }

                    let lastHeaderIndex = -1;
                    for (let i = 0; i < currentStream.bufferList.length; i++) {
                        const data = new Uint8Array(currentStream.bufferList[i]);
                        if (data.length > 8 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) { // ftyp
                            lastHeaderIndex = i;
                        } else if (data.length > 4 && data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) { // webm
                            lastHeaderIndex = i;
                        }
                    }
                    if (lastHeaderIndex === -1 && (currentStream.mimeType?.startsWith("video/") || currentStream.mimeType?.startsWith("audio/"))) {
                        alert(this.i18n("noHeadForMerge", "لم يتم الكشف عن بيانات رأس صالحة للدمج لمسار واحد على الأقل. جرب التنزيل بشكل منفصل."));
                        hasValidStreamsForMerging = false;
                        performMerge = false;
                        break;
                    }
                    if (lastHeaderIndex > 0) {
                        if (!userConfirmedHeadChoice && !checkHead.checked) {
                            checkHead.checked = window.confirm(this.i18n("headDataConfirmation", "تم الكشف عن بيانات رأس إضافية، هل ترغب في تنظيفها؟"));
                            userConfirmedHeadChoice = true;
                        }
                        if (checkHead.checked) {
                            currentStream.bufferList.splice(0, lastHeaderIndex);
                        }
                    }
                }
                if (!hasValidStreamsForMerging && (this.captureDownloadMode === "ffmpeg" || this.captureDownloadMode === "mp4box")) {
                    console.warn("CatCatch: Missing headers in some streams, forcing separate download for this attempt.");
                    this.downloadDirect(activeMedia);
                    if (this.isComplete || localStorage.getItem("CatCatchCatch_completeClearCache") === "checked") {
                        this.clearCache(true);
                    }
                    if (this.tips) this.tips.innerHTML = this.i18n("downloadCompleted", "اكتمل التنزيل");
                    return;
                }
            }

            let finalDownloadActionIsDirect = false;
            let mp4boxAttemptedAndFailed = false; // لتتبع فشل MP4Box وتجنب المسح المزدوج

            switch (this.captureDownloadMode) {
                case "ffmpeg":
                    if (activeMedia.length >= 2 && performMerge) {
                        this.downloadWithFFmpeg(activeMedia);
                    } else {
                        console.log("CatCatch: FFMPEG merge selected, but conditions not met. Downloading directly.");
                        this.downloadDirect(activeMedia);
                        finalDownloadActionIsDirect = true;
                    }
                    break;
                case "mp4box":
                    if (activeMedia.length >= 2 && performMerge) {
                        let videoStream = null;
                        let audioStream = null;
                        const videoMimeTypes = ['video/mp4', 'video/webm', 'video/ogg'];
                        const audioMimeTypes = ['audio/mp4', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/aac'];

                        for (const stream of activeMedia) {
                            if (!videoStream && stream.mimeType && videoMimeTypes.some(type => stream.mimeType.startsWith(type))) {
                                videoStream = stream;
                            } else if (!audioStream && stream.mimeType && audioMimeTypes.some(type => stream.mimeType.startsWith(type))) {
                                audioStream = stream;
                            }
                        }
                        if (!videoStream || !audioStream) {
                             if (activeMedia[0].mimeType && activeMedia[0].mimeType.startsWith('video/')) videoStream = activeMedia[0];
                             else if (activeMedia[0].mimeType && activeMedia[0].mimeType.startsWith('audio/')) audioStream = activeMedia[0];
                             if (activeMedia.length > 1 && activeMedia[1].mimeType && activeMedia[1].mimeType.startsWith('video/') && !videoStream) videoStream = activeMedia[1];
                             else if (activeMedia.length > 1 && activeMedia[1].mimeType && activeMedia[1].mimeType.startsWith('audio/') && !audioStream) audioStream = activeMedia[1];
                        }

                        if (videoStream && audioStream && videoStream.bufferList.length > 0 && audioStream.bufferList.length > 0) {
                            const filesToMerge = [
                                { dataUrl: URL.createObjectURL(new Blob(videoStream.bufferList, { type: videoStream.mimeType })), mimeType: videoStream.mimeType },
                                { dataUrl: URL.createObjectURL(new Blob(audioStream.bufferList, { type: audioStream.mimeType })), mimeType: audioStream.mimeType }
                            ];
                            const title = this.fileName ? this.fileName.innerHTML.trim() : document.title;
                            window.postMessage({
                                action: "catCatchToBackground", Message: "mergeCapturedAVRequest",
                                files: filesToMerge, filenameHint: title, tabId: this.tabId
                            }, "*");
                            console.log("CatCatch: MP4Box merge request sent for session:", this.currentCaptureSessionId);
                            // لا تقم بالمسح هنا، انتظر الرد من background.js أو قم بالمسح عند الخطأ إذا لزم الأمر
                            // this.clearCache(true); // تم نقل المسح إلى معالج الاستجابة أو الخطأ
                        } else {
                            console.log("CatCatch: MP4Box merge selected, but conditions not fully met. Downloading directly.");
                            this.downloadDirect(activeMedia);
                            finalDownloadActionIsDirect = true;
                            mp4boxAttemptedAndFailed = true;
                        }
                    } else {
                         console.log("CatCatch: MP4Box merge selected, but conditions not met. Downloading directly.");
                        this.downloadDirect(activeMedia);
                        finalDownloadActionIsDirect = true;
                    }
                    break;
                case "separate":
                default:
                    this.downloadDirect(activeMedia);
                    finalDownloadActionIsDirect = true;
                    break;
            }

            if (this.isComplete || localStorage.getItem("CatCatchCatch_completeClearCache") === "checked") {
                if (finalDownloadActionIsDirect) {
                     this.clearCache(true);
                }
                // إذا كان الدمج (FFMPEG أو MP4Box الناجح)، فسيتم المسح داخل تلك الدوال أو بعد إرسال الطلب.
            }
            if (this.tips) {
                this.tips.innerHTML = this.i18n("downloadOrMergeCompleted", "اكتمل التنزيل/الدمج");
            }
        }

        /**
         * 使用FFmpeg合并下载捕获的数据
         * @param {Array} mediaToProcess - الوسائط التي سيتم دمجها (عادةً activeMedia)
         */
        downloadWithFFmpeg(mediaToProcess) {
            const media = [];
            for (let item of mediaToProcess) {
                if (!item || !item.bufferList || item.bufferList.length === 0) continue;

                const mime = (item.mimeType && item.mimeType.split(';')[0]) || 'video/mp4';
                const fileBlob = new Blob(item.bufferList, { type: mime });
                const type = mime.split('/')[0] || 'video';

                media.push({
                    data: (typeof chrome == "object") ? URL.createObjectURL(fileBlob) : fileBlob,
                    type: type,
                    originalMimeType: item.mimeType
                });
            }

            if (media.length < 2) {
                alert(this.i18n("notEnoughDataForMerge", "لا توجد بيانات كافية للدمج. سيتم التنزيل بشكل منفصل إذا أمكن."));
                this.downloadDirect(mediaToProcess);
                return;
            }

            const title = this.fileName ? this.fileName.innerHTML.trim() : document.title;

            window.postMessage({
                action: "catCatchFFmpeg",
                use: "catchMerge",
                files: media,
                title: title,
                output: title,
                quantity: media.length,
                sessionId: this.currentCaptureSessionId
            });
            console.log("CatCatch: Data sent to FFmpeg for session:", this.currentCaptureSessionId);
            this.clearCache(true);
        }
        /**
         * 直接下载捕获的数据
         * @param {Array} mediaToDownload - الوسائط التي سيتم تنزيلها
         */
        downloadDirect(mediaToDownload) {
            if (!mediaToDownload || mediaToDownload.length === 0) {
                alert(this.i18n("noDataToDownload", "لا توجد بيانات لتنزيلها."));
                return;
            }
            const a = document.createElement('a');
            let downloadCount = 0;

            for (let item of mediaToDownload) {
                if (!item || !item.bufferList || item.bufferList.length === 0) continue;
                const mime = (item.mimeType && item.mimeType.split(';')[0]) || 'application/octet-stream';
                let ext = 'bin';
                if (mime.includes('mp4')) ext = 'mp4';
                else if (mime.includes('webm')) ext = 'webm';
                else if (mime.includes('ogg')) ext = 'ogg';
                else if (mime.includes('mpeg') && mime.startsWith('audio/')) ext = 'mp3';
                else if (mime.includes('aac')) ext = 'aac';
                else if (mime.startsWith('video/')) ext = 'mp4';
                else if (mime.startsWith('audio/')) ext = 'mp3';


                const fileBlob = new Blob(item.bufferList, { type: mime });
                a.href = URL.createObjectURL(fileBlob);
                let fileNameSuffix = "";
                if (mediaToDownload.length > 1) {
                    if (item.mimeType && item.mimeType.startsWith('video/')) {
                        fileNameSuffix = "_video";
                    } else if (item.mimeType && item.mimeType.startsWith('audio/')) {
                        fileNameSuffix = "_audio";
                    } else {
                        fileNameSuffix = `_part${downloadCount + 1}`;
                    }
                }
                a.download = `${this.fileName ? this.fileName.innerHTML.trim() : document.title}${fileNameSuffix}.${ext}`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 100);
                downloadCount++;
            }
            a.remove();
            if (downloadCount === 0) {
                alert(this.i18n("noValidDataForDirectDownload", "لم يتم العثور على بيانات صالحة للتنزيل المباشر."));
            }
        }

        clearFileName(obj = "selector", warning = "") {
            localStorage.removeItem("CatCatchCatch_" + obj);
            const element = obj == "selector" ? this.selector : this.regular;
            if (element) element.innerHTML = this.i18n("notSet", "غير معين");
            this.getFileName();
            if (warning) alert(warning);
        }

        /**
         * 清理缓存
         * @param {boolean} forceClearAll
         */
        clearCache(forceClearAll = false) {
            if (forceClearAll) {
                this.catchMedia = [];
                this.mediaSize = 0;
                this.isComplete = false;
                this.currentCaptureSessionId = null;
                if (this.tips) {
                    this.tips.innerHTML = this.i18n("waiting", "انتظار تشغيل الفيديو");
                }
                console.log("CatCatch: Cache cleared forcefully. Session ID reset.");
                return;
            }

            this.mediaSize = 0;
            if (this.isComplete) {
                console.log("CatCatch: clearCache called with isComplete=true but not forceClearAll. Media will be cleared after download/merge by explicit clearCache(true).");
                // لا نمسح هنا، المسح الكامل سيتم بعد عملية التنزيل/الدمج
                return;
            }

            console.log("CatCatch: Partial clear (keeping first buffer of each stream) - typically for restart.");
            for (let key in this.catchMedia) {
                const media = this.catchMedia[key];
                if (media && media.bufferList && media.bufferList.length > 0) {
                    const firstBuffer = media.bufferList[0];
                    media.bufferList = [firstBuffer];
                    this.mediaSize += firstBuffer ? (firstBuffer.byteLength || 0) : 0;
                } else if (media) {
                    media.bufferList = [];
                }
            }
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