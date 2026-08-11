/**
 * annotation-overlay.js
 * DOM-aware annotation overlay for visual design feedback.
 *
 * Zero dependencies — single-file vanilla JS. Inject via Tandem evaluate or
 * a <script> tag. Draw arrows, circles, text labels, and freehand strokes.
 * Every annotation automatically links to the DOM element underneath so the
 * output JSON carries CSS selectors, not just pixel coordinates.
 *
 * Usage:
 *   // Inject into any page (Tandem evaluate):
 *   // Read this file, wrap in an IIFE eval, or inject via script tag.
 *
 *   // Public API (on window.__annotationOverlay):
 *   __annotationOverlay.activate()    // show toolbar, start annotating
 *   __annotationOverlay.deactivate()  // hide overlay, restore page
 *   __annotationOverlay.serialize()   // → JSON string
 *   __annotationOverlay.clear()       // remove all annotations
 *
 * Shortcuts:
 *   Ctrl+Shift+A   toggle overlay
 *   Ctrl+Z         undo last annotation
 *   Escape         cancel current drawing / deactivate
 */

(function () {
  "use strict";

  // ===================================================================
  //  Constants
  // ===================================================================

  var COLORS = [
    "#e94560", // red
    "#4080f0", // blue
    "#2ecc71", // green
    "#f1c40f", // yellow
    "#9b59b6", // purple
  ];

  var STROKE_WIDTH = 2.5;
  var ARROW_HEAD_LEN = 14;
  var FONT = "14px system-ui, -apple-system, sans-serif";

  // ===================================================================
  //  State
  // ===================================================================

  var annotations = [];
  var currentTool = "arrow"; // arrow | circle | text | freehand
  var currentColor = COLORS[0];
  var isActive = false;

  // drawing-in-progress state
  var drawing = null; // { tool, startX, startY, points, ... }
  var rafId = null;

  // DOM
  var canvas = null;
  var ctx = null;
  var toolbar = null;
  var commentBox = null;
  var dpr = 1;

  // ===================================================================
  //  Helpers
  // ===================================================================

  function hexToRgb(h) {
    var m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(h);
    return m
      ? {
          r: parseInt(m[1], 16),
          g: parseInt(m[2], 16),
          b: parseInt(m[3], 16),
        }
      : { r: 0, g: 0, b: 0 };
  }

  function rgbaStr(h, alpha) {
    var c = hexToRgb(h);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
  }

  // ===================================================================
  //  DOM Bridge
  // ===================================================================

  function elementAt(x, y) {
    // Temporarily hide our overlay so elementFromPoint sees the page.
    canvas.style.pointerEvents = "none";
    if (toolbar) toolbar.style.pointerEvents = "none";
    var el = document.elementFromPoint(x, y);
    canvas.style.pointerEvents = "auto";
    if (toolbar) toolbar.style.pointerEvents = "auto";
    // Skip our own toolbar elements
    if (el && toolbar && toolbar.contains(el)) return null;
    if (el === canvas) return null;
    return el;
  }

  function generateSelector(el) {
    if (!el || el === document.body || el === document.documentElement) return "";
    if (el.id) return "#" + CSS.escape(el.id);

    var parts = [];
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var seg = cur.tagName.toLowerCase();

      // SVG elements
      if (cur.namespaceURI === "http://www.w3.org/2000/svg" && cur.id) {
        parts.unshift("#" + CSS.escape(cur.id));
        break;
      }

      if (cur.className && typeof cur.className === "string") {
        var classes = cur.className.trim().split(/\s+/).filter(Boolean);
        if (classes.length > 0) {
          seg += "." + classes.map(function (c) { return CSS.escape(c); }).join(".");
        }
      }

      // Disambiguate siblings with same tag+class
      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(
          parent.children,
          function (s) {
            return (
              s.tagName === cur.tagName &&
              (s.className === cur.className ||
                (typeof s.className === "string" &&
                  typeof cur.className === "string" &&
                  s.className.trim() === cur.className.trim()))
            );
          }
        );
        if (same.length > 1) {
          var idx = Array.prototype.indexOf.call(same, cur) + 1;
          seg += ":nth-child(" + idx + ")";
        }
      }

      parts.unshift(seg);
      cur = cur.parentElement;
    }

    return parts.join(" > ");
  }

  function elementMeta(el) {
    if (!el) return { selector: "", tagName: "", classes: [], elementText: "" };
    var text = (el.textContent || "").trim().substring(0, 80);
    var classes = [];
    if (el.className && typeof el.className === "string") {
      classes = el.className.trim().split(/\s+/).filter(Boolean);
    }
    return {
      selector: generateSelector(el),
      tagName: el.tagName ? el.tagName.toLowerCase() : "",
      classes: classes,
      elementText: text,
    };
  }

  // ===================================================================
  //  Drawing helpers
  // ===================================================================

  function setStroke(color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = STROKE_WIDTH * dpr;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.fillStyle = color;
  }

  function drawArrowHead(x, y, angle) {
    ctx.save();
    ctx.translate(x * dpr, y * dpr);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-ARROW_HEAD_LEN * dpr, -ARROW_HEAD_LEN * 0.45 * dpr);
    ctx.lineTo(-ARROW_HEAD_LEN * dpr, ARROW_HEAD_LEN * 0.45 * dpr);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawAnnotation(ann) {
    setStroke(ann.color);

    switch (ann.type) {
      case "arrow":
        ctx.beginPath();
        ctx.moveTo(ann.position.start.x * dpr, ann.position.start.y * dpr);
        ctx.lineTo(ann.position.end.x * dpr, ann.position.end.y * dpr);
        ctx.stroke();
        var angle = Math.atan2(
          ann.position.end.y - ann.position.start.y,
          ann.position.end.x - ann.position.start.x
        );
        drawArrowHead(ann.position.end.x, ann.position.end.y, angle);
        break;

      case "circle":
        ctx.beginPath();
        ctx.rect(
          ann.position.x * dpr,
          ann.position.y * dpr,
          ann.position.w * dpr,
          ann.position.h * dpr
        );
        ctx.stroke();
        break;

      case "text":
        var lines = ann.comment.split("\n");
        ctx.font =
          Math.round(14 * dpr) + "px system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "top";
        var lh = 20 * dpr;
        // text background pill
        var maxW = 0;
        lines.forEach(function (l) {
          var m = ctx.measureText(l);
          if (m.width > maxW) maxW = m.width;
        });
        var px = ann.position.x * dpr;
        var py = ann.position.y * dpr;
        var pad = 6 * dpr;
        ctx.fillStyle = rgbaStr(ann.color, 0.15);
        ctx.fillRect(
          px - pad,
          py - pad,
          maxW + pad * 2,
          lh * lines.length + pad * 2
        );
        // text
        ctx.fillStyle = ann.color;
        lines.forEach(function (l, i) {
          ctx.fillText(l, px, py + i * lh);
        });
        break;

      case "freehand":
        if (!ann.position.points || ann.position.points.length < 2) return;
        ctx.beginPath();
        var pts = ann.position.points;
        ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
        for (var i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * dpr, pts[i].y * dpr);
        }
        ctx.stroke();
        break;
    }
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    annotations.forEach(drawAnnotation);
  }

  function renderDrawing() {
    rafId = null;
    if (!drawing) return;

    redrawAll();

    // Draw in-progress shape in a lighter version
    setStroke(rgbaStr(currentColor, 0.5));

    switch (drawing.tool) {
      case "arrow":
        ctx.beginPath();
        ctx.moveTo(drawing.startX * dpr, drawing.startY * dpr);
        ctx.lineTo(drawing.endX * dpr, drawing.endY * dpr);
        ctx.stroke();
        break;

      case "circle":
        var x = Math.min(drawing.startX, drawing.endX);
        var y = Math.min(drawing.startY, drawing.endY);
        var w = Math.abs(drawing.endX - drawing.startX);
        var h = Math.abs(drawing.endY - drawing.startY);
        ctx.beginPath();
        ctx.rect(x * dpr, y * dpr, w * dpr, h * dpr);
        ctx.stroke();
        break;

      case "freehand":
        var pts = drawing.points;
        if (pts.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x * dpr, pts[0].y * dpr);
        for (var i2 = 1; i2 < pts.length; i2++) {
          ctx.lineTo(pts[i2].x * dpr, pts[i2].y * dpr);
        }
        ctx.stroke();
        break;
    }
  }

  function scheduleRedraw() {
    if (rafId) return;
    rafId = requestAnimationFrame(renderDrawing);
  }

  // ===================================================================
  //  Toolbar
  // ===================================================================

  var TOOLS = [
    { id: "arrow", label: "➤", title: "Arrow (click & drag)" },
    { id: "circle", label: "□", title: "Box (click & drag)" },
    { id: "text", label: "T", title: "Text label" },
    { id: "freehand", label: "✎", title: "Freehand" },
  ];

  function buildToolbar() {
    if (toolbar) return;

    toolbar = document.createElement("div");
    toolbar.id = "__anno_toolbar";
    toolbar.innerHTML =
      '<div id="__anno_tools"></div>' +
      '<div id="__anno_colors"></div>' +
      '<div id="__anno_actions"></div>';

    // Tools
    var toolsDiv = toolbar.querySelector("#__anno_tools");
    TOOLS.forEach(function (t) {
      var btn = document.createElement("button");
      btn.textContent = t.label;
      btn.title = t.title;
      btn.dataset.tool = t.id;
      btn.addEventListener("click", function () { selectTool(t.id); });
      toolsDiv.appendChild(btn);
    });

    // Colors
    var colorsDiv = toolbar.querySelector("#__anno_colors");
    COLORS.forEach(function (color, i) {
      var swatch = document.createElement("span");
      swatch.className = "__anno_swatch";
      swatch.style.backgroundColor = color;
      swatch.title = color;
      swatch.addEventListener("click", function () { selectColor(i); });
      colorsDiv.appendChild(swatch);
    });

    // Actions
    var actionsDiv = toolbar.querySelector("#__anno_actions");
    var undoBtn = document.createElement("button");
    undoBtn.textContent = "↩";
    undoBtn.title = "Undo (Ctrl+Z)";
    undoBtn.addEventListener("click", undo);
    actionsDiv.appendChild(undoBtn);

    var doneBtn = document.createElement("button");
    doneBtn.textContent = "Done";
    doneBtn.className = "__anno_done";
    doneBtn.addEventListener("click", finish);
    actionsDiv.appendChild(doneBtn);

    document.body.appendChild(toolbar);
    updateToolUI();
  }

  function destroyToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
  }

  function updateToolUI() {
    if (!toolbar) return;
    // tool buttons
    var btns = toolbar.querySelectorAll("#__anno_tools button");
    btns.forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === currentTool);
    });
    // color swatches
    var swatches = toolbar.querySelectorAll(".__anno_swatch");
    swatches.forEach(function (s, i) {
      s.classList.toggle("active", COLORS[i] === currentColor);
    });
  }

  function selectTool(toolId) {
    currentTool = toolId;
    updateToolUI();
  }

  function selectColor(index) {
    currentColor = COLORS[index];
    updateToolUI();
  }

  // ===================================================================
  //  Comment input
  // ===================================================================

  function showCommentInput(x, y, callback) {
    hideCommentInput();

    commentBox = document.createElement("div");
    commentBox.id = "__anno_comment";
    commentBox.innerHTML =
      '<textarea id="__anno_comment_input" rows="2" placeholder="What should change?"></textarea>' +
      '<div><button id="__anno_comment_ok">Add</button>' +
      '<button id="__anno_comment_cancel">Cancel</button></div>';

    // Position near the annotation
    commentBox.style.left = Math.min(x + 12, window.innerWidth - 280) + "px";
    commentBox.style.top = Math.min(y + 12, window.innerHeight - 140) + "px";

    document.body.appendChild(commentBox);

    var input = commentBox.querySelector("#__anno_comment_input");
    input.focus();

    commentBox.querySelector("#__anno_comment_ok").addEventListener("click", function () {
      var text = input.value.trim();
      hideCommentInput();
      if (text) callback(text);
    });
    commentBox.querySelector("#__anno_comment_cancel").addEventListener("click", function () {
      hideCommentInput();
      callback(null);
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        var text = input.value.trim();
        hideCommentInput();
        if (text) callback(text);
      }
      if (e.key === "Escape") {
        hideCommentInput();
        callback(null);
      }
    });
  }

  function hideCommentInput() {
    if (commentBox) {
      commentBox.remove();
      commentBox = null;
    }
  }

  // ===================================================================
  //  Canvas events (drawing)
  // ===================================================================

  function canvasCoords(e) {
    return { x: e.clientX, y: e.clientY };
  }

  function onMouseDown(e) {
    if (!isActive || e.button !== 0) return;
    var p = canvasCoords(e);

    if (currentTool === "text") {
      showCommentInput(p.x, p.y, function (comment) {
        if (!comment) return;
        var el = elementAt(p.x, p.y);
        var ann = {
          id: crypto.randomUUID ? crypto.randomUUID() : "a" + Date.now() + Math.random().toString(36).slice(2, 8),
          type: "text",
          comment: comment,
          color: currentColor,
          position: { x: p.x, y: p.y },
        };
        var meta = elementMeta(el);
        ann.selector = meta.selector;
        ann.tagName = meta.tagName;
        ann.classes = meta.classes;
        ann.elementText = meta.elementText;
        annotations.push(ann);
        redrawAll();
      });
      return;
    }

    drawing = {
      tool: currentTool,
      startX: p.x,
      startY: p.y,
      endX: p.x,
      endY: p.y,
      points: [{ x: p.x, y: p.y }],
    };
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!drawing) return;
    var p = canvasCoords(e);
    drawing.endX = p.x;
    drawing.endY = p.y;
    if (currentTool === "freehand") {
      drawing.points.push({ x: p.x, y: p.y });
    }
    scheduleRedraw();
    e.preventDefault();
  }

  function onMouseUp(e) {
    if (!drawing) return;
    var p = canvasCoords(e);
    drawing.endX = p.x;
    drawing.endY = p.y;
    if (currentTool === "freehand") {
      drawing.points.push({ x: p.x, y: p.y });
    }

    var tool = drawing.tool;
    var dx = Math.abs(drawing.endX - drawing.startX);
    var dy = Math.abs(drawing.endY - drawing.startY);

    // Ignore tiny drags (likely accidental)
    if (tool !== "freehand" && dx < 4 && dy < 4) {
      drawing = null;
      redrawAll();
      return;
    }
    if (tool === "freehand" && drawing.points.length < 3) {
      drawing = null;
      redrawAll();
      return;
    }

    // Determine target element
    var targetX, targetY;
    if (tool === "arrow") {
      targetX = drawing.endX;
      targetY = drawing.endY;
    } else if (tool === "circle") {
      targetX = (drawing.startX + drawing.endX) / 2;
      targetY = (drawing.startY + drawing.endY) / 2;
    } else {
      // freehand → bbox center
      var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      drawing.points.forEach(function (pt) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      });
      targetX = (minX + maxX) / 2;
      targetY = (minY + maxY) / 2;
    }

    // Show comment input before finalizing
    var savedDrawing = drawing;
    drawing = null;
    redrawAll();

    showCommentInput(p.x, p.y, function (comment) {
      if (!comment) {
        // User cancelled — discard
        return;
      }

      var el = elementAt(targetX, targetY);
      var meta = elementMeta(el);

      var ann = {
        id: crypto.randomUUID ? crypto.randomUUID() : "a" + Date.now() + Math.random().toString(36).slice(2, 8),
        type: savedDrawing.tool,
        comment: comment,
        color: currentColor,
        selector: meta.selector,
        tagName: meta.tagName,
        classes: meta.classes,
        elementText: meta.elementText,
      };

      if (savedDrawing.tool === "arrow") {
        ann.position = {
          start: { x: savedDrawing.startX, y: savedDrawing.startY },
          end: { x: savedDrawing.endX, y: savedDrawing.endY },
        };
      } else if (savedDrawing.tool === "circle") {
        var cx = Math.min(savedDrawing.startX, savedDrawing.endX);
        var cy = Math.min(savedDrawing.startY, savedDrawing.endY);
        var cw = Math.abs(savedDrawing.endX - savedDrawing.startX);
        var ch = Math.abs(savedDrawing.endY - savedDrawing.startY);
        ann.position = { x: cx, y: cy, w: cw, h: ch };
      } else if (savedDrawing.tool === "freehand") {
        ann.position = { points: savedDrawing.points };
      }

      annotations.push(ann);
      redrawAll();
    });

    e.preventDefault();
  }

  function undo() {
    annotations.pop();
    redrawAll();
  }

  // ===================================================================
  //  Keyboard
  // ===================================================================

  function onKeyDown(e) {
    // Ctrl+Shift+A → toggle
    if (e.ctrlKey && e.shiftKey && e.key === "A") {
      e.preventDefault();
      toggle();
      return;
    }

    if (!isActive) return;

    // Ctrl+Z → undo
    if (e.ctrlKey && e.key === "z") {
      e.preventDefault();
      undo();
      return;
    }

    // Escape → cancel drawing or deactivate
    if (e.key === "Escape") {
      e.preventDefault();
      if (drawing) {
        drawing = null;
        redrawAll();
      } else {
        deactivate();
      }
      return;
    }
  }

  // ===================================================================
  //  Serializer
  // ===================================================================

  function serialize() {
    return JSON.stringify(
      {
        version: "1",
        url: window.location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
        timestamp: new Date().toISOString(),
        annotations: annotations,
      },
      null,
      2
    );
  }

  function copyToClipboard() {
    var json = serialize();
    // Try clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () {
        console.log("[AnnotationOverlay] Copied to clipboard");
      }).catch(function () {
        fallbackCopy(json);
      });
    } else {
      fallbackCopy(json);
    }
    // Always log so Tandem devtools can read
    console.log("[AnnotationOverlay] Output:\n" + json);
  }

  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (_) { /* noop */ }
    ta.remove();
    console.log("[AnnotationOverlay] Copied via fallback");
  }

  // ===================================================================
  //  Install / Remove
  // ===================================================================

  function installCanvas() {
    if (canvas) return;
    canvas = document.createElement("canvas");
    canvas.id = "__anno_canvas";
    canvas.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;pointer-events:auto;";
    document.body.appendChild(canvas);

    dpr = window.devicePixelRatio || 1;
    resizeCanvas();

    ctx = canvas.getContext("2d");

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    window.addEventListener("resize", resizeCanvas);
  }

  function removeCanvas() {
    if (!canvas) return;
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseup", onMouseUp);
    window.removeEventListener("resize", resizeCanvas);
    canvas.remove();
    canvas = null;
    ctx = null;
  }

  function resizeCanvas() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    redrawAll();
  }

  // ===================================================================
  //  Activate / Deactivate
  // ===================================================================

  function activate() {
    if (isActive) return;
    isActive = true;
    installCanvas();
    buildToolbar();
    redrawAll();
    console.log("[AnnotationOverlay] Activated — Ctrl+Shift+A to toggle");
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;
    drawing = null;
    hideCommentInput();
    destroyToolbar();
    removeCanvas();
  }

  function toggle() {
    if (isActive) deactivate();
    else activate();
  }

  function finish() {
    copyToClipboard();
    deactivate();
  }

  function clearAnnos() {
    annotations = [];
    if (isActive) redrawAll();
  }

  // ===================================================================
  //  Stylesheet
  // ===================================================================

  function injectStyles() {
    if (document.getElementById("__anno_styles")) return;
    var style = document.createElement("style");
    style.id = "__anno_styles";
    style.textContent =
      "#__anno_toolbar {" +
      "  position:fixed;top:12px;left:50%;transform:translateX(-50%);" +
      "  z-index:2147483647;display:flex;align-items:center;gap:6px;" +
      "  padding:6px 10px;background:#1e1e2e;border:1px solid #45475a;" +
      "  border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.4);" +
      "  font-family:system-ui,-apple-system,sans-serif;font-size:13px;" +
      "  color:#cdd6f4;user-select:none;" +
      "}" +
      "#__anno_toolbar button {" +
      "  background:transparent;border:none;color:#a6adc8;" +
      "  cursor:pointer;border-radius:6px;padding:5px 10px;" +
      "  font-size:15px;line-height:1;transition:background .12s,color .12s;" +
      "}" +
      "#__anno_toolbar button:hover { background:#313244;color:#cdd6f4; }" +
      "#__anno_toolbar button.active { background:#45475a;color:#fff; }" +
      "#__anno_toolbar .__anno_done {" +
      "  background:#a6e3a1;color:#1e1e2e;font-weight:600;padding:5px 14px;" +
      "}" +
      "#__anno_toolbar .__anno_done:hover { background:#94e2d5; }" +
      "#__anno_tools { display:flex;gap:2px; }" +
      "#__anno_colors { display:flex;gap:4px;padding:0 8px;border-left:1px solid #45475a;border-right:1px solid #45475a; }" +
      ".__anno_swatch {" +
      "  width:20px;height:20px;border-radius:50%;cursor:pointer;" +
      "  border:2px solid transparent;transition:border-color .12s,transform .12s;" +
      "}" +
      ".__anno_swatch:hover { transform:scale(1.15); }" +
      ".__anno_swatch.active { border-color:#fff; }" +
      "#__anno_actions { display:flex;gap:2px; }" +
      "#__anno_comment {" +
      "  position:fixed;z-index:2147483647;width:260px;" +
      "  background:#1e1e2e;border:1px solid #45475a;border-radius:10px;" +
      "  padding:8px;box-shadow:0 4px 24px rgba(0,0,0,.4);" +
      "  font-family:system-ui,-apple-system,sans-serif;" +
      "}" +
      "#__anno_comment textarea {" +
      "  width:100%;box-sizing:border-box;background:#313244;color:#cdd6f4;" +
      "  border:1px solid #45475a;border-radius:6px;padding:6px 8px;" +
      "  font:inherit;font-size:13px;resize:none;outline:none;" +
      "}" +
      "#__anno_comment textarea:focus { border-color:#89b4fa; }" +
      "#__anno_comment div { display:flex;gap:4px;margin-top:6px;justify-content:flex-end; }" +
      "#__anno_comment button {" +
      "  padding:4px 12px;border:none;border-radius:6px;font:inherit;font-size:12px;" +
      "  cursor:pointer;transition:background .12s;" +
      "}" +
      "#__anno_comment_ok { background:#a6e3a1;color:#1e1e2e; }" +
      "#__anno_comment_ok:hover { background:#94e2d5; }" +
      "#__anno_comment_cancel { background:#45475a;color:#cdd6f4; }" +
      "#__anno_comment_cancel:hover { background:#585b70; }";
    document.head.appendChild(style);
  }

  // ===================================================================
  //  Bootstrap
  // ===================================================================

  function init() {
    if (window.__annotationOverlay) return; // already installed
    injectStyles();
    document.addEventListener("keydown", onKeyDown);

    // Expose public API
    window.__annotationOverlay = {
      activate: activate,
      deactivate: deactivate,
      toggle: toggle,
      serialize: serialize,
      clear: clearAnnos,
    };

    // Auto-activate if URL has ?__anno=1
    if (/[?&]__anno=1(&|$)/.test(window.location.search)) {
      activate();
    }
  }

  init();
})();
