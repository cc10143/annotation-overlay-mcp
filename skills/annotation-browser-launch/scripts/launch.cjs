// Launch the annotation browser — Playwright chromium-956323 + Annotation Overlay
// extension + dedicated persistent profile, with a fixed CDP port for reconnect.
// Run in background (keepalive holds the window open); kill the process to close.
//
// Usage: NODE_PATH="<playwright node_modules>" node launch.cjs <url>
const { chromium } = require("playwright");

const url = process.argv[2] || "https://example.com";

// Machine config — see SKILL.md. Override via env when needed.
const CHROME = process.env.ANNO_BROWSER_CHROME ||
  "C:/Users/26462/AppData/Local/ms-playwright/chromium-956323/chrome-win/chrome.exe";
const EXT = process.env.ANNO_BROWSER_EXT ||
  "D:/KaiFa/annotation-overlay/extension";
const PROFILE = process.env.ANNO_BROWSER_PROFILE ||
  "C:/Users/26462/.annotation-overlay/browser-profile";
const PORT = parseInt(process.env.ANNO_BROWSER_PORT || "9223", 10);

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    args: [
      `--load-extension=${EXT}`,
      `--disable-extensions-except=${EXT}`,
      `--remote-debugging-port=${PORT}`,
    ],
  });
  const page = ctx.pages()[0];
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Wait for the overlay to inject (bridge.js runs at document_idle).
  let injected = false;
  for (let i = 0; i < 20 && !injected; i++) {
    injected = await page
      .evaluate(() => typeof window.__annotationOverlay !== "undefined")
      .catch(() => false);
    if (!injected) await new Promise((r) => setTimeout(r, 500));
  }
  // Show the toolbar (overlay is hidden by default; agent owns the page in D).
  if (injected) {
    await page.evaluate(() => window.__annotationOverlay.activate()).catch(() => {});
  }
  const toolbar = await page
    .evaluate(() => !!document.getElementById("__anno_toolbar"))
    .catch(() => false);

  console.log(
    `[annotation-browser] READY url=${await page.url()} | overlay=${injected} | toolbar=${toolbar} | port=${PORT}`
  );

  // Keep the process alive so the browser window stays open.
  setInterval(() => {}, 60000);
})().catch((e) => {
  console.error("[annotation-browser] FAILED:", e.message);
  process.exit(1);
});
