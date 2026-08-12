---
name: annotation-browser-launch
description: 拉起 agent 拥有的标注浏览器（Playwright chromium-956323 + Annotation Overlay 扩展 + 专用持久 profile + 固定 CDP 端口），供用户在页面上标注反馈。Use when the agent needs to show the annotation toolbar on a page for the user to annotate, in the flow where the agent owns the browser (方案 D 主流程).
---

# 标注浏览器启动（Annotation Browser Launch）

## 何时用

agent 需要用户在页面上做视觉标注反馈，标注发生在 **agent 自己拉起的浏览器窗口** 里（方案 D，主流程）。配合 `annotation-feedback-wait` 使用：本 skill 拉窗口 + 激活标注 → wait skill 收数据 → 本 skill 重连复验。

## 为什么是 agent 的浏览器

标注界面放在 agent 控制的浏览器（chromium-956323）而不是用户真实 Chrome：agent 原生控制导航/刷新/截图，闭环最顺。**已验证**：该 chromium 构建能加载我们的扩展、https 页能 fetch localhost server（旧 chromium-1228 不行 —— 它 https→localhost 挂起，submit 会失败，必须用 956323）。

## 配置表（本机路径）

| 项 | 值 |
|----|----|
| chromium | `C:/Users/26462/AppData/Local/ms-playwright/chromium-956323/chrome-win/chrome.exe` |
| 扩展目录 | `D:/KaiFa/annotation-overlay/extension` |
| 持久 profile | `C:/Users/26462/.annotation-overlay/browser-profile`（登录态跨轮次保留） |
| CDP 端口 | `9223`（避开 chrome-debug 的 9222） |
| playwright NODE_PATH | `C:/Users/26462/AppData/Local/OpenAI/Codex/runtimes/cua_node/1b23c930bdf84ed6/bin/node_modules` |
| 启动脚本 | `~/.claude/skills/annotation-browser-launch/scripts/launch.cjs` |

脚本支持 env 覆盖：`ANNO_BROWSER_CHROME` / `ANNO_BROWSER_EXT` / `ANNO_BROWSER_PROFILE` / `ANNO_BROWSER_PORT`。

## 流程

### 1. 启动标注浏览器（后台运行）

**先查 9223 端口是否已在监听** —— 如果上次的标注浏览器还开着，直接跳到「重连」复用，不要重复启动（同 profile + 端口互斥）。

```bash
NODE_PATH="<配置表 playwright NODE_PATH>" node ~/.claude/skills/annotation-browser-launch/scripts/launch.cjs "<目标URL>"
```

用 **run_in_background** 运行。脚本会：
- 拉起 chromium-956323 + 扩展 + 持久 profile + 9223 端口
- 导航到目标 URL，等 overlay 注入，`activate()` 显示工具栏
- 输出 `[annotation-browser] READY url=... | overlay=true | toolbar=true | port=9223`

**首次使用**：profile 是空的，用户需要在 agent 浏览器里登录目标 app 一次，之后跨轮次保留。

### 2. 请用户标注

窗口已在用户屏幕、工具栏已显示。告诉用户用标注工具圈画问题区域并点 **Submit**。然后转 `annotation-feedback-wait` 收数据。

### 3. 重连 + 复验

agent 处理反馈后，用 node_repl 连回浏览器操作（刷新/截图/重激活）：

```js
const pw = await import("playwright");
const c = await pw.chromium.connectOverCDP("http://127.0.0.1:9223");
const page = c.contexts().flatMap(cx => cx.pages())[0];
await page.reload();                                             // 加载修复
await page.waitForLoadState("domcontentloaded");
await page.evaluate(() => window.__annotationOverlay.activate()); // 重激活标注（提交后会自动停用）
// 复验截图：await page.screenshot({ path: "C:/Users/26462/.annotation-overlay/screenshots/verify.png" })
await c.close();
```

### 4. 关闭

标注流程结束 → 杀掉启动脚本的后台进程（Playwright 退出时自动关浏览器），9223 端口释放。

## 关键要点

- **必须用 chromium-956323**，不要用 1228 —— 1228 的 https 页 fetch http://localhost 挂起，submit 到 server 会失败。
- **同一时间只跑一个标注浏览器**（同一 profile + 端口互斥）。启动前先查 9223，已开则复用。
- overlay 默认隐藏（agent 控制激活），`activate()` 由脚本和重连代码显式调用。
- 提交后 overlay 自动 deactivate（toolbar 隐藏），重连复验代码里要重新 `activate()`。
- 持久 profile 含登录态 —— 这是设计（agent 浏览器要能访问目标 app），标注目标属用户自己的项目，无敏感数据风险。

## 相关

- `annotation-feedback-wait`（收数据：等 submit → read_annotations → clear）
- `before-after-verification`、`chrome-extension-e2e-testing`
