import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ALLOWLIST,
  isAllowedUrl,
  matchesPattern,
  normalizeAllowlist,
} from "../extension/shared.js";

test("uses FlovaAI as the default allowlist", () => {
  assert.deepEqual(normalizeAllowlist([]), DEFAULT_ALLOWLIST);
  assert.equal(isAllowedUrl("https://www.flova.ai/en/project/123"), true);
  assert.equal(isAllowedUrl("https://service.flova.ai/api"), false);
  assert.equal(isAllowedUrl("chrome://extensions/"), false);
});

test("supports explicit subdomain patterns", () => {
  assert.equal(matchesPattern("https://app.example.com/a", "https://*.example.com/*"), true);
  assert.equal(matchesPattern("https://example.com/a", "https://*.example.com/*"), true);
  assert.equal(matchesPattern("http://example.com/a", "https://*.example.com/*"), false);
});

test("drops invalid patterns and deduplicates valid patterns", () => {
  assert.deepEqual(
    normalizeAllowlist(["javascript:*", "https://www.flova.ai/*", "https://www.flova.ai/*"]),
    ["https://www.flova.ai/*"],
  );
});
