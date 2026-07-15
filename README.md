# Codex Page Capture

让 Codex 直接截取或录制当前 Chrome 中的 FlovaAI 页面。截图保存为 PNG，录屏保存为无声 H.264 MP4；只采集网页可见区域，不包含浏览器工具栏或桌面。

> 当前版本仅支持 macOS + Google Chrome，采用 Chrome 开发者模式加载扩展。

## 能做什么

- 列出当前允许采集的 FlovaAI 标签页
- 截取当前页面可见区域并保存 PNG
- 开始、停止或定时录制当前页面，输出 H.264 MP4
- 每次调用指定保存目录，或修改默认保存目录
- 页面内容和采集文件只保留在本机，不上传、不做遥测

默认保存到：

```text
~/Pictures/Codex Captures/YYYY-MM-DD/
```

## 系统要求

- macOS
- Google Chrome 116 或更高版本
- Codex 桌面版或带插件功能的 Codex CLI
- Node.js 20 或更高版本
- FFmpeg（建议通过 Homebrew 安装：`brew install ffmpeg`）
- Git

## 推荐安装方式：交给 Codex

复制 [INSTALL_WITH_CODEX.md](./INSTALL_WITH_CODEX.md) 里的完整提示词，发给同事电脑上的 Codex。Codex 会克隆仓库、检查依赖、安装本地组件和个人插件，并带着用户完成 Chrome 扩展加载。

## 手动安装

```bash
git clone https://github.com/liyichao0215-pixel/codex-page-capture.git
cd codex-page-capture

./plugins/codex-page-capture/scripts/install.sh

codex plugin marketplace add .
codex plugin add codex-page-capture@liyichao-tools
```

然后打开 `chrome://extensions/`：

1. 打开“开发者模式”。
2. 点击“加载已解压的扩展程序”。
3. 选择仓库中的 `plugins/codex-page-capture/extension` 文件夹。
4. 确认扩展 ID 是 `eholiclneibhdgcdoaecbpbcaephipcg`。
5. 保持 Chrome 打开，重启 Codex，并新建一个任务。

## 验证

先在 Chrome 前台打开一个 `https://www.flova.ai/` 页面，再运行：

```bash
node plugins/codex-page-capture/scripts/health-check.mjs
```

在新的 Codex 任务中可以直接说：

```text
列出可以采集的 FlovaAI 标签页，然后截取当前页面并把图片给我看。
```

或：

```text
录制当前 FlovaAI 页面 5 秒，把 MP4 保存路径发给我。
```

## 权限与安全

- 默认只允许 `https://www.flova.ai/*`
- 拒绝 Chrome 内部页、扩展页、隐身页和非白名单网页
- 不读取 Cookie、浏览历史、网络请求或表单数据
- 保存路径仅允许位于当前用户目录或 `/Volumes`
- 截图结束后会断开调试器；录屏停止、超时或失败后也会断开并清理临时帧
- Chrome 会显示调试提示，这是直接从 Codex 启动页面采集所需的标准行为

## 卸载

```bash
node plugins/codex-page-capture/scripts/uninstall.mjs
codex plugin remove codex-page-capture@liyichao-tools
codex plugin marketplace remove liyichao-tools
```

卸载不会删除已经保存的截图和视频。

## 许可证

[MIT](./LICENSE)
