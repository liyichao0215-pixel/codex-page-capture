import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import {
  APP_SUPPORT_DIR,
  DEFAULT_OUTPUT_BASE,
  MAX_RECORDING_SECONDS,
  SOCKET_PATH,
  TEMP_ROOT,
  defaultFileName,
  findFfmpeg,
  forceExtension,
  isNonEmptyString,
  loadSettings,
  parseJpegDimensions,
  parsePngDimensions,
  resolveOutputDirectory,
  sanitizeTitle,
  saveSettings,
  uniqueFilePath,
  validateAndCreateDirectory,
} from "./core.mjs";

const BROWSER_TIMEOUT_MS = 30_000;
const MAX_NATIVE_MESSAGE_BYTES = 256 * 1024 * 1024;
const OUTPUT_FPS = 30;
const pendingBrowserRequests = new Map();
const recordings = new Map();
let activeRecordingId = null;
let browserRequestSequence = 1;
let inputBuffer = Buffer.alloc(0);
let settings = await loadSettings();

function log(message) {
  process.stderr.write(`[codex-page-capture] ${message}\n`);
}

function errorMessage(error) {
  return error?.message || String(error || "未知错误");
}

function sendNative(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

function callBrowser(method, args = {}, timeoutMs = BROWSER_TIMEOUT_MS) {
  const id = `browser-${browserRequestSequence++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingBrowserRequests.delete(id);
      reject(new Error(`Chrome 命令超时：${method}`));
    }, timeoutMs);
    pendingBrowserRequests.set(id, { resolve, reject, timer });
    sendNative({ kind: "browser_command", id, method, args });
  });
}

function createCompletion() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function reserveUniquePath(directory, requestedName) {
  let candidate = await uniqueFilePath(directory, requestedName);
  while (true) {
    try {
      const handle = await open(candidate, "wx", 0o600);
      await handle.close();
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      candidate = await uniqueFilePath(directory, path.basename(candidate));
    }
  }
}

async function saveScreenshot(args = {}) {
  const browserResult = await callBrowser("capture_screenshot", {
    tab_id: Number.isInteger(args.tab_id) ? args.tab_id : undefined,
  });
  const bytes = Buffer.from(browserResult.image_base64 || "", "base64");
  const dimensions = parsePngDimensions(bytes);
  const directory = await resolveOutputDirectory(settings, args.output_dir);
  const requestedName = isNonEmptyString(args.filename)
    ? forceExtension(args.filename, ".png")
    : defaultFileName("screenshot", browserResult.tab?.title);
  const outputPath = await uniqueFilePath(directory, requestedName);
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: outputPath,
    format: "png",
    width: dimensions.width,
    height: dimensions.height,
    size_bytes: bytes.length,
    tab_id: browserResult.tab?.tab_id,
    title: browserResult.tab?.title,
    url: browserResult.tab?.url,
    captured_at: browserResult.captured_at,
    warnings: [],
  };
}

function queueFrameWrite(session, event) {
  if (session.finalizing || !isNonEmptyString(event.data)) return;
  const index = session.nextFrameIndex++;
  const framePath = path.join(session.tempDir, `frame-${String(index).padStart(7, "0")}.jpg`);
  const frame = {
    path: framePath,
    atMs: Number.isFinite(event.at_ms) ? event.at_ms : Date.now(),
    source: event.source || "unknown",
  };
  session.frameQueue = session.frameQueue
    .then(async () => {
      const bytes = Buffer.from(event.data, "base64");
      parseJpegDimensions(bytes);
      await writeFile(framePath, bytes, { mode: 0o600 });
      session.frames.push(frame);
    })
    .catch((error) => {
      session.frameError = error;
    });
}

function ffconcatQuote(filePath) {
  return `'${filePath.replace(/'/g, "'\\''")}'`;
}

