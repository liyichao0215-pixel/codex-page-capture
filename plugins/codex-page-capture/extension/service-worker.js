import {
  DEFAULT_ALLOWLIST,
  isAllowedUrl,
  normalizeAllowlist,
  publicTab,
} from "./shared.js";

const NATIVE_HOST = "com.codex.page_capture";
const DEBUG_PROTOCOL_VERSION = "1.3";
const POPUP_TIMEOUT_MS = 35 * 60 * 1000;
const BACKGROUND_GRACE_MS = 2000;
const SCREENCAST_STALL_MS = 2000;
const SCREENCAST_FPS_SAMPLE_MS = 500;
const TARGET_SOURCE_FPS = 15;
const FALLBACK_INTERVAL_MS = 33;

let nativePort = null;
let reconnectTimer = null;
let currentRecording = null;
const popupRequests = new Map();

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

async function getAllowlist() {
  const stored = await chrome.storage.local.get(["allowlist"]);
  return normalizeAllowlist(stored.allowlist || DEFAULT_ALLOWLIST);
}

async function getAllowedTabs() {
  const [tabs, allowlist] = await Promise.all([chrome.tabs.query({}), getAllowlist()]);
  return tabs
    .filter((tab) => Number.isInteger(tab.id) && !tab.incognito && isAllowedUrl(tab.url, allowlist))
    .map((tab) => publicTab(tab));
}

async function resolveTargetTab(tabId) {
  let tab;
  if (Number.isInteger(tabId)) {
    tab = await chrome.tabs.get(tabId);
  } else {
    const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = activeTabs[0];
  }
  if (!tab || !Number.isInteger(tab.id)) {
    throw new Error("没有找到可采集的当前标签页");
  }
  if (tab.incognito) {
    throw new Error("第一版不允许采集隐身窗口页面");
  }
  const allowlist = await getAllowlist();
  if (!isAllowedUrl(tab.url, allowlist)) {
    throw new Error(`页面不在允许范围内：${tab.url || "未知地址"}`);
  }
  return tab;
}

async function attach(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, DEBUG_PROTOCOL_VERSION);
  } catch (error) {
    throw new Error(
      `无法连接页面调试器。请关闭该标签页的 DevTools 或结束其他 Chrome/Codex 浏览器任务后重试。${errorMessage(error)}`,
    );
  }
}

async function detach(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // The tab may already be closed or detached by Chrome.
  }
}

async function sendCdp(tabId, method, params = undefined) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

function postNative(message) {
  if (!nativePort) throw new Error("本地保存组件未连接");
  nativePort.postMessage(message);
}

function sendRecordingEvent(type, payload = {}) {
  try {
    postNative({ kind: "recording_event", type, ...payload });
  } catch {
    // Disconnect cleanup is handled separately.
  }
}

function clearRecordingTimers(recording) {
  if (!recording) return;
  clearInterval(recording.watchdogTimer);
  clearTimeout(recording.backgroundTimer);
  clearTimeout(recording.maxTimer);
  clearTimeout(recording.fallbackTimer);
  recording.watchdogTimer = null;
  recording.backgroundTimer = null;
  recording.maxTimer = null;
  recording.fallbackTimer = null;
}

