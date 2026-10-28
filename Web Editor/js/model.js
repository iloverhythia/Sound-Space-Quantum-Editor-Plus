'use strict';

// Port of the editor's map model: Objects/*.cs, Objects/Other/ObjectList.cs, Objects/Managers/*.cs,
// EditHistory/UndoRedoManager.cs, NewMaps/Map.cs, NewMaps/Timing.cs, NewMaps/Patterns.cs and Misc/Easing.cs
const SSQE = window.SSQE = window.SSQE || {};

(function () {
    // C# Math.Round defaults to banker's rounding
    function roundEven(x) {
        const r = Math.round(x);
        if (Math.abs(x % 1) === 0.5 && r % 2 !== 0)
            return r - 1;
        return r;
    }

    function round2(x) {
        return Math.round(x * 100) / 100;
    }

    function fmt(x) {
        return String(round2(x));
    }

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

    // ---------------------------------------------------------------- easing (Misc/Easing.cs)

    const EASING_STYLES = ['Linear', 'Sine', 'Back', 'Quad', 'Quart', 'Quint', 'Bounce', 'Elastic', 'Exponential', 'Circular', 'Cubic'];
    const EASING_DIRECTIONS = ['In', 'Out', 'InOut'];

    const Easing = (function () {
        const C1 = 1.70158, C2 = C1 * 1.525, C3 = C1 + 1, C4 = 2 * Math.PI / 3, C5 = 2 * Math.PI / 4.5;
        const N1 = 7.5625, D1 = 2.75;

        function bounceOut(t) {
            if (t < 1 / D1) return N1 * t * t;
            if (t < 2 / D1) return N1 * (t -= 1.5 / D1) * t + 0.75;
            if (t < 2.5 / D1) return N1 * (t -= 2.25 / D1) * t + 0.9375;
            return N1 * (t -= 2.625 / D1) * t + 0.984375;
        }

        const IN = [
            t => t,
            t => 1 - Math.cos(t * Math.PI / 2),
            t => C3 * t * t * t - C1 * t * t,
            t => t * t,
            t => t ** 4,
            t => t ** 5,
            t => 1 - bounceOut(1 - t),
            t => t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * C4),
            t => t === 0 ? 0 : 2 ** (10 * t - 10),
            t => 1 - Math.sqrt(1 - t * t),
            t => t ** 3,
        ];

        const OUT = [
            t => t,
            t => Math.sin(t * Math.PI / 2),
            t => 1 + C3 * (t - 1) ** 3 + C1 * (t - 1) ** 2,
            t => 1 - (1 - t) ** 2,
            t => 1 - (1 - t) ** 4,
            t => 1 - (1 - t) ** 5,
            bounceOut,
            t => t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * C4) + 1,
            t => t === 1 ? 1 : 1 - 2 ** (-10 * t),
            t => Math.sqrt(1 - (t - 1) ** 2),
            t => 1 - (1 - t) ** 3,
        ];

        const INOUT = [
            t => t,
            t => -(Math.cos(Math.PI * t) - 1) / 2,
            t => t < 0.5 ? ((2 * t) ** 2 * ((C2 + 1) * 2 * t - C2)) / 2 : ((2 * t - 2) ** 2 * ((C2 + 1) * (t * 2 - 2) + C2) + 2) / 2,
            t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2,
            t => t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2,
            t => t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2,
            t => t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2,
            t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * C5)) / 2 : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * C5)) / 2 + 1,
            t => t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
            t => t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2,
            t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
        ];

        return {
            process(min, max, t, style, direction) {
                t = clamp(t, 0, 1);
                const table = direction === 0 ? IN : direction === 1 ? OUT : INOUT;
                const f = table[style] || table[0];
                return min + (max - min) * f(t);
            },
        };
    })();

    // ---------------------------------------------------------------- map objects (Objects/*.cs)

    class MapObject {
        constructor(id, ms, name = null) {
            this.id = id;
            this.ms = ms;
            this.duration = 0;
            this.name = name;
            this.extra = [];
            this.selected = false;
            this.dragStartMs = 0;
            this.hasDuration = true;
            this.playHitsound = true;
        }

        fields() {
            return [];
        }

        toString() {
            const data = [...this.fields(), ...this.extra];
            return data.length > 0 ? `${this.ms}|${data.join('|')}` : String(this.ms);
        }

        copyBase(o) {
            o.extra = this.extra;
            return o;
        }

        clone() {
            const o = new MapObject(this.id, this.ms, this.name);
            o.duration = this.duration;
            return this.copyBase(o);
        }
    }

    class XYMapObject extends MapObject {
        constructor(id, x, y, ms, name) {
            super(id, ms, name);
            this.x = x;
            this.y = y;
        }

        fields() {
            return [fmt(this.x), fmt(this.y)];
        }
    }

    class Note extends XYMapObject {
        constructor(x, y, ms, enableEasing = false, style = 0, direction = 0) {
            super(0, x, y, ms, 'Note');
            this.anchored = false;
            this.enableEasing = enableEasing;
            this.style = style;
            this.direction = direction;
        }

        fields() {
            return [...super.fields(), this.enableEasing ? '1' : '0', String(this.style), String(this.direction)];
        }

        clone() {
            return new Note(this.x, this.y, this.ms, this.enableEasing, this.style, this.direction);
        }
    }

    class TimingPoint extends MapObject {
        constructor(bpm, ms) {
            super(1, ms, 'BPM');
            this.bpm = bpm;
            this.hasDuration = false;
        }

        fields() {
            return [fmt(this.bpm)];
        }

        clone() {
            return new TimingPoint(this.bpm, this.ms);
        }
    }

    // VFX objects (ids 2-11) are kept as raw fields so they survive a load/save round trip unchanged
    const VFX_NAMES = { 2: 'Brightness', 3: 'Contrast', 4: 'Saturation', 5: 'Blur', 6: 'FOV', 7: 'Tint', 8: 'Position', 9: 'Rotation', 10: 'AR Factor', 11: 'Text' };

    class RawObject extends MapObject {
        constructor(id, ms, data) {
            super(id, ms, VFX_NAMES[id] || null);
            this.data = data;
            const d = parseInt(data[0], 10);
            this.duration = id >= 2 && id <= 11 && Number.isFinite(d) ? d : 0;
            this.hasDuration = id >= 2 && id <= 11;
        }

        fields() {
            const data = [...this.data];
            if (this.hasDuration)
                data[0] = String(this.duration);
            return data;
        }

        clone() {
            const o = new RawObject(this.id, this.ms, this.fields());
            return o;
        }
    }

    class Beat extends MapObject {
        constructor(ms) {
            super(12, ms, 'Beat');
            this.hasDuration = false;
        }

        clone() {
            return this.copyBase(new Beat(this.ms));
        }
    }

    const GLIDE_DIRECTIONS = ['Up', 'Right', 'Down', 'Left'];

    class Glide extends MapObject {
        constructor(ms, direction) {
            super(13, ms, 'Glide');
            this.hasDuration = false;
            this.direction = direction;
        }

        fields() {
            return [String(this.direction)];
        }

        clone() {
            return this.copyBase(new Glide(this.ms, this.direction));
        }
    }

    class Mine extends XYMapObject {
        constructor(x, y, ms) {
            super(14, x, y, ms, 'Mine');
            this.hasDuration = false;
            this.playHitsound = false;
        }

        clone() {
            return this.copyBase(new Mine(this.x, this.y, this.ms));
        }
    }

    // FormatUtils.ConvertString
    function quoteString(str) {
        return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    }

    class Lyric extends MapObject {
        constructor(ms, text, fadeIn, fadeOut) {
            super(15, ms, 'Lyric');
            this.hasDuration = false;
            this.text = text;
            this.fadeIn = fadeIn;
            this.fadeOut = fadeOut;
            this.playHitsound = false;
        }

        fields() {
            return [quoteString(this.text), this.fadeIn ? '1' : '0', this.fadeOut ? '1' : '0'];
        }

        clone() {
            return this.copyBase(new Lyric(this.ms, this.text, this.fadeIn, this.fadeOut));
        }
    }

    class Fever extends MapObject {
        constructor(ms, duration) {
            super(16, ms, 'Fever');
            this.duration = duration;
            this.playHitsound = false;
        }

        fields() {
            return [String(this.duration)];
        }

        clone() {
            return this.copyBase(new Fever(this.ms, this.duration));
        }
    }

    class Bookmark extends MapObject {
        constructor(text, ms, endMs) {
            super(17, ms, 'Bookmark');
            this.text = text;
            this.endMs = endMs;
            this.hasDuration = false;
        }

        clone() {
            return new Bookmark(this.text, this.ms, this.endMs);
        }
    }

    // Objects/MOParser.cs
    function parseObject(id, data) {
        if (!data.length)
            return null;

        try {
            let index = 0;
            if (id === null)
                id = parseInt(data[index++], 10);
            const ms = parseInt(data[index], 10);
            if (!Number.isFinite(id) || !Number.isFinite(ms))
                return null;

            const f = () => parseFloat(data[++index]);
            const i = () => parseInt(data[++index], 10);
            let obj;

            switch (id) {
                case 0: {
                    const x = f(), y = f();
                    let easing = false, style = 0, direction = 0;
                    if (index + 1 < data.length) easing = i() === 1;
                    if (index + 1 < data.length) style = i();
                    if (index + 1 < data.length) direction = i();
                    if (!Number.isFinite(x) || !Number.isFinite(y))
                        return null;
                    obj = new Note(x, y, ms, easing, style || 0, direction || 0);
                    break;
                }
                case 1:
                    obj = new TimingPoint(f(), ms);
                    break;
                case 12:
                    obj = new Beat(ms);
                    break;
                case 13:
                    obj = new Glide(ms, i());
                    break;
                case 14:
                    obj = new Mine(f(), f(), ms);
                    break;
                case 15: {
                    const text = data[++index];
                    obj = new Lyric(ms, text, i() === 1, i() === 1);
                    break;
                }
                case 16:
                    obj = new Fever(ms, i());
                    break;
                case 17: {
                    const endMs = i();
                    obj = new Bookmark(data[++index], ms, endMs);
                    break;
                }
                default:
                    // keep everything after the timestamp verbatim
                    return new RawObject(id, ms, data.slice(index + 1));
            }

            obj.extra = data.slice(index + 1);
            return obj;
        } catch (e) {
            console.warn('Failed to parse MapObject', id, data, e);
            return null;
        }
    }

    // ---------------------------------------------------------------- undo / redo (EditHistory/UndoRedoManager.cs)

    class UndoRedo {
        constructor(editor) {
            this.editor = editor;
            this.actions = [];
            this.index = -1;
            this.prevBpmWarning = 0;
        }

        add(label, undo, redo, runRedo = true) {
            this.actions.length = this.index + 1;
            this.actions.push({ label, undo, redo });
            this.index++;

            if (runRedo)
                redo();

            if (label === 'ADD NOTE' && runRedo && this.editor && this.editor.map.timingPoints.length === 0) {
                const now = Date.now();
                if (now - this.prevBpmWarning >= 5000) {
                    this.editor.toast('Please use BPM!', 'warn');
                    this.prevBpmWarning = now;
                }
            }

            this.editor && this.editor.onMapChanged();
        }

        undo() {
            if (this.index >= 0) {
                const action = this.actions[this.index];
                this.editor && this.editor.toast(`UNDONE: ${action.label}`, 'other');
                action.undo();
                this.index--;
                this.editor && this.editor.onMapChanged();
            }
        }

        redo() {
            if (this.index + 1 < this.actions.length) {
                const action = this.actions[this.index + 1];
                this.editor && this.editor.toast(`REDONE: ${action.label}`, 'other');
                action.redo();
                this.index++;
                this.editor && this.editor.onMapChanged();
            }
        }

        clear() {
            this.actions = [];
            this.index = -1;
        }
    }

    // ---------------------------------------------------------------- object list (Objects/Other/ObjectList.cs)

    class ObjectList {
        constructor(map) {
            this.map = map;
            this.items = [];
            this._selected = [];
            this.bezierNodes = [];
        }

        get length() {
            return this.items.length;
        }

        get selected() {
            return this._selected;
        }

        set selected(value) {
            this._selected = value;
            this.updateSelection();
        }

        clearSelected() {
            this.selected = [];
        }

        updateSelection() {
            for (const o of this.items)
                o.selected = false;
            for (const o of this._selected)
                o.selected = true;
        }

        getClosest(ms) {
            let closest = -1;
            for (const o of this.items)
                if (Math.abs(o.ms - ms) < Math.abs(closest - ms))
                    closest = o.ms;
            return closest;
        }

        searchFirst(key) {
            let first = 0, count = this.items.length - 1;
            while (count > 0) {
                const step = Math.trunc(count / 2);
                const iter = first + step;
                if (this.items[iter].ms < key) {
                    first = iter + 1;
                    count -= step + 1;
                } else
                    count = step;
            }
            return first;
        }

        searchLast(key) {
            let last = 0, count = this.items.length - 1;
            while (count > 0) {
                const step = Math.trunc(count / 2);
                const iter = last + step;
                if (this.items[iter].ms <= key) {
                    last = iter + 1;
                    count -= step + 1;
                } else
                    count = step;
            }
            return last;
        }

        searchRange(start, end) {
            start = Math.trunc(start);
            end = Math.trunc(end);
            const first = this.searchFirst(start);
            let last = this.searchLast(end);
            if (this.items.length > 0 && this.items[last].ms <= end && this.items[first].ms >= start)
                last++;
            return [first, last];
        }

        sort() {
            this.items.sort((a, b) => a.ms - b.ms);
            this.map && this.map.changed();
        }

        add(obj) {
            this.items.push(obj);
        }

        removeAll(list) {
            if (!list.length)
                return;
            const set = new Set(list);
            this.items = this.items.filter(o => !set.has(o));
            this.updateSelection();
        }

        clear() {
            this.items = [];
            this.selected = [];
        }

        // Modify_Replace
        replace(label, oldObjects, newObjects) {
            label = label.replace('[S]', Math.max(oldObjects.length, newObjects.length) > 1 ? 'S' : '');

            oldObjects = [...oldObjects];
            newObjects = [...newObjects];

            const oldBez = [...this.bezierNodes];
            const newBez = this.bezierNodes.filter(n => n < this.items.length + newObjects.length - oldObjects.length);

            this.map.undo.add(label, () => {
                this.removeAll(newObjects);
                this.items.push(...oldObjects);
                this.sort();
                this.selected = [...oldObjects];
                this.bezierNodes = [...oldBez];
            }, () => {
                this.removeAll(oldObjects);
                this.items.push(...newObjects);
                this.sort();
                this.selected = [...newObjects];
                this.bezierNodes = [...newBez];
            });
        }

        // Modify_Edit
        edit(label, toModify, action) {
            if (typeof toModify === 'function') {
                action = toModify;
                toModify = this._selected;
            }
            if (!toModify.length)
                return;

            const completed = toModify.map(n => n.clone());
            completed.forEach(action);
            this.replace(label, toModify, completed);
        }

        addObjects(label, toAdd) {
            const list = Array.isArray(toAdd) ? toAdd : [toAdd];
            this.replace(label, [], list);
            // (for the STATS page: notes placed by hand and by the auto mapper)
            if (window.SSQEStats && list.length && list[0] instanceof Note)
                SSQEStats.add(label === 'AUTO MAP' ? 'notesAutoMapped' : 'notesPlaced', list.length);
        }

        removeObjects(label, toRemove) {
            const list = toRemove === undefined ? this._selected : Array.isArray(toRemove) ? toRemove : [toRemove];
            if (window.SSQEStats && list.length && list[0] instanceof Note)
                SSQEStats.add('notesDeleted', list.length);
            this.replace(label, list, []);
        }
    }

    // ---------------------------------------------------------------- map (NewMaps/Map.cs)

    const DIFFICULTIES = ['N/A', 'Easy', 'Medium', 'Hard', 'Logic', 'Tasukete'];

    const RenderMode = { Notes: 0, Special: 1, VFX: 2 };
    const ObjectMode = { Disabled: 0, Note: 1, Beat: 12, Glide: 13, Mine: 14, Lyric: 15, Fever: 16 };

    class Map {
        constructor() {
            this.undo = new UndoRedo(null);
            this.notes = new ObjectList(this);
            this.vfxObjects = new ObjectList(this);
            this.specialObjects = new ObjectList(this);
            this.bookmarks = [];
            this.timingPoints = [];
            this.selectedPoint = null;

            this.songLinks = [];
            this.artistLinks = {};
            this.mapperIds = {};

            this.fileName = null;
            this.fileHandle = null;
            this.soundId = '-1';
            this.savedText = null;

            this.tempoSlider = 0.9;
            this.zoom = 1;
            this.currentTime = 0;
            this.beatDivisor = 3;
            this.duration = 0;

            this.renderMode = RenderMode.Notes;
            this.objectMode = ObjectMode.Disabled;

            // per-map properties stored in the .ini (Map._baseSettings)
            this.props = {
                exportOffset: 0,
                mappers: '', songName: '', difficulty: 'N/A', useCover: false, cover: 'Default',
                customDifficulty: '', rating: 0, useVideo: false, video: '', songOffset: '',
                songTitle: '', songArtist: '', mapCreator: '', mapCreatorPersonalLink: '',
                previewStartTime: '', previewDuration: '', novaCover: '', novaIcon: '',
                romanizedArtist: '', romanizedTitle: '', colorsetPath: '', phxmPlatform: '',
            };

            this.version = 0;
        }

        changed() {
            this.version++;
        }

        get tempo() {
            const t = this.tempoSlider;
            return Math.min(t, 0.9) + Math.max(t - 0.9, 0) * 2 + 0.1;
        }

        get bezierNodes() {
            return this.notes.bezierNodes;
        }

        set bezierNodes(v) {
            this.notes.bezierNodes = v;
        }

        get fileId() {
            if (this.fileName)
                return this.fileName.replace(/\.[^.]*$/, '');
            return this.soundId;
        }

        get activeList() {
            switch (this.renderMode) {
                case RenderMode.Notes:
                    return this.notes;
                case RenderMode.VFX:
                    return this.vfxObjects;
                default:
                    return this.objectMode === ObjectMode.Note ? this.notes : this.specialObjects;
            }
        }

        get selectedObjects() {
            return [...this.activeList.selected];
        }

        set selectedObjects(value) {
            this.activeList.selected = [...value];
        }

        clearSelected() {
            this.notes.clearSelected();
            this.vfxObjects.clearSelected();
            this.specialObjects.clearSelected();
            this.selectedPoint = null;
        }

        sortAll() {
            this.notes.sort();
            this.vfxObjects.sort();
            this.specialObjects.sort();
            this.sortTimings();
            this.sortBookmarks();
        }

        sortObjects() {
            this.activeList.sort();
        }

        sortTimings() {
            this.timingPoints.sort((a, b) => a.ms - b.ms);
            this.changed();
        }

        sortBookmarks() {
            this.bookmarks.sort((a, b) => a.ms - b.ms);
            this.changed();
        }

        getObjectsInRange(start, end) {
            const list = this.activeList;
            const [low, high] = list.searchRange(start, end);
            let result = list.items.slice(low, high);

            if (list !== this.notes && this.objectMode !== ObjectMode.Disabled)
                result = result.filter(n => n.id === this.objectMode);
            return result;
        }

        incrementZoom(delta) {
            let zoom = this.zoom;
            let step = 0.1;

            if (zoom < 0.1 || (zoom === 0.1 && delta < 0))
                step /= 10;
            if (zoom > 10 || (zoom === 10 && delta > 0))
                step *= 2;

            zoom = Math.round((zoom + delta * step) * 100) / 100;
            if (zoom > 0.1)
                zoom = Math.round(zoom * 10) / 10;

            this.zoom = clamp(zoom, 0.01, 20);
        }

        // PointManager / BookmarkManager
        replacePoints(label, oldPoints, newPoints) {
            label = label.replace('[S]', Math.max(oldPoints.length, newPoints.length) > 1 ? 'S' : '');
            oldPoints = [...oldPoints];
            newPoints = [...newPoints];

            this.undo.add(label, () => {
                this.timingPoints = this.timingPoints.filter(p => !newPoints.includes(p));
                this.timingPoints.push(...oldPoints);
                this.selectedPoint = oldPoints.length === 1 ? oldPoints[0] : null;
                this.sortTimings();
            }, () => {
                this.timingPoints = this.timingPoints.filter(p => !oldPoints.includes(p));
                this.timingPoints.push(...newPoints);
                this.selectedPoint = newPoints.length === 1 ? newPoints[0] : null;
                this.sortTimings();
            });
        }

        editPoints(label, toModify, action) {
            if (!toModify.length)
                return;
            const completed = toModify.map(p => p.clone());
            completed.forEach(action);
            this.replacePoints(label, toModify, completed);
        }

        replaceBookmarks(label, oldB, newB) {
            label = label.replace('[S]', Math.max(oldB.length, newB.length) > 1 ? 'S' : '');
            oldB = [...oldB];
            newB = [...newB];

            this.undo.add(label, () => {
                this.bookmarks = this.bookmarks.filter(b => !newB.includes(b));
                this.bookmarks.push(...oldB);
                this.sortBookmarks();
            }, () => {
                this.bookmarks = this.bookmarks.filter(b => !oldB.includes(b));
                this.bookmarks.push(...newB);
                this.sortBookmarks();
            });
        }

        editBookmarks(label, toModify, action) {
            if (!toModify.length)
                return;
            const completed = toModify.map(b => b.clone());
            completed.forEach(action);
            this.replaceBookmarks(label, toModify, completed);
        }

        copyBookmarksText() {
            return this.bookmarks.map(b => {
                const text = b.text.replace(/ ~/g, '_~');
                return b.ms !== b.endMs ? `${b.ms}-${b.endMs} ~ ${text}` : `${b.ms} ~ ${text}`;
            }).join('\n');
        }

        pasteBookmarksText(data) {
            const temp = [];
            for (let line of data.split('\n')) {
                line = line.trim();
                const split = line.split(' ~');
                if (split.length !== 2)
                    continue;
                const sub = split[0].split('-');
                const text = split[1].trim().replace(/_~/g, ' ~');

                if (sub.length === 1 && /^-?\d+$/.test(sub[0]))
                    temp.push(new Bookmark(text, +sub[0], +sub[0]));
                else if (sub.length === 2 && /^-?\d+$/.test(sub[0]) && /^-?\d+$/.test(sub[1]))
                    temp.push(new Bookmark(text, +sub[0], +sub[1]));
            }

            if (temp.length)
                this.replaceBookmarks('PASTE BOOKMARK[S]', this.bookmarks, temp);
            return temp.length;
        }
    }

    // ---------------------------------------------------------------- timing (NewMaps/Timing.cs)

    const ANY_POINT = { bpm: 0, ms: 0 }; // stands in for `new TimingPoint(0, 0)` used as a never-matching drag point

    const Timing = {
        getCurrentBpm(map, currentMs, draggingPoint = null) {
            let current = { bpm: 0, ms: 0 };
            for (const point of map.timingPoints) {
                if (point === draggingPoint)
                    continue;
                if (point.ms < currentMs || (draggingPoint === null && point.ms === currentMs))
                    current = point;
            }
            return current;
        },

        getClosestBeat(map, settings, currentMs, draggingPoint = null, ignoreDivisor = false) {
            let closest = -1;
            const point = Timing.getCurrentBpm(map, currentMs, draggingPoint);

            if (point.bpm > 0) {
                let interval = 60000 / point.bpm;
                if (!ignoreDivisor)
                    interval /= map.beatDivisor + 1;
                const offset = point.ms % interval;

                closest = Math.trunc(roundEven(roundEven((currentMs - offset) / interval) * interval + offset));
            }

            return closest;
        },

        getClosestBeatScroll(map, settings, currentMs, negative = false, iterations = 1) {
            let closest = Timing.getClosestBeat(map, settings, currentMs);

            if (Timing.getCurrentBpm(map, closest).bpm <= 0)
                return -1;

            for (let i = 0; i < iterations; i++) {
                const currentPoint = Timing.getCurrentBpm(map, currentMs, negative ? ANY_POINT : null);
                const interval = 60000 / currentPoint.bpm / (map.beatDivisor + 1);

                if (negative) {
                    closest = Timing.getClosestBeat(map, settings, currentMs, ANY_POINT);
                    if (closest >= currentMs)
                        closest = Timing.getClosestBeat(map, settings, closest - Math.trunc(interval));
                } else {
                    if (closest <= currentMs)
                        closest = Timing.getClosestBeat(map, settings, closest + Math.trunc(interval));
                    if (Timing.getCurrentBpm(map, currentMs).ms !== Timing.getCurrentBpm(map, closest).ms)
                        closest = Timing.getCurrentBpm(map, closest).ms;
                }

                currentMs = closest;
            }

            if (closest < 0)
                return -1;
            return Math.trunc(clamp(closest, 0, map.duration));
        },

        notesFromPoint(map, point) {
            const index = map.timingPoints.indexOf(point);
            const next = index + 1 < map.timingPoints.length ? map.timingPoints[index + 1].ms : map.duration;
            return map.notes.items.filter(n => n.ms >= point.ms && n.ms < next);
        },

        updatePoint(map, point, newBpm) {
            const mult = point.bpm / newBpm;
            const notes = Timing.notesFromPoint(map, point);
            map.notes.edit('ADJUST NOTE[S]', notes, n => n.ms = Math.trunc((n.ms - point.ms) * mult) + point.ms);
        },

        movePoints(map, points, offset) {
            const toAdjust = [];
            for (const p of points)
                toAdjust.push(...Timing.notesFromPoint(map, p));
            map.notes.edit('ADJUST NOTE[S]', toAdjust, n => n.ms += offset);
        },
    };

    // ---------------------------------------------------------------- patterns (NewMaps/Patterns.cs)

    function factorial(n) {
        let r = 1;
        for (let i = 2; i <= n; i++)
            r *= i;
        return r;
    }

    function binomial(n, k) {
        // exact for the sizes the editor allows, falls back to a product form to avoid overflow
        let r = 1;
        for (let i = 1; i <= k; i++)
            r = r * (n - k + i) / i;
        return Number.isFinite(r) ? r : factorial(n) / (factorial(k) * factorial(n - k));
    }

    const Patterns = {
        horizontalFlip(note) {
            note.x = 2 - note.x;
        },

        verticalFlip(note) {
            note.y = 2 - note.y;
        },

        rotate(note, deg, clampSR) {
            const angle = Math.atan2(note.y - 1, note.x - 1) * 180 / Math.PI;
            const distance = Math.hypot(note.x - 1, note.y - 1);
            const a = (angle + deg) * Math.PI / 180;

            note.x = Math.cos(a) * distance + 1;
            note.y = Math.sin(a) * distance + 1;

            if (clampSR) {
                note.x = clamp(note.x, -0.85, 2.85);
                note.y = clamp(note.y, -0.85, 2.85);
            }
        },

        scale(note, scale, clampSR) {
            const s = scale / 100;
            note.x = (note.x - 1) * s + 1;
            note.y = (note.y - 1) * s + 1;

            if (clampSR) {
                note.x = clamp(note.x, -0.85, 2.85);
                note.y = clamp(note.y, -0.85, 2.85);
            }
        },

        drawBezier(nodes, divisor, curve) {
            const final = [];
            const degree = nodes.length - 1;

            // (web only: the divisor may have decimals: a curve gets that many steps a node on average, rounded over the
            // whole curve; straight lines alternate whole steps between nodes so they average it, still meeting every node)
            if (curve) {
                const steps = Math.max(1, Math.round(divisor * degree));
                const deltaMs = nodes[degree].ms - nodes[0].ms;
                // (web only, for speed: the binomial coefficients once rather than for every point, and the powers of
                // t and 1 - t built up a step at a time; the same sum)
                const coef = new Float64Array(degree + 1);
                for (let p = 0; p <= degree; p++)
                    coef[p] = binomial(degree, p);
                const tp = new Float64Array(degree + 1), up = new Float64Array(degree + 1);

                for (let s = 0; s <= steps; s++) {
                    const t = s / steps, u = 1 - t;
                    tp[0] = up[0] = 1;
                    for (let p = 1; p <= degree; p++) {
                        tp[p] = tp[p - 1] * t;
                        up[p] = up[p - 1] * u;
                    }
                    let x = 0, y = 0;

                    for (let p = 0; p <= degree; p++) {
                        const v = coef[p] * up[degree - p] * tp[p];
                        x += v * nodes[p].x;
                        y += v * nodes[p].y;
                    }

                    final.push(new Note(x, y, Math.trunc(nodes[0].ms + deltaMs * t)));
                }
            } else {
                for (let p = 0; p < degree; p++) {
                    const a = nodes[p], b = nodes[p + 1];
                    const steps = Math.max(1, Math.round((p + 1) * divisor) - Math.round(p * divisor));
                    for (let s = 0; s <= steps; s++) {
                        if (s > 0 || p === 0) {
                            const t = s / steps;
                            final.push(new Note(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, Math.trunc(a.ms + (b.ms - a.ms) * t)));
                        }
                    }
                }
            }

            return final;
        },

        // splits nodes at anchored notes and joins the bezier segments
        bezierSegments(nodes, divisor, curve) {
            const anchored = [0];
            for (let i = 1; i < nodes.length; i++)
                if (nodes[i].anchored)
                    anchored.push(i);
            if (!anchored.includes(nodes.length - 1))
                anchored.push(nodes.length - 1);

            const segments = [];
            for (let i = 1; i < anchored.length; i++)
                segments.push(Patterns.drawBezier(nodes.slice(anchored[i - 1], anchored[i] + 1), divisor, curve));
            return segments;
        },

        storePattern(map, settings, index) {
            const notes = map.notes.selected;
            if (!notes.length)
                return false;

            const point = Timing.getCurrentBpm(map, notes[0].ms);
            const onPoint = point.bpm > 0;
            const interval = onPoint ? 60000 / point.bpm / (map.beatDivisor + 1) : 0;
            let pattern = onPoint ? '1' : '0';
            const offset = notes[0].ms;

            for (const note of notes) {
                const time = onPoint ? (note.ms - offset) / interval : note.ms - offset;
                pattern += `,${note.x}|${note.y}|${time}`;
            }

            settings.patterns[index] = pattern;
            return true;
        },

        recallPattern(map, settings, index) {
            const pattern = settings.patterns[index];
            if (!pattern)
                return;

            const offset = map.currentTime;
            const point = Timing.getCurrentBpm(map, offset);
            const onPoint = point.bpm > 0;

            const split = pattern.split(',');
            const quantized = split[0] === '1';
            const toAdd = [];

            for (let i = 1; i < split.length; i++) {
                const [x, y, time] = split[i].split('|').map(parseFloat);

                if (!quantized)
                    toAdd.push(new Note(x, y, Math.trunc(time + offset)));
                else {
                    const bpm = onPoint ? point.bpm : 60;
                    const interval = 60000 / bpm / (map.beatDivisor + 1);
                    toAdd.push(new Note(x, y, Math.trunc(time * interval + offset)));
                }
            }

            if (!toAdd.length)
                return;

            if (!quantized && onPoint) {
                const interval = 60000 / point.bpm / (map.beatDivisor + 1);
                let minDist = Number.MAX_VALUE;

                for (let i = 1; i < toAdd.length; i++) {
                    const dist = Math.min(minDist, toAdd[i].ms - toAdd[i - 1].ms);
                    if (dist > 0)
                        minDist = dist;
                }

                for (let i = 1; i < toAdd.length; i++)
                    toAdd[i].ms = Math.trunc((toAdd[i].ms - offset) / minDist * interval + offset);
            }

            map.notes.addObjects('ADD PATTERN', toAdd);
        },
    };

    Object.assign(SSQE, {
        roundEven, round2, fmt, clamp, quoteString,
        Easing, EASING_STYLES, EASING_DIRECTIONS, GLIDE_DIRECTIONS, DIFFICULTIES,
        MapObject, XYMapObject, Note, TimingPoint, RawObject, Beat, Glide, Mine, Lyric, Fever, Bookmark,
        parseObject, UndoRedo, ObjectList, Map, RenderMode, ObjectMode, Timing, Patterns,
    });
})();
