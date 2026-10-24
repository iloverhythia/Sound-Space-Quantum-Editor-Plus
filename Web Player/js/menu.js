'use strict';

// Map player menu and settings, drawn with the editor's GUI toolkit (Web Editor/js/gui.js) so they look like the
// editor's own windows.
(function () {
    const G = SSQE.GUI;
    const None = G.CenterMode.None;
    const UNCOLORED_CHECK = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];

    // opened from the editor's menu (MAP PLAYER), inside a frame on top of it
    const EMBEDDED = window.parent !== window && /[?&]embedded\b/.test(location.search);
    const settings = SSQESettings.load();
    let mapText = '';
    let mapInfo = null;      // { name, notes, length } of the loaded map
    let mapError = '';
    let audioFile = null;
    let replayBuffer = null;
    let replayInfo = '';
    let results = null;
    let fromStart = true;
    let audioCtx = null;
    let hitBuffer = null;
    let game = null;
    let screen = null;

    // what the GUI controls expect from the editor app
    const app = {
        dialogOpen: () => false,
        writeClipboard: text => navigator.clipboard && navigator.clipboard.writeText(text).catch(() => { }),
    };

    // ---------------------------------------------------------------- helpers

    const formatTime = ms => `${Math.trunc(ms / 60000)}:${String(Math.trunc(ms % 60000 / 1000)).padStart(2, '0')}`;

    function parseStartTime(text) {
        text = text.trim();
        if (text.includes(':')) {
            const [m, s] = text.split(':');
            return (parseFloat(m) || 0) * 60000 + (parseFloat(s) || 0) * 1000;
        }
        return parseFloat(text) || 0;
    }

    function toast(text, error = false) {
        screen && screen.toast && screen.toast.show(text, error ? [255, 80, 80] : settings.color1);
    }

    function pickFile(accept, multiple = false) {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            // iOS greys out files it can't match to the accept list and needs the input in the page
            if (!(window.matchMedia && matchMedia('(pointer: coarse)').matches))
                input.accept = accept;
            Object.assign(input.style, { position: 'fixed', left: '-1000px', top: '0', opacity: '0' });
            let done = false;
            const finish = file => {
                if (done)
                    return;
                done = true;
                input.remove();
                resolve(file);
            };
            if (multiple)
                input.multiple = true;
            input.addEventListener('change', () => finish(multiple ? [...input.files] : input.files[0] || null));
            input.addEventListener('cancel', () => finish(null));
            document.body.append(input);
            input.click();
        });
    }

    function pickColor(current) {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'color';
            input.value = '#' + current.slice(0, 3).map(n => Math.round(n).toString(16).padStart(2, '0')).join('');
            Object.assign(input.style, { position: 'fixed', left: '50%', top: '50%', opacity: '0', pointerEvents: 'none' });
            let done = false;
            const finish = value => {
                if (done)
                    return;
                done = true;
                input.remove();
                resolve(value ? [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16)) : null);
            };
            input.addEventListener('change', () => finish(input.value));
            input.addEventListener('cancel', () => finish(null));
            document.body.append(input);
            input.click();
        });
    }

    // ---------------------------------------------------------------- map / audio / replay

    // learn: the map was loaded by the user, so the auto mapper learns from it (and a loaded replay can be learned)
    function setMap(text, learn = false) {
        mapText = text;
        mapInfo = null;
        mapError = '';
        if (!text.trim())
            return false;
        try {
            const { id, notes } = SSQEGame.parseMap(text, settings.noteColors);
            mapInfo = { name: id, notes: notes.length, length: notes.length ? notes[notes.length - 1].Ms : 0 };
            if (learn) {
                if (window.SSQEAutoMapper)
                    SSQEAutoMapper.learn(notes.map(n => ({ x: n.X, y: n.Y, ms: n.Ms }))).catch(() => { });
                learnReplay();
            }
            return true;
        } catch (err) {
            mapError = err.message;
            return false;
        }
    }

    const sniffAudio = b => b[0] === 0x4f && b[1] === 0x67 ? ['audio/ogg', 'ogg'] : b[0] === 0x52 && b[1] === 0x49 ? ['audio/wav', 'wav']
        : b[0] === 0x66 && b[1] === 0x4c ? ['audio/flac', 'flac'] : ['audio/mpeg', 'mp3'];

    // .txt map data, or a .sspm / .rhm file with the song inside it
    async function loadMapFile(file) {
        const name = file.name.toLowerCase();
        try {
            if (name.endsWith('.sspm') || name.endsWith('.rhm')) {
                const map = new SSQE.Map();
                const { audio } = name.endsWith('.sspm')
                    ? SSQE.Formats.readSspm(map, await file.arrayBuffer())
                    : await SSQE.Formats.readRhm(map, await file.arrayBuffer(), file.name);
                map.sortAll();
                if (!setMap(SSQE.Formats.writeTxt(map), true))
                    throw new Error(mapError);
                if (audio) {
                    const [type, ext] = sniffAudio(audio);
                    loadAudioFile(new File([audio], `${map.soundId}.${ext}`, { type }), true);
                }
                toast(audio ? 'LOADED MAP AND AUDIO' : 'LOADED MAP');
                return;
            }
            if (setMap(await file.text(), true))
                toast('LOADED MAP');
            else
                toast(mapError || 'INVALID MAP', true);
        } catch (err) {
            toast(`INVALID MAP: ${err.message}`, true);
        }
    }

    let audioBuffer = null;

    function loadAudioFile(file, quiet = false) {
        audioFile = file;
        audioBuffer = null;
        if (!quiet)
            toast('LOADED AUDIO');
        // decoded up front: plays with exact timing and doesn't need an <audio> element (which iOS restricts)
        if (!audioCtx)
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        file.arrayBuffer()
            .then(buf => audioCtx.decodeAudioData(buf))
            .then(decoded => {
                if (audioFile === file)
                    audioBuffer = decoded;
            })
            .catch(() => { });
    }

    async function loadReplayFile(file) {
        try {
            const buffer = await file.arrayBuffer();
            const r = SSQEGame.parseReplay(buffer);
            replayBuffer = buffer;
            replayName = file.name;
            replayInfo = r.format === 'sspre'
                ? `${r.name || file.name} - ${formatTime(r.endMs)} long`
                : `${file.name} - ${r.cursor.length} cursor nodes - tempo ${Math.round(r.tempo * 100)}%`;
            toast('LOADED REPLAY');
            learnReplay();
        } catch (err) {
            replayBuffer = null;
            replayInfo = '';
            toast(`INVALID REPLAY: ${err.message}`, true);
        }
    }

    // the bot learns from .sspre replays once they're lined up with their map
    let replayName = '';
    const learnedReplays = new Set();
    async function learnReplay() {
        if (!replayBuffer || !mapInfo || !window.SSQEBot)
            return;
        const id = `${replayName}|${replayBuffer.byteLength}|${mapInfo.name}|${mapInfo.notes}`;
        if (learnedReplays.has(id))
            return;
        learnedReplays.add(id);
        try {
            const r = SSQEGame.parseReplay(replayBuffer);
            if (r.format !== 'sspre')
                return;
            const notes = SSQEGame.parseMap(mapText, settings.noteColors).notes;
            const aligned = SSQEGame.alignReplay(r, notes);
            if (!aligned.alignment || aligned.alignment.matched < 0.5)
                return;
            const tempo = aligned.tempo || 1;
            const ok = await SSQEBot.learn(aligned.cursor, notes, id, {
                hitWindow: (parseFloat(r.settings && r.settings.hitw) || 55) * tempo,
                hitbox: parseFloat(r.settings && r.settings.hbox) || 1.14,
            });
            if (ok)
                toast('THE BOT LEARNED FROM THIS REPLAY');
        } catch (err) {
            console.warn('The bot could not learn from this replay', err);
        }
    }

    // map text from a .sspm, .rhm or .txt file
    async function mapTextFromFile(file) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.sspm') || name.endsWith('.rhm')) {
            const map = new SSQE.Map();
            if (name.endsWith('.sspm'))
                SSQE.Formats.readSspm(map, await file.arrayBuffer());
            else
                await SSQE.Formats.readRhm(map, await file.arrayBuffer(), file.name);
            map.sortAll();
            return SSQE.Formats.writeTxt(map);
        }
        return file.text();
    }

    // Bulk learning: every .sspre in files is matched to a map (picked alongside, or the loaded one) by its name, or
    // failing that by which map its cursor lines up with, and the bot learns from it.
    // report(text, isError) shows progress.
    let bulkLearning = false;
    async function learnFromFiles(files, report) {
        if (bulkLearning || !window.SSQEBot)
            return;
        const replays = files.filter(f => /\.sspre$/i.test(f.name));
        if (!replays.length) {
            report('PICK .SSPRE REPLAYS, AND THEIR MAPS IF THEY AREN\'T LOADED', true);
            return;
        }
        bulkLearning = true;
        const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
        const maps = [];
        try {
            for (const f of files.filter(f => /\.(sspm|rhm|txt)$/i.test(f.name))) {
                try {
                    const { id, notes } = SSQEGame.parseMap(await mapTextFromFile(f), settings.noteColors);
                    if (notes.length)
                        maps.push({ id, notes, file: f.name });
                } catch { /* not a map */ }
            }
            if (mapInfo && mapText)
                try {
                    maps.push({ id: mapInfo.name, notes: SSQEGame.parseMap(mapText, settings.noteColors).notes, file: '' });
                } catch { /* ignore */ }

            let learned = 0, known = 0, unmatched = 0, failed = 0;
            for (let i = 0; i < replays.length; i++) {
                const f = replays[i];
                report(`LEARNING FROM REPLAY ${i + 1} OF ${replays.length}...`);
                await new Promise(r => setTimeout(r, 30));
                try {
                    const buffer = await f.arrayBuffer();
                    const r = SSQEGame.parseReplay(buffer);
                    if (r.format !== 'sspre') {
                        failed++;
                        continue;
                    }
                    const names = [norm(r.name || ''), norm(f.name)];
                    let candidates = maps.filter(m => {
                        const ids = [norm(m.id), norm(m.file.replace(/\.[^.]*$/, ''))].filter(Boolean);
                        return ids.some(id => names.some(n => n.startsWith(id)));
                    });
                    if (!candidates.length)
                        candidates = maps;
                    let best = null;
                    for (const m of candidates) {
                        const aligned = SSQEGame.alignReplay(r, m.notes);
                        const q = aligned.alignment ? aligned.alignment.matched : 0;
                        if (!best || q > best.q)
                            best = { aligned, m, q };
                    }
                    if (!best || best.q < 0.5) {
                        unmatched++;
                        continue;
                    }
                    const tempo = best.aligned.tempo || 1;
                    const id = `${f.name}|${buffer.byteLength}|${best.m.id}|${best.m.notes.length}`;
                    learnedReplays.add(id);
                    const ok = await SSQEBot.learn(best.aligned.cursor, best.m.notes, id, {
                        hitWindow: (parseFloat(r.settings && r.settings.hitw) || 55) * tempo,
                        hitbox: parseFloat(r.settings && r.settings.hbox) || 1.14,
                    });
                    ok ? learned++ : known++;
                } catch (err) {
                    console.warn(`Couldn't learn from ${f.name}`, err);
                    failed++;
                }
            }
            const parts = [`LEARNED FROM ${learned} OF ${replays.length} REPLAYS`];
            if (known)
                parts.push(`${known} ALREADY LEARNED`);
            if (unmatched)
                parts.push(`${unmatched} WITHOUT THEIR MAP`);
            if (failed)
                parts.push(`${failed} UNREADABLE`);
            report(parts.join(' - '), !learned && (unmatched + failed) > 0);
        } finally {
            bulkLearning = false;
        }
    }

    async function pasteMap() {
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            // reading the clipboard isn't allowed everywhere (e.g. inside a Claude artifact); a normal paste still works
            toast('PRESS CTRL+V TO PASTE THE MAP');
            return;
        }
        if (!text.trim())
            return;
        if (setMap(text.trim(), true))
            toast('PASTED MAP');
        else
            toast(mapError || 'INVALID MAP', true);
    }

    function demoMap() {
        const notes = [];
        let x = 1, y = 1;
        const beat = 60000 / 130;
        for (let i = 0; i < 160; i++) {
            const step = i % 16 === 15 ? 2 : 1;
            for (let k = 0; k < step; k++) {
                x = Math.max(0, Math.min(2, x + Math.round(Math.random() * 2 - 1)));
                y = Math.max(0, Math.min(2, y + Math.round(Math.random() * 2 - 1)));
            }
            notes.push(`${x}|${y}|${Math.round(1000 + i * beat / (i % 32 < 16 ? 1 : 2))}`);
        }
        setMap('demo,' + notes.join(','));
        toast('GENERATED DEMO MAP');
    }

    // Ctrl+V on the menu pastes map data
    window.addEventListener('paste', e => {
        if (game || document.activeElement && document.activeElement.id === 'touch-input')
            return;
        const text = (e.clipboardData || window.clipboardData).getData('text').trim();
        if (!text || (SSQE.GUI.activeWindow && SSQE.GUI.activeWindow.textboxFocused()))
            return;
        e.preventDefault();
        if (setMap(text, true))
            toast('PASTED MAP');
        else
            toast(mapError || 'INVALID MAP', true);
    });

    // drag & drop anywhere
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
        e.preventDefault();
        if (game)
            return;
        const dropped = [...e.dataTransfer.files];
        // several replays at once: the bot learns from all of them (with the maps dropped alongside)
        if (dropped.filter(f => /\.sspre$/i.test(f.name)).length > 1) {
            learnFromFiles(dropped, toast);
            return;
        }
        for (const file of dropped) {
            const name = file.name.toLowerCase();
            if (name.endsWith('.sspre') || name.endsWith('.qer'))
                loadReplayFile(file);
            else if (/\.(sspm|rhm)$/.test(name) || (name.endsWith('.txt') && !file.type.startsWith('audio')))
                loadMapFile(file);
            else
                loadAudioFile(file);
        }
    });

    // ---------------------------------------------------------------- starting a game

    async function ensureAudio() {
        if (!audioCtx)
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended')
            await audioCtx.resume().catch(() => { });
        if (!hitBuffer) {
            try {
                const res = await fetch(window.SSQE_HIT_WAV);
                hitBuffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
            } catch {
                hitBuffer = null;
            }
        }
    }

    async function start(mode) {
        if (game)
            return;
        if (!mapInfo) {
            toast(mapError || 'LOAD A MAP FIRST', true);
            return;
        }
        if (mode === 'replay' && !replayBuffer) {
            toast('LOAD A REPLAY FIRST', true);
            return;
        }

        // must happen synchronously inside the click for the browser to allow it
        if (settings.fullscreenPlayer && !document.fullscreenElement && document.documentElement.requestFullscreen)
            document.documentElement.requestFullscreen().catch(() => { });

        await ensureAudio();
        if ((mode === 'bot' || settings.realisticAutoplay) && window.SSQEBot)
            await SSQEBot.load();

        let audioElement = null;
        const tempo = SSQESettings.tempoFromSlider(settings.tempo);
        // (at other tempos the decoded song is stretched without changing its pitch, see the editor's stretch.js)
        if (audioFile && (!audioBuffer || (!window.SSQEStretch && Math.abs(tempo - 1) > 1e-6) || mode === 'replay')) {
            try {
                audioElement = await SSQEGame.loadAudio(audioFile);
            } catch (err) {
                toast(err.message.toUpperCase(), true);
                if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => { });
                return;
            }
        }

        if (document.activeElement)
            document.activeElement.blur();

        // .sspre replays can start part way into the song: line their cursor up with the map's notes
        let replay = null, replayStart = null;
        if (mode === 'replay') {
            replay = SSQEGame.parseReplay(replayBuffer);
            if (replay.format === 'sspre') {
                replay = SSQEGame.alignReplay(replay, SSQEGame.parseMap(mapText, settings.noteColors).notes);
                // notes before the replay's start offset weren't part of the run
                replayStart = Math.max(0, replay.cursor[0].Ms, replay.songTime ? replay.startOffset || 0 : 0);
                // the game moves replay cursors on its own clock (real time since it started, which begins 65ms before a
                // 2s lead-in, after which the song plays from replayStart at the replay's tempo) and centred on the
                // grid (-1..1, where notes are 0..2)
                const tempo = replay.tempo || 1;
                // replays aligned in song time are played on the song's clock; others on the game's own clock
                const engineTime = replay.songTime ? ms => ms : ms => (ms - replayStart) / tempo + 2000 - 65;
                replay = {
                    ...replay,
                    cursor: replay.cursor.map(c => ({ X: c.X - 1, Y: c.Y - 1, Ms: engineTime(c.Ms) })),
                    skips: (replay.skips || []).map(k => ({ ...k, Ms: engineTime(k.Ms) })),
                };
                if (replay.alignment && replay.alignment.matched < 0.5)
                    toast('THIS REPLAY MAY NOT BE FOR THIS MAP', true);
            }
        }

        try {
            G.fadeIn(document.getElementById('game'), document.getElementById('overlay'));
            game = new SSQEGame.Game({
                canvas: document.getElementById('game'),
                overlay: document.getElementById('overlay'),
                settings: SSQESettings.clone(settings),
                mapText,
                audioElement,
                audioBuffer,
                audioCtx,
                hitBuffer,
                replayBuffer: replay,
                mode,
                fromStart: replayStart === null ? fromStart : false,
                startTime: replayStart === null ? parseStartTime(menu.startBox.text) : replayStart,
                onExit: finish,
            });
        } catch (err) {
            toast(`FAILED TO START: ${err.message}`, true);
            return;
        }

        screen.stop();
        document.body.classList.add('playing');
        game.start();
        if (mode === 'play')
            game.lockPointer();
    }

    function finish(r) {
        game = null;
        document.body.classList.remove('playing');
        if (document.fullscreenElement)
            document.exitFullscreen().catch(() => { });
        results = r;
        show(menu);
    }

    // ---------------------------------------------------------------- screens

    function show(next) {
        // (the old screen fades out as the new one comes in)
        G.crossfade(document.getElementById('editor-canvas'));
        if (screen)
            screen.stop();
        screen = next.screen;
        screen.toast = next.toast;
        screen.start();
    }

    const background = () => new G.Square(0, 0, 1920, 1080, { color: [30, 30, 30] });
    const button = (x, y, w, h, text, textSize, onClick, props = {}) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick, ...props });
    // (the main menu's buttons: flat, without the gradient, and nearly square cornered, like the original editor's menu)
    const flatButton = (x, y, w, h, text, textSize, onClick, props = {}) => button(x, y, w, h, text, textSize, onClick, { gradient: false, cornerRadius: 0.06, ...props });
    const label = (x, y, w, h, text, textSize, props = {}) => new G.Label(x, y, w, h, { text, textSize, centerMode: None, ...props });
    const dynamic = (x, y, w, h, textSize, fn, props = {}) => {
        const l = label(x, y, w, h, '', textSize, props);
        l.process = function (dt) {
            G.Label.prototype.process.call(this, dt);
            this.text = fn();
        };
        return l;
    };

    // laid out like GuiWindowMenu: title top left, a dark panel on the left, big buttons on the right
    function buildMenu() {
        const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
        const startBox = new G.Textbox(60, 790, 300, 50, { textSize: 30, style: G.Styles.Textbox_Uncolored, text: '0:00' });
        const replayButton = flatButton(1190, 410, 600, 100, 'WATCH REPLAY', 54, () => start('replay'));
        const toast = new G.Toast(0, 1000, 1920, 64, { textSize: 42 });

        const controls = [
            background(),
            new G.Square(35, 180, 950, 790, { color: [0, 0, 0, 40] }),
            new G.Square(55, 230, 900, 715, { color: [0, 0, 0, 50] }),
            new G.Square(0, 1040, 1920, 40, { color: [0, 0, 0, 50] }),
            new SSQE.Screens.Picture(35, 4, 212, 172, { name: 'logo', align: 'left' }),
            label(262, 26, 700, 90, 'QUANTUM EDITOR PLUS', 84, { font: 'square' }),
            label(262, 118, 400, 40, 'MAP PLAYER', 38, { font: 'square' }),
            label(60, 195, 200, 40, 'MAP', 42),

            flatButton(60, 250, 280, 50, 'LOAD MAP', 30, async () => {
                const f = await pickFile('.txt,.sspm,.rhm,text/plain');
                f && loadMapFile(f);
            }),
            flatButton(350, 250, 280, 50, 'PASTE MAP', 30, pasteMap),
            flatButton(640, 250, 280, 50, 'DEMO MAP', 30, demoMap),
            dynamic(60, 315, 880, 30, 24, () => mapInfo
                ? `${mapInfo.name} - ${mapInfo.notes} notes - ${formatTime(mapInfo.length)}`
                : mapError ? `Invalid map: ${mapError}` : 'No map loaded', { colorSetting: null }),

            flatButton(60, 375, 280, 50, 'LOAD AUDIO', 30, async () => {
                const f = await pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
                f && loadAudioFile(f);
            }),
            dynamic(60, 440, 880, 30, 24, () => audioFile
                ? `${audioFile.name} (${(audioFile.size / 1048576).toFixed(1)} MB)` : 'No audio - the map will play silently'),

            flatButton(60, 500, 280, 50, 'LOAD REPLAY', 30, async () => {
                const f = await pickFile('.sspre,.qer');
                f && loadReplayFile(f);
            }),
            dynamic(60, 565, 880, 30, 24, () => replayInfo || 'No replay loaded'),

            label(60, 630, 200, 40, 'START', 42),
            new G.Checkbox(60, 685, 45, 45, {
                text: 'Play From Start', textSize: 30, style: UNCOLORED_CHECK, get: () => fromStart, set: v => fromStart = v,
            }),
            label(60, 755, 400, 30, 'Start Time (m:ss or ms):', 26),
            startBox,

            dynamic(400, 755, 540, 190, 24, () => results ? [
                'LAST RESULT',
                `Accuracy: ${results.accuracy}`,
                `Hits: ${results.hits}    Misses: ${results.misses}`,
                `Max Combo: ${results.maxCombo}    Pauses: ${results.pauses}`,
                `Mode: ${results.mode}`,
            ].join('\n') : ''),

            flatButton(1190, 180, 600, 100, 'PLAY', 54, () => start('play')),
            flatButton(1190, 295, 600, 100, 'AUTOPLAY', 54, () => start('autoplay')),
            replayButton,
            flatButton(1190, 525, 600, 100, 'SETTINGS', 54, () => show(settingsScreen)),
            // opened from the editor's menu: a way back to it
            ...(EMBEDDED ? [flatButton(1190, 640, 600, 100, 'BACK TO EDITOR', 54, () => {
                if (game)
                    return;
                window.parent.postMessage('ssqe-close-player', '*');
            })] : []),

            dynamic(1190, EMBEDDED ? 747 : 632, 600, 26, 22, () => {
                const b = window.SSQEBot && SSQEBot.statsSync();
                return b ? `Realistic autoplay: ${settings.realisticAutoplay ? 'on' : 'off'} - learned from ${b.replays} replay${b.replays === 1 ? '' : 's'}` : '';
            }),
            label(1190, EMBEDDED ? 775 : 660, 600, 300, touch
                ? 'Controls:\n\n> Drag anywhere to move the cursor\n> Buttons in the top right corner:\n>> Restart, pause (hold to unpause) and quit'
                : 'Controls:\n\n> Quit: ESCAPE / hold R\n> Restart: TAB\n> Pause: SPACE (hold to unpause)\n> Offset: SCROLL\n> Unfocus: CTRL + U\n> Focus: LEFT CLICK\n> Fullscreen: F11', 22),
            label(0, 1040, 1920, 40, 'Drop a map (.sspm, .rhm or .txt), audio or a replay (.sspre) anywhere on the page', 20, { centerMode: G.CenterMode.XY }),
            toast,
        ];

        const s = new SSQE.Screens.Screen(app, controls);
        s.update = () => {
            replayButton.visible = !!replayBuffer;
        };
        return { screen: s, toast, startBox };
    }

    // laid out like GuiWindowSettings: section buttons on the left, the section's controls next to them
    function buildSettings() {
        const save = () => SSQESettings.save(settings);
        const toast = new G.Toast(0, 1000, 1920, 64, { textSize: 42 });

        class NoteColors extends G.Interactive {
            init() {
                super.init();
                this.hoverIndex = -1;
            }

            mouseMove(x) {
                const colors = settings.noteColors;
                const w = this.rect.w / colors.length;
                this.hoverIndex = this.hovering ? Math.min(Math.max(Math.trunc((x - this.rect.x) / w), 0), colors.length - 1) : -1;
            }

            mouseLeave() {
                super.mouseLeave();
                this.hoverIndex = -1;
            }

            mouseUpLeft(x, y) {
                super.mouseUpLeft(x, y);
                if (this.hovering && this.hoverIndex >= 0 && settings.noteColors.length > 1) {
                    settings.noteColors.splice(this.hoverIndex, 1);
                    save();
                }
            }

            mouseUpRight(x, y) {
                super.mouseUpRight(x, y);
                const i = this.hoverIndex;
                if (this.hovering && i > 0) {
                    const c = settings.noteColors;
                    [c[i], c[i - 1]] = [c[i - 1], c[i]];
                    save();
                }
            }

            draw(ctx) {
                const colors = settings.noteColors;
                const w = this.rect.w / colors.length;
                colors.forEach((c, i) => {
                    ctx.fillStyle = G.rgb(c);
                    ctx.fillRect(this.rect.x + w * i, this.rect.y, w, this.rect.h);
                });
                if (this.hoverIndex >= 0) {
                    ctx.strokeStyle = 'rgb(0,127,255)';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(this.rect.x + w * this.hoverIndex, this.rect.y, w, this.rect.h);
                }
            }
        }

        // one control per schema item, flowing down two columns
        function section(items) {
            const controls = [];
            let x = 0, y = 0;
            for (const item of items) {
                const height = item.type === 'bool' ? 60 : item.type === 'colorlist' ? 130 : item.type === 'botLearn' ? 140 : 100;
                if (y + height > 660) {
                    x += 700;
                    y = 0;
                }
                const get = () => settings[item.key];
                const set = v => {
                    settings[item.key] = v;
                    save();
                };
                const title = item.label.replace(/(^|\s)([a-z])/g, (m, a, c) => a + c.toUpperCase()).replace('Colours', 'Colors');

                if (item.type === 'bool')
                    controls.push(new G.Checkbox(x, y, 45, 45, { text: title, textSize: 34, style: UNCOLORED_CHECK, get, set }));
                else if (item.type === 'number')
                    controls.push(
                        label(x, y, 400, 26, `${title}:`, 30),
                        new G.NumberBox(x, y + 30, 200, 50, {
                            textSize: 30, style: G.Styles.Textbox_Uncolored, get, set, increment: item.step,
                            isFloat: item.step % 1 !== 0, isPositive: item.min !== undefined && item.min >= 0,
                            bounds: [item.min ?? -1e9, item.max ?? 1e9],
                        }));
                else if (item.type === 'range') {
                    const fmt = item.format || (v => String(v));
                    controls.push(
                        dynamic(x, y, 400, 26, 30, () => `${title}: ${fmt(get())}`),
                        new G.Slider(x - 12, y + 30, 424, 55, {
                            get: () => get() - item.min, set: v => set(Math.round((v + item.min) / item.step) * item.step),
                            max: item.max - item.min, step: item.step, def: SSQESettings.DEFAULTS[item.key] - item.min,
                        }));
                } else if (item.type === 'select')
                    controls.push(
                        label(x, y, 400, 26, `${title}:`, 30),
                        new G.ButtonList(x, y + 30, 400, 50, {
                            textSize: 30, options: item.options,
                            get: () => Math.max(0, item.options.indexOf(get())), set: i => set(item.options[i]),
                        }));
                else if (item.type === 'dropdown')
                    controls.push(
                        label(x, y, 400, 26, `${title}:`, 30),
                        new G.Dropdown(x, y + 30, 400, 50, {
                            textSize: 30, options: item.options, toShow: 8,
                            get: () => get(), set: i => set(item.options[i]),
                        }));
                else if (item.type === 'customImage')
                    controls.push(
                        dynamic(x, y, 600, 26, 30, () => `${title}: ${SSQECustom.state.imageName || 'None'}`),
                        button(x, y + 30, 200, 50, 'LOAD IMAGE', 30, async () => {
                            const file = await pickFile('image/*');
                            if (!file)
                                return;
                            try {
                                await SSQECustom.setImage(file);
                                settings.background = 'Custom Image';
                                save();
                                toast.show('BACKGROUND IMAGE LOADED', settings.color1);
                            } catch (err) {
                                toast.show(`COULDN'T SAVE THE IMAGE: ${err.message}`.toUpperCase(), [255, 50, 50]);
                            }
                        }),
                        button(x + 210, y + 30, 150, 50, 'CLEAR', 30, async () => {
                            await SSQECustom.setImage(null).catch(() => { });
                            if (settings.background === 'Custom Image') {
                                settings.background = 'None';
                                save();
                            }
                        }));
                else if (item.type === 'customMesh')
                    controls.push(
                        dynamic(x, y, 600, 26, 30, () => `${title}: ${SSQECustom.state.noteMeshName || 'Default'}`),
                        button(x, y + 30, 200, 50, 'LOAD MESH', 30, async () => {
                            const file = await pickFile('.obj');
                            if (!file)
                                return;
                            try {
                                await SSQECustom.setNoteMesh(file);
                                toast.show('NOTE MESH LOADED', settings.color1);
                            } catch (err) {
                                toast.show(`INVALID MESH: ${err.message}`.toUpperCase(), [255, 50, 50]);
                            }
                        }),
                        button(x + 210, y + 30, 150, 50, 'RESET', 30, () => SSQECustom.setNoteMesh(null).catch(() => { })));
                else if (item.type === 'botLearn')
                    controls.push(
                        label(x, y, 700, 26, `${title}:`, 30),
                        button(x, y + 30, 360, 50, 'UPLOAD REPLAYS', 30, async () => {
                            const files = await pickFile('.sspre,.sspm,.rhm,.txt', true);
                            if (files && files.length)
                                learnFromFiles(files, (text, error) => toast.show(text, error ? [255, 80, 80] : settings.color1));
                        }),
                        label(x, y + 85, 700, 40, 'Pick any number of .sspre replays, plus their maps (.sspm, .rhm, .txt)\nunless the map is already loaded. You can also drop them on the menu.', 22));
                else if (item.type === 'mapperLearn')
                    controls.push(
                        label(x, y, 700, 26, `${title}:`, 30),
                        button(x, y + 30, 360, 50, 'UPLOAD MAPS', 30, async () => {
                            const files = await pickFile('.sspm,.rhm,.txt,.osu', true);
                            if (files && files.length && window.SSQEAutoMapper)
                                SSQEAutoMapper.learnFiles(files, (text, error) => toast.show(text, error ? [255, 80, 80] : settings.color1));
                        }));
                else if (item.type === 'botInfo' || item.type === 'mapperInfo') {
                    const bot = item.type === 'botInfo';
                    const lib = () => bot ? window.SSQEBot : window.SSQEAutoMapper;
                    let confirm = false;
                    const reset = button(x, y + 30, 300, 50, 'RESET LEARNING', 30, async () => {
                        if (!confirm) {
                            confirm = true;
                            reset.text = 'ARE YOU SURE?';
                            setTimeout(() => { confirm = false; reset.text = 'RESET LEARNING'; }, 4000);
                            return;
                        }
                        confirm = false;
                        reset.text = 'RESET LEARNING';
                        lib() && await lib().reset();
                        toast.show(bot ? 'BOT LEARNING RESET' : 'AUTO MAPPER LEARNING RESET', settings.color1);
                    });
                    controls.push(
                        dynamic(x, y, 700, 26, 30, () => {
                            const st = lib() && lib().statsSync();
                            if (!st)
                                return `${title}: -`;
                            return bot ? `${title}: ${st.replays} replays, ${st.notes} notes`
                                : `${title}: ${st.maps} maps, ${st.notes} notes`;
                        }),
                        reset);
                } else if (item.type === 'color')
                    controls.push(
                        label(x, y, 600, 26, `${title}:`, 30),
                        button(x, y + 30, 200, 50, 'PICK COLOR', 30, () => pickColor(get()).then(c => c && set(c))),
                        new G.Square(x + 210, y + 30, 75, 50, { color: () => get() }));
                else if (item.type === 'colorlist')
                    controls.push(
                        label(x, y, 400, 26, `${title}:`, 30),
                        button(x, y + 30, 200, 50, 'ADD COLOR', 30, () => pickColor([255, 255, 255]).then(c => {
                            if (c && settings.noteColors.length < 32) {
                                settings.noteColors.push(c);
                                save();
                            }
                        })),
                        new NoteColors(x + 210, y + 30, 150, 50),
                        label(x, y + 85, 400, 26, 'LMB: Remove    RMB: Move left', 22));
                y += height;
            }
            return new G.Container(320, 0, 1400, 700, controls);
        }

        const names = SSQESettings.SCHEMA.map(([title]) => title.toUpperCase().replace('CAMERA & CURSOR', 'CAMERA').replace('COLOURS', 'COLORS'));
        const panels = SSQESettings.SCHEMA.map(([, items]) => section(items));
        const navButtons = names.map((t, i) => new G.Button(0, i * 100, 200, 50, { text: t, textSize: 30 }));
        const nav = new G.Container(180, 80, 200, 550, [...navButtons, ...panels]);
        new G.Radio(navButtons, 0, active => panels.forEach((p, i) => p.visible = navButtons[i] === active));

        let resetQuery = false, resetTimer = null;
        const resetButton = button(700, 865, 500, 50, 'RESET TO DEFAULT', 30, () => {
            if (resetQuery) {
                // keep the same object, the GUI and sound player hold on to it
                for (const k of Object.keys(settings))
                    delete settings[k];
                Object.assign(settings, SSQESettings.clone(SSQESettings.DEFAULTS));
                save();
                resetQuery = false;
                resetButton.text = 'RESET TO DEFAULT';
                toast.show('SETTINGS RESET', settings.color1);
            } else {
                resetQuery = true;
                resetButton.text = 'ARE YOU SURE?';
                clearTimeout(resetTimer);
                resetTimer = setTimeout(() => {
                    resetQuery = false;
                    resetButton.text = 'RESET TO DEFAULT';
                }, 5000);
            }
        });

        const importButton = button(700, 810, 500, 50, 'IMPORT EDITOR SETTINGS', 30, async () => {
            const file = await pickFile('.txt,.json');
            if (!file)
                return;
            try {
                const count = SSQESettings.applyObject(settings, JSON.parse(await file.text()), true);
                save();
                toast.show(`IMPORTED ${count} SETTINGS`, settings.color1);
            } catch (err) {
                toast.show(`FAILED TO LOAD SETTINGS: ${err.message}`, [255, 80, 80]);
            }
        });

        // the whole setup (map player and editor settings, background, cursor, note mesh) in one .ssqes file
        const exportSetupButton = button(1270, 810, 500, 50, 'EXPORT SETUP (.SSQES)', 30, async () => {
            save();
            try {
                const learned = window.confirm('Also include what the auto mapper and the realistic autoplay bot have learned? (The file gets bigger.)');
                const blob = await SSQECustom.exportSetup({ learned });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'my-setup.ssqes';
                document.body.append(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
                toast.show('EXPORTED SETUP', settings.color1);
            } catch (err) {
                toast.show(`FAILED TO EXPORT: ${err.message}`, [255, 80, 80]);
            }
        });
        const importSetupButton = button(1270, 865, 500, 50, 'IMPORT SETUP (.SSQES)', 30, async () => {
            const file = await pickFile('.ssqes');
            if (!file || !window.confirm(`Import the setup in '${file.name}'? It replaces your map player and editor settings, background, grid cursor and note mesh.`))
                return;
            try {
                await SSQECustom.importSetup(file);
                // start again with the new setup (the editor too, when the player is open inside it)
                try {
                    (EMBEDDED ? window.parent : window).location.reload();
                } catch {
                    location.reload();
                }
            } catch (err) {
                toast.show(`FAILED TO IMPORT: ${err.message}`, [255, 80, 80]);
            }
        });

        const controls = [
            background(), nav, resetButton, importButton, exportSetupButton, importSetupButton,
            button(660, 930, 600, 100, 'SAVE AND RETURN', 54, () => {
                save();
                if (mapText)
                    setMap(mapText);
                show(menu);
            }),
            toast,
        ];
        return { screen: new SSQE.Screens.Screen(app, controls), toast };
    }

    let menu = null, settingsScreen = null;

    window.addEventListener('DOMContentLoaded', async () => {
        G.setSettings(settings);
        SSQE.Audio.SoundPlayer.settings = settings;
        await G.loadFonts();
        menu = buildMenu();
        settingsScreen = buildSettings();
        show(menu);
        // the STATS page (in the editor): a session of the player on its own (inside the editor it's the editor's)
        if (window.SSQEStats && !EMBEDDED) {
            SSQEStats.session();
            SSQEStats.tick(() => false);
        }

        // click sounds need an unlocked audio context
        const unlock = () => {
            SSQE.Audio.loadSounds();
            window.removeEventListener('pointerdown', unlock, true);
        };
        window.addEventListener('pointerdown', unlock, true);
    });
})();