async function emitFallbackFrame(recording) {
  if (!currentRecording || currentRecording.id !== recording.id || recording.stopping) return;
  if (recording.fallbackBusy) {
    recording.fallbackTimer = setTimeout(() => emitFallbackFrame(recording), FALLBACK_INTERVAL_MS);
    return;
  }
  recording.fallbackBusy = true;
  const startedAt = Date.now();
  try {
    const result = await sendCdp(recording.tabId, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 85,
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    recording.lastFrameAt = Date.now();
    sendRecordingEvent("frame", {
      recording_id: recording.id,
      data: result.data,
      at_ms: recording.lastFrameAt,
      source: "screenshot_loop",
    });
  } catch (error) {
    await autoStopRecording("capture_failed", errorMessage(error));
    return;
  } finally {
    recording.fallbackBusy = false;
  }
  const delay = Math.max(0, FALLBACK_INTERVAL_MS - (Date.now() - startedAt));
  recording.fallbackTimer = setTimeout(() => emitFallbackFrame(recording), delay);
}

async function switchToFallback(recording, warning = "页面帧流停顿，已自动切换到兼容录制模式") {
  if (
    !currentRecording ||
    currentRecording.id !== recording.id ||
    recording.mode === "screenshot_loop" ||
    recording.fallbackSwitching
  ) {
    return;
  }
  recording.fallbackSwitching = true;
  try {
    await sendCdp(recording.tabId, "Page.stopScreencast");
  } catch {
    // It may already have stopped; the screenshot loop can still be attempted.
  }
  recording.mode = "screenshot_loop";
  recording.fallbackSwitching = false;
  sendRecordingEvent("mode_changed", {
    recording_id: recording.id,
    mode: recording.mode,
    warning,
  });
  await emitFallbackFrame(recording);
}

async function stopRecordingInternal(reason = "user_stopped", detail = null) {
  const recording = currentRecording;
  if (!recording) throw new Error("当前没有正在录制的页面");
  if (recording.stopping) return recording.stopPromise;
  recording.stopping = true;
  recording.stopPromise = (async () => {
    clearRecordingTimers(recording);
    if (recording.mode === "screencast") {
      try {
        await sendCdp(recording.tabId, "Page.stopScreencast");
      } catch {
        // Continue detaching and preserving frames.
      }
    }
    await detach(recording.tabId);
    currentRecording = null;
    return {
      recording_id: recording.id,
      tab_id: recording.tabId,
      title: recording.title,
      url: recording.url,
      reason,
      detail,
      mode: recording.mode,
      ended_at: new Date().toISOString(),
    };
  })();
  return recording.stopPromise;
}

async function autoStopRecording(reason, detail = null) {
  if (!currentRecording || currentRecording.stopping) return;
  const recordingId = currentRecording.id;
  try {
    const result = await stopRecordingInternal(reason, detail);
    sendRecordingEvent("auto_stopped", { recording_id: recordingId, result });
  } catch (error) {
    sendRecordingEvent("auto_stopped", {
      recording_id: recordingId,
      error: errorMessage(error),
      reason,
    });
  }
}

function scheduleBackgroundStop() {
  const recording = currentRecording;
  if (!recording || recording.backgroundTimer) return;
  recording.backgroundTimer = setTimeout(() => {
    recording.backgroundTimer = null;
    autoStopRecording("target_backgrounded", "目标标签页离开前台超过 2 秒");
  }, BACKGROUND_GRACE_MS);
}

function cancelBackgroundStop() {
  if (!currentRecording?.backgroundTimer) return;
  clearTimeout(currentRecording.backgroundTimer);
  currentRecording.backgroundTimer = null;
}

async function captureScreenshot(args = {}) {
  const tab = await resolveTargetTab(args.tab_id);
  await attach(tab.id);
  try {
    await sendCdp(tab.id, "Page.enable");
    const [image, metrics] = await Promise.all([
      sendCdp(tab.id, "Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }),
      sendCdp(tab.id, "Page.getLayoutMetrics"),
    ]);
    return {
      tab: publicTab(tab, true),
      image_base64: image.data,
      viewport: {
        width: metrics.visualViewport?.clientWidth ?? null,
        height: metrics.visualViewport?.clientHeight ?? null,
        scale: metrics.visualViewport?.scale ?? 1,
      },
      captured_at: new Date().toISOString(),
    };
  } finally {
    await detach(tab.id);
  }
}

async function startRecording(args = {}) {
  if (currentRecording) {
    throw new Error(`已有录制任务正在运行：${currentRecording.id}`);
  }
  const recordingId = String(args.recording_id || "").trim();
  if (!recordingId) throw new Error("缺少 recording_id");
  const tab = await resolveTargetTab(args.tab_id);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await attach(tab.id);

  const recording = {
    id: recordingId,
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title || "未命名页面",
    url: tab.url,
    mode: "screencast",
    startedAt: Date.now(),
    lastFrameAt: Date.now(),
    screencastStartedAt: null,
    screencastFrameTimes: [],
    fallbackBusy: false,
    fallbackSwitching: false,
    stopping: false,
    stopPromise: null,
  };
  currentRecording = recording;

  try {
    await sendCdp(tab.id, "Page.enable");
    const initial = await sendCdp(tab.id, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 90,
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    });
    sendRecordingEvent("frame", {
      recording_id: recording.id,
      data: initial.data,
      at_ms: Date.now(),
      source: "initial",
    });
    await sendCdp(tab.id, "Page.startScreencast", {
      format: "jpeg",
      quality: 90,
      maxWidth: 1920,
      maxHeight: 1080,
      everyNthFrame: 1,
    });
    recording.screencastStartedAt = Date.now();
  } catch (error) {
    currentRecording = null;
    await detach(tab.id);
    throw error;
  }

  recording.watchdogTimer = setInterval(() => {
    if (currentRecording?.id !== recording.id || recording.mode !== "screencast") return;
    const now = Date.now();
    const stalled = now - recording.lastFrameAt >= SCREENCAST_STALL_MS;
    const sampleElapsed = now - recording.screencastStartedAt;
    const sampledFps =
      sampleElapsed > 0 ? (recording.screencastFrameTimes.length * 1000) / sampleElapsed : 0;
    const belowTarget = sampleElapsed >= SCREENCAST_FPS_SAMPLE_MS && sampledFps < TARGET_SOURCE_FPS;
    if (stalled || belowTarget) {
      const warning = stalled
        ? "页面帧流停顿，已自动切换到兼容录制模式"
        : `页面帧流约 ${sampledFps.toFixed(1)} fps，低于 ${TARGET_SOURCE_FPS} fps 目标，已自动切换到兼容录制模式`;
      switchToFallback(recording, warning).catch((error) =>
        autoStopRecording("fallback_failed", errorMessage(error)),
      );
    }
  }, 500);
  const maxSeconds = Math.min(1800, Math.max(1, Number(args.max_duration_seconds) || 1800));
  recording.maxTimer = setTimeout(
    () => autoStopRecording("max_duration", `达到 ${maxSeconds} 秒录制上限`),
    maxSeconds * 1000,
  );

  return {
    recording_id: recording.id,
    tab: publicTab(tab, true),
    mode: recording.mode,
    max_duration_seconds: maxSeconds,
    started_at: new Date(recording.startedAt).toISOString(),
  };
}

async function executeBrowserCommand(method, args = {}) {
  switch (method) {
    case "list_capture_tabs":
      return { tabs: await getAllowedTabs(), allowlist: await getAllowlist() };
    case "capture_screenshot":
      return captureScreenshot(args);
    case "start_recording":
      return startRecording(args);
    case "stop_recording":
      if (args.recording_id && currentRecording?.id !== args.recording_id) {
        throw new Error(`当前录制任务不是 ${args.recording_id}`);
      }
      return stopRecordingInternal("user_stopped");
    case "get_extension_status":
      return {
        connected: true,
        recording: currentRecording
          ? {
              recording_id: currentRecording.id,
              tab_id: currentRecording.tabId,
              title: currentRecording.title,
              url: currentRecording.url,
              mode: currentRecording.mode,
              started_at: new Date(currentRecording.startedAt).toISOString(),
            }
          : null,
        allowlist: await getAllowlist(),
      };
    default:
      throw new Error(`扩展不支持的命令：${method}`);
  }
}

function rejectPopupRequests(message) {
  for (const { sendResponse, timer } of popupRequests.values()) {
    clearTimeout(timer);
    sendResponse({ ok: false, error: message });
  }
  popupRequests.clear();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNativeHost();
  }, 1200);
}

