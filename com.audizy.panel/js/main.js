(function () {
    "use strict";

    // ---- bridge -----------------------------------------------------------
    var cs = new CSInterface();
    var extRoot = "";
    try { extRoot = cs.getSystemPath(SystemPath.EXTENSION); } catch (e) {}
    function callJSX(fn, args, cb) {
        var parts = [];
        for (var i = 0; i < args.length; i++) parts.push(JSON.stringify(args[i]));
        cs.evalScript(fn + "(" + parts.join(",") + ")", function (raw) {
            var res; try { res = JSON.parse(raw); } catch (e) { res = { success: false, error: raw }; }
            if (!res || res.success === false) log("JSX " + fn + " → " + ((res && res.error) || raw));
            if (cb) cb(res);
        });
    }

    // ---- constants --------------------------------------------------------
    var RULER_H = 28, LANE_H = 48, SCROLL_H = 16, LANE_TOP = 32;
    function rulerTop() { return 0; }   // ruler drawn at the top
    var TOOLS = [
        { id: "pointer", icon: "pointer", label: "Selection Tool", key: "V" },
        { id: "razor",   icon: "razor",   label: "Razor Tool",     key: "C" },
        { id: "hand",    icon: "hand",    label: "Hand Tool",      key: "H" }
    ];
    function toolById(id) { for (var i = 0; i < TOOLS.length; i++) if (TOOLS[i].id === id) return TOOLS[i]; return TOOLS[0]; }

    // ---- dom --------------------------------------------------------------
    var $ = function (id) { return document.getElementById(id); };
    var canvas = $("tl"), ctx = canvas.getContext("2d");
    var wrap = $("canvasWrap");
    var emptyEl = $("empty"), timelineEl = $("timeline");
    var toolIconEl = $("activeToolIcon"), toolLabelEl = $("activeToolLabel");   // may be null (toolbar removed)
    var trackHeadersEl = $("trackHeaders");
    var toastEl = $("toast");
    var scrollbar = $("scrollbar"), scrollThumb = $("scrollThumb");
    var logPanelEl = $("logPanel"), logBodyEl = $("logBody");

    // ---- state ------------------------------------------------------------
    var st = {
        group: null, peaks: null, tool: "pointer",
        view: { start: 0, pps: 100 },
        playhead: 0, selRcId: null, hoverX: -1, snap: true,
        track: { muted: false, solo: false, locked: false },
        playing: false, playT0: 0, playWall: 0, lastPush: 0, playRAF: 0
    };
    var drag = null, toastTimer = null;

    // ---- log --------------------------------------------------------------
    var logLines = [];
    function log(msg) {
        var ts = new Date().toISOString().substr(11, 8);
        logLines.push("[" + ts + "] " + msg);
        if (logLines.length > 800) logLines.shift();
        if (logBodyEl) { logBodyEl.value = logLines.join("\n"); logBodyEl.scrollTop = logBodyEl.scrollHeight; }
    }
    window.onerror = function (m, src, line, col) { log("JS ERROR: " + m + " @" + line + ":" + col); return false; };
    window.addEventListener("unhandledrejection", function (e) { log("PROMISE REJECT: " + (e && e.reason)); });

    // ---- helpers ----------------------------------------------------------
    function toast(msg, isErr) {
        log((isErr ? "ERROR: " : "") + msg);
        toastEl.textContent = msg; toastEl.className = "show" + (isErr ? " err" : "");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { toastEl.className = ""; }, 2200);
    }
    // AE-style timecode M:SS:FF (minutes:seconds:frames)
    function fmt(t) {
        if (t == null || isNaN(t)) return "0:00:00";
        var fps = Math.max(1, Math.round((st.group && st.group.frameRate) || 30));
        var neg = t < 0; if (neg) t = -t;
        var totalF = Math.round(t * fps);
        var f = totalF % fps;
        var totalS = Math.floor(totalF / fps);
        var s = totalS % 60, m = Math.floor(totalS / 60);
        function p2(n) { return (n < 10 ? "0" : "") + n; }
        return (neg ? "-" : "") + m + ":" + p2(s) + ":" + p2(f);
    }
    function css(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
    function timeToX(t) { return (t - st.view.start) * st.view.pps; }
    function xToTime(x) { return st.view.start + x / st.view.pps; }
    function cssW() { return canvas.clientWidth || 600; }
    function cssH() { return canvas.clientHeight || 200; }
    function selSeg() {
        if (!st.group || !st.selRcId) return null;
        var s = st.group.segments; for (var i = 0; i < s.length; i++) if (s[i].rcId === st.selRcId) return s[i];
        return null;
    }
    function segAtTime(t) {
        if (!st.group) return null;
        var s = st.group.segments; for (var i = 0; i < s.length; i++) if (t > s[i].inPoint && t < s[i].outPoint) return s[i];
        return null;
    }
    function segByRc(id) {
        if (!st.group) return null;
        var s = st.group.segments; for (var i = 0; i < s.length; i++) if (s[i].rcId === id) return s[i];
        return null;
    }
    var EDGE_PX = 6;   // hit zone for trim handles
    function edgeHit(x, y) {
        if (!st.group) return null;
        if (y < LANE_TOP || y > LANE_TOP + LANE_H) return null;
        var s = st.group.segments;
        for (var i = 0; i < s.length; i++) {
            var x0 = timeToX(s[i].inPoint), x1 = timeToX(s[i].outPoint);
            if (Math.abs(x - x0) <= EDGE_PX) return { seg: s[i], edge: "in" };
            if (Math.abs(x - x1) <= EDGE_PX) return { seg: s[i], edge: "out" };
        }
        return null;
    }
    function contentStart() { return st.group ? st.group.groupStart : 0; }
    function contentEnd() { return st.group ? st.group.groupEnd : 10; }

    // ---- palette ----------------------------------------------------------
    function paletteAction(id, icon, label, handler) {
        var b = document.createElement("button");
        b.id = id; b.className = "tool-btn";
        b.innerHTML = window.AudizyIcons[icon] + '<span class="tool-tooltip">' + label + '</span>';
        b.addEventListener("click", handler);
        return b;
    }
    function buildPalette() {
        var pal = $("palette"); pal.innerHTML = "";
        var grid = document.createElement("div"); grid.className = "palette-tools";
        grid.appendChild(paletteAction("btnLog", "log", "Log", function () { logPanelEl.classList.toggle("hidden"); }));
        grid.appendChild(paletteAction("btnLoad", "precompose", "Precompose / load audio", load));
        var divider = document.createElement("div"); divider.className = "palette-divider";
        grid.appendChild(divider);
        for (var i = 0; i < TOOLS.length; i++) {
            (function (tool) {
                var b = document.createElement("button");
                b.className = "tool-btn" + (tool.id === st.tool ? " active" : "");
                b.setAttribute("data-tool", tool.id);
                b.innerHTML = window.AudizyIcons[tool.icon] +
                    '<span class="tool-tooltip">' + tool.label +
                    '<span class="tool-tooltip-shortcut">' + tool.key + '</span></span>';
                b.addEventListener("click", function () { setTool(tool.id); });
                grid.appendChild(b);
            })(TOOLS[i]);
        }
        pal.appendChild(grid);
    }
    function setTool(id) {
        st.tool = id;
        var btns = document.querySelectorAll(".tool-btn");
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-tool") === id);
        var t = toolById(id);
        if (toolIconEl) toolIconEl.innerHTML = window.AudizyIcons[t.icon];
        if (toolLabelEl) toolLabelEl.textContent = t.label + " (" + t.key + ")";
        wrap.classList.remove("blade", "hand", "zoom");
        if (id === "razor") wrap.classList.add("blade");
        else if (id === "hand") wrap.classList.add("hand");
        else if (id === "zoom") wrap.classList.add("zoom");
    }

    // ---- canvas sizing ----------------------------------------------------
    function resize() {
        var dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(cssW() * dpr);
        canvas.height = Math.floor(cssH() * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        render();
    }
    window.addEventListener("resize", resize);

    // ---- render -----------------------------------------------------------
    function clampView() { if (st.view.start < 0) st.view.start = 0; }   // never scroll left past 0:00
    function render() {
        clampView();
        var w = cssW(), h = cssH();
        ctx.clearRect(0, 0, w, h);
        if (!st.group) return;
        drawLaneBg(w);
        var segs = st.group.segments;
        for (var i = 0; i < segs.length; i++) drawSegment(segs[i]);
        drawRuler(w);
        drawPlayhead(h);
        drawBladeHover();
        updateScrollbar();
    }
    function drawLaneBg(w) {
        ctx.fillStyle = css("--color-bg-primary");
        ctx.fillRect(0, LANE_TOP, w, LANE_H);
        ctx.strokeStyle = css("--color-border");
        ctx.beginPath(); ctx.moveTo(0, LANE_TOP + LANE_H + 0.5); ctx.lineTo(w, LANE_TOP + LANE_H + 0.5); ctx.stroke();
    }
    function drawSegment(seg) {
        var x0 = timeToX(seg.inPoint), x1 = timeToX(seg.outPoint), w = x1 - x0;
        if (w <= 0 || x1 < 0 || x0 > cssW()) return;
        var sel = (seg.rcId === st.selRcId);
        var y = LANE_TOP + 2, hh = LANE_H - 4;
        ctx.fillStyle = !seg.audioEnabled ? "#3a2e2e" : (sel ? "#3f6da0" : "#2f4a63");
        ctx.fillRect(x0, y, w, hh);
        if (st.peaks) {
            window.AudizyWave.drawPeaksRange(ctx, st.peaks, seg.srcIn, seg.srcOut,
                x0 + 1, y + 2, w - 2, hh - 4, sel ? "#cfe6ff" : "#8fc4ff", 1.6);
        }
        ctx.strokeStyle = sel ? css("--color-focus") : css("--color-border");
        ctx.lineWidth = sel ? 2 : 1;
        ctx.strokeRect(x0 + 0.5, y + 0.5, w - 1, hh - 1);
        // label bar
        ctx.fillStyle = "rgba(0,0,0,0.25)"; ctx.fillRect(x0, y, w, 12);
        ctx.fillStyle = "rgba(255,255,255,0.8)"; ctx.font = "10px Consolas, monospace";
        ctx.save(); ctx.beginPath(); ctx.rect(x0, y, w, 12); ctx.clip();
        ctx.fillText(seg.name, x0 + 4, y + 9); ctx.restore();
    }
    function niceStep(pps) {
        var target = 90 / pps;
        var steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
        for (var i = 0; i < steps.length; i++) if (steps[i] >= target) return steps[i];
        return 1200;
    }
    function drawRuler(w) {
        var ry = rulerTop();
        ctx.fillStyle = css("--color-bg-secondary");
        ctx.fillRect(0, ry, w, RULER_H);
        ctx.strokeStyle = css("--color-border");
        ctx.beginPath(); ctx.moveTo(0, ry + 0.5); ctx.lineTo(w, ry + 0.5); ctx.stroke();
        var step = niceStep(st.view.pps);
        var t0 = Math.floor(st.view.start / step) * step;
        ctx.fillStyle = css("--color-text-muted");
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.font = "9px Consolas, monospace"; ctx.lineWidth = 1;
        for (var t = t0; timeToX(t) < w; t += step) {
            var x = timeToX(t); if (x < -50) continue;
            ctx.beginPath(); ctx.moveTo(x + 0.5, ry); ctx.lineTo(x + 0.5, ry + 6); ctx.stroke();
            ctx.fillText(fmt(t), x + 3, ry + 17);
        }
    }
    function drawPlayhead(h) {
        var x = timeToX(st.playhead);
        ctx.strokeStyle = css("--color-playhead"); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
        ctx.fillStyle = css("--color-playhead");
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
    }
    function drawBladeHover() {
        if (st.tool !== "razor" || st.hoverX < 0) return;
        ctx.strokeStyle = "#ffd24d"; ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(st.hoverX + 0.5, LANE_TOP); ctx.lineTo(st.hoverX + 0.5, LANE_TOP + LANE_H); ctx.stroke();
        ctx.setLineDash([]);
    }

    // ---- scrollbar --------------------------------------------------------
    function updateScrollbar() {
        var w = cssW();
        var cS = contentStart(), cE = contentEnd();
        var pad = (cE - cS) * 0.1 + 1;
        var total = (cE - cS) + pad * 2;
        var viewSpan = w / st.view.pps;
        var frac = Math.min(1, viewSpan / total);
        var thumbW = Math.max(24, frac * w);
        var pos = ((st.view.start - (cS - pad)) / total) * w;
        pos = Math.max(0, Math.min(w - thumbW, pos));
        scrollThumb.style.width = thumbW + "px";
        scrollThumb.style.left = pos + "px";
    }

    // ---- view control -----------------------------------------------------
    function fit() {
        if (!st.group) return;
        var span = contentEnd() - contentStart(); if (span <= 0) span = 10;
        st.view.pps = Math.max(4, (cssW() - 40) / span);
        st.view.start = contentStart() - 20 / st.view.pps;
        render();
    }
    function zoomAt(x, factor) {
        var tAt = xToTime(x);
        st.view.pps = Math.max(2, Math.min(6000, st.view.pps * factor));
        st.view.start = tAt - x / st.view.pps;
        render();
    }

    // ---- data flow --------------------------------------------------------
    function stateSig(segs) {
        var s = "";
        for (var i = 0; i < segs.length; i++) s += segs[i].rcId + ":" + segs[i].inPoint.toFixed(4) + ":" + segs[i].outPoint.toFixed(4) + ";";
        return s;
    }
    function applyGroup(res, doFit) {
        if (!res || !res.success) { toast((res && res.error) || "Load failed", true); return; }
        st.group = res; st.playhead = res.currentTime;
        st.lastSig = stateSig(res.segments);
        if (st.selRcId && !selSeg()) st.selRcId = null;
        emptyEl.classList.add("hidden"); timelineEl.classList.remove("hidden");
        if (res.sourcePath) {
            window.AudizyWave.getPeaks(extRoot, res.sourcePath, function (data) {
                st.peaks = data;
                if (!data) toast("Waveform: " + (window.AudizyWave.lastError() || "decode failed"), true);
                render();
            });
        } else {
            st.peaks = null;
            toast("No source file path on layer", true);
        }
        resize();
        if (doFit) fit();
    }
    function load() { callJSX("precomposeSelectedAudio", [], function (res) { applyGroup(res, true); }); }
    function reload() { if (st.group && st.group.precompId != null) callJSX("getPrecompState", [st.group.precompId], function (res) { applyGroup(res, false); }); }
    function afterEdit(msg) {
        return function (res) { if (res && res.success) { toast(msg); applyGroup(res, false); } else toast((res && res.error) || "Failed", true); };
    }
    function renamePrecomp() {
        if (!st.group || st.group.precompId == null) { toast("Precompose audio first", true); return; }
        var cur = st.group.compName || "Audizy";
        var name = window.prompt("Rename precomp:", cur);
        if (name === null) return;
        name = ("" + name).replace(/^\s+|\s+$/g, "");
        if (!name) { toast("Empty name", true); return; }
        callJSX("renamePrecomp", [st.group.precompId, name], afterEdit("Renamed"));
    }

    // ---- edit list --------------------------------------------------------
    function uuidjs() {
        return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === "x" ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    // Each clip keeps its own free comp position (compIn = inPoint).
    function listFromSegments() {
        var segs = st.group.segments, list = { v: 1, segments: [] };
        for (var i = 0; i < segs.length; i++)
            list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint });
        return list;
    }
    function applyList(list, msg) {
        callJSX("azApply", [st.group.precompId, JSON.stringify(list)], afterEdit(msg));
    }

    // ---- actions ----------------------------------------------------------
    function cutAt(t) {
        if (!st.group) return;
        var seg = segAtTime(t);
        if (!seg) { toast("No clip under the cut point", true); return; }
        var srcSplit = seg.srcIn + (t - seg.inPoint);
        if (srcSplit <= seg.srcIn + 1e-4 || srcSplit >= seg.srcOut - 1e-4) { toast("Cut must be inside the clip", true); return; }
        var segs = st.group.segments, list = { v: 1, segments: [] };
        for (var i = 0; i < segs.length; i++) {
            if (segs[i].rcId === seg.rcId) {
                var mid = segs[i].inPoint + (srcSplit - segs[i].srcIn);   // comp time of the cut
                list.segments.push({ id: uuidjs(), srcIn: segs[i].srcIn, srcOut: srcSplit, compIn: segs[i].inPoint });
                list.segments.push({ id: uuidjs(), srcIn: srcSplit, srcOut: segs[i].srcOut, compIn: mid });
            } else list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint });
        }
        applyList(list, "Cut");
    }
    function cutAtPlayhead() { cutAt(st.playhead); }
    function deleteSel() {
        var s = selSeg(); if (!s) { toast("Select a clip first", true); return; }
        if (st.group.segments.length <= 1) { toast("Can't delete the last clip", true); return; }
        var segs = st.group.segments, list = { v: 1, segments: [] };
        for (var i = 0; i < segs.length; i++) if (segs[i].rcId !== s.rcId)
            list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint });
        st.selRcId = null;
        applyList(list, "Deleted");
    }
    function rippleDel() { deleteSel(); }
    function liftDel() { deleteSel(); }
    function selectSeg(seg) {
        st.selRcId = seg ? seg.rcId : null;
        render();
    }
    function movePlayhead(t) {
        st.playhead = Math.max(0, t);
        render();
        if (st.group && st.group.precompId != null) callJSX("azSetCompTime", [st.group.precompId, st.playhead], function () {});
    }

    // ---- transport: local clock drives the panel playhead ------------------
    function togglePlay() { if (st.playing) stopPlay(); else startPlay(); }
    function startPlay() {
        if (!st.group) return;
        st.playing = true;
        st.playT0 = st.playhead;
        st.playWall = performance.now();
        var b = $("btnPlay"); if (b) b.textContent = "⏸";
        tick();
    }
    function stopPlay() {
        st.playing = false;
        if (st.playRAF) { cancelAnimationFrame(st.playRAF); st.playRAF = 0; }
        var b = $("btnPlay"); if (b) b.textContent = "▶";
    }
    function tick() {
        if (!st.playing) return;
        var now = performance.now();
        st.playhead = st.playT0 + (now - st.playWall) / 1000;
        var end = (st.group.compDuration || contentEnd());
        if (st.playhead >= end) { st.playhead = end; render(); stopPlay(); return; }
        render();
        st.playRAF = requestAnimationFrame(tick);
    }

    // ---- mouse ------------------------------------------------------------
    function lx(ev) { return ev.clientX - canvas.getBoundingClientRect().left; }
    function ly(ev) { return ev.clientY - canvas.getBoundingClientRect().top; }

    canvas.addEventListener("dblclick", function (ev) {
        if (!st.group) return;
        if (ly(ev) < RULER_H) return;   // double-click a clip to rename the precomp
        renamePrecomp();
    });
    canvas.addEventListener("mousedown", function (ev) {
        if (!st.group) return;
        var x = lx(ev), y = ly(ev), t = xToTime(x), onRuler = y < RULER_H;
        // middle mouse = pan (hand), never move clips
        if (ev.button === 1) { ev.preventDefault(); drag = { type: "hand", x: x, start: st.view.start }; return; }
        if (ev.button !== 0) return;   // ignore right button
        if (st.tool === "hand") { drag = { type: "hand", x: x, start: st.view.start }; return; }
        if (st.tool === "zoom") { zoomAt(x, ev.altKey ? 1 / 1.5 : 1.5); return; }
        if (st.tool === "razor" && !onRuler) { cutAt(t); return; }
        // pointer: trim if grabbing a clip edge
        if (!onRuler) {
            var eh = edgeHit(x, y);
            if (eh && !st.track.locked && !eh.seg.locked) {
                selectSeg(eh.seg);
                drag = { type: "trim", edge: eh.edge, rcId: eh.seg.rcId,
                         startTime: eh.seg.startTime, sourceDur: st.group.sourceDuration || eh.seg.srcOut };
                return;
            }
        }
        if (onRuler) { movePlayhead(t); drag = { type: "scrub" }; return; }
        var seg = segAtTime(t);
        if (seg && !st.track.locked && !seg.locked) {
            selectSeg(seg);
            drag = { type: "move", index: seg.index, rcId: seg.rcId, grab: t - seg.inPoint,
                     origIn: seg.inPoint, origOut: seg.outPoint, origStart: seg.startTime,
                     downX: x, downT: t, moved: false };
        } else if (seg) {
            selectSeg(seg); movePlayhead(t); drag = { type: "scrub" };
        } else {
            selectSeg(null); movePlayhead(t); drag = { type: "scrub" };
        }
    });
    window.addEventListener("mousemove", function (ev) {
        st.hoverX = lx(ev);
        if (drag) {
            if (drag.type === "hand") { st.view.start = drag.start - (lx(ev) - drag.x) / st.view.pps; render(); return; }
            if (drag.type === "scrub") { movePlayhead(xToTime(lx(ev))); return; }
            if (drag.type === "move") {
                var mx = lx(ev), t2 = xToTime(mx);
                if (Math.abs(mx - drag.downX) > 3) drag.moved = true;
                if (drag.moved) {
                    var newIn = t2 - drag.grab;
                    if (st.snap) { var fr = st.group.frameRate; newIn = Math.round(newIn * fr) / fr; }
                    if (newIn < 0) newIn = 0;
                    var d = newIn - drag.origIn;
                    var seg = segByRc(drag.rcId);
                    if (seg) { seg.inPoint = drag.origIn + d; seg.outPoint = drag.origOut + d; seg.startTime = drag.origStart + d; render(); }
                }
                return;
            }
            if (drag.type === "trim") {
                var tx = xToTime(lx(ev));
                if (st.snap) { var f = st.group.frameRate; tx = Math.round(tx * f) / f; }
                var g = segByRc(drag.rcId); if (!g) return;
                var minDur = 1 / st.group.frameRate;
                if (drag.edge === "in") {
                    if (tx < drag.startTime) tx = drag.startTime;            // srcIn >= 0
                    if (tx > g.outPoint - minDur) tx = g.outPoint - minDur;
                    g.inPoint = tx; g.srcIn = tx - drag.startTime;
                } else {
                    if (tx < g.inPoint + minDur) tx = g.inPoint + minDur;
                    var maxOut = drag.startTime + drag.sourceDur;            // srcOut <= source length
                    if (tx > maxOut) tx = maxOut;
                    g.outPoint = tx; g.srcOut = tx - drag.startTime;
                }
                g.duration = g.outPoint - g.inPoint; drag.moved = true; render(); return;
            }
            if (drag.type === "sbar") {
                var dx = ev.clientX - drag.x0;
                var w = cssW(); var cS = contentStart(), cE = contentEnd();
                var pad = (cE - cS) * 0.1 + 1, total = (cE - cS) + pad * 2;
                st.view.start = drag.start0 + (dx / w) * total; render(); return;
            }
        } else if (st.tool === "pointer" && st.group) {
            canvas.style.cursor = edgeHit(lx(ev), ly(ev)) ? "ew-resize" : "";   // AE-style trim cursor
        }
        if (st.tool === "razor") render();
    });
    window.addEventListener("mouseup", function () {
        if (drag && drag.type === "move" && drag.moved) applyList(listFromSegments(), "Moved");
        else if (drag && drag.type === "move") movePlayhead(drag.downT);
        else if (drag && drag.type === "trim" && drag.moved) applyList(listFromSegments(), "Trimmed");
        drag = null;
    });
    canvas.addEventListener("mouseleave", function () { st.hoverX = -1; if (st.tool === "razor") render(); });
    wrap.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        if (ev.ctrlKey || ev.metaKey) zoomAt(lx(ev), ev.deltaY < 0 ? 1.15 : 1 / 1.15);
        else { st.view.start += (ev.deltaX || ev.deltaY) / st.view.pps * 0.5; render(); }
    }, { passive: false });

    scrollThumb.addEventListener("mousedown", function (ev) {
        ev.stopPropagation();
        drag = { type: "sbar", x0: ev.clientX, start0: st.view.start };
    });

    // ---- buttons / keys ---------------------------------------------------
    $("logClose").addEventListener("click", function () { logPanelEl.classList.add("hidden"); });
    $("logClear").addEventListener("click", function () { logLines = []; logBodyEl.value = ""; });
    $("logCopy").addEventListener("click", function () {
        logBodyEl.focus(); logBodyEl.select();
        try { document.execCommand("copy"); toast("Log copied"); } catch (e) { toast("Copy failed", true); }
    });

    document.addEventListener("keydown", function (ev) {
        if (ev.target && (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA")) return;
        var k = ev.key.toLowerCase();
        if (k === "k" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); cutAtPlayhead(); return; }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (k === "v") setTool("pointer");
        else if (k === "c") setTool("razor");
        else if (k === "h") setTool("hand");
        else if (k === "f") fit();
        else if (k === "=" || k === "+") zoomAt(cssW() / 2, 1.3);
        else if (k === "-") zoomAt(cssW() / 2, 1 / 1.3);
    });

    // ---- playhead poll: follow AE's CTI in the precomp ---------------------
    // Works while the precomp is open (Show Waveform opens it). AE suspends
    // scripts during preview playback, so the playhead catches up on stop.
    var pollInflight = false;
    setInterval(function () {
        if (!st.group || st.group.precompId == null || drag || pollInflight || st.playing) return;
        pollInflight = true;
        callJSX("azGetCompTime", [st.group.precompId], function (res) {
            pollInflight = false;
            if (res && res.success && Math.abs(res.time - st.playhead) > 0.0005) { st.playhead = res.time; render(); }
        });
    }, 80);

    // ---- state-change poll: catch AE undo/redo and refresh the clips -------
    var refreshInflight = false;
    setInterval(function () {
        if (!st.group || st.group.precompId == null || drag || st.playing || refreshInflight) return;
        refreshInflight = true;
        callJSX("getPrecompState", [st.group.precompId], function (res) {
            refreshInflight = false;
            if (!res || !res.success) return;
            var sig = stateSig(res.segments);
            if (sig !== st.lastSig) applyGroup(res, false);   // layers changed in AE (undo/redo) → refresh
        });
    }, 500);

    // ---- init -------------------------------------------------------------
    buildPalette();
    setTool("pointer");
    resize();
    // auto-load an existing Audizy precomp in the active comp (no selection needed)
    callJSX("azAutoDetect", [], function (res) { if (res && res.success) applyGroup(res, true); });
})();
