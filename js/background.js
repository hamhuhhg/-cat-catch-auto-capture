importScripts("/js/function.js", "/js/init.js");

var tabCaptureStates = new Map();
var autoCaptureManuallyDisabledTabs = new Set();

function injectCatchScript(tabId, catchScriptInfo) {
    const files = [`catch-script/catch.js`];
    if (catchScriptInfo.i18n) files.unshift("catch-script/i18n.js");
    chrome.scripting.executeScript({
        target: { tabId: tabId, allFrames: catchScriptInfo.allFrames },
        files: files,
        injectImmediately: true,
        world: catchScriptInfo.world
    }, () => {
        if (chrome.runtime.lastError) {
            console.error(`CatCatch: Error injecting catch.js into tab ${tabId}: ${chrome.runtime.lastError.message}`);
            G.scriptList.get("catch.js").tabId.delete(tabId); // Rollback
        } else {
            // console.log(`CatCatch: catch.js auto-injected into tab ${tabId}`);
        }
        // No reload for automatic injection
    });
}

function removeCatchScript(tabId, catchScriptInfo) {
    // Attempt to notify the content script to clean up its UI and operations.
    chrome.tabs.sendMessage(tabId, {
        catCatchMessageRelay: true,
        for: "catchScript",
        payload: { command: "shutdown" }
    }, response => {
        if (chrome.runtime.lastError) {
            // console.warn(`CatCatch: Could not send shutdown to catch.js in tab ${tabId}: ${chrome.runtime.lastError.message}.`);
        }
    });
    // No reload for automatic removal
}

function manageAutoCaptureForTab(tabId, tabUrl) {
    if (!G.initSyncComplete || !G.initLocalComplete || tabId <= 0 || !tabUrl || isSpecialPage(tabUrl)) {
        return;
    }

    const catchScript = G.scriptList.get("catch.js");
    if (!catchScript) {
        console.error("CatCatch: catch.js script info not found in G.scriptList.");
        return;
    }

    const isBlockedByUrl = G.blockUrl.length > 0 && isLockUrl(tabUrl);
    const effectivelyBlocked = G.blockUrlWhite ? !isBlockedByUrl : isBlockedByUrl;

    // Determine if catch.js should be active based on auto-capture settings
    // MODIFIED: Added check for autoCaptureManuallyDisabledTabs
    if (autoCaptureManuallyDisabledTabs.has(tabId)) {
        // console.log(`CatCatch: Auto-capture for tab ${tabId} is manually disabled.`);
        if (catchScript.tabId.has(tabId)) {
            catchScript.tabId.delete(tabId);
            removeCatchScript(tabId, catchScript);
        }
        return;
    }
    const shouldBeActiveDueToAuto = G.autoCaptureEnabled && G.enable && !effectivelyBlocked;
    const isCurrentlyActive = catchScript.tabId.has(tabId);

    if (shouldBeActiveDueToAuto) {
        if (!isCurrentlyActive) {
            catchScript.tabId.add(tabId);
            injectCatchScript(tabId, catchScript);
        }
    } else { // Not meeting auto-capture conditions (auto_off, main_ext_disabled, or tab_is_blocked)
        if (isCurrentlyActive && G.autoCaptureEnabled) {
            // If auto-capture is ON, but conditions are no longer met (e.g., tab became blocklisted, or G.enable flipped)
            // Only remove if it was likely added by auto-capture.
            // This part is tricky. For now, if it *shouldn't* be active due to current auto-capture rules,
            // and it *is* active, assume it needs to be deactivated.
            catchScript.tabId.delete(tabId);
            removeCatchScript(tabId, catchScript);
        }
        // If G.autoCaptureEnabled is FALSE, global deactivation is handled by chrome.storage.onChanged.
        // Individual manual deactivations will also set catchScript.tabId.delete(tabId).
    }
}

// Service Worker 5分钟后会强制终止扩展
// https://bugs.chromium.org/p/chromium/issues/detail?id=1271154
// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension/70003493#70003493
chrome.webNavigation.onBeforeNavigate.addListener(function () { return; });
chrome.webNavigation.onHistoryStateUpdated.addListener(function () { return; });
chrome.runtime.onConnect.addListener(function (Port) {
    if (chrome.runtime.lastError || Port.name !== "HeartBeat") return;
    Port.postMessage("HeartBeat");
    Port.onMessage.addListener(function (message, Port) { return; });
    const interval = setInterval(function () {
        clearInterval(interval);
        Port.disconnect();
    }, 250000);
    Port.onDisconnect.addListener(function () {
        interval && clearInterval(interval);
        if (chrome.runtime.lastError) { return; }
    });
});

/**
 *  定时任务
 *  nowClear clear 清理冗余数据
 *  save 保存数据
 */
chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm.name === "nowClear" || alarm.name === "clear") {
        clearRedundant();
        return;
    }
    if (alarm.name === "save") {
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }
});

