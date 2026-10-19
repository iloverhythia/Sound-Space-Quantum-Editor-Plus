'use strict';

// Port of NewMaps/Mapping.cs (open/close/save/cache), NewGUI/Windows/GuiWindowMenu.cs, GuiWindowCreate.cs and
// GuiWindowSettings.cs, plus browser-specific storage (IndexedDB stands in for the editor's cached/ folder).
(function () {
    // (a note's place and time, to remember which notes the auto mapper placed)
    // the newest version in a changelog ('-- Plus 3.0.27 - ...'), and whether one version is newer than another
    const versionIn = text => {
        const m = /-- Plus (\d+(?:\.\d+)+)/.exec(text || '');
        return m ? m[1] : null;
    };
    const newerVersion = (a, b) => {
        const p = a.split('.').map(Number), q = b.split('.').map(Number);
        for (let i = 0; i < Math.max(p.length, q.length); i++)
            if ((p[i] || 0) !== (q[i] || 0))
                return (p[i] || 0) > (q[i] || 0);
        return false;
    };
    const autoKey = n => `${Math.round(n.x * 1000)}|${Math.round(n.y * 1000)}|${Math.round(n.ms)}`;
    // (copied notes, kept in the browser for pasting into another map or window: see copyObjects)
    const CLIPBOARD_KEY = 'ssqe-plus-clipboard';
    const { Map, Formats, RenderMode } = SSQE;
    const el = (...a) => SSQE.el(...a);

    // ---------------------------------------------------------------- storage

    class Storage {
        constructor() {
            this.memory = { audio: new window.Map(), maps: new window.Map(), handles: new window.Map() };
            this.db = null;
        }

        async open() {
            if (!window.indexedDB)
                return;
            try {
                this.db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open('ssqe-web-editor', 1);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        for (const name of ['audio', 'maps', 'handles'])
                            if (!db.objectStoreNames.contains(name))
                                db.createObjectStore(name);
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
            } catch (e) {
                console.warn('IndexedDB unavailable, maps will not persist', e);
            }
        }

        async op(store, mode, fn) {
            if (!this.db) {
                const m = this.memory[store];
                return fn({
                    get: k => m.get(k), put: (v, k) => m.set(k, v), delete: k => m.delete(k),
                    getAll: () => [...m.values()],
                }, true);
            }
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(store, mode);
                const req = fn(tx.objectStore(store), false);
                tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
                tx.onerror = () => reject(tx.error);
            });
        }

        getAudio(id) { return this.op('audio', 'readonly', s => s.get(id)); }
        putAudio(id, blob) { return this.op('audio', 'readwrite', s => s.put(blob, id)); }
        getMaps() { return this.op('maps', 'readonly', s => s.getAll()); }
        putMap(rec) { return this.op('maps', 'readwrite', s => s.put(rec, rec.key)); }
        deleteMap(key) { return this.op('maps', 'readwrite', s => s.delete(key)); }
        getHandle(key) { return this.op('handles', 'readonly', s => s.get(key)); }
        putHandle(key, h) { return this.op('handles', 'readwrite', s => s.put(h, key)); }
        deleteHandle(key) { return this.op('handles', 'readwrite', s => s.delete(key)); }
    }

    // guesses a mime type for raw audio bytes so the browser can decode SSPM audio
    function sniffAudio(bytes) {
        const b = bytes.subarray(0, 12);
        const str = String.fromCharCode(...b);
        if (str.startsWith('OggS'))
            return 'audio/ogg';
        if (str.startsWith('RIFF'))
            return 'audio/wav';
        if (str.startsWith('fLaC'))
            return 'audio/flac';
        if (str.slice(4, 8) === 'ftyp')
            return 'audio/mp4';
        return 'audio/mpeg';
    }

    // a minimal (stored, uncompressed) zip writer for handing over several files at once
    const CRC_TABLE = (() => {
        const t = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++)
                c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        let c = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++)
            c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    async function zipFiles(files) {
        const enc = new TextEncoder();
        const parts = [], central = [];
        let offset = 0;
        for (const { name, blob } of files) {
            const data = new Uint8Array(await blob.arrayBuffer());
            const nameBytes = enc.encode(name);
            const crc = crc32(data);
            const local = new DataView(new ArrayBuffer(30));
            local.setUint32(0, 0x04034b50, true);
            local.setUint16(4, 20, true);
            local.setUint16(6, 0x0800, true); // utf-8 names
            local.setUint32(14, crc, true);
            local.setUint32(18, data.length, true);
            local.setUint32(22, data.length, true);
            local.setUint16(26, nameBytes.length, true);
            parts.push(local.buffer, nameBytes, data);

            const entry = new DataView(new ArrayBuffer(46));
            entry.setUint32(0, 0x02014b50, true);
            entry.setUint16(4, 20, true);
            entry.setUint16(6, 20, true);
            entry.setUint16(8, 0x0800, true);
            entry.setUint32(16, crc, true);
            entry.setUint32(20, data.length, true);
            entry.setUint32(24, data.length, true);
            entry.setUint16(28, nameBytes.length, true);
            entry.setUint32(42, offset, true);
            central.push(entry.buffer, nameBytes);
            offset += 30 + nameBytes.length + data.length;
        }
        const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, files.length, true);
        end.setUint16(10, files.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
    }

    const newKey = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    // ---------------------------------------------------------------- app

    class App {
        constructor() {
            this.settings = SSQE.Settings.load();
            SSQE.Audio.SoundPlayer.settings = this.settings;
            this.storage = new Storage();
            this.dialogs = new SSQE.Dialogs(this);
            this.music = new SSQE.Audio.MusicPlayer(this.settings);
            this.openMaps = []; // Mapping.Cache: { key, map|null, rec }
            this.mapIndex = 0;
            this.screen = null;
            this.changelog = '';
            this.editor = null;
            this.cacheTimer = null;
            this.autosaveTimer = null;
        }

        async init() {
            SSQE.GUI.setSettings(this.settings);
            await SSQE.GUI.loadFonts();
            await this.storage.open();
            const recs = (await this.storage.getMaps()) || [];
            recs.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
            this.openMaps = recs.map(rec => ({ key: rec.key, map: null, rec }));

            this.applyTheme();
            this.loadChangelog().then(() => this.watchForUpdates());
            this.showMenu();
            this.startAutosaving();
            // the STATS page: a session, and time in the app and in the editor
            if (window.SSQEStats) {
                SSQEStats.session();
                SSQEStats.tick(() => document.body.dataset.screen === 'editor'
                    && !(this.playerFrame && this.playerFrame.style.display !== 'none' && !this.playerFrame.classList.contains('hidden')));
            }

            // the desktop app: what you're doing goes to Discord, and files opened with the app (a .ssqes setup, a
            // .sspm map) are loaded like LOAD MAP
            if (window.ssqeDesktop) {
                setInterval(() => this.updatePresence(), 5000);
                this.updatePresence();
                // new releases: downloaded and installed by the app, with the progress shown here
                this.desktopPaths = { Rhythia: '', Novastra: '' };
                window.ssqeDesktop.playtestPaths().then(p => this.desktopPaths = p).catch(() => { });
                window.ssqeDesktop.onUpdateProgress(text => text ? this.loading(true, text) : this.loading(false));
                // the app is about to close to update: the open map's changes are saved first
                window.ssqeDesktop.onSaveForUpdate(async () => {
                    this.flushCache();
                    SSQE.Settings.save(this.settings);
                    await new Promise(r => setTimeout(r, 300));
                });
                window.ssqeDesktop.checkForUpdates(this.settings.checkUpdates !== false);
                window.ssqeDesktop.onOpenFiles(files => {
                    if (files && files.length)
                        this.loadFiles(files.map(f => new File([f.bytes], f.name)));
                });
            }

            window.addEventListener('beforeunload', e => {
                if (this.cacheTimer) {
                    this.flushCache();
                    e.preventDefault();
                    e.returnValue = '';
                }
            });

            // buttons and checkboxes shouldn't keep keyboard focus, otherwise Space would also "click" them
            document.addEventListener('click', e => {
                const target = e.target.closest('button, input[type=checkbox], input[type=range]');
                if (target && !target.closest('.msg-overlay'))
                    setTimeout(() => target.blur(), 0);
            }, true);
            document.addEventListener('change', e => {
                if (e.target.tagName === 'SELECT' && !e.target.closest('.msg-overlay, .av-window'))
                    e.target.blur();
            }, true);

            window.addEventListener('dragover', e => e.preventDefault());
            window.addEventListener('drop', e => {
                e.preventDefault();
                const files = [...e.dataTransfer.files];
                if (!files.length)
                    return;
                if (this.editor && files.length === 1 && files[0].name.toLowerCase().endsWith('.ini'))
                    this.readIniFile(this.editor.map, files[0]);
                else if (!this.editor)
                    this.loadFiles(files);
            });
        }

        applyTheme() {
            const root = document.documentElement.style;
            for (let i = 1; i <= 5; i++)
                root.setProperty(`--c${i}`, `rgb(${this.settings[`color${i}`].join(',')})`);
        }

        // web only: exporting to Novastra (NPK). The editor fades to black, then the video fades in and loops for
        // good; there's no way back short of closing the tab.
        hitTheRoad() {
            if (this.roadTripped)
                return;
            this.roadTripped = true;

            // made inside the click so browsers (iOS too) let it play with sound later
            const video = el('video', { loop: '', playsinline: '', preload: 'auto' },
                el('source', { src: 'assets/hit_the_road.webm', type: 'video/webm' }),
                el('source', { src: 'assets/hit_the_road.mp4', type: 'video/mp4' }));
            video.play().then(() => video.pause()).catch(() => { });

            const overlay = el('div', { id: 'hit-the-road' });
            Object.assign(overlay.style, {
                position: 'fixed', inset: '0', zIndex: '2147483647', background: '#000', opacity: '0',
                transition: 'opacity 2s ease', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'default', touchAction: 'none',
            });
            Object.assign(video.style, { maxWidth: '100%', maxHeight: '100%', opacity: '0', transition: 'opacity 2.5s ease' });
            overlay.append(video);
            document.body.append(overlay);

            // nothing gets through to the editor any more
            const block = e => {
                e.stopImmediatePropagation();
                if (e.cancelable && !(e.type === 'keydown' && (e.ctrlKey || e.metaKey) && /^[wW]$/.test(e.key)))
                    e.preventDefault();
            };
            for (const type of ['keydown', 'keyup', 'keypress', 'wheel', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'paste', 'copy', 'drop', 'dragover'])
                window.addEventListener(type, block, { capture: true, passive: false });

            requestAnimationFrame(() => requestAnimationFrame(() => overlay.style.opacity = '1'));
            setTimeout(() => {
                if (this.editor) {
                    this.editor.music && this.editor.music.isPlaying && this.editor.pauseMusic && this.editor.pauseMusic();
                    this.editor.suspend && this.editor.suspend();
                }
                if (this.screen && this.screen.stop)
                    this.screen.stop();
                const start = () => {
                    video.currentTime = 0;
                    video.style.opacity = '1';
                    video.play().catch(() => {
                        // sound not allowed here: play muted rather than not at all
                        video.muted = true;
                        video.play().catch(() => { });
                    });
                };
                if (video.readyState >= 2)
                    start();
                else
                    // not loaded (some players can't stream it from the app's files): the whole file, from memory
                    fetch('assets/hit_the_road.webm').then(r => r.blob()).then(blob => {
                        video.src = URL.createObjectURL(blob);
                        video.load();
                        video.addEventListener('canplay', start, { once: true });
                    }).catch(start);
            }, 2000);
        }

        dialogOpen() {
            return this.dialogs.isModalOpen();
        }

        // the menu, create, settings and keybinds windows are canvas screens (screens.js); the editor runs its own loop
        showScreen(name) {
            SSQE.GUI.crossfade(document.getElementById('editor-canvas'));
            if (this.screen) {
                this.screen.stop();
                this.screen = null;
            }
            document.body.dataset.screen = name;
            if (name !== 'editor') {
                this.screen = SSQE.Screens[name](this);
                this.screen.start();
            }
            this.loading(false);
            this.updatePresence();
        }

        // Discord rich presence (desktop app only), like the original editor's
        updatePresence() {
            if (!window.ssqeDesktop)
                return;
            const playing = this.playerFrame && this.playerFrame.style.display !== 'none' && !this.playerFrame.classList.contains('hidden');
            let details = 'In the menu', state = '';
            if (playing)
                details = 'Playing a map';
            else if (this.editor && this.editor.map) {
                const map = this.editor.map;
                details = `Editing a map - ${map.notes.items.length} notes`;
                state = map.fileId || '';
            }
            // web only: mapping together (collab.js)
            const collab = window.SSQECollab && SSQECollab.presenceInfo && SSQECollab.presenceInfo();
            if (collab && !playing) {
                const who = collab.names.length ? `with ${collab.names.join(', ')}` : 'waiting for them to join';
                details = collab.mapping && this.editor && this.editor.map
                    ? `Collaborating - ${this.editor.map.notes.items.length} notes` : 'Starting a collab';
                state = `${who} (${collab.people} of 5)`.slice(0, 120);
            }
            window.ssqeDesktop.setPresence({ details, state });
        }

        // Desktop app: the map and its song go to Rhythia (--a/--t/--sp/--sf, like the original editor)
        // (and Novastra the same way, with its own chart: see desktop/main.js)
        async playtestRhythia(editor, fromStart, game = 'Rhythia') {
            if (editor.music.isPlaying)
                editor.pauseMusic();
            const map = editor.map;
            if (!(this.desktopPaths && this.desktopPaths[game])) {
                this.dialogs.message(`Choose where ${game} is first: SETTINGS > PLAYER > ${game.toUpperCase()} PATH.`);
                return;
            }
            const audio = await this.storage.getAudio(map.soundId);
            if (!audio) {
                this.dialogs.message(`No audio found for ID '${map.soundId}'.`);
                return;
            }
            const bytes = new Uint8Array(await audio.arrayBuffer());
            const audioExt = { 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac', 'audio/mp4': 'm4a' }[sniffAudio(bytes)] || 'mp3';
            SSQE.Settings.save(this.settings);
            const job = {
                game, audio: bytes, audioExt,
                tempo: SSQESettings.tempoFromSlider(map.tempoSlider), startMs: fromStart ? 0 : Math.floor(editor.currentTime),
            };
            if (game === 'Novastra')
                Object.assign(job, { nch: Formats.writeNch(map), nlr: Formats.writeNlr(map), fileId: map.fileId || map.soundId,
                    keys: [editor.keys && editor.keys.ctrl, editor.keys && editor.keys.alt, editor.keys && editor.keys.shift] });
            else
                job.txt = Formats.writeTxt(map);
            const result = await window.ssqeDesktop.playtest(job);
            if (result && result.error)
                editor.toast(result.error, 'warn');
            else
                editor.toast(`STARTED ${game.toUpperCase()}`, 'other');
        }

        // the screen fades and settles in (back from the map player)
        animateIn() {
            SSQE.GUI.crossfade(document.getElementById('editor-canvas'), { snapshot: false });
        }

        // Covers the screen with a 'LOADING...' overlay (or takes it away) and resolves once it's on screen, so a
        // click that takes a moment (opening a map decodes its audio) shows at once instead of looking frozen
        loading(on, text = 'LOADING...') {
            const el = document.getElementById('ssqe-loading');
            if (!el)
                return Promise.resolve();
            el.querySelector('.text').textContent = text;
            el.classList.toggle('on', !!on);
            return on ? new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 90)))) : Promise.resolve();
        }

        // ------------------------------------------------------------ helpers

        download(blob, name) {
            return this.downloadFiles([{ name, blob }]);
        }

        // Saves files for the user. Inside a Claude artifact the frame can't download directly, so the artifact's
        // downloads capability is used; it only accepts some file types, so .ini/.sspm files (and several files at
        // once) are handed over as one .zip there.
        async downloadFiles(files, zipName) {
            const downloads = window.claude && window.claude.use ? await window.claude.use('downloads').catch(() => null) : null;
            if (downloads) {
                const ok = /\.(txt|json|zip|png|md|csv)$/i;
                let name = files[0].name, data = files[0].blob;
                if (files.length > 1 || !ok.test(name)) {
                    name = `${zipName || files[0].name.replace(/\.[^.]*$/, '')}.zip`;
                    data = await zipFiles(files);
                }
                try {
                    await downloads.save({ filename: name, data });
                    return true;
                } catch (e) {
                    if (e && e.code !== 'declined')
                        this.dialogs.message(`The file couldn't be saved here (${e.code || e.message}).`, 'Error');
                    return false;
                }
            }

            for (const { name, blob } of files) {
                const a = el('a', { href: URL.createObjectURL(blob), download: name });
                document.body.append(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 10000);
            }
            return true;
        }

        pickFile(accept, multiple = false) {
            return new Promise(resolve => {
                // iOS only opens the picker for an input that's in the page, and greys out files whose type it can't
                // map from the accept list (.mp3 next to .asset, .sspm, ...), so touch devices get no filter
                if (SSQE.Touch && SSQE.Touch.active)
                    accept = '';
                const input = el('input', { type: 'file', accept, style: { position: 'fixed', left: '-1000px', top: '0', opacity: '0' } });
                if (multiple)
                    input.multiple = true;
                let done = false;
                const finish = value => {
                    if (done)
                        return;
                    done = true;
                    input.remove();
                    resolve(value);
                };
                input.addEventListener('change', () => finish(multiple ? [...input.files] : input.files[0] || null));
                input.addEventListener('cancel', () => finish(multiple ? [] : null));
                document.body.append(input);
                input.click();
            });
        }

        async writeClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
            } catch {
                const ta = el('textarea', { style: { position: 'fixed', opacity: '0' } });
                ta.value = text;
                document.body.append(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
            }
        }

        async readClipboard(label) {
            try {
                const text = await navigator.clipboard.readText();
                if (text)
                    return text;
            } catch { /* fall back to a prompt */ }
            return this.dialogs.prompt('Paste', label, '', true);
        }

        // ------------------------------------------------------------ menu (GuiWindowMenu)

        showMenu() {
            this.showScreen('menu');
        }

        openCreate() {
            this.showScreen('create');
        }

        openSettings() {
            this.showScreen('settings');
        }

        // web only: the map player runs in a frame over the editor, so the editor (and its open maps) stay as they are.
        // Its BACK TO EDITOR button sends 'ssqe-close-player'. Settings, learned data and custom files are shared, as
        // both are on the same site.
        openPlayer() {
            if (!this.playerFrame) {
                const frame = el('iframe', {
                    src: window.SSQE_PLAYER_URL || '../Web%20Player/index.html?embedded=1',
                    allow: 'fullscreen; autoplay',
                    allowfullscreen: '',
                    title: 'Map Player',
                    id: 'ssqe-player-frame',
                    class: 'hidden',
                });
                Object.assign(frame.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', border: '0', zIndex: '50', background: '#000', display: 'none' });
                document.body.append(frame);
                this.playerFrame = frame;
                window.addEventListener('message', e => {
                    if (e.source === frame.contentWindow && e.data === 'ssqe-close-player')
                        this.closePlayer();
                });
            }
            if (this.screen && this.screen.stop)
                this.screen.stop();
            clearTimeout(this.playerHide);
            this.playerFrame.style.display = 'block';
            requestAnimationFrame(() => requestAnimationFrame(() => {
                this.playerFrame.classList.remove('hidden');
                this.updatePresence();
            }));
            this.playerFrame.focus();
        }

        closePlayer() {
            if (!this.playerFrame || this.playerFrame.style.display === 'none' || this.playerFrame.classList.contains('hidden'))
                return;
            this.playerFrame.classList.add('hidden');
            this.playerHide = setTimeout(() => this.playerFrame.style.display = 'none', 230);
            if (document.fullscreenElement)
                document.exitFullscreen().catch(() => { });
            if (this.screen && this.screen.start)
                this.screen.start();
            this.animateIn();
            this.updatePresence();
            // settings may have changed in the player
            this.settings && this.applyTheme();
        }

        openKeybinds() {
            this.showScreen('keybinds');
        }

        // ------------------------------------------------------------ setup files (.ssqes)

        async exportSetup() {
            const answer = await this.dialogs.confirm(
                'Export your setup: the editor and map player settings, keybinds, custom background, grid cursor and note mesh.\n\nAlso include what the auto mapper and the realistic autoplay bot have learned? (The file gets bigger.)',
                [['Yes', 'yes'], ['No', 'no'], ['Cancel', 'cancel']]);
            if (answer !== 'yes' && answer !== 'no')
                return;
            try {
                const blob = await SSQECustom.exportSetup({ learned: answer === 'yes' });
                await this.download(blob, 'my-setup.ssqes');
                window.SSQEStats && SSQEStats.add('setupsShared');
            } catch (e) {
                this.dialogs.message(`Failed to export the setup: ${e.message}`, 'Error');
            }
        }

        async importSetup(file) {
            file = file || await this.pickFile('.ssqes');
            if (!file)
                return;
            const answer = await this.dialogs.confirm(
                `Import the setup in '${file.name}'?\n\nIt replaces your editor and map player settings, keybinds, custom background, grid cursor and note mesh (and what the auto mapper and bot learned, if the file has that). Your maps aren't touched.`,
                [['Import', 'yes'], ['Cancel', 'no']]);
            if (answer !== 'yes')
                return;
            try {
                await this.loading(true, 'IMPORTING SETUP...');
                await SSQECustom.importSetup(file);
                // everything (this editor and the map player) starts again with the new setup
                location.reload();
            } catch (e) {
                this.loading(false);
                this.dialogs.message(`Failed to import the setup: ${e.message}`, 'Error');
            }
        }

        async loadMapDialog() {
            const files = await this.pickFile('.txt,.ini,.sspm,.rhm,.osu,.ssqes,audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus', true);
            if (files.length)
                this.loadFiles(files);
        }

        async pasteMap() {
            const text = await this.readClipboard('Paste map data');
            if (text && text.trim())
                this.loadText(text.trim());
        }

        // Settings.lastFile: the map opened most recently
        lastMapEntry() {
            let key = null;
            try {
                key = localStorage.getItem('ssqe-web-editor-last-map');
            } catch { /* storage unavailable */ }
            return key ? this.openMaps.find(e => e.key === key) || null : null;
        }

        openLastMap() {
            const entry = this.lastMapEntry();
            if (entry)
                this.openEntry(entry);
        }

        openAutosaved() {
            this.openLastMap();
        }

        entryName(entry) {
            return entry.map ? entry.map.fileId : (entry.rec.fileName ? entry.rec.fileName.replace(/\.[^.]*$/, '') : entry.rec.soundId);
        }

        // stands in for the desktop colour picker dialog
        pickColor(current) {
            return new Promise(resolve => {
                const input = el('input', { type: 'color', style: { position: 'fixed', left: '50%', top: '50%', opacity: '0', pointerEvents: 'none' } });
                input.value = '#' + current.slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
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

        async loadChangelog() {
            try {
                const res = await fetch('../changelog');
                if (!res.ok)
                    throw new Error(res.statusText);
                this.changelog = (await res.text()).replace(/\r/g, '');
            } catch {
                this.changelog = 'The changelog is available in the repository (changelog file next to this folder).';
            }
            this.version ??= versionIn(this.changelog);
        }

        // web only, in the browser (the desktop app updates itself, see desktop/main.js): every 10 minutes, whether a
        // newer version has been put online since this page loaded; if so, a popup offers to reload into it (asked
        // once per version: 'Later' leaves it until the next one)
        watchForUpdates() {
            if (window.ssqeDesktop || this.watchingUpdates)
                return;
            this.watchingUpdates = true;
            let offered = null;
            this.checkWebUpdate = async () => {
                if (this.settings.checkUpdates === false || !this.version || this.dialogOpen())
                    return;
                let text;
                try {
                    const res = await fetch(`../changelog?${Date.now()}`, { cache: 'no-store' });
                    if (!res.ok)
                        return;
                    text = (await res.text()).replace(/\r/g, '');
                } catch {
                    return;
                }
                const latest = versionIn(text);
                if (!latest || latest === offered || !newerVersion(latest, this.version))
                    return;
                offered = latest;
                const answer = await this.dialogs.confirm(`Version ${latest} is out (you have ${this.version}).\n\nUpdate now? Your maps are saved first, then the page reloads. What's new is in the changelog.`,
                    [['Update', 'yes'], ['Later', 'no']], 'Info');
                if (answer !== 'yes')
                    return;
                this.flushCache();
                SSQE.Settings.save(this.settings);
                await new Promise(r => setTimeout(r, 500));
                location.reload();
            };
            setInterval(() => this.checkWebUpdate(), 10 * 60 * 1000);
        }

        isSaved(entry) {
            const rec = entry.rec;
            if (entry.map)
                return !!entry.map.savedText && entry.map.savedText === this.mapText(entry.map);
            return !!rec.savedText && rec.savedText === `${rec.txt}\n${rec.ini}`;
        }

        // ------------------------------------------------------------ loading (Mapping.Load / Parse)

        async loadFiles(files) {
            const byExt = ext => files.filter(f => f.name.toLowerCase().endsWith(ext));
            const setup = byExt('.ssqes')[0];
            if (setup)
                return this.importSetup(setup);
            const audioFiles = files.filter(f => !/\.(txt|ini|sspm|osu|rhm)$/i.test(f.name));
            const base = name => name.replace(/\.[^.]*$/, '');

            try {
                // (shows that the map is loading as soon as it's picked: reading a big .sspm takes a moment)
                if (files.some(f => /\.(txt|sspm|osu|rhm)$/i.test(f.name)))
                    await this.loading(true, 'LOADING MAP...');
                const sspm = byExt('.sspm')[0];
                if (sspm) {
                    const map = new Map();
                    const { audio, cover } = Formats.readSspm(map, await sspm.arrayBuffer());
                    if (audio)
                        await this.storage.putAudio(map.soundId, new Blob([audio], { type: sniffAudio(audio) }));
                    if (cover)
                        map.coverBytes = cover;
                    await this.openNewMap(map, null);
                    return;
                }

                const rhm = byExt('.rhm')[0];
                if (rhm) {
                    const map = new Map();
                    const { audio, cover } = await Formats.readRhm(map, await rhm.arrayBuffer(), rhm.name);
                    if (audio)
                        await this.storage.putAudio(map.soundId, new Blob([audio], { type: sniffAudio(audio) }));
                    if (cover)
                        map.coverBytes = cover;
                    await this.openNewMap(map, null);
                    return;
                }

                const osu = byExt('.osu')[0];
                if (osu) {
                    const map = new Map();
                    const audioName = Formats.readOsu(map, await osu.text());
                    const audio = audioFiles.find(f => f.name === audioName) || audioFiles[0];
                    if (audio)
                        await this.storage.putAudio(map.soundId, audio);
                    await this.openNewMap(map, null);
                    return;
                }

                const txt = byExt('.txt')[0];
                if (txt) {
                    const map = new Map();
                    Formats.readTxt(map, await txt.text());
                    const ini = byExt('.ini').find(f => base(f.name) === base(txt.name)) || byExt('.ini')[0];
                    // (the desktop app: where it is, so SAVE writes back to it; and its .ini beside it, as the
                    // original editor reads it, when only the .txt was picked)
                    const filePath = this.desktopFiles && window.ssqeDesktop.pathOf ? window.ssqeDesktop.pathOf(txt) : '';
                    if (ini)
                        Formats.readIni(map, await ini.text());
                    else if (filePath) {
                        const text = await window.ssqeDesktop.readIniFor(filePath).catch(() => null);
                        if (text)
                            Formats.readIni(map, text);
                    }
                    if (audioFiles[0])
                        await this.storage.putAudio(map.soundId, audioFiles[0]);
                    map.fileName = txt.name;
                    if (filePath)
                        map.filePath = filePath;
                    await this.openNewMap(map, null, true);
                    return;
                }

                if (audioFiles[0])
                    this.dialogs.message('To start a new map from an audio file, use CREATE NEW MAP.');
            } catch (e) {
                console.warn(e);
                this.loading(false);
                this.dialogs.message(`Failed to load map data: ${e.message}`);
            } finally {
                this.loading(false);
            }
        }

        async loadText(text) {
            try {
                const map = new Map();
                Formats.readTxt(map, text);
                await this.openNewMap(map, null);
            } catch (e) {
                this.dialogs.message(`Failed to load map data: ${e.message}`);
            }
        }

        async readIniFile(map, file) {
            try {
                Formats.readIni(map, await file.text());
                map.sortAll();
                this.editor && this.editor.toast('IMPORTED INI');
                this.scheduleCacheSave();
            } catch (e) {
                this.dialogs.message(`Failed to read .ini: ${e.message}`);
            }
        }

        // DETECT BPM: the song's tempo between two times (the whole song without them), see automapper.js detectBpm.
        // Resolves to { bpm, offsetMs, steady } or null (and says why)
        async detectBpm(editor, fromMs = 0, toMs = 0) {
            const buffer = editor && editor.music && editor.music.buffer;
            if (!buffer || !window.SSQEAutoMapper) {
                this.dialogs.message('The song is still loading (or couldn\'t be decoded), so its BPM can\'t be detected yet.');
                return null;
            }
            editor.toast('DETECTING THE BPM...', 'other');
            const found = await SSQEAutoMapper.detectBpm(buffer, fromMs, toMs, text => editor.toast(text, 'other')).catch(err => {
                console.warn(err);
                return null;
            });
            if (!found) {
                editor.toast('NO CLEAR BEAT FOUND', 'other');
                this.dialogs.message(toMs > fromMs && toMs - fromMs < 15000
                    ? 'Pick at least 15 seconds of the song to detect its BPM from.'
                    : 'No clear beat could be found in this part of the song. Try a part with drums, or tap it with the BPM Tapper.');
                return null;
            }
            editor.toast(`DETECTED ${found.bpm} BPM - OFFSET ${found.offsetMs}MS${found.steady ? '' : ' (THE TEMPO DRIFTS)'}`, 'other');
            return found;
        }

        // DETECT BPM in the Timing tab: the whole song's, as the map's timing point (asks first if it has some)
        async detectBpmToMap(editor) {
            const map = editor.map;
            const found = await this.detectBpm(editor);
            if (!found)
                return;
            if (map.timingPoints.length) {
                const answer = await this.dialogs.confirm(`Detected ${found.bpm} BPM (first downbeat at ${found.offsetMs} ms)${found.steady ? '' : ', though the tempo drifts in places'}.\n\nReplace the map's ${map.timingPoints.length} timing point${map.timingPoints.length === 1 ? '' : 's'} with it?`);
                if (answer !== 'yes')
                    return;
            }
            map.replacePoints('DETECT BPM', map.timingPoints.slice(), [new SSQE.TimingPoint(found.bpm, found.offsetMs)]);
            editor.toast(`SET BPM TO ${found.bpm} AT ${found.offsetMs}MS`, 'other');
        }

        async importIni(map) {
            const file = await this.pickFile('.ini');
            if (file)
                this.readIniFile(map, file);
        }

        // adds a freshly parsed map to the open map list and opens it
        async openNewMap(map, key, savedAsLoaded = false) {
            // web only: every imported map teaches the auto mapper
            if (window.SSQEAutoMapper)
                SSQEAutoMapper.learn(map.notes.items.map(n => ({ x: n.x, y: n.y, ms: n.ms })))
                    .then(learned => learned && this.editor && this.editor.toast('AUTO MAPPER LEARNED FROM THIS MAP', 'other'))
                    .catch(() => { });
            const entry = { key: key || newKey(), map, rec: null };
            if (savedAsLoaded)
                map.savedText = this.mapText(map);
            this.openMaps.push(entry);
            map.key = entry.key;
            await this.persistEntry(entry);
            await this.openEntry(entry);
        }

        mapText(map) {
            return `${Formats.writeTxt(map)}\n${Formats.writeIni(map)}`;
        }

        async materialize(entry) {
            if (entry.map)
                return entry.map;
            const rec = entry.rec;
            const map = new Map();
            Formats.readTxt(map, rec.txt);
            Formats.readIni(map, rec.ini);
            map.key = entry.key;
            map.fileName = rec.fileName || null;
            map.filePath = rec.filePath || null;
            map.savedText = rec.savedText || null;
            if (rec.props)
                Object.assign(map.props, rec.props);
            if (rec.view) {
                map.tempoSlider = rec.view.tempoSlider ?? map.tempoSlider;
                map.zoom = rec.view.zoom ?? map.zoom;
            }
            if (rec.cover)
                map.coverBytes = rec.cover;
            if (rec.auto && rec.auto.length) {
                const auto = new Set(rec.auto);
                for (const n of map.notes.items)
                    n.auto = auto.has(autoKey(n));
            }
            // (who placed which notes in a collab, and everyone's colour on this map: see collab.js)
            if (rec.authors && rec.authors.length)
                map.authors = new globalThis.Map(rec.authors);
            if (rec.by && rec.by.length) {
                const by = new globalThis.Map(rec.by);
                for (const n of map.notes.items) {
                    const id = by.get(autoKey(n));
                    if (id)
                        n.by = id;
                }
            }
            try {
                map.dirHandle = await this.storage.getHandle(entry.key) || null;
            } catch {
                map.dirHandle = null;
            }
            entry.map = map;
            return map;
        }

        // Mapping.Open
        async openEntry(entry) {
            let map;
            try {
                map = await this.materialize(entry);
            } catch (e) {
                this.dialogs.message(`Failed to load map data: ${e.message}`);
                return;
            }

            let audio = await this.storage.getAudio(map.soundId);
            if (audio)
                await this.loading(true, 'LOADING MAP...');
            else
                this.loading(false);
            if (!audio) {
                const answer = await this.dialogs.confirm(`No audio found for ID '${map.soundId}'.\n\nWould you like to import an audio file for this ID?`, [['OK', 'yes'], ['Cancel', 'no']]);
                if (answer !== 'yes')
                    return;
                audio = await this.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
                if (!audio)
                    return;
                await this.storage.putAudio(map.soundId, audio);
            }

            try {
                await this.loading(true, 'LOADING MAP...');
                await SSQE.Audio.loadSounds();
                await this.music.load(audio);
            } catch (e) {
                this.loading(false);
                const answer = await this.dialogs.confirm(`Failed to load audio with ID '${map.soundId}':\n\n${e.message}\n\nWould you like to import a new file?`, [['OK', 'yes'], ['Cancel', 'no']]);
                if (answer === 'yes') {
                    const file = await this.pickFile('audio/*');
                    if (file) {
                        await this.storage.putAudio(map.soundId, file);
                        return this.openEntry(entry);
                    }
                }
                return;
            }

            map.duration = this.music.duration * 1000;
            map.currentTime = Math.min(map.currentTime, map.duration);
            window.SSQEStats && SSQEStats.add('mapsOpened');
            map.sortAll();

            try {
                localStorage.setItem('ssqe-web-editor-last-map', entry.key);
            } catch { /* storage unavailable */ }
            this.showScreen('editor');
            this.editor = new SSQE.Editor(this, map, this.music);
            this.editor.start();
        }

        backToMenu() {
            if (this.editor) {
                this.flushCache();
                this.editor.stop();
                this.editor = null;
                this.music.stop();
            }
            this.dialogs.closeAll();
            this.showMenu();
        }

        // Mapping.Close
        async closeEntry(entry) {
            if (!this.isSaved(entry)) {
                const map = await this.materialize(entry);
                const answer = await this.dialogs.confirm(`${map.fileId} (${map.soundId})\n\nWould you like to save before closing?`, [['Yes', 'yes'], ['No', 'no'], ['Cancel', 'cancel']]);
                if (answer === 'cancel' || answer === null)
                    return;
                if (answer === 'yes' && !await this.save(map))
                    return;
            }

            this.openMaps = this.openMaps.filter(e => e !== entry);
            await this.storage.deleteMap(entry.key);
            await this.storage.deleteHandle(entry.key).catch(() => { });
        }

        // ------------------------------------------------------------ cache / autosave

        async persistEntry(entry) {
            const map = entry.map;
            if (!map)
                return;
            const rec = {
                key: entry.key,
                order: this.openMaps.indexOf(entry),
                soundId: map.soundId,
                fileName: map.fileName,
                filePath: map.filePath || null,
                txt: Formats.writeTxt(map),
                ini: Formats.writeIni(map),
                savedText: map.savedText,
                props: map.props,
                view: { tempoSlider: map.tempoSlider, zoom: map.zoom },
                cover: map.coverBytes || null,
                // (which notes the auto mapper placed: see afterSave)
                auto: map.notes.items.filter(n => n.auto).map(autoKey),
                // (who placed which notes in a collab, and each person's name and colour on this map)
                by: map.notes.items.filter(n => n.by).map(n => [autoKey(n), n.by]),
                authors: map.authors ? [...map.authors] : [],
                updated: Date.now(),
            };
            entry.rec = rec;
            try {
                await this.storage.putMap(rec);
            } catch (e) {
                console.warn('Failed to cache map', e);
            }
        }

        scheduleCacheSave() {
            clearTimeout(this.cacheTimer);
            this.cacheTimer = setTimeout(() => this.flushCache(), 1000);
        }

        flushCache() {
            clearTimeout(this.cacheTimer);
            this.cacheTimer = null;
            const entry = this.editor && this.openMaps.find(e => e.map === this.editor.map);
            if (entry)
                this.persistEntry(entry);
        }

        // Mapping.StartAutosaving - writes to the map's files when it was saved to a folder before
        startAutosaving() {
            clearInterval(this.autosaveTimer);
            const tick = async () => {
                if (!this.settings.enableAutosave || !this.editor)
                    return;
                const map = this.editor.map;
                if (map.notes.length + map.bookmarks.length + map.timingPoints.length === 0 || this.isSaved({ map }))
                    return;

                // the open map is always cached in the browser; maps saved to a folder are also written to their files
                this.flushCache();
                if (this.desktopFiles && map.filePath) {
                    if (await this.writeDesktop(map))
                        map.savedText = this.mapText(map);
                } else if (map.dirHandle && map.fileName)
                    await this.writeToFolder(map, map.dirHandle, map.fileName.replace(/\.txt$/i, ''), false);
                this.editor && this.editor.toast('AUTOSAVED');
            };
            this.autosaveTimer = setInterval(tick, Math.max(0.5, this.settings.autosaveInterval) * 60000);
        }

        // ------------------------------------------------------------ saving (Mapping.Save / SaveAs)

        async writeToFolder(map, dir, name, interactive) {
            try {
                if (dir.queryPermission && await dir.queryPermission({ mode: 'readwrite' }) !== 'granted') {
                    if (!interactive || await dir.requestPermission({ mode: 'readwrite' }) !== 'granted')
                        return false;
                }
                const write = async (fileName, text) => {
                    const handle = await dir.getFileHandle(fileName, { create: true });
                    const w = await handle.createWritable();
                    await w.write(text);
                    await w.close();
                };
                await write(`${name}.txt`, Formats.writeTxt(map));
                await write(`${name}.ini`, Formats.writeIni(map));
                map.fileName = `${name}.txt`;
                map.savedText = this.mapText(map);
                return true;
            } catch (e) {
                console.warn('Failed to save', e);
                return false;
            }
        }

        // web only, the desktop app: like the original editor, a map has a .txt on the computer (map.filePath, its .ini
        // beside it): SAVE writes there straight away, SAVE AS asks where with the usual save window
        get desktopFiles() {
            return !!(window.ssqeDesktop && window.ssqeDesktop.saveMapAs);
        }

        async writeDesktop(map) {
            try {
                return !!await window.ssqeDesktop.saveMapTo(map.filePath, Formats.writeTxt(map), Formats.writeIni(map));
            } catch (e) {
                console.warn('Failed to save', e);
                return false;
            }
        }

        async save(map) {
            if (this.desktopFiles) {
                if (!map.filePath)
                    return this.saveAs(map);
                const ok = await this.writeDesktop(map);
                if (ok)
                    map.savedText = this.mapText(map);
                this.afterSave(map, ok);
                return ok;
            }
            if (map.dirHandle && map.fileName) {
                const ok = await this.writeToFolder(map, map.dirHandle, map.fileName.replace(/\.txt$/i, ''), true);
                this.afterSave(map, ok);
                return ok;
            }
            return this.saveAs(map);
        }

        async saveAs(map) {
            if (this.desktopFiles) {
                let file = null;
                try {
                    file = await window.ssqeDesktop.saveMapAs(map.fileId, Formats.writeTxt(map), Formats.writeIni(map));
                } catch (e) {
                    console.warn('Failed to save', e);
                    this.afterSave(map, false);
                    return false;
                }
                if (!file)
                    return false;
                map.filePath = file;
                map.fileName = file.split(/[\\/]/).pop();
                map.dirHandle = null;
                map.savedText = this.mapText(map);
                this.afterSave(map, true);
                return true;
            }
            // folder access isn't allowed inside frames (like a Claude artifact)
            const canUseFolders = !!window.showDirectoryPicker && window.self === window.top;
            const result = await this.dialogs.saveAs(map, canUseFolders);
            if (!result)
                return false;

            const name = (result.name || map.fileId).replace(/\.(txt|ini)$/i, '').replace(/[\\/:*?"<>|]/g, '_');
            let ok = false;

            if (result.mode === 'folder') {
                try {
                    const dir = await window.showDirectoryPicker({ id: 'ssqe-maps', mode: 'readwrite' });
                    ok = await this.writeToFolder(map, dir, name, true);
                    if (ok) {
                        map.dirHandle = dir;
                        this.storage.putHandle(map.key, dir).catch(() => { });
                    }
                } catch (e) {
                    if (e.name !== 'AbortError')
                        console.warn(e);
                    return false;
                }
            } else {
                ok = await this.downloadFiles([
                    { name: `${name}.txt`, blob: new Blob([Formats.writeTxt(map)], { type: 'text/plain' }) },
                    { name: `${name}.ini`, blob: new Blob([Formats.writeIni(map)], { type: 'text/plain' }) },
                ], name);
                if (ok) {
                    map.fileName = `${name}.txt`;
                    map.dirHandle = null;
                    map.savedText = this.mapText(map);
                }
            }

            this.afterSave(map, ok);
            return ok;
        }

        afterSave(map, ok) {
            if (this.editor && this.editor.map === map)
                this.editor.toast(ok ? 'SAVED' : 'FAILED TO SAVE', ok ? 'info' : 'warn');
            // web only: a map you've made teaches the auto mapper too, each time it's saved (its latest version, not
            // every one), but only the notes placed by hand: never what the auto mapper put there itself
            const own = map.notes.items.filter(n => !n.auto);
            if (ok && window.SSQEAutoMapper && own.length >= 20)
                SSQEAutoMapper.learn(own.map(n => ({ x: n.x, y: n.y, ms: n.ms })), map.fileId || '', { source: map.key })
                    .then(learned => learned && this.editor && this.editor.map === map && this.editor.toast('SAVED - AUTO MAPPER LEARNED FROM IT', 'info'))
                    .catch(() => { });
            const entry = this.openMaps.find(e => e.map === map);
            if (entry)
                this.persistEntry(entry);
        }

        // GuiWindowEditor CopyButton
        async copyMapData(map) {
            try {
                await this.writeClipboard(Formats.writeTxt(map, this.settings.correctOnCopy));
                this.editor && this.editor.toast('COPIED TO CLIPBOARD');
            } catch {
                this.editor && this.editor.toast('FAILED TO COPY', 'warn');
            }
        }

        // GuiWindowEditor ReplaceID
        async replaceAudioId(map, id) {
            id = (id || '').trim();
            if (!id)
                return;
            if (await this.dialogs.confirm('Are you sure you want to replace this ID?\nIf an asset exists with this ID, it will be overwritten.') !== 'yes')
                return;
            const audio = await this.storage.getAudio(map.soundId);
            if (audio)
                await this.storage.putAudio(id, audio);
            map.soundId = id;
            this.editor && this.editor.onMapChanged();
            this.editor && this.editor.toast(`REPLACED AUDIO ID WITH ${id}`);
        }

        // Copy and paste between maps: what's copied is the app's, not one map's (each map you open gets an editor of
        // its own, so copied notes used to go with the map they came from). Notes are also kept in the browser's
        // storage, so they paste into a map in another window or tab, or after the editor was closed and opened again.
        copyObjects(objects) {
            const time = Date.now();
            this.clipboard = { items: objects.map(o => o.clone()), time };
            if (objects.length && objects.every(o => o instanceof SSQE.Note))
                try {
                    localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ time, notes: objects.map(n => [n.x, n.y, n.ms, n.enableEasing ? 1 : 0, n.style | 0, n.direction | 0]) }));
                } catch { /* full or blocked: this window still has them */ }
        }

        // copies of what was copied last (whichever was later: here, or notes copied in another window)
        copiedObjects() {
            let stored = null;
            try {
                stored = JSON.parse(localStorage.getItem(CLIPBOARD_KEY) || 'null');
            } catch { /* nothing there */ }
            const mine = this.clipboard;
            if (stored && Array.isArray(stored.notes) && (!mine || stored.time > mine.time))
                return stored.notes.filter(n => Array.isArray(n) && n.length >= 3 && n.slice(0, 3).every(Number.isFinite))
                    .map(([x, y, ms, e, st, d]) => new SSQE.Note(x, y, ms, !!e, st || 0, d || 0));
            return mine ? mine.items.map(o => o.clone()) : [];
        }

        // OPEN EDITOR FOLDER: in the desktop app, the folder maps are saved in (see desktop/main.js); a browser has none
        async openEditorFolder() {
            if (window.ssqeDesktop && window.ssqeDesktop.openFolder) {
                const r = await window.ssqeDesktop.openFolder().catch(e => ({ error: e.message }));
                if (r && r.error)
                    this.dialogs.message(`The editor folder couldn't be opened: ${r.error}`);
                return;
            }
            this.dialogs.message('The web editor keeps its maps and audio in your browser, so there is no editor folder to open. (The desktop app opens the folder your maps are saved in.)');
        }

        // CONVERT TO MP3 (MusicPlayer.ConvertToMP3): the map's song encoded as an MP3 (192 kbps, with LAME: vendor/
        // lame.min.js, loaded the first time it's needed), replacing the audio the map keeps
        async convertToMp3(editor) {
            const map = editor.map;
            const stored = await this.storage.getAudio(map.soundId);
            const buffer = editor.music && editor.music.buffer;
            if (!stored || !buffer) {
                this.dialogs.message('The song is still loading (or couldn\'t be decoded), so it can\'t be converted yet.');
                return;
            }
            const head = new Uint8Array(await stored.slice(0, 4).arrayBuffer());
            const isMp3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
            const ask = isMp3 ? 'This audio is already an MP3 file! Do you want to convert it anyway?\nThis will take a while!'
                : 'Are you sure you want to convert this audio to MP3?\nThis will take a while!';
            if (await this.dialogs.confirm(ask, [['Yes', 'yes'], ['No', 'no']], 'Info') !== 'yes')
                return;
            if (editor.music.isPlaying)
                editor.pauseMusic();
            try {
                if (!window.lamejs)
                    await new Promise((resolve, reject) => {
                        const tag = document.createElement('script');
                        tag.src = 'js/vendor/lame.min.js';
                        tag.onload = resolve;
                        tag.onerror = () => reject(new Error('The MP3 encoder could not be loaded.'));
                        document.head.append(tag);
                    });
                // (LAME takes 32, 44.1 or 48 kHz at most: anything else is resampled to 44.1)
                let src = buffer;
                if (![32000, 44100, 48000].includes(src.sampleRate)) {
                    const ctx = new OfflineAudioContext(Math.min(2, src.numberOfChannels), Math.ceil(src.duration * 44100), 44100);
                    const node = ctx.createBufferSource();
                    node.buffer = src;
                    node.connect(ctx.destination);
                    node.start();
                    src = await ctx.startRendering();
                }
                const channels = Math.min(2, src.numberOfChannels);
                const encoder = new lamejs.Mp3Encoder(channels, src.sampleRate, 192);
                const toInt = data => {
                    const out = new Int16Array(data.length);
                    for (let i = 0; i < data.length; i++)
                        out[i] = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767)));
                    return out;
                };
                const left = toInt(src.getChannelData(0)), right = channels > 1 ? toInt(src.getChannelData(1)) : null;
                const parts = [];
                const STEP = 1152 * 40;
                let last = performance.now();
                for (let i = 0; i < left.length; i += STEP) {
                    const l = left.subarray(i, i + STEP);
                    const chunk = right ? encoder.encodeBuffer(l, right.subarray(i, i + STEP)) : encoder.encodeBuffer(l);
                    if (chunk.length)
                        parts.push(new Uint8Array(chunk));
                    // (a moment for the page every so often, with how far it's got)
                    if (performance.now() - last > 40) {
                        editor.toast(`CONVERTING TO MP3 ${Math.floor(i / left.length * 100)}%`, 'other');
                        await new Promise(r => setTimeout(r));
                        last = performance.now();
                    }
                }
                const end = encoder.flush();
                if (end.length)
                    parts.push(new Uint8Array(end));
                const blob = new Blob(parts, { type: 'audio/mpeg' });
                await this.storage.putAudio(map.soundId, blob);
                await this.music.load(blob);
                map.duration = this.music.duration * 1000;
                this.music.setTempo(map.tempo);
                editor.toast('SUCCESSFULLY CONVERTED', 'other');
            } catch (e) {
                console.warn(e);
                editor.toast('FAILED TO CONVERT', 'other');
                this.dialogs.message(`Converting to MP3 failed: ${e.message}`, 'Error');
            }
        }

        async changeAudio(editor) {
            const file = await this.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
            if (!file)
                return;
            await this.storage.putAudio(editor.map.soundId, file);
            if (editor.music.isPlaying)
                editor.pauseMusic();
            try {
                await this.music.load(file);
                editor.map.duration = this.music.duration * 1000;
                this.music.setTempo(editor.map.tempo);
                editor.toast('AUDIO REPLACED');
            } catch (e) {
                this.dialogs.message(e.message);
            }
        }

        // ------------------------------------------------------------ playtest (GuiWindowEditor.Playtest + the web player)

        async playtest(editor, fromStart, autoplay) {
            window.SSQEStats && SSQEStats.add('playtests');
            // the desktop app plays in Rhythia, like the original editor, when that's the playtest game
            const game = this.settings.playtestGame || 'SSQE Player';
            if (window.ssqeDesktop && game === 'Rhythia')
                return this.playtestRhythia(editor, fromStart);
            if (window.ssqeDesktop && game === 'Novastra')
                return this.playtestRhythia(editor, fromStart, 'Novastra');
            if (!window.SSQEGame) {
                this.dialogs.message('The web player could not be loaded. Make sure the "Web Player" folder sits next to the "Web Editor" folder.');
                return;
            }
            if (editor.music.isPlaying)
                editor.pauseMusic();

            const map = editor.map;
            const s = this.settings;
            const ps = SSQESettings.load();
            Object.assign(ps, {
                tempo: map.tempoSlider,
                masterVolume: s.masterVolume,
                sfxVolume: s.sfxVolume,
                musicOffset: s.musicOffset,
                noteColors: s.noteColors,
                color1: s.color1,
                color2: s.color2,
                smoothAutoplay: s.smoothAutoplay,
                monoAudio: s.monoAudio,
                muteSfx: s.muteSfx,
                maxPolyphony: s.maxPolyphony,
            });

            // the decoded song plays exactly and needs no <audio> element (which iOS won't load or start without a
            // tap); the element is only needed to keep the pitch at other tempos
            const audioBuffer = editor.music.buffer;
            const needElement = !audioBuffer || Math.abs(SSQESettings.tempoFromSlider(map.tempoSlider) - 1) > 1e-6;
            const blob = needElement ? await this.storage.getAudio(map.soundId) : null;
            const audioElement = blob ? await SSQEGame.loadAudio(blob).catch(() => null) : null;

            if (ps.fullscreenPlayer && !document.fullscreenElement)
                document.documentElement.requestFullscreen().catch(() => { });

            editor.suspend();
            document.body.classList.add('playtesting');

            const finish = () => {
                document.body.classList.remove('playtesting');
                if (document.fullscreenElement)
                    document.exitFullscreen().catch(() => { });
                editor.resume();
            };

            try {
                SSQE.GUI.fadeIn(document.getElementById('game'), document.getElementById('overlay'));
                const game = new SSQEGame.Game({
                    canvas: document.getElementById('game'),
                    overlay: document.getElementById('overlay'),
                    settings: ps,
                    mapText: Formats.writeTxt(map),
                    audioElement,
                    audioBuffer,
                    audioCtx: SSQE.Audio.audioContext(),
                    hitBuffer: null,
                    replayBuffer: null,
                    mode: autoplay ? 'autoplay' : 'play',
                    fromStart,
                    startTime: editor.currentTime,
                    onExit: finish,
                });
                game.sound.buffer = await this.hitBuffer();
                game.start();
                if (!autoplay)
                    game.lockPointer();
            } catch (e) {
                finish();
                this.dialogs.message(`Failed to start the player: ${e.message}`);
            }
        }

        async hitBuffer() {
            await SSQE.Audio.loadSounds();
            const ac = SSQE.Audio.audioContext();
            try {
                const res = await fetch(window.SSQE_SOUNDS.hit);
                return await ac.decodeAudioData(await res.arrayBuffer());
            } catch {
                return null;
            }
        }
    }

    SSQE.App = App;
    SSQE.zipFiles = zipFiles;

    window.addEventListener('DOMContentLoaded', () => {
        const app = new App();
        window.ssqeApp = app;
        // web only: accounts and spectating (online.js)
        window.SSQEOnline && SSQEOnline.attach(app);
        window.SSQECollab && SSQECollab.attach(app);
        app.init();
    });
})();
