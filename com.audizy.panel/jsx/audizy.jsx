/**
 * Audizy - ExtendScript backend (runs inside After Effects, ES3).
 * Audio-only NLE core distilled from Railcut: rcId identity, group id,
 * frame-snapped split, ripple/lift delete, segment move, audio dB.
 *
 * ES3 only — no const/let/arrow/template-literals.
 */

// ============================================
// JSON polyfill (ExtendScript has no native JSON)
// ============================================
if (typeof JSON === "undefined") { JSON = {}; }
if (typeof JSON.parse !== "function") {
    JSON.parse = function (s) { return eval("(" + s + ")"); };
}
if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (v) {
        var t = typeof v;
        if (v === null) return "null";
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return String(v);
        if (t === "string") {
            return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
                .replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
        }
        var i, out = [];
        if (v instanceof Array) {
            for (i = 0; i < v.length; i++) out.push(JSON.stringify(v[i]));
            return "[" + out.join(",") + "]";
        }
        if (t === "object") {
            for (var k in v) {
                if (v.hasOwnProperty(k) && typeof v[k] !== "undefined" && typeof v[k] !== "function") {
                    out.push(JSON.stringify(k) + ":" + JSON.stringify(v[k]));
                }
            }
            return "{" + out.join(",") + "}";
        }
        return "null";
    };
}

// ============================================
// Result helpers
// ============================================
function makeResult(success, error) {
    var r = { success: success };
    if (error) r.error = error;
    return JSON.stringify(r);
}
function ok(extra) {
    var r = { success: true };
    if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k]; }
    return JSON.stringify(r);
}
function snapToFrame(time, frameRate) { return Math.round(time * frameRate) / frameRate; }

// ============================================
// Active comp (cached fallback when panel has focus)
// ============================================
var _lastCompId = 0;
function getActiveComp() {
    var comp = app.project.activeItem;
    if (comp && comp instanceof CompItem) { _lastCompId = comp.id; return comp; }
    if (_lastCompId > 0) {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem && item.id === _lastCompId) return item;
        }
    }
    return null;
}
function getAudioLevelsProperty(layerIndex) {
    var comp = getActiveComp();
    if (!comp) return { error: "No active composition" };
    var layer = comp.layer(layerIndex);
    if (!layer || !layer.hasAudio) return { error: "Layer " + layerIndex + " has no audio" };
    var al = layer.property("ADBE Audio Group").property("ADBE Audio Levels");
    if (!al) return { error: "Cannot access audio levels property" };
    return { comp: comp, layer: layer, audioLevels: al };
}

