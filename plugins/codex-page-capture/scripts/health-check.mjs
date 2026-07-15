import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invokeBridge } from "../mcp/bridge-client.mjs";
import {
  APP_SUPPORT_DIR,
  DEFAULT_OUTPUT_BASE,
  SETTINGS_PATH,
  findFfmpeg,
  loadSettings,
} from "../native/core.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeManifestPath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
  "com.codex.page_capture.json",
);
const checks = [];

async function check(name, action, waiting = false) {
  try {
    const detail = await action();
    checks.push({ name, status: "ok", detail });
  } catch (error) {
    checks.push({ name, status: waiting ? "waiting" : "error", detail: error?.message || String(error) });
  }
}

await check("Chrome 扩展文件", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(rootDir, "extension", "manifest.json"), "utf8"),
  );
  if (manifest.name !== "Codex 页面截图录屏") throw new Error("扩展 manifest 不匹配");
  return manifest.version;
});
await check("Native Host 配置", async () => {
  const manifest = JSON.parse(await readFile(nativeManifestPath, "utf8"));
  await access(manifest.path);
  return manifest.path;
});
await check("Codex MCP 启动器", async () => {
  const launcher = path.join(APP_SUPPORT_DIR, "mcp-server-launcher.sh");
  await access(launcher);
  return launcher;
});
await check("FFmpeg", findFfmpeg);
await check("保存设置", async () => {
  const settings = await loadSettings();
  const directory = settings.default_output_directory || DEFAULT_OUTPUT_BASE;
  const info = await stat(directory);
  if (!info.isDirectory()) throw new Error("默认输出位置不是目录");
  return `${SETTINGS_PATH} -> ${directory}`;
});
await check(
  "Chrome 实时连接",
  async () => {
    const status = await invokeBridge("get_capture_status", {}, 4000);
    if (!status.extension_connected) throw new Error(status.extension_error || "扩展未连接");
    return status.recording ? `已连接，录制中 ${status.recording.recording_id}` : "已连接，空闲";
  },
  true,
);

for (const item of checks) {
  const mark = item.status === "ok" ? "✓" : item.status === "waiting" ? "○" : "✗";
  process.stdout.write(`${mark} ${item.name}：${item.detail}\n`);
}

const errors = checks.filter((item) => item.status === "error");
if (errors.length) process.exitCode = 1;
