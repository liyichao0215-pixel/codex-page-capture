import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
async function locateFfmpeg() {
  const candidates = [
    process.env.CODEX_PAGE_CAPTURE_FFMPEG,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

const ffmpeg = await locateFfmpeg();

function nativeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

async function socketRequest(socketPath, method, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const id = `${method}-${Date.now()}`;
    const lines = readline.createInterface({ input: socket, crlfDelay: Infinity });
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, args })}\n`));
    socket.once("error", reject);
    lines.once("line", (line) => {
      const response = JSON.parse(line);
      socket.destroy();
      response.ok ? resolve(response.result) : reject(new Error(response.error));
    });
  });
}

test("Native Host saves PNG and encodes a timed H.264 MP4", { timeout: 20_000, skip: !ffmpeg }, async (t) => {
  const home = await mkdtemp("/private/tmp/cpc-home-");
  const fixtureDir = path.join(home, "fixtures");
  const outputDir = path.join(home, "captures");
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  const pngPath = path.join(fixtureDir, "page.png");
  const jpegPath = path.join(fixtureDir, "frame.jpg");
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x6d5ef6:s=320x240:d=0.1",
    "-frames:v",
    "1",
    pngPath,
  ]);
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x6d5ef6:s=320x240:d=0.1",
    "-frames:v",
    "1",
    jpegPath,
  ]);
  const pngBase64 = (await readFile(pngPath)).toString("base64");
  const jpegBase64 = (await readFile(jpegPath)).toString("base64");

  const child = spawn(process.execPath, [path.join(root, "native", "native-host.mjs")], {
    env: {
      ...process.env,
      HOME: home,
      CODEX_PAGE_CAPTURE_FFMPEG: ffmpeg,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(async () => {
    child.stdin.end();
    child.kill("SIGTERM");
    await rm(home, { recursive: true, force: true });
  });
  const socketPath = path.join(home, "Library", "Application Support", "CodexPageCapture", "bridge.sock");

  let stdoutBuffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
    while (stdoutBuffer.length >= 4) {
      const length = stdoutBuffer.readUInt32LE(0);
      if (stdoutBuffer.length < length + 4) return;
      const message = JSON.parse(stdoutBuffer.subarray(4, length + 4).toString("utf8"));
      stdoutBuffer = stdoutBuffer.subarray(length + 4);
      if (message.kind !== "browser_command") continue;
      const base = { kind: "browser_response", id: message.id, ok: true };
      if (message.method === "capture_screenshot") {
        child.stdin.write(
          nativeFrame({
            ...base,
            result: {
              tab: { tab_id: 7, title: "Flova 测试页", url: "https://www.flova.ai/test", active: true },
              image_base64: pngBase64,
              captured_at: new Date().toISOString(),
            },
          }),
        );
      } else if (message.method === "start_recording") {
        child.stdin.write(
          nativeFrame({
            kind: "recording_event",
            type: "frame",
            recording_id: message.args.recording_id,
            data: jpegBase64,
            at_ms: Date.now(),
            source: "initial",
          }),
        );
        child.stdin.write(
          nativeFrame({
            ...base,
            result: {
              recording_id: message.args.recording_id,
              tab: { tab_id: 7, title: "Flova 测试页", url: "https://www.flova.ai/test", active: true },
              mode: "screencast",
              started_at: new Date().toISOString(),
            },
          }),
        );
      } else if (message.method === "stop_recording") {
        child.stdin.write(
          nativeFrame({
            kind: "recording_event",
            type: "frame",
            recording_id: message.args.recording_id,
            data: jpegBase64,
            at_ms: Date.now(),
            source: "screencast",
          }),
        );
        child.stdin.write(
          nativeFrame({
            ...base,
            result: { recording_id: message.args.recording_id, reason: "user_stopped" },
          }),
        );
      } else if (message.method === "get_extension_status") {
        child.stdin.write(nativeFrame({ ...base, result: { connected: true, recording: null } }));
      } else {
        child.stdin.write(nativeFrame({ ...base, result: {} }));
      }
    }
  });

  const socketDeadline = Date.now() + 4000;
  while (Date.now() < socketDeadline) {
    try {
      await stat(socketPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const screenshot = await socketRequest(socketPath, "capture_screenshot", { output_dir: outputDir });
  assert.equal(screenshot.width, 320);
  assert.equal(screenshot.height, 240);
  assert.equal((await stat(screenshot.path)).size > 0, true);

  const recording = await socketRequest(socketPath, "record_for", {
    duration_seconds: 1,
    output_dir: outputDir,
  });
  assert.equal(recording.codec, "h264");
  assert.equal(recording.has_audio, false);
  assert.equal(recording.width, 320);
  assert.equal(recording.height, 240);
  assert.equal((await stat(recording.path)).size > 0, true);
});
