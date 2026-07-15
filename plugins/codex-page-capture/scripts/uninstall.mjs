import { rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_SUPPORT_DIR, SOCKET_PATH, TEMP_ROOT } from "../native/core.mjs";

const nativeManifestPath = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Google",
  "Chrome",
  "NativeMessagingHosts",
  "com.codex.page_capture.json",
);

await unlink(nativeManifestPath).catch(() => {});
await unlink(path.join(APP_SUPPORT_DIR, "native-host-launcher.sh")).catch(() => {});
await unlink(path.join(APP_SUPPORT_DIR, "mcp-server-launcher.sh")).catch(() => {});
await unlink(SOCKET_PATH).catch(() => {});
await rm(TEMP_ROOT, { recursive: true, force: true });

process.stdout.write(
  [
    "Native Host 已移除。",
    "请在 Chrome 扩展程序页面移除“Codex 页面截图录屏”。",
    "如需移除 Codex 插件，请运行：codex plugin remove codex-page-capture@personal",
    "已保存的截图、视频和默认目录设置没有被删除。",
  ].join("\n") + "\n",
);