// ============================================
// rcId (per-layer identity) + group id (links segments from one loaded clip)
// Stored in layer.comment: [RC:uuid] and [RG:uuid]
// ============================================
var RC_TAG_RE = /\[RC:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;
var RG_TAG_RE = /\[RG:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

function uuid() {
    var hex = "0123456789abcdef", r = "", i;
    for (i = 0; i < 36; i++) {
        if (i === 8 || i === 13 || i === 18 || i === 23) r += "-";
        else if (i === 14) r += "4";
        else if (i === 19) r += hex.charAt((Math.random() * 4 | 0) + 8);
        else r += hex.charAt(Math.random() * 16 | 0);
    }
    return r;
}
function parseTag(re, comment) { if (!comment) return ""; var m = comment.match(re); return m ? m[1] : ""; }
function setTag(re, prefix, comment, id) {
    var tag = "[" + prefix + ":" + id + "]";
    if (!comment) return tag;
    if (re.test(comment)) return comment.replace(re, tag);
    return comment + "\n" + tag;
}
function parseRcId(c) { return parseTag(RC_TAG_RE, c); }
function parseGroup(c) { return parseTag(RG_TAG_RE, c); }
function ensureRcId(layer) {
    var id = parseRcId(layer.comment);
    if (!id) { id = uuid(); layer.comment = setTag(RC_TAG_RE, "RC", layer.comment, id); }
    return id;
}
function setGroup(layer, gid) { layer.comment = setTag(RG_TAG_RE, "RG", layer.comment, gid); }

// ============================================
// Diagnostics
// ============================================
function audizyPing() { return "Audizy connected. AE " + app.version; }

// ============================================
// Segment descriptor for the panel timeline.
// srcIn/srcOut = position inside the SOURCE file (seconds), for waveform slicing.
// ============================================
function describeSegment(L) {
    var stretch = 1;
    try { stretch = (L.stretch || 100) / 100; } catch (e) {}
    var srcIn = (L.inPoint - L.startTime) * stretch;
    var srcOut = (L.outPoint - L.startTime) * stretch;
    var src = null;
    try { if (L.source && L.source.mainSource && L.source.mainSource.file) src = L.source.mainSource.file.fsName; } catch (e) {}
    return {
        index: L.index,
        rcId: ensureRcId(L),
        name: L.name,
        inPoint: L.inPoint,
        outPoint: L.outPoint,
        startTime: L.startTime,
        duration: L.outPoint - L.inPoint,
        srcIn: srcIn,
        srcOut: srcOut,
        audioEnabled: L.audioEnabled,
        enabled: L.enabled,
        locked: L.locked,
        selected: L.selected,
        sourcePath: src
    };
}

// ============================================
// Load: take the selected audio layer, tag it into a group, return the
// group's timeline. If the selected layer already belongs to a group,
// the whole group loads (all its split segments).
// ============================================
function loadSelectedAudio() {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var chosen = null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (L.selected && L.hasAudio) { chosen = L; break; }
    }
    if (!chosen) return makeResult(false, "Select an audio layer in the timeline first");

    app.beginUndoGroup("Audizy: Load Audio");
    var gid;
    try {
        gid = parseGroup(chosen.comment);
        if (!gid) { gid = uuid(); setGroup(chosen, gid); }
        ensureRcId(chosen);
    } finally { app.endUndoGroup(); }

    return getAudioGroup(gid);
}

function getAudioGroup(groupId) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var segs = [], sourcePath = null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (!L.hasAudio) continue;
        if (parseGroup(L.comment) !== groupId) continue;
        var d = describeSegment(L);
        segs.push(d);
        if (!sourcePath && d.sourcePath) sourcePath = d.sourcePath;
    }
    if (!segs.length) return makeResult(false, "Group not found (segments deleted?)");

    // sort by comp inPoint ascending
    segs.sort(function (a, b) { return a.inPoint - b.inPoint; });
    var gStart = segs[0].inPoint, gEnd = segs[0].outPoint;
    for (var s = 0; s < segs.length; s++) {
        if (segs[s].inPoint < gStart) gStart = segs[s].inPoint;
        if (segs[s].outPoint > gEnd) gEnd = segs[s].outPoint;
    }
    return JSON.stringify({
        success: true,
        groupId: groupId,
        compName: comp.name,
        frameRate: comp.frameRate,
        compDuration: comp.duration,
        currentTime: comp.time,
        sourcePath: sourcePath,
        groupStart: gStart,
        groupEnd: gEnd,
        segments: segs
    });
}

// ============================================
// Selection / playhead
// ============================================
function selectSegment(layerIndex) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = comp.layer(layerIndex);
    if (!L) return makeResult(false, "Layer not found");
    for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    L.selected = true;
    return makeResult(true);
}
function getCurrentTime() {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    return ok({ time: comp.time });
}
function setCurrentTime(t) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    comp.time = snapToFrame(t, comp.frameRate);
    return ok({ time: comp.time });
}

// ============================================
// Internal helpers
// ============================================
function findGroupLayerByIndex(comp, groupId, layerIndex) {
    var L = comp.layer(layerIndex);
    if (!L) return null;
    if (parseGroup(L.comment) !== groupId) return null;
    return L;
}
/** Find the segment (layer) of a group whose comp span contains time t. */
function findSegmentAtTime(comp, groupId, t) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (!L.hasAudio) continue;
        if (parseGroup(L.comment) !== groupId) continue;
        if (t > L.inPoint && t < L.outPoint) return L;
    }
    return null;
}
/** Shift a layer in comp time by delta (moves startTime + in/out together). */
function shiftLayer(layer, d) {
    layer.startTime = layer.startTime + d;
    if (d < 0) { layer.inPoint = layer.inPoint + d; layer.outPoint = layer.outPoint + d; }
    else { layer.outPoint = layer.outPoint + d; layer.inPoint = layer.inPoint + d; }
}