// onBeforeRequest 浏览器发送请求之前使用正则匹配发送请求的URL
// chrome.webRequest.onBeforeRequest.addListener(
//     function (data) {
//         try { findMedia(data, true); } catch (e) { console.log(e); }
//     }, { urls: ["<all_urls>"] }, ["requestBody"]
// );
// 保存requestHeaders
chrome.webRequest.onSendHeaders.addListener(
    function (data) {
        if (G && G.initSyncComplete && !G.enable) { return; }
        if (data.requestHeaders) {
            G.requestHeaders.set(data.requestId, data.requestHeaders);
            data.allRequestHeaders = data.requestHeaders;
        }
        try { findMedia(data, true); } catch (e) { console.log(e); }
    }, { urls: ["<all_urls>"] }, ['requestHeaders',
        chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS].filter(Boolean)
);
// onResponseStarted 浏览器接收到第一个字节触发，保证有更多信息判断资源类型
chrome.webRequest.onResponseStarted.addListener(
    function (data) {
        try {
            data.allRequestHeaders = G.requestHeaders.get(data.requestId);
            if (data.allRequestHeaders) {
                G.requestHeaders.delete(data.requestId);
            }
            findMedia(data);
        } catch (e) { console.log(e, data); }
    }, { urls: ["<all_urls>"] }, ["responseHeaders"]
);
// 删除失败的requestHeadersData
chrome.webRequest.onErrorOccurred.addListener(
    function (data) {
        G.requestHeaders.delete(data.requestId);
        G.blackList.delete(data.requestId);
    }, { urls: ["<all_urls>"] }
);

function findMedia(data, isRegex = false, filter = false, timer = false) {
    if (timer) { return; }
    // Service Worker被强行杀死之后重新自我唤醒，等待全局变量初始化完成。
    if (!G || !G.initSyncComplete || !G.initLocalComplete || G.tabId == undefined || cacheData.init) {
        setTimeout(() => {
            findMedia(data, isRegex, filter, true);
        }, 233);
        return;
    }
    // 检查 是否启用 是否在当前标签是否在屏蔽列表中
    const blockUrlFlag = data.tabId && data.tabId > 0 && G.blockUrlSet.has(data.tabId);
    if (!G.enable || (G.blockUrlWhite ? !blockUrlFlag : blockUrlFlag)) {
        return;
    }

    data.getTime = Date.now();

    if (!isRegex && G.blackList.has(data.requestId)) {
        G.blackList.delete(data.requestId);
        return;
    }
    // 屏蔽特殊页面发起的资源
    if (data.initiator != "null" &&
        data.initiator != undefined &&
        isSpecialPage(data.initiator)) { return; }
    if (G.isFirefox &&
        data.originUrl &&
        isSpecialPage(data.originUrl)) { return; }
    // 屏蔽特殊页面的资源
    if (isSpecialPage(data.url)) { return; }
    const urlParsing = new URL(data.url);
    let [name, ext] = fileNameParse(urlParsing.pathname);

    //正则匹配
    if (isRegex && !filter) {
        for (let key in G.Regex) {
            if (!G.Regex[key].state) { continue; }
            G.Regex[key].regex.lastIndex = 0;
            let result = G.Regex[key].regex.exec(data.url);
            if (result == null) { continue; }
            if (G.Regex[key].blackList) {
                G.blackList.add(data.requestId);
                return;
            }
            data.extraExt = G.Regex[key].ext ? G.Regex[key].ext : undefined;
            if (result.length == 1) {
                findMedia(data, true, true);
                return;
            }
            result.shift();
            result = result.map(str => decodeURIComponent(str));
            if (!result[0].startsWith('https://') && !result[0].startsWith('http://')) {
                result[0] = urlParsing.protocol + "//" + data.url;
            }
            data.url = result.join("");
            findMedia(data, true, true);
            return;
        }
        return;
    }

    // 非正则匹配
    if (!isRegex) {
        // 获取头部信息
        data.header = getResponseHeadersValue(data);
        //检查后缀
        if (!filter && ext != undefined) {
            filter = CheckExtension(ext, data.header?.size);
            if (filter == "break") { return; }
        }
        //检查类型
        if (!filter && data.header?.type != undefined) {
            filter = CheckType(data.header.type, data.header?.size);
            if (filter == "break") { return; }
        }
        //查找附件
        if (!filter && data.header?.attachment != undefined) {
            const res = data.header.attachment.match(reFilename);
            if (res && res[1]) {
                [name, ext] = fileNameParse(decodeURIComponent(res[1]));
                filter = CheckExtension(ext, 0);
                if (filter == "break") { return; }
            }
        }
        //放过类型为media的资源
        if (data.type == "media") {
            filter = true;
        }
    }

    if (!filter) { return; }

    // 谜之原因 获取得资源 tabId可能为 -1 firefox中则正常
    // 检查是 -1 使用当前激活标签得tabID
    data.tabId = data.tabId == -1 ? G.tabId : data.tabId;

    cacheData[data.tabId] ??= [];
    cacheData[G.tabId] ??= [];

    // 缓存数据大于9999条 清空缓存 避免内存占用过多
    if (cacheData[data.tabId].length > G.maxLength) {
        cacheData[data.tabId] = [];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        return;
    }

    // 查重 避免CPU占用 大于500 强制关闭查重
    // if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
    //     for (let item of cacheData[data.tabId]) {
    //         if (item.url.length == data.url.length &&
    //             item.cacheURL.pathname == urlParsing.pathname &&
    //             item.cacheURL.host == urlParsing.host &&
    //             item.cacheURL.search == urlParsing.search) { return; }
    //     }
    // }

    if (G.checkDuplicates && cacheData[data.tabId].length <= 500) {
        const tabFingerprints = G.urlMap.get(data.tabId) || new Set();
        if (tabFingerprints.has(data.url)) {
            return; // 找到重复，直接返回
        }
        tabFingerprints.add(data.url);
        G.urlMap.set(data.tabId, tabFingerprints);
        if (tabFingerprints.size >= 500) {
            tabFingerprints.clear();
        }
    }

    chrome.tabs.get(data.tabId, async function (webInfo) {
        if (chrome.runtime.lastError) { return; }
        data.requestHeaders = getRequestHeaders(data);
        // requestHeaders 中cookie 单独列出来
        if (data.requestHeaders?.cookie) {
            data.cookie = data.requestHeaders.cookie;
            data.requestHeaders.cookie = undefined;
        }
        const info = {
            name: name,
            url: data.url,
            size: data.header?.size,
            ext: ext,
            type: data.mime ?? data.header?.type,
            tabId: data.tabId,
            isRegex: isRegex,
            requestId: data.requestId ?? Date.now().toString(),
            initiator: data.initiator,
            requestHeaders: data.requestHeaders,
            cookie: data.cookie,
            // cacheURL: { host: urlParsing.host, search: urlParsing.search, pathname: urlParsing.pathname },
            getTime: data.getTime
        };
        // 不存在扩展使用类型
        if (info.ext === undefined && info.type !== undefined) {
            info.ext = info.type.split("/")[1];
        }
        // 正则匹配的备注扩展
        if (data.extraExt) {
            info.ext = data.extraExt;
        }
        // 不存在 initiator 和 referer 使用web url代替initiator
        if (info.initiator == undefined || info.initiator == "null") {
            info.initiator = info.requestHeaders?.referer ?? webInfo?.url;
        }
        // 装载页面信息
        info.title = webInfo?.title ?? "NULL";
        info.favIconUrl = webInfo?.favIconUrl;
        info.webUrl = webInfo?.url;
        // 屏蔽资源
        if (!isRegex && G.blackList.has(data.requestId)) {
            G.blackList.delete(data.requestId);
            return;
        }
        // 发送到popup 并检查自动下载
        chrome.runtime.sendMessage({ Message: "popupAddData", data: info }, function () {
            if (G.featAutoDownTabId.size > 0 && G.featAutoDownTabId.has(info.tabId) && chrome.downloads?.State) {
                try {
                    const downDir = info.title == "NULL" ? "CatCatch/" : stringModify(info.title) + "/";
                    let fileName = isEmpty(info.name) ? stringModify(info.title) + '.' + info.ext : decodeURIComponent(stringModify(info.name));
                    if (G.TitleName) {
                        fileName = filterFileName(templates(G.downFileName, info));
                    } else {
                        fileName = downDir + fileName;
                    }
                    chrome.downloads.download({
                        url: info.url,
                        filename: fileName
                    });
                } catch (e) { return; }
            }
            if (chrome.runtime.lastError) { return; }
        });

        // 数据发送
        if (G.send2local) {
            try { send2local("catch", { ...info, requestHeaders: data.allRequestHeaders }, info.tabId); } catch (e) { console.log(e); }
        }

        // 储存数据
        cacheData[info.tabId] ??= [];
        cacheData[info.tabId].push(info);

        // 当前标签媒体数量大于100 开启防抖 等待5秒储存 或 积累10个资源储存一次。
        if (cacheData[info.tabId].length >= 100 && debounceCount <= 10) {
            debounceCount++;
            clearTimeout(debounce);
            debounce = setTimeout(function () { save(info.tabId); }, 5000);
            return;
        }
        // 时间间隔小于500毫秒 等待2秒储存
        if (Date.now() - debounceTime <= 500) {
            clearTimeout(debounce);
            debounceTime = Date.now();
            debounce = setTimeout(function () { save(info.tabId); }, 2000);
            return;
        }
        save(info.tabId);
    });
}
// cacheData数据 储存到 chrome.storage.local
function save(tabId) {
    clearTimeout(debounce);
    debounceTime = Date.now();
    debounceCount = 0;
    (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData }, function () {
        chrome.runtime.lastError && console.log(chrome.runtime.lastError);
    });
    cacheData[tabId] && SetIcon({ number: cacheData[tabId].length, tabId: tabId });
}

