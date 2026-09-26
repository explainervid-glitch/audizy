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
    var RULER_H = 20, LANE_H = 48, SCROLL_H = 16, LANE_TOP = 24;
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
        playhead: 0, sel: [], hoverX: -1, snap: true,   // sel = selected clip rcIds
        snapClip: true, snapPlayhead: true,   // magnetic snapping toggles
        track: { muted: false, solo: false, locked: false },
        playing: false, playT0: 0, playWall: 0, lastPush: 0, playRAF: 0,
        vgain: 1,          // vertical (amplitude) zoom
        peakCache: {},     // sourcePath -> envelope data | null  (multi-file safe)
        peakReq: {}        // sourcePath -> true (load requested/in-flight)
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
    // ---- selection (multi) ------------------------------------------------
    function isSel(rcId) { for (var i = 0; i < st.sel.length; i++) if (st.sel[i] === rcId) return true; return false; }
    function selSegs() {                                  // selected segments, timeline order
        if (!st.group) return [];
        var out = [], s = st.group.segments;
        for (var i = 0; i < s.length; i++) if (isSel(s[i].rcId)) out.push(s[i]);
        return out;
    }
    function selSeg() { var a = selSegs(); return a.length ? a[0] : null; }
    function setSel(ids) { st.sel = ids || []; }
    function toggleSel(rcId) {
        for (var i = 0; i < st.sel.length; i++) if (st.sel[i] === rcId) { st.sel.splice(i, 1); return; }
        st.sel.push(rcId);
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

    // ---- magnetic snapping ------------------------------------------------
    var SNAP_PX = 8;                                   // grab radius in pixels
    function snapThr() { return SNAP_PX / st.view.pps; }
    function clipEdges(excludeRcId) {                  // in/out of every other clip
        var out = [], segs = st.group ? st.group.segments : [], i;
        for (i = 0; i < segs.length; i++) {
            if (excludeRcId && segs[i].rcId === excludeRcId) continue;
            out.push(segs[i].inPoint); out.push(segs[i].outPoint);
        }
        return out;
    }
    function clipEdgesExcept(ids) {                    // edges of every clip not in ids
        var out = [], segs = st.group ? st.group.segments : [], i, j, skip;
        for (i = 0; i < segs.length; i++) {
            skip = false;
            for (j = 0; j < ids.length; j++) if (segs[i].rcId === ids[j]) { skip = true; break; }
            if (skip) continue;
            out.push(segs[i].inPoint); out.push(segs[i].outPoint);
        }
        return out;
    }
    function snapNearest(v, targets) {                 // snap v to closest target within thr
        var thr = snapThr(), best = v, bd = thr, i;
        for (i = 0; i < targets.length; i++) {
            var d = Math.abs(targets[i] - v);
            if (d < bd) { bd = d; best = targets[i]; }
        }
        return best;
    }
    function playheadSnap(t) {                          // playhead → clip edges
        if (!st.snapPlayhead || !st.group) return t;
        return snapNearest(t, clipEdges(null));
    }

    // ---- per-source waveform cache (each clip draws its own file) ----------
    function requestPeaks(path) {
        if (!path || st.peakReq[path]) return;
        st.peakReq[path] = true;
        window.AudizyWave.getPeaks(extRoot, path, function (data) {
            st.peakCache[path] = data || null;
            if (!data) toast("Waveform: " + (window.AudizyWave.lastError() || "decode failed"), true);
            render();
        });
    }
    function peaksFor(seg) {
        var p = seg && seg.sourcePath;
        if (!p) return null;
        if (st.peakCache.hasOwnProperty(p)) return st.peakCache[p];
        requestPeaks(p);
        return null;
    }

    // ---- palette ----------------------------------------------------------
    function paletteAction(id, icon, label, handler) {
        var b = document.createElement("button");
        b.id = id; b.className = "tool-btn"; b.title = label;   // native tooltip
        b.innerHTML = window.AudizyIcons[icon] + '<span class="tool-tooltip">' + label + '</span>';
        b.addEventListener("click", handler);
        return b;
    }
    function buildPalette() {
        var pal = $("palette"); pal.innerHTML = "";
        var grid = document.createElement("div"); grid.className = "palette-tools";
        grid.appendChild(paletteAction("btnLog", "log", "Log", function () { logPanelEl.classList.toggle("hidden"); }));
        grid.appendChild(paletteAction("btnLoad", "precompose", "Precompose / load audio", load));
        var play = document.createElement("button");
        play.id = "btnPlay"; play.className = "tool-btn"; play.innerHTML = window.AudizyIcons.play;
        play.title = "Play / Stop (Space)";
        play.addEventListener("click", togglePlay);
        grid.appendChild(play);
        grid.appendChild(paletteAction("btnExtract", "extract", "Extract clip to parent comp", extractSel));
        grid.appendChild(paletteAction("btnInsert", "insert", "Insert: select an audio layer + a precomp layer", insertSel));
        var divider = document.createElement("div"); divider.className = "palette-divider";
        grid.appendChild(divider);
        for (var i = 0; i < TOOLS.length; i++) {
            (function (tool) {
                var b = document.createElement("button");
                b.className = "tool-btn" + (tool.id === st.tool ? " active" : "");
                b.setAttribute("data-tool", tool.id);
                b.title = tool.label + " (" + tool.key + ")";   // native tooltip
                b.innerHTML = window.AudizyIcons[tool.icon] +
                    '<span class="tool-tooltip">' + tool.label +
                    '<span class="tool-tooltip-shortcut">' + tool.key + '</span></span>';
                b.addEventListener("click", function () { setTool(tool.id); });
                grid.appendChild(b);
            })(TOOLS[i]);
        }
        var div2 = document.createElement("div"); div2.className = "palette-divider";
        grid.appendChild(div2);
        grid.appendChild(makeToggle("snapClip", "magnet", "Clip Snapping", st.snapClip,
            function (on) { st.snapClip = on; }));
        grid.appendChild(makeToggle("snapHead", "magnetHead", "Playhead Snapping", st.snapPlayhead,
            function (on) { st.snapPlayhead = on; }));
        pal.appendChild(grid);
    }
    function makeToggle(id, icon, label, initial, fn) {
        var b = document.createElement("button");
        b.id = id; b.className = "tool-btn" + (initial ? " active" : ""); b.title = label;   // native tooltip
        b.innerHTML = window.AudizyIcons[icon] + '<span class="tool-tooltip">' + label + '</span>';
        var on = initial;
        b.addEventListener("click", function () { on = !on; b.classList.toggle("active", on); fn(on); });
        return b;
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
        drawMarquee();
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
        var sel = isSel(seg.rcId);
        var y = LANE_TOP + 2, hh = LANE_H - 4;
        ctx.fillStyle = !seg.audioEnabled ? "#3a2e2e" : (sel ? "#3f6da0" : "#2f4a63");
        ctx.fillRect(x0, y, w, hh);
        var pk = peaksFor(seg);
        if (pk) {
            window.AudizyWave.drawPeaksRange(ctx, pk, seg.srcIn, seg.srcOut,
                x0 + 1, y + 2, w - 2, hh - 4, sel ? "#cfe6ff" : "#8fc4ff", 1.6 * st.vgain);
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
        ctx.fillStyle = "#dcdcdc";
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.font = "9px Consolas, monospace"; ctx.lineWidth = 1;
        for (var t = t0; timeToX(t) < w; t += step) {
            var x = timeToX(t); if (x < -50) continue;
            ctx.beginPath(); ctx.moveTo(x + 0.5, ry); ctx.lineTo(x + 0.5, ry + 4); ctx.stroke();
            ctx.fillText(fmt(t), x + 3, ry + 13);
        }
    }
    function drawPlayhead(h) {
        var x = timeToX(st.playhead);
        ctx.strokeStyle = css("--color-playhead"); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); ctx.stroke();
        ctx.fillStyle = css("--color-playhead");
        ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.closePath(); ctx.fill();
    }
    function drawMarquee() {
        if (!drag || drag.type !== "marquee" || !drag.moved) return;
        var x0 = Math.min(drag.x0, drag.x), x1 = Math.max(drag.x0, drag.x);
        ctx.fillStyle = "rgba(74,158,255,0.18)";
        ctx.fillRect(x0, LANE_TOP, x1 - x0, LANE_H);
        ctx.strokeStyle = css("--color-focus"); ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, LANE_TOP + 0.5, x1 - x0 - 1, LANE_H - 1);
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
        if (st.sel.length) {                              // drop ids that no longer exist
            var keep = [], segsNow = res.segments || [], a, b;
            for (a = 0; a < st.sel.length; a++)
                for (b = 0; b < segsNow.length; b++)
                    if (segsNow[b].rcId === st.sel[a]) { keep.push(st.sel[a]); break; }
            st.sel = keep;
        }
        emptyEl.classList.add("hidden"); timelineEl.classList.remove("hidden");
        // request a waveform for every clip's own source (multi-file safe)
        var segs = res.segments || [];
        for (var i = 0; i < segs.length; i++) requestPeaks(segs[i].sourcePath);
        resize();
        if (doFit) fit();
    }
    function load() {
        callJSX("azNeedsPrecompose", [], function (chk) {
            var name = "";
            if (chk && chk.precompose) {   // fresh audio → ask a name; loading existing → no dialog
                name = window.prompt("Precomp name:", "Audizy - Audio");
                if (name === null) return;
            }
            callJSX("precomposeSelectedAudio", [name], function (res) { applyGroup(res, true); });
        });
    }
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
            list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint, name: segs[i].name, src: segs[i].sourcePath });
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
                list.segments.push({ id: uuidjs(), srcIn: segs[i].srcIn, srcOut: srcSplit, compIn: segs[i].inPoint, name: segs[i].name, src: segs[i].sourcePath });
                list.segments.push({ id: uuidjs(), srcIn: srcSplit, srcOut: segs[i].srcOut, compIn: mid, name: segs[i].name, src: segs[i].sourcePath });
            } else list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint, name: segs[i].name, src: segs[i].sourcePath });
        }
        applyList(list, "Cut");
    }
    function cutAtPlayhead() { cutAt(st.playhead); }
    function deleteSel() {
        var picked = selSegs(); if (!picked.length) { toast("Select a clip first", true); return; }
        var segs = st.group.segments;
        if (picked.length >= segs.length) { toast("Can't delete every clip", true); return; }
        var list = { v: 1, segments: [] };
        for (var i = 0; i < segs.length; i++) if (!isSel(segs[i].rcId))
            list.segments.push({ id: segs[i].rcId, srcIn: segs[i].srcIn, srcOut: segs[i].srcOut, compIn: segs[i].inPoint, name: segs[i].name, src: segs[i].sourcePath });
        st.sel = [];
        applyList(list, picked.length > 1 ? "Deleted " + picked.length + " clips" : "Deleted");
    }
    function rippleDel() { deleteSel(); }
    function liftDel() { deleteSel(); }
    // Extract selected clips out of the precomp into its parent comp, same time.
    function extractSel() {
        if (!st.group || st.group.precompId == null) { toast("Load a precomp first", true); return; }
        var picked = selSegs(); if (!picked.length) { toast("Select a clip first", true); return; }
        var ids = [];
        for (var i = 0; i < picked.length; i++) ids.push(picked[i].rcId);
        callJSX("azExtractClips", [st.group.precompId, JSON.stringify(ids)],
            afterEdit(ids.length > 1 ? "Extracted " + ids.length + " clips" : "Extracted to parent comp"));
    }
    // Insert: select an audio layer + a precomp layer in AE, then click. Moves the
    // audio into the chosen precomp at matching time (any precomp, not just Audizy).
    function insertSel() {
        callJSX("azInsertSelected", [], afterEdit("Inserted into precomp"));
    }
    function selectSeg(seg) {
        setSel(seg ? [seg.rcId] : []);
        render();
    }
    function selectAll() {
        if (!st.group) return;
        var ids = [], s = st.group.segments;
        for (var i = 0; i < s.length; i++) ids.push(s[i].rcId);
        setSel(ids); render();
    }
    /** Clips whose span intersects [t0,t1] — used by the marquee. */
    function segsInRange(t0, t1) {
        var out = [], s = st.group ? st.group.segments : [];
        for (var i = 0; i < s.length; i++) if (s[i].outPoint > t0 && s[i].inPoint < t1) out.push(s[i]);
        return out;
    }
    function movePlayhead(t) {
        st.playhead = Math.max(0, playheadSnap(t));
        render();
        if (st.group && st.group.precompId != null) callJSX("azSetCompTime", [st.group.precompId, st.playhead], function () {});
    }

    // ---- transport: panel drives playback (AE blocks scripts during preview) -
    // A Web Audio clock moves the playhead and plays the edited clips, so the
    // red line moves + you hear it, independent of AE.
    function togglePlay() { if (st.playing) stopPlay(); else startPlay(); }
    function setPlayBtn(key) { var b = $("btnPlay"); if (b) b.innerHTML = window.AudizyIcons[key]; }
    // load each unique source's AudioBuffer, then callback with {path: buffer}
    function loadBuffers(paths, done) {
        var out = {}, uniq = [], i;
        for (i = 0; i < paths.length; i++) if (paths[i] && uniq.indexOf(paths[i]) < 0) uniq.push(paths[i]);
        if (!uniq.length) { done(out); return; }
        var pending = uniq.length, finished = false;
        for (i = 0; i < uniq.length; i++) {
            (function (p) {
                window.AudizyWave.getBuffer(extRoot, p, function (buf) {
                    out[p] = buf || null;
                    if (--pending <= 0 && !finished) { finished = true; done(out); }
                });
            })(uniq[i]);
        }
    }
    function startPlay() {
        if (!st.group) return;
        var ctx = window.AudizyWave.context();
        if (!ctx) { toast("Audio unavailable", true); return; }
        try { ctx.resume(); } catch (e) {}
        var segs = st.group.segments, paths = [], i;
        for (i = 0; i < segs.length; i++) paths.push(segs[i].sourcePath);
        loadBuffers(paths, function (bufs) {
            st.playing = true;
            st.playCtx = ctx;
            st.playT0 = st.playhead;
            st.playCtxStart = ctx.currentTime;
            st.playSources = [];
            var any = false;
            for (var j = 0; j < segs.length; j++) {
                var s = segs[j];
                if (s.outPoint <= st.playhead) continue;   // already passed
                var buf = bufs[s.sourcePath];
                if (!buf) continue;
                any = true;
                var when, offset, dur;
                if (st.playhead <= s.inPoint) {            // starts later
                    when = st.playCtxStart + (s.inPoint - st.playT0);
                    offset = s.srcIn; dur = s.outPoint - s.inPoint;
                } else {                                   // playhead inside clip
                    when = st.playCtxStart;
                    offset = s.srcIn + (st.playhead - s.inPoint); dur = s.outPoint - st.playhead;
                }
                if (dur <= 0) continue;
                try {
                    var src = ctx.createBufferSource();
                    src.buffer = buf; src.connect(ctx.destination);
                    src.start(when, Math.max(0, offset), dur);
                    st.playSources.push(src);
                } catch (e) { log("play src: " + e); }
            }
            if (!any) toast("No audio buffer — moving playhead only", true);
            setPlayBtn("pause");
            tick();
        });
    }
    function stopPlay() {
        st.playing = false;
        if (st.playRAF) { cancelAnimationFrame(st.playRAF); st.playRAF = 0; }
        if (st.playSources) { for (var i = 0; i < st.playSources.length; i++) { try { st.playSources[i].stop(); } catch (e) {} } st.playSources = []; }
        setPlayBtn("play");
        if (st.group && st.group.precompId != null) callJSX("azSetCompTime", [st.group.precompId, st.playhead], function () {});
    }
    function tick() {
        if (!st.playing) return;
        st.playhead = st.playT0 + (st.playCtx.currentTime - st.playCtxStart);
        if (st.playhead < st.playT0) st.playhead = st.playT0;
        var end = st.group.groupEnd || st.group.compDuration || contentEnd();
        if (st.playhead >= end) { st.playhead = end; render(); stopPlay(); return; }
        render();
        st.playRAF = requestAnimationFrame(tick);
    }

    // ---- mouse ------------------------------------------------------------
    function lx(ev) { return ev.clientX - canvas.getBoundingClientRect().left; }
    function ly(ev) { return ev.clientY - canvas.getBoundingClientRect().top; }

    canvas.addEventListener("dblclick", function (ev) {
        if (!st.group) return;
        if (ly(ev) < RULER_H) return;
        var seg = segAtTime(xToTime(lx(ev)));   // double-click a clip to rename that layer
        if (!seg) return;
        var name = window.prompt("Rename clip:", seg.name || "");
        if (name === null) return;
        name = ("" + name).replace(/^\s+|\s+$/g, "");
        if (!name) { toast("Empty name", true); return; }
        callJSX("azRenameClip", [st.group.precompId, seg.rcId, name], afterEdit("Renamed"));
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
        var addMod = ev.ctrlKey || ev.metaKey || ev.shiftKey;   // add/remove from selection
        if (!onRuler) {
            var eh = edgeHit(x, y);
            if (eh && !st.track.locked && !eh.seg.locked) {
                if (!isSel(eh.seg.rcId)) selectSeg(eh.seg);      // trim always acts on one clip
                drag = { type: "trim", edge: eh.edge, rcId: eh.seg.rcId,
                         startTime: eh.seg.startTime, sourceDur: eh.seg.sourceDuration || st.group.sourceDuration || eh.seg.srcOut };
                return;
            }
        }
        if (onRuler) { movePlayhead(t); drag = { type: "scrub" }; return; }
        var seg = segAtTime(t);
        if (seg && addMod) { toggleSel(seg.rcId); render(); drag = null; return; }
        if (seg && !st.track.locked && !seg.locked) {
            if (!isSel(seg.rcId)) setSel([seg.rcId]);            // clicking a selected clip keeps the group
            render();
            var items = [], picked = selSegs(), k;
            for (k = 0; k < picked.length; k++)
                items.push({ rcId: picked[k].rcId, origIn: picked[k].inPoint, origOut: picked[k].outPoint, origStart: picked[k].startTime });
            drag = { type: "move", rcId: seg.rcId, grab: t - seg.inPoint,
                     origIn: seg.inPoint, origOut: seg.outPoint, items: items,
                     downX: x, downT: t, moved: false };
        } else if (seg) {
            selectSeg(seg); movePlayhead(t); drag = { type: "scrub" };
        } else {
            // empty lane: drag = marquee, plain click = scrub + clear selection
            drag = { type: "marquee", x0: x, y0: y, x: x, y: y, t0: t,
                     base: addMod ? st.sel.slice(0) : [], additive: addMod, downT: t, moved: false };
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
                    var movedIds = [], q;
                    for (q = 0; q < drag.items.length; q++) movedIds.push(drag.items[q].rcId);
                    if (st.snapClip) {                       // magnetic: snap in OR out edge to other clips / 0 / playhead
                        var segLen = drag.origOut - drag.origIn;
                        var tg = clipEdgesExcept(movedIds); tg.push(0); tg.push(st.playhead);
                        var thr = snapThr(), bestDelta = 0, bd = thr, m;
                        for (m = 0; m < tg.length; m++) {
                            var di = tg[m] - newIn; if (Math.abs(di) < bd) { bd = Math.abs(di); bestDelta = di; }
                            var doo = tg[m] - (newIn + segLen); if (Math.abs(doo) < bd) { bd = Math.abs(doo); bestDelta = doo; }
                        }
                        newIn += bestDelta;
                    }
                    var d = newIn - drag.origIn;
                    var minIn = drag.items[0].origIn;        // keep the whole group at t >= 0
                    for (q = 1; q < drag.items.length; q++) if (drag.items[q].origIn < minIn) minIn = drag.items[q].origIn;
                    if (minIn + d < 0) d = -minIn;
                    for (q = 0; q < drag.items.length; q++) {
                        var it = drag.items[q], sg = segByRc(it.rcId);
                        if (!sg) continue;
                        sg.inPoint = it.origIn + d; sg.outPoint = it.origOut + d; sg.startTime = it.origStart + d;
                    }
                    render();
                }
                return;
            }
            if (drag.type === "marquee") {
                drag.x = lx(ev); drag.y = ly(ev);
                if (Math.abs(drag.x - drag.x0) > 3) drag.moved = true;
                if (drag.moved) {
                    var ta = Math.min(drag.t0, xToTime(drag.x)), tb = Math.max(drag.t0, xToTime(drag.x));
                    var hit = segsInRange(ta, tb), ids = drag.base.slice(0), h, j2, dup;
                    for (h = 0; h < hit.length; h++) {
                        dup = false;
                        for (j2 = 0; j2 < ids.length; j2++) if (ids[j2] === hit[h].rcId) { dup = true; break; }
                        if (!dup) ids.push(hit[h].rcId);
                    }
                    setSel(ids); render();
                }
                return;
            }
            if (drag.type === "trim") {
                var tx = xToTime(lx(ev));
                if (st.snap) { var f = st.group.frameRate; tx = Math.round(tx * f) / f; }
                if (st.snapClip) { var tt = clipEdges(drag.rcId); tt.push(0); tt.push(st.playhead); tx = snapNearest(tx, tt); }
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
        else if (drag && drag.type === "marquee" && !drag.moved) {
            if (!drag.additive) setSel([]);                // plain click on empty lane = clear + scrub
            movePlayhead(drag.downT);
        }
        drag = null;
        render();
    });
    canvas.addEventListener("mouseleave", function () { st.hoverX = -1; if (st.tool === "razor") render(); });
    wrap.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        if (ev.altKey) {   // vertical (amplitude) zoom
            st.vgain *= (ev.deltaY < 0 ? 1.15 : 1 / 1.15);
            if (st.vgain < 0.2) st.vgain = 0.2; if (st.vgain > 12) st.vgain = 12;
            render();
        } else if (ev.ctrlKey || ev.metaKey) zoomAt(lx(ev), ev.deltaY < 0 ? 1.15 : 1 / 1.15);
        else { st.view.start += (ev.deltaX || ev.deltaY) / st.view.pps * 0.5; render(); }
    }, { passive: false });

    scrollThumb.addEventListener("mousedown", function (ev) {
        ev.stopPropagation();
        drag = { type: "sbar", x0: ev.clientX, start0: st.view.start };
    });

    // ---- drag & drop: drop an audio file onto the timeline ----------------
    function dropHint(on) { wrap.style.boxShadow = on ? "inset 0 0 0 2px var(--color-focus)" : ""; }
    wrap.addEventListener("dragenter", function (ev) { ev.preventDefault(); dropHint(true); });
    wrap.addEventListener("dragover", function (ev) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
        dropHint(true);
    });
    wrap.addEventListener("dragleave", function (ev) { if (ev.target === wrap) dropHint(false); });
    wrap.addEventListener("drop", function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        dropHint(false);
        if (!st.group || st.group.precompId == null) { toast("Precompose audio first, then drop files", true); return; }
        var dt = ev.dataTransfer, path = "";
        if (dt && dt.files && dt.files.length) path = dt.files[0].path || "";   // CEF exposes OS path
        if (!path) { toast("Could not read dropped file path", true); return; }
        var x = ev.clientX - canvas.getBoundingClientRect().left;
        var t = Math.max(0, xToTime(x));
        if (st.snap && st.group.frameRate) t = Math.round(t * st.group.frameRate) / st.group.frameRate;
        callJSX("azAddAudioFile", [st.group.precompId, path, t], afterEdit("Added clip"));
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
        if (k === "a" && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); selectAll(); return; }
        if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
        if (ev.key === "Escape") { setSel([]); render(); return; }
        if (ev.key === " " || k === "spacebar") { ev.preventDefault(); togglePlay(); return; }
        if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSel(); return; }
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
        // Follow AE's CTI (mapped from the active comp through the precomp layer).
        if (!st.group || st.group.precompId == null || drag || pollInflight || st.playing) return;
        pollInflight = true;
        callJSX("azGetCompTime", [st.group.precompId], function (res) {
            pollInflight = false;
            if (res && res.success && Math.abs(res.time - st.playhead) > 0.0005) { st.playhead = res.time; render(); }
        });
    }, 150);

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
    }, 1200);

    // ---- init -------------------------------------------------------------
    buildPalette();
    setTool("pointer");
    resize();
    // auto-load an existing Audizy precomp in the active comp (no selection needed)
    callJSX("azAutoDetect", [], function (res) { if (res && res.success) applyGroup(res, true); });
})();