// ============================================
// Cut — split the group's segment under time t
// ============================================
function splitGroupAtTime(groupId, t) {
    try {
        var comp = getActiveComp();
        if (!comp) return makeResult(false, "No active composition");
        var snapped = snapToFrame(t, comp.frameRate);
        var L = findSegmentAtTime(comp, groupId, snapped);
        if (!L) return makeResult(false, "No segment under the cut point");
        if (L.locked) return makeResult(false, "Segment is locked");

        app.beginUndoGroup("Audizy: Cut");
        var newRcId = "";
        try {
            var origOut = L.outPoint;
            L.outPoint = snapped;
            var nl = L.duplicate();
            nl.inPoint = snapped;
            nl.outPoint = origOut;
            newRcId = uuid();
            nl.comment = setTag(RC_TAG_RE, "RC", nl.comment, newRcId);
            setGroup(nl, groupId);
        } finally { app.endUndoGroup(); }
        return ok({ newRcId: newRcId });
    } catch (e) { return makeResult(false, e.toString()); }
}
/** Split at current playhead. */
function splitGroupAtPlayhead(groupId) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    return splitGroupAtTime(groupId, comp.time);
}

// ============================================
// Delete — ripple (close gap) or lift (leave gap)
// ============================================
function rippleDeleteSegment(groupId, layerIndex) {
    try {
        var comp = getActiveComp();
        if (!comp) return makeResult(false, "No active composition");
        var L = findGroupLayerByIndex(comp, groupId, layerIndex);
        if (!L) return makeResult(false, "Segment not found in group");
        if (L.locked) return makeResult(false, "Segment is locked");

        app.beginUndoGroup("Audizy: Ripple Delete");
        try {
            var delDur = L.outPoint - L.inPoint;
            var boundary = L.inPoint;
            // collect later segments (start at/after deleted out) BEFORE removing
            var laterRcIds = [];
            for (var i = 1; i <= comp.numLayers; i++) {
                var S = comp.layer(i);
                if (S === L) continue;
                if (!S.hasAudio) continue;
                if (parseGroup(S.comment) !== groupId) continue;
                if (S.inPoint >= boundary + delDur - 0.00001) laterRcIds.push(parseRcId(S.comment));
            }
            L.remove();
            // shift later segments left by delDur to close the gap
            for (var j = 0; j < laterRcIds.length; j++) {
                var T = findLayerByRcId(comp, laterRcIds[j]);
                if (T) shiftLayer(T, -delDur);
            }
        } finally { app.endUndoGroup(); }
        return makeResult(true);
    } catch (e) { return makeResult(false, e.toString()); }
}
function liftDeleteSegment(groupId, layerIndex) {
    try {
        var comp = getActiveComp();
        if (!comp) return makeResult(false, "No active composition");
        var L = findGroupLayerByIndex(comp, groupId, layerIndex);
        if (!L) return makeResult(false, "Segment not found in group");
        if (L.locked) return makeResult(false, "Segment is locked");
        app.beginUndoGroup("Audizy: Lift Delete");
        try { L.remove(); } finally { app.endUndoGroup(); }
        return makeResult(true);
    } catch (e) { return makeResult(false, e.toString()); }
}
function findLayerByRcId(comp, rcId) {
    if (!rcId) return null;
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (parseRcId(L.comment) === rcId) return L;
    }
    return null;
}

// ============================================
// Trim a segment edge to a comp time (drag handles in the panel)
// edge: "in" or "out"
// ============================================
function trimSegmentEdge(groupId, layerIndex, edge, t) {
    try {
        var comp = getActiveComp();
        if (!comp) return makeResult(false, "No active composition");
        var L = findGroupLayerByIndex(comp, groupId, layerIndex);
        if (!L) return makeResult(false, "Segment not found in group");
        if (L.locked) return makeResult(false, "Segment is locked");
        var snapped = snapToFrame(t, comp.frameRate);
        app.beginUndoGroup("Audizy: Trim");
        try {
            if (edge === "in") {
                if (snapped >= L.outPoint) return makeResult(false, "In must be before out");
                L.inPoint = snapped;
            } else {
                if (snapped <= L.inPoint) return makeResult(false, "Out must be after in");
                L.outPoint = snapped;
            }
        } finally { app.endUndoGroup(); }
        return makeResult(true);
    } catch (e) { return makeResult(false, e.toString()); }
}

