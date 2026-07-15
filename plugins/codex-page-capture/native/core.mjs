import { constants as fsConstants } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HOME_DIR = os.homedir();
export const APP_SUPPORT_DIR = path.join(
  HOME_DIR,
  "Library",
  "Application Support",
  "CodexPageCapture",
);
export const SETTINGS_PATH = path.join(APP_SUPPORT_DIR, "settings.json");
export const SOCKET_PATH = path.join(APP_SUPPORT_DIR, "bridge.sock");
export const TEMP_ROOT = path.join(APP_SUPPORT_DIR, "temp");
export const DEFAULT_OUTPUT_BASE = path.join(HOME_DIR, "Pictures", "Codex Captures");
export const MAX_RECORDING_SECONDS = 1800;

export function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function sanitizeTitle(value, fallback = "页面") {
  const cleaned = String(value || fallback)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/:\\]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

export function localDatePart(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTimePart(date = new Date()) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join("");
}

export function defaultFileName(kind, title, date = new Date()) {
  const suffix = kind === "screenshot" ? "screenshot.png" : "recording.mp4";
  return `${localTimePart(date)}_${sanitizeTitle(title)}_${suffix}`;
}

export function forceExtension(fileName, extension) {
  const safe = sanitizeTitle(path.basename(String(fileName || "")), `capture${extension}`);
  const parsed = path.parse(safe);
  return `${parsed.name || "capture"}${extension}`;
}

export function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isAllowedAbsolutePath(candidate) {
  if (!path.isAbsolute(candidate)) return false;
  const normalized = path.resolve(candidate);
  return isPathInside(HOME_DIR, normalized) || isPathInside("/Volumes", normalized);
}

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`无法找到路径的现有父目录：${candidate}`);
      current = parent;
    }
  }
}

export async function validateAndCreateDirectory(candidate) {
  if (!isNonEmptyString(candidate)) throw new Error("保存目录不能为空");
  const resolved = path.resolve(candidate.trim());
  if (!isAllowedAbsolutePath(resolved)) {
    throw new Error("保存目录必须位于当前用户目录或 /Volumes 外接磁盘下");
  }

  const ancestor = await nearestExistingAncestor(resolved);
  const realAncestor = await realpath(ancestor);
  if (!isAllowedAbsolutePath(realAncestor)) {
    throw new Error("保存目录通过符号链接指向了不允许的位置");
  }
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const realDirectory = await realpath(resolved);
  if (!isAllowedAbsolutePath(realDirectory)) {
    throw new Error("保存目录不在允许的位置");
  }
  await access(realDirectory, fsConstants.W_OK);
  return realDirectory;
}

export async function resolveOutputDirectory(settings, overridePath, date = new Date()) {
  if (isNonEmptyString(overridePath)) {
    return validateAndCreateDirectory(overridePath);
  }
  const base = isNonEmptyString(settings?.default_output_directory)
    ? settings.default_output_directory
    : DEFAULT_OUTPUT_BASE;
  return validateAndCreateDirectory(path.join(base, localDatePart(date)));
}

export async function uniqueFilePath(directory, requestedName) {
  const parsed = path.parse(requestedName);
  let candidate = path.join(directory, requestedName);
  let counter = 2;
  while (true) {
    try {
      await access(candidate);
      candidate = path.join(directory, `${parsed.name}-${counter}${parsed.ext}`);
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
}

export function parsePngDimensions(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error("Chrome 返回的截图不是有效 PNG");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

export function parseJpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error("录屏帧不是有效 JPEG");
  }
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + length + 2 > buffer.length) break;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += length + 2;
  }
  throw new Error("无法读取录屏帧尺寸");
}

export async function loadSettings() {
  await mkdir(APP_SUPPORT_DIR, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    return {
      default_output_directory: isNonEmptyString(parsed?.default_output_directory)
        ? parsed.default_output_directory
        : DEFAULT_OUTPUT_BASE,
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const defaults = { default_output_directory: DEFAULT_OUTPUT_BASE };
    await saveSettings(defaults);
    return defaults;
  }
}

export async function saveSettings(settings) {
  await mkdir(APP_SUPPORT_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${SETTINGS_PATH}.tmp-${process.pid}`;
  await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, SETTINGS_PATH);
}

export async function findFfmpeg() {
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "ffmpeg"));
  const candidates = [
    process.env.CODEX_PAGE_CAPTURE_FFMPEG,
    path.join(HOME_DIR, ".local", "bin", "ffmpeg"),
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    ...pathCandidates,
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue checking known locations.
    }
  }
  throw new Error("没有找到 FFmpeg，无法生成 MP4");
}
