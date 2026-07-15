import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  APP_SUPPORT_DIR,
  DEFAULT_OUTPUT_BASE,
  findFfmpeg,
  loadSettings,
  validateAndCreateDirectory,
} from "../native/core.mjs";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.join(rootDir, "extension");
const extensionManifestPath = path.join(extensionDir, "manifest.json");
const nativeHostPath = path.join(rootDir, "native", "native-host.mjs");
const mcpServerPath = path.join(rootDir, "mcp", "server.mjs");
const launcherPath = path.join(APP_SUPPORT_DIR, "native-host-launcher.sh");
const mcpLauncherPath = path.join(APP_SUPPORT_DIR, "mcp-server-launcher.sh");
const nativeManifestDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
);
const nativeManifestPath = path.join(nativeManifestDir, "com.codex.page_capture.json");

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest]
    .map((byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`)
    .join("");
}

async function atomicJson(filePath, payload) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function writeLauncher(targetPath, entryPath) {
  await writeFile(
    targetPath,
    [
      "#!/bin/zsh",
      "set -euo pipefail",
      "",
      `exec ${shellQuote(process.execPath)} ${shellQuote(entryPath)}`,
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  await chmod(targetPath, 0o755);
}

const extensionManifest = JSON.parse(await readFile(extensionManifestPath, "utf8"));
const extensionId = extensionIdFromKey(extensionManifest.key);
if (extensionId !== "eholiclneibhdgcdoaecbpbcaephipcg") {
  throw new Error(`扩展 ID 校验失败：${extensionId}`);
}

await mkdir(APP_SUPPORT_DIR, { recursive: true, mode: 0o700 });
await mkdir(nativeManifestDir, { recursive: true, mode: 0o700 });
await writeLauncher(launcherPath, nativeHostPath);
await writeLauncher(mcpLauncherPath, mcpServerPath);
await validateAndCreateDirectory(DEFAULT_OUTPUT_BASE);
await loadSettings();
const ffmpeg = await findFfmpeg();

await atomicJson(nativeManifestPath, {
  name: "com.codex.page_capture",
  description: "Local save and H.264 encoding bridge for Codex Page Capture",
  path: launcherPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
});

const shouldOpen = !process.argv.includes("--no-open");
if (shouldOpen) {
  await execFileAsync("open", ["-a", "Google Chrome", "chrome://extensions/"]).catch(() => {});
}

process.stdout.write(
  [
    "Codex 页面截图录屏的本地组件已安装。",
    `Chrome 扩展目录：${extensionDir}`,
    `固定扩展 ID：${extensionId}`,
    `Native Host：${nativeManifestPath}`,
    `Codex MCP 启动器：${mcpLauncherPath}`,
    `FFmpeg：${ffmpeg}`,
    `默认输出：${DEFAULT_OUTPUT_BASE}`,
    "",
    "请在 Chrome 扩展程序页面打开开发者模式，点击“加载已解压的扩展程序”，选择上面的 extension 目录。",
  ].join("\n") + "\n",
);