// ============================================
// Move a segment in comp time by delta seconds (drag). Frame-snapped.
// ============================================
function moveSegmentBy(groupId, layerIndex, delta) {
    try {
        var comp = getActiveComp();
        if (!comp) return makeResult(false, "No active composition");
        var L = findGroupLayerByIndex(comp, groupId, layerIndex);
        if (!L) return makeResult(false, "Segment not found in group");
        if (L.locked) return makeResult(false, "Segment is locked");
        var target = snapToFrame(L.inPoint + delta, comp.frameRate);
        var d = target - L.inPoint;
        if (d === 0) return ok({ inPoint: L.inPoint });
        app.beginUndoGroup("Audizy: Move Segment");
        try { shiftLayer(L, d); } finally { app.endUndoGroup(); }
        return ok({ inPoint: L.inPoint, startTime: L.startTime });
    } catch (e) { return makeResult(false, e.toString()); }
}

// ============================================
// Audio level (dB) + fades
// ============================================
function setAudioLevelStatic(layerIndex, db) {
    var r = getAudioLevelsProperty(layerIndex);
    if (r.error) return makeResult(false, r.error);
    var al = r.audioLevels;
    app.beginUndoGroup("Audizy: Set Audio Level");
    try {
        for (var i = al.numKeys; i >= 1; i--) al.removeKey(i);
        al.setValue([db, db]);
    } finally { app.endUndoGroup(); }
    return makeResult(true);
}
function audioFade(layerIndex, dir, seconds, floorDb) {
    var r = getAudioLevelsProperty(layerIndex);
    if (r.error) return makeResult(false, r.error);
    var al = r.audioLevels, layer = r.layer;
    if (typeof floorDb !== "number") floorDb = -48;
    if (typeof seconds !== "number" || seconds <= 0) seconds = 0.5;
    app.beginUndoGroup("Audizy: Audio Fade " + dir);
    try {
        if (dir === "in") {
            al.setValueAtTime(layer.inPoint, [floorDb, floorDb]);
            al.setValueAtTime(layer.inPoint + seconds, [0, 0]);
        } else {
            al.setValueAtTime(layer.outPoint - seconds, [0, 0]);
            al.setValueAtTime(layer.outPoint, [floorDb, floorDb]);
        }
    } finally { app.endUndoGroup(); }
    return makeResult(true);
}
/** Set audioEnabled on every segment of a group (track-level mute). */
function setGroupMute(groupId, muted) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    app.beginUndoGroup("Audizy: Track Mute");
    try {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L.hasAudio && parseGroup(L.comment) === groupId) L.audioEnabled = !muted;
        }
    } finally { app.endUndoGroup(); }
    return ok({ muted: muted });
}
/** Lock/unlock every segment of a group (track-level lock). */
function setGroupLock(groupId, locked) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    app.beginUndoGroup("Audizy: Track Lock");
    try {
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            if (L.hasAudio && parseGroup(L.comment) === groupId) L.locked = locked;
        }
    } finally { app.endUndoGroup(); }
    return ok({ locked: locked });
}
function toggleSegmentMute(layerIndex) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = comp.layer(layerIndex);
    if (!L || !L.hasAudio) return makeResult(false, "No audio layer");
    app.beginUndoGroup("Audizy: Toggle Mute");
    try { L.audioEnabled = !L.audioEnabled; } finally { app.endUndoGroup(); }
    return ok({ audioEnabled: L.audioEnabled });
}

