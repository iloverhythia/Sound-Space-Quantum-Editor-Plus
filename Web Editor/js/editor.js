'use strict';

// Port of NewGUI/Windows/GuiWindowEditor.cs, NewGUI/Controls/GuiGrid.cs, GuiTrack.cs, GuiSliderTimeline.cs,
// NewGUI/Input/KeybindManager.cs and the editor parts of MainWindow.cs. Everything is laid out on a
// 1920x1080 stage (the original's reference resolution) which is scaled to fit the window.
(function () {
    const {
        Note, TimingPoint, Beat, Glide, Mine, Lyric, Fever, XYMapObject,
        Timing, Patterns, Easing, RenderMode, ObjectMode, clamp, roundEven, Formats,
    } = SSQE;

    const G = SSQE.GUI;
    // (input of any kind keeps the editor drawing every frame for a moment, see Editor.keepAwake)
    const WAKE_EVENTS = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove', 'input', 'change', 'resize', 'focus'];

    // current screen rects of the track and grid controls (updated on resize like Control.Resize)
    let TRACK = { x: 0, y: 0, w: 1920, h: 86 };
    let GRID = { x: 810, y: 390, w: 300, h: 300 };

    const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
    // web only: the people you're mapping with (collab.js), each in their own colour ([r, g, b]): their selection, the
    // notes they just placed and where they are in the song
    const PEER_A = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    // (how long a note they just placed glows)
    const PEER_FLASH = 900;
    const fmtInt = n => Math.trunc(n).toLocaleString('en-US');

    // GuiGrid.objectLookup - which special object a grid key places
    const OBJECT_LOOKUP = {
        [ObjectMode.Beat]: { '1,1': () => new Beat(0) },
        [ObjectMode.Mine]: Object.fromEntries([0, 1, 2].flatMap(x => [0, 1, 2].map(y => [`${x},${y}`, () => new Mine(x, y, 0)]))),
        [ObjectMode.Glide]: {
            '1,2': () => new Glide(0, 0),
            '1,0': () => new Glide(0, 2),
            '2,1': () => new Glide(0, 3),
            '0,1': () => new Glide(0, 1),
        },
        [ObjectMode.Fever]: { '1,1': () => new Fever(0, 0) },
    };

    class Editor {
        constructor(app, map, music) {
            this.app = app;
            this.settings = app.settings;
            this.map = map;
            this.music = music;
            map.undo.editor = this;

            this.canvas = document.getElementById('editor-canvas');
            this.ctx = this.canvas.getContext('2d');

            this.mouse = { x: -1, y: -1, left: false, right: false };
            this.keys = { ctrl: false, alt: false, shift: false };

            // grid state
            this.hoveringCell = null;
            this.placing = false;
            this.lastPlacedPos = null;
            this.hoveringXY = null;
            this.draggingXY = [];
            this.dragCellStart = null;
            this.gridVisible = [];

            // track state
            this.selecting = false;
            this.selectMsStart = 0;
            this.selectMsEnd = 0;
            this.hoveringObject = null;
            this.hoveringDuration = null;
            this.hoveringTextIndex = -1;
            this.draggingObjects = [];
            this.draggingDuration = null;
            this.dragMsStart = 0;
            this.dragXStart = 0;
            this.trackDragging = false;
            this.shouldReplay = false;
            this.lastPlayedObject = null;
            this.lastPlayedTick = null;
            this.trackStartRel = 0;
            this.trackEndRel = 1;

            this.running = false;
            this.lastFrame = performance.now();

            this.spriteSheet = new Image();
            this.spriteSheet.src = 'assets/Sprites.png';
            this.tintedSprites = {};
        }

        // ------------------------------------------------------------ lifecycle

        start() {
            this.running = true;
            this.ui = SSQE.buildEditorWindow(this);
            this.win = new G.Window(this.app, this.ui.controls);
            this.win.keys = this.keys;
            this.attachInput();
            this.music.setTempo(this.map.tempo);
            this.raf = requestAnimationFrame(t => this.frame(t));
        }

        stop() {
            this.running = false;
            cancelAnimationFrame(this.raf);
            this.detachInput();
            if (this.music.isPlaying)
                this.pauseMusic();
        }

        // used while the web player runs a playtest on top of the editor
        suspend() {
            this.running = false;
            cancelAnimationFrame(this.raf);
            this.detachInput();
            this.mouse.left = this.mouse.right = false;
            this.placing = false;
        }

        resume() {
            if (this.running)
                return;
            this.running = true;
            this.attachInput();
            this.lastFrame = performance.now();
            this.raf = requestAnimationFrame(t => this.frame(t));
        }

        get currentTime() {
            return this.map.currentTime;
        }

        // web only: where the grid is on the screen (collab.js shows someone's mouse over the same cell of it)
        get gridRect() {
            return GRID;
        }

        set currentTime(v) {
            this.map.currentTime = v;
        }

        get totalTime() {
            return this.map.duration;
        }

        onMapChanged() {
            this.map.changed();
            this.app.scheduleCacheSave();
        }

        // GuiWindowEditor.ShowInfo / ShowWarn / ShowError / ShowOther
        // Drawing only when something can change (web only, for speed and battery): while the song plays, the mouse or
        // keys are in use, a toast is showing or the map changes, every frame; for a moment after (so hover fades and
        // the like finish), then about 15 frames a second while nothing happens. A MacBook's screen asks for 120 frames
        // a second, every one of them the whole editor at twice the pixels.
        keepAwake(ms = 1000) {
            this.awakeUntil = Math.max(this.awakeUntil || 0, performance.now() + ms);
        }

        toast(text, kind = 'info') {
            this.keepAwake(2200);
            const s = this.settings;
            const color = kind === 'warn' ? s.color2 : kind === 'error' ? [255, 200, 0] : kind === 'other' ? [255, 109, 0] : s.color1;
            this.ui && this.ui.Toast.show(text, color);
        }

        // ------------------------------------------------------------ music helpers (MusicPlayer.Play/Pause)

        playMusic() {
            this.music.play(this.currentTime);
        }

        pauseMusic() {
            this.currentTime = clamp(this.music.pause(), 0, this.totalTime);
        }

        togglePlay() {
            if (this.music.isPlaying)
                this.pauseMusic();
            else {
                if (this.currentTime >= this.totalTime - 1)
                    this.currentTime = 0;
                this.playMusic();
            }
        }

        setTempoSlider(v) {
            this.map.tempoSlider = v;
            this.music.setTempo(this.map.tempo);
        }

        // ------------------------------------------------------------ timing helpers bound to this map

        closestBeat(ms, draggingPoint = null, ignoreDivisor = false) {
            return Timing.getClosestBeat(this.map, this.settings, ms, draggingPoint, ignoreDivisor);
        }

        currentBpm(ms, draggingPoint = null) {
            return Timing.getCurrentBpm(this.map, ms, draggingPoint);
        }

        // Timing.Advance
        advance(reverse = false) {
            if (this.currentBpm(this.currentTime).bpm > 0)
                this.currentTime = Timing.getClosestBeatScroll(this.map, this.settings, this.currentTime, reverse);
        }

        // Timing.Scroll
        scroll(reverse, mult = 1) {
            const delta = mult * (reverse ? -1 : 1);
            let currentTime = this.currentTime;
            const totalTime = this.totalTime;

            if (this.music.isPlaying && !this.settings.pauseScroll) {
                currentTime += delta * 500 * this.map.tempo;
                currentTime = clamp(currentTime, 0, totalTime);
                this.currentTime = currentTime;
                this.music.seek(currentTime);
            } else {
                if (this.music.isPlaying)
                    this.pauseMusic();
                currentTime = this.currentTime;

                const closest = Timing.getClosestBeatScroll(this.map, this.settings, currentTime, delta < 0);
                const bpm = this.currentBpm(0);

                currentTime = closest >= 0 || bpm.bpm > 0 ? closest : currentTime + delta / 10 * 1000 / this.map.zoom * 0.5;

                if (this.currentBpm(this.currentTime).bpm === 0 && this.currentBpm(currentTime).bpm !== 0)
                    currentTime = this.currentBpm(currentTime).ms;

                this.currentTime = clamp(currentTime, 0, totalTime);
            }
        }

        get clickMode() {
            const s = this.settings;
            return s.separateClickTools ? (s.selectTool ? 'select' : 'place') : 'both';
        }

        get canSelect() {
            return this.clickMode !== 'place';
        }

        get canPlace() {
            return this.clickMode !== 'select';
        }

        get renderNotes() {
            return this.map.renderMode === RenderMode.Notes || this.map.objectMode === ObjectMode.Note;
        }

        // ------------------------------------------------------------ input

        attachInput() {
            this.handlers = {
                mousemove: e => this.onMouseMove(e),
                mousedown: e => this.onMouseDown(e),
                mouseup: e => this.onMouseUp(e),
                wheel: e => this.onWheel(e),
                keydown: e => this.onKeyDown(e),
                keyup: e => this.onKeyUp(e),
                paste: e => this.onPaste(e),
                contextmenu: e => {
                    if (e.target === this.canvas)
                        e.preventDefault();
                },
                blur: () => {
                    this.keys = { ctrl: false, alt: false, shift: false };
                },
                wake: () => this.keepAwake(1000),
            };
            for (const type of WAKE_EVENTS)
                window.addEventListener(type, this.handlers.wake, { capture: true, passive: true });
            this.keepAwake(1000);

            window.addEventListener('mousemove', this.handlers.mousemove);
            window.addEventListener('mousedown', this.handlers.mousedown);
            window.addEventListener('mouseup', this.handlers.mouseup);
            window.addEventListener('wheel', this.handlers.wheel, { passive: false });
            window.addEventListener('keydown', this.handlers.keydown);
            window.addEventListener('keyup', this.handlers.keyup);
            this.fit = G.fitCanvas(this.canvas, (w, h) => this.resize(w, h));
            window.addEventListener('paste', this.handlers.paste);
            window.addEventListener('contextmenu', this.handlers.contextmenu);
            window.addEventListener('blur', this.handlers.blur);
        }

        detachInput() {
            const h = this.handlers;
            for (const type of WAKE_EVENTS)
                window.removeEventListener(type, h.wake, { capture: true });
            window.removeEventListener('mousemove', h.mousemove);
            window.removeEventListener('mousedown', h.mousedown);
            window.removeEventListener('mouseup', h.mouseup);
            window.removeEventListener('wheel', h.wheel);
            window.removeEventListener('keydown', h.keydown);
            window.removeEventListener('keyup', h.keyup);
            this.fit.dispose();
            window.removeEventListener('paste', h.paste);
            window.removeEventListener('contextmenu', h.contextmenu);
            window.removeEventListener('blur', h.blur);
        }

        resize(w = window.innerWidth, h = window.innerHeight) {
            this.win.resize(w, h);
            TRACK = this.ui.Track.rect;
            GRID = this.ui.Grid.rect;
        }

        updateModifiers(e) {
            this.keys.ctrl = e.ctrlKey || e.metaKey;
            this.keys.alt = e.altKey;
            this.keys.shift = e.shiftKey;
        }

        isCanvasEvent(e) {
            return e.target === this.canvas;
        }

        // GuiWindow.Render -> MouseMove, then the grid / track MouseMove handlers
        onMouseMove(e) {
            this.updateModifiers(e);
            const x = e.clientX, y = e.clientY;
            this.mouse.x = x;
            this.mouse.y = y;

            this.win.mouseMove(x, y);
            this.gridMouseMove(x, y);
            this.trackMouseMove(x, y);
        }

        // GuiWindow.MouseDown: controls are visited in reverse order, so the track and grid come first
        onMouseDown(e) {
            this.updateModifiers(e);
            if (!this.isCanvasEvent(e))
                return;
            if (document.activeElement && document.activeElement !== document.body)
                document.activeElement.blur();

            const x = e.clientX, y = e.clientY;
            this.mouse.x = x;
            this.mouse.y = y;
            this.win.mouseMove(x, y);
            this.win.buttonClicked = false;

            if (e.button === 0) {
                this.mouse.left = true;

                if (inRect(TRACK, x, y)) {
                    this.trackMouseDownLeft(x, y);
                    this.win.buttonClicked = true;
                }
                this.trackMouseDownLeftGlobal(x, y);

                if (!this.win.buttonClicked && !this.win.hoveringInteractive())
                    this.gridMouseDownLeftGlobal(x, y);
                if (inRect(GRID, x, y))
                    this.win.buttonClicked = true;

                this.win.mouseDown(x, y, 0);
            } else if (e.button === 2) {
                this.mouse.right = true;

                // GuiTrack.MouseDownRightGlobal
                this.map.selectedPoint = null;
                const hoveringList = this.ui.controls.some(c => c instanceof G.ButtonList && c.visible && c.hovering);
                if (!inRect(TRACK, x, y) && !hoveringList)
                    this.map.clearSelected();
                if (inRect(TRACK, x, y)) {
                    this.trackMouseDownRight(x, y);
                    this.win.buttonClicked = true;
                }

                this.win.mouseDown(x, y, 2);
            }
        }

        onMouseUp(e) {
            this.updateModifiers(e);
            const x = e.clientX, y = e.clientY;

            if (e.button === 0 && this.mouse.left) {
                this.mouse.left = false;
                this.trackMouseUpLeft(x, y);
                this.gridMouseUpLeftGlobal(x, y);
                this.win.mouseUp(x, y, 0);
            } else if (e.button === 2 && this.mouse.right) {
                this.mouse.right = false;
                this.selecting = false;
                this.win.mouseUp(x, y, 2);
            }
        }

        // GuiWindowEditor.MouseScroll
        onWheel(e) {
            if (!this.isCanvasEvent(e))
                return;
            e.preventDefault();
            this.updateModifiers(e);
            if (e.deltaY === 0)
                return;

            const delta = e.deltaY < 0 ? 1 : -1;
            this.win.scroll(e.clientX, e.clientY, delta);
            if (this.win.root.consumesScroll())
                return;

            if (this.keys.shift) {
                const step = 0.5 * (this.keys.ctrl ? 1 : 2) * delta;
                this.map.beatDivisor = clamp(this.map.beatDivisor + step, 0, 31);
            } else if (this.keys.ctrl)
                this.map.incrementZoom(delta);
            else
                this.scroll(delta < 0 !== this.settings.reverseScroll, 1);
        }

        // Windowing.TextboxFocused - canvas textboxes plus the HTML inputs of the floating windows
        textboxFocused() {
            if (this.win.textboxFocused())
                return true;
            const el = document.activeElement;
            return el && (el.tagName === 'INPUT' && !['checkbox', 'range', 'button', 'color', 'file'].includes(el.type) || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');
        }

        onPaste(e) {
            if (this.win.textboxFocused()) {
                e.preventDefault();
                this.win.paste((e.clipboardData || window.clipboardData).getData('text'));
            }
        }

        onKeyDown(e) {
            this.updateModifiers(e);
            if (this.app.dialogOpen())
                return;

            if (this.win.textboxFocused()) {
                const handled = this.win.keyDown(e);
                if (handled === true || (e.key === ' '))
                    e.preventDefault();
                return;
            }
            if (this.textboxFocused()) {
                if (e.code === 'Escape')
                    document.activeElement.blur();
                return;
            }

            const binds = SSQE.Settings.compareKeybind(this.settings, e.code, this.keys.ctrl, this.keys.alt, this.keys.shift);
            if (binds.length || ['Space', 'ArrowLeft', 'ArrowRight', 'Tab', 'F11'].includes(e.code))
                e.preventDefault();

            for (const bind of binds)
                this.runKeybind(bind);

            // GuiTrack.KeyDown
            if (e.code === 'Space' && !e.repeat && (!this.trackDragging || this.draggingObjects.length || this.draggingDuration) && !this.ui.Timeline.dragging)
                this.togglePlay();
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight')
                this.scroll(e.code === 'ArrowLeft');
            if (e.code === 'Escape')
                this.map.clearSelected();

            // MainWindow: F11 toggles fullscreen
            if (e.code === 'F11') {
                if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => { });
                else
                    document.documentElement.requestFullscreen().catch(() => { });
            }
        }

        onKeyUp(e) {
            this.updateModifiers(e);
        }

        // ------------------------------------------------------------ keybinds (KeybindManager.ParseKeybind)

        runKeybind(bind) {
            const map = this.map;
            const s = this.settings;

            if (bind.startsWith('pattern')) {
                const index = parseInt(bind.slice(7), 10);
                if (this.keys.shift) {
                    if (Patterns.storePattern(map, s, index)) {
                        SSQE.Settings.save(s);
                        this.toast(`BOUND PATTERN ${index}`);
                    }
                } else if (this.keys.ctrl) {
                    s.patterns[index] = '';
                    SSQE.Settings.save(s);
                    this.toast(`UNBOUND PATTERN ${index}`);
                } else
                    Patterns.recallPattern(map, s, index);
                return;
            }

            if (bind.startsWith('gridKey')) {
                const [gx, gy] = bind.slice(7).split('|').map(Number);
                this.gridKey(2 - gx, 2 - gy);
                return;
            }

            switch (bind) {
                case 'selectAll':
                    map.clearSelected();
                    if (this.renderNotes)
                        map.notes.selected = [...map.notes.items];
                    else {
                        const list = map.renderMode === RenderMode.VFX ? map.vfxObjects : map.specialObjects;
                        list.selected = map.objectMode !== ObjectMode.Disabled ? list.items.filter(n => n.id === map.objectMode) : [...list.items];
                    }
                    break;
                case 'undo':
                    map.undo.undo();
                    break;
                case 'redo':
                    map.undo.redo();
                    break;
                case 'copy':
                    this.copySelection(false);
                    break;
                case 'cut':
                    this.copySelection(true);
                    break;
                case 'paste':
                    this.paste();
                    break;
                case 'delete':
                    this.deleteSelection();
                    break;
                case 'quantum':
                    s.enableQuantum = !s.enableQuantum;
                    this.settingsChanged();
                    break;
                case 'anchorNode':
                    if (map.notes.selected.length)
                        map.notes.edit('ANCHOR NODE[S]', n => n.anchored = !n.anchored);
                    break;
                case 'exportSSPM':
                    this.app.dialogs.exportSspm(this);
                    break;
                case 'createBPM':
                    if (map.notes.selected.length === 2) {
                        const [a, b] = map.notes.selected;
                        const min = Math.min(a.ms, b.ms), max = Math.max(a.ms, b.ms);
                        const bpm = Math.round(60000 / (max - min) * 4) / 4;
                        if (bpm > 0 && Number.isFinite(bpm))
                            map.replacePoints('CREATE TIMING POINT', [], [new TimingPoint(bpm, min)]);
                    }
                    break;
                case 'hFlip':
                    this.hFlip();
                    break;
                case 'vFlip':
                    this.vFlip();
                    break;
                case 'switchClickTool':
                    s.selectTool = !s.selectTool;
                    this.settingsChanged();
                    break;
                case 'openTimings':
                    this.app.dialogs.timings(this);
                    break;
                case 'openBookmarks':
                    this.app.dialogs.bookmarks(this);
                    break;
                case 'storeNodes':
                    this.storeNodes();
                    break;
                case 'drawBezier':
                    this.runBezier();
                    break;
                case 'save':
                    this.app.save(this.map);
                    break;
                case 'saveAs':
                    this.app.saveAs(this.map);
                    break;
            }
        }

        settingsChanged() {
            SSQE.Settings.save(this.settings);
            this.music.updateVolume();
            this.app.applyTheme();
        }

        // ------------------------------------------------------------ editing actions

        copySelection(cut) {
            const map = this.map;
            const lists = [[map.notes, 'NOTES', 'NOTE[S]'], [map.vfxObjects, 'OBJECTS', 'OBJECT[S]'], [map.specialObjects, 'OBJECTS', 'OBJECT[S]']];

            for (const [list, label, undoLabel] of lists) {
                if (list.selected.length) {
                    const copied = [...list.selected];
                    this.app.copyObjects(copied);
                    if (cut)
                        list.removeObjects(`CUT ${undoLabel}`, copied);
                    this.toast(`${cut ? 'CUT' : 'COPIED'} ${label}`, 'other');
                    return;
                }
            }
        }

        paste() {
            const map = this.map;
            const s = this.settings;
            // (what was copied last, in this map or another one, in this window or another one, see app.copyObjects)
            const copied = this.app.copiedObjects();
            if (!copied.length)
                return;

            const isNote = copied[0] instanceof Note;
            const offset = Math.min(...copied.map(n => n.ms));
            const max = Math.max(...copied.map(n => n.ms));

            copied.forEach(n => n.ms = Math.trunc(clamp(this.currentTime + n.ms - offset, 0, this.totalTime)));

            const jump = () => {
                if (s.jumpPaste) {
                    this.currentTime += max - offset;
                    if (s.autoAdvance)
                        this.advance();
                }
            };

            if (isNote && this.renderNotes) {
                if (s.pasteReversed) {
                    for (let i = 0; i < Math.trunc(copied.length / 2); i++) {
                        const cur = copied[i], opp = copied[copied.length - 1 - i];
                        [cur.x, cur.y, opp.x, opp.y] = [opp.x, opp.y, cur.x, cur.y];
                    }
                }

                if (s.applyOnPaste) {
                    for (const note of copied) {
                        Patterns.rotate(note, s.rotateBy, s.clampSR);
                        Patterns.scale(note, s.scaleBy, s.clampSR);
                    }
                }

                map.notes.addObjects('PASTE NOTE[S]', copied);
                jump();
            } else if (!isNote && map.renderMode !== RenderMode.Notes) {
                const vfx = copied.filter(o => Formats.VFX_LOOKUP[o.id]);
                const special = copied.filter(o => !Formats.VFX_LOOKUP[o.id]);

                if (map.renderMode === RenderMode.VFX)
                    map.vfxObjects.addObjects('PASTE OBJECT[S]', vfx);
                else
                    map.specialObjects.addObjects('PASTE OBJECT[S]', special);
                jump();
            }
        }

        // GuiTrack.KeybindUsed("delete")
        deleteSelection() {
            const map = this.map;
            if (map.selectedPoint)
                map.replacePoints('DELETE POINT', [map.selectedPoint], []);
            else if (this.renderNotes)
                map.notes.removeObjects('DELETE NOTE[S]');
            else if (map.renderMode === RenderMode.VFX)
                map.vfxObjects.removeObjects('DELETE OBJECT[S]');
            else
                map.specialObjects.removeObjects('DELETE OBJECT[S]');
        }

        hFlip() {
            this.map.notes.edit('HORIZONTAL FLIP', Patterns.horizontalFlip);
        }

        vFlip() {
            this.map.notes.edit('VERTICAL FLIP', Patterns.verticalFlip);
        }

        rotate(deg) {
            this.map.notes.edit(`ROTATE ${deg}`, n => Patterns.rotate(n, deg, this.settings.clampSR));
        }

        scaleNotes(scale) {
            this.map.notes.edit(`SCALE ${scale}%`, n => Patterns.scale(n, scale, this.settings.clampSR));
        }

        storeNodes() {
            const notes = this.map.notes;
            const selected = new Set(notes.selected);
            notes.bezierNodes = [];
            notes.items.forEach((n, i) => {
                if (selected.has(n))
                    notes.bezierNodes.push(i);
            });
        }

        clearNodes() {
            this.map.notes.bezierNodes = [];
        }

        // Patterns.RunBezier
        runBezier() {
            const map = this.map;
            const s = this.settings;
            const divisor = Math.trunc(s.bezierDivisor + 0.5);
            const nodesIdx = map.notes.bezierNodes;

            if (divisor > 0 && (nodesIdx.length > 1 || map.notes.selected.length > 1)) {
                const nodes = nodesIdx.length > 1 ? nodesIdx.map(i => map.notes.items[i]).filter(Boolean) : [...map.notes.selected].sort((a, b) => a.ms - b.ms);
                const result = [];

                try {
                    for (const segment of Patterns.bezierSegments(nodes, divisor, s.curveBezier))
                        for (let j = 1; j < segment.length; j++)
                            result.push(segment[j]);
                } catch {
                    this.toast('FAILED TO DRAW BEZIER', 'error');
                    return;
                }

                if (result.some(n => !Number.isFinite(n.x) || !Number.isFinite(n.y))) {
                    this.toast('TOO MANY NODES', 'error');
                    return;
                }

                map.clearSelected();
                result.push(nodes[0]);
                map.notes.replace('DRAW BEZIER', nodes, result);
            }

            for (const note of map.notes.items)
                note.anchored = false;
            map.notes.bezierNodes = [];
        }

        // ------------------------------------------------------------ grid (GuiGrid.cs)

        get gridTextScale() {
            return GRID.w / 300;
        }

        get cellSize() {
            return GRID.w / 3;
        }

        get cellBounds() {
            return this.settings.enableQuantum ? [-0.85, 2.85] : [0, 2];
        }

        mouseToGridUnclampedOld(mx, my) {
            const s = this.settings;
            const quantum = s.enableQuantum;
            const inc = quantum ? (s.quantumSnapping + 3) / 3 : 1;
            let x = (mx - GRID.x - GRID.w / 2) / GRID.w * 3 + 1 / inc;
            let y = (my - GRID.y - GRID.h / 2) / GRID.h * 3 + 1 / inc;

            if (s.quantumGridSnap || !quantum) {
                x = Math.floor((x + 1 / inc / 2) * inc) / inc;
                y = Math.floor((y + 1 / inc / 2) * inc) / inc;
            }

            x = x - 1 / inc + 1;
            y = y - 1 / inc + 1;
            return [2 - x, 2 - y];
        }

        mouseToGridUnclamped(mx, my) {
            const s = this.settings;
            const quantum = s.enableQuantum;
            const cell = this.cellSize;

            if (quantum) {
                mx -= cell * (s.quantumXOffset - 1);
                my -= cell * (s.quantumYOffset - 1);
            }

            const inc = quantum ? 2 / (s.quantumSnapping + 2) : 1;
            let x = (mx - GRID.x - cell / 2) / cell;
            let y = (my - GRID.y - cell / 2) / cell;

            if (s.quantumGridSnap || !quantum) {
                x = roundEven(x / inc) * inc;
                y = roundEven(y / inc) * inc;
            }

            if (quantum) {
                x += s.quantumXOffset - 1;
                y += s.quantumYOffset - 1;
            }

            return [2 - x, 2 - y];
        }

        mouseToGrid(mx, my) {
            const pos = this.settings.oldQuantumSnap ? this.mouseToGridUnclampedOld(mx, my) : this.mouseToGridUnclamped(mx, my);
            const [lo, hi] = this.cellBounds;
            return [clamp(pos[0], lo, hi), clamp(pos[1], lo, hi)];
        }

        gridMouseMove(x, y) {
            const hover = this.mouseToGrid(x, y);
            const unclamped = this.mouseToGridUnclamped(x, y);

            this.hoveringCell = Math.abs(hover[0] - unclamped[0]) <= 1 && Math.abs(hover[1] - unclamped[1]) <= 1 ? hover : null;

            if (this.placing && !this.music.isPlaying) {
                if (!this.lastPlacedPos || hover[0] !== this.lastPlacedPos[0] || hover[1] !== this.lastPlacedPos[1]) {
                    const ms = this.closestBeat(this.currentTime);
                    this.map.notes.addObjects('ADD NOTE', new Note(hover[0], hover[1], ms >= 0 ? ms : Math.trunc(this.currentTime)));

                    if (this.settings.autoAdvance)
                        this.advance();

                    this.lastPlacedPos = hover;
                }
            } else if (this.draggingXY.length) {
                const drag = this.draggingXY[0];
                let xOff = hover[0] - drag.x;
                let yOff = hover[1] - drag.y;
                if (xOff === 0 && yOff === 0)
                    return;

                let minX = drag.x, maxX = drag.x, minY = drag.y, maxY = drag.y;
                for (const o of this.draggingXY) {
                    minX = Math.min(minX, o.x);
                    maxX = Math.max(maxX, o.x);
                    minY = Math.min(minY, o.y);
                    maxY = Math.max(maxY, o.y);
                }

                const [lo, hi] = this.cellBounds;
                xOff = Math.max(lo, minX + xOff) - minX;
                xOff = Math.min(hi, maxX + xOff) - maxX;
                yOff = Math.max(lo, minY + yOff) - minY;
                yOff = Math.min(hi, maxY + yOff) - maxY;

                for (let i = 1; i < this.draggingXY.length; i++) {
                    this.draggingXY[i].x += xOff;
                    this.draggingXY[i].y += yOff;
                }
            }
        }

        gridMouseDownLeftGlobal() {
            const map = this.map;
            const mode = this.clickMode;

            if ((this.hoveringXY === null && mode === 'both') || mode === 'place') {
                if (!this.renderNotes || this.hoveringCell === null)
                    return;

                const ms = this.closestBeat(this.currentTime);
                const [px, py] = this.hoveringCell;
                map.notes.addObjects('ADD NOTE', new Note(px, py, ms >= 0 ? ms : Math.trunc(this.currentTime)));

                if (this.settings.autoAdvance && !this.music.isPlaying)
                    this.advance();

                this.lastPlacedPos = this.hoveringCell;
                this.placing = true;
            } else if (this.hoveringXY !== null) {
                const hovering = this.hoveringXY;
                let selected = map.selectedObjects.filter(n => n instanceof XYMapObject);

                if (this.keys.shift) {
                    const first = selected[0] || hovering;
                    const min = Math.min(first.ms, hovering.ms), max = Math.max(first.ms, hovering.ms);
                    selected = map.getObjectsInRange(min, max).filter(n => n instanceof XYMapObject && n !== first);
                    selected.unshift(first);
                } else if (this.keys.ctrl) {
                    if (hovering.selected)
                        selected = selected.filter(n => n !== hovering);
                    else
                        selected.push(hovering);
                } else if (!selected.length || !selected.includes(hovering))
                    selected = [hovering];

                map.selectedObjects = selected;

                if (hovering.selected) {
                    this.draggingXY = [hovering, ...selected];
                    this.dragCellStart = [hovering.x, hovering.y];
                }
            }
        }

        gridMouseUpLeftGlobal() {
            this.placing = false;
            this.lastPlacedPos = null;

            if (this.draggingXY.length) {
                const dx = this.draggingXY[0].x - this.dragCellStart[0];
                const dy = this.draggingXY[0].y - this.dragCellStart[1];

                if (dx * dx + dy * dy > 0) {
                    for (let i = 1; i < this.draggingXY.length; i++) {
                        this.draggingXY[i].x -= dx;
                        this.draggingXY[i].y -= dy;
                    }

                    const list = this.map.activeList;
                    list.edit(list === this.map.notes ? 'MOVE NOTE[S]' : 'MOVE OBJECT[S]', n => {
                        if ('x' in n) {
                            n.x += dx;
                            n.y += dy;
                        }
                    });
                }

                this.draggingXY = [];
            }
        }

        // GuiGrid.KeybindUsed
        gridKey(x, y) {
            const map = this.map;
            const s = this.settings;
            let ms = Math.min(this.closestBeat(this.currentTime), Math.trunc(this.totalTime));
            if (ms < 0)
                ms = Math.trunc(this.currentTime);

            if (this.renderNotes) {
                if (!s.moveOnGridKey || !map.notes.selected.length) {
                    map.notes.addObjects('ADD NOTE', new Note(x, y, ms));
                    if (s.moveOnGridKey)
                        map.notes.clearSelected();
                } else {
                    map.notes.edit('MOVE NOTE[S]', n => {
                        n.x = x;
                        n.y = y;
                    });
                    return;
                }
            } else if (map.renderMode === RenderMode.Special && OBJECT_LOOKUP[map.objectMode]) {
                const factory = OBJECT_LOOKUP[map.objectMode][`${x},${y}`];
                if (!factory)
                    return;
                const obj = factory();
                obj.ms = ms;
                map.specialObjects.addObjects(`ADD ${obj.name.toUpperCase()}`, obj);
            } else
                return;

            if (s.autoAdvance)
                this.advance();
        }

        // GuiGrid.PreRender - placing notes while the song plays and the mouse is held
        gridPreRender() {
            if (this.placing && this.music.isPlaying) {
                const ms = this.closestBeat(this.currentTime);
                if (ms > 0 && ms <= this.currentTime && !this.map.notes.items.some(n => Math.abs(n.ms - ms) < 2)) {
                    const [px, py] = this.mouseToGrid(this.mouse.x, this.mouse.y);
                    this.map.notes.addObjects('ADD NOTE', new Note(px, py, ms));
                }
            }
        }

        // ------------------------------------------------------------ track (GuiTrack.cs)

        get msToPx() {
            return this.map.zoom * 0.5;
        }

        get pxToMs() {
            return 2 / this.map.zoom;
        }

        get trackNoteSize() {
            return TRACK.h * 0.52;
        }

        get trackCellGap() {
            return TRACK.h * 0.14;
        }

        trackMouseMove(x) {
            const totalTime = this.totalTime;
            const cursorPos = TRACK.w * this.settings.cursorPos / 100;
            let cursorMs = (x - cursorPos) * this.pxToMs + this.currentTime;
            if (x === this.dragXStart)
                return;

            const bpm = this.currentBpm(cursorMs).bpm;
            const stepX = 60000 / bpm * this.msToPx / this.map.beatDivisor;
            const threshold = clamp(stepX / 1.75, 1, 12) || 12;

            if (this.draggingObjects.length)
                cursorMs -= this.trackNoteSize / 2 * this.pxToMs;

            const first = this.draggingObjects[0];

            if (first instanceof TimingPoint) {
                let snapped = this.closestBeat(cursorMs, first);
                const snappedNote = this.map.notes.getClosest(cursorMs);

                if (Math.abs(snappedNote - cursorMs) < Math.abs(snapped - cursorMs))
                    snapped = snappedNote;
                if (Math.abs(snapped - cursorMs) * this.msToPx <= threshold)
                    cursorMs = snapped;
                if (Math.abs(cursorMs) * this.msToPx <= threshold)
                    cursorMs = 0;

                first.ms = Math.trunc(Math.min(cursorMs, totalTime));
                this.map.sortTimings();
            } else {
                if (bpm > 0) {
                    const snapped = this.closestBeat(cursorMs);
                    if (Math.abs(snapped - cursorMs) * this.msToPx <= threshold)
                        cursorMs = snapped;
                }

                if (this.draggingDuration)
                    this.draggingDuration.duration = Math.trunc(Math.max(cursorMs - this.draggingDuration.ms, 0));
                else if (this.draggingObjects.length) {
                    const offset = cursorMs - first.dragStartMs;
                    for (const obj of this.draggingObjects)
                        obj.ms = Math.trunc(clamp(obj.dragStartMs + offset, 0, totalTime));
                    this.map.sortObjects();
                } else if (this.trackDragging) {
                    let time = this.dragMsStart - (x - this.dragXStart) * this.pxToMs;
                    if (this.currentBpm(time).bpm > 0)
                        time = this.closestBeat(time);
                    this.currentTime = clamp(time, 0, totalTime);
                }
            }
        }

        trackMouseDownLeft(x) {
            const map = this.map;
            let playCheck = false;

            if (this.hoveringDuration) {
                this.draggingObjects = [];
                this.draggingDuration = this.hoveringDuration;
                this.draggingDuration.dragStartMs = this.draggingDuration.duration;
                map.clearSelected();
            } else if (this.hoveringObject && !(this.hoveringObject instanceof TimingPoint)) {
                const hovering = this.hoveringObject;
                let selected = map.selectedObjects;

                if (this.keys.shift) {
                    const first = selected[0] || hovering;
                    const min = Math.min(first.ms, hovering.ms), max = Math.max(first.ms, hovering.ms);
                    selected = map.getObjectsInRange(min, max).filter(n => n !== first);
                    selected.unshift(first);
                } else if (this.keys.ctrl) {
                    if (hovering.selected)
                        selected = selected.filter(n => n !== hovering);
                    else
                        selected.push(hovering);
                } else if (!selected.includes(hovering))
                    selected = [hovering];

                map.clearSelected();
                map.selectedObjects = selected;

                if (hovering.selected) {
                    this.draggingObjects = [hovering, ...selected];
                    for (const obj of this.draggingObjects)
                        obj.dragStartMs = obj.ms;
                }

                this.draggingDuration = null;
            } else if (!this.hoveringObject)
                playCheck = true;

            this.dragMsStart = this.currentTime;
            this.dragXStart = x;
            this.trackDragging = true;

            this.shouldReplay = playCheck && this.music.isPlaying;
            if (this.shouldReplay)
                this.pauseMusic();
        }

        trackMouseDownLeftGlobal() {
            if (this.hoveringObject instanceof TimingPoint) {
                const point = this.hoveringObject;
                this.draggingObjects = [point];
                this.draggingDuration = null;
                point.dragStartMs = point.ms;

                this.map.clearSelected();
                this.map.selectedPoint = point;
            }
        }

        trackMouseUpLeft() {
            const map = this.map;
            const first = this.draggingObjects[0];

            if (first instanceof TimingPoint) {
                const diff = first.ms - first.dragStartMs;
                if (diff !== 0) {
                    first.ms = first.dragStartMs;
                    map.editPoints('MOVE POINT', [first], n => n.ms += diff);
                }
            } else if (first) {
                const diff = first.ms - first.dragStartMs;
                if (diff !== 0) {
                    for (const obj of this.draggingObjects)
                        obj.ms = obj.dragStartMs;
                    const list = map.activeList;
                    list.edit(list === map.notes ? 'MOVE NOTE[S]' : 'MOVE OBJECT[S]', n => n.ms += diff);
                }
            } else if (this.draggingDuration) {
                const d = this.draggingDuration;
                const diff = d.duration - d.dragStartMs;
                if (diff !== 0) {
                    d.duration = d.dragStartMs;
                    map.activeList.edit('MOVE OBJ DURATION', [d], n => n.duration += diff);
                }
            }

            this.draggingObjects = [];
            this.draggingDuration = null;

            if (this.trackDragging && this.shouldReplay)
                this.playMusic();
            this.shouldReplay = false;
            this.trackDragging = false;
        }

        trackMouseDownRight(x) {
            const cursorPos = TRACK.w * this.settings.cursorPos / 100;
            this.selectMsStart = (x - cursorPos) * this.pxToMs + this.currentTime;
            this.selectMsEnd = this.selectMsStart;
            this.selecting = true;
        }

        trackPreRender() {
            if (this.selecting) {
                const cursorPos = TRACK.w * this.settings.cursorPos / 100;
                this.selectMsEnd = (this.mouse.x - cursorPos) * this.pxToMs + this.currentTime;

                const start = Math.min(this.selectMsStart, this.selectMsEnd) - this.trackNoteSize * this.pxToMs;
                const end = Math.max(this.selectMsStart, this.selectMsEnd);
                this.map.selectedObjects = this.map.getObjectsInRange(start, end);
            }
        }

        // ------------------------------------------------------------ frame

        frame(now) {
            if (!this.running)
                return;
            // (nothing going on: a frame every 66ms or so, see keepAwake)
            if (this.map.version !== this.seenVersion) {
                this.seenVersion = this.map.version;
                this.keepAwake(600);
            }
            if (!this.music.isPlaying && now >= (this.awakeUntil || 0) && !this.mouse.left && !this.mouse.right && !this.selecting
                && now - this.lastFrame < 66) {
                this.raf = requestAnimationFrame(t => this.frame(t));
                return;
            }
            const frametime = Math.max(0, (now - this.lastFrame) / 1000);
            this.lastFrame = now;

            // (the song's length as the player knows it now: put right once the whole song is decoded, see audio.js,
            // so the timeline doesn't think the song is over early and jump to the end)
            const songMs = this.music.duration * 1000;
            if (this.music.loaded && songMs > 0 && Math.abs(songMs - this.map.duration) > 1)
                this.map.duration = songMs;

            if (this.music.isPlaying) {
                this.currentTime = clamp(this.music.currentTimeMs(), 0, this.totalTime);
                if (this.music.ended) {
                    // MusicPlayer.OnEnded
                    this.music.pause();
                    this.currentTime = this.totalTime;
                }
            }

            this.gridPreRender();
            this.trackPreRender();
            this.render(frametime);

            this.raf = requestAnimationFrame(t => this.frame(t));
        }

        color(i, a = 1) {
            const s = this.settings;
            const palette = [s.color1, s.color2, s.color3, s.color4, [255, 255, 255], [0, 255, 64], [0, 128, 255], [191, 191, 191], [255, 0, 0], [128, 128, 128], s.color5];
            const c = palette[i];
            return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        }

        // (i: which of the note colours, or web only, a colour of its own: in a collab, the colour of whoever placed it)
        noteColor(i, a = 1) {
            const cols = this.settings.noteColors;
            const c = Array.isArray(i) ? i : cols[i % cols.length];
            return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        }

        rgba(c, a = 1) {
            return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
        }

        // draws text with the editor's font layout; (x, y) is positioned according to align/baseline
        text(str, x, y, size, color, align = 'left', baseline = 'top', font = 'main') {
            if (!str)
                return;
            str = String(str);
            if (align === 'center')
                x -= G.Text.width(str, size, font) / 2;
            else if (align === 'right')
                x -= G.Text.width(str, size, font);
            const h = G.Text.height(size, font) * str.split('\n').length;
            if (baseline === 'middle')
                y -= h / 2;
            else if (baseline === 'bottom')
                y -= h;
            G.Text.draw(this.ctx, str, x, y, size, font, color);
        }

        render(frametime) {
            const ctx = this.ctx;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.fit.setTransform(ctx);

            this.ui.update();
            this.win.process(frametime);
            this.win.render(ctx);
            // (web only: drawn over the editor, e.g. collab.js's partner's mouse)
            this.afterRender && this.afterRender(ctx, this.win.width, this.win.height);
        }

        // ------------------------------------------------------------ grid rendering

        roundedRect(x, y, w, h, fill, stroke, lineWidth = 2) {
            const ctx = this.ctx;
            ctx.beginPath();
            if (this.settings.gridSquircles && ctx.roundRect)
                ctx.roundRect(x, y, w, h, Math.min(w, h) * (this.settings.gridSquircleRadius ?? 0.125) * 1.5);
            else
                ctx.rect(x, y, w, h);
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fill();
            }
            if (stroke) {
                ctx.strokeStyle = stroke;
                ctx.lineWidth = lineWidth;
                ctx.stroke();
            }
        }

        diamond(cx, cy, r, fill, stroke, lineWidth = 2) {
            const ctx = this.ctx;
            ctx.beginPath();
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r, cy);
            ctx.closePath();
            if (fill) {
                ctx.fillStyle = fill;
                ctx.fill();
            }
            if (stroke) {
                ctx.strokeStyle = stroke;
                ctx.lineWidth = lineWidth;
                ctx.stroke();
            }
        }

        line(x1, y1, x2, y2, color, width = 1) {
            const ctx = this.ctx;
            // GL draws thin lines as whole pixels; snap straight lines to whole device pixels so they aren't blurred away
            if (x1 === x2 || y1 === y2) {
                const r = G.pixelRatio;
                const devices = Math.max(1, Math.round(width * r));
                const snap = v => (Math.floor(v * r) + (devices % 2 ? 0.5 : 0)) / r;
                width = devices / r;
                if (x1 === x2)
                    x1 = x2 = snap(x1);
                if (y1 === y2)
                    y1 = y2 = snap(y1);
            }
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.stroke();
        }

        renderGrid() {
            const ctx = this.ctx;
            const s = this.settings;
            const map = this.map;
            const cell = this.cellSize;
            // web only: Note Size (Graphics tab) scales the notes (and custom meshes) on the grid
            const noteSize = cell * 0.75 * clamp((s.gridNoteSize ?? 100) / 100, 0.25, 2), previewSize = cell * 0.65;
            const noteGap = (cell - noteSize) / 2, previewGap = (cell - previewSize) / 2;
            const t = this.currentTime;
            const ar = (s.approachRate + 1) / 10;
            const maxMs = t + 1000 / ar;
            const mx = this.mouse.x, my = this.mouse.y;

            // web only: 3D mode has its own, lower opacity for the grid itself so the notes stand out
            ctx.save();
            if (s.mode3D) {
                // solid backing first, so the background picture (it has a square right behind the grid) can't show
                // through and only the grid itself fades
                ctx.fillStyle = '#000';
                ctx.fillRect(GRID.x, GRID.y, GRID.w, GRID.h);
                ctx.globalAlpha = clamp(s.grid3DOpacity, 0, 255) / 255;
            }

            // background, outline and divisor lines (GuiGrid.Draw)
            ctx.fillStyle = `rgba(39,39,39,${s.gridOpacity / 255})`;
            ctx.fillRect(GRID.x, GRID.y, GRID.w, GRID.h);
            ctx.strokeStyle = 'rgb(52,52,52)';
            ctx.lineWidth = 1;
            ctx.strokeRect(GRID.x + 0.5, GRID.y + 0.5, GRID.w - 1, GRID.h - 1);

            for (let i = 1; i < 3; i++) {
                this.line(GRID.x + GRID.w / 3 * i, GRID.y, GRID.x + GRID.w / 3 * i, GRID.y + GRID.h, 'rgb(13,13,13)');
                this.line(GRID.x, GRID.y + GRID.h / 3 * i, GRID.x + GRID.w, GRID.y + GRID.h / 3 * i, 'rgb(13,13,13)');
            }

            if (s.oldQuantumSnap) {
                const divisor = s.quantumGridLines ? s.quantumSnapping + 3 : 3;
                const offset = Math.round(divisor) % 2 === 0 ? 0.5 : 1;
                for (let i = Math.trunc(2 * offset); i <= divisor; i++) {
                    const x = GRID.x + GRID.w / divisor * (i - offset);
                    const y = GRID.y + GRID.h / divisor * (i - offset);
                    this.line(x, GRID.y, x, GRID.y + GRID.h, 'rgb(52,52,52)');
                    this.line(GRID.x, y, GRID.x + GRID.w, y, 'rgb(52,52,52)');
                }
            } else {
                const inc = s.quantumGridLines ? 2 / (s.quantumSnapping + 2) : 1;
                const gap = (1 - inc) / 2;
                const gapInc = Math.floor(gap / inc) * inc;

                for (let x = (s.quantumXOffset - 1) % inc - inc; x < 3; x += inc) {
                    const pos = GRID.x + (x - gapInc + gap) * cell;
                    if (pos >= GRID.x - 0.001 && pos <= GRID.x + GRID.w + 0.001)
                        this.line(pos, GRID.y, pos, GRID.y + GRID.h, 'rgb(52,52,52)');
                }
                for (let y = (s.quantumYOffset - 1) % inc - inc; y < 3; y += inc) {
                    const pos = GRID.y + (y - gapInc + gap) * cell;
                    if (pos >= GRID.y - 0.001 && pos <= GRID.y + GRID.h + 0.001)
                        this.line(GRID.x, pos, GRID.x + GRID.w, pos, 'rgb(52,52,52)');
                }
            }

            // grid letters
            if (s.gridLetters) {
                const keys = s.numpad ? SSQE.Settings.NUMPAD_KEYS : s.gridKeys;
                const lookup = OBJECT_LOOKUP[map.objectMode];
                keys.forEach((code, i) => {
                    const gx = i % 3, gy = Math.trunc(i / 3);
                    if (map.renderMode !== RenderMode.Notes && map.objectMode !== ObjectMode.Note && (!lookup || !lookup[`${2 - gx},${2 - gy}`]))
                        return;
                    this.text(SSQE.Settings.keyName(code), GRID.x + gx * cell + cell / 2, GRID.y + gy * cell + cell / 2, 38 * this.gridTextScale, 'rgb(52,52,52)', 'center', 'middle');
                });
            }
            ctx.restore();

            // notes
            const notes = map.notes;
            const [low, high] = notes.searchRange(t, maxMs);
            const isSpecial = map.renderMode === RenderMode.Special;
            const showNotes = this.renderNotes;
            this.hoveringXY = null;

            // web only: 3D mode puts the notes in perspective, flying out from the middle of the grid towards their
            // cell (full size when hit), with notes that were just hit growing past it as they fade
            const mode3D = s.mode3D;
            const DEPTH = 5, PASSED_MS = 200;
            const window3D = Math.max(1, maxMs - t);
            const gcx = GRID.x + GRID.w / 2, gcy = GRID.y + GRID.h / 2;
            const place = (note, scale) => {
                const size = noteSize * scale;
                const cx = gcx + (GRID.x + (2 - note.x + 0.5) * cell - gcx) * scale;
                const cy = gcy + (GRID.y + (2 - note.y + 0.5) * cell - gcy) * scale;
                return [cx - size / 2, cy - size / 2, size];
            };

            const drawn = [];
            if (mode3D && s.mode3DHitEffect) {
                const [passedLow] = notes.searchRange(t - PASSED_MS, t);
                for (let i = passedLow; i < low; i++) {
                    const note = notes.items[i];
                    const age = clamp((t - note.ms) / PASSED_MS, 0, 1);
                    const [x, y, size] = place(note, 1 + age * 0.6);
                    drawn.push({ note, i, x, y, size, progress: 1 - age });
                }
            }
            for (let i = low; i < high; i++) {
                const note = notes.items[i];
                let x = GRID.x + (2 - note.x) * cell + noteGap;
                let y = GRID.y + (2 - note.y) * cell + noteGap;
                let size = noteSize;

                let progress = 1 - Math.min(1, (note.ms - t) * ar / 750);
                if (isSpecial && note.enableEasing)
                    progress = Easing.process(0, 1, progress, note.style, note.direction);
                else
                    progress = Math.min(1, progress ** 2);
                progress = clamp(progress, 0, 1);

                if (mode3D) {
                    const z = clamp((note.ms - t) / window3D, 0, 1);
                    [x, y, size] = place(note, 1 / (1 + z * DEPTH));
                } else if (this.canSelect && showNotes && Math.abs(mx - noteSize / 2 - x) <= noteSize / 2 && Math.abs(my - noteSize / 2 - y) <= noteSize / 2)
                    this.hoveringXY ??= note;

                drawn.push({ note, i, x, y, size, progress });
            }
            // far notes first so the near ones are drawn on top
            if (mode3D)
                drawn.sort((a, b) => a.size - b.size);

            for (const d of drawn) {
                const c = d.note.byColor || d.i % s.noteColors.length;
                const lineWidth = mode3D ? Math.max(1, 2 * d.size / noteSize) : 2;
                // web only: a custom note mesh (Settings > Player) is shown on the grid the way the player draws it
                const sprite = window.SSQECustom && SSQECustom.noteMeshSprite(Array.isArray(c) ? c : s.noteColors[c]);
                if (sprite) {
                    ctx.globalAlpha = clamp(d.progress, 0, 1);
                    ctx.drawImage(sprite, d.x, d.y, d.size, d.size);
                    ctx.globalAlpha = 1;
                } else if (!mode3D && d.size === noteSize) {
                    // (web only, for speed: the note's square drawn once per colour and faded in, the same look)
                    const sq = this.gridNoteSprite(c, noteSize);
                    ctx.globalAlpha = clamp(d.progress, 0, 1);
                    ctx.drawImage(sq.canvas, d.x - sq.pad, d.y - sq.pad, sq.w, sq.w);
                    ctx.globalAlpha = 1;
                } else
                    this.roundedRect(d.x, d.y, d.size, d.size, this.noteColor(c, 0.15 * d.progress), this.noteColor(c, d.progress), lineWidth);

                if (s.approachSquares && !mode3D) {
                    const size = 4 + noteSize + noteSize * (1 - d.progress) * 2 + 0.5;
                    this.roundedRect(d.x - size / 2 + noteSize / 2, d.y - size / 2 + noteSize / 2, size, size, null, this.noteColor(c, d.progress), Math.max(1, size * 0.0125));
                }
            }

            if (showNotes) {
                for (const d of drawn) {
                    if (d.note.selected)
                        this.roundedRect(d.x - 4, d.y - 4, d.size + 8, d.size + 8, null, this.color(6, d.progress), 2);
                    if (d.note.peerSel)
                        this.roundedRect(d.x - 7, d.y - 7, d.size + 14, d.size + 14, null, PEER_A(d.note.peerSel, d.progress), 2);
                    const flash = d.note.peerAt ? (performance.now() - d.note.peerAt) / PEER_FLASH : 1;
                    if (flash < 1)
                        this.roundedRect(d.x - 4 - 14 * flash, d.y - 4 - 14 * flash, d.size + 8 + 28 * flash, d.size + 8 + 28 * flash, null, PEER_A(d.note.peerColor, 1 - flash), 3);
                    if (this.hoveringXY === d.note)
                        this.roundedRect(d.x - 4, d.y - 4, d.size + 8, d.size + 8, null, this.color(5, 0.25), 2);
                }
            }

            if (s.gridNumbers) {
                for (const d of drawn)
                    this.text(fmtInt(d.i + 1), d.x + d.size / 2, d.y + d.size / 2, 28 * this.gridTextScale * d.size / noteSize, this.color(4, d.progress), 'center', 'middle');
            }

            // special objects
            if (isSpecial) {
                if (map.objectMode !== ObjectMode.Note)
                    this.hoveringXY = null;
                this.renderGridSpecial(t, maxMs, ar);
            }

            // place preview
            if (this.hoveringCell && !this.hoveringXY && this.canPlace && showNotes) {
                const [hx, hy] = this.hoveringCell;
                const x = GRID.x + (2 - hx) * cell + previewGap;
                const y = GRID.y + (2 - hy) * cell + previewGap;
                this.roundedRect(x, y, previewSize, previewSize, this.color(9, 0.125), this.color(9, 0.09375), 2);
            }

            // bezier preview
            const nodes = notes.bezierNodes.map(i => notes.items[i]).filter(Boolean);
            if (nodes.length > 1) {
                // (web only, for speed: worked out and drawn again only when the nodes, the divisor, the grid or the
                // colours change; every other frame it's one picture)
                const divisor = Math.trunc(s.bezierDivisor + 0.5);
                let key = `${divisor}|${s.curveBezier}|${GRID.x},${GRID.y},${cell},${previewGap},${previewSize}|${s.gridSquircles}|${s.gridSquircleRadius}|${G.pixelRatio}|${s.color2}`;
                for (const n of nodes)
                    key += `|${n.x},${n.y},${n.ms},${n.anchored ? 1 : 0}`;
                if (!this.bezierPreview || this.bezierPreview.key !== key) {
                    const pts = [];
                    for (const segment of Patterns.bezierSegments(nodes, divisor, s.curveBezier))
                        for (const n of segment)
                            pts.push([GRID.x + (2 - n.x) * cell + previewGap, GRID.y + (2 - n.y) * cell + previewGap]);
                    // (drawn once into a picture just big enough, at the screen's resolution, square by square as before
                    // so overlapping squares build up the same way)
                    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
                    for (const [x, y] of pts) {
                        x0 = Math.min(x0, x);
                        y0 = Math.min(y0, y);
                        x1 = Math.max(x1, x + previewSize);
                        y1 = Math.max(y1, y + previewSize);
                    }
                    const r = G.pixelRatio, pad = 4 / r + 2;
                    x0 = Math.floor((x0 - pad) * r) / r;
                    y0 = Math.floor((y0 - pad) * r) / r;
                    const pw = Math.min(8192, Math.ceil((x1 + pad - x0) * r)), ph = Math.min(8192, Math.ceil((y1 + pad - y0) * r));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, pw);
                    canvas.height = Math.max(1, ph);
                    const g = canvas.getContext('2d');
                    g.setTransform(r, 0, 0, r, -x0 * r, -y0 * r);
                    g.fillStyle = this.color(2, 0.125);
                    g.strokeStyle = this.color(2, 0.09375);
                    g.lineWidth = 2;
                    for (const [x, y] of pts) {
                        g.beginPath();
                        if (s.gridSquircles && g.roundRect)
                            g.roundRect(x, y, previewSize, previewSize, previewSize * (s.gridSquircleRadius ?? 0.125) * 1.5);
                        else
                            g.rect(x, y, previewSize, previewSize);
                        g.fill();
                        g.stroke();
                    }
                    g.strokeStyle = 'rgb(255,255,255)';
                    g.lineWidth = 1;
                    g.beginPath();
                    pts.forEach(([x, y], i) => i ? g.lineTo(x + previewSize / 2, y + previewSize / 2) : g.moveTo(x + previewSize / 2, y + previewSize / 2));
                    g.stroke();
                    this.bezierPreview = { key, canvas, x: x0, y: y0, w: canvas.width / r, h: canvas.height / r };
                }
                const bp = this.bezierPreview;
                ctx.drawImage(bp.canvas, bp.x, bp.y, bp.w, bp.h);
            }

            // autoplay cursor
            if (s.autoplay)
                this.renderAutoplay(low, t);
        }

        renderGridSpecial(t, maxMs, ar) {
            const map = this.map;
            const s = this.settings;
            const cell = this.cellSize;
            const objects = map.specialObjects;
            const [, high] = objects.searchRange(t, maxMs);
            const shouldCheckId = map.objectMode !== ObjectMode.Disabled;
            const mineSize = cell * 0.6, mineGap = (cell - mineSize) / 2;
            const c5 = s.color5;

            for (let i = 0; i < high; i++) {
                const obj = objects.items[i];
                if (obj.ms < t)
                    continue;
                if (shouldCheckId && obj.id !== map.objectMode)
                    continue;

                const progress = Math.min(1, (1 - Math.min(1, (obj.ms - t) * ar / 750)) ** 2);

                if (obj instanceof Mine) {
                    const x = GRID.x + (2 - obj.x) * cell + mineGap;
                    const y = GRID.y + (2 - obj.y) * cell + mineGap;
                    const cx = x + mineSize / 2, cy = y + mineSize / 2;

                    if (this.canSelect && Math.abs(this.mouse.x - cx) <= mineSize / 2 && Math.abs(this.mouse.y - cy) <= mineSize / 2)
                        this.hoveringXY ??= obj;

                    this.diamond(cx, cy, mineSize / 2, this.color(8, 0.15 * progress), this.color(8, progress));
                    if (s.approachSquares) {
                        const size = 4 + mineSize + mineSize * (1 - progress) * 2 + 0.5;
                        this.diamond(cx, cy, size / 2, null, this.color(8, progress), Math.max(1, size * 0.0125));
                    }
                    if (obj.selected)
                        this.diamond(cx, cy, mineSize / 2 + 4, null, this.color(6, progress));
                    if (this.hoveringXY === obj)
                        this.diamond(cx, cy, mineSize / 2 + 4, null, this.color(5, 0.25));
                } else if (obj.id === 12) {
                    this.ctx.strokeStyle = this.rgba(c5, progress);
                    this.ctx.lineWidth = 3;
                    this.ctx.strokeRect(GRID.x - 5, GRID.y - 5, GRID.w + 10, GRID.h + 10);
                    if (s.approachSquares) {
                        const size = 4 + GRID.w + GRID.w * (1 - progress) + 0.5;
                        this.ctx.lineWidth = Math.max(1, size * 0.0075);
                        this.ctx.strokeRect(GRID.x + GRID.w / 2 - size / 2, GRID.y + GRID.h / 2 - size / 2, size, size);
                    }
                } else if (obj instanceof Glide) {
                    const ctx = this.ctx;
                    const cx = GRID.x + GRID.w / 2, cy = GRID.y + GRID.h / 2;
                    ctx.save();
                    ctx.translate(cx, cy);
                    ctx.rotate(obj.direction * Math.PI / 2);
                    ctx.strokeStyle = this.rgba(c5, progress);
                    ctx.lineWidth = 3;
                    ctx.strokeRect(-GRID.w / 2 - 5, -GRID.h / 2 - 5, GRID.w + 10, GRID.h + 10);
                    this.line(-GRID.w / 2 + 10, -GRID.h / 2 + 13, GRID.w / 2 - 10, -GRID.h / 2 + 13, this.rgba(c5, progress), 6);
                    for (const oy of [-GRID.h / 5, GRID.h / 5]) {
                        ctx.beginPath();
                        const r = GRID.w / 10;
                        for (let k = 0; k < 3; k++) {
                            const a = (-90 + k * 120) * Math.PI / 180;
                            const px = Math.cos(a) * r, py = oy + Math.sin(a) * r;
                            k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
                        }
                        ctx.closePath();
                        ctx.lineWidth = 8;
                        ctx.stroke();
                    }
                    ctx.restore();
                }
            }
        }

        // GuiGrid autoplay cursor
        renderAutoplay(low, t) {
            const notes = this.map.notes.items;
            const cell = this.cellSize;
            const def = { x: 1, y: 1, ms: 0 };
            const index = Math.max(0, low - 1);

            let lastFar = index > 0 && index < notes.length ? notes[index - 1] : def;
            let last = index < notes.length ? notes[index] : def;
            let next = index + 1 < notes.length ? notes[index + 1] : last;
            let nextFar = index + 2 < notes.length ? notes[index + 2] : next;

            if (t > next.ms) {
                lastFar = last;
                last = next;
            }
            if (t < last.ms) {
                nextFar = next;
                next = last;
            }

            const diff = next.ms - last.ms;
            let p = diff === 0 ? 1 : (t - last.ms) / diff;
            let x = cell / 2 + GRID.x, y = cell / 2 + GRID.y;

            if (this.settings.smoothAutoplay) {
                const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * p + (2 * a - 5 * b + 4 * c - d) * p * p + (-a + 3 * b - 3 * c + d) * p * p * p);
                x += (2 - cr(lastFar.x, last.x, next.x, nextFar.x)) * cell;
                y += (2 - cr(lastFar.y, last.y, next.y, nextFar.y)) * cell;
            } else {
                p = Math.sin(p * Math.PI / 2);
                const lx = (2 - last.x) * cell, ly = (2 - last.y) * cell;
                const nx = (2 - next.x) * cell, ny = (2 - next.y) * cell;
                x += lx + (nx - lx) * p;
                y += ly + (ny - ly) * p;
            }

            // (in a collab: someone else's edit near here doesn't move it; only your own time or your own edit does)
            const hold = this.autoplayHold;
            if (hold && hold.t === t && hold.x !== undefined) {
                x = hold.x;
                y = hold.y;
                p = hold.p;
            } else {
                this.autoplayHold = null;
                this.autoplayLast = { t, x, y, p };
            }

            const width = Math.sin(p * Math.PI) * 8 + 16;
            // web only: the user's own cursor image (Settings > Graphics), animated GIFs included
            const custom = window.SSQECustom && SSQECustom.cursorFrame();
            if (custom) {
                const size = width * clamp((this.settings.cursorScale ?? 100) / 100, 0.25, 8) * GRID.w / 300 * 1.5;
                const iw = custom.naturalWidth || custom.width, ih = custom.naturalHeight || custom.height;
                const k = size / Math.max(iw, ih);
                this.ctx.drawImage(custom, x - iw * k / 2, y - ih * k / 2, iw * k, ih * k);
                return;
            }
            this.ctx.fillStyle = 'rgba(255,255,255,0.25)';
            this.ctx.fillRect(x - width / 2, y - width / 2, width, width);
            this.ctx.strokeStyle = 'rgba(255,255,255,1)';
            this.ctx.lineWidth = Math.max(1, width * 0.075);
            this.ctx.strokeRect(x - width / 2, y - width / 2, width, width);
        }

        // ------------------------------------------------------------ track rendering (GuiTrack.UpdateInstanceData)

        // A note's square on the grid (fill and outline as roundedRect draws them at full strength), as a picture at
        // the screen's resolution, one per colour and size
        gridNoteSprite(c, size) {
            const s = this.settings, r = G.pixelRatio, pad = 2;
            const key = `${Array.isArray(c) ? c.join(',') : c}|${size}|${r}|${s.gridSquircles}|${s.gridSquircleRadius}|${s.noteColors.join(';')}`;
            this.gridNotes ??= new Map();
            let sq = this.gridNotes.get(key);
            if (sq)
                return sq;
            if (this.gridNotes.size > 64)
                this.gridNotes.clear();
            const w = size + 2 * pad, px = Math.max(1, Math.ceil(w * r));
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = px;
            const g = canvas.getContext('2d');
            g.scale(px / w, px / w);
            g.beginPath();
            if (s.gridSquircles && g.roundRect)
                g.roundRect(pad, pad, size, size, size * (s.gridSquircleRadius ?? 0.125) * 1.5);
            else
                g.rect(pad, pad, size, size);
            g.fillStyle = this.noteColor(c, 0.15);
            g.fill();
            g.strokeStyle = this.noteColor(c, 1);
            g.lineWidth = 2;
            g.stroke();
            sq = { canvas, w, pad };
            this.gridNotes.set(key, sq);
            return sq;
        }

        // A note's box on the track with its mini grid (as renderTrack drew it shape by shape), as a picture at the
        // screen's resolution, one per colour, see-through-ness and size
        trackBox(c, a, noteSize, cellPos) {
            const r = G.pixelRatio;
            const key = `${Array.isArray(c) ? c.join(',') : c}|${a}|${noteSize}|${r}|${this.settings.noteColors.join(';')}`;
            this.trackBoxes ??= new Map();
            let box = this.trackBoxes.get(key);
            if (box)
                return box;
            if (this.trackBoxes.size > 64)
                this.trackBoxes.clear();
            const px = Math.max(1, Math.ceil(noteSize * r));
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = px;
            const g = canvas.getContext('2d');
            g.scale(px / noteSize, px / noteSize);
            g.fillStyle = this.noteColor(c, a / 20);
            g.fillRect(0, 0, noteSize, noteSize);
            g.strokeStyle = this.noteColor(c, a);
            g.lineWidth = 1;
            g.strokeRect(0.5, 0.5, noteSize - 1, noteSize - 1);
            g.strokeStyle = this.noteColor(c, a * 0.45);
            for (let k = 0; k < 9; k++)
                g.strokeRect(cellPos(2 - k % 3) + 0.5, cellPos(Math.trunc(k / 3)) + 0.5, noteSize * 0.2 - 1, noteSize * 0.2 - 1);
            box = { canvas, w: noteSize };
            this.trackBoxes.set(key, box);
            return box;
        }

        tintedSprite(id, color) {
            const key = `${id}|${color}`;
            if (this.tintedSprites[key])
                return this.tintedSprites[key];
            if (!this.spriteSheet.complete || !this.spriteSheet.naturalWidth)
                return null;

            const size = 80;
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const g = c.getContext('2d');
            g.drawImage(this.spriteSheet, (id % 4) * size, Math.trunc(id / 4) * size, size, size, 0, 0, size, size);
            g.globalCompositeOperation = 'source-in';
            g.fillStyle = color;
            g.fillRect(0, 0, size, size);
            this.tintedSprites[key] = c;
            return c;
        }

        renderTrack() {
            const ctx = this.ctx;
            const s = this.settings;
            const map = this.map;
            const H = TRACK.h, W = TRACK.w;
            const noteSize = this.trackNoteSize, cellGap = this.trackCellGap;
            const cellPos = x => x * noteSize * 0.3 + noteSize * 0.1;
            const msToPx = this.msToPx, pxToMs = this.pxToMs;

            const currentTime = this.currentTime;
            const totalTime = this.totalTime;
            const sfxOffset = s.sfxOffset;
            const currentPos = currentTime * msToPx;
            const cursorPos = W * s.cursorPos / 100;
            const endPos = cursorPos - currentPos + totalTime * msToPx + 1;
            const minMs = (-cursorPos - noteSize) * pxToMs + currentTime;
            const maxMs = (W - cursorPos) * pxToMs + currentTime;
            const msX = ms => cursorPos - currentPos + ms * msToPx;

            this.trackStartRel = Math.max(0, (-cursorPos * pxToMs + currentTime) / (totalTime || 1));
            this.trackEndRel = Math.min(1, ((W - cursorPos) * pxToMs + currentTime) / (totalTime || 1));

            // background
            ctx.fillStyle = `rgba(39,39,39,${s.trackOpacity / 255})`;
            ctx.fillRect(0, 0, W, H);
            ctx.strokeStyle = 'rgb(52,52,52)';
            ctx.lineWidth = 1;
            ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

            // waveform (Waveform.Render: a line strip through the left/right samples of each 2ms step)
            const wave = this.music.waveform;
            if (s.waveform && wave)
                this.renderWaveform(wave, msX, minMs, maxMs, H);

            this.hoveringObject = null;
            this.hoveringDuration = null;
            this.hoveringTextIndex = -1;
            const mx = this.mouse.x, my = this.mouse.y;
            const labels = [];
            let lastRenderedText = -Infinity;

            let toPlay = null;
            let polyphony = 0;

            // selection box
            if (this.selecting) {
                const xs = msX(this.selectMsStart), xe = msX(this.selectMsEnd);
                ctx.fillStyle = this.color(5, 0.04);
                ctx.fillRect(Math.min(xs, xe), 0, Math.abs(xe - xs), H);
            }

            const dragging = this.draggingObjects.length > 0 && !(this.draggingObjects[0] instanceof TimingPoint);

            if (this.renderNotes) {
                const notes = map.notes;
                const [low, high] = notes.searchRange(minMs, maxMs);
                const colorCount = s.noteColors.length;

                for (let i = low; i < high; i++) {
                    const x = msX(notes.items[i].ms);
                    if (!dragging && mx > x && mx < x + noteSize && my > cellGap && my < cellGap + noteSize) {
                        this.hoveringObject ??= notes.items[i];
                    }
                }

                // (web only, for speed: each note's box and mini grid is one picture, drawn once per colour; the
                // location markers and the text lines are gathered up and drawn a colour at a time, so thousands of
                // notes on screen are a few thousand image draws rather than tens of thousands of shapes)
                const markers = new Map(), stems = new Map();
                const markerSize = noteSize * 0.2;
                let lastBox = -Infinity;
                // (one CSS pixel wide, on whole device pixels, as line() draws it)
                const stemPx = Math.max(1, Math.round(G.pixelRatio)), stemDevice = stemPx / G.pixelRatio;
                const stemX = v => (Math.floor(v * G.pixelRatio) + (stemPx % 2 ? 0.5 : 0)) / G.pixelRatio;
                for (let i = low; i < high; i++) {
                    const note = notes.items[i];
                    let isHovering = this.hoveringObject === note;
                    const x = msX(note.ms);
                    const a = note.ms < currentTime - 1 ? 0.35 : 1;
                    const c = note.byColor || i % colorCount;

                    // location marker, note box and mini grid
                    // (a box under a pixel from the last one drawn would only cover it again: skipped, its marker kept)
                    const box = x - lastBox >= 1 || isHovering || note.selected ? this.trackBox(c, a, noteSize, cellPos) : null;
                    if (box) {
                        ctx.drawImage(box.canvas, x, cellGap, box.w, box.w);
                        lastBox = x;
                    }
                    const mk = this.noteColor(c, a);
                    let path = markers.get(mk);
                    if (!path)
                        markers.set(mk, path = new Path2D());
                    // (one exactly on top of the last of its colour, to the device pixel, isn't drawn twice)
                    const mx0 = x + cellPos(2 - note.x), my0 = cellGap + cellPos(2 - note.y);
                    const mKey = Math.round(mx0 * G.pixelRatio) * 100003 + Math.round(my0 * G.pixelRatio);
                    if (path.last !== mKey) {
                        path.rect(mx0, my0, markerSize, markerSize);
                        path.last = mKey;
                    }

                    // text line
                    const lc = this.color(4, !this.hoveringObject || isHovering ? a : 0.35);
                    let stem = stems.get(lc);
                    if (!stem)
                        stems.set(lc, stem = new Path2D());
                    const sx = stemX(x + 0.5);
                    if (stem.last !== sx) {
                        stem.moveTo(sx, H + 2);
                        stem.lineTo(sx, H * 1.4);
                        stem.last = sx;
                    }

                    if (isHovering)
                        this.strokeBox(x - 4, cellGap - 4, noteSize + 8, noteSize + 8, this.color(5));
                    else if (note.selected) {
                        if (dragging)
                            this.line(msX(note.dragStartMs), 0, msX(note.dragStartMs), H, this.color(7));
                        else
                            this.strokeBox(x - 4, cellGap - 4, noteSize + 8, noteSize + 8, this.color(6));
                    }
                    if (note.peerSel)
                        this.strokeBox(x - 7, cellGap - 7, noteSize + 14, noteSize + 14, PEER_A(note.peerSel));
                    if (note.peerAt && performance.now() - note.peerAt < PEER_FLASH) {
                        const f = (performance.now() - note.peerAt) / PEER_FLASH;
                        this.strokeBox(x - 4 - 8 * f, cellGap - 4 - 8 * f, noteSize + 8 + 16 * f, noteSize + 8 + 16 * f, PEER_A(note.peerColor, 1 - f));
                    }

                    if (note.ms <= currentTime - sfxOffset) {
                        toPlay = note;
                        if (note.ms > (this.lastPlayedObject?.ms ?? -1))
                            polyphony++;
                    }

                    isHovering ||= dragging && note.selected;

                    if (x - 8 > lastRenderedText || isHovering) {
                        labels.push({ x: x + 3, a: `Note ${fmtInt(i + 1)}`, b: `${fmtInt(note.ms)}ms`, hover: isHovering });
                        lastRenderedText = x;
                    }
                }
                for (const [color, path] of markers) {
                    ctx.fillStyle = color;
                    ctx.fill(path);
                }
                ctx.lineWidth = stemDevice;
                for (const [color, path] of stems) {
                    ctx.strokeStyle = color;
                    ctx.stroke(path);
                }
            } else {
                const list = map.renderMode === RenderMode.VFX ? map.vfxObjects : map.specialObjects;
                const shouldCheckId = map.renderMode === RenderMode.Special && map.objectMode !== ObjectMode.Disabled;
                const indices = [];
                const colorCount = s.noteColors.length;

                for (const obj of list.items) {
                    if (obj.duration + obj.ms < minMs)
                        continue;
                    if (obj.ms > maxMs)
                        break;
                    if (shouldCheckId && obj.id !== map.objectMode)
                        continue;
                    const x = msX(obj.ms);
                    if (mx > x && mx < x + noteSize && my > cellGap && my < cellGap + noteSize)
                        this.hoveringObject ??= obj;
                }

                for (let i = 0; i < list.items.length; i++) {
                    const obj = list.items[i];
                    while (indices.length <= obj.id)
                        indices.push(0);
                    indices[obj.id]++;

                    if (obj.duration + obj.ms < minMs)
                        continue;
                    if (obj.ms > maxMs)
                        break;
                    if (shouldCheckId && obj.id !== map.objectMode)
                        continue;

                    let isHovering = this.hoveringObject === obj || this.hoveringDuration === obj;
                    const x = msX(obj.ms);
                    const a = obj.ms < currentTime - 1 ? 0.35 : 1;
                    const c = (shouldCheckId ? indices[obj.id] - 1 : i) % colorCount;
                    const cx = x + noteSize / 2, cy = cellGap + noteSize / 2;

                    if (obj.hasDuration) {
                        const width = obj.duration * msToPx;
                        this.line(x + noteSize, cy, x + noteSize + Math.max(width - noteSize, 0), cy, this.noteColor(c, a), 4);
                        this.diamond(x + width, cy, noteSize / 4, this.noteColor(c, a), null);

                        if (Math.abs(mx - x - width) < noteSize / 4 && Math.abs(my - cy) < noteSize / 4)
                            this.hoveringDuration ??= obj;
                        if (this.hoveringDuration === obj)
                            this.diamond(x + width, cy, noteSize / 4 + 4, null, this.color(5), 1);
                        else if (this.draggingDuration === obj)
                            this.diamond(x + width, cy, noteSize / 4 + 4, null, this.color(6), 1);
                    }

                    const sprite = this.tintedSprite(obj.id, this.noteColor(c));
                    ctx.beginPath();
                    ctx.arc(cx, cy, noteSize / 2, 0, Math.PI * 2);
                    ctx.fillStyle = this.noteColor(c, a / 20);
                    ctx.fill();
                    ctx.strokeStyle = this.noteColor(c, a);
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    if (sprite) {
                        ctx.globalAlpha = a;
                        ctx.drawImage(sprite, x + noteSize / 16, cellGap + noteSize / 16, noteSize * 7 / 8, noteSize * 7 / 8);
                        ctx.globalAlpha = 1;
                    }

                    this.line(x + 0.5, H + 2, x + 0.5, H * 1.4, this.color(4, !this.hoveringObject || isHovering ? a : 0.35));

                    if (isHovering) {
                        ctx.beginPath();
                        ctx.arc(cx, cy, noteSize / 2 + 4, 0, Math.PI * 2);
                        ctx.strokeStyle = this.color(5);
                        ctx.lineWidth = 1;
                        ctx.stroke();
                    } else if (obj.selected) {
                        if (dragging)
                            this.line(msX(obj.dragStartMs), 0, msX(obj.dragStartMs), H, this.color(7));
                        else {
                            ctx.beginPath();
                            ctx.arc(cx, cy, noteSize / 2 + 4, 0, Math.PI * 2);
                            ctx.strokeStyle = this.color(6);
                            ctx.lineWidth = 1;
                            ctx.stroke();
                        }
                    }

                    if (map.renderMode === RenderMode.Special && obj.ms <= currentTime - sfxOffset && obj.playHitsound) {
                        toPlay = obj;
                        if (obj.ms > (this.lastPlayedObject?.ms ?? -1))
                            polyphony++;
                    }

                    isHovering ||= dragging && obj.selected;

                    if (x - 8 > lastRenderedText || isHovering) {
                        labels.push({ x: x + 3, a: `${obj.name ?? 'null'} ${fmtInt(indices[obj.id])}`, b: `${fmtInt(obj.ms)}ms`, hover: isHovering });
                        lastRenderedText = x;
                    }
                }
            }

            // timing points and beat ticks
            const beatDiv = map.beatDivisor + 1;
            const multiplier = beatDiv % 1 === 0 ? 1 : 1 / (beatDiv % 1);
            const divisor = Math.round(beatDiv * multiplier);
            const multipleOfTwo = divisor % 2 === 0;
            const divisorReset = Math.trunc((divisor - 1) / 2) * 2;
            const beatTickGap = H - noteSize - cellGap;
            const points = map.timingPoints;
            const bpmLabels = [];

            for (let i = 0; i < points.length; i++) {
                const point = points[i];
                if (point.bpm <= 0)
                    continue;

                const startX = msX(point.ms);
                const msInc = 60000 / point.bpm * multiplier;
                const halfInc = msInc / 2;
                const subInc = msInc / divisor;

                if (mx > startX && mx < startX + H && my > H && my < H * 2)
                    this.hoveringObject ??= point;

                if (point.ms <= totalTime) {
                    const nextMs = i + 1 < points.length ? Math.min(points[i + 1].ms, totalTime) : totalTime;
                    const totalMs = nextMs - point.ms;
                    const visStart = Math.max(0, minMs - point.ms), visEnd = Math.min(totalMs, maxMs - point.ms);

                    if (visEnd > visStart - msInc) {
                        const numBeats = Math.trunc(totalMs / msInc);
                        const numHalf = multipleOfTwo ? Math.trunc(totalMs / halfInc - numBeats) : 0;
                        const numSub = Math.trunc(totalMs / subInc - numBeats - numHalf);

                        const j0 = Math.max(0, Math.floor(visStart / msInc) - 1);
                        const j1 = Math.min(numBeats, Math.ceil(visEnd / msInc) + 1);

                        for (let j = j0; j < j1; j++) {
                            const x = startX + msInc * (j + 1) * msToPx;
                            this.line(x, H, x, H - beatTickGap, this.color(1));
                        }
                        for (let j = j0; j < Math.min(numHalf, j1); j++) {
                            const x = startX + (msInc * j + halfInc) * msToPx;
                            this.line(x, H - 3 * beatTickGap / 5, x, H, this.color(2));
                        }

                        // sub-beat ticks (same stepping as the original instancing loop)
                        if (numSub > 0 && divisorReset > 0) {
                            let currentIncrement = subInc;
                            for (let j = 0; j < numSub; j++) {
                                const curTick = j % divisorReset;
                                if (curTick === 0 && j > 0)
                                    currentIncrement += subInc;
                                else if (curTick + 1 === divisor / 2 && multipleOfTwo)
                                    currentIncrement += subInc;
                                const x = startX + (subInc * j + currentIncrement) * msToPx;
                                if (x > W)
                                    break;
                                if (x >= 0)
                                    this.line(x, H - 3 * beatTickGap / 10, x, H, this.color(0));
                            }
                        }
                    }
                }

                this.line(startX, 0, startX, H * 1.95, this.color(8));
                if (this.hoveringObject === point)
                    this.strokeBox(startX - 4, H, H, H, this.color(5));
                else if (map.selectedPoint === point)
                    this.strokeBox(startX - 4, H, H, H, this.color(6));

                bpmLabels.push({ x: startX + 3, a: `${+point.bpm.toFixed(3)} BPM`, b: `${fmtInt(point.ms)}ms` });
            }

            // static lines: song start, song end, cursor
            this.line(msX(0), 0, msX(0), H, this.color(1));
            this.line(endPos, 0, endPos, H, this.color(8));
            this.line(cursorPos, 0, cursorPos, H, this.color(4, 0.75));
            // (where whoever you're mapping with is in the song)
            for (const p of this.peers || []) {
                const px = msX(p.time);
                if (px >= 0 && px <= W) {
                    this.line(px, 0, px, H, PEER_A(p.color));
                    this.text(p.name, px + 4, 2, 16, PEER_A(p.color));
                }
            }
            if (this.selecting) {
                this.line(msX(this.selectMsStart), 0, msX(this.selectMsStart), H, this.color(5));
                this.line(msX(this.selectMsEnd), 0, msX(this.selectMsEnd), H, this.color(5));
            }

            // labels are drawn in the text pass (GuiTrack.PostRender)
            this.trackLabels = { labels, bpmLabels, H };

            // hit sounds and metronome
            if (toPlay !== this.lastPlayedObject) {
                const dist = Math.abs((toPlay?.ms ?? 0) - currentTime);
                if (toPlay && this.music.isPlaying && document.hasFocus() && dist < 200)
                    for (let i = 0; i < Math.min(s.maxPolyphony, polyphony); i++)
                        SSQE.Audio.SoundPlayer.play('hit');
                this.lastPlayedObject = toPlay;
            }

            if (s.metronome && document.hasFocus()) {
                const ms = currentTime - sfxOffset;
                const beat = this.closestBeat(ms, null, !s.scaleMetronome);
                if (beat !== this.lastPlayedTick && beat <= ms && beat > 0 && this.music.isPlaying) {
                    this.lastPlayedTick = beat;
                    SSQE.Audio.SoundPlayer.play('metronome');
                }
            }
        }

        // Waveform.Render: a line strip through the left/right samples of each 2ms step. Drawn once into strips 256
        // pixels wide (at the screen's pixel density) and kept, so a frame only copies the few strips on screen: tens of
        // thousands of tiny lines every frame made the timeline the slowest thing on the screen (100ms a frame on a
        // busy song at 2x, while playing). The strips are made again when the zoom, the colour, the style, the size or
        // the song changes.
        renderWaveform(wave, msX, minMs, maxMs, H) {
            const ctx = this.ctx;
            const offset = this.music.musicOffset - 15;
            const stepMs = wave.resolution * 1000;
            const msToPx = this.msToPx;
            if (!(msToPx > 0) || !(stepMs > 0))
                return;
            const ratio = G.pixelRatio || 1;
            const color = this.color(3), classic = !!this.settings.classicWaveform;
            const TILE = 256;
            const key = `${msToPx}|${H}|${ratio}|${color}|${classic}|${offset}`;
            let cache = this.waveCache;
            if (!cache || cache.wave !== wave || cache.key !== key) {
                cache = this.waveCache = { wave, key, tiles: new Map() };
            }
            // tile k covers the song from k * TILE pixels to (k + 1) * TILE pixels at this zoom
            const tileMs = TILE / msToPx;
            const k0 = Math.floor(minMs / tileMs), k1 = Math.floor(maxMs / tileMs);
            for (let k = k0; k <= k1; k++) {
                let tile = cache.tiles.get(k);
                if (!tile) {
                    tile = this.waveTile(wave, k * tileMs, tileMs, TILE, H, ratio, offset, stepMs, color, classic);
                    cache.tiles.set(k, tile);
                    // (the latest 64 kept: about 16 screens' worth)
                    if (cache.tiles.size > 64)
                        cache.tiles.delete(cache.tiles.keys().next().value);
                }
                if (tile) {
                    // (on whole device pixels, so the strips meet without a seam)
                    const x = Math.round(msX(k * tileMs) * ratio) / ratio;
                    ctx.drawImage(tile, x, 0, TILE, H);
                }
            }
        }

        // one strip of the waveform (see renderWaveform): null where the song has no samples
        waveTile(wave, fromMs, spanMs, W, H, ratio, offset, stepMs, color, classic) {
            const first = Math.max(0, Math.floor((fromMs - offset) / stepMs) - 1);
            const last = Math.min(wave.count, Math.ceil((fromMs + spanMs - offset) / stepMs) + 2);
            if (last <= first)
                return null;
            const c = document.createElement('canvas');
            c.width = Math.ceil(W * ratio);
            c.height = Math.ceil(H * ratio);
            const g = c.getContext('2d');
            g.scale(ratio, ratio);
            const px = W / spanMs;
            const xOf = i => (i * stepMs + offset - fromMs) * px;
            g.beginPath();
            if (classic) {
                for (let i = first; i < last; i++) {
                    const y = (2 - Math.max(Math.abs(wave.left[i]), Math.abs(wave.right[i])) * 2) * H / 2;
                    i === first ? g.moveTo(xOf(i), y) : g.lineTo(xOf(i), y);
                }
            } else {
                for (let i = first; i < last; i++) {
                    const x = xOf(i);
                    if (i === first)
                        g.moveTo(x, (wave.left[i] + 1) * H / 2);
                    else
                        g.lineTo(x, (wave.left[i] + 1) * H / 2);
                    g.lineTo(x, (wave.right[i] + 1) * H / 2);
                }
            }
            g.strokeStyle = color;
            g.lineWidth = 0.75;
            g.stroke();
            return c;
        }

        // GuiTrack.PostRender
        renderTrackText() {
            const data = this.trackLabels;
            if (!data)
                return;
            const { labels, bpmLabels, H } = data;
            const size = H / 4;
            const anyHover = labels.some(l => l.hover);
            for (const l of labels) {
                const alpha = anyHover && !l.hover ? 0.2 : 1;
                this.text(l.a, l.x, H, size, this.color(0, alpha));
                this.text(l.b, l.x, H * 1.2, size, this.color(1, alpha));
            }
            for (const l of bpmLabels) {
                this.text(l.a, l.x, H + H / 2, size, this.color(0));
                this.text(l.b, l.x, H * 1.2 + H / 2, size, this.color(1));
            }
        }

        strokeBox(x, y, w, h, color) {
            const ctx = this.ctx;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }

        // GuiWindowEditor.Render lyric preview
        lyricPreview() {
            const t = this.currentTime;
            const lyrics = this.map.specialObjects.items.filter(o => o instanceof Lyric);
            let prev = null, current = null;
            let text = '', alpha = 1, fadingIn = false;

            for (let i = 0; i < lyrics.length; i++) {
                prev = current;
                current = lyrics[i];
                if (current.ms > t)
                    break;

                if (current.fadeOut) {
                    alpha = 1 - clamp((t - current.ms) / 1000, 0, 1);
                    fadingIn = false;
                } else if (current.fadeIn) {
                    alpha = clamp((t - current.ms) / 1000, 0, 1);
                    fadingIn = true;
                } else if (!fadingIn)
                    alpha = 1;

                if (current.text.trim()) {
                    if (prev && !prev.text.trim()) {
                        text = current.text;
                        if (text.startsWith('-'))
                            text = text.slice(1);
                    } else if (current.text.startsWith('-'))
                        text = current.text.slice(1);
                    else if (text.endsWith('-'))
                        text = text.slice(0, -1) + current.text;
                    else if (text.trim())
                        text += ' ' + current.text;
                    else
                        text = current.text;
                } else if (!current.fadeOut)
                    text = current.text;
            }

            if (text.endsWith('-'))
                text = text.slice(0, -1);
            return [text, alpha];
        }
    }

    // GuiGrid / GuiTrack as controls in the editor window: they draw through the editor
    class GridControl extends G.Control {
        draw() {
            this.editor.renderGrid();
        }
    }

    class TrackControl extends G.Control {
        draw() {
            this.editor.renderTrack();
        }

        drawText() {
            this.editor.renderTrackText();
        }
    }

    // GuiSliderTimeline
    class TimelineSlider extends G.Slider {
        init() {
            super.init();
            this.canReset = false;
            this.playRightClickSound = false;
            this.hoveringBookmark = null;
            this.wasPlaying = false;
            this.get = () => this.editor.currentTime;
            this.set = v => this.editor.currentTime = v;
            this.max = () => this.editor.totalTime || 1;
        }

        get step() {
            return (this.editor.totalTime || 1) / 2000;
        }

        set step(v) { }

        lineRectT() {
            const r = this.rect;
            return { x: r.x + r.h / 2, y: r.y + r.h / 2 - 1.5, w: r.w - r.h, h: 3 };
        }

        draw(ctx) {
            const e = this.editor;
            const map = e.map;
            const line = this.lineRectT();
            const max = e.totalTime || 1;
            const y = line.y + line.h / 2;

            G.fillSquircle(ctx, line, this.cornerRadius, e.settings.color2);
            ctx.fillStyle = e.color(2);
            ctx.fillRect(line.x + e.trackStartRel * line.w, line.y, (e.trackEndRel - e.trackStartRel) * line.w, line.h);

            // progress marker + hover (GuiSlider.Draw)
            const [cx, cy] = [line.x + line.w * (e.currentTime / max), y];
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = e.color(0);
            ctx.fill();
            const hover = this.anims.hover.value;
            if (hover > 0) {
                ctx.beginPath();
                const radius = 12 * hover, rot = (90 * hover) * Math.PI / 180;
                for (let k = 0; k < 6; k++) {
                    const a = rot + k * Math.PI / 3;
                    k ? ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius) : ctx.moveTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
                }
                ctx.closePath();
                ctx.strokeStyle = e.color(0);
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // bookmarks
            for (const b of map.bookmarks) {
                const x = line.x + b.ms / max * line.w;
                const endX = line.x + b.endMs / max * line.w;
                ctx.fillStyle = this.hoveringBookmark === b ? e.color(1, 0.75) : e.color(2, 0.75);
                ctx.fillRect(x - 4, y - 40, 8 + (endX - x), 8);
            }

            // note / point / object ticks
            const widthDiff = (this.window ? this.window.width : 1920) / 1920;
            const ticks = (items, y1, y2, width) => {
                let prevX = -1;
                ctx.fillStyle = '#fff';
                for (const o of items) {
                    const x = line.x + o.ms * (line.w / max);
                    if (x - 1 >= prevX) {
                        ctx.fillRect(x - width / 2, Math.min(y1, y2), width, Math.abs(y2 - y1));
                        prevX = x;
                    }
                }
            };
            ticks(map.notes.items, y + 5, y + 3, 1 * widthDiff);
            ticks(map.timingPoints, y - 10, y - 6, 2 * widthDiff);
            ticks(map.vfxObjects.items, y + 9, y + 7, 2 * widthDiff);
            ticks(map.specialObjects.items, y + 9, y + 7, 2 * widthDiff);
            // (whoever you're mapping with)
            for (const p of e.peers || []) {
                const px = line.x + line.w * Math.min(1, Math.max(0, p.time / max));
                ctx.fillStyle = PEER_A(p.color);
                ctx.beginPath();
                ctx.moveTo(px, y - 4);
                ctx.lineTo(px - 6, y - 14);
                ctx.lineTo(px + 6, y - 14);
                ctx.closePath();
                ctx.fill();
            }
        }

        drawText(ctx) {
            if (!this.hoveringBookmark)
                return;
            const line = this.lineRectT();
            const max = this.editor.totalTime || 1;
            const x = line.x + this.hoveringBookmark.ms / max * line.w;
            const y = line.y + line.h / 2;
            G.Text.draw(ctx, this.hoveringBookmark.text, x, y - 40 - G.Text.height(16), 16, 'main', this.editor.settings.color2);
        }

        mouseMove(x, y) {
            super.mouseMove(x, y);
            const line = this.lineRectT();
            const yPos = line.y + line.h / 2;
            const max = this.editor.totalTime || 1;
            this.hoveringBookmark = null;
            for (const b of this.editor.map.bookmarks) {
                const xPos = line.x + b.ms / max * line.w;
                const endX = line.x + b.endMs / max * line.w;
                if (inRect({ x: xPos - 4, y: yPos - 40, w: 8 + (endX - xPos), h: 8 }, x, y))
                    this.hoveringBookmark = b;
            }
        }

        mouseDownLeft(x, y, window) {
            const e = this.editor;
            if (!this.hoveringBookmark) {
                this.wasPlaying = e.music.isPlaying;
                if (e.music.isPlaying)
                    e.pauseMusic();
            }
            super.mouseDownLeft(x, y, window);
        }

        mouseDownLeftGlobal(x, y, window) {
            const e = this.editor;
            if (this.hoveringBookmark) {
                if (e.music.isPlaying)
                    e.pauseMusic();
                e.currentTime = e.keys.shift ? this.hoveringBookmark.endMs : this.hoveringBookmark.ms;
            }
            super.mouseDownLeftGlobal(x, y, window);
        }

        mouseUpLeft(x, y) {
            if (this.dragging && this.wasPlaying && !this.editor.settings.pauseScroll)
                this.editor.playMusic();
            super.mouseUpLeft(x, y);
        }

        mouseDownRightGlobal(x, y, window) {
            const e = this.editor;
            if (this.hoveringBookmark) {
                if (e.music.isPlaying)
                    e.pauseMusic();
                e.currentTime = e.keys.shift ? this.hoveringBookmark.ms : this.hoveringBookmark.endMs;
            }
            super.mouseDownRightGlobal(x, y, window);
        }
    }

    // the hover area of the timeline covers the bookmarks above the line as well
    TimelineSlider.prototype.contains = function (x, y) {
        return G.Control.prototype.contains.call(this, x, y) || !!this.hoveringBookmark;
    };

    SSQE.GridControl = GridControl;
    SSQE.TrackControl = TrackControl;
    SSQE.TimelineSlider = TimelineSlider;
    SSQE.Editor = Editor;
})();
