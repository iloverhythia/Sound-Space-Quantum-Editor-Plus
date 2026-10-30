'use strict';

// Port of NewGUI/Windows/GuiWindowEditor.Controls.cs and the event wiring in GuiWindowEditor.cs.
// Positions, sizes and text sizes are copied from the original (1920x1080 reference layout).
(function () {
    const G = SSQE.GUI;
    const { RenderMode, ObjectMode, Lyric, clamp, EASING_STYLES } = SSQE;
    const None = G.CenterMode.None;

    const CAMERA_MODES = ['half lock', 'full lock', 'spin'];
    const EXPORT_TYPES = ['Nightly (SSPM)', 'Rhythia (RHM)', 'Rewrite (PHXM)', 'Novastra (NPK)'];
    const GAMES = ['Rhythia', 'Novastra'];

    function build(editor) {
        const app = editor.app;
        const s = editor.settings;
        const map = editor.map;
        const ps = SSQESettings.load();
        const savePs = () => SSQESettings.save(ps);
        const saveS = () => editor.settingsChanged();

        const button = (x, y, w, h, text, textSize, onClick, props = {}) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick, ...props });
        const checkbox = (x, y, text, textSize, key, props = {}) => new G.Checkbox(x, y, 30, 30, {
            text, textSize, get: () => s[key], set: v => { s[key] = v; saveS(); }, ...props,
        });
        const pCheckbox = (x, y, text, textSize, key) => new G.Checkbox(x, y, 30, 30, {
            text, textSize, get: () => ps[key], set: v => { ps[key] = v; savePs(); },
        });
        const label = (x, y, w, h, text, textSize, props = {}) => new G.Label(x, y, w, h, { text, textSize, colorSetting: 'color1', ...props });
        const numeric = (x, y, w, h, textSize, get, set, props = {}) => new G.NumericTextbox(x, y, w, h, { textSize, get, set, ...props });
        const slider = (x, y, w, h, get, set, max, step, def, props = {}) => new G.Slider(x, y, w, h, { style: G.Styles.None, get, set, max, step, def, ...props });

        // ------------------------------------------------ nav buttons
        const LNavOptions = button(10, 172, 175, 50, 'OPTIONS', 31);
        const LNavTiming = button(195, 172, 175, 50, 'TIMING', 31);
        const LNavPatterns = button(380, 172, 175, 50, 'PATTERNS', 31);
        const LNavPlayer = button(10, 946, 545, 50, 'PLAYTEST', 31);
        const RNavSnapping = button(1365, 172, 175, 50, 'SNAPPING', 31);
        const RNavGraphics = button(1550, 172, 175, 50, 'GRAPHICS', 31);
        const RNavExport = button(1735, 172, 175, 50, 'EXPORT', 31);

        // ------------------------------------------------ Options
        const OptionsNav = new G.Container(10, 222, 545, 756, [
            checkbox(0, 10, 'Use Numpad', 26, 'numpad'),
            checkbox(0, 50, 'Separate Click Tools', 26, 'separateClickTools'),
            button(0, 90, 200, 40, 'Swap Click mode', 26, () => editor.runKeybind('switchClickTool')),
            checkbox(0, 140, 'Jump on Paste', 26, 'jumpPaste'),
            checkbox(0, 180, 'Pause on Seek', 26, 'pauseScroll'),
            checkbox(0, 220, 'Use Old Quantum Divisor', 26, 'oldQuantumSnap'),
            // (web only: clicking or dragging on the grid always places notes, also where a note is already showing,
            // instead of picking that note up; Ctrl or Shift still selects)
            checkbox(0, 260, 'Place Notes Over Other Notes', 26, 'placeOverNotes'),
            button(0, 310, 200, 40, 'Edit Extra Objects', 26, () => setSpecial(true)),
        ]);

        // ------------------------------------------------ Timing
        // APPLY DIVISOR (web only): the divisor the selected notes are on is the one set when they were selected, or
        // else the one they all sit on; they're moved onto the one set now (see Editor.applyDivisor)
        let selSeen = null, divisorAtSelect = 0;
        const divisorNow = () => Math.round((map.beatDivisor + 1) * 10) / 10;
        const divisorFrom = () => {
            const sel = map.activeList.selected;
            if (sel !== selSeen) {
                selSeen = sel;
                divisorAtSelect = divisorNow();
            }
            if (sel.length < 2)
                return 0;
            const clock = editor.beatClock();
            if (!clock)
                return 0;
            const at = divisorAtSelect;
            const onIt = sel.every(n => {
                const p = clock.pts[clock.segAtMs(n.ms)];
                const tick = 60000 / p.bpm / at, local = (n.ms - p.ms) / tick;
                return Math.abs(local - Math.round(local)) * tick <= 2.5;
            });
            return onIt ? at : editor.divisorOf(sel, clock) || at;
        };
        const ApplyDivisorLabel = label(220, 445, 300, 30, '', 26, { centerMode: None });
        const TimingNav = new G.Container(10, 222, 545, 756, [
            numeric(0, 50, 130, 40, 31, () => map.props.exportOffset, v => {
                SSQE.Formats.setExportOffset(map, Math.trunc(v));
                editor.onMapChanged();
            }),
            numeric(170, 50, 130, 40, 31, () => s.sfxOffset, v => { s.sfxOffset = v; saveS(); }),
            numeric(340, 50, 130, 40, 31, () => s.musicOffset, v => { s.musicOffset = v; saveS(); }),
            button(0, 110, 210, 40, 'OPEN BPM SETUP', 27, () => app.dialogs.timings(editor)),
            // (the song's BPM, found from its beat, as the map's timing point)
            button(220, 110, 210, 40, 'DETECT BPM', 27, () => app.detectBpmToMap(editor)),
            button(0, 160, 210, 40, 'IMPORT INI', 27, () => app.importIni(map)),
            checkbox(0, 210, 'Metronome', 26, 'metronome'),
            checkbox(0, 250, 'Scale Metronome With Divisor', 26, 'scaleMetronome'),
            button(0, 290, 210, 40, 'EDIT BOOKMARKS', 27, () => app.dialogs.bookmarks(editor)),
            button(0, 340, 210, 40, 'COPY BOOKMARKS', 27, () => {
                const text = map.copyBookmarksText();
                if (text)
                    app.writeClipboard(text).then(() => editor.toast('COPIED TO CLIPBOARD', 'other'));
            }),
            button(0, 390, 210, 40, 'PASTE BOOKMARKS', 27, async () => {
                const text = await app.readClipboard('Paste bookmarks ("ms ~ text" per line)');
                if (text)
                    map.pasteBookmarksText(text);
            }),
            button(0, 440, 210, 40, 'APPLY DIVISOR', 27, () => {
                const from = divisorFrom(), to = divisorNow();
                if (editor.applyDivisor(from || to, to))
                    divisorAtSelect = to;
            }),
            ApplyDivisorLabel,
            label(0, 20, 100, 30, 'Export Offset:', 30, { centerMode: None }),
            label(170, 20, 100, 30, 'SFX Offset:', 30, { centerMode: None }),
            label(340, 20, 100, 30, 'Music Offset:', 30, { centerMode: None }),
        ]);

        // ------------------------------------------------ Patterns
        const numberBox = (x, y, w, h, props) => new G.NumberBox(x, y, w, h, props);

        // fills from the timeline's position up to the next note (or the end of the song)
        let autoMapping = false;
        // (web only: the notes it has placed so far, shown on the map while it works, not undoable until it's done)
        let preview = [], previewAt = 0;
        const setPreview = notes => {
            if (preview.length)
                map.notes.removeAll(preview);
            preview = notes;
            map.autoMapPreview = notes.length > 0;
            if (notes.length) {
                map.notes.items.push(...notes);
                map.notes.sort();
            } else
                map.changed();
            editor.keepAwake(400);
        };
        const autoMap = async () => {
            if (!window.SSQEAutoMapper)
                return;
            if (autoMapping) {
                editor.toast('STILL AUTO MAPPING - ONE MOMENT', 'other');
                return;
            }
            const buffer = editor.music.buffer;
            if (!buffer) {
                app.dialogs.message('The song is still loading (or couldn\'t be decoded), so it can\'t be auto mapped yet.');
                return;
            }
            const start = Math.max(0, Math.round(editor.currentTime));
            const notes = map.notes.items;
            const next = notes.find(n => n.ms > start);
            const end = next ? next.ms : Math.trunc(editor.totalTime);
            const before = notes.filter(n => n.ms <= start).slice(-2).map(n => ({ x: n.x, y: n.y, ms: n.ms }));
            autoMapping = true;
            editor.toast('AUTO MAPPING...', 'other', Infinity);
            try {
                const timing = map.timingPoints.filter(p => p.bpm > 0).map(p => ({ bpm: p.bpm, ms: p.ms })).sort((p, q) => p.ms - q.ms);
                const made = await SSQEAutoMapper.generate({
                    // (shown until the next step's, or the result's)
                    progress: text => editor.toast(text, 'other', Infinity),
                    // (the notes going down as it places them)
                    preview: sofar => {
                        const now = performance.now();
                        if (now - previewAt < 90)
                            return;
                        previewAt = now;
                        const fresh = sofar.filter(n => n.ms >= start && n.ms <= end && Number.isFinite(n.x) && Number.isFinite(n.y))
                            .map(n => Object.assign(new SSQE.Note(n.x, n.y, n.ms), { auto: true }));
                        // (each try starts again from the start: the last try's notes stay ahead of where this one has
                        // got to, so the notes are rewritten as it goes rather than vanishing)
                        const upTo = fresh.length ? fresh[fresh.length - 1].ms : -Infinity;
                        setPreview(fresh.concat(preview.filter(n => n.ms > upTo + 5)));
                    },
                    buffer, startMs: start, endMs: end, density: (s.autoMapDensity ?? 100) / 100, difficulty: s.autoMapDifficulty ?? 5,
                    stars: s.autoMapStars ?? 5,
                    timing,
                    quantum: Math.min(100, Math.max(0, s.autoMapQuantumPct ?? 0)) / 100,
                    before, avoid: [...before.map(n => n.ms), ...(next ? [next.ms] : [])],
                    styleNotes: s.autoMapUseMap === false ? [] : notes.map(n => ({ x: n.x, y: n.y, ms: n.ms })),
                    // (Similar to This Map: the notes already mapped, whose parts that sound like what's being mapped
                    // are taken over)
                    similarity: Math.min(100, Math.max(0, s.autoMapSimilarity ?? 0)) / 100,
                    similarNotes: notes.map(n => ({ x: n.x, y: n.y, ms: n.ms })),
                    count: s.autoMapCount || 0,
                    flow: (s.autoMapFlow ?? 70) / 100,
                    follow: (s.autoMapFollow ?? 75) / 100,
                    jumpScale: (s.autoMapJump ?? 100) / 100,
                    patterns: s.autoMapPatterns || 'mixed',
                    jumpShare: (s.autoMapJumpShare ?? 50) / 100,
                    dropBoost: (s.autoMapDrops ?? 100) / 100,
                    variety: (s.autoMapVariety ?? 50) / 100,
                    sources: (s.autoMapSources || 'kick,snare,hat').split(',').filter(Boolean),
                    sensitivity: (s.autoMapSensitivity ?? 50) / 100,
                    fill: s.autoMapFill || 'intense',
                    calm: (s.autoMapCalm ?? 30) / 100,
                });
                // no BPM yet and the song keeps a steady beat: the detected BPM becomes the map's timing point, so the
                // beat lines match what was mapped
                setPreview([]);
                const info = made.info || {};
                let bpmText = '';
                if (!timing.length && info.bpm) {
                    if (info.steady && s.autoMapSetBpm !== false) {
                        map.replacePoints('DETECTED BPM', [], [new SSQE.TimingPoint(info.bpm, Math.round(info.offsetMs))]);
                        bpmText = ` - SET BPM TO ${info.bpm}`;
                    } else
                        bpmText = ` - ABOUT ${info.bpm} BPM${info.steady ? '' : ' (NOT STEADY, NOT SET)'}`;
                }
                if (!made.length)
                    editor.toast(`NOTHING TO MAP HERE${bpmText}`, 'other', 5);
                else {
                    // (marked as the auto mapper's, so saving the map doesn't teach the auto mapper its own notes)
                    map.notes.addObjects('AUTO MAP', made.map(n => Object.assign(new SSQE.Note(n.x, n.y, n.ms), { auto: true })));
                    window.SSQEStats && SSQEStats.add('autoMaps');
                    const short = s.autoMapCount > 0 && made.length < s.autoMapCount ? ` (ONLY ${made.length} OF ${s.autoMapCount} FIT THE SONG)` : '';
                    // (a target the song can't reach at a playable speed: as hard as it goes, said so)
                    const aim = s.autoMapCount > 0 ? 0 : s.autoMapStars ?? 5;
                    const sr = info.stars > 0 ? ` - ${info.stars.toFixed(2)} STARS${aim && info.stars < aim - 0.05 ? ' (AS HARD AS THIS SONG GOES)' : ''}` : '';
                    editor.toast(`AUTO MAPPED ${made.length} NOTES${sr}${short}${bpmText}`, 'other', 5);
                }
            } catch (err) {
                const kept = preview;
                setPreview([]);
                if (err && err.stopped) {
                    // STOP: what it had placed stays, selected, so it can be deleted or kept
                    if (kept.length) {
                        map.notes.addObjects('AUTO MAP', kept);
                        map.notes.selected = kept;
                    }
                    editor.toast(kept.length ? `AUTO MAPPING STOPPED - KEPT ${kept.length} NOTES (SELECTED)` : 'AUTO MAPPING STOPPED', 'other', 5);
                } else {
                    editor.toast('AUTO MAPPING FAILED', 'error');
                    app.dialogs.message(`Auto mapping failed: ${err.message}`, 'Error');
                }
            } finally {
                autoMapping = false;
            }
        };
        editor.autoMap = autoMap;
        const AutoMapDifficultyLabel = label(370, 200, 175, 30, '', 30, { centerMode: None });
        AutoMapDifficultyLabel.process = function (dt) {
            G.Label.prototype.process.call(this, dt);
            this.text = `Stars: ${(s.autoMapStars ?? 5).toFixed(1)}`;
        };
        const AutoMapQuantumLabel = label(370, 560, 175, 30, '', 30, { centerMode: None });
        AutoMapQuantumLabel.process = function (dt) {
            G.Label.prototype.process.call(this, dt);
            this.text = `Quantum: ${Math.round(s.autoMapQuantumPct ?? 0)}%`;
        };
        const AutoMapSimilarLabel = label(0, 630, 175, 30, '', 30, { centerMode: None });
        AutoMapSimilarLabel.process = function (dt) {
            G.Label.prototype.process.call(this, dt);
            this.text = `Auto Map Like This Map: ${Math.round(s.autoMapSimilarity ?? 0)}%`;
        };
        const AutoMapStats = label(370, 280, 175, 90, '', 24, { centerMode: None });
        AutoMapStats.process = function (dt) {
            G.Label.prototype.process.call(this, dt);
            const st = window.SSQEAutoMapper && SSQEAutoMapper.statsSync();
            this.text = st ? `Learned from:\n${st.maps} map${st.maps === 1 ? '' : 's'}\n${st.notes} notes` : '';
        };
        const PatternsNav = new G.Container(10, 222, 545, 756, [
            button(0, 20, 175, 40, 'HORIZONTAL FLIP', 27, () => editor.hFlip()),
            button(185, 20, 175, 40, 'VERTICAL FLIP', 27, () => editor.vFlip()),
            numberBox(0, 110, 100, 40, { increment: 5, isFloat: true, textSize: 31, get: () => s.rotateBy, set: v => { s.rotateBy = v; saveS(); } }),
            button(110, 110, 100, 40, 'ROTATE', 27, () => editor.rotate(s.rotateBy)),
            numberBox(0, 190, 100, 40, { increment: 5, isFloat: true, textSize: 31, get: () => s.scaleBy, set: v => { s.scaleBy = v; saveS(); } }),
            button(110, 190, 100, 40, 'SCALE', 27, () => editor.scaleNotes(s.scaleBy)),
            checkbox(0, 250, 'Apply Rotate/Scale on Paste', 27, 'applyOnPaste'),
            checkbox(0, 290, 'Clamp Rotate/Scale in Bounds', 27, 'clampSR'),
            checkbox(0, 330, 'Paste Reversed', 27, 'pasteReversed'),
            checkbox(0, 370, 'Move Selected on Grid Key Pressed', 27, 'moveOnGridKey'),
            button(0, 430, 175, 40, 'STORE NODES', 27, () => editor.storeNodes()),
            button(185, 430, 175, 40, 'CLEAR NODES', 27, () => editor.clearNodes()),
            checkbox(0, 490, 'Curve Bezier', 27, 'curveBezier'),
            // (decimals too: 2.5 is two notes between nodes, then three, and so on)
            numberBox(0, 560, 100, 40, { increment: 1, isFloat: true, isPositive: true, textSize: 27, bounds: [0.1, Number.MAX_VALUE], get: () => s.bezierDivisor, set: v => { s.bezierDivisor = v; saveS(); } }),
            button(110, 560, 100, 40, 'DRAW', 27, () => editor.runBezier()),
            label(0, 80, 175, 30, 'Rotate by Degrees:', 30, { centerMode: None }),
            label(0, 160, 100, 30, 'Scale by Percent:', 30, { centerMode: None }),
            label(0, 530, 100, 30, 'Draw Bezier with Divisor:', 30, { centerMode: None }),

            // web only: auto mapper (automapper.js), learns from every imported map
            label(370, 20, 175, 30, 'Auto Mapper:', 30, { centerMode: None }),
            button(370, 50, 175, 40, 'AUTO MAP', 27, () => autoMap()),
            label(370, 110, 175, 30, 'Density %:', 30, { centerMode: None }),
            numberBox(370, 140, 120, 40, { increment: 10, isPositive: true, textSize: 27, bounds: [10, 400], get: () => s.autoMapDensity ?? 100, set: v => { s.autoMapDensity = v; saveS(); } }),
            AutoMapDifficultyLabel,
            // (the star rating the map is aimed at, 1 to 15 in tenths)
            slider(370, 230, 175, 32, () => ((s.autoMapStars ?? 5) - 1) * 10, v => { s.autoMapStars = Math.round(10 + v) / 10; saveS(); }, 140, 1, 40),
            AutoMapStats,
            button(370, 380, 175, 40, 'LEARN FROM MAPS', 27, async () => {
                const files = await app.pickFile('.sspm,.rhm,.txt,.osu', true);
                if (files && files.length)
                    // (each map's 'LEARNING...' up until the next, the result for 5 seconds)
                    SSQEAutoMapper.learnFiles(files, (text, error) => editor.toast(text, error ? 'error' : 'other', /\.\.\.$/.test(text) ? Infinity : 5));
            }),
            // (how much of the map is quantum: 0 none, 100 all of it, in between some parts, tamer the lower)
            AutoMapQuantumLabel,
            slider(370, 590, 175, 32, () => s.autoMapQuantumPct ?? 0, v => { s.autoMapQuantumPct = Math.round(v); saveS(); }, 100, 1, 0),
            button(370, 640, 175, 40, 'MORE OPTIONS', 27, () => app.dialogs.autoMapOptions(editor)),
            // (how much it takes over the parts of this map that sound like what it's mapping, see automapper.js)
            AutoMapSimilarLabel,
            slider(0, 665, 210, 32, () => s.autoMapSimilarity ?? 0, v => { s.autoMapSimilarity = Math.round(v); saveS(); }, 100, 1, 0),
            label(370, 480, 175, 30, 'Notes (0 = Auto):', 26, { centerMode: None }),
            numberBox(370, 510, 140, 40, { increment: 10, isPositive: true, textSize: 27, bounds: [0, 100000], get: () => s.autoMapCount ?? 0, set: v => { s.autoMapCount = Math.round(v); saveS(); } }),
            button(370, 430, 175, 40, 'RESET LEARNING', 27, () => {
                app.dialogs.confirm('Forget everything the auto mapper has learned?').then(r => r === 'yes' && SSQEAutoMapper.reset());
            }),
        ]);

        // ------------------------------------------------ Player (playtest)
        const playtest = (fromStart, e) => app.playtest(editor, fromStart, editor.keys.alt);
        const PlayerApproachRateLabel = label(0, 380, 400, 32, '', 30);
        const PlayerNav = new G.Container(10, 222, 545, 836, [
            new G.Dropdown(0, 50, 150, 40, { options: CAMERA_MODES, textSize: 27, get: () => ps.cameraMode, set: i => { ps.cameraMode = CAMERA_MODES[i]; savePs(); } }),
            numeric(175, 50, 100, 40, 31, () => ps.noteScale, v => { ps.noteScale = v; savePs(); }, { isFloat: true }),
            numeric(300, 50, 100, 40, 31, () => ps.cursorScale, v => { ps.cursorScale = v; savePs(); }, { isFloat: true }),
            pCheckbox(0, 110, 'Lock Cursor Within Grid', 27, 'lockCursor'),
            pCheckbox(0, 160, 'Grid Guides', 27, 'gridGuides'),
            numeric(0, 240, 115, 40, 31, () => ps.sensitivity, v => { ps.sensitivity = v; savePs(); }, { isFloat: true, isPositive: true }),
            numeric(135, 240, 115, 40, 31, () => ps.parallax, v => { ps.parallax = v; savePs(); }, { isFloat: true, isPositive: true }),
            numeric(270, 240, 115, 40, 31, () => ps.fov, v => { ps.fov = v; savePs(); }, { isFloat: true, isPositive: true }),
            numeric(0, 325, 150, 40, 31, () => ps.approachDistance, v => { ps.approachDistance = v; savePs(); }, { isFloat: true, isPositive: true }),
            numeric(235, 325, 150, 40, 31, () => ps.hitWindow, v => { ps.hitWindow = v; savePs(); }, { isPositive: true }),
            slider(0, 410, 400, 32, () => ps.playerApproachRate, v => { ps.playerApproachRate = Math.round(v); savePs(); }, 29, 1, 9),
            pCheckbox(0, 460, 'Approach Fade', 27, 'approachFade'),
            button(0, 520, 200, 40, 'PLAY FROM START', 27, e => playtest(true, e)),
            button(210, 520, 200, 40, 'PLAY HERE', 27, e => playtest(false, e)),
            label(0, 20, 100, 30, 'Camera Mode:', 30, { centerMode: None }),
            label(175, 20, 100, 30, 'Note Size:', 30, { centerMode: None }),
            label(300, 20, 100, 30, 'Cursor Size:', 30, { centerMode: None }),
            label(0, 210, 100, 30, 'Sensitivity:', 30, { centerMode: None }),
            label(135, 210, 100, 30, 'Parallax:', 30, { centerMode: None }),
            label(270, 210, 100, 30, 'FOV:', 30, { centerMode: None }),
            label(0, 295, 100, 30, 'Approach Distance:', 30, { centerMode: None }),
            label(235, 295, 100, 30, 'Hit Window:', 30, { centerMode: None }),
            PlayerApproachRateLabel,
        ]);

        const leftNavs = [[LNavOptions, OptionsNav], [LNavTiming, TimingNav], [LNavPatterns, PatternsNav], [LNavPlayer, PlayerNav]];
        const StandardNav = new G.Container(0, 0, 1920, 1080, [LNavOptions, LNavTiming, LNavPatterns, LNavPlayer, OptionsNav, TimingNav, PatternsNav, PlayerNav]);
        const leftIndex = s.lastLeftNav ? leftNavs.findIndex(([b]) => b.text === s.lastLeftNav) : 1;
        const leftRadio = new G.Radio(leftNavs.map(n => n[0]), leftIndex >= 0 ? leftIndex : null, active => {
            for (const [b, panel] of leftNavs)
                panel.visible = b === active;
            s.lastLeftNav = active ? active.text.replace(/^\[|\]$/g, '') : '';
            SSQE.Settings.save(s);
        });

        // ------------------------------------------------ Snapping
        const QuantumXOffset = slider(245, 310, 250, 32, () => s.quantumXOffset, v => { s.quantumXOffset = v; saveS(); }, 2, 0.05, 1);
        const QuantumYOffset = slider(245, 380, 250, 32, () => s.quantumYOffset, v => { s.quantumYOffset = v; saveS(); }, 2, 0.05, 1);
        const BeatDivisorLabel = label(245, 140, 250, 32, '', 30);
        const SnappingLabel = label(245, 210, 250, 32, '', 30);
        const QuantumXLabel = label(245, 280, 250, 32, '', 30);
        const QuantumYLabel = label(245, 350, 250, 32, '', 30);
        const SnappingNav = new G.Container(1365, 222, 545, 756, [
            checkbox(245, 10, 'Quantum', 27, 'enableQuantum'),
            checkbox(245, 50, 'Snap to Grid', 27, 'quantumGridSnap'),
            checkbox(245, 90, 'Auto-Advance', 27, 'autoAdvance'),
            slider(245, 170, 250, 32, () => map.beatDivisor, v => map.beatDivisor = v, 31, 0.5, 3, { shiftIncrement: 0.5 }),
            slider(245, 240, 250, 32, () => s.quantumSnapping, v => { s.quantumSnapping = Math.round(v); saveS(); }, 57, 1, 0),
            BeatDivisorLabel, SnappingLabel, QuantumXOffset, QuantumYOffset, QuantumXLabel, QuantumYLabel,
        ]);

        // ------------------------------------------------ Graphics
        const ApproachRateLabel = label(245, 260, 250, 32, '', 28);
        const Grid3DLabel = label(0, 100, 230, 32, '', 26);
        const GridZoomLabel = label(0, 180, 230, 32, '', 26);
        const NoteSizeLabel = label(0, 260, 230, 32, '', 26);
        const CursorPosLabel = label(245, 340, 250, 32, '', 28);
        const GraphicsNav = new G.Container(1365, 222, 545, 756, [
            checkbox(245, 10, 'Autoplay', 26, 'autoplay'),
            checkbox(245, 90, 'Approach Squares', 26, 'approachSquares'),
            checkbox(245, 130, 'Grid Numbers', 26, 'gridNumbers'),
            checkbox(245, 170, 'Grid Letters', 26, 'gridLetters'),
            checkbox(245, 210, 'Quantum Grid Lines', 26, 'quantumGridLines'),
            slider(245, 290, 250, 32, () => s.approachRate, v => { s.approachRate = Math.round(v); saveS(); }, 29, 1, 14),
            slider(245, 370, 250, 32, () => s.cursorPos, v => { s.cursorPos = Math.round(v); saveS(); }, 100, 1, 40),
            ApproachRateLabel, CursorPosLabel,
            checkbox(245, 50, 'Smooth Autoplay Cursor', 26, 'smoothAutoplay'),
            // web only: notes fly out from the middle of the grid, like in game
            checkbox(0, 10, '3D Mode', 26, 'mode3D'),
            checkbox(0, 50, '3D Hit Effect', 26, 'mode3DHitEffect'),
            Grid3DLabel,
            slider(0, 130, 230, 32, () => s.grid3DOpacity, v => { s.grid3DOpacity = Math.round(v); saveS(); }, 255, 1, 80),
            // web only: grid size
            GridZoomLabel,
            slider(0, 210, 230, 32, () => (s.gridZoom ?? 100) - 50, v => {
                s.gridZoom = Math.round(v / 5) * 5 + 50;
                layoutGrid();
                editor.resize();
                saveS();
            }, 150, 5, 50),
            NoteSizeLabel,
            slider(0, 290, 230, 32, () => (s.gridNoteSize ?? 100) - 25, v => {
                s.gridNoteSize = Math.round(v / 5) * 5 + 25;
                saveS();
            }, 175, 5, 75),
        ]);

        // ------------------------------------------------ Export
        // CALCULATE SR/RP (as in the original editor): the star rating and the ranked points from Rhythia's server; when
        // it can't be reached, the star rating worked out here (the same formula, see starrating.js), without points
        const SRLabel = label(10, 70, 190, 320, '', 28, { centerMode: None });
        const srCache = new Map();
        let calculating = false;
        const calculateSR = async () => {
            if (calculating || !window.SSQEStarRating)
                return;
            calculating = true;
            SRLabel.text = 'Calculating...';
            try {
                const data = SSQE.Formats.writeTxt(map);
                const key = data.slice(data.indexOf(','));
                let res = srCache.get(key);
                if (!res) {
                    res = await SSQEStarRating.online(data);
                    if (res)
                        srCache.set(key, res);
                }
                if (res) {
                    let text = `SR: ${Math.round(res.sr * 100) / 100}\n`;
                    for (const [name, rp] of Object.entries(res.rp))
                        text += `\n${name}: ${Math.round(+rp * 100) / 100} RP`;
                    SRLabel.text = text;
                } else {
                    const sr = SSQEStarRating.rate(map.notes.items.map(n => ({ x: n.x, y: n.y, ms: n.ms })));
                    SRLabel.text = `SR: ${Math.round(sr * 100) / 100}\n\n(worked out here:\nRhythia's server\ncouldn't be reached,\nso no RP)`;
                }
            } catch (err) {
                SRLabel.text = `Failed: ${err.message}`;
            } finally {
                calculating = false;
            }
        };
        const ReplaceIDBox = new G.Textbox(275, 230, 210, 40, { textSize: 27 });
        const ExportNav = new G.Container(1365, 222, 545, 756, [
            button(275, 20, 100, 40, 'SAVE', 27, () => app.save(map)),
            button(385, 20, 100, 40, 'SAVE AS', 27, () => app.saveAs(map)),
            new G.Dropdown(255, 90, 250, 40, {
                options: EXPORT_TYPES, textSize: 27, prefix: 'Export: ',
                get: () => s.exportType || EXPORT_TYPES[0], set: i => { s.exportType = EXPORT_TYPES[i]; saveS(); },
            }),
            button(275, 140, 210, 40, 'EXPORT MAP', 27, () => {
                const type = s.exportType || EXPORT_TYPES[0];
                if (type === EXPORT_TYPES[0])
                    app.dialogs.exportSspm(editor);
                else if (type === EXPORT_TYPES[1])
                    app.dialogs.exportSspm(editor, 'rhm');
                else if (type === EXPORT_TYPES[2])
                    app.dialogs.exportPhxm(editor);
                else if (type === EXPORT_TYPES[3])
                    app.hitTheRoad();
            }),
            ReplaceIDBox,
            button(275, 280, 210, 40, 'REPLACE', 27, () => app.replaceAudioId(map, ReplaceIDBox.text)),
            button(275, 350, 210, 40, 'CONVERT TO MP3', 27, () => app.convertToMp3(editor)),
            label(275, 190, 210, 40, 'Replace Audio ID', 30),
            button(0, 20, 210, 40, 'CALCULATE SR/RP', 27, () => calculateSR()),
            SRLabel,
        ]);

        const rightNavs = [[RNavSnapping, SnappingNav], [RNavGraphics, GraphicsNav], [RNavExport, ExportNav]];
        const ConstantNav = new G.Container(0, 0, 1920, 1080, [RNavSnapping, RNavGraphics, RNavExport, SnappingNav, GraphicsNav, ExportNav]);
        const rightIndex = s.lastRightNav ? rightNavs.findIndex(([b]) => b.text === s.lastRightNav) : 0;
        const rightRadio = new G.Radio(rightNavs.map(n => n[0]), rightIndex >= 0 ? rightIndex : null, active => {
            for (const [b, panel] of rightNavs)
                panel.visible = b === active;
            s.lastRightNav = active ? active.text.replace(/^\[|\]$/g, '') : '';
            SSQE.Settings.save(s);
        });

        // ------------------------------------------------ extra objects
        const SpecialNavBeat = button(0, 0, 150, 30, 'Beats', 26);
        const SpecialNavMine = button(0, 40, 150, 30, 'Mines', 26);
        const SpecialNavGlide = button(0, 80, 150, 30, 'Glides', 26);
        const SpecialNavLyric = button(0, 120, 150, 30, 'Lyrics', 26);
        const SpecialNavFever = button(0, 160, 150, 30, 'Fevers', 26);
        const SpecialNavNotes = button(0, 668, 150, 30, 'Modify Notes', 26);
        const SpecialNavNova = new G.Container(10, 232, 545, 756, [SpecialNavBeat, SpecialNavMine, SpecialNavGlide, SpecialNavLyric, SpecialNavFever, SpecialNavNotes]);

        const LyricBox = new G.Textbox(0, 0, 370, 30, { textSize: 26 });
        const LyricFadeIn = new G.Checkbox(0, 40, 30, 30, { text: 'Fade In', textSize: 26 });
        const LyricFadeOut = new G.Checkbox(0, 80, 30, 30, { text: 'Fade Out', textSize: 26 });
        let fadeIn = false, fadeOut = false;
        LyricFadeIn.get = () => fadeIn;
        LyricFadeIn.set = v => { fadeIn = v; if (v) fadeOut = false; };
        LyricFadeOut.get = () => fadeOut;
        LyricFadeOut.set = v => { fadeOut = v; if (v) fadeIn = false; };
        const createLyric = text => {
            const selected = map.specialObjects.selected;
            if (selected.length === 1 && selected[0] instanceof Lyric) {
                map.specialObjects.edit('EDIT LYRIC', [selected[0]], n => {
                    n.text = text;
                    n.fadeIn = fadeIn;
                    n.fadeOut = fadeOut;
                });
            } else {
                let ms = editor.closestBeat(editor.currentTime);
                ms = Math.trunc(clamp(ms >= 0 ? ms : editor.currentTime, 0, editor.totalTime));
                map.specialObjects.addObjects('ADD LYRIC', new Lyric(ms, text, fadeIn, fadeOut));
                if (s.autoAdvance)
                    editor.advance();
            }
            map.clearSelected();
            LyricBox.text = '';
            fadeIn = fadeOut = false;
        };
        const LyricCreate = button(0, 120, 370, 30, 'CREATE', 26, () => createLyric(LyricBox.text));
        LyricBox.onTextEntered = text => {
            createLyric(text);
            LyricBox.focused = true;
        };
        const LyricNav = new G.Container(175, 232, 370, 756, [
            LyricBox, LyricFadeIn, LyricFadeOut, LyricCreate,
            new G.Label(0, 160, 370, 400, {
                text: 'Lyric usage:\n> "-" prefix: Replace previous line\n> "-" suffix: Apply next lyric as a syllable\n    (Without a space in between)\n> Press \'Enter\' in the lyric textbox to quickly place a lyric',
                textSize: 20, centerMode: None,
            }),
        ], { visible: false });

        let easing = false, easingStyle = 0, easingDirection = 0;
        const NoteNav = new G.Container(175, 232, 370, 756, [
            new G.Checkbox(0, 0, 30, 30, { text: 'Enable Easing', textSize: 26, get: () => easing, set: v => easing = v }),
            new G.Dropdown(0, 80, 370, 30, { options: ['In', 'Out'], textSize: 26, prefix: 'Easing Direction: ', get: () => ['In', 'Out'][easingDirection], set: i => easingDirection = i }),
            new G.Dropdown(0, 40, 370, 30, { options: EASING_STYLES, toShow: 8, textSize: 26, prefix: 'Easing Style: ', get: () => EASING_STYLES[easingStyle], set: i => easingStyle = i }),
            button(0, 160, 370, 30, 'Apply Modifications', 26, () => map.notes.edit('MODIFY NOTE[S]', n => {
                n.enableEasing = easing;
                n.style = easingStyle;
                n.direction = easingDirection;
            })),
        ], { visible: false });

        const GameSwitch = new G.ButtonList(10, 946, 545, 50, {
            prefix: 'GAME: ', textSize: 31, options: GAMES,
            get: () => Math.max(0, GAMES.indexOf(s.modchartGame)), set: i => { s.modchartGame = GAMES[i]; saveS(); },
        });
        const SpecialNavExit = button(10, 172, 545, 50, 'CLOSE EXTRA OBJECTS', 31, () => setSpecial(false));
        const LyricPreview = new G.Label(0, 860, 1920, 56, { textSize: 48, colorSetting: 'color2' });
        const FeverPreview = new G.Square(0, 0, 1920, 1080, { color: [255, 0, 0, 23], visible: false });

        const objModes = new window.Map([
            [SpecialNavBeat, ObjectMode.Beat], [SpecialNavMine, ObjectMode.Mine], [SpecialNavGlide, ObjectMode.Glide],
            [SpecialNavLyric, ObjectMode.Lyric], [SpecialNavFever, ObjectMode.Fever], [SpecialNavNotes, ObjectMode.Note],
        ]);
        const specialRadio = new G.Radio([...objModes.keys()], null, active => {
            const mode = active ? objModes.get(active) : ObjectMode.Disabled;
            LyricNav.visible = active === SpecialNavLyric;
            NoteNav.visible = active === SpecialNavNotes;
            map.objectMode = mode;
            map.clearSelected();
        });

        const SpecialMapNavs = new G.Container(0, 0, 1920, 1080, [FeverPreview, SpecialNavNova, GameSwitch, SpecialNavExit, LyricNav, LyricPreview, NoteNav], { visible: false });

        function setSpecial(on) {
            StandardNav.visible = !on;
            SpecialMapNavs.visible = on;
            map.renderMode = on ? RenderMode.Special : RenderMode.Notes;
            map.objectMode = ObjectMode.Disabled;
            if (specialRadio.active)
                specialRadio.clear();
            map.clearSelected();
        }

        // ------------------------------------------------ main controls
        const CopyButton = button(810, 273, 300, 42, 'COPY MAP DATA', 27, () => app.copyMapData(map));
        const BackButton = button(810, 774, 300, 42, 'BACK TO MENU', 27, () => app.backToMenu());
        // (web only: under BACK TO MENU while the auto mapper works)
        const StopAutoMapButton = button(810, 822, 300, 42, 'STOP AUTO MAPPING', 27, () => {
            if (!autoMapping || !window.SSQEAutoMapper)
                return;
            SSQEAutoMapper.stop();
            editor.toast('STOPPING...', 'other', Infinity);
        });
        StopAutoMapButton.visible = false;

        const Tempo = slider(1408, 1016, 512, 64, () => map.tempoSlider, v => editor.setTempoSlider(v), 1.4, 0.05, 0.9);
        const Timeline = new SSQE.TimelineSlider(0, 1016, 1344, 64, { style: G.Styles.None, editor });
        const MusicVolume = slider(1856, 760, 40, 256, () => s.masterVolume, v => { s.masterVolume = v; saveS(); }, 1, 0.01, 0.05, { reverse: true });
        const SfxVolume = slider(1792, 760, 40, 256, () => s.sfxVolume, v => { s.sfxVolume = v; saveS(); }, 1, 0.01, 0.1, { reverse: true });
        const MusicMute = new G.TexturedButton(1868, 750, 16, 16, { textureName: 'MuteUnmute', tileSize: [2, 1], tileIndex: () => s.muteMusic ? 1 : 0, style: G.Styles.Button_Uncolored });
        MusicMute.onLeftDown = () => { s.muteMusic = !s.muteMusic; saveS(); };
        const SfxMute = new G.TexturedButton(1804, 750, 16, 16, { textureName: 'MuteUnmute', tileSize: [2, 1], tileIndex: () => s.muteSfx ? 1 : 0, style: G.Styles.Button_Uncolored });
        SfxMute.onLeftDown = () => { s.muteSfx = !s.muteSfx; saveS(); };
        const PlayPause = new G.TexturedButton(1344, 1016, 64, 64, { textureName: 'widgets', tileSize: [2, 2], tileIndex: () => editor.music.isPlaying ? 1 : 0, style: G.Styles.Transparent });
        PlayPause.onLeftDown = () => editor.togglePlay();

        const Toast = new G.Toast(0, 1000, 1920, 64, { textSize: 42 });
        const ZoomLabel = label(565, 172, 80, 30, 'Zoom:', 32, { centerMode: None });
        const ZoomValueLabel = label(640, 172, 80, 30, '', 32, { centerMode: None, colorSetting: 'color2' });
        const ClickModeLabel = label(810, 816, 300, 42, '', 30);
        const TempoLabel = label(1408, 1048, 512, 30, '', 30);
        const MusicVolumeLabel = label(1856, 720, 40, 30, 'Music', 24);
        const MusicVolumeValueLabel = label(1856, 996, 40, 30, '', 24);
        const SfxVolumeLabel = label(1792, 720, 40, 30, 'SFX', 24);
        const SfxVolumeValueLabel = label(1792, 996, 40, 30, '', 24);
        const CurrentTimeLabel = label(0, 1048, 64, 32, '', 26);
        const CurrentMsLabel = label(0, 1012, 32, 32, '', 26);
        const TotalTimeLabel = label(1280, 1048, 64, 32, '', 26);
        const NotesLabel = label(0, 1048, 1344, 32, '', 30);

        const Grid = new SSQE.GridControl(810, 390, 300, 300, { stretch: 'None', editor });
        // web only: Grid Zoom scales the grid around the middle of the screen; the buttons above and below it follow
        function layoutGrid() {
            const size = 300 * clamp((s.gridZoom ?? 100) / 100, 0.5, 2);
            const top = 540 - size / 2, bottom = 540 + size / 2;
            Grid.origin = { x: 960 - size / 2, y: top, w: size, h: size };
            if (top - 117 >= 175) {
                CopyButton.origin.y = top - 117;
                BackButton.origin.y = bottom + 84;
                StopAutoMapButton.origin.y = bottom + 132;
                ClickModeLabel.origin.y = bottom + 126;
            } else {
                // too big to fit Copy Map Data above without covering the timeline's labels: stack both buttons below
                CopyButton.origin.y = bottom + 16;
                BackButton.origin.y = bottom + 64;
                StopAutoMapButton.origin.y = bottom + 112;
                ClickModeLabel.origin.y = bottom + 108;
            }
        }
        layoutGrid();
        const Track = new SSQE.TrackControl(0, 0, 1920, 86, { editor });
        const Background = new G.Square(0, 0, 1920, 1080, {
            image: () => SSQE.Settings.editorBackgroundImage(s), cover: () => (s.editorBackground || 'Default') !== 'Default',
            // the default picture is drawn around the grid, so it grows with Grid Zoom
            imageZoom: () => (s.editorBackground || 'Default') === 'Default' ? clamp((s.gridZoom ?? 100) / 100, 0.5, 2) : 1,
            color: () => [30, 30, 30, s.editorBGOpacity],
        });

        // web only: touch screens have no keyboard shortcuts, so the common ones get buttons under the grid
        const toggleFullscreen = () => {
            if (document.fullscreenElement)
                document.exitFullscreen().catch(() => { });
            else if (document.documentElement.requestFullscreen)
                document.documentElement.requestFullscreen().then(() => screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape')).catch(() => { });
        };
        const touchActions = [['UNDO', 'undo'], ['REDO', 'redo'], ['SELECT ALL', 'selectAll'], ['COPY', 'copy'], ['CUT', 'cut'],
            ['PASTE', 'paste'], ['DELETE', 'delete'], ['SAVE', 'save'], ['FULLSCREEN', toggleFullscreen]];
        const touchWidth = (790 - 6 * (touchActions.length - 1)) / touchActions.length;
        const TouchBar = new G.Container(565, 946, 790, 50, touchActions.map(([text, action], i) =>
            button(i * (touchWidth + 6), 0, touchWidth, 50, text, 20, () => typeof action === 'function' ? action() : editor.runKeybind(action))),
        { visible: !!(SSQE.Touch && SSQE.Touch.active) });
        SSQE.Touch && SSQE.Touch.onChange(on => TouchBar.visible = on);

        const controls = [Background, StandardNav, SpecialMapNavs, ConstantNav, CopyButton, BackButton, StopAutoMapButton, Tempo,
            Timeline, MusicVolume, SfxVolume, PlayPause, Toast, ZoomLabel, ZoomValueLabel, ClickModeLabel, TempoLabel,
            MusicVolumeLabel, MusicVolumeValueLabel, SfxVolumeLabel, SfxVolumeValueLabel, CurrentTimeLabel, CurrentMsLabel,
            MusicMute, SfxMute, TotalTimeLabel, NotesLabel, TouchBar, Grid, Track];

        if (map.renderMode === RenderMode.Special) {
            StandardNav.visible = false;
            SpecialMapNavs.visible = true;
        }

        const fmtTime = ms => `${Math.trunc(ms / 60000)}:${String(Math.trunc(ms % 60000 / 1000)).padStart(2, '0')}`;

        // GuiWindowEditor.Render + the ValueChanged label updates
        function update() {
            const t = editor.currentTime, total = editor.totalTime;

            ZoomValueLabel.text = `${Math.round(map.zoom * 100)}%`;
            ClickModeLabel.text = `Click: ${editor.clickMode === 'select' ? 'Select' : 'Place'}`;
            StopAutoMapButton.visible = autoMapping;
            ClickModeLabel.visible = editor.clickMode !== 'both' && !autoMapping;

            BeatDivisorLabel.text = `Beat Divisor: ${Math.round(map.beatDivisor * 10) / 10 + 1}`;
            if (TimingNav.visible) {
                const from = divisorFrom(), to = divisorNow();
                ApplyDivisorLabel.text = map.activeList.selected.length < 2 ? '(select notes)' : from ? `(Divisor ${from} to ${to})` : '(set a BPM)';
            }
            SnappingLabel.text = `Quantum Divisor: ${Math.round(s.quantumSnapping + 3)}`;
            QuantumXLabel.text = `Quantum X Offset: ${Math.round((s.quantumXOffset - 1) * 100) / 100}`;
            QuantumYLabel.text = `Quantum Y Offset: ${Math.round((s.quantumYOffset - 1) * 100) / 100}`;
            for (const c of [QuantumXLabel, QuantumYLabel, QuantumXOffset, QuantumYOffset])
                c.visible = !s.oldQuantumSnap;
            ApproachRateLabel.text = `Approach Rate: ${Math.round(s.approachRate + 1)}`;
            PlayerApproachRateLabel.text = `Player Approach Rate: ${Math.round(ps.playerApproachRate + 1)}`;
            CursorPosLabel.text = `Cursor Position: ${Math.abs(Math.round(s.cursorPos))}%`;
            Grid3DLabel.text = `3D Grid Opacity: ${Math.round(s.grid3DOpacity / 255 * 100)}%`;
            GridZoomLabel.text = `Grid Zoom: ${s.gridZoom ?? 100}%`;
            NoteSizeLabel.text = `Note Size: ${s.gridNoteSize ?? 100}%`;
            TempoLabel.text = `PLAYBACK SPEED - ${Math.round(map.tempo * 100)}%`;
            MusicVolumeValueLabel.text = String(Math.abs(Math.round(s.masterVolume * 100)));
            SfxVolumeValueLabel.text = String(Math.abs(Math.round(s.sfxVolume * 100)));

            CurrentTimeLabel.text = fmtTime(t);
            TotalTimeLabel.text = fmtTime(total);

            const progress = total ? t / total : 0;
            const tr = Timeline.rect, mr = CurrentMsLabel.rect;
            CurrentMsLabel.rect = { x: tr.x + tr.h / 2 + (tr.w - tr.h) * progress - mr.w / 2, y: mr.y, w: mr.w, h: mr.h };
            CurrentMsLabel.text = `${Math.trunc(t).toLocaleString('en-US')}ms`;

            NotesLabel.text = map.renderMode === RenderMode.Notes ? `${map.notes.length} Notes`
                : map.renderMode === RenderMode.VFX ? `${map.vfxObjects.length} Objects` : `${map.specialObjects.length} Objects`;

            SpecialNavNova.visible = s.modchartGame === 'Novastra';

            // lyric editor / preview
            const mode = map.objectMode;
            LyricPreview.visible = SpecialMapNavs.visible && (mode === ObjectMode.Lyric || mode === ObjectMode.Disabled);
            if (LyricPreview.visible) {
                const sel = map.specialObjects.selected;
                LyricCreate.text = sel.length === 1 ? 'EDIT' : 'CREATE';
                const [text, alpha] = editor.lyricPreview();
                LyricPreview.text = text;
                LyricPreview.textAlpha = alpha;
            }
            const selectedLyric = map.specialObjects.selected.length === 1 && map.specialObjects.selected[0] instanceof Lyric ? map.specialObjects.selected[0] : null;
            if (selectedLyric && selectedLyric !== editor.lastSelectedLyric) {
                LyricBox.text = selectedLyric.text;
                fadeIn = selectedLyric.fadeIn;
                fadeOut = selectedLyric.fadeOut;
            }
            editor.lastSelectedLyric = selectedLyric;

            const selectedNote = mode === ObjectMode.Note ? map.notes.selected[0] : null;
            if (selectedNote && selectedNote !== editor.lastSelectedNote) {
                easing = selectedNote.enableEasing;
                easingStyle = selectedNote.style;
                easingDirection = Math.min(selectedNote.direction, 1);
            }
            editor.lastSelectedNote = selectedNote;

            const feverVisible = mode === ObjectMode.Disabled || mode === ObjectMode.Fever;
            FeverPreview.visible = SpecialMapNavs.visible && feverVisible &&
                map.specialObjects.items.some(o => o.id === 16 && t >= o.ms && t <= o.ms + o.duration);
        }

        // buttons that also respond to keybinds (BindKeybind)
        const keybindButtons = {};

        return { controls, update, Toast, Grid, Track, Timeline, keybindButtons, setSpecial };
    }

    SSQE.buildEditorWindow = build;
})();