// ============================================
// Transport (drive AE playback from the panel)
// ============================================
function playComp() {
    try {
        var comp = getActiveComp();
        if (comp) { comp.openInViewer(); }
        // Menu command 2071 = "Play/Pause" ; fallback to time echo
        try { app.executeCommand(app.findMenuCommandId("Play/Stop")); } catch (e) {}
        return makeResult(true);
    } catch (e) { return makeResult(false, e.toString()); }
}

// ============================================================================
// TIME-REMAP EDIT ENGINE
// One audio layer = one "track". The edit list (ordered source spans) drives a
// single Time Remap curve — cuts/deletes/reorders never create new layers.
// Edit list persisted in layer.comment between <<AZ ... AZ>> sentinels.
// ============================================================================
var AZ_RE = /<<AZ ([\s\S]*?) AZ>>/;

function getAzData(comment) {
    if (!comment) return null;
    var m = comment.match(AZ_RE);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}
function setAzData(comment, obj) {
    var json = JSON.stringify(obj);
    var base = comment ? comment.replace(AZ_RE, "") : "";
    base = base.replace(/\s+$/, "");
    return base + "\n<<AZ " + json + " AZ>>";
}
function azSrcPath(L) {
    try { if (L.source && L.source.mainSource && L.source.mainSource.file) return L.source.mainSource.file.fsName; }
    catch (e) {}
    return null;
}

/** Write the Time Remap curve (+ declick fades) from an edit list. */
function azApplyRemap(comp, L, data, declick) {
    var fr = comp.frameRate, fdur = 1 / fr, i, s;
    L.timeRemapEnabled = true;
    var tr = L.property("ADBE Time Remapping");
    for (i = tr.numKeys; i >= 1; i--) tr.removeKey(i);

    var segs = data.segments, tc = L.startTime, joins = [];
    for (s = 0; s < segs.length; s++) {
        var a = segs[s].srcIn, b = segs[s].srcOut, dur = b - a;
        if (dur <= 0.000001) continue;
        tr.setValueAtTime(tc, a);
        tc += dur;
        tr.setValueAtTime(tc, b);
        if (s < segs.length - 1) { joins.push(tc); tc += fdur; }
    }
    // slope 1 everywhere (linear both sides), then HOLD-out at each join
    for (i = 1; i <= tr.numKeys; i++)
        tr.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
    for (i = 0; i < joins.length; i++) {
        var k = tr.nearestKeyIndex(joins[i]);
        if (k > 0) tr.setInterpolationTypeAtKey(k, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.HOLD);
    }
    L.inPoint = L.startTime;
    L.outPoint = tc;

    // declick: 1-frame dip to -60 dB across every join
    var al = L.property("ADBE Audio Group").property("ADBE Audio Levels");
    for (i = al.numKeys; i >= 1; i--) al.removeKey(i);
    if (declick && joins.length) {
        al.setValueAtTime(L.startTime, [0, 0]);
        for (i = 0; i < joins.length; i++) {
            var jt = joins[i];
            al.setValueAtTime(jt - fdur, [0, 0]);
            al.setValueAtTime(jt, [-60, -60]);
            al.setValueAtTime(jt + fdur, [0, 0]);
        }
        al.setValueAtTime(tc, [0, 0]);
    } else {
        al.setValue([0, 0]);
    }
}

/** Build the panel payload: segments laid end-to-end in comp time. */
function azBuildState(comp, L, data) {
    var fr = comp.frameRate, fdur = 1 / fr, segs = data.segments, out = [], tc = L.startTime, s;
    var src = azSrcPath(L);
    for (s = 0; s < segs.length; s++) {
        var a = segs[s].srcIn, b = segs[s].srcOut, dur = b - a;
        out.push({
            rcId: segs[s].id, index: -1, name: L.name,
            inPoint: tc, outPoint: tc + dur, startTime: L.startTime, duration: dur,
            srcIn: a, srcOut: b, audioEnabled: L.audioEnabled, enabled: L.enabled,
            locked: L.locked, selected: L.selected, sourcePath: src
        });
        tc = tc + dur;
        if (s < segs.length - 1) tc += fdur;
    }
    return JSON.stringify({
        success: true, trackRcId: parseRcId(L.comment), groupId: parseRcId(L.comment),
        precompId: comp.id, compName: comp.name, frameRate: fr, compDuration: comp.duration, currentTime: comp.time,
        sourcePath: src, sourceDuration: (L.source && L.source.duration) ? L.source.duration : (tc - L.startTime),
        groupStart: L.startTime, groupEnd: tc, segments: out
    });
}