/**
 * 监听 扩展 message 事件
 */
chrome.runtime.onMessage.addListener(function (Message, sender, sendResponse) {
    if (chrome.runtime.lastError) { return true; } // Keep 'return true' for async operations if any handler is async

    // Handle getCaptureSettings from catch-script/catch.js (via content-script.js)
    if (Message.Message === "getCaptureSettings") {
        if (sender.tab && sender.tab.id) {
            const settingsForClient = {
                watchedOnCaptureComplete: G.watchedOnCaptureComplete,
                watchedOnTabClose: G.watchedOnTabClose,
                watchedOnNextVideo: G.watchedOnNextVideo,
                mergeCapturedAV: G.mergeCapturedAV 
            };
            chrome.tabs.sendMessage(sender.tab.id, {
                catCatchMessageRelay: true, for: "catchScript",
                payload: { action: "receiveSettingsAndTabId", settings: settingsForClient, tabId: sender.tab.id }
            });
        }
        return true;
    }

    // Handle saveCapturedVideo from catch-script/catch.js
    if (Message.Message === "saveCapturedVideo") {
        const videoData = Message.data;
        if (videoData && videoData.tabId && videoData.filename) {
            chrome.tabs.sendMessage(videoData.tabId, {
                catCatchMessageRelay: true, for: "catchScript",
                payload: { command: "triggerDownloadFromCache", filenameHint: videoData.filename }
            }, response => { if (chrome.runtime.lastError){ console.warn("Error sending triggerDownloadFromCache: ", chrome.runtime.lastError.message);}});
        } else { console.warn("CatCatch: Invalid videoData for 'saveCapturedVideo'", videoData); }
        return true;
    }

    // Handle updateTabCaptureState from catch-script/catch.js
    if (Message.Message === "updateTabCaptureState") {
        if (Message.tabId && Message.captureState) {
            tabCaptureStates.set(Message.tabId, Message.captureState);
        }
        return true;
    }

    if (!G.initLocalComplete || !G.initSyncComplete) { sendResponse("error"); return true; }

    if (Message.Message === "toggleManualCaptureOverride") {
        const tabId = Message.tabId || G.tabId;
        const catchScript = G.scriptList.get("catch.js");
        if (!catchScript) { sendResponse({ success: false, error: "Script info not found." }); return true; }
        let newManualOverrideState;
        if (autoCaptureManuallyDisabledTabs.has(tabId)) {
            autoCaptureManuallyDisabledTabs.delete(tabId); newManualOverrideState = false;
            chrome.tabs.get(tabId, function(tab) {
                if (!chrome.runtime.lastError && tab && tab.url) manageAutoCaptureForTab(tabId, tab.url);
            });
        } else {
            autoCaptureManuallyDisabledTabs.add(tabId); newManualOverrideState = true;
            if (catchScript.tabId.has(tabId)) {
                catchScript.tabId.delete(tabId); removeCatchScript(tabId, catchScript);
            }
        }
        chrome.runtime.sendMessage({ Message: "buttonStateUpdated", tabId: tabId });
        sendResponse({ success: true, manualOverrideActive: newManualOverrideState });
        return true;
    }

    Message.tabId = Message.tabId ?? G.tabId;

    if (Message.Message == "pushData") { (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData }); sendResponse("ok"); return true; }
    if (Message.Message == "getAllData") { sendResponse(cacheData); return true; }
    if (Message.Message == "ClearIcon") { Message.type ? SetIcon({ tabId: Message.tabId }) : SetIcon(); sendResponse("ok"); return true; }
    if (Message.Message == "enable") {
        G.enable = !G.enable; chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
        sendResponse(G.enable); return true;
    }
    if (Message.Message == "getData" && Message.requestId) {
        if (!Array.isArray(Message.requestId)) Message.requestId = [Message.requestId];
        const response = [];
        if (Message.requestId.length) {
            for (let itemKey in cacheData) {
                if(cacheData[itemKey]){
                    for (let data of cacheData[itemKey]) {
                        if (Message.requestId.includes(data.requestId)) response.push(data);
                    }
                }
            }
        }
        sendResponse(response.length ? response : "error"); return true;
    }
    if (Message.Message == "getData") { sendResponse(cacheData[Message.tabId]); return true; }
    if (Message.Message == "getButtonState") {
        let state = {
            MobileUserAgent: G.featMobileTabId.has(Message.tabId), AutoDown: G.featAutoDownTabId.has(Message.tabId),
            enable: G.enable, autoCaptureEnabled: G.autoCaptureEnabled, 
            isManuallyDisabled: autoCaptureManuallyDisabledTabs.has(Message.tabId), mergeCapturedAV: G.mergeCapturedAV
        };
        G.scriptList.forEach(function (item, key) { state[item.key] = item.tabId.has(Message.tabId); });
        sendResponse(state); return true;
    }
    if (Message.Message == "mobileUserAgent") {
        mobileUserAgent(Message.tabId, !G.featMobileTabId.has(Message.tabId));
        chrome.tabs.reload(Message.tabId, { bypassCache: true }); sendResponse("ok"); return true;
    }
    if (Message.Message == "autoDown") {
        G.featAutoDownTabId.has(Message.tabId) ? G.featAutoDownTabId.delete(Message.tabId) : G.featAutoDownTabId.add(Message.tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
        sendResponse("ok"); return true;
    }
    if (Message.Message == "script") {
        if (Message.script === "catch.js" && G.autoCaptureEnabled) {
            sendResponse({ success: false, error: "Use toggleManualCaptureOverride when auto-capture is on." }); return true;
        }
        if (!G.scriptList.has(Message.script)) { sendResponse("error no exists"); return false; }
        const script = G.scriptList.get(Message.script); const scriptTabid = script.tabId;
        const refresh = Message.refresh ?? script.refresh;
        if (scriptTabid.has(Message.tabId)) {
            scriptTabid.delete(Message.tabId);
            if (Message.script == "search.js") G.deepSearchTemporarilyClose = Message.tabId;
            refresh && chrome.tabs.reload(Message.tabId, { bypassCache: true }); sendResponse("ok"); return true;
        }
        scriptTabid.add(Message.tabId);
        if (refresh) { chrome.tabs.reload(Message.tabId, { bypassCache: true }); }
        else {
            const files = [`catch-script/${Message.script}`];
            script.i18n && files.unshift("catch-script/i18n.js");
            chrome.scripting.executeScript({ target: { tabId: Message.tabId, allFrames: script.allFrames }, files: files, injectImmediately: true, world: script.world });
        }
        sendResponse("ok"); return true;
    }
    if (Message.Message == "scriptI18n") {
        chrome.scripting.executeScript({ target: { tabId: Message.tabId, allFrames: true }, files: ["catch-script/i18n.js"], injectImmediately: true, world: "MAIN" });
        sendResponse("ok"); return true;
    }
    if (Message.Message == "HeartBeat") {
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            if (tabs[0] && tabs[0].id) G.tabId = tabs[0].id;
        });
        sendResponse("HeartBeat OK"); return true;
    }
    if (Message.Message == "clearData") {
        if (Message.type) { delete cacheData[Message.tabId]; }
        else { for (let itemKey in cacheData) { if (itemKey == Message.tabId) continue; delete cacheData[itemKey]; } }
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant(); sendResponse("OK"); return true;
    }
    if (Message.Message == "clearRedundant") { clearRedundant(); sendResponse("OK"); return true; }
    if (Message.Message == "addMedia") {
        chrome.tabs.query({}, function (tabs) {
            for (let item of tabs) {
                if (item.url == Message.href) {
                    findMedia({ url: Message.url, tabId: item.id, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, requestHeaders: Message.requestHeaders }, true, true);
                    return true;
                }
            }
            findMedia({ url: Message.url, tabId: -1, extraExt: Message.extraExt, mime: Message.mime, requestId: Message.requestId, initiator: Message.href, requestHeaders: Message.requestHeaders }, true, true);
        });
        sendResponse("ok"); return true;
    }
    if (Message.Message == "catCatchFFmpeg") {
        const dataToFfmpegPage = { 
            ...Message, 
            Message: "ffmpeg", 
            tabId: Message.tabId ?? sender.tab.id, 
            version: G.ffmpegConfig.version 
        };
        let targetUrl = G.ffmpegConfig.url;
        if (Message.ffmpegAutoDownload) {
            targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'autoDownload=true';
        }
        chrome.tabs.query({ url: G.ffmpegConfig.url + "*" }, function (tabs) {
            if (chrome.runtime.lastError || !tabs.length) {
                chrome.tabs.create({ url: targetUrl, active: Message.active ?? true }, function (tab) {
                    if (chrome.runtime.lastError) { return; }
                    G.ffmpegConfig.tab = tab.id; G.ffmpegConfig.cacheData.push(dataToFfmpegPage);
                }); return true;
            }
            if (tabs[0].status == "complete") { chrome.tabs.sendMessage(tabs[0].id, dataToFfmpegPage); }
            else { G.ffmpegConfig.tab = tabs[0].id; G.ffmpegConfig.cacheData.push(dataToFfmpegPage); }
        });
        sendResponse("ok"); return true;
    }
    if (Message.Message == "send2local" && G.send2local) {
        try { send2local(Message.action, Message.data, Message.tabId); } catch (e) { console.log(e); }
        sendResponse("ok"); return true;
    }

    if (Message.Message === "mergeCapturedAVRequest") {
        const { files, filenameHint, tabId } = Message;
        if (files && files.length === 2 && filenameHint && tabId) {
            Promise.all([
                fetch(files[0].dataUrl).then(res => res.blob()),
                fetch(files[1].dataUrl).then(res => res.blob())
            ]).then(async ([blob1, blob2]) => {
                URL.revokeObjectURL(files[0].dataUrl);
                URL.revokeObjectURL(files[1].dataUrl);

                if (typeof MP4Box === 'undefined') {
                    console.error("CatCatch: MP4Box.js is not available (MP4Box is undefined).");
                    sendResponse({ success: false, message: "MP4Box.js not found." });
                    return;
                }

                const outputMp4File = MP4Box.createFile();
                let processedFileCount = 0;
                const totalFilesToProcess = 2;
                const trackIdMap = new Map();

                const processFile = (blob, fileIdentifierHint) => {
                    return new Promise(async (resolve, reject) => {
                        const tempMp4File = MP4Box.createFile();
                        const buffer = await blob.arrayBuffer();
                        buffer.fileStart = 0;

                        tempMp4File.onReady = (info) => {
                            let trackProcessed = false;
                            if (info.tracks && info.tracks.length > 0) {
                                info.tracks.forEach(track => {
                                    if (!trackProcessed && 
                                        (track.type === fileIdentifierHint || 
                                         (fileIdentifierHint === "video" && track.type !== "audio") || 
                                         (fileIdentifierHint === "audio" && track.type !== "video"))
                                       ) {
                                        const newTrackOpts = {
                                            type: track.type,
                                            codec: track.codec,
                                            width: track.video ? track.video.width : undefined,
                                            height: track.video ? track.video.height : undefined,
                                            timescale: track.timescale,
                                            duration: track.duration,
                                            language: track.language,
                                            hdlr_name: track.hdlr_name,
                                            name: track.name,
                                            nb_samples: track.nb_samples,
                                            description: track.description
                                        };
                                        const newTrackId = outputMp4File.addTrack(newTrackOpts);
                                        trackIdMap.set(track.id, newTrackId);
                                        tempMp4File.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 0 });
                                        trackProcessed = true;
                                    }
                                });
                                 if (!trackProcessed && info.tracks.length > 0) { 
                                    const track = info.tracks[0]; // Fallback to first track
                                    console.warn(`CatCatch: Could not find '${fileIdentifierHint}' track, using first available track ID ${track.id} (type ${track.type}) as fallback.`);
                                    const newTrackOpts = {type: track.type, codec: track.codec, width: track.video ? track.video.width : undefined, height: track.video ? track.video.height : undefined, timescale: track.timescale, duration: track.duration, language: track.language, hdlr_name: track.hdlr_name, name: track.name, nb_samples: track.nb_samples, description: track.description };
                                    const newTrackId = outputMp4File.addTrack(newTrackOpts);
                                    trackIdMap.set(track.id, newTrackId);
                                    tempMp4File.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples || 0 });
                                    trackProcessed = true; // Mark as processed with fallback
                                 }
                            }
                            if (!trackProcessed) {
                                console.error(`CatCatch: No suitable tracks found or processed in blob identified as ${fileIdentifierHint}.`);
                                reject(new Error(`No suitable tracks in ${fileIdentifierHint} blob.`));
                                return;
                            }
                            tempMp4File.start();
                        };

                        tempMp4File.onSamples = (inputTrackId, user, samples) => {
                            const outputTrackId = trackIdMap.get(inputTrackId);
                            if (outputTrackId !== undefined) {
                                for (const sample of samples) {
                                    outputMp4File.addSample(outputTrackId, sample.data, {
                                        duration: sample.duration,
                                        dts: sample.dts,
                                        cts: sample.cts,
                                        is_sync: sample.is_sync,
                                    });
                                }
                            }
                        };
                        
                        tempMp4File.onFlush = () => {
                            processedFileCount++;
                            if (processedFileCount === totalFilesToProcess) {
                                try {
                                    const mergedBuffer = outputMp4File.getBuffer();
                                    const mergedBlob = new Blob([mergedBuffer], { type: 'video/mp4' });
                                    chrome.downloads.download({
                                        url: URL.createObjectURL(mergedBlob),
                                        filename: filenameHint + "_merged.mp4"
                                    }, (downloadId) => {
                                        if (chrome.runtime.lastError) {
                                            console.error("CatCatch: Download error:", chrome.runtime.lastError.message);
                                            sendResponse({ success: false, message: "Download failed: " + chrome.runtime.lastError.message });
                                        } else {
                                            sendResponse({ success: true, message: "Merge and download started." });
                                        }
                                    });
                                } catch (e) {
                                    console.error("CatCatch: Error getting buffer from outputMp4File:", e);
                                    sendResponse({ success: false, message: "Failed to finalize merged MP4: " + e.message });
                                }
                            }
                            resolve();
                        };

                        tempMp4File.onError = (e) => {
                            console.error(`CatCatch: MP4Box.js error for ${fileIdentifierHint}:`, e);
                            reject(e);
                        };
                        
                        tempMp4File.appendBuffer(buffer);
                        tempMp4File.flush();
                    });
                };
                
                (async () => {
                    try {
                        let firstFileHint = files[0].mimeType && files[0].mimeType.startsWith('video/') ? "video" : (files[0].mimeType && files[0].mimeType.startsWith('audio/') ? "audio" : "unknown");
                        let secondFileHint = files[1].mimeType && files[1].mimeType.startsWith('audio/') ? "audio" : (files[1].mimeType && files[1].mimeType.startsWith('video/') ? "video" : "unknown");

                        // Determine processing order: video then audio is typical
                        if (firstFileHint === "audio" && secondFileHint === "video") {
                            await processFile(blob2, "video"); // Process second blob (video) first
                            await processFile(blob1, "audio"); // Then first blob (audio)
                        } else {
                            // Default: process blob1 (assumed video or first given) then blob2 (assumed audio or second given)
                            // If hints are unknown, this relies on the order they were sent
                            await processFile(blob1, firstFileHint === "unknown" ? "video" : firstFileHint); 
                            await processFile(blob2, secondFileHint === "unknown" ? "audio" : secondFileHint);
                        }
                    } catch (error) {
                        console.error("CatCatch: Error in merging process with MP4Box:", error);
                        sendResponse({ success: false, message: "Merging process failed: " + error.message });
                    }
                })();

            }).catch(error => {
                console.error("CatCatch: Error fetching blobs for merging:", error);
                sendResponse({ success: false, message: "Error fetching data for merge." });
            });
        } else {
            console.error("CatCatch: Invalid mergeCapturedAVRequest received.", Message);
            sendResponse({ success: false, message: "Invalid request parameters." });
        }
        return true; 
    }

    if (Message.Message === "setMergeCapturedAVState") {
        if (typeof Message.state === 'boolean') {
            G.mergeCapturedAV = Message.state;
            chrome.storage.sync.set({ mergeCapturedAV: G.mergeCapturedAV }, () => {
                if (chrome.runtime.lastError) {
                    console.error("CatCatch: Error saving mergeCapturedAV state:", chrome.runtime.lastError.message);
                    sendResponse({ success: false, error: chrome.runtime.lastError.message });
                } else {
                    sendResponse({ success: true });
                }
            });
        } else {
            console.error("CatCatch: Invalid state for setMergeCapturedAVState:", Message.state);
            sendResponse({ success: false, error: "Invalid state." });
        }
        return true; 
    }
    // If no message was handled by this point, it might be an idea to send a default response
    // or ensure all message types are covered or explicitly ignored.
    // For now, we assume any message not caught above doesn't require a response or is handled elsewhere.
});
// 选定标签 更新G.tabId
// chrome.tabs.onHighlighted.addListener(function (activeInfo) {
//     if (activeInfo.windowId == -1 || !activeInfo.tabIds || !activeInfo.tabIds.length) { return; }
//     G.tabId = activeInfo.tabIds[0];
// });

