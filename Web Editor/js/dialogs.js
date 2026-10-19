'use strict';

// Port of NewGUI/Forms (TimingsWindow, BookmarksWindow, ExportSSPM, BPMTapper - Avalonia windows, laid out from their
// .axaml files) and NewGUI/Dialogs/MessageDialog (the in-editor message box from GuiWindowDialog)
(function () {
    const { TimingPoint, Bookmark, Timing, DIFFICULTIES } = SSQE;
    const el = (...a) => SSQE.el(...a);

    // absolutely positioned element inside an Avalonia panel
    const at = (node, x, y, w, h) => {
        Object.assign(node.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
        return node;
    };
    const aButton = (text, onClick, x, y, w, h) => at(el('button', { class: 'av-button', type: 'button', onclick: onClick }, text), x, y, w, h);
    const aLabel = (text, x, y, w, h, cls = '') => at(el('div', { class: `av-label ${cls}` }, text), x, y, w, h);
    const aBox = (x, y, w, h, value = '', cls = '') => {
        const box = at(el('input', { type: 'text', class: `av-textbox ${cls}`, spellcheck: 'false' }), x, y, w, h);
        box.value = value;
        return box;
    };
    const aCheck = (text, checked, x, y, w, h) => {
        const input = el('input', { type: 'checkbox' });
        input.checked = checked;
        const label = at(el('label', { class: 'av-check' }, input, el('span', { class: 'av-check-box' }), el('span', {}, text)), x, y, w, h);
        return { label, input };
    };

    // DataGrid with RowHeight 20, GridLinesVisibility All and RowBackground WhiteSmoke
    class DataGrid {
        constructor(columns, x, y, w, h) {
            this.columns = columns;
            this.rows = [];
            this.selected = new Set();
            this.anchor = -1;
            this.onSelect = null;
            this.onActivate = null;
            this.body = el('div', { class: 'av-grid-body' });
            this.node = at(el('div', { class: 'av-grid', tabindex: '0' },
                el('div', { class: 'av-grid-head' }, columns.map(([name, width]) => el('div', { style: { width: width + 'px' } }, name))),
                this.body), x, y, w, h);
            this.node.addEventListener('keydown', e => {
                if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    this.rows.forEach((_, i) => this.selected.add(i));
                    this.render();
                    this.onSelect && this.onSelect();
                }
            });
        }

        setRows(rows, keep) {
            this.rows = rows;
            this.selected = new Set([...this.selected].filter(i => i < rows.length && (!keep || keep(rows[i].item))));
            this.render();
        }

        selectedItems() {
            return [...this.selected].sort((a, b) => a - b).map(i => this.rows[i].item);
        }

        select(index) {
            this.selected = new Set(index >= 0 ? [index] : []);
            this.anchor = index;
            this.render();
        }

        render() {
            this.body.innerHTML = '';
            this.rows.forEach((row, i) => {
                const r = el('div', { class: 'av-grid-row' + (this.selected.has(i) ? ' selected' : '') },
                    row.cells.map((c, k) => el('div', { style: { width: this.columns[k][1] + 'px' } }, String(c))));
                r.addEventListener('mousedown', e => {
                    if (e.shiftKey && this.anchor >= 0) {
                        this.selected = new Set();
                        for (let k = Math.min(this.anchor, i); k <= Math.max(this.anchor, i); k++)
                            this.selected.add(k);
                    } else if (e.ctrlKey || e.metaKey) {
                        this.selected.has(i) ? this.selected.delete(i) : this.selected.add(i);
                        this.anchor = i;
                    } else {
                        this.selected = new Set([i]);
                        this.anchor = i;
                    }
                    this.render();
                    this.onSelect && this.onSelect();
                });
                r.addEventListener('dblclick', () => this.onActivate && this.onActivate(row.item));
                this.body.append(r);
            });
        }
    }

    class Dialogs {
        constructor(app) {
            this.app = app;
            this.layer = document.getElementById('dialog-layer');
            this.modals = 0;
            this.windows = {};
        }

        isModalOpen() {
            return this.modals > 0;
        }

        // ------------------------------------------------------------ MessageDialog (GuiWindowDialog, 450x160 at 735,460)

        modal(body, buttons, opts = {}) {
            return new Promise(resolve => {
                const overlay = el('div', { class: 'msg-overlay' });
                const close = value => {
                    overlay.remove();
                    this.modals--;
                    document.removeEventListener('keydown', onKey, true);
                    window.removeEventListener('resize', place);
                    resolve(value);
                };
                const onKey = e => {
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        close(opts.cancelValue ?? null);
                    } else if (e.key === 'Enter' && opts.enterValue !== undefined && e.target.tagName !== 'TEXTAREA') {
                        e.stopPropagation();
                        close(typeof opts.enterValue === 'function' ? opts.enterValue() : opts.enterValue);
                    }
                };

                const offset = 3 - buttons.length;
                const box = el('div', { class: 'msg-box' + (opts.tall ? ' tall' : '') },
                    el('div', { class: 'msg-drag' }),
                    el('button', { class: 'msg-close', type: 'button', onclick: () => close(opts.cancelValue ?? null) }),
                    el('div', { class: 'msg-inner' },
                        el('div', { class: 'msg-icon', style: { backgroundImage: `url(assets/${opts.icon || 'Info'}.png)` } }),
                        el('div', { class: 'msg-text' }, body),
                        buttons.map(([text, value], i) => el('button', {
                            class: 'msg-button', type: 'button', style: { left: (198 + 85 * (i + offset)) + 'px', fontSize: text.length > 6 ? '15px' : '' },
                            onclick: () => close(typeof value === 'function' ? value() : value),
                        }, text))),
                );

                // drag strip
                let dx = 0, dy = 0;
                box.firstChild.addEventListener('pointerdown', e => {
                    const sx = e.clientX - dx, sy = e.clientY - dy;
                    const move = ev => {
                        dx = ev.clientX - sx;
                        dy = ev.clientY - sy;
                        place();
                    };
                    const up = () => {
                        window.removeEventListener('pointermove', move);
                        window.removeEventListener('pointerup', up);
                    };
                    window.addEventListener('pointermove', move);
                    window.addEventListener('pointerup', up);
                });

                // stretched with the window like every other GUI control (1920x1080 origin)
                const place = () => {
                    const W = window.innerWidth, H = window.innerHeight;
                    let sx = W / 1920, sy = H / 1080, x = 734 * sx, y = 427 * sy;
                    // web only: on small screens the stretched box would be unreadable, so fit it instead
                    if (Math.min(sx, sy) < 0.6) {
                        const bh = box.offsetHeight || 194;
                        sx = sy = Math.min(1, (W - 16) / 452, (H - 16) / bh);
                        x = (W - 452 * sx) / 2;
                        y = (H - bh * sy) / 2;
                    }
                    box.style.transform = `translate(${x + dx}px, ${y + dy}px) scale(${sx}, ${sy})`;
                };
                window.addEventListener('resize', place);

                overlay.append(box);
                this.layer.append(overlay);
                place();
                this.modals++;
                document.addEventListener('keydown', onKey, true);

                const focus = box.querySelector('input, textarea') || box.querySelector('.msg-button');
                setTimeout(() => focus && focus.focus(), 0);
            });
        }

        message(text, icon = 'Info') {
            return this.modal(text, [['OK', true]], { enterValue: true, icon });
        }

        confirm(text, buttons = [['Yes', 'yes'], ['No', 'no']], icon = 'Warning') {
            return this.modal(text, buttons, { cancelValue: 'cancel', icon });
        }

        prompt(title, label, value = '', multiline = false) {
            const input = multiline ? el('textarea', { class: 'msg-input multiline', spellcheck: 'false' }) : el('input', { type: 'text', class: 'msg-input', spellcheck: 'false' });
            input.value = value;
            return this.modal(el('div', { class: 'msg-form' }, el('div', {}, label), input),
                [['OK', () => input.value], ['Cancel', null]], { enterValue: multiline ? undefined : () => input.value, tall: multiline });
        }

        // ------------------------------------------------------------ Avalonia windows (non-modal)

        floating(id, title, width, height, controls, onClose) {
            this.windows[id]?.close();

            const panel = el('div', { class: 'av-panel', style: { width: width + 'px', height: height + 'px' } }, controls);
            const win = el('div', { class: 'av-window' },
                el('div', { class: 'av-title' }, el('span', {}, title), el('button', { class: 'av-x', type: 'button', title: 'Close', onclick: () => close() })),
                panel);

            const close = () => {
                win.remove();
                delete this.windows[id];
                onClose && onClose();
            };

            // WindowStartupLocation="CenterScreen"; web only: shrunk to fit on screens smaller than the window
            const scale = Math.min(1, (window.innerWidth - 8) / (width + 2), (window.innerHeight - 8) / (height + 32));
            if (scale < 1)
                win.style.transform = `scale(${scale})`;
            win.style.left = Math.max(0, (window.innerWidth - (width + 2) * scale) / 2) + 'px';
            win.style.top = Math.max(0, (window.innerHeight - (height + 32) * scale) / 2) + 'px';

            const titleBar = win.firstChild;
            titleBar.addEventListener('pointerdown', e => {
                if (e.target.tagName === 'BUTTON')
                    return;
                const rect = win.getBoundingClientRect();
                const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
                const move = ev => {
                    win.style.left = Math.max(0, ev.clientX - dx) + 'px';
                    win.style.top = Math.max(0, ev.clientY - dy) + 'px';
                };
                const up = () => {
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            });
            win.addEventListener('pointerdown', () => this.layer.lastChild !== win && this.layer.append(win));
            // these are separate windows in the desktop editor, so their keys never reach the editor
            win.addEventListener('keydown', e => e.stopPropagation());

            this.layer.append(win);
            this.windows[id] = { close, win };
            return this.windows[id];
        }

        // web only (collab.js): an invite to map together, in the bottom right corner rather than in the middle of
        // the screen, so it doesn't get in the way; it answers no by itself after 30 seconds
        invitePopup(id, text, onAnswer) {
            const W = 320, H = 120;
            let answered = false;
            const answer = yes => {
                if (answered)
                    return;
                answered = true;
                clearTimeout(timer);
                w.close();
                onAnswer(yes);
            };
            const w = this.floating(`invite-${id}`, 'Map together?', W, H, [
                aLabel(text, 12, 10, W - 24, 56),
                aButton('Accept', () => answer(true), 12, 78, 140, 30),
                aButton('Decline', () => answer(false), W - 152, 78, 140, 30),
            ], () => answer(false));
            w.win.style.transform = '';
            w.win.style.left = Math.max(0, window.innerWidth - W - 18) + 'px';
            w.win.style.top = Math.max(0, window.innerHeight - H - 50) + 'px';
            const timer = setTimeout(() => answer(false), 30000);
            return w;
        }

        // web only (collab.js): the people online, to invite into the map you're mapping together
        collabInvite(list, inviteState, invite, full) {
            const W = 360, rows = Math.max(1, Math.min(10, list.length));
            const controls = [];
            if (!list.length)
                controls.push(aLabel('Nobody else is online right now.', 16, 16, W - 32, 26));
            list.slice(0, 10).forEach((u, i) => {
                const y = 14 + i * 36;
                controls.push(aLabel(`${u.name}${u.noInvites ? ' (no invites)' : u.busy ? ' (busy)' : ''}`, 16, y + 4, 200, 26));
                const st = inviteState(u.id);
                const b = aButton(st === 'sent' ? 'Invited...' : st === 'declined' ? 'Declined' : 'Invite', () => {
                    invite(u);
                    b.textContent = 'Invited...';
                }, W - 126, y, 110, 28);
                b.disabled = full || !!u.noInvites;
                controls.push(b);
            });
            if (full)
                controls.push(aLabel('5 people is the most that can map together.', 16, 20 + rows * 36, W - 32, 26));
            return this.floating('collab-invite', 'Invite to map with you', W, 30 + rows * 36 + (full ? 30 : 0), controls);
        }

        closeAll() {
            for (const w of Object.values(this.windows))
                w.close();
        }

        notOnWeb(what) {
            this.message(`${what} isn't available in the web editor.`);
        }

        // ------------------------------------------------------------ BPM setup (TimingsWindow.axaml, 390x635)

        timings(editor) {
            const map = editor.map;
            const s = editor.settings;
            const X = 15, Y = 15, O = Y + 375;

            const grid = new DataGrid([['BPM', 180], ['Ms', 180]], X, Y, 360, 370);
            const bpmBox = aBox(X + 80, O, 90, 20, '0');
            const offsetBox = aBox(X + 80, O + 25, 90, 20, '0');
            const moveBox = aBox(X + 175, O + 50, 90, 20, '0');
            const adjust = aCheck('Adjust notes when changing points', s.adjustNotes, X + 55, O + 78, 250, 20);
            adjust.input.addEventListener('change', () => {
                s.adjustNotes = adjust.input.checked;
                SSQE.Settings.save(s);
            });
            const startBox = aBox(X + 182, O + 180, 86, 22, '0');
            const endBox = aBox(X + 182, O + 208, 86, 22, '0');
            const resultBox = aBox(X + 274, O + 208, 86, 22, '0', 'readonly center');
            resultBox.readOnly = true;

            let lastVersion = -1;
            const selectedPoints = () => grid.selectedItems();

            const resetList = () => {
                const selected = new Set(selectedPoints());
                grid.selected = new Set();
                map.timingPoints.forEach((p, i) => {
                    if (selected.has(p))
                        grid.selected.add(i);
                });
                grid.setRows(map.timingPoints.map(p => ({ item: p, cells: [+p.bpm.toFixed(3), p.ms] })));
                lastVersion = map.version;
            };

            grid.onSelect = () => {
                const p = selectedPoints()[0];
                if (p) {
                    bpmBox.value = p.bpm;
                    offsetBox.value = p.ms;
                }
            };

            offsetBox.addEventListener('input', () => {
                const v = parseInt(offsetBox.value, 10);
                if (Number.isFinite(v) && v > map.duration)
                    offsetBox.value = Math.trunc(map.duration);
            });

            const add = () => {
                const bpm = parseFloat(bpmBox.value), ms = parseInt(offsetBox.value, 10);
                if (!Number.isFinite(bpm) || !Number.isFinite(ms) || map.timingPoints.some(p => p.ms === ms))
                    return;
                map.replacePoints('ADD POINT', [], [new TimingPoint(bpm, ms)]);
            };

            const update = () => {
                const point = selectedPoints()[0];
                const bpm = parseFloat(bpmBox.value), ms = parseInt(offsetBox.value, 10);
                if (!point || !Number.isFinite(bpm) || !Number.isFinite(ms))
                    return;
                if (map.timingPoints.some(p => p.ms === ms && p !== point))
                    return;
                if (s.adjustNotes)
                    Timing.updatePoint(map, point, bpm);
                map.editPoints('EDIT POINT', [point], n => {
                    n.bpm = bpm;
                    n.ms = ms;
                });
            };

            const del = () => {
                const points = selectedPoints();
                if (points.length)
                    map.replacePoints('DELETE POINT[S]', points, []);
            };

            const move = () => {
                const offset = parseInt(moveBox.value, 10);
                const points = selectedPoints();
                if (!Number.isFinite(offset) || offset === 0 || !points.length)
                    return;
                map.editPoints('MOVE POINT[S]', points, n => n.ms += offset);
                if (s.adjustNotes)
                    Timing.movePoints(map, points, offset);
            };

            const setPoints = points => {
                map.replacePoints('IMPORT POINTS', map.timingPoints, points);
            };

            const pasteOsu = async () => {
                const text = await this.app.readClipboard('Paste osu! [TimingPoints]');
                if (text)
                    this.tryParse('OSU', () => setPoints(parseOsuTiming(text)));
            };

            const pasteCh = async () => {
                const text = await this.app.readClipboard('Paste a Clone Hero .chart');
                if (text)
                    this.tryParse('CH', () => setPoints(parseChTiming(text)));
            };

            const openBeatmap = async () => {
                const file = await this.app.pickFile('.osu,.chart,.adofai');
                if (!file)
                    return;
                const text = await file.text();
                if (file.name.toLowerCase().endsWith('.adofai'))
                    this.tryParse('ADOFAI', () => setPoints(parseAdofaiTiming(text)));
                else if (file.name.toLowerCase().endsWith('.chart'))
                    this.tryParse('CH', () => setPoints(parseChTiming(text)));
                else
                    this.tryParse('OSU', () => setPoints(parseOsuTiming(text)));
            };

            // Detect BPM: between Start and End (the whole song when End isn't after Start); the result goes into the
            // BPM and Offset boxes too, ready for Add Point (or Update Point)
            let detecting = false;
            const detect = async () => {
                if (detecting)
                    return;
                detecting = true;
                resultBox.value = '...';
                const from = Math.max(0, parseInt(startBox.value, 10) || 0), to = parseInt(endBox.value, 10) || 0;
                const found = await this.app.detectBpm(editor, from, to > from ? to : 0);
                detecting = false;
                resultBox.value = found ? found.bpm : '0';
                if (found) {
                    bpmBox.value = found.bpm;
                    offsetBox.value = found.offsetMs;
                }
            };

            const pasteAdofai = async () => {
                const text = await this.app.readClipboard('Paste an ADOFAI level (.adofai)');
                if (text)
                    this.tryParse('ADOFAI', () => setPoints(parseAdofaiTiming(text)));
            };

            const twoLine = text => text.split('\n').map((t, i) => [i ? el('br') : null, t]).flat();

            const controls = [
                grid.node,
                aLabel('  BPM', X, O, 80, 20), bpmBox,
                aLabel('  Offset (ms)', X, O + 25, 80, 20), offsetBox,
                aButton('Add Point', add, X + 175, O, 90, 20),
                aButton('Update Point', update, X + 175, O + 25, 90, 20),
                aButton('Delete Point', del, X + 270, O, 90, 20),
                aButton('Current Pos', () => offsetBox.value = Math.trunc(editor.currentTime), X + 270, O + 25, 90, 20),
                moveBox, aButton('Move Points', move, X + 270, O + 50, 90, 20),
                aLabel('  Move Selected Points (ms)', X, O + 50, 170, 20),
                adjust.label,
                aButton(twoLine('Paste OSU\nTimings'), pasteOsu, X, O + 125, 86, 50),
                aButton(twoLine('Paste ADOFAI\nTimings'), pasteAdofai, X + 92, O + 125, 86, 50),
                aButton(twoLine('Paste Clone\nHero Timings'), pasteCh, X + 183, O + 125, 86, 50),
                aButton(twoLine('Open\nBeatmap\nTimings'), openBeatmap, X + 274, O + 125, 86, 50),
                aButton(twoLine('Open BPM\nTapper'), () => this.tapper(), X, O + 180, 86, 50),
                aLabel('Start (ms)  ', X + 92, O + 180, 86, 22, 'right'),
                aLabel('End (ms)  ', X + 92, O + 208, 86, 22, 'right'),
                startBox, endBox,
                aButton('Detect BPM', detect, X + 274, O + 180, 86, 22),
                resultBox,
            ];

            const win = this.floating('timings', 'BPM Setup', 390, 635, controls, () => clearInterval(timer));
            const timer = setInterval(() => {
                if (map.version !== lastVersion)
                    resetList();
            }, 100);

            resetList();
            const current = Timing.getCurrentBpm(map, editor.currentTime);
            const index = map.timingPoints.indexOf(current);
            if (index >= 0) {
                grid.select(index);
                bpmBox.value = current.bpm;
                offsetBox.value = current.ms;
            }
            return win;
        }

        tryParse(kind, fn) {
            try {
                fn();
            } catch (e) {
                console.warn(e);
                this.message(`Failed to parse beatmap\n[ ${kind} : ${e.name} ]`, 'Error');
            }
        }

        // ------------------------------------------------------------ BPMTapper.axaml (226x244)

        tapper() {
            let taps = 0, tapping = false, start = 0;
            const X = 21, Y = 12;
            const bpmLabel = aLabel('', X, Y, 184, 32, 'boxed big');
            const decLabel = aLabel('', X, Y + 74, 184, 24, 'boxed');
            const decimals = aBox(X + 96, Y + 37, 88, 30, '2', 'bold');

            const reset = () => {
                taps = 0;
                tapping = false;
                bpmLabel.textContent = '';
                decLabel.textContent = '';
            };

            const tap = () => {
                taps++;
                if (!tapping) {
                    tapping = true;
                    start = performance.now();
                    bpmLabel.textContent = '0';
                    decLabel.textContent = '0';
                } else {
                    const d = Math.min(Math.max(parseInt(decimals.value, 10) || 0, 0), 15);
                    const mins = (performance.now() - start) / 60000;
                    const bpm = (taps - 1) / mins;
                    bpmLabel.textContent = Math.round(bpm);
                    decLabel.textContent = bpm.toFixed(d);
                }
            };

            const tapButton = aButton('TAP OR PRESS ANY KEY', tap, X, Y + 108, 184, 65);
            const controls = [
                bpmLabel, decLabel,
                aLabel('Decimal Places', X, Y + 37, 96, 30),
                decimals,
                tapButton,
                aButton('RESET', reset, X, Y + 179, 184, 41),
            ];

            const win = this.floating('tapper', 'BPM Tapper', 226, 244, controls);
            const panel = win.win.lastChild;
            panel.tabIndex = 0;
            panel.addEventListener('keydown', e => {
                if (e.target === decimals || e.repeat)
                    return;
                e.preventDefault();
                e.stopPropagation();
                tap();
            });
            setTimeout(() => panel.focus(), 0);
        }

        // ------------------------------------------------------------ BookmarksWindow.axaml (650x450)

        bookmarks(editor) {
            const map = editor.map;
            const X = 15, Y = 15, O = Y + 375;

            const grid = new DataGrid([['Text', 420], ['Start Ms', 100], ['End Ms', 100]], X, Y, 620, 370);
            const textBox = aBox(X + 60, O, 300, 20);
            const startBox = aBox(X + 60, O + 25, 147, 20, '0');
            const endBox = aBox(X + 213, O + 25, 147, 20, '0');

            let lastVersion = -1;
            const selected = () => grid.selectedItems();

            const resetList = () => {
                const sel = new Set(selected());
                grid.selected = new Set();
                map.bookmarks.forEach((b, i) => {
                    if (sel.has(b))
                        grid.selected.add(i);
                });
                grid.setRows(map.bookmarks.map(b => ({ item: b, cells: [b.text, b.ms, b.endMs] })));
                lastVersion = map.version;
            };

            grid.onSelect = () => {
                const b = selected()[0];
                if (b) {
                    textBox.value = b.text;
                    startBox.value = b.ms;
                    endBox.value = b.endMs;
                }
            };
            grid.onActivate = b => {
                if (editor.music.isPlaying)
                    editor.pauseMusic();
                editor.currentTime = b.ms;
            };

            const add = () => {
                const ms = parseInt(startBox.value, 10), end = parseInt(endBox.value, 10);
                if (!Number.isFinite(ms) || !Number.isFinite(end))
                    return;
                if (map.bookmarks.some(b => b.text === textBox.value && b.ms === ms && b.endMs === end))
                    return;
                map.replaceBookmarks('ADD BOOKMARK', [], [new Bookmark(textBox.value || '', ms, end)]);
            };

            const update = () => {
                const b = selected()[0];
                const ms = parseInt(startBox.value, 10), end = parseInt(endBox.value, 10);
                if (!b || !Number.isFinite(ms) || !Number.isFinite(end))
                    return;
                map.editBookmarks('EDIT BOOKMARK', [b], n => {
                    n.text = textBox.value;
                    n.ms = ms;
                    n.endMs = end;
                });
            };

            const del = () => {
                const b = selected();
                if (b.length)
                    map.replaceBookmarks('DELETE BOOKMARK[S]', b, []);
            };

            const currentPos = () => {
                const t = Math.trunc(editor.currentTime);
                if (startBox.value !== endBox.value)
                    startBox.value = t;
                endBox.value = t;
            };

            const controls = [
                grid.node,
                aLabel('Text', X, O, 60, 20), textBox,
                aLabel('Offset', X, O + 25, 60, 20), startBox, endBox,
                aButton('Add Bookmark', add, X + 375, O, 117, 20),
                aButton('Update Bookmark', update, X + 375, O + 25, 117, 20),
                aButton('Delete Bookmark', del, X + 503, O, 117, 20),
                aButton('Current Pos', currentPos, X + 503, O + 25, 117, 20),
            ];

            const win = this.floating('bookmarks', 'Bookmarks', 650, 450, controls, () => clearInterval(timer));
            const timer = setInterval(() => {
                if (map.version !== lastVersion)
                    resetList();
            }, 100);
            resetList();
            startBox.value = endBox.value = Math.trunc(editor.currentTime);
            return win;
        }

        // ------------------------------------------------------------ ExportSSPM.axaml (344x358)

        // format: 'sspm' (Nightly) or 'rhm' (Rhythia), both take the same metadata
        exportSspm(editor, format = 'sspm') {
            const map = editor.map;
            const p = map.props;
            const X = 12, Y = 12;

            const idBox = aBox(X + 84, Y, 236, 20, map.soundId, 'readonly dark');
            idBox.readOnly = true;
            const nameBox = aBox(X + 84, Y + 25, 236, 20, p.songName);
            const diffBox = at(el('select', { class: 'av-combo' }, DIFFICULTIES.map(d => el('option', { value: d }, d))), X + 84, Y + 50, 236, 20);
            diffBox.value = p.difficulty || 'N/A';
            const customBox = aBox(X + 184, Y + 74, 136, 20, p.customDifficulty);
            const mapperBox = at(el('textarea', { class: 'av-textbox', spellcheck: 'false' }), X + 84, Y + 99, 236, 130);
            mapperBox.value = p.mappers;
            let coverFile = null;
            const coverBox = aBox(X + 84, Y + 236.5, 176, 25, map.coverBytes ? 'Loaded map cover' : 'Default', 'readonly dark');
            coverBox.readOnly = true;
            const useCover = aCheck('Use Cover', p.useCover, X + 84, Y + 274, 236, 20);

            const selectCover = async () => {
                const file = await this.app.pickFile('image/png,image/jpeg');
                if (file) {
                    coverFile = file;
                    coverBox.value = file.name;
                }
            };

            const finish = async () => {
                p.songName = nameBox.value;
                p.difficulty = diffBox.value;
                p.customDifficulty = customBox.value;
                p.mappers = mapperBox.value;
                p.useCover = useCover.input.checked;
                editor.onMapChanged();

                let cover = null;
                if (useCover.input.checked) {
                    if (coverFile) {
                        cover = new Uint8Array(await coverFile.arrayBuffer());
                        map.coverBytes = cover;
                    } else if (map.coverBytes)
                        cover = map.coverBytes;
                    else {
                        try {
                            cover = new Uint8Array(await (await fetch('assets/Cover.png')).arrayBuffer());
                        } catch {
                            this.message('The default cover could not be loaded (open the editor through a web server, or select a cover image). Exporting without a cover.', 'Warning');
                        }
                    }
                }

                const audio = await this.app.storage.getAudio(map.soundId);
                if (!audio) {
                    this.message('No audio is loaded for this map.', 'Error');
                    return;
                }

                const id = SSQE.Formats.fixId(map.soundId);
                const mappers = mapperBox.value.split('\n').map(m => m.trim()).filter(Boolean);
                const meta = {
                    songId: id,
                    mapName: nameBox.value,
                    mappers: (mappers.length ? mappers : ['None']).join('\n'),
                    difficulty: diffBox.value,
                    customDifficulty: customBox.value,
                };

                let bytes;
                if (format === 'rhm') {
                    meta.duration = (editor.music && editor.music.duration || 0) * 1000;
                    meta.mapName = meta.mapName || p.songTitle || map.soundId;
                    // Rhythia always looks for a cover in the .rhm
                    if (!cover)
                        cover = await fetch('assets/Cover.png').then(r => r.ok ? r.arrayBuffer() : null).then(b => b && new Uint8Array(b)).catch(() => null);
                    const entries = [
                        { name: 'map', blob: new Blob([SSQE.Formats.writeRhmMap(map, meta)]) },
                        { name: 'audio', blob: audio },
                    ];
                    if (cover)
                        entries.push({ name: 'cover', blob: new Blob([cover]) });
                    bytes = await SSQE.zipFiles(entries);
                } else
                    bytes = SSQE.Formats.writeSspm(map, meta, new Uint8Array(await audio.arrayBuffer()), cover);

                this.app.download(new Blob([bytes], { type: 'application/octet-stream' }), `${id}.${format}`);
                window.SSQEStats && SSQEStats.add('mapsExported');
                win.close();
                editor.toast(`EXPORTED ${format.toUpperCase()}`);
            };

            const controls = [
                aLabel('Map ID', X, Y, 84, 20), idBox,
                aLabel('Song Name', X, Y + 25, 84, 20), nameBox,
                aLabel('Difficulty', X, Y + 50, 84, 20), diffBox,
                aLabel('Custom Difficulty (Optional)', X, Y + 74, 184, 20), customBox,
                aLabel(['Mapper(s)', el('br'), el('br'), '(One per line)'], X, Y + 99, 84, 60, 'top'), mapperBox,
                aLabel('Cover Image', X, Y + 239, 84, 20), coverBox,
                aButton('Select', selectCover, X + 265, Y + 236.5, 55, 25),
                useCover.label,
                aButton('Finish', finish, X, Y + 298, 320, 36),
            ];

            const win = this.floating(`export_${format}`, `Export ${format.toUpperCase()}`, 344, 358, controls);
            return win;
        }

        // ------------------------------------------------------------ ExportPHXM.axaml (Rewrite)

        exportPhxm(editor) {
            const map = editor.map;
            const p = map.props;
            const X = 12, Y = 12, W = 236;
            const split = (p.songName || '').split(' - ');
            const titleBox = aBox(X + 104, Y, W, 20, p.songTitle || (split.length > 1 ? split.slice(1).join(' - ') : p.songName) || '');
            const artistBox = aBox(X + 104, Y + 25, W, 20, p.songArtist || (split.length > 1 ? split[0] : ''));
            const diffBox = at(el('select', { class: 'av-combo' }, DIFFICULTIES.map(d => el('option', { value: d }, d))), X + 104, Y + 50, W, 20);
            diffBox.value = p.difficulty || 'N/A';
            const customBox = aBox(X + 204, Y + 74, 136, 20, p.customDifficulty);
            const ratingBox = aBox(X + 104, Y + 99, W, 20, String(p.rating || 0));
            const linkBox = aBox(X + 104, Y + 124, W, 20, Object.values(map.artistLinks || {})[0] || '');
            const platformBox = aBox(X + 104, Y + 149, W, 20, p.phxmPlatform || '');
            const mapperBox = at(el('textarea', { class: 'av-textbox', spellcheck: 'false' }), X + 104, Y + 174, W, 100);
            mapperBox.value = p.mappers || p.mapCreator || '';
            let coverFile = null;
            const coverBox = aBox(X + 104, Y + 281.5, W - 60, 25, map.coverBytes ? 'Loaded map cover' : 'None', 'readonly dark');
            coverBox.readOnly = true;
            const useCover = aCheck('Use Cover', p.useCover, X + 104, Y + 319, W, 20);
            const selectCover = async () => {
                const file = await this.app.pickFile('image/png,image/jpeg');
                if (file) {
                    coverFile = file;
                    coverBox.value = file.name;
                    useCover.input.checked = true;
                }
            };

            const finish = async () => {
                const title = titleBox.value.trim() || 'Untitled Song';
                p.songTitle = title;
                p.songArtist = artistBox.value;
                p.difficulty = diffBox.value;
                p.customDifficulty = customBox.value;
                p.rating = parseFloat(ratingBox.value) || 0;
                p.phxmPlatform = platformBox.value;
                p.mappers = mapperBox.value;
                p.useCover = useCover.input.checked;
                map.artistLinks = linkBox.value ? { [artistBox.value]: linkBox.value } : {};
                editor.onMapChanged();
                let cover = null;
                if (useCover.input.checked) {
                    if (coverFile) {
                        cover = new Uint8Array(await coverFile.arrayBuffer());
                        map.coverBytes = cover;
                    } else if (map.coverBytes)
                        cover = map.coverBytes;
                }
                const audio = await this.app.storage.getAudio(map.soundId);
                if (!audio) {
                    this.message('No audio is loaded for this map.', 'Error');
                    return;
                }
                const mappers = mapperBox.value.split('\n').map(m => m.trim()).filter(Boolean);
                const meta = {
                    title, artist: artistBox.value, mappers: (mappers.length ? mappers : ['None']).join('\n'),
                    difficulty: diffBox.value, customDifficulty: customBox.value, rating: p.rating,
                    artistLink: linkBox.value, artistPlatform: platformBox.value,
                    duration: (editor.music && editor.music.duration || 0) * 1000,
                };
                try {
                    const bytes = await SSQE.Formats.writePhxm(map, meta, audio, cover);
                    const id = SSQE.Formats.fixId(`${meta.mappers.split('\n')[0]} - ${title} - ${meta.artist}`);
                    this.app.download(new Blob([bytes], { type: 'application/octet-stream' }), `${id}.phxm`);
                    window.SSQEStats && SSQEStats.add('mapsExported');
                    win.close();
                    editor.toast('EXPORTED PHXM');
                } catch (e) {
                    console.warn(e);
                    this.message(`Failed to export PHXM:\n\n${e.message}`, 'Warning');
                }
            };

            const controls = [
                aLabel('Song Title', X, Y, 104, 20), titleBox,
                aLabel('Song Artist', X, Y + 25, 104, 20), artistBox,
                aLabel('Difficulty', X, Y + 50, 104, 20), diffBox,
                aLabel('Custom Difficulty (Optional)', X, Y + 74, 204, 20), customBox,
                aLabel('Rating', X, Y + 99, 104, 20), ratingBox,
                aLabel('Artist Link', X, Y + 124, 104, 20), linkBox,
                aLabel('Artist Platform', X, Y + 149, 104, 20), platformBox,
                aLabel(['Mapper(s)', el('br'), el('br'), '(One per line)'], X, Y + 174, 104, 60, 'top'), mapperBox,
                aLabel('Cover Image', X, Y + 284, 104, 20), coverBox,
                aButton('Select', selectCover, X + 285, Y + 281.5, 55, 25),
                useCover.label,
                aButton('Finish', finish, X, Y + 343, 340, 36),
            ];
            const win = this.floating('export_phxm', 'Export PHXM', 364, 403, controls);
            return win;
        }

        // ------------------------------------------------------------ auto mapper options (web only)

        // web only: logging in (a username and a password: see online.js), and whether people may watch you map
        account() {
            const O = window.SSQEOnline, s = this.app.settings;
            const W = 360, controls = [];
            if (!O || !O.configured()) {
                controls.push(aLabel('Accounts and spectating aren\'t set up in this version yet.', 16, 16, W - 32, 60));
                return this.floating('account', 'Account', W, 100, controls);
            }
            const status = aLabel('', 16, 0, W - 32, 44);
            const watch = aCheck('Let others watch me map', s.allowSpectators !== false, 16, 0, W - 32, 22);
            watch.input.addEventListener('change', () => {
                s.allowSpectators = watch.input.checked;
                SSQE.Settings.save(s);
            });
            const invites = aCheck('Let others invite me to collab', s.allowInvites !== false, 16, 0, W - 32, 22);
            invites.input.addEventListener('change', () => {
                s.allowInvites = invites.input.checked;
                SSQE.Settings.save(s);
            });
            const reopen = () => this.account();
            if (O.loggedIn()) {
                controls.push(aLabel(`Logged in as ${O.username()}`, 16, 16, W - 32, 26));
                controls.push(at(watch.label, 16, 56, W - 32, 22));
                controls.push(at(invites.label, 16, 86, W - 32, 22));
                controls.push(aButton('Log Out', async () => {
                    await O.logOut();
                    reopen();
                }, 16, 126, 120, 30));
                return this.floating('account', 'Account', W, 170, controls);
            }
            const name = aBox(120, 16, W - 136, 26);
            const pass = aBox(120, 52, W - 136, 26);
            pass.type = 'password';
            name.autocomplete = 'username';
            pass.autocomplete = 'current-password';
            const go = make => async () => {
                status.textContent = make ? 'Making the account...' : 'Logging in...';
                try {
                    const who = make ? await O.signUp(name.value.trim(), pass.value) : await O.logIn(name.value.trim(), pass.value);
                    this.app.dialogs.message(`${make ? 'Account made. ' : ''}Logged in as ${who}.`);
                    reopen();
                } catch (e) {
                    status.textContent = e.message;
                }
            };
            pass.addEventListener('keydown', e => e.key === 'Enter' && go(false)());
            controls.push(aLabel('Username', 16, 16, 100, 26), name, aLabel('Password', 16, 52, 100, 26), pass,
                aButton('Log In', go(false), 16, 92, 150, 30), aButton('Make Account', go(true), W - 166, 92, 150, 30),
                at(status, 16, 132, W - 32, 44), at(watch.label, 16, 182, W - 32, 22),
                aLabel('Just a username and a password: no email.', 16, 212, W - 32, 22));
            return this.floating('account', 'Account', W, 246, controls);
        }

        autoMapOptions(editor) {
            const s = editor.settings;
            const save = () => editor.settingsChanged();
            const X = 12, LW = 150, CW = 170, VX = X + LW + CW + 8;
            const controls = [];
            let y = 12;
            const rows = [];

            const slider = (label, key, min, max, step, def, fmt, hint) => {
                const value = aLabel('', VX, y, 52, 22);
                const input = at(el('input', { type: 'range', min, max, step, title: hint }), X + LW, y, CW, 22);
                const show = () => value.textContent = fmt(+input.value);
                const read = () => {
                    input.value = s[key] ?? def;
                    show();
                };
                input.addEventListener('input', () => {
                    s[key] = +input.value;
                    show();
                    save();
                });
                controls.push(aLabel(label, X, y, LW, 22), input, value);
                rows.push({ read, reset: () => s[key] = def });
                y += 30;
            };
            const choice = (label, key, options, def, hint) => {
                const select = at(el('select', { class: 'av-combo', title: hint }, options.map(([v, t]) => el('option', { value: v }, t))), X + LW, y, CW + 60, 22);
                select.addEventListener('change', () => {
                    s[key] = select.value;
                    save();
                });
                controls.push(aLabel(label, X, y, LW, 22), select);
                rows.push({ read: () => select.value = s[key] ?? def, reset: () => s[key] = def });
                y += 30;
            };
            const check = (label, key, def, hint) => {
                const c = aCheck(label, s[key] ?? def, X, y, LW + CW + 60, 22);
                c.label.title = hint;
                c.input.addEventListener('change', () => {
                    s[key] = c.input.checked;
                    save();
                });
                controls.push(c.label);
                rows.push({ read: () => c.input.checked = s[key] ?? def, reset: () => s[key] = def });
                y += 28;
            };
            const number = (label, key, min, max, def, hint) => {
                const box = aBox(X + LW, y, 80, 22, '');
                box.title = hint;
                box.addEventListener('change', () => {
                    const v = Math.min(max, Math.max(min, Math.round(+box.value || 0)));
                    s[key] = v;
                    box.value = v;
                    save();
                });
                controls.push(aLabel(label, X, y, LW, 22), box);
                rows.push({ read: () => box.value = s[key] ?? def, reset: () => s[key] = def });
                y += 30;
            };
            const pct = v => `${v}%`;

            slider('Target Stars', 'autoMapStars', 1, 15, 0.1, 5, v => `${v.toFixed(1)}*`, 'How hard, as Rhythia\'s star rating (SR): the map comes out at exactly this rating (the same formula as Rhythia and CALCULATE SR/RP). Harder means more notes, faster streams and bigger, quicker jumps; past what a song can normally rate, its streams are spaced out too');
            slider('Density', 'autoMapDensity', 25, 300, 5, 100, pct, 'More or fewer notes than the difficulty gives');
            number('Notes to Add (0 = Auto)', 'autoMapCount', 0, 100000, 0, 'An exact number of notes instead of what the difficulty gives');
            y += 6;
            slider('Flow', 'autoMapFlow', 0, 100, 5, 70, pct, 'How smooth the cursor\'s path is kept: higher avoids sudden turns and speed changes');
            slider('Follow Learned Maps', 'autoMapFollow', 0, 100, 5, 75, pct, 'How closely the patterns and their rhythm stick to the maps it learned');
            slider('Jump Size', 'autoMapJump', 50, 200, 5, 100, pct, 'Bigger or smaller moves than the learned maps make');
            choice('Patterns', 'autoMapPatterns', [['mixed', 'Mixed (streams and jumps)'], ['streams', 'Stream map (only streams)'], ['jumps', 'Jump map (big moves)']], 'mixed', 'What kind of map: mixed, with streams and jumps (see Streams / Jumps); a stream map, only streams that flow one cell at a time and hop one block over where the rhythm leaves a note out; or a jump map, almost only jumps on the song\'s own rhythm. Stream and jump maps follow the example maps that come with it, and the learned maps like them');
            slider('Streams / Jumps', 'autoMapJumpShare', 0, 100, 5, 50, v => `${v}% jumps`, 'For a mixed map: how much of the song is jumps. 0% streams all through, 100% jumps all through; in between, the calmer parts are jumps and the more intense parts and drops are streams, with jumps wherever the music slows down');
            slider('Drop Intensity', 'autoMapDrops', 0, 200, 10, 100, pct, 'How much denser and wider the intense parts and drops are than the rest');
            slider('Variety', 'autoMapVariety', 0, 100, 5, 50, pct, 'Lower keeps to a plan: a part of the song that comes round again gets its pattern again (turned or mirrored); higher makes new patterns more often');
            // which kinds of sound get notes (any mix of them)
            controls.push(aLabel('Sync To', X, y, LW, 22));
            const SOURCES = [['kick', 'Kicks'], ['snare', 'Snares & claps'], ['hat', 'Hi-hats & cymbals'], ['melody', 'Melody & vocals'], ['bass', 'Bass']];
            const sourceBoxes = SOURCES.map(([key, text], i) => {
                const c = aCheck(text, false, X + LW + (i % 2) * 125, y + Math.floor(i / 2) * 24, 122, 22);
                c.input.addEventListener('change', () => {
                    const on = sourceBoxes.filter(b => b.input.checked).map(b => b.key);
                    if (!on.length) {
                        c.input.checked = true;
                        return;
                    }
                    s.autoMapSources = on.join(',');
                    save();
                });
                controls.push(c.label);
                return { ...c, key };
            });
            rows.push({
                read: () => {
                    const on = (s.autoMapSources || 'kick,snare,hat').split(',');
                    sourceBoxes.forEach(b => b.input.checked = on.includes(b.key));
                },
                reset: () => s.autoMapSources = 'kick,snare,hat',
            });
            y += 78;
            slider('Sensitivity', 'autoMapSensitivity', 0, 100, 5, 50, pct, 'How quiet a sound can be and still get a note: lower only maps clear hits');
            choice('Fill Streams', 'autoMapFill', [['intense', 'In intense parts'], ['busy', 'Wherever the song is busy'], ['never', 'Never (only on sounds)']], 'intense', 'Whether streams are filled in between sounds where the song itself is busy');
            slider('Calm Parts', 'autoMapCalm', 0, 100, 5, 30, pct, 'How many notes calm parts (intros, breakdowns) get: 0% leaves them nearly empty');
            y += 6;
            slider('Quantum', 'autoMapQuantumPct', 0, 100, 1, 0, pct, 'How much of the map is quantum (notes off the 3x3 grid), in the design of the quantum maps it learned: 100% all of it, lower only some parts and tamer, around 10% just a few runs bent into lines and curves like the Bezier tool');
            slider('Similar to This Map', 'autoMapSimilarity', 0, 100, 5, 0, pct, 'How much it maps like the notes already in the map: each part of the song that sounds like a part you have mapped takes that part over, turned or mirrored so it joins on smoothly, with its rhythm where it has about as many notes as the difficulty wants. 100% does that wherever it can; lower, less often, and the rest only borrows its shapes. Needs some of the song mapped already');
            check('Follow this map\'s own patterns', 'autoMapUseMap', true, 'The notes already in the map are the patterns it prefers');
            check('Set the detected BPM when the map has none', 'autoMapSetBpm', true, 'Adds the song\'s BPM as a timing point so the beat lines match');
            y += 8;

            const refresh = () => rows.forEach(r => r.read());
            controls.push(aButton('Reset to Defaults', () => {
                rows.forEach(r => r.reset());
                save();
                refresh();
            }, X, y, 170, 30));
            controls.push(aButton('Auto Map', () => editor.autoMap && editor.autoMap(), X + 180, y, 214, 30));
            y += 42;
            refresh();
            return this.floating('autoMapOptions', 'Auto Mapper Options', 418, y, controls);
        }

        // ------------------------------------------------------------ save as (stands in for the native save dialog)

        saveAs(map, canUseFolders) {
            const input = el('input', { type: 'text', class: 'msg-input', spellcheck: 'false' });
            input.value = map.fileId;
            const info = canUseFolders
                ? 'Save the map (.txt) and its properties (.ini) to a folder, or download them.'
                : 'The map (.txt) and its properties (.ini) will be downloaded.';
            const result = mode => () => ({ name: input.value, mode });
            const buttons = canUseFolders
                ? [['Folder', result('folder')], ['Download', result('download')], ['Cancel', null]]
                : [['OK', result('download')], ['Cancel', null]];
            return this.modal(el('div', { class: 'msg-form' }, el('div', {}, info), input), buttons,
                { enterValue: result(canUseFolders ? 'folder' : 'download') });
        }
    }

    // TimingsWindow.ParseADOFAI: an ADOFAI level (.adofai, as text) as BPM points. The planet takes the angle it turns
    // between two tiles at the BPM (180 degrees: one beat), from the level's offset on; SetSpeed changes the BPM (to a
    // value, or times a multiplier) from its tile, Twirl the way round it turns, a midspin turns it straight back. A
    // point goes in where the level starts and wherever its BPM changes. (Read as the JSON it is, so it works with
    // levels in either of ADOFAI's formats: angleData, or the older pathData letters.)
    const ADOFAI_DEGREES = {
        R: 0, J: 30, E: 45, T: 60, U: 90, G: 120, Q: 135, H: 150, L: 180, N: 210, Z: 225, F: 240,
        D: 270, B: 300, C: 315, M: 330, x: 195, W: 165, A: 345, p: 15, q: 105, Y: 285, o: 75, V: 255, '!': 999,
    };
    function parseAdofaiTiming(data) {
        // (ADOFAI writes trailing commas, which JSON doesn't allow)
        const level = JSON.parse(data.replace(/^﻿/, '').replace(/,(\s*[}\]])/g, '$1'));
        const settings = level.settings || {};
        let angles = null;
        if (Array.isArray(level.angleData))
            angles = level.angleData.map(Number);
        else if (typeof level.pathData === 'string')
            angles = [...level.pathData].map(c => ADOFAI_DEGREES[c] ?? 0);
        if (!angles || angles.length < 2)
            throw new SyntaxError('No tiles');
        const speedAt = new Map(), twirlAt = new Set();
        for (const a of Array.isArray(level.actions) ? level.actions : []) {
            if (a && a.eventType === 'SetSpeed')
                speedAt.set(+a.floor, a);
            else if (a && a.eventType === 'Twirl')
                twirlAt.add(+a.floor);
        }
        let bpm = +settings.bpm > 0 ? +settings.bpm : 100;
        const apply = floor => {
            const sp = speedAt.get(floor);
            if (sp)
                bpm = sp.speedType === 'Multiplier' ? bpm * (+sp.bpmMultiplier || 1) : +sp.beatsPerMinute > 0 ? +sp.beatsPerMinute : bpm;
        };
        apply(0);
        let time = +settings.offset || 0, clockwise = true;
        const points = [new TimingPoint(Math.round(bpm * 1000) / 1000, Math.round(time))];
        for (let i = 1; i < angles.length; i++) {
            const prev = angles[i - 1];
            if (prev === 999)
                continue;
            let next = angles[i];
            const midspin = next === 999;
            if (midspin) {
                next = angles[i + 1];
                if (next === undefined)
                    break;
            }
            if (twirlAt.has(i))
                clockwise = !clockwise;
            const before = bpm;
            apply(i);
            if (bpm !== before && bpm > 0)
                points.push(new TimingPoint(Math.round(bpm * 1000) / 1000, Math.round(time)));
            let angle = ((prev + (midspin ? 0 : 180) - next) % 360 + 360) % 360;
            if (angle <= 0)
                angle += 360;
            if (!clockwise)
                angle = 360 - angle;
            if (angle <= 0)
                angle += 360;
            time += 60000 / bpm * angle / 180;
        }
        // (one point a time: a later one at the same time wins)
        const byMs = new Map();
        for (const p of points)
            byMs.set(p.ms, p);
        return [...byMs.values()].sort((a, b) => a.ms - b.ms);
    }

    // TimingsWindow.ParseOSU
    function parseOsuTiming(data) {
        data = data.replace(/\r\n/g, '\n');
        if (data.includes('TimingPoints')) {
            data = data.slice(data.indexOf('TimingPoints') + 13);
            if (data.includes('['))
                data = data.slice(0, data.indexOf('['));
        }

        const points = [];
        for (const line of data.split('\n')) {
            if (!line.includes(','))
                continue;
            const s = line.split(',');
            const time = Math.trunc(parseFloat(s[0]));
            let bpm = parseFloat(s[1]);
            if (!Number.isFinite(time) || !Number.isFinite(bpm))
                throw new SyntaxError('FormatException');
            const inherited = s.length > 6 ? s[6].trim() === '1' : bpm > 0;
            bpm = Math.abs(Math.round(60000 / bpm * 1000) / 1000);
            if (bpm > 0 && inherited)
                points.push(new TimingPoint(bpm, time));
        }
        return points;
    }

    // TimingsWindow.ParseCH
    function parseChTiming(data) {
        data = data.replace(/\r\n/g, '\n');
        let res = data.slice(data.indexOf('Resolution'));
        res = res.slice(0, res.indexOf('\n')).replace('Resolution = ', '');
        const resolution = parseFloat(res);
        if (!Number.isFinite(resolution))
            throw new SyntaxError('FormatException');

        data = data.slice(data.indexOf('SyncTrack'));
        data = data.slice(0, data.indexOf('}')).replace('SyncTrack]\n{', '');

        const bpms = [], times = [], ms = [];
        for (const line of data.split('\n')) {
            if (!line.includes(' B '))
                continue;
            bpms.push(parseFloat(line.slice(line.indexOf(' B ') + 3)) / 1000);
            times.push(parseFloat(line.slice(0, line.indexOf(' B ')).replace(' =', '')));
        }

        for (let i = 0; i < times.length; i++) {
            if (i > 0) {
                const diff = Math.round(1000 * ((times[i] - times[i - 1]) / (bpms[i - 1] * resolution / 60)) * 100) / 100;
                ms.push(diff + ms[i - 1]);
            } else
                ms.push(times[i]);
        }

        return ms.map((m, i) => new TimingPoint(bpms[i], Math.trunc(m)));
    }

    SSQE.Dialogs = Dialogs;
})();