/**
 * Build panel state by reading the precomp's actual audio layers (each layer =
 * one clip). No Time Remap — layers are the source of truth and survive reload.
 */
function azStateFromComp(comp) {
    var segs = [], src = null, srcDur = 0, i;
    for (i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (!L.hasAudio) continue;
        ensureRcId(L);
        var p = azSrcPath(L);
        if (!src && p) src = p;
        if (!srcDur && L.source && L.source.duration) srcDur = L.source.duration;
        segs.push({
            rcId: parseRcId(L.comment), index: L.index, name: L.name,
            inPoint: L.inPoint, outPoint: L.outPoint, startTime: L.startTime,
            duration: L.outPoint - L.inPoint,
            srcIn: L.inPoint - L.startTime, srcOut: L.outPoint - L.startTime,
            audioEnabled: L.audioEnabled, enabled: L.enabled, locked: L.locked,
            selected: L.selected, sourcePath: p
        });
    }
    if (!segs.length) return makeResult(false, "No audio layer inside precomp");
    segs.sort(function (a, b) { return a.inPoint - b.inPoint; });
    var gStart = segs[0].inPoint, gEnd = segs[0].outPoint;
    for (i = 0; i < segs.length; i++) {
        if (segs[i].inPoint < gStart) gStart = segs[i].inPoint;
        if (segs[i].outPoint > gEnd) gEnd = segs[i].outPoint;
    }
    return JSON.stringify({
        success: true, precompId: comp.id, trackRcId: segs[0].rcId, groupId: comp.id,
        compName: comp.name, frameRate: comp.frameRate, compDuration: comp.duration, currentTime: comp.time,
        sourcePath: src, sourceDuration: srcDur || (gEnd - gStart),
        groupStart: gStart, groupEnd: gEnd, segments: segs
    });
}

/** Find a CompItem by id. */
function azCompById(id) {
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.id === id) return it;
    }
    return null;
}
/** Read the layer's edit list, seeding a single full-length segment if absent. */
function azSeedData(L) {
    var data = getAzData(L.comment);
    if (!data || !data.segments || !data.segments.length) {
        var srcDur = (L.source && L.source.duration) ? L.source.duration : (L.outPoint - L.startTime);
        var a = L.inPoint - L.startTime; if (a < 0) a = 0;
        var b = L.outPoint - L.startTime; if (b <= a || b > srcDur + 0.0001) b = srcDur;
        data = { v: 1, segments: [{ id: uuid(), srcIn: a, srcOut: b }] };
        L.comment = setAzData(L.comment, data);
    }
    return data;
}

function azLoadSelected() {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = null, i;
    for (i = 1; i <= comp.numLayers; i++) { var X = comp.layer(i); if (X.selected && X.hasAudio) { L = X; break; } }
    if (!L) return makeResult(false, "Select an audio layer first");
    app.beginUndoGroup("Audizy: Load (Time Remap)");
    var data;
    try {
        ensureRcId(L);
        data = getAzData(L.comment);
        if (!data || !data.segments || !data.segments.length) {
            var srcDur = (L.source && L.source.duration) ? L.source.duration : (L.outPoint - L.startTime);
            var a = L.inPoint - L.startTime; if (a < 0) a = 0;
            var b = L.outPoint - L.startTime; if (b <= a || b > srcDur + 0.0001) b = srcDur;
            data = { v: 1, segments: [{ id: uuid(), srcIn: a, srcOut: b }] };
        }
        azApplyRemap(comp, L, data, true);
        L.comment = setAzData(L.comment, data);
    } finally { app.endUndoGroup(); }
    return azBuildState(comp, L, data);
}

function azGetState(rcId) {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = findLayerByRcId(comp, rcId);
    if (!L) return makeResult(false, "Track layer not found");
    var data = getAzData(L.comment);
    if (!data) return makeResult(false, "No edit list on layer");
    return azBuildState(comp, L, data);
}

