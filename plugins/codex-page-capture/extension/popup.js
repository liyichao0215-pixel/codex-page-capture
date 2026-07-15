import { DEFAULT_ALLOWLIST, normalizeAllowlist } from "./shared.js";

const $ = (id) => document.getElementById(id);

async function callHost(method, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: "popup_request", method, args });
  if (!response?.ok) throw new Error(response?.error || "本地组件没有响应");
  return response.result;
}

function setMessage(text, isError = false) {
  $("message").textContent = text || "";
  $("message").style.color = isError ? "#a43737" : "#106c43";
}

async function refresh() {
  try {
    const [status, tabs, stored] = await Promise.all([
      callHost("get_capture_status"),
      callHost("list_capture_tabs"),
      chrome.storage.local.get(["allowlist"]),
    ]);
    $("status").textContent = status.recording ? "录制中" : "已连接";
    $("status").className = "status ok";
    $("output-dir").value = status.default_output_directory || "";
    const current = tabs.tabs?.find((tab) => tab.active) || tabs.tabs?.[0];
    $("current-tab").textContent = current ? current.title : "当前页面不在允许范围内";
    $("allowlist").value = normalizeAllowlist(stored.allowlist || DEFAULT_ALLOWLIST).join("\n");
    $("start").disabled = Boolean(status.recording);
    $("stop").disabled = !status.recording;
  } catch (error) {
    $("status").textContent = "未连接";
    $("status").className = "status error";
    setMessage(error.message, true);
  }
}

async function run(method, args = {}) {
  setMessage("处理中…");
  try {
    const result = await callHost(method, args);
    setMessage(result.path ? `已保存：${result.path}` : "操作完成");
  } catch (error) {
    setMessage(error.message, true);
  } finally {
    await refresh();
  }
}

$("screenshot").addEventListener("click", () => run("capture_screenshot"));
$("start").addEventListener("click", () => run("start_recording"));
$("stop").addEventListener("click", () => run("stop_recording"));
$("save-dir").addEventListener("click", () =>
  run("set_default_output_directory", { path: $("output-dir").value }),
);
$("save-allowlist").addEventListener("click", async () => {
  const allowlist = normalizeAllowlist($("allowlist").value.split(/\r?\n/));
  await chrome.storage.local.set({ allowlist });
  setMessage("网站范围已保存");
  await refresh();
});

refresh();