async function encodeRecording(session, endedAtMs) {
  await session.frameQueue;
  if (session.frameError) throw session.frameError;
  const frames = [...session.frames].sort((a, b) => a.atMs - b.atMs);
  if (frames.length === 0) throw new Error("没有收到可编码的页面帧");

  const durationSeconds = Math.max(1 / OUTPUT_FPS, (endedAtMs - session.startedAtMs) / 1000);
  const sourceFps = frames.length / durationSeconds;
  if (durationSeconds >= 3 && frames.length > 1 && sourceFps < 8) {
    throw new Error(`有效页面帧率只有 ${sourceFps.toFixed(1)} fps，低于 8 fps 质量下限`);
  }
  if (sourceFps < 15 && frames.length > 1) {
    session.warnings.push(`有效页面帧率为 ${sourceFps.toFixed(1)} fps，低于 15 fps 目标`);
  }

  const firstBytes = await readFile(frames[0].path);
  const firstSize = parseJpegDimensions(firstBytes);
  const outputWidth = Math.max(2, Math.min(1920, firstSize.width) & ~1);
  const outputHeight = Math.max(2, Math.min(1080, firstSize.height) & ~1);
  const concatLines = ["ffconcat version 1.0"];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const nextAt = frames[index + 1]?.atMs ?? endedAtMs;
    const frameDuration = Math.max(1 / OUTPUT_FPS, (nextAt - frame.atMs) / 1000);
    concatLines.push(`file ${ffconcatQuote(frame.path)}`);
    concatLines.push(`duration ${frameDuration.toFixed(6)}`);
  }
  concatLines.push(`file ${ffconcatQuote(frames.at(-1).path)}`);
  const concatPath = path.join(session.tempDir, "frames.ffconcat");
  await writeFile(concatPath, `${concatLines.join("\n")}\n`, { mode: 0o600 });

  const ffmpeg = await findFfmpeg();
  const filter = [
    `scale=${outputWidth}:${outputHeight}:force_original_aspect_ratio=decrease`,
    `pad=${outputWidth}:${outputHeight}:(ow-iw)/2:(oh-ih)/2:black`,
  ].join(",");
  await new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatPath,
        "-vf",
        filter,
        "-r",
        String(OUTPUT_FPS),
        "-fps_mode",
        "cfr",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-an",
        session.outputPath,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg 编码失败 (${signal || code})：${stderr.trim()}`));
    });
  });

  const outputStat = await stat(session.outputPath);
  if (!outputStat.isFile() || outputStat.size === 0) throw new Error("MP4 输出文件为空");
  return {
    durationSeconds,
    sourceFps,
    width: outputWidth,
    height: outputHeight,
    sizeBytes: outputStat.size,
    frameCount: frames.length,
  };
}

async function finalizeRecording(session, stopInfo = {}) {
  if (session.finalizePromise) return session.finalizePromise;
  session.finalizing = true;
  clearTimeout(session.hostMaxTimer);
  session.finalizePromise = (async () => {
    const endedAtMs = Date.now();
    if (activeRecordingId === session.id) activeRecordingId = null;
    try {
      const encoded = await encodeRecording(session, endedAtMs);
      const reason = stopInfo.reason || "user_stopped";
      const partial = !["user_stopped", "timed_recording_completed", "max_duration"].includes(reason);
      if (partial) {
        session.warnings.push(stopInfo.detail || `录制因 ${reason} 提前结束`);
      }
      const result = {
        path: session.outputPath,
        format: "mp4",
        codec: "h264",
        has_audio: false,
        recording_id: session.id,
        duration_seconds: Number(encoded.durationSeconds.toFixed(3)),
        source_fps: Number(encoded.sourceFps.toFixed(2)),
        output_fps: OUTPUT_FPS,
        source_frames: encoded.frameCount,
        width: encoded.width,
        height: encoded.height,
        size_bytes: encoded.sizeBytes,
        tab_id: session.tabId,
        title: session.title,
        url: session.url,
        started_at: new Date(session.startedAtMs).toISOString(),
        ended_at: new Date(endedAtMs).toISOString(),
        partial,
        reason,
        warnings: [...new Set(session.warnings.filter(Boolean))],
      };
      await rm(session.tempDir, { recursive: true, force: true });
      recordings.delete(session.id);
      session.completion.resolve({ ok: true, result });
      return result;
    } catch (error) {
      await rm(session.outputPath, { force: true }).catch(() => {});
      await rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
      recordings.delete(session.id);
      session.completion.resolve({ ok: false, error: errorMessage(error) });
      throw error;
    }
  })();
  return session.finalizePromise;
}

async function startRecording(args = {}) {
  if (activeRecordingId) throw new Error(`已有录制任务正在运行：${activeRecordingId}`);
  await findFfmpeg();
  const maxDurationSeconds = Math.min(
    MAX_RECORDING_SECONDS,
    Math.max(1, Math.floor(Number(args.max_duration_seconds) || MAX_RECORDING_SECONDS)),
  );
  const directory = await resolveOutputDirectory(settings, args.output_dir);
  const titleForName = sanitizeTitle(args.title || "当前页面");
  const requestedName = isNonEmptyString(args.filename)
    ? forceExtension(args.filename, ".mp4")
    : defaultFileName("recording", titleForName);
  const outputPath = await reserveUniquePath(directory, requestedName);
  await mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(path.join(TEMP_ROOT, "recording-"));
  const id = randomUUID();
  const completion = createCompletion();
  const session = {
    id,
    outputPath,
    tempDir,
    tabId: null,
    title: titleForName,
    url: null,
    startedAtMs: Date.now(),
    nextFrameIndex: 1,
    frameQueue: Promise.resolve(),
    frameError: null,
    frames: [],
    warnings: [],
    finalizing: false,
    finalizePromise: null,
    completion,
    hostMaxTimer: null,
  };
  recordings.set(id, session);
  activeRecordingId = id;
  try {
    const browserResult = await callBrowser("start_recording", {
      recording_id: id,
      tab_id: Number.isInteger(args.tab_id) ? args.tab_id : undefined,
      max_duration_seconds: maxDurationSeconds,
    });
    session.tabId = browserResult.tab?.tab_id;
    session.title = browserResult.tab?.title || session.title;
    session.url = browserResult.tab?.url || null;
    session.startedAtMs = Date.parse(browserResult.started_at) || session.startedAtMs;
    if (!isNonEmptyString(args.filename) && !isNonEmptyString(args.title)) {
      const titledPath = await reserveUniquePath(
        directory,
        defaultFileName("recording", session.title),
      );
      await rm(session.outputPath, { force: true });
      session.outputPath = titledPath;
    }
    session.hostMaxTimer = setTimeout(async () => {
      if (session.finalizing) return;
      try {
        const stopped = await callBrowser("stop_recording", { recording_id: id });
        await finalizeRecording(session, {
          ...stopped,
          reason: "max_duration",
          detail: `达到 ${maxDurationSeconds} 秒录制上限`,
        });
      } catch (error) {
        await finalizeRecording(session, {
          reason: "max_duration",
          detail: errorMessage(error),
        }).catch((finalError) => log(errorMessage(finalError)));
      }
    }, (maxDurationSeconds + 1) * 1000);
    return {
      recording_id: id,
      planned_path: outputPath,
      tab_id: session.tabId,
      title: session.title,
      url: session.url,
      mode: browserResult.mode,
      max_duration_seconds: maxDurationSeconds,
      started_at: new Date(session.startedAtMs).toISOString(),
      warnings: [],
    };
  } catch (error) {
    activeRecordingId = null;
    recordings.delete(id);
    await rm(outputPath, { force: true });
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function stopRecording(args = {}, reasonOverride = null) {
  const id = isNonEmptyString(args.recording_id) ? args.recording_id : activeRecordingId;
  if (!id) throw new Error("当前没有正在录制的页面");
  const session = recordings.get(id);
  if (!session) throw new Error(`找不到录制任务：${id}`);
  if (session.finalizePromise) return session.finalizePromise;
  let stopped;
  try {
    stopped = await callBrowser("stop_recording", { recording_id: id });
  } catch (error) {
    session.warnings.push(`停止页面录制时收到提示：${errorMessage(error)}`);
    stopped = { recording_id: id, reason: "browser_stop_error", detail: errorMessage(error) };
  }
  if (reasonOverride) stopped.reason = reasonOverride;
  return finalizeRecording(session, stopped);
}

async function recordFor(args = {}) {
  const durationSeconds = Math.floor(Number(args.duration_seconds));
  if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_RECORDING_SECONDS) {
    throw new Error(`duration_seconds 必须是 1 到 ${MAX_RECORDING_SECONDS} 的整数`);
  }
  const started = await startRecording({
    ...args,
    max_duration_seconds: Math.min(MAX_RECORDING_SECONDS, durationSeconds + 5),
  });
  const session = recordings.get(started.recording_id);
  const timerResult = await Promise.race([
    new Promise((resolve) => setTimeout(() => resolve({ timer: true }), durationSeconds * 1000)),
    session.completion.promise,
  ]);
  if (timerResult?.timer) {
    return stopRecording({ recording_id: started.recording_id }, "timed_recording_completed");
  }
  if (timerResult.ok) return timerResult.result;
  throw new Error(timerResult.error);
}

async function getStatus() {
  let extensionStatus;
  try {
    extensionStatus = await callBrowser("get_extension_status", {}, 3000);
  } catch (error) {
    extensionStatus = { connected: false, error: errorMessage(error), recording: null };
  }
  const active = activeRecordingId ? recordings.get(activeRecordingId) : null;
  return {
    native_host_connected: true,
    extension_connected: Boolean(extensionStatus.connected),
    extension_error: extensionStatus.error || null,
    default_output_directory: settings.default_output_directory || DEFAULT_OUTPUT_BASE,
    allowed_output_roots: [process.env.HOME, "/Volumes"].filter(Boolean),
    allowlist: extensionStatus.allowlist || ["https://www.flova.ai/*"],
    recording: active
      ? {
          recording_id: active.id,
          planned_path: active.outputPath,
          tab_id: active.tabId,
          title: active.title,
          url: active.url,
          frames_received: active.frames.length,
          started_at: new Date(active.startedAtMs).toISOString(),
        }
      : null,
  };
}

async function invoke(method, args = {}) {
  switch (method) {
    case "list_capture_tabs":
      return callBrowser("list_capture_tabs");
    case "capture_screenshot":
      return saveScreenshot(args);
    case "start_recording":
      return startRecording(args);
    case "stop_recording":
      return stopRecording(args);
    case "record_for":
      return recordFor(args);
    case "get_capture_status":
      return getStatus();
    case "set_default_output_directory": {
      const directory = await validateAndCreateDirectory(args.path);
      settings = { ...settings, default_output_directory: directory };
      await saveSettings(settings);
      return { path: directory, default_output_directory: directory };
    }
    default:
      throw new Error(`未知命令：${method}`);
  }
}

function handleNativeMessage(message) {
  if (message?.kind === "browser_response") {
    const pending = pendingBrowserRequests.get(message.id);
    if (!pending) return;
    pendingBrowserRequests.delete(message.id);
    clearTimeout(pending.timer);
    message.ok ? pending.resolve(message.result) : pending.reject(new Error(message.error || "Chrome 操作失败"));
    return;
  }

  if (message?.kind === "recording_event") {
    const session = recordings.get(message.recording_id);
    if (!session) return;
    if (message.type === "frame") {
      queueFrameWrite(session, message);
    } else if (message.type === "mode_changed") {
      if (message.warning) session.warnings.push(message.warning);
    } else if (message.type === "auto_stopped") {
      const stopInfo = message.result || {
        reason: message.reason || "auto_stopped",
        detail: message.error || null,
      };
      finalizeRecording(session, stopInfo).catch((error) => log(errorMessage(error)));
    }
    return;
  }

  if (message?.kind === "popup_request") {
    invoke(message.method, message.args || {})
      .then((result) =>
        sendNative({
          kind: "popup_response",
          request_id: message.request_id,
          ok: true,
          result,
        }),
      )
      .catch((error) =>
        sendNative({
          kind: "popup_response",
          request_id: message.request_id,
          ok: false,
          error: errorMessage(error),
        }),
      );
  }
}

function consumeNativeInput(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (inputBuffer.length >= 4) {
    const messageLength = inputBuffer.readUInt32LE(0);
    if (messageLength <= 0 || messageLength > MAX_NATIVE_MESSAGE_BYTES) {
      throw new Error(`无效的 Native Messaging 消息长度：${messageLength}`);
    }
    if (inputBuffer.length < messageLength + 4) return;
    const body = inputBuffer.subarray(4, messageLength + 4);
    inputBuffer = inputBuffer.subarray(messageLength + 4);
    handleNativeMessage(JSON.parse(body.toString("utf8")));
  }
}

async function removeStaleSocket() {
  try {
    await stat(SOCKET_PATH);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const live = await new Promise((resolve) => {
    const socket = net.createConnection(SOCKET_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (live) throw new Error(`已有 Native Host 正在使用 ${SOCKET_PATH}`);
  await unlink(SOCKET_PATH).catch(() => {});
}

await mkdir(APP_SUPPORT_DIR, { recursive: true, mode: 0o700 });
await removeStaleSocket();

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch (error) {
      socket.write(`${JSON.stringify({ ok: false, error: errorMessage(error) })}\n`);
      return;
    }
    invoke(request.method, request.args || {})
      .then((result) =>
        socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`),
      )
      .catch((error) =>
        socket.write(
          `${JSON.stringify({ id: request.id, ok: false, error: errorMessage(error) })}\n`,
        ),
      );
  });
});

server.on("error", (error) => {
  log(`Unix Socket 失败：${errorMessage(error)}`);
  process.exitCode = 1;
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(SOCKET_PATH, resolve);
});
await chmod(SOCKET_PATH, 0o600);
log(`Native Host 已启动：${SOCKET_PATH}`);

process.stdin.on("data", (chunk) => {
  try {
    consumeNativeInput(chunk);
  } catch (error) {
    log(errorMessage(error));
    process.exitCode = 1;
  }
});

async function shutdown() {
  for (const pending of pendingBrowserRequests.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Native Host 已关闭"));
  }
  pendingBrowserRequests.clear();
  server.close();
  await unlink(SOCKET_PATH).catch(() => {});
}

process.stdin.on("end", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