/**
 * 监听 切换标签
 * 更新全局变量 G.tabId 为当前标签
 */
chrome.tabs.onActivated.addListener(function (activeInfo) {
    G.tabId = activeInfo.tabId;
    if (cacheData[G.tabId] !== undefined) {
        SetIcon({ number: cacheData[G.tabId].length, tabId: G.tabId });
        return;
    }
    SetIcon({ tabId: G.tabId });
});

// 切换窗口，更新全局变量G.tabId
// chrome.windows.onFocusChanged.addListener(function (activeInfo) {
//     if (activeInfo == -1) { return; }
//     chrome.tabs.query({ active: true, windowId: activeInfo }, function (tabs) {
//         if (tabs[0] && tabs[0].id) {
//             G.tabId = tabs[0].id;
//         } else {
//             G.tabId = -1;
//         }
//     });
// }, { filters: ["normal"] });

/**
 * 监听 标签页面更新
 * 检查 清理数据
 * 检查 是否在屏蔽列表中
 */
chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (isSpecialPage(tab.url) || tabId <= 0 || !G.initSyncComplete) { return; }
    if (changeInfo.status === "complete" && tab.url) { // Ensure tab.url is present
        manageAutoCaptureForTab(tabId, tab.url);
    }
    if (changeInfo.status && changeInfo.status == "loading" && G.autoClearMode == 2) {
        G.urlMap.delete(tabId);
        chrome.alarms.get("save", function (alarm) {
            if (!alarm) {
                delete cacheData[tabId];
                SetIcon({ tabId: tabId });
                chrome.alarms.create("save", { when: Date.now() + 1000 });
            }
        });
    }
    // 检查当前标签是否在屏蔽列表中
    if (changeInfo.url && tabId > 0 && G.blockUrl.length) {
        G.blockUrlSet.delete(tabId);
        if (isLockUrl(changeInfo.url)) {
            G.blockUrlSet.add(tabId);
        }
    }
    chrome.sidePanel.setOptions({
        tabId,
        path: "popup.html?tabId=" + tabId
    });
});

