import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server initializes and exposes the planned tools", async (t) => {
  const child = spawn(process.execPath, [path.join(root, "mcp", "server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const responses = [];
  lines.on("line", (line) => responses.push(JSON.parse(line)));

  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

  const deadline = Date.now() + 3000;
  while (responses.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(responses[0].result.serverInfo.name, "Codex Page Capture");
  const names = responses[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [
    "list_capture_tabs",
    "capture_screenshot",
    "start_recording",
    "stop_recording",
    "record_for",
    "get_capture_status",
    "set_default_output_directory",
  ]);
});
