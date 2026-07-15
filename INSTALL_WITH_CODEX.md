# 发给 Codex 的自动部署提示词

把下面整段原样复制到同事电脑上的 Codex：

```text
请在我的这台 Mac 上安装并验证 Codex Page Capture：
https://github.com/liyichao0215-pixel/codex-page-capture

目标：让我在 Codex 里直接截取和无声录制当前 Chrome 的 FlovaAI 页面，只采集网页可见区域，并保存 PNG 或 H.264 MP4 到本机。

请直接执行，不要只给我安装说明。遵守以下要求：

1. 先确认系统是 macOS，并确认已安装 Google Chrome、Git、Node.js 20+、FFmpeg 和支持插件的 Codex。缺少依赖时：
   - 优先使用当前机器已有的程序。
   - 如果 Homebrew 已安装，可用它安装缺少的 Node.js 或 FFmpeg。
   - 如果安装系统依赖需要我的授权，明确告诉我将安装什么并等我确认，不要静默改变其他配置。

2. 将仓库克隆到 `~/codex-page-capture`；如果目录已经存在，就检查远程地址并安全更新，保留用户自己的修改，不要强制覆盖。

3. 在仓库根目录完成本地组件安装：
   `./plugins/codex-page-capture/scripts/install.sh --no-open`

4. 把仓库注册为 Codex 插件市场并安装插件：
   `codex plugin marketplace add ~/codex-page-capture`
   `codex plugin add codex-page-capture@liyichao-tools`
   如果已经安装，则安全升级或重装到仓库当前版本，不要制造重复市场配置。

5. 打开 Chrome 的 `chrome://extensions/`，开启开发者模式，加载这个未打包扩展目录：
   `~/codex-page-capture/plugins/codex-page-capture/extension`
   确认扩展名称是“Codex 页面截图录屏”，扩展 ID 必须是：
   `eholiclneibhdgcdoaecbpbcaephipcg`
   如果你无法替我完成 Chrome 的这一步，就把页面打开并只让我完成必要的点击，然后继续验证。

6. 保持 Chrome 打开，在前台打开一个 `https://www.flova.ai/` 页面，运行：
   `node ~/codex-page-capture/plugins/codex-page-capture/scripts/health-check.mjs`
   健康检查中“Chrome 实时连接”也必须通过。若失败，请实际排查 Native Host、扩展 ID、扩展是否启用、Chrome 是否需要重启和 FFmpeg 路径，不要在未通过时宣称完成。

7. 告诉我需要重启 Codex 并新建任务，才能让新 MCP 工具出现。重启后验证工具至少包含：
   `list_capture_tabs`
   `capture_screenshot`
   `start_recording`
   `stop_recording`
   `record_for`
   `get_capture_status`
   `set_default_output_directory`

8. 最后做一次真实验收：列出 FlovaAI 标签页并截取当前页，把 PNG 直接展示给我；再录制 5 秒，确认 MP4 为 H.264、无音轨且能正常打开，并把两个绝对保存路径告诉我。

安全边界：不要扩大网站白名单，不要上传任何页面或采集文件，不要读取 Cookie、浏览历史、网络请求或表单数据，不要修改无关的 Chrome 扩展或 Codex 插件。
```
