/**
 * Audizy waveform module (ported from AudiMate's approach).
 * Reads the audio file via CEP's cep.fs.readFile (Base64) — more reliable in
 * CEP than Node fs — falls back to Node fs. Decodes with Web Audio, stores a
 * min/max envelope per bucket, and draws the real waveform shape (not just
 * symmetric bars).
 */
(function () {
    "use strict";

    var HIRES = 16000;     // envelope buckets per file (higher = smoother when zoomed)
    var cache = {};        // path -> { mins, maxs, duration }
    var pending = {};      // path -> [cb,...]
    var lastError = "";

    var fs = null;
    try { fs = require("fs"); } catch (e) { fs = null; }

    var actx = null;
    function audioCtx() {
        if (actx) return actx;
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { actx = new AC(); } catch (e) { actx = null; }
        return actx;
    }

    function b64ToArrayBuffer(b64) {
        var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes.buffer;
    }

    /** Read a file to ArrayBuffer: CEP fs (Base64) first, then Node fs. */
    function readArrayBuffer(filePath) {
        // CEP fs
        try {
            if (window.cep && window.cep.fs && window.cep.fs.readFile) {
                var enc = (window.cep.encoding && window.cep.encoding.Base64) || "Base64";
                var r = window.cep.fs.readFile(filePath, enc);
                if (r && (r.err === 0 || r.err === undefined) && r.data) return b64ToArrayBuffer(r.data);
                if (r && r.err) lastError = "cep.fs.readFile err " + r.err;
            }
        } catch (e) { lastError = "cep.fs read: " + e; }
        // Node fs fallback
        try {
            if (fs) {
                var buf = fs.readFileSync(filePath);
                return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            }
        } catch (e) { lastError = "fs read: " + e; }
        return null;
    }

    /** Min/max envelope per bucket, channels averaged. */
    function envelopeFromBuffer(audioBuf) {
        var ch = audioBuf.getChannelData(0);
        var n = audioBuf.numberOfChannels;
        var ch2 = n > 1 ? audioBuf.getChannelData(1) : null;
        var total = ch.length;
        if (total < 1) return null;
        var bucket = Math.max(1, Math.floor(total / HIRES));
        var mins = [], maxs = [], s = 0, i;
        while (s < total) {
            var end = Math.min(total, s + bucket), mn = 1, mx = -1;
            for (i = s; i < end; i++) {
                var v = ch[i]; if (ch2) v = (v + ch2[i]) / 2;
                if (v < mn) mn = v;
                if (v > mx) mx = v;
            }
            if (mn > mx) { mn = 0; mx = 0; }
            mins.push(mn); maxs.push(mx);
            s = end;
        }
        return { mins: mins, maxs: maxs, duration: audioBuf.duration };
    }

    function decode(filePath, done) {
        var ctx = audioCtx();
        if (!ctx) { lastError = "AudioContext unavailable"; done(null); return; }
        var ab = readArrayBuffer(filePath);
        if (!ab) { if (!lastError) lastError = "read failed"; done(null); return; }
        var settled = false;
        function ok(d) { if (settled) return; settled = true; done(d); }
        function keep(buf) {
            var d = null; try { d = envelopeFromBuffer(buf); } catch (e) { lastError = "envelope: " + e; }
            if (d) d.buffer = buf;   // keep AudioBuffer for playback
            ok(d);
        }
        try {
            var p = ctx.decodeAudioData(ab, keep,
                function (err) { lastError = "decode failed: " + (err && err.message ? err.message : err); ok(null); });
            if (p && typeof p.then === "function") {
                p.then(keep, function (err) { lastError = "decode failed: " + err; ok(null); });
            }
        } catch (e) { lastError = "decodeAudioData threw: " + e; ok(null); }
    }

    /** getPeaks(extRoot, path, cb) -> cb({mins,maxs,duration}|null). Cached, async. */
    function getPeaks(extRoot, filePath, cb) {
        if (!filePath) { cb(null); return; }
        if (cache[filePath]) { cb(cache[filePath]); return; }
        if (pending[filePath]) { pending[filePath].push(cb); return; }
        pending[filePath] = [cb];
        decode(filePath, function (data) {
            if (data) cache[filePath] = data;
            var cbs = pending[filePath]; delete pending[filePath];
            for (var i = 0; i < cbs.length; i++) cbs[i](data);
        });
    }

    /**
     * Draw the min/max envelope for source range [srcIn,srcOut] into rect
     * (x,y,w,h). gain scales amplitude (clamped to [-1,1]).
     */
    function drawPeaksRange(ctx, data, srcIn, srcOut, x, y, w, h, color, gain) {
        if (!data || !data.maxs || !data.maxs.length || data.duration <= 0) return;
        if (typeof gain !== "number" || gain <= 0) gain = 1;
        var mins = data.mins, maxs = data.maxs, dur = data.duration, len = maxs.length;
        var mid = y + h / 2, half = h / 2 - 1;
        var f0 = Math.max(0, srcIn / dur), f1 = Math.min(1, srcOut / dur);
        if (f1 <= f0) return;
        var p0 = f0 * len, p1 = f1 * len, span = p1 - p0;

        // sub-pixel columns for a smoother (non-voxel) shape
        var cols = Math.max(2, Math.floor(w * 2));
        var topY = new Array(cols), botY = new Array(cols), c;
        for (c = 0; c < cols; c++) {
            var a = p0 + (c / cols) * span, b = p0 + ((c + 1) / cols) * span;
            var ia = Math.floor(a), ib = Math.max(ia + 1, Math.floor(b));
            var mn = 1, mx = -1;
            for (var k = ia; k < ib && k < len; k++) { if (maxs[k] > mx) mx = maxs[k]; if (mins[k] < mn) mn = mins[k]; }
            if (mn > mx) { mn = 0; mx = 0; }
            var vmx = mx * gain; if (vmx > 1) vmx = 1;
            var vmn = mn * gain; if (vmn < -1) vmn = -1;
            topY[c] = mid - vmx * half * 0.95;
            botY[c] = mid - vmn * half * 0.95;
        }
        // filled envelope: top edge left→right, bottom edge right→left
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(x, topY[0]);
        for (c = 1; c < cols; c++) ctx.lineTo(x + (c / cols) * w, topY[c]);
        for (c = cols - 1; c >= 0; c--) ctx.lineTo(x + (c / cols) * w, botY[c]);
        ctx.closePath();
        ctx.fill();
    }

    window.AudizyWave = {
        available: function () { return !!((window.cep && window.cep.fs) || fs); },
        lastError: function () { return lastError; },
        getPeaks: getPeaks,
        getBuffer: function (extRoot, path, cb) { getPeaks(extRoot, path, function (d) { cb(d ? d.buffer : null); }); },
        context: function () { return audioCtx(); },
        drawPeaksRange: drawPeaksRange
    };
})();
