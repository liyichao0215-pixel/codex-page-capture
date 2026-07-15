# Codex 页面截图录屏

适用于 macOS 的本地 Chrome + Codex 插件。它可以让 Codex 截取 FlovaAI 标签页的可见页面，或录制无声 H.264 MP4。

## 默认行为

- 默认网站：`https://www.flova.ai/*`
- 默认目录：`~/Pictures/Codex Captures/YYYY-MM-DD/`
- 截图：PNG，只含网页可见区域
- 录屏：无声 H.264 MP4，最长 30 分钟
- 保存路径仅允许位于当前用户目录或 `/Volumes`
- 不上传、不遥测、不读取 Cookie、历史记录或网络请求

## 安装

运行：

```bash
./scripts/install.sh
```

然后在 Chrome 的 `chrome://extensions/`：

1. 打开“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择本插件的 `extension` 文件夹。
4. 确认扩展显示的 ID 是 `eholiclneibhdgcdoaecbpbcaephipcg`。

重启 Codex，并在新任务中调用插件工具。

## 本地检查

```bash
node --test tests/*.test.mjs
node --check extension/service-worker.js
node --check native/native-host.mjs
node scripts/health-check.mjs
```

## 卸载

```bash
node scripts/uninstall.mjs
codex plugin remove codex-page-capture@personal
```

卸载不会删除已经保存的截图或视频。
