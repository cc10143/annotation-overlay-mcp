---
name: annotation-feedback-wait
description: 通过 Annotation Overlay（浏览器标注扩展 + MCP server）收集用户视觉反馈并等待其提交时使用。核心是挂后台 watcher 轮询标注数量 —— MCP 是拉取模型，server 不能推送给 agent，不主动轮询就感知不到用户提交。Use when the agent needs the user to annotate a page in the browser and wait for the feedback submission to arrive.
---

# 标注反馈等待（Annotation Feedback Wait）

## 何时用

需要用户通过 **Annotation Overlay** 在浏览器标注页面反馈、并等待其提交时。典型场景：视觉设计评审、UI 问题反馈、页面缺陷圈画、before/after 验证。

**核心前提**：annotation-overlay-mcp 是 **MCP 拉取模型** —— 用户点 Submit 后数据静默落库，agent **不会自动感知**。必须主动挂 watcher 或轮询 `read_annotations` 才能收到反馈。设计缺陷，靠流程弥补。

## 流程

### 1. 确认环境

- `annotation-overlay-mcp` MCP server 已连接（`read_annotations` / `capture_page` / `set_annotation_mode` / `clear_annotations` 四个工具可用）
- 用户 Chrome 已加载 Annotation Overlay 扩展（chrome://extensions → Load unpacked → `extension/` 目录）
- MCP server 在 localhost:3847 健康（`curl http://localhost:3847/api/health`）

### 2. 先 clear_annotations（关键：保证读到的是这一轮的新反馈）

调 `clear_annotations` 清空 store。**clear 在前**而不是在后：这样 `read_annotations` 永远只返回本轮用户新提交的标注，不需要"判断哪些是残留"。也顺带清掉上一轮的 before/after 截图路径。

（要保留历史做对比就跳过此步，改用 `_receivedAt` 时间戳判断残留 —— 主流程不做这个。）

### 3. 挂后台 watcher（在请用户标注之前）

用后台 watcher 轮询标注数量，count 变化即通知：

```
后台命令：每 ~5s 轮询 http://localhost:3847/api/annotations 的 count，
count 与上次不同时输出一行（如 "annotation count changed: 0 -> 3"）。
首次读取只初始化、不输出（避免启动噪音）。
```

示例（curl + grep，Windows Git Bash 可用）：
```bash
last=""
while true; do
  c=$(curl -s --max-time 3 http://localhost:3847/api/annotations 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2)
  if [ -n "$c" ]; then
    if [ -z "$last" ]; then last="$c"
    elif [ "$c" != "$last" ]; then echo "annotation count changed: $last -> $c"; last="$c"; fi
  fi
  sleep 5
done
```

用户 submit → count 增加 → 收到通知。agent 自己 `clear_annotations` → count 回落 → 也收到通知。

### 4. 让标注工具栏出现（主流程：agent 自己的浏览器）

**主入口**：调 `annotation-browser-launch` skill —— agent 用 Playwright 拉起 chromium-956323 + 扩展 + 持久 profile，导航目标页并 `activate()` 显示工具栏。agent 拥有浏览器，后续刷新/截图/复验都由 agent 原生控制。

**兜底（用户真实 Chrome）**：若标注必须发生在用户自己的 Chrome，才用 `set_annotation_mode(true)`（MCP 工具，走 SW 通道，返回 `{ok, enabled, tabUrl}` —— 核对 tabUrl 是否是要标注的页面）。用户也可按 `Ctrl+Shift+A` 手动唤出/隐藏。

然后明确告诉用户：在浏览器用标注工具圈画问题区域（箭头/方框/文字/自由画/点选元素/选文字），然后点 **Submit**。

### 5. 等通知，读取

收到 watcher 通知（或用户确认已提交）后，调 `read_annotations`。返回结构：

```json
{
  "count": 3,
  "annotations": [
    { "id": "...", "type": "arrow|circle|text|freehand|select|textsel",
      "comment": "...", "selector": "...", "fallbackSelectors": [...],
      "tagName": "BUTTON", "classes": [...], "elementText": "...",
      "position": { ... }, "color": "#e94560" }
  ],
  "screenshotPath": "C:\\...\\anno-before.png",
  "afterScreenshotPath": "C:\\...\\anno-after.png",
  "afterScreenshotTabUrl": "https://example.com/"
}
```

### 6. 处理

- 把 `screenshotPath`（before，提交时捕获的标注视图）喂视觉 MCP，看用户指的位置
- 修复后调 `capture_page` 拿 after 截图，喂视觉 MCP 对比确认修复生效
- **不在这里 clear** —— 下一轮开始时的步骤 2 会清，保证每轮数据隔离，没有"判断残留"的负担

## 关键要点

- **clear 在前是流程纪律**：每轮开始先 `clear_annotations`，`read_annotations` 就永远只含本轮新反馈，不用判断"哪些是残留"（见步骤 2）
- **没有 watcher 时必须主动轮询** `read_annotations` —— MCP 拉取模型，不轮询就感知不到提交
- `capture_page` 捕获的是**最近聚焦窗口的活动 tab**，返回的 `tabUrl` 要核对是否是要验证的页面（用户切 tab 会截到错页）
- `screenshotPath`（before）在提交时捕获，可能因扩展 SW 冷启动超时（overlay 1.2s 捕获超时）而缺失 —— 缺失时以 `afterScreenshotPath` + 标注数据为准
- 提交后 overlay 自动清除画布标注并停用，用户需重新激活才能继续标注

## 相关

- Annotation Overlay README（工具完整说明、MCP tools、selector fallback 链）
- [[annotation-overlay-v2]]、[[screenshot-export]]、[[before-after-verification]]