/**
 * 监听 frame 正在载入
 * 检查 是否在屏蔽列表中 (frameId == 0 为主框架)
 * 检查 自动清理 (frameId == 0 为主框架)
 * 检查 注入脚本
 */
chrome.webNavigation.onCommitted.addListener(function (details) {
    if (isSpecialPage(details.url) || details.tabId <= 0 || !G.initSyncComplete) { return; }

    if (details.frameId === 0 && details.url) { // Ensure details.url is present for main frame
        manageAutoCaptureForTab(details.tabId, details.url);
    }
    // 刷新页面 检查是否在屏蔽列表中
    if (details.frameId == 0 && details.transitionType == "reload") {
        G.blockUrlSet.delete(details.tabId);
        if (isLockUrl(details.url)) {
            G.blockUrlSet.add(details.tabId);
        }
    }

    // 刷新清理角标数
    if (details.frameId == 0 && (!['auto_subframe', 'manual_subframe', 'form_submit'].includes(details.transitionType)) && G.autoClearMode == 1) {
        delete cacheData[details.tabId];
        G.urlMap.delete(details.tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        SetIcon({ tabId: details.tabId });
    }

    // chrome内核版本 102 以下不支持 chrome.scripting.executeScript API
    if (G.version < 102) { return; }

    if (G.deepSearch && G.deepSearchTemporarilyClose != details.tabId) {
        G.scriptList.get("search.js").tabId.add(details.tabId);
        G.deepSearchTemporarilyClose = null;
    }

    // catch-script 脚本
    G.scriptList.forEach(function (item, script) {
        if (script === "catch.js") { // If it's catch.js, its injection is now handled by manageAutoCaptureForTab
            return; // Equivalent to 'continue' in a for loop
        }
        // The rest of the original loop logic for other scripts:
        if (!item.tabId.has(details.tabId) || !item.allFrames) { return true; }

        const files = [`catch-script/${script}`];
        item.i18n && files.unshift("catch-script/i18n.js");
        chrome.scripting.executeScript({
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            files: files,
            injectImmediately: true,
            world: item.world
        });
    });

    // 模拟手机
    if (G.initLocalComplete && G.featMobileTabId.size > 0 && G.featMobileTabId.has(details.tabId)) {
        chrome.scripting.executeScript({
            args: [G.MobileUserAgent.toString()],
            target: { tabId: details.tabId, frameIds: [details.frameId] },
            func: function () {
                Object.defineProperty(navigator, 'userAgent', { value: arguments[0], writable: false });
            },
            injectImmediately: true,
            world: "MAIN"
        });
    }
});

/**
 * 监听 标签关闭 清理数据
 */
chrome.tabs.onRemoved.addListener(function (tabId) {
    // 清理缓存数据
    // New logic for watchedOnTabClose:
    if (G.autoCaptureEnabled && G.watchedOnTabClose && G.scriptList.get("catch.js")?.tabId.has(tabId)) {
        const captureState = tabCaptureStates.get(tabId);
        if (captureState && captureState.isCapturing) {
            // console.log(`Background: Tab ${tabId} closed, was capturing (state found). Commanding self-download.`);
            chrome.tabs.sendMessage(tabId, {
                catCatchMessageRelay: true,
                for: "catchScript",
                payload: {
                    command: "triggerDownloadFromCache",
                    filenameHint: captureState.filename
                }
            }, response => {
                if (chrome.runtime.lastError) {
                    // console.warn(`CatCatch: Error sending 'triggerDownloadFromCache' to closing tab ${tabId}: ${chrome.runtime.lastError.message}. Might be too late.`);
                } else {
                    // console.log(`CatCatch: 'triggerDownloadFromCache' message sent to closing tab ${tabId}. Response:`, response);
                }
            });
        } else {
            // console.log(`Background: Tab ${tabId} closed, auto-capture ON, but no active capture state found in tabCaptureStates or not marked as isCapturing.`);
       }
    }
    tabCaptureStates.delete(tabId); // Clean up state for the closed tab

    chrome.alarms.get("nowClear", function (alarm) {
        !alarm && chrome.alarms.create("nowClear", { when: Date.now() + 1000 });
    });
    if (G.initSyncComplete) {
        G.blockUrlSet.has(tabId) && G.blockUrlSet.delete(tabId);
    }
});

/**
 * 浏览器 扩展快捷键
 */
chrome.commands.onCommand.addListener(function (command) {
    if (command == "auto_down") {
        if (G.featAutoDownTabId.has(G.tabId)) {
            G.featAutoDownTabId.delete(G.tabId);
        } else {
            G.featAutoDownTabId.add(G.tabId);
        }
        (chrome.storage.session ?? chrome.storage.local).set({ featAutoDownTabId: Array.from(G.featAutoDownTabId) });
    } else if (command == "catch") {
        const scriptTabid = G.scriptList.get("catch.js").tabId;
        scriptTabid.has(G.tabId) ? scriptTabid.delete(G.tabId) : scriptTabid.add(G.tabId);
        chrome.tabs.reload(G.tabId, { bypassCache: true });
    } else if (command == "m3u8") {
        chrome.tabs.create({ url: "m3u8.html" });
    } else if (command == "clear") {
        delete cacheData[G.tabId];
        (chrome.storage.session ?? chrome.storage.local).set({ MediaData: cacheData });
        clearRedundant();
        SetIcon({ tabId: G.tabId });
    } else if (command == "enable") {
        G.enable = !G.enable;
        chrome.storage.sync.set({ enable: G.enable });
        chrome.action.setIcon({ path: G.enable ? "/img/icon.png" : "/img/icon-disable.png" });
    } else if (command == "reboot") {
        chrome.runtime.reload();
    }
});

/**
 * 监听 页面完全加载完成 判断是否在线ffmpeg页面
 * 如果是在线ffmpeg 则发送数据
 */
chrome.webNavigation.onCompleted.addListener(function (details) {
    if (G.ffmpegConfig.tab && details.tabId == G.ffmpegConfig.tab) {
        setTimeout(() => {
            G.ffmpegConfig.cacheData.forEach(data => {
                chrome.tabs.sendMessage(details.tabId, data);
            });
            G.ffmpegConfig.cacheData = [];
            G.ffmpegConfig.tab = 0;
        }, 500);
    }
});

/**
 * 检查扩展名和大小
 * @param {String} ext 
 * @param {Number} size 
 * @returns {Boolean|String}
 */
function CheckExtension(ext, size) {
    const Ext = G.Ext.get(ext);
    if (!Ext) { return false; }
    if (!Ext.state) { return "break"; }
    if (Ext.size != 0 && size != undefined && size <= Ext.size * 1024) { return "break"; }
    return true;
}

/**
 * 检查类型和大小
 * @param {String} dataType 
 * @param {Number} dataSize 
 * @returns {Boolean|String}
 */
function CheckType(dataType, dataSize) {
    const typeInfo = G.Type.get(dataType.split("/")[0] + "/*") || G.Type.get(dataType);
    if (!typeInfo) { return false; }
    if (!typeInfo.state) { return "break"; }
    if (typeInfo.size != 0 && dataSize != undefined && dataSize <= typeInfo.size * 1024) { return "break"; }
    return true;
}

/**
 * 获取文件名及扩展名
 * @param {String} pathname 
 * @returns {Array}
 */
function fileNameParse(pathname) {
    let fileName = decodeURI(pathname.split("/").pop());
    let ext = fileName.split(".");
    ext = ext.length == 1 ? undefined : ext.pop().toLowerCase();
    return [fileName, ext ? ext : undefined];
}

/**
 * 获取响应头信息
 * @param {Object} data 
 * @returns {Object}
 */
function getResponseHeadersValue(data) {
    const header = {};
    if (data.responseHeaders == undefined || data.responseHeaders.length == 0) { return header; }
    for (let item of data.responseHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "content-length") {
            header.size ??= parseInt(item.value);
        } else if (item.name == "content-type") {
            header.type = item.value.split(";")[0].toLowerCase();
        } else if (item.name == "content-disposition") {
            header.attachment = item.value;
        } else if (item.name == "content-range") {
            let size = item.value.split('/')[1];
            if (size !== '*') {
                header.size = parseInt(size);
            }
        }
    }
    return header;
}

