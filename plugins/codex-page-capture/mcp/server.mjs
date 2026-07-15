import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { invokeBridge } from "./bridge-client.mjs";

const SERVER_NAME = "Codex Page Capture";
const SERVER_VERSION = "0.1.1";
const JsonRpcError = { METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602 };

const commonTargetProperties = {
  tab_id: {
    type: "integer",
    description: "Optional exact tab_id returned by list_capture_tabs. Omit to use the active allowed tab.",
  },
  output_dir: {
    type: "string",
    description: "Optional absolute output directory under the user home directory or /Volumes.",
  },
  filename: {
    type: "string",
    description: "Optional output filename. The required .png or .mp4 extension is applied automatically.",
  },
};

const tools = [
  {
    name: "list_capture_tabs",
    title: "列出可采集的 Chrome 页面",
    description:
      "List Chrome tabs currently allowed for page screenshots and recordings. Use only when the active tab is ambiguous or the user asks for another tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "capture_screenshot",
    title: "截取页面 PNG",
    description:
      "Capture the visible webpage area of the active allowed Chrome tab, save a local PNG, and return its absolute path and preview.",
    inputSchema: {
      type: "object",
      properties: commonTargetProperties,
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "start_recording",
    title: "开始页面录屏",
    description:
      "Start one silent visible-page recording. Use stop_recording later. Only one recording may run at a time.",
    inputSchema: {
      type: "object",
      properties: {
        ...commonTargetProperties,
        max_duration_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 1800,
          default: 1800,
          description: "Automatic safety stop, at most 1800 seconds.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "stop_recording",
    title: "停止页面录屏",
    description: "Stop the active page recording, encode H.264 MP4, and return the completed local path.",
    inputSchema: {
      type: "object",
      properties: {
        recording_id: {
          type: "string",
          description: "Optional recording_id from start_recording. Omit to stop the only active recording.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "record_for",
    title: "定时页面录屏",
    description:
      "Record the active allowed Chrome page for an exact duration, then save and return a silent H.264 MP4 in one call.",
    inputSchema: {
      type: "object",
      properties: {
        duration_seconds: {
          type: "integer",
          minimum: 1,
          maximum: 1800,
          description: "Recording duration in whole seconds.",
        },
        ...commonTargetProperties,
      },
      required: ["duration_seconds"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "get_capture_status",
    title: "检查页面采集状态",
    description:
      "Check Chrome extension connection, output settings, allowlist, and the current recording without changing anything.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "set_default_output_directory",
    title: "设置默认保存目录",
    description:
      "Set the default base output directory. Date subfolders are created automatically for captures using the default.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Absolute writable directory under the user home directory or /Volumes.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function summaryFor(toolName, result) {
  switch (toolName) {
    case "list_capture_tabs":
      return result.tabs?.length
        ? `找到 ${result.tabs.length} 个可采集页面。`
        : "当前没有允许采集的 Chrome 页面。";
    case "capture_screenshot":
      return `截图已保存：${result.path}\n尺寸：${result.width}×${result.height}`;
    case "start_recording":
      return `已开始录制：${result.recording_id}\n计划保存：${result.planned_path}`;
    case "stop_recording":
    case "record_for":
      return `录屏已保存：${result.path}\n时长：${result.duration_seconds} 秒，${result.width}×${result.height}`;
    case "set_default_output_directory":
      return `默认保存目录已设置为：${result.default_output_directory}`;
    case "get_capture_status":
      return result.extension_connected
        ? result.recording
          ? `Chrome 扩展已连接，正在录制 ${result.recording.recording_id}。`
          : "Chrome 扩展已连接，当前没有录制任务。"
        : `Chrome 扩展未连接：${result.extension_error || "未知原因"}`;
    default:
      return JSON.stringify(result, null, 2);
  }
}

async function toolResult(toolName, result) {
  const content = [{ type: "text", text: summaryFor(toolName, result) }];
  if (toolName === "capture_screenshot" && result.path && result.size_bytes <= 8 * 1024 * 1024) {
    const bytes = await readFile(result.path);
    content.push({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" });
  }
  return { content, structuredContent: result };
}

async function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Capture only the user's allowed Chrome page pixels. Prefer the active tab, use record_for for fixed durations, and report success only when a completed absolute path is returned. Never broaden the website allowlist or claim a partial recording is complete without telling the user.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }
  if (method === "tools/call") {
    const toolName = params?.name;
    if (!tools.some((tool) => tool.name === toolName)) {
      sendError(id, JsonRpcError.INVALID_PARAMS, `Unknown tool: ${toolName || ""}`);
      return;
    }
    try {
      const result = await invokeBridge(toolName, params.arguments || {});
      sendResult(id, await toolResult(toolName, result));
    } catch (error) {
      sendResult(id, {
        content: [{ type: "text", text: error?.message || String(error) }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    Promise.resolve(handleRequest(message)).catch((error) => {
      if (message.id !== undefined) sendError(message.id, -32603, error?.message || String(error));
    });
  } catch (error) {
    sendError(null, -32700, error?.message || "Invalid JSON");
  }
});
