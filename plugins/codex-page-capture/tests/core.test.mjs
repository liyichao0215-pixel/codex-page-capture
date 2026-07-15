import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  defaultFileName,
  forceExtension,
  isAllowedAbsolutePath,
  parsePngDimensions,
  sanitizeTitle,
  uniqueFilePath,
  validateAndCreateDirectory,
} from "../native/core.mjs";

test("sanitizes capture filenames without losing Chinese", () => {
  assert.equal(sanitizeTitle("  Flova / 项目：测试  "), "Flova - 项目：测试");
  assert.equal(forceExtension("我的截图.jpeg", ".png"), "我的截图.png");
  assert.match(defaultFileName("screenshot", "项目页", new Date(2026, 6, 14, 9, 8, 7)), /^090807_项目页_screenshot\.png$/);
});

test("allows only user and volume paths", () => {
  assert.equal(isAllowedAbsolutePath(path.join(os.homedir(), "Pictures", "x")), true);
  assert.equal(isAllowedAbsolutePath("/Volumes/Test/x"), true);
  assert.equal(isAllowedAbsolutePath("/tmp/x"), false);
  assert.equal(isAllowedAbsolutePath("relative/x"), false);
});

test("creates safe output directory and avoids duplicate files", async () => {
  const root = path.join(os.homedir(), ".codex-page-capture-test", String(process.pid));
  await rm(root, { recursive: true, force: true });
  const directory = await validateAndCreateDirectory(path.join(root, "nested"));
  await writeFile(path.join(directory, "capture.png"), "one");
  const unique = await uniqueFilePath(directory, "capture.png");
  assert.equal(path.basename(unique), "capture-2.png");
  assert.equal(await readFile(path.join(directory, "capture.png"), "utf8"), "one");
  await rm(root, { recursive: true, force: true });
});

test("parses PNG dimensions", () => {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  assert.deepEqual(parsePngDimensions(png), { width: 1920, height: 1080 });
});

test("rejects unsafe output directory", async () => {
  await assert.rejects(() => validateAndCreateDirectory("/tmp/codex-capture"), /用户目录|Volumes/);
});
