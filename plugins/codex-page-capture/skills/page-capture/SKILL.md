---
name: page-capture
description: Use the local Codex Page Capture Chrome extension to list allowed FlovaAI tabs, save visible-page PNG screenshots, and record silent MP4 videos. Use when the user asks Codex to screenshot or record a page in their existing Chrome session.
---

# Page Capture

Use the bundled MCP tools for all capture operations.

## Workflow

1. Call `get_capture_status` when connection state is uncertain.
2. Default to the active allowed tab. Call `list_capture_tabs` only when the user names another tab or multiple matching tabs exist.
3. Use `capture_screenshot` for a PNG of the visible page area.
4. Prefer `record_for` when the user provides a duration. Use `start_recording` and `stop_recording` only when the end time is unknown.
5. Return the absolute saved path and any warnings. Never claim success without a completed path from the tool.

## Safety

- Do not broaden the website allowlist unless the user explicitly asks.
- Do not retry a debugger-conflict error repeatedly; ask the user to close DevTools or finish the other Chrome task.
- A recording must remain on the target foreground tab. If it auto-stops after the tab is hidden, report that the returned MP4 is partial.
- The plugin captures only page pixels. It does not authorize clicking, submitting, downloading from, or otherwise changing the page.