function connectNativeHost() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener(async (message) => {
      if (message?.kind === "browser_command") {
        try {
          const result = await executeBrowserCommand(message.method, message.args || {});
          port.postMessage({ kind: "browser_response", id: message.id, ok: true, result });
        } catch (error) {
          port.postMessage({
            kind: "browser_response",
            id: message.id,
            ok: false,
            error: errorMessage(error),
          });
        }
        return;
      }
      if (message?.kind === "popup_response") {
        const pending = popupRequests.get(message.request_id);
        if (!pending) return;
        popupRequests.delete(message.request_id);
        clearTimeout(pending.timer);
        pending.sendResponse(
          message.ok
            ? { ok: true, result: message.result }
            : { ok: false, error: message.error || "操作失败" },
        );
      }
    });
    port.onDisconnect.addListener(() => {
      const disconnected = nativePort === port;
      if (disconnected) nativePort = null;
      rejectPopupRequests(chrome.runtime.lastError?.message || "本地保存组件已断开");
      if (currentRecording) {
        stopRecordingInternal("native_host_disconnected").catch(() => {});
      }
      scheduleReconnect();
    });
  } catch {
    nativePort = null;
    scheduleReconnect();
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "popup_request") return false;
  if (!nativePort) {
    sendResponse({ ok: false, error: "本地保存组件未连接，请运行安装或健康检查" });
    return false;
  }
  const requestId = crypto.randomUUID();
  const timer = setTimeout(() => {
    const pending = popupRequests.get(requestId);
    if (!pending) return;
    popupRequests.delete(requestId);
    pending.sendResponse({ ok: false, error: "操作超时" });
  }, POPUP_TIMEOUT_MS);
  popupRequests.set(requestId, { sendResponse, timer });
  nativePort.postMessage({
    kind: "popup_request",
    request_id: requestId,
    method: message.method,
    args: message.args || {},
  });
  return true;
});

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const recording = currentRecording;
  if (!recording || source.tabId !== recording.tabId) return;
  if (method === "Page.screencastFrame") {
    try {
      await sendCdp(recording.tabId, "Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
    } catch {
      // Stop handling below will surface a persistent debugger failure.
    }
    if (recording.mode !== "screencast" || recording.stopping) return;
    recording.lastFrameAt = Date.now();
    recording.screencastFrameTimes.push(recording.lastFrameAt);
    sendRecordingEvent("frame", {
      recording_id: recording.id,
      data: params.data,
      at_ms: recording.lastFrameAt,
      source: "screencast",
    });
    return;
  }
  if (method === "Page.screencastVisibilityChanged") {
    params.visible ? cancelBackgroundStop() : scheduleBackgroundStop();
  }
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!currentRecording || source.tabId !== currentRecording.tabId || currentRecording.stopping) {
    return;
  }
  const recording = currentRecording;
  clearRecordingTimers(recording);
  currentRecording = null;
  sendRecordingEvent("auto_stopped", {
    recording_id: recording.id,
    result: {
      recording_id: recording.id,
      tab_id: recording.tabId,
      title: recording.title,
      url: recording.url,
      reason: "debugger_detached",
      detail: reason,
      mode: recording.mode,
      ended_at: new Date().toISOString(),
    },
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (!currentRecording) return;
  tabId === currentRecording.tabId ? cancelBackgroundStop() : scheduleBackgroundStop();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!currentRecording) return;
  windowId === currentRecording.windowId ? cancelBackgroundStop() : scheduleBackgroundStop();
});

chrome.runtime.onStartup.addListener(connectNativeHost);
chrome.runtime.onInstalled.addListener(connectNativeHost);
connectNativeHost();