/**
 * Rebuild the precomp's audio layers from an edit list. Each segment becomes a
 * real layer of the source footage, trimmed to [srcIn,srcOut] and laid end to
 * end. No Time Remap. Layer proliferation stays inside the precomp only.
 */
function azApply(precompId, editListJson) {
    var comp = azCompById(precompId);
    if (!comp) return makeResult(false, "Precomp not found");
    var base = azInnerAudio(comp);
    if (!base) return makeResult(false, "No audio layer inside precomp");
    var srcItem = base.source;
    if (!srcItem) return makeResult(false, "Audio layer has no source");
    var data; try { data = JSON.parse(editListJson); } catch (e) { return makeResult(false, "Bad edit list"); }
    if (!data.segments || !data.segments.length) return makeResult(false, "Edit list empty");

    app.beginUndoGroup("Audizy: Edit");
    try {
        // remove existing audio layers (high index first)
        for (var i = comp.numLayers; i >= 1; i--) { var Lx = comp.layer(i); if (Lx.hasAudio) Lx.remove(); }
        // lay each segment as a trimmed footage layer at its free comp position
        var tc = 0, s;
        for (s = 0; s < data.segments.length; s++) {
            var seg = data.segments[s];
            var a = seg.srcIn, b = seg.srcOut, dur = b - a;
            if (dur <= 0) continue;
            var ci = (typeof seg.compIn === "number") ? seg.compIn : tc;   // free position
            if (ci < 0) ci = 0;
            var NL = comp.layers.add(srcItem);
            NL.startTime = ci - a;      // source time (compTime - startTime) = a at ci
            NL.inPoint = ci;
            NL.outPoint = ci + dur;
            NL.comment = setTag(RC_TAG_RE, "RC", NL.comment, seg.id || uuid());
            tc = ci + dur;
        }
    } catch (e) {
        app.endUndoGroup();
        return makeResult(false, "Apply failed: " + e.toString());
    }
    app.endUndoGroup();
    return azStateFromComp(comp);
}

function azSetMute(rcId, muted) {
    var comp = getActiveComp(); if (!comp) return makeResult(false, "No active composition");
    var L = findLayerByRcId(comp, rcId); if (!L) return makeResult(false, "not found");
    app.beginUndoGroup("Audizy: Mute"); try { L.audioEnabled = !muted; } finally { app.endUndoGroup(); }
    return ok({ muted: muted });
}
function azSetLock(rcId, locked) {
    var comp = getActiveComp(); if (!comp) return makeResult(false, "No active composition");
    var L = findLayerByRcId(comp, rcId); if (!L) return makeResult(false, "not found");
    L.locked = locked;
    return ok({ locked: locked });
}

// ============================================================================
// PRECOMPOSE FLOW
// Precompose the selected audio layer (move all attributes) and stamp the
// precomp LAYER (the clip in the main comp) with a layer marker so it can be
// recognized later. The precomp is NOT opened in the AE timeline. If the
// selected layer is already a stamped Audizy precomp clip, load it instead of
// precomposing again.
// ============================================================================
var AZ_STAMP = "Audizy Precomp";   // human-readable layer marker

function azStampLayer(layer) {
    try { layer.property("ADBE Marker").setValueAtTime(0, new MarkerValue(AZ_STAMP)); } catch (e) {}
}
function azLayerHasStamp(layer) {
    try {
        var mp = layer.property("ADBE Marker");
        for (var i = 1; i <= mp.numKeys; i++) {
            var mv = mp.keyValue(i);
            if (mv && mv.comment && mv.comment.indexOf("Audizy") === 0) return true;
        }
    } catch (e) {}
    return false;
}
function azInnerAudio(cmp) {
    for (var i = 1; i <= cmp.numLayers; i++) if (cmp.layer(i).hasAudio) return cmp.layer(i);
    return null;
}
/** Find the precomp layer in a comp that references a given precomp comp. */
function azFindPrecompLayer(comp, pre) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (L.source && L.source === pre) return L;
    }
    return null;
}

