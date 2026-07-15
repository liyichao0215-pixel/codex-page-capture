export const DEFAULT_ALLOWLIST = ["https://www.flova.ai/*"];

export function normalizeAllowlist(value) {
  const items = Array.isArray(value) ? value : [];
  const normalized = items
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .filter((item) => /^https?:\/\/[A-Za-z0-9.*_-]+\/.+$/.test(item));
  return [...new Set(normalized.length ? normalized : DEFAULT_ALLOWLIST)];
}

export function matchesPattern(url, pattern) {
  try {
    const parsed = new URL(url);
    const match = pattern.match(/^(https?):\/\/([^/]+)(\/.*)$/);
    if (!match || parsed.protocol !== `${match[1]}:`) return false;
    const hostPattern = match[2].toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const hostMatches = hostPattern.startsWith("*.")
      ? host === hostPattern.slice(2) || host.endsWith(`.${hostPattern.slice(2)}`)
      : host === hostPattern;
    if (!hostMatches) return false;
    const pathPattern = match[3];
    if (pathPattern === "/*") return true;
    const escaped = pathPattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }
}

export function isAllowedUrl(url, allowlist = DEFAULT_ALLOWLIST) {
  return normalizeAllowlist(allowlist).some((pattern) => matchesPattern(url, pattern));
}

export function publicTab(tab, active = false) {
  return {
    tab_id: tab.id,
    title: tab.title || "未命名页面",
    url: tab.url,
    active: Boolean(active || tab.active),
    window_id: tab.windowId,
  };
}