/**
 * 获取请求头
 * @param {Object} data 
 * @returns {Object|Boolean}
 */
function getRequestHeaders(data) {
    if (data.allRequestHeaders == undefined || data.allRequestHeaders.length == 0) { return false; }
    const header = {};
    for (let item of data.allRequestHeaders) {
        item.name = item.name.toLowerCase();
        if (item.name == "referer") {
            header.referer = item.value;
        } else if (item.name == "origin") {
            header.origin = item.value;
        } else if (item.name == "cookie") {
            header.cookie = item.value;
        } else if (item.name == "authorization") {
            header.authorization = item.value;
        }
    }
    if (Object.keys(header).length) {
        return header;
    }
    return false;
}
//设置扩展图标
function SetIcon(obj) {
    if (obj?.number == 0 || obj?.number == undefined) {
        chrome.action.setBadgeText({ text: "", tabId: obj?.tabId ?? G.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "还没闻到味儿~", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    } else if (G.badgeNumber) {
        obj.number = obj.number > 999 ? "999+" : obj.number.toString();
        chrome.action.setBadgeText({ text: obj.number, tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
        // chrome.action.setTitle({ title: "抓到 " + obj.number + " 条鱼", tabId: obj.tabId }, function () { if (chrome.runtime.lastError) { return; } });
    }
}

// 模拟手机端
function mobileUserAgent(tabId, change = false) {
    if (change) {
        G.featMobileTabId.add(tabId);
        (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [tabId],
            addRules: [{
                "id": tabId,
                "action": {
                    "type": "modifyHeaders",
                    "requestHeaders": [{
                        "header": "User-Agent",
                        "operation": "set",
                        "value": G.MobileUserAgent
                    }]
                },
                "condition": {
                    "tabIds": [tabId],
                    "resourceTypes": Object.values(chrome.declarativeNetRequest.ResourceType)
                }
            }]
        });
        return true;
    }
    G.featMobileTabId.delete(tabId) && (chrome.storage.session ?? chrome.storage.local).set({ featMobileTabId: Array.from(G.featMobileTabId) });
    chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [tabId]
    });
}

// 判断特殊页面
function isSpecialPage(url) {
    if (!url || url == "null") { return true; }
    return !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("blob:"));
}

// 测试
// chrome.storage.local.get(function (data) { console.log(data.MediaData) });
// chrome.declarativeNetRequest.getSessionRules(function (rules) { console.log(rules); });
// chrome.tabs.query({}, function (tabs) { for (let item of tabs) { console.log(item.id); } });