/** Rename a precomp comp. */
function renamePrecomp(precompId, newName) {
    var item = null;
    for (var i = 1; i <= app.project.numItems; i++) {
        var it = app.project.item(i);
        if (it instanceof CompItem && it.id === precompId) { item = it; break; }
    }
    if (!item) return makeResult(false, "Precomp not found");
    if (!newName) return makeResult(false, "Empty name");
    app.beginUndoGroup("Audizy: Rename Precomp");
    try { item.name = newName; } finally { app.endUndoGroup(); }
    var inner = azInnerAudio(item);
    if (!inner) return makeResult(false, "No audio layer inside precomp");
    ensureRcId(inner);
    return azStateFromComp(item);
}

/** Find a stamped Audizy precomp layer in a comp (source = stamped CompItem). */
function azFindStampedPrecomp(comp) {
    for (var i = 1; i <= comp.numLayers; i++) {
        var L = comp.layer(i);
        if (L.hasAudio && L.source instanceof CompItem && azLayerHasStamp(L)) return L;
    }
    return null;
}
/** Auto-detect: load an existing Audizy precomp in the active comp, no selection needed. */
function azAutoDetect() {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = azFindStampedPrecomp(comp);
    if (!L) return makeResult(false, "No Audizy precomp found");
    var inner = azInnerAudio(L.source);
    if (!inner) return makeResult(false, "No audio layer inside precomp");
    ensureRcId(inner);
    return azStateFromComp(L.source);
}

function precomposeSelectedAudio() {
    var comp = getActiveComp();
    if (!comp) return makeResult(false, "No active composition");
    var L = null, i;
    for (i = 1; i <= comp.numLayers; i++) {
        var X = comp.layer(i);
        if (X.selected && X.hasAudio) { L = X; break; }
    }
    // No selection? Fall back to an existing stamped precomp in the comp.
    if (!L) {
        var found = azFindStampedPrecomp(comp);
        if (found) { var inr = azInnerAudio(found.source); if (inr) { ensureRcId(inr); return azStateFromComp(found.source); } }
        return makeResult(false, "Select an audio layer first");
    }

    // Already a stamped Audizy precomp clip? Load it, do not precompose again.
    if (L.source instanceof CompItem && azLayerHasStamp(L)) {
        var innerExisting = azInnerAudio(L.source);
        if (!innerExisting) return makeResult(false, "No audio layer inside precomp");
        ensureRcId(innerExisting);
        return azStateFromComp(L.source);
    }

    var pre, PL;
    app.beginUndoGroup("Audizy: Precompose Audio");
    try {
        try { if (L.timeRemapEnabled) L.timeRemapEnabled = false; } catch (e) {}   // clean before precompose
        pre = comp.layers.precompose([L.index], "Audizy - " + L.name, true);  // moveAllAttributes
        PL = azFindPrecompLayer(comp, pre);
        if (PL) azStampLayer(PL);          // stamp the clip, not the comp
    } finally { app.endUndoGroup(); }

    if (!(pre instanceof CompItem)) return makeResult(false, "Precompose failed");
    var inner = azInnerAudio(pre);
    if (!inner) return makeResult(false, "No audio layer inside precomp");
    ensureRcId(inner);
    return azStateFromComp(pre);   // do NOT openInViewer
}

/** Reopen an existing precomp by id and return its state (re-entry). */
function getPrecompState(precompId) {
    var item = azCompById(precompId);
    if (!item) return makeResult(false, "Precomp not found");
    var inner = azInnerAudio(item);
    if (!inner) return makeResult(false, "No audio layer inside precomp");
    ensureRcId(inner);
    return azStateFromComp(item);
}

/** Read the precomp comp's current time (for playhead sync). */
function azGetCompTime(precompId) {
    var comp = azCompById(precompId);
    if (!comp) return makeResult(false, "Precomp not found");
    return ok({ time: comp.time });
}
/** Set the precomp comp's current time (moves its CTI when it is open). */
function azSetCompTime(precompId, t) {
    var comp = azCompById(precompId);
    if (!comp) return makeResult(false, "Precomp not found");
    comp.time = t;
    return ok({ time: comp.time });
}

