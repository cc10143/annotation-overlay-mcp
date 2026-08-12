/**
 * annotation-overlay.js  v2.0.0
 * DOM-aware annotation overlay for visual design feedback.
 *
 * Zero dependencies — single-file vanilla JS.
 * 6 interaction modes: arrow, box, text, freehand, click-to-select, text selection annotation.
 * Every annotation links to the DOM element underneath via CSS selectors.
 * Submit batch annotations to the MCP server via postMessage (Chrome extension bridge).
 *
 * Usage:
 *   // Chrome Extension: auto-injected by bridge.js on every page
 *   // Standalone: inject via script tag or Tandem evaluate
 *
 *   // Public API (on window.__annotationOverlay):
 *   __annotationOverlay.activate()    // show toolbar, start annotating
 *   __annotationOverlay.deactivate()  // hide overlay, restore page
 *   __annotationOverlay.serialize()   // → JSON string
 *   __annotationOverlay.clear()       // remove all annotations
 *   __annotationOverlay.submit()      // send to MCP server
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
  var DEFAULT_PORT = 3847;

  // ===================================================================
  //  State
  // ===================================================================

  var annotations = [];
  var redoStack = [];
  var currentTool = "arrow"; // arrow | circle | text | freehand | select | textsel
  var currentColor = COLORS[0];
  var isActive = false;
  var mcpPort = DEFAULT_PORT; // set via anno-config from bridge

  // drawing-in-progress state
  var drawing = null; // { tool, startX, startY, points, ... }
  var rafId = null;

  // select tool state
  var highlightedEl = null;

  // select-tool debounce: delays pin so a double-click's first click
  // doesn't fire it (dblclick in select mode edits annotations instead)
  var selectClickTimer = null;

  // numbered badges (DOM refs for cleanup)
  var badges = [];

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
      ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
      : { r: 0, g: 0, b: 0 };
  }

  function rgbaStr(h, alpha) {
    var c = hexToRgb(h);
    return "rgba(" + c.r + "," + c.g + "," + c.b + "," + alpha + ")";
  }

  function makeId() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "a" + Date.now() + Math.random().toString(36).slice(2, 8);
  }

  // ===================================================================
  //  DOM Bridge
  // ===================================================================

  function elementAt(x, y) {
    canvas.style.pointerEvents = "none";
    if (toolbar) toolbar.style.pointerEvents = "none";
    var el = document.elementFromPoint(x, y);
    canvas.style.pointerEvents = "auto";
    if (toolbar) toolbar.style.pointerEvents = "auto";
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

      var parent = cur.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (s) {
          return (
            s.tagName === cur.tagName &&
            (s.className === cur.className ||
              (typeof s.className === "string" &&
                typeof cur.className === "string" &&
                s.className.trim() === cur.className.trim()))
          );
        });
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

  function contentHash(el) {
    if (!el) return "";
    var text = (el.textContent || "").trim().substring(0, 40);
    var hash = 5381;
    var full = (el.textContent || "").trim();
    for (var i = 0; i < full.length; i++) {
      hash = ((hash << 5) + hash) + full.charCodeAt(i);
    }
    return text + "-" + (hash >>> 0).toString(16);
  }

  function elementMeta(el) {
    if (!el) return { selector: "", tagName: "", classes: [], elementText: "", fallbackSelectors: [], contentHash: "" };
    var text = (el.textContent || "").trim().substring(0, 80);
    var classes = [];
    if (el.className && typeof el.className === "string") {
      classes = el.className.trim().split(/\s+/).filter(Boolean);
    }
    var cssPath = generateSelector(el);
    var ch = contentHash(el);

    var fallbacks = [];
    if (el.id) fallbacks.push({ type: "id", value: "#" + CSS.escape(el.id) });
    fallbacks.push({ type: "cssPath", value: cssPath });
    fallbacks.push({ type: "contentHash", value: ch });

    return {
      selector: cssPath,
      fallbackSelectors: fallbacks,
      tagName: el.tagName ? el.tagName.toLowerCase() : "",
      classes: classes,
      elementText: text,
      contentHash: ch,
    };
  }

  // For box/freehand: find the deepest ancestor whose rect covers ≥60% of the
  // drawn region. One container element = "this region" — clearer for the agent
  // than a list of every element the box happens to overlap.
  function findRegionContainer(box) {
    if (!box || box.w <= 0 || box.h <= 0) return null;
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    var el = elementAt(cx, cy);
    if (!el) return null;
    var boxArea = box.w * box.h;
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var r = cur.getBoundingClientRect();
      var ox = Math.max(0, Math.min(r.right, box.x + box.w) - Math.max(r.left, box.x));
      var oy = Math.max(0, Math.min(r.bottom, box.y + box.h) - Math.max(r.top, box.y));
      var inter = ox * oy;
      if (inter >= boxArea * 0.6) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function pinBadge(el, index) {
    var rect = el.getBoundingClientRect();
    var badge = document.createElement("div");
    badge.className = "__anno_badge";
    badge.textContent = String(index);
    badge.style.left = (rect.right - 6) + "px";
    badge.style.top = (rect.top - 6) + "px";
    badge.dataset.annoBadgeIdx = String(index);
    badge.dataset.annoIdx = String(index);
    badge.addEventListener("dblclick", function (e) {
      e.stopPropagation();
      if (currentTool !== "select") return;
      var ann = annotations[parseInt(badge.dataset.annoIdx, 10) - 1];
      if (ann) editAnnotation(ann, e.clientX, e.clientY);
    });
    document.body.appendChild(badge);
    badges.push(badge);
  }

  function removeAllBadges() {
    badges.forEach(function (b) { b.remove(); });
    badges = [];
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
        ctx.font = Math.round(14 * dpr) + "px system-ui, -apple-system, sans-serif";
        ctx.textBaseline = "top";
        var lh = 20 * dpr;
        var maxW = 0;
        lines.forEach(function (l) {
          var m = ctx.measureText(l);
          if (m.width > maxW) maxW = m.width;
        });
        var px = ann.position.x * dpr;
        var py = ann.position.y * dpr;
        var pad = 6 * dpr;
        ctx.fillStyle = rgbaStr(ann.color, 0.15);
        ctx.fillRect(px - pad, py - pad, maxW + pad * 2, lh * lines.length + pad * 2);
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

      case "textsel":
        // Highlight block over the selected text so the annotation is visible
        // on the canvas and double-clickable (select mode edits the comment).
        if (!ann.position || typeof ann.position.w === "undefined") return;
        ctx.fillStyle = rgbaStr(ann.color, 0.15);
        ctx.fillRect(
          ann.position.x * dpr,
          ann.position.y * dpr,
          ann.position.w * dpr,
          ann.position.h * dpr
        );
        ctx.strokeStyle = ann.color;
        ctx.lineWidth = 1 * dpr;
        ctx.strokeRect(
          ann.position.x * dpr,
          ann.position.y * dpr,
          ann.position.w * dpr,
          ann.position.h * dpr
        );
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
        var pts2 = drawing.points;
        if (pts2.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(pts2[0].x * dpr, pts2[0].y * dpr);
        for (var i2 = 1; i2 < pts2.length; i2++) {
          ctx.lineTo(pts2[i2].x * dpr, pts2[i2].y * dpr);
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
    { id: "arrow", label: "➤", title: "Arrow (click & drag)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>' },
    { id: "circle", label: "□", title: "Box (click & drag)",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>' },
    { id: "text", label: "T", title: "Text label",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 4h12"/><path d="M12 4v16"/><path d="M8 20h8"/></svg>' },
    { id: "freehand", label: "✎", title: "Freehand",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' },
    { id: "select", label: "+", title: "Click to select element",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 1v4m0 14v4M1 12h4m14 0h4"/></svg>' },
    { id: "textsel", label: "[ ]", title: "Annotate text selection",
      svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 12h-3V7H6v5H3"/><path d="M3 5v14"/><rect x="8" y="7" width="6" height="10" rx="1" stroke-dasharray="2 2"/></svg>' },
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
      btn.innerHTML = t.svg;
      btn.title = t.title;
      btn.dataset.tool = t.id;
      btn.className = "__anno_tool_btn";
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

    var submitBtn = document.createElement("button");
    submitBtn.textContent = annotations.length > 0 ? "Submit (" + annotations.length + ")" : "Submit";
    submitBtn.className = "__anno_submit";
    submitBtn.id = "__anno_submit_btn";
    submitBtn.addEventListener("click", submit);
    actionsDiv.appendChild(submitBtn);

    // Export dropdown
    var exportWrap = document.createElement("div");
    exportWrap.className = "__anno_dropdown";
    var exportBtn = document.createElement("button");
    exportBtn.textContent = "Export ▾";
    exportBtn.title = "Export annotations";
    exportBtn.addEventListener("click", function (e) {
      e.stopPropagation();
      var menu = exportWrap.querySelector(".__anno_dropdown_menu");
      menu.style.display = menu.style.display === "block" ? "none" : "block";
    });
    exportWrap.appendChild(exportBtn);

    var exportMenu = document.createElement("div");
    exportMenu.className = "__anno_dropdown_menu";
    exportMenu.style.display = "none";
    ["json", "markdown", "png"].forEach(function (fmt) {
      var item = document.createElement("button");
      var labels = { json: "JSON", markdown: "Markdown", png: "PNG (canvas)" };
      item.textContent = labels[fmt];
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        exportMenu.style.display = "none";
        doExport(fmt);
      });
      exportMenu.appendChild(item);
    });
    exportWrap.appendChild(exportMenu);
    actionsDiv.appendChild(exportWrap);

    // Close button
    var closeBtn = document.createElement("button");
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>';
    closeBtn.title = "Close (Esc)";
    closeBtn.className = "__anno_close_btn";
    closeBtn.addEventListener("click", deactivate);
    toolbar.appendChild(closeBtn);

    document.body.appendChild(toolbar);

    // Close export dropdown on outside click
    document.addEventListener("click", function () {
      if (exportMenu) exportMenu.style.display = "none";
    });
    updateToolUI();
  }

  function destroyToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
  }

  function updateSubmitCount() {
    var btn = document.getElementById("__anno_submit_btn");
    if (btn) {
      btn.textContent = annotations.length > 0 ? "Submit (" + annotations.length + ")" : "Submit";
      if (annotations.length > 0) {
        btn.classList.add("__anno_submit_has");
      } else {
        btn.classList.remove("__anno_submit_has");
      }
    }
  }

  function updateToolUI() {
    if (!toolbar) return;
    var btns = toolbar.querySelectorAll("#__anno_tools button");
    btns.forEach(function (b) {
      b.classList.toggle("active", b.dataset.tool === currentTool);
    });
    var swatches = toolbar.querySelectorAll(".__anno_swatch");
    swatches.forEach(function (s, i) {
      s.classList.toggle("active", COLORS[i] === currentColor);
    });
    updateSubmitCount();
  }

  function selectTool(toolId) {
    currentTool = toolId;
    clearHighlight();
    updateToolUI();
  }

  function selectColor(index) {
    currentColor = COLORS[index];
    updateToolUI();
  }

  // ===================================================================
  //  Comment input
  // ===================================================================

  // initialValue (optional): prefill the textarea for editing existing annotations.
  // Add → callback(text) (empty string passes through, caller decides whether to
  // keep/clear); Cancel / Esc → callback(null).
  function showCommentInput(x, y, callback, initialValue) {
    hideCommentInput();

    commentBox = document.createElement("div");
    commentBox.id = "__anno_comment";
    commentBox.innerHTML =
      '<textarea id="__anno_comment_input" rows="2" placeholder="What should change?"></textarea>' +
      '<div><button id="__anno_comment_ok">Add</button>' +
      '<button id="__anno_comment_cancel">Cancel</button></div>';

    commentBox.style.left = Math.min(x + 12, window.innerWidth - 280) + "px";
    commentBox.style.top = Math.min(y + 12, window.innerHeight - 140) + "px";

    document.body.appendChild(commentBox);

    var input = commentBox.querySelector("#__anno_comment_input");
    if (typeof initialValue === "string") {
      input.value = initialValue;
      input.setSelectionRange(initialValue.length, initialValue.length);
    }
    input.focus();

    commentBox.querySelector("#__anno_comment_ok").addEventListener("click", function () {
      var text = input.value.trim();
      hideCommentInput();
      callback(text);
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
        callback(text);
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
  //  Select tool helpers
  // ===================================================================

  function clearHighlight() {
    if (highlightedEl) {
      highlightedEl.removeAttribute("data-anno-highlight");
      highlightedEl = null;
    }
  }

  function handleSelectHover(e) {
    if (!isActive || currentTool !== "select") return;
    var el = elementAt(e.clientX, e.clientY);
    if (el === highlightedEl) return;
    clearHighlight();
    if (el) {
      el.setAttribute("data-anno-highlight", "");
      highlightedEl = el;
    }
  }

  function handleSelectClick(e) {
    if (!isActive || currentTool !== "select" || e.button !== 0) return;
    var el = elementAt(e.clientX, e.clientY);
    if (!el) return;
    clearHighlight();

    // v2.2: pin immediately (no comment prompt). Debounce 250ms so a
    // double-click's first click doesn't pin — dblclick edits instead.
    if (selectClickTimer) clearTimeout(selectClickTimer);
    selectClickTimer = setTimeout(function () {
      selectClickTimer = null;

      var rect = el.getBoundingClientRect();
      var meta = elementMeta(el);
      var ann = {
        id: makeId(),
        type: "select",
        comment: "",
        color: currentColor,
        selector: meta.selector,
        fallbackSelectors: meta.fallbackSelectors,
        tagName: meta.tagName,
        classes: meta.classes,
        elementText: meta.elementText,
        contentHash: meta.contentHash,
        position: {
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
        },
      };
      redoStack = [];
      annotations.push(ann);
      pinBadge(el, annotations.length);
      redrawAll();
      updateToolUI();
    }, 250);
  }

  // ===================================================================
  //  Double-click to edit annotation comment (select mode only)
  // ===================================================================

  function distToSegment(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(px - ax, py - ay);
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    var cx = ax + t * dx, cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  function distToPolyline(px, py, points) {
    if (!points || points.length < 2) return Infinity;
    var min = Infinity;
    for (var i = 1; i < points.length; i++) {
      var d = distToSegment(px, py, points[i - 1].x, points[i - 1].y, points[i].x, points[i].y);
      if (d < min) min = d;
    }
    return min;
  }

  function pointInRect(px, py, rx, ry, rw, rh, pad) {
    return px >= rx - pad && px <= rx + rw + pad && py >= ry - pad && py <= ry + rh + pad;
  }

  // Topmost first: later annotations render on top, so hit them first.
  function hitTestAnnotation(x, y) {
    for (var i = annotations.length - 1; i >= 0; i--) {
      var ann = annotations[i];
      var p = ann.position;
      if (!p) continue;
      if (ann.type === "arrow" && p.start && p.end) {
        if (distToSegment(x, y, p.start.x, p.start.y, p.end.x, p.end.y) < 12) return ann;
      } else if (ann.type === "circle") {
        if (pointInRect(x, y, p.x, p.y, p.w, p.h, 12)) return ann;
      } else if (ann.type === "freehand") {
        if (distToPolyline(x, y, p.points) < 12) return ann;
      } else if ((ann.type === "select" || ann.type === "textsel") && typeof p.w !== "undefined") {
        if (pointInRect(x, y, p.x, p.y, p.w, p.h, 8)) return ann;
      }
    }
    return null;
  }

  function editAnnotation(ann, x, y) {
    showCommentInput(x, y, function (comment) {
      if (comment === null) return; // cancelled
      ann.comment = comment;
      redrawAll();
      updateSubmitCount();
    }, ann.comment);
  }

  function onCanvasDblClick(e) {
    if (currentTool !== "select") return;
    // Cancel the pending single-click pin so a double-click doesn't badge
    if (selectClickTimer) { clearTimeout(selectClickTimer); selectClickTimer = null; }
    var p = canvasCoords(e);
    var ann = hitTestAnnotation(p.x, p.y);
    if (ann) editAnnotation(ann, p.x, p.y);
  }

  // ===================================================================
  //  Text selection handler
  // ===================================================================

  function handleTextSelection(e) {
    if (!isActive || currentTool !== "textsel") return;
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;

    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();

    var selectedText = sel.toString().trim().substring(0, 200);

    // v2.2: annotate immediately (selectedText IS the content), no prompt.
    // Double-click in select mode edits the comment later.
    var container = range.commonAncestorContainer;
    var el = container.nodeType === 3 ? container.parentElement : container;

    var meta = elementMeta(el);
    var ann = {
      id: makeId(),
      type: "textsel",
      comment: "",
      color: currentColor,
      selectedText: selectedText,
      selector: meta.selector,
      fallbackSelectors: meta.fallbackSelectors,
      tagName: meta.tagName,
      classes: meta.classes,
      elementText: meta.elementText,
      contentHash: meta.contentHash,
      position: {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      },
    };
    redoStack = [];
    annotations.push(ann);
    redrawAll();
    updateToolUI();

    // Clear the selection highlight so it doesn't linger visually
    sel.removeAllRanges();
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

    // select tool: handled by click on canvas → delegate to select handler
    if (currentTool === "select") {
      handleSelectClick(e);
      return;
    }

    // textsel tool: ignore canvas mouse events (handled by global mouseup)
    if (currentTool === "textsel") {
      return;
    }

    if (currentTool === "text") {
      showCommentInput(p.x, p.y, function (comment) {
        if (!comment) return;
        var el = elementAt(p.x, p.y);
        var meta = elementMeta(el);
        var ann = {
          id: makeId(),
          type: "text",
          comment: comment,
          color: currentColor,
          position: { x: p.x, y: p.y },
        };
        ann.selector = meta.selector;
        ann.fallbackSelectors = meta.fallbackSelectors;
        ann.tagName = meta.tagName;
        ann.classes = meta.classes;
        ann.elementText = meta.elementText;
        ann.contentHash = meta.contentHash;
        redoStack = [];
        annotations.push(ann);
        redrawAll();
        updateToolUI();
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
    // select tool hover highlight
    if (currentTool === "select") {
      handleSelectHover(e);
      return;
    }

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

    var targetX, targetY;
    if (tool === "arrow") {
      targetX = drawing.endX;
      targetY = drawing.endY;
    } else if (tool === "circle") {
      targetX = (drawing.startX + drawing.endX) / 2;
      targetY = (drawing.startY + drawing.endY) / 2;
    } else {
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

    var savedDrawing = drawing;
    drawing = null;
    redrawAll();

    // v2.2: draw → annotate immediately, no comment prompt.
    // Double-click in select mode edits the comment later.
    var el = elementAt(targetX, targetY);
    var meta = elementMeta(el);

    var ann = {
      id: makeId(),
      type: savedDrawing.tool,
      comment: "",
      color: currentColor,
      selector: meta.selector,
      fallbackSelectors: meta.fallbackSelectors,
      tagName: meta.tagName,
      classes: meta.classes,
      elementText: meta.elementText,
      contentHash: meta.contentHash,
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
      // Box: attach the region container element (the ancestor covering this area)
      var regionBox = { x: cx, y: cy, w: cw, h: ch };
      var regionEl = findRegionContainer(regionBox);
      if (regionEl) ann.region = elementMeta(regionEl);
    } else if (savedDrawing.tool === "freehand") {
      ann.position = { points: savedDrawing.points };
      // Freehand: region container over the stroke's bounding box
      var fhBox = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      var fhRegionEl = findRegionContainer(fhBox);
      if (fhRegionEl) ann.region = elementMeta(fhRegionEl);
    }

    redoStack = [];
    annotations.push(ann);
    redrawAll();
    updateToolUI();

    e.preventDefault();
  }

  function undo() {
    // If drawing in progress, cancel it first — don't pop an annotation
    if (drawing) {
      drawing = null;
      redrawAll();
      return;
    }
    if (annotations.length === 0) return;

    var popped = annotations.pop();
    redoStack.push(popped);

    // Hide the corresponding badge instead of removing it
    var idx = annotations.length + 1; // 1-based index of the popped annotation
    badges.forEach(function (b) {
      if (b.dataset.annoIdx === String(idx)) {
        b.style.display = "none";
      }
    });

    redrawAll();
    updateToolUI();
  }

  function redo() {
    if (redoStack.length === 0) return;

    var restored = redoStack.pop();
    annotations.push(restored);

    // Show the corresponding badge
    var idx = annotations.length; // 1-based index of the restored annotation
    badges.forEach(function (b) {
      if (b.dataset.annoIdx === String(idx)) {
        b.style.display = "";
      }
    });

    redrawAll();
    updateToolUI();
  }

  // ===================================================================
  //  Keyboard
  // ===================================================================

  function onKeyDown(e) {
    if (e.ctrlKey && e.shiftKey && e.key === "A") {
      e.preventDefault();
      toggle();
      return;
    }

    if (!isActive) return;

    // Don't intercept shortcuts when typing in comment input
    if (commentBox && commentBox.contains(document.activeElement)) return;

    // Case-insensitive key match: physical keyboards report "Z" when
    // Shift is held, but synthesized/automation events may report "z".
    if (e.ctrlKey && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }

    if (
      e.ctrlKey &&
      ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y")
    ) {
      e.preventDefault();
      redo();
      return;
    }

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

    // Tool switching: 1-6 (no modifier)
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      var toolIdx = parseInt(e.key, 10);
      if (toolIdx >= 1 && toolIdx <= 6) {
        e.preventDefault();
        selectTool(TOOLS[toolIdx - 1].id);
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        showShortcutPanel();
        return;
      }
    }
  }

  function showShortcutPanel() {
    var existing = document.getElementById("__anno_shortcuts");
    if (existing) { existing.remove(); return; }

    var panel = document.createElement("div");
    panel.id = "__anno_shortcuts";
    var shortcuts = [
      ["Ctrl+Shift+A", "Toggle overlay"],
      ["1–6", "Switch tool"],
      ["Ctrl+Z", "Undo"],
      ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
      ["Double-click", "Edit comment (select tool)"],
      ["Escape", "Cancel / Close"],
      ["Enter", "Confirm comment"],
      ["Shift+Enter", "Newline in comment"],
      ["?", "This panel"],
    ];
    var html = '<div style="font-weight:600;margin-bottom:8px;color:#cdd6f4;">Shortcuts</div>';
    shortcuts.forEach(function (s) {
      html += '<div style="display:flex;justify-content:space-between;gap:24px;padding:2px 0;font-size:12px;">' +
        '<kbd style="color:#a6e3a1;">' + s[0] + '</kbd>' +
        '<span style="color:#a6adc8;">' + s[1] + '</span></div>';
    });
    panel.innerHTML = html;
    panel.style.cssText =
      "position:fixed;z-index:2147483647;top:60px;left:50%;transform:translateX(-50%);" +
      "background:#1e1e2e;border:1px solid #45475a;border-radius:10px;" +
      "padding:12px 16px;box-shadow:0 4px 24px rgba(0,0,0,.4);" +
      "font-family:system-ui,-apple-system,sans-serif;min-width:260px;";
    document.body.appendChild(panel);

    var closer = function (e) {
      if (!panel.contains(e.target)) {
        panel.remove();
        document.removeEventListener("click", closer);
        document.removeEventListener("keydown", escClose);
      }
    };
    var escClose = function (e) {
      if (e.key === "Escape") { panel.remove(); document.removeEventListener("click", closer); document.removeEventListener("keydown", escClose); }
    };
    setTimeout(function () {
      document.addEventListener("click", closer);
      document.addEventListener("keydown", escClose);
    }, 0);
  }

  // ===================================================================
  //  Serializer
  // ===================================================================

  function serialize() {
    return JSON.stringify(
      {
        version: "2",
        url: window.location.href,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        timestamp: new Date().toISOString(),
        annotations: annotations,
      },
      null,
      2
    );
  }

  // ===================================================================
  //  Screenshot capture (attach annotated viewport to submit)
  // ===================================================================

  function hideOverlayUI() {
    ["__anno_toolbar", "__anno_comment", "__anno_shortcuts"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.style.display !== "none") {
        el.dataset.annoPrevDisplay = el.style.display;
        el.style.display = "none";
      }
    });
  }

  function restoreOverlayUI() {
    ["__anno_toolbar", "__anno_comment", "__anno_shortcuts"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && el.dataset.annoPrevDisplay !== undefined) {
        el.style.display = el.dataset.annoPrevDisplay;
        delete el.dataset.annoPrevDisplay;
      }
    });
  }

  // Ask the extension to capture the current visible tab. The capture includes
  // the overlay's canvas annotations and badges (they are DOM), so no separate
  // compositing is needed — we only hide toolbar/comment/shortcut UI first.
  // Without an extension bridge the request times out and callback(null) fires,
  // so submit proceeds without a screenshot.
  function captureScreenshot(callback) {
    hideOverlayUI();
    var done = false;
    var handler = function (e) {
      if (e.data?.type === "anno-captured") {
        window.removeEventListener("message", handler);
        done = true;
        restoreOverlayUI();
        callback(e.data.ok && e.data.dataURL ? e.data.dataURL : null);
      }
    };
    window.addEventListener("message", handler);
    window.postMessage({ type: "anno-capture" }, "*");
    setTimeout(function () {
      if (done) return;
      window.removeEventListener("message", handler);
      restoreOverlayUI();
      callback(null);
    }, 1200);
  }

  // ===================================================================
  //  Submit (to MCP server via extension bridge)
  // ===================================================================

  function submit() {
    if (annotations.length === 0) {
      console.log("[AnnotationOverlay] No annotations to submit");
      return;
    }

    var payload = {
      version: "2",
      url: window.location.href,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      timestamp: new Date().toISOString(),
      annotations: annotations.slice(), // copy
    };

    // Capture the annotated viewport (page + annotations) and attach it to the
    // submit. In the Chrome extension this runs via captureVisibleTab; without
    // an extension bridge the capture times out and submit proceeds without a
    // screenshot.
    captureScreenshot(function (dataURL) {
      if (dataURL) payload.screenshotData = dataURL;

      var logPayload = Object.assign({}, payload);
      delete logPayload.screenshotData;
      console.log("[AnnotationOverlay] Submitting " + annotations.length + " annotation(s)...\n" + JSON.stringify(logPayload, null, 2));

      var submitted = false;
      var handler = function (e) {
        if (e.data?.type === "anno-submitted") {
          window.removeEventListener("message", handler);
          submitted = true;
          if (e.data.ok) {
            console.log("[AnnotationOverlay] Submitted. " + e.data.count + " total on server.");
            clearAnnos();
            deactivate();
          } else {
            console.error("[AnnotationOverlay] Submit failed:", e.data.error);
          }
        }
      };
      window.addEventListener("message", handler);

      // Send via postMessage to bridge.js (ISOLATED world)
      window.postMessage({ type: "anno-submit", payload: payload }, "*");

      // Fallback: if no bridge response after 3s, try direct fetch
      setTimeout(function () {
        if (!submitted) {
          window.removeEventListener("message", handler);
          console.log("[AnnotationOverlay] Bridge not responding, trying direct fetch...");
          directSubmit(payload);
        }
      }, 3000);
    });
  }

  function directSubmit(payload) {
    // For standalone use (no Chrome extension) — POST directly to MCP server
    var port = mcpPort || DEFAULT_PORT;
    fetch("http://localhost:" + port + "/api/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        console.log("[AnnotationOverlay] Direct submit OK. " + data.count + " total on server.");
        clearAnnos();
        deactivate();
      })
      .catch(function (err) {
        console.error("[AnnotationOverlay] Direct submit failed:", err.message);
        console.log("[AnnotationOverlay] Falling back to clipboard.\n" + JSON.stringify(payload, null, 2));
        fallbackCopy(JSON.stringify(payload, null, 2));
        deactivate();
      });
  }

  function copyToClipboard() {
    var json = serialize();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).catch(function () { fallbackCopy(json); });
    } else {
      fallbackCopy(json);
    }
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
  //  Export
  // ===================================================================

  function downloadBlob(content, filename, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportJSON() {
    var json = serialize();
    var host = window.location.hostname || "localhost";
    var ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
    downloadBlob(json, "annotations-" + host + "-" + ts + ".json", "application/json");
    console.log("[AnnotationOverlay] Exported JSON");
  }

  function exportPNG() {
    if (!canvas) return;
    canvas.toBlob(function (blob) {
      if (!blob) {
        console.error("[AnnotationOverlay] PNG export failed: canvas.toBlob returned null");
        return;
      }
      var host = window.location.hostname || "localhost";
      var ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "annotations-" + host + "-" + ts + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      console.log("[AnnotationOverlay] Exported PNG");
    }, "image/png");
  }

  function exportMarkdown() {
    var payload = {
      version: "2",
      url: window.location.href,
      timestamp: new Date().toISOString(),
      annotations: annotations.slice(),
    };

    var done = false;
    var handler = function (e) {
      if (e.data?.type === "anno-exported" && e.data.format === "markdown") {
        window.removeEventListener("message", handler);
        done = true;
        if (e.data.data) {
          var host = window.location.hostname || "localhost";
          var ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
          downloadBlob(e.data.data, "annotations-" + host + "-" + ts + ".md", "text/markdown");
          console.log("[AnnotationOverlay] Exported Markdown");
        } else {
          console.error("[AnnotationOverlay] Markdown export failed:", e.data.error);
        }
      }
    };
    window.addEventListener("message", handler);

    // Send via bridge; fallback to direct fetch after 3s
    window.postMessage({ type: "anno-export", format: "markdown", payload: payload }, "*");
    setTimeout(function () {
      if (done) return;
      window.removeEventListener("message", handler);
      // Direct fetch fallback
      var port = mcpPort || DEFAULT_PORT;
      fetch("http://localhost:" + port + "/api/export/markdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.text(); })
        .then(function (md) {
          var host = window.location.hostname || "localhost";
          var ts = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);
          downloadBlob(md, "annotations-" + host + "-" + ts + ".md", "text/markdown");
          console.log("[AnnotationOverlay] Exported Markdown (direct)");
        })
        .catch(function (err) {
          console.error("[AnnotationOverlay] Markdown export failed:", err.message);
        });
    }, 3000);
  }

  function doExport(format) {
    if (annotations.length === 0) {
      console.log("[AnnotationOverlay] No annotations to export");
      return;
    }
    if (format === "json") exportJSON();
    else if (format === "png") exportPNG();
    else if (format === "markdown") exportMarkdown();
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

    // getContext must come BEFORE resizeCanvas — resizeCanvas calls
    // redrawAll which uses ctx, and a null ctx throws on activation.
    ctx = canvas.getContext("2d");

    dpr = window.devicePixelRatio || 1;
    resizeCanvas();

    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("dblclick", onCanvasDblClick);
    window.addEventListener("resize", resizeCanvas);

    // Text selection handler (global, not on canvas)
    document.addEventListener("mouseup", handleTextSelection);
  }

  function removeCanvas() {
    if (!canvas) return;
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("mouseup", onMouseUp);
    canvas.removeEventListener("dblclick", onCanvasDblClick);
    window.removeEventListener("resize", resizeCanvas);
    document.removeEventListener("mouseup", handleTextSelection);
    clearHighlight();
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
    updateToolUI();
    console.log("[AnnotationOverlay] Activated — Ctrl+Shift+A to toggle");
  }

  function deactivate() {
    if (!isActive) return;
    isActive = false;
    drawing = null;
    clearHighlight();
    hideCommentInput();
    destroyToolbar();
    removeCanvas();
  }

  function toggle() {
    if (isActive) deactivate();
    else activate();
  }

  function clearAnnos() {
    annotations = [];
    redoStack = [];
    removeAllBadges();
    if (isActive) redrawAll();
    updateToolUI();
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
      "  z-index:2147483647;display:flex;align-items:center;gap:8px;" +
      "  padding:8px 12px;background:#1e1e2e;border:1px solid #45475a;" +
      "  border-radius:10px;box-shadow:0 4px 24px rgba(0,0,0,.4);" +
      "  font-family:system-ui,-apple-system,sans-serif;font-size:13px;" +
      "  color:#cdd6f4;user-select:none;" +
      "}" +
      "#__anno_toolbar button {" +
      "  background:transparent;border:none;color:#a6adc8;" +
      "  cursor:pointer;border-radius:6px;padding:5px 10px;" +
      "  font-size:15px;line-height:1;transition:background .12s,color .12s;" +
      "  display:flex;align-items:center;justify-content:center;" +
      "}" +
      "#__anno_toolbar button:hover { background:#313244;color:#cdd6f4; }" +
      "#__anno_toolbar button.active { background:#45475a;color:#fff; }" +
      ".__anno_tool_btn svg { width:18px;height:18px; }" +
      "#__anno_toolbar .__anno_submit {" +
      "  background:#a6e3a1;color:#1e1e2e;font-weight:600;padding:5px 14px;" +
      "  font-size:13px;" +
      "}" +
      "#__anno_toolbar .__anno_submit:hover { background:#94e2d5; }" +
      ".__anno_submit_has {" +
      "  animation: __anno_pulse .6s ease-in-out infinite alternate;" +
      "}" +
      "@keyframes __anno_pulse {" +
      "  from { box-shadow: 0 0 0 0 rgba(166,227,161,.4); }" +
      "  to   { box-shadow: 0 0 0 6px rgba(166,227,161,0); }" +
      "}" +
      ".__anno_close_btn svg { width:16px;height:16px; }" +
      ".__anno_close_btn:hover { background:#e94560 !important;color:#fff !important; }" +
      "#__anno_tools { display:flex;gap:2px; }" +
      "#__anno_colors { display:flex;gap:4px;padding:0 8px;border-left:1px solid #45475a;border-right:1px solid #45475a; }" +
      ".__anno_swatch {" +
      "  width:20px;height:20px;border-radius:50%;cursor:pointer;" +
      "  border:2px solid transparent;transition:border-color .12s,transform .12s;" +
      "}" +
      ".__anno_swatch:hover { transform:scale(1.15); }" +
      ".__anno_swatch.active { border-color:#fff; }" +
      "#__anno_actions { display:flex;gap:2px; }" +
      ".__anno_dropdown { position:relative; }" +
      ".__anno_dropdown_menu {" +
      "  display:none;position:absolute;top:100%;right:0;margin-top:4px;" +
      "  background:#1e1e2e;border:1px solid #45475a;border-radius:8px;" +
      "  box-shadow:0 4px 24px rgba(0,0,0,.4);z-index:2147483647;" +
      "  min-width:130px;padding:4px;overflow:hidden;" +
      "}" +
      ".__anno_dropdown_menu button {" +
      "  display:block;width:100%;text-align:left;padding:6px 10px;" +
      "  border:none;background:transparent;color:#cdd6f4;font-size:12px;" +
      "  cursor:pointer;border-radius:4px;" +
      "}" +
      ".__anno_dropdown_menu button:hover { background:#313244; }" +
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
      "#__anno_comment_cancel:hover { background:#585b70; }" +
      // Select tool: hover highlight
      "[data-anno-highlight] {" +
      "  outline: 2px dashed #4080f0 !important;" +
      "  outline-offset: 2px !important;" +
      "}" +
      // Numbered badge
      ".__anno_badge {" +
      "  position:fixed;" +
      "  z-index:2147483647;" +
      "  width:22px;height:22px;" +
      "  border-radius:50%;" +
      "  background:#e94560;" +
      "  color:#fff;" +
      "  font-size:11px;font-weight:700;" +
      "  font-family:system-ui,-apple-system,sans-serif;" +
      "  display:flex;align-items:center;justify-content:center;" +
      "  pointer-events:auto;" +
      "  cursor:pointer;" +
      "  box-shadow:0 1px 4px rgba(0,0,0,.4);" +
      "}" +
      ".__anno_badge:hover { transform:scale(1.15); }";
    document.head.appendChild(style);
  }

  // ===================================================================
  //  Extension config listener
  // ===================================================================

  function listenForConfig() {
    window.addEventListener("message", function (e) {
      if (e.source !== window) return;
      if (e.data?.type === "anno-config") {
        mcpPort = e.data.port || DEFAULT_PORT;
        console.log("[AnnotationOverlay] Configured for port " + mcpPort);
      }
    });
  }

  // ===================================================================
  //  Bootstrap
  // ===================================================================

  function init() {
    if (window.__annotationOverlay) return;
    injectStyles();
    document.addEventListener("keydown", onKeyDown);
    listenForConfig();

    window.__annotationOverlay = {
      activate: activate,
      deactivate: deactivate,
      toggle: toggle,
      serialize: serialize,
      clear: clearAnnos,
      submit: submit,
    };

    // Extension-injected: auto-activate
    // When injected via bridge.js (Chrome extension), activate immediately.
    // The ?__anno=1 URL param is also supported for standalone injection.
    var injectedByExtension = !!document.querySelector("script[data-anno-overlay]");
    if (injectedByExtension || /[?&]__anno=1(&|$)/.test(window.location.search)) {
      activate();
    }
  }

  init();
})();
