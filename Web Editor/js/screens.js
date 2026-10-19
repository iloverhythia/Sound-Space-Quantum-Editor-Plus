'use strict';

// Ports of GuiWindowMenu, GuiWindowCreate, GuiWindowSettings and GuiWindowKeybinds (layouts copied from their
// *.Controls.cs files), drawn with the canvas GUI toolkit in gui.js.
(function () {
    const G = SSQE.GUI;
    const None = G.CenterMode.None;

    // FontRenderer.WrapText
    function wrapText(text, size, font, width) {
        const out = [];
        for (const line of text.split('\n')) {
            const words = line.split(' ');
            let current = null;
            for (const word of words) {
                const next = current !== null ? `${current} ${word}` : word;
                if (current && G.Text.width(next, size, font) > width) {
                    out.push(current);
                    current = ' ' + word; // the desktop wrapper keeps the separating space on the next line
                } else
                    current = next;
            }
            out.push(current ?? '');
        }
        return out.join('\n');
    }

    // GuiScrollingList holding one wrapped label (the changelog)
    class ScrollingText extends G.Interactive {
        init() {
            super.init();
            this.scroll = 0;
            this.scrollScale = 2;
            this.textSize = 20;
            this.font = 'semibold';
            this.content = '';
            this.wrapped = '';
            this.wrappedFor = '';
            this.playLeftClickSound = false;
            this.playRightClickSound = false;
            this.draggingBar = false;
        }

        get barWidth() {
            return Math.min(20, this.origin.w / 10) * this.rect.w / (this.origin.w + Math.min(20, this.origin.w / 10));
        }

        layout() {
            const key = `${this.content}|${this.rect.w}|${this.scaledTextSize}`;
            if (key !== this.wrappedFor) {
                this.wrapped = wrapText(this.content, this.scaledTextSize, this.font, this.rect.w);
                this.wrappedFor = key;
            }
            const lines = this.wrapped.split('\n').length;
            const contentH = lines * this.scaledTextSize;
            this.maxScroll = Math.max(0, contentH - this.rect.h);
            this.scroll = Math.min(Math.max(this.scroll, 0), this.maxScroll);
        }

        contains(x, y) {
            const r = this.rect;
            return x >= r.x && x <= r.x + r.w + this.barWidth && y >= r.y && y <= r.y + r.h;
        }

        mouseScroll(x, y, delta) {
            this.scroll -= 10 * delta * this.scrollScale * this.textScale;
            this.layout();
        }

        mouseDownLeft(x, y, window) {
            super.mouseDownLeft(x, y, window);
            this.draggingBar = x >= this.rect.x + this.rect.w - this.barWidth / 2;
            this.lastY = y;
            this.mouseMove(x, y);
        }

        mouseMove(x, y) {
            // on touch screens the text itself can be dragged
            if (this.dragging && !this.draggingBar && SSQE.Touch && SSQE.Touch.active) {
                this.scroll -= y - this.lastY;
                this.lastY = y;
                this.layout();
            }
            if (this.dragging && this.draggingBar) {
                const top = this.rect.y + 6, h = this.rect.h - 12;
                this.scroll = Math.min(1, Math.max(0, (y - top) / h)) * this.maxScroll;
            }
        }

        draw(ctx) {
            this.layout();
            // slider (Style = Slider_Uncolored): grey line + white marker
            const bx = this.rect.x + this.rect.w + this.barWidth / 2; // the bar sits just right of the list
            const top = this.rect.y + 6, h = this.rect.h - 12;
            ctx.fillStyle = 'rgb(75,75,75)';
            ctx.fillRect(bx - 1.5, top, 3, h);
            const p = this.maxScroll ? this.scroll / this.maxScroll : 0;
            ctx.beginPath();
            ctx.arc(bx, top + h * p, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
        }

        drawText(ctx) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
            ctx.clip();
            G.Text.draw(ctx, this.wrapped, this.rect.x, this.rect.y - this.scroll, this.scaledTextSize, this.font, [255, 255, 255]);
            ctx.restore();
        }
    }

    // GuiPathBox: a CHOOSE button followed by the chosen file name
    function pathBox(x, y, w, h, text, textSize, getLabel, onChoose) {
        const button = new G.Button(0, 0, w / 4, h, { text, textSize, onLeftClick: onChoose });
        const label = new G.Label(w / 4 + 8, 0, w * 3 / 4 - 8, h, { textSize, centerMode: G.CenterMode.Y });
        const backdrop = new G.Square(w / 4, 0, w * 3 / 4, h, { color: [26, 26, 26] });
        const outline = new G.Square(w / 4, 0, w * 3 / 4, h, { color: [52, 52, 52], outline: true });
        const box = new G.Container(x, y, w, h, [button, label, backdrop, outline]);
        box.process = function (dt) {
            G.Container.prototype.process.call(this, dt);
            label.text = getLabel();
        };
        return box;
    }

    // GuiTextboxKeybind / GuiTextboxGridKeybind
    class KeybindBox extends G.Textbox {
        init() {
            super.init();
            this.style = G.Styles.Textbox_Uncolored;
            this.getText = () => '';
            this.onKey = null;
        }

        process(dt) {
            super.process(dt);
            this.text = this.getText();
            this.cursorPos = this.text.length;
        }

        keyDown(e) {
            if (!this.focused)
                return false;
            if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key))
                return true;
            this.onKey(e.code === 'Backspace' ? 'Delete' : e.code, e.ctrlKey || e.metaKey, e.altKey, e.shiftKey);
            return true;
        }

        paste() { }
    }

    // ---------------------------------------------------------------- shared runner

    class Screen {
        constructor(app, controls) {
            this.app = app;
            this.win = new G.Window(app, G.squareButtons(controls));
            this.canvas = document.getElementById('editor-canvas');
            this.ctx = this.canvas.getContext('2d');
            this.running = false;
        }

        start() {
            this.running = true;
            this.handlers = {
                mousemove: e => this.win.mouseMove(e.clientX, e.clientY),
                mousedown: e => {
                    if (e.target !== this.canvas)
                        return;
                    this.win.mouseMove(e.clientX, e.clientY);
                    this.win.mouseDown(e.clientX, e.clientY, e.button);
                },
                mouseup: e => this.win.mouseUp(e.clientX, e.clientY, e.button),
                wheel: e => {
                    if (e.target !== this.canvas)
                        return;
                    e.preventDefault();
                    if (e.deltaY)
                        this.win.scroll(e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
                },
                keydown: e => {
                    this.win.keys.ctrl = e.ctrlKey || e.metaKey;
                    this.win.keys.alt = e.altKey;
                    this.win.keys.shift = e.shiftKey;
                    if (this.app.dialogOpen())
                        return;
                    const r = this.win.keyDown(e);
                    if (r === true)
                        e.preventDefault();
                    this.onKeyDown && this.onKeyDown(e);
                },
                keyup: e => {
                    this.win.keys.ctrl = e.ctrlKey || e.metaKey;
                    this.win.keys.alt = e.altKey;
                    this.win.keys.shift = e.shiftKey;
                },
                paste: e => {
                    if (this.win.textboxFocused()) {
                        e.preventDefault();
                        this.win.paste(e.clipboardData.getData('text'));
                    }
                },
                contextmenu: e => e.target === this.canvas && e.preventDefault(),
            };
            for (const [k, h] of Object.entries(this.handlers))
                window.addEventListener(k, h, k === 'wheel' ? { passive: false } : undefined);
            this.fit = G.fitCanvas(this.canvas, (w, h) => this.win.resize(w, h));
            this.last = performance.now();
            const frame = now => {
                if (!this.running)
                    return;
                const dt = Math.max(0, (now - this.last) / 1000);
                this.last = now;
                this.update && this.update(dt);
                this.win.process(dt);
                const ctx = this.ctx;
                ctx.setTransform(1, 0, 0, 1, 0, 0);
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                this.fit.setTransform(ctx);
                this.win.render(ctx);
                this.raf = requestAnimationFrame(frame);
            };
            this.raf = requestAnimationFrame(frame);
        }

        stop() {
            this.running = false;
            cancelAnimationFrame(this.raf);
            for (const [k, h] of Object.entries(this.handlers || {}))
                window.removeEventListener(k, h);
            this.fit && this.fit.dispose();
        }
    }

    const background = () => new G.Square(0, 0, 1920, 1080, { color: [30, 30, 30] });

    // a picture from assets/ drawn as it is (keeping its transparency), fitted inside the control
    class Picture extends G.Control {
        draw(ctx) {
            const img = G.texture(this.name);
            if (!img.complete || !img.naturalWidth)
                return;
            const r = this.rect, k = Math.min(r.w / img.naturalWidth, r.h / img.naturalHeight);
            const w = img.naturalWidth * k, h = img.naturalHeight * k;
            ctx.globalAlpha = 1;
            ctx.drawImage(img, r.x + (r.w - w) / 2 * (this.align === 'left' ? 0 : 1), r.y + (r.h - h) / 2, w, h);
        }
    }

    // ---------------------------------------------------------------- GuiWindowMenu

    function menu(app) {
        const s = app.settings;
        const label = (x, y, w, h, props) => new G.Label(x, y, w, h, { centerMode: None, ...props });
        // (flat, without the gradient, and nearly square cornered, like the original editor's menu)
        const button = (x, y, w, h, text, textSize, onClick) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick });

        const changelog = new ScrollingText(60, 230, 890, 715, { content: app.changelog || 'Loading...' });
        // (the buttons are a little shorter than the original's so STATS and CREDITS fit in the column)
        const autosaved = button(1190, 845, 600, 85, 'AUTOSAVED MAP', 48, () => app.openAutosaved());
        const lastMap = button(1190, 845, 600, 85, 'EDIT LAST MAP', 48, () => app.openLastMap());

        // (web only: logging in, for spectating; the button shows who's logged in)
        const accountButton = button(1590, 132, 200, 40, 'LOG IN', 22, () => app.dialogs.account());
        accountButton.process = function (dt) {
            G.Button.prototype.process.call(this, dt);
            this.text = window.SSQEOnline && SSQEOnline.loggedIn() ? SSQEOnline.username() : 'LOG IN';
        };
        const navLeft = button(0, 1040, 40, 40, '<', 34, () => { app.mapIndex--; });
        const navRight = button(1880, 1040, 40, 40, '>', 34, () => { app.mapIndex++; });
        const selects = [], closes = [];
        for (let i = 0; i < 5; i++) {
            const x = 40 + 368 * i;
            selects.push(button(x, 1040, 368, 40, '', 20, () => {
                const entry = app.openMaps[app.mapIndex + i];
                if (entry)
                    app.openEntry(entry);
            }));
            closes.push(button(x, 1040, 40, 40, 'X', 26, () => {
                const entry = app.openMaps[app.mapIndex + i];
                if (entry)
                    app.closeEntry(entry);
            }));
        }

        const collabNote = label(380, 132, 900, 40, { text: '', textSize: 26, centerMode: None });
        const collabCancel = button(1300, 132, 260, 40, 'CANCEL COLLAB', 24, () => window.SSQECollab && SSQECollab.leave());
        const controls = [
            background(),
            new G.Square(35, 180, 950, 790, { color: [0, 0, 0, 40] }),
            new G.Square(55, 230, 900, 715, { color: [0, 0, 0, 50] }),
            new G.Square(0, 1040, 1920, 40, { color: [0, 0, 0, 50] }),
            button(1190, 180, 600, 85, 'CREATE NEW MAP', 48, () => app.openCreate()),
            button(1190, 275, 600, 85, 'LOAD MAP', 48, () => app.loadMapDialog()),
            button(1190, 370, 600, 85, 'PASTE MAP', 48, () => app.pasteMap()),
            button(1190, 465, 600, 85, 'SETTINGS', 48, () => app.openSettings()),
            // web only: the map player, opened on top of the editor; stats (credits are in Settings)
            button(1190, 560, 600, 85, 'MAP PLAYER', 48, () => app.openPlayer()),
            button(1190, 655, 600, 85, 'STATS', 48, () => app.showScreen('stats')),
            button(1190, 750, 295, 85, 'SPECTATE', 40, () => app.showScreen('spectate')),
            button(1495, 750, 295, 85, 'COLLABORATE', 40, () => app.showScreen('collaborate')),
            accountButton,
            // web only: starting a collab, the host opens the map to work on from here (collab.js)
            collabNote, collabCancel,
            autosaved, lastMap, navLeft, navRight,
            ...selects, ...closes,
            button(262, 132, 100, 40, 'Feedback?', 20, () => window.open('https://forms.gle/Rh4RXKT9KyttJ9Dc6', '_blank', 'noopener')),
            changelog,
            label(60, 195, 200, 40, { text: 'CHANGELOG', textSize: 42 }),
            new Picture(35, 4, 212, 172, { name: 'logo', align: 'left' }),
            label(262, 26, 700, 90, { text: 'QUANTUM EDITOR PLUS', textSize: 84, font: 'square' }),
        ];

        const screen = new Screen(app, controls);
        screen.update = () => {
            const collabWith = window.SSQECollab && SSQECollab.choosingFor();
            collabNote.text = collabWith ? `MAPPING WITH ${collabWith.toUpperCase()}: CREATE, LOAD OR OPEN THE MAP` : '';
            collabCancel.visible = !!collabWith;
            changelog.content = app.changelog || 'Loading...';

            // GuiWindowMenu.FixButtonsChangelog
            autosaved.visible = false;
            lastMap.visible = !!app.lastMapEntry();
            const r = lastMap.origin;
            lastMap.origin = { ...r, y: autosaved.visible ? 940 : 845 };

            // GuiWindowMenu.AssembleMapList / Render
            const count = app.openMaps.length;
            app.mapIndex = Math.max(0, Math.min(app.mapIndex, Math.max(count - 5, 0)));
            navLeft.visible = app.mapIndex > 0;
            navRight.visible = app.mapIndex < count - 5;
            for (let i = 0; i < 5; i++) {
                const entry = app.openMaps[app.mapIndex + i];
                selects[i].visible = !!entry;
                closes[i].visible = !!entry && selects[i].hovering;
                if (entry) {
                    const name = (app.isSaved(entry) ? '' : '[!] ') + app.entryName(entry);
                    selects[i].text = closes[i].visible ? 'Open Map' : trimText(name, selects[i].scaledTextSize, 'main', selects[i].rect.w - 10);
                }
            }
            screen.win.resize(screen.win.width, screen.win.height);
        };
        const scrollMaps = screen.win.scroll.bind(screen.win);
        screen.win.scroll = (x, y, delta) => {
            scrollMaps(x, y, delta);
            if ([navLeft, navRight, ...selects, ...closes].some(b => b.visible && b.hovering))
                app.mapIndex += delta > 0 ? 1 : -1;
        };
        return screen;
    }

    // FontRenderer.TrimText
    function trimText(text, size, font, width) {
        if (G.Text.width(text, size, font) <= width)
            return text;
        while (text.length > 1 && G.Text.width(text + '...', size, font) > width)
            text = text.slice(0, -1);
        return text + '...';
    }

    // ---------------------------------------------------------------- GuiWindowCreate

    function create(app) {
        const s = app.settings;
        const unc = G.Styles.Checkbox_Uncolored = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        let audioFile = null;
        const fileLabel = () => audioFile ? audioFile.name : '';
        const choose = async () => {
            const f = await app.pickFile('audio/*,.asset,.mp3,.ogg,.wav,.flac,.m4a,.opus');
            if (f)
                audioFile = f;
        };

        const games = ['Sound Space', 'Rhythia', 'Novastra/Phoenyx/Other'];
        const idBox = new G.Textbox(470, 5, 340, 50, { textSize: 36 });
        const ssContainer = new G.Container(0, 0, 1920, 1080, [
            new G.Label(370, -45, 540, 50, { text: 'Audio ID', textSize: 36 }),
            idBox,
            new G.Label(370, 55, 540, 50, { text: 'Import Audio', textSize: 36 }),
            pathBox(370, 105, 540, 50, 'CHOOSE', 28, fileLabel, choose),
        ]);
        const rhythiaContainer = new G.Container(0, 0, 1920, 1080, [
            new G.Label(370, -45, 540, 50, { text: 'Import Audio', textSize: 36 }),
            pathBox(370, 5, 540, 50, 'CHOOSE', 28, fileLabel, choose),
            new G.Label(370, 85, 540, 100, { text: 'Rhythia Online is no longer supported for importing\nand should not be used for new work.\n\ndiscord.gg/rhythia -> #Announcements', textSize: 20 }),
        ], { visible: false });
        const novaContainer = new G.Container(0, 0, 1920, 1080, [
            pathBox(370, 5, 540, 50, 'CHOOSE', 28, fileLabel, choose),
            new G.Label(370, -45, 540, 50, { text: 'Import Audio', textSize: 36 }),
        ], { visible: false });
        const panels = [ssContainer, rhythiaContainer, novaContainer];

        let active = Math.max(0, games.indexOf(s.createGame || 'Sound Space'));
        const navs = games.map((g, i) => new G.Checkbox(0, i * 100, 50, 50, {
            text: g, textSize: 30, style: unc,
            get: () => active === i,
            set: () => {
                active = i;
                s.createGame = games[i];
                SSQE.Settings.save(s);
            },
        }));
        const gameNavs = new G.Container(320, 415, 180, 250, [...navs, ...panels]);

        const controls = [
            background(),
            new G.Container(0, 0, 1920, 1080, [
                new G.Button(750, 705, 420, 50, {
                    text: 'CREATE MAP', textSize: 38, onLeftClick: async () => {
                        if (!audioFile) {
                            app.dialogs.message('Choose an audio file first.');
                            return;
                        }
                        let id = SSQE.Formats.fixId(audioFile.name.replace(/\.[^.]*$/, ''));
                        if (active === 0 && idBox.text.trim())
                            id = SSQE.Formats.fixId(idBox.text.trim());
                        await app.storage.putAudio(id, audioFile);
                        const map = new SSQE.Map();
                        map.soundId = id;
                        window.SSQEStats && SSQEStats.add('mapsCreated');
                        await app.openNewMap(map, null);
                        // (mapping with someone: the song goes to them too, see collab.js)
                        window.SSQECollab && SSQECollab.songChosen(audioFile, id);
                    },
                }),
                new G.Button(690, 920, 540, 75, { text: 'BACK TO MENU', textSize: 48, onLeftClick: () => app.showMenu() }),
            ]),
            gameNavs,
        ];
        // (mapping with someone: they wait for the song chosen here)
        const collabNote = new G.Label(360, 200, 1200, 60, { text: '', textSize: 40 });
        controls.push(collabNote);

        const screen = new Screen(app, controls);
        screen.update = () => {
            panels.forEach((p, i) => p.visible = i === active);
            const peer = window.SSQECollab && SSQECollab.choosingFor();
            collabNote.text = peer ? `MAPPING WITH ${peer.toUpperCase()}: CHOOSE THE SONG, THEN CREATE MAP` : '';
        };
        return screen;
    }

    // ---------------------------------------------------------------- GuiWindowSettings

    function settings(app) {
        const s = app.settings;
        const unc = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        const save = () => {
            SSQE.Settings.save(s);
            app.applyTheme();
        };
        const lbl = (x, y, w, h, text, textSize = 30) => new G.Label(x, y, w, h, { text, textSize, centerMode: None });
        const btn = (x, y, w, h, text, textSize, onClick) => new G.Button(x, y, w, h, { text, textSize, onLeftClick: onClick });
        const chk = (x, y, text, key, onChange) => new G.Checkbox(x, y, 45, 45, {
            text, textSize: 34, style: unc, get: () => s[key], set: v => { s[key] = v; save(); onChange && onChange(v); },
        });
        const dynamicLbl = (x, y, w, h, fn, textSize = 26) => {
            const l = lbl(x, y, w, h, '', textSize);
            l.process = function (dt) {
                G.Label.prototype.process.call(this, dt);
                this.text = fn();
            };
            return l;
        };

        // web only: custom background image and note mesh, shared with the map player
        const loadBackgroundImage = async () => {
            const file = await app.pickFile('image/*');
            if (!file)
                return;
            try {
                await SSQECustom.setImage(file);
                s.editorBackground = 'Custom Image';
                save();
            } catch (err) {
                app.dialogs.message(`The image couldn't be saved: ${err.message}`, 'Error');
            }
        };
        const loadCursor = async () => {
            const file = await app.pickFile('image/*,.gif,.png,.webp,.apng,.svg,.cur');
            if (!file)
                return;
            try {
                await SSQECustom.setCursor(file);
            } catch (err) {
                app.dialogs.message(`The cursor couldn't be saved: ${err.message}`, 'Error');
            }
        };
        const loadNoteMesh = async () => {
            const file = await app.pickFile('.obj');
            if (!file)
                return;
            try {
                await SSQECustom.setNoteMesh(file);
            } catch (err) {
                app.dialogs.message(`This note mesh can't be used: ${err.message}`, 'Error');
            }
        };
        const playerSetting = (key, value) => {
            const ps = SSQESettings.load();
            ps[key] = value;
            SSQESettings.save(ps);
        };

        const num = (x, y, w, h, key, props) => new G.NumberBox(x, y, w, h, {
            textSize: 34, get: () => s[key], set: v => { s[key] = v; save(); }, ...props,
        });

        const pick = key => app.pickColor(s[key]).then(c => {
            if (c) {
                s[key] = c;
                save();
            }
        });

        const colorRow = (i, y, text) => [
            btn(0, y, 200, 50, 'PICK COLOR', 30, () => pick(`color${i}`)),
            lbl(0, y - 30, 200, 26, text),
            new G.Square(210, y, 75, 50, { color: () => s[`color${i}`] }),
        ];

        // note colour squares (LMB: remove, RMB: move left)
        class NoteColors extends G.Interactive {
            init() {
                super.init();
                this.playLeftClickSound = true;
                this.hoverIndex = -1;
            }

            mouseMove(x) {
                const colors = s.noteColors;
                const w = this.rect.w / colors.length;
                this.hoverIndex = this.hovering ? Math.min(Math.max(Math.trunc((x - this.rect.x) / w), 0), colors.length - 1) : -1;
            }

            mouseLeave() {
                super.mouseLeave();
                this.hoverIndex = -1;
            }

            mouseUpLeft(x, y) {
                super.mouseUpLeft(x, y);
                if (this.hovering && this.hoverIndex >= 0 && s.noteColors.length > 1) {
                    s.noteColors.splice(this.hoverIndex, 1);
                    save();
                }
            }

            mouseUpRight(x, y) {
                super.mouseUpRight(x, y);
                const i = this.hoverIndex;
                if (this.hovering && i > 0 && s.noteColors.length > 1) {
                    [s.noteColors[i], s.noteColors[i - 1]] = [s.noteColors[i - 1], s.noteColors[i]];
                    save();
                }
            }

            draw(ctx) {
                const colors = s.noteColors;
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

        const opacityRow = (y, key, text) => [
            num(650, y, 200, 50, key, { increment: 5, isPositive: true, bounds: [0, 255], style: G.Styles.Textbox_Uncolored }),
            lbl(650, y - 30, 200, 26, text),
            new G.Square(860, y, 75, 50, { color: () => [255, 255, 255, Math.min(255, Math.max(0, s[key]))] }),
        ];

        const ColorsNav = new G.Container(320, 0, 1220, 700, [
            ...colorRow(1, 0, 'Color 1 (1/X BPM + Primary):'),
            ...colorRow(2, 100, 'Color 2 (1/1 BPM + Secondary):'),
            ...colorRow(3, 200, 'Color 3 (1/2 BPM + Preview):'),
            ...colorRow(4, 300, 'Color 4 (Waveform):'),
            ...colorRow(5, 400, 'Color 5 (Special Objects):'),
            btn(0, 500, 200, 50, 'ADD COLOR', 30, () => app.pickColor([255, 255, 255]).then(c => {
                if (c && s.noteColors.length < 32) {
                    s.noteColors.push(c);
                    save();
                }
            })),
            lbl(0, 470, 200, 26, 'Note Colors:'),
            lbl(0, 555, 195, 26, 'LMB: Remove\nRMB: Move left'),
            new NoteColors(210, 500, 75, 50),
            ...opacityRow(0, 'editorBGOpacity', 'Editor Background Opacity:'),
            ...opacityRow(100, 'gridOpacity', 'Grid Opacity:'),
            ...opacityRow(200, 'trackOpacity', 'Track Opacity:'),
            // web only: background picture, from the map player's worlds or the user's own image
            lbl(650, 300, 400, 26, 'Editor Background:'),
            btn(1060, 330, 160, 50, 'LOAD IMAGE', 30, loadBackgroundImage),
            dynamicLbl(650, 390, 570, 26, () => `Custom Image: ${(window.SSQECustom && SSQECustom.state.imageName) || 'None'}`),
            new G.Dropdown(650, 330, 400, 50, {
                options: Object.keys(SSQE.Settings.EDITOR_BACKGROUNDS), textSize: 30, toShow: 8,
                get: () => s.editorBackground || 'Default', set: i => { s.editorBackground = Object.keys(SSQE.Settings.EDITOR_BACKGROUNDS)[i]; save(); },
            }),
        ]);

        const fpsLimit = { value: s.fpsLimit ?? 60 };
        const GraphicsNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Enable Waveform', 'waveform'),
            chk(0, 60, 'Use Classic Waveform', 'classicWaveform'),
            num(0, 150, 200, 50, 'waveformDetail', { increment: 1, isPositive: true, textSize: 30, bounds: [1, 250], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 120, 200, 26, 'Waveform Level of Detail:'),
            chk(0, 300, 'Enable VSync', 'useVSync'),
            chk(0, 360, 'Limit Player FPS', 'limitPlayerFPS'),
            new G.Slider(0, 410, 400, 55, { get: () => fpsLimit.value, set: v => { fpsLimit.value = v; s.fpsLimit = v; save(); }, max: 305, step: 5, def: 60 }),
            new G.Label(0, 460, 400, 55, { textSize: 34, centerMode: None, text: '' }),
            chk(0, 510, 'Lower FPS in Background', 'lowerBackgroundFPS'),
            chk(700, 0, 'Use Anti-Aliasing', 'msaa'),
            chk(700, 60, 'Show Control Gradients', 'buttonGradients'),
            lbl(700, 120, 200, 26, 'Font Scale:'),
            num(700, 150, 200, 50, 'fontScale', { increment: 0.05, isPositive: true, isFloat: true, textSize: 30, bounds: [0.25, 2.5], style: G.Styles.Textbox_Uncolored }),
            chk(700, 300, 'Grid Squircles', 'gridSquircles'),
            num(700, 390, 200, 50, 'gridSquircleDetail', { increment: 1, isPositive: true, textSize: 30, bounds: [1, 16], style: G.Styles.Textbox_Uncolored }),
            lbl(700, 360, 200, 26, 'Grid Squircle Corner Detail:'),
            num(700, 485, 200, 50, 'gridSquircleRadius', { increment: 0.025, isPositive: true, isFloat: true, textSize: 30, bounds: [0, 0.5], style: G.Styles.Textbox_Uncolored }),
            lbl(700, 455, 200, 26, 'Grid Squircle Corner Radius:'),
            new G.Square(955, 395, 40, 40, { color: [255, 255, 255], outline: true, stretch: 'None', cornerRadius: s.gridSquircleRadius }),
            // web only: custom image (animated GIFs too) for the cursor square that follows the notes on the grid
            dynamicLbl(0, 580, 680, 26, () => `Grid Cursor Image: ${(window.SSQECustom && SSQECustom.state.cursorName) || 'Default'}`, 30),
            btn(0, 610, 220, 50, 'LOAD IMAGE', 30, loadCursor),
            btn(230, 610, 150, 50, 'RESET', 30, () => SSQECustom.setCursor(null).catch(() => { })),
            lbl(700, 580, 200, 26, 'Grid Cursor Size (%):'),
            num(700, 610, 200, 50, 'cursorScale', { increment: 10, isPositive: true, textSize: 30, bounds: [25, 800], style: G.Styles.Textbox_Uncolored }),
        ]);
        const fpsLabel = GraphicsNav.controls[7];
        const squirclePreview = GraphicsNav.controls.find(c => c instanceof G.Square && c.outline);

        const MappingNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Enable Autosave', 'enableAutosave'),
            num(0, 90, 200, 50, 'autosaveInterval', { increment: 1, isPositive: true, isFloat: true, bounds: [0.1, 60], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 60, 200, 26, 'Autosave Interval (min):'),
            chk(0, 215, 'Correct Errors on Copy', 'correctOnCopy'),
            chk(0, 275, 'Reverse Scroll Direction', 'reverseScroll'),
        ]);

        const games = ['Rhythia', 'Novastra', 'SSQE Player'];
        // the desktop app playtests in Rhythia (its path chosen here); the web editor always uses the web player
        const desktop = !!window.ssqeDesktop;
        const notOnWeb = () => app.dialogs.message('Playtesting in Rhythia or Novastra isn\'t available in the web editor. Playtests always use the web player.');
        const pickGame = game => async () => {
            const chosen = await window.ssqeDesktop.pickPlaytestPath(game);
            if (chosen)
                app.desktopPaths = { ...(app.desktopPaths || {}), [game]: chosen };
        };
        const pickRhythia = pickGame('Rhythia'), pickNova = pickGame('Novastra');
        const PlayerNav = new G.Container(320, 0, 1220, 700, [
            ...games.map((g, i) => new G.Checkbox(0, i * 60, 45, 45, {
                text: g, textSize: 34, style: unc,
                get: () => (s.playtestGame || 'SSQE Player') === g,
                set: () => {
                    s.playtestGame = g;
                    save();
                    if (!desktop && g !== 'SSQE Player')
                        notOnWeb();
                    else if (desktop && g !== 'SSQE Player' && !(app.desktopPaths && app.desktopPaths[g]))
                        pickGame(g)();
                },
            })),
            pathBox(300, 0, 750, 50, 'RHYTHIA PATH', 30, () => desktop ? (app.desktopPaths && app.desktopPaths.Rhythia) || '' : '', desktop ? pickRhythia : notOnWeb),
            pathBox(300, 60, 750, 50, 'NOVASTRA PATH', 30, () => desktop ? (app.desktopPaths && app.desktopPaths.Novastra) || '' : '', desktop ? pickNova : notOnWeb),
            new G.Checkbox(0, 180, 45, 45, {
                text: 'Open SSQE Player in Fullscreen', textSize: 34, style: unc,
                get: () => SSQESettings.load().fullscreenPlayer, set: v => { const ps = SSQESettings.load(); ps.fullscreenPlayer = v; SSQESettings.save(ps); },
            }),
            // web only: the SSQE Player's 3D background and note mesh
            dynamicLbl(0, 280, 700, 26, () => `Custom Note Mesh: ${(window.SSQECustom && SSQECustom.state.noteMeshName) || 'Default'}`, 30),
            btn(0, 310, 200, 50, 'LOAD MESH', 30, loadNoteMesh),
            btn(210, 310, 150, 50, 'RESET', 30, () => SSQECustom.setNoteMesh(null).catch(() => { })),
            new G.Checkbox(700, 180, 45, 45, {
                text: 'Uncap Playtest FPS', textSize: 34, style: unc,
                get: () => !!SSQESettings.load().uncapFps, set: v => playerSetting('uncapFps', v),
            }),
            new G.Checkbox(700, 240, 45, 45, {
                text: 'Disable Background Effects', textSize: 34, style: unc,
                get: () => !!SSQESettings.load().disableBgEffects, set: v => playerSetting('disableBgEffects', v),
            }),
            new G.Checkbox(700, 300, 45, 45, {
                text: 'Realistic Autoplay', textSize: 34, style: unc,
                get: () => !!SSQESettings.load().realisticAutoplay, set: v => playerSetting('realisticAutoplay', v),
            }),
            lbl(0, 400, 400, 26, 'Playtest Background:'),
            new G.Dropdown(0, 430, 400, 50, {
                options: SSQESettings.BACKGROUNDS, textSize: 30, toShow: 8,
                get: () => SSQESettings.load().background || 'None', set: i => playerSetting('background', SSQESettings.BACKGROUNDS[i]),
            }),
        ]);

        const AudioNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Mono Audio', 'monoAudio'),
            num(0, 90, 200, 50, 'maxPolyphony', { increment: 1, isPositive: true, bounds: [1, 16], style: G.Styles.Textbox_Uncolored }),
            lbl(0, 60, 200, 26, 'Maximum Polyphony:'),
        ]);

        const OtherNav = new G.Container(320, 0, 1220, 700, [
            chk(0, 0, 'Skip Download From Roblox', 'skipDownload'),
            chk(0, 60, 'Check For Updates', 'checkUpdates'),
            // desktop app: look for a new version right now, and which one this is
            ...(window.ssqeDesktop ? [
                btn(0, 130, 400, 50, 'CHECK FOR UPDATES NOW', 30, () => window.ssqeDesktop.checkForUpdatesNow()),
                lbl(0, 195, 600, 30, `Version ${window.ssqeDesktop.version}`, 28),
            ] : []),
        ]);

        const navs = [['COLORS', ColorsNav], ['GRAPHICS', GraphicsNav], ['MAPPING', MappingNav], ['PLAYER', PlayerNav], ['AUDIO', AudioNav], ['OTHER', OtherNav]];
        const navButtons = navs.map(([t], i) => new G.Button(0, i * 100, 200, 50, { text: t, textSize: 30 }));
        const NavController = new G.Container(180, 80, 200, 550, [...navButtons, ...navs.map(n => n[1])]);
        new G.Radio(navButtons, 0, active => navs.forEach(([, panel], i) => panel.visible = navButtons[i] === active));

        let resetQuery = false, resetTimer = null;
        const resetButton = btn(700, 865, 500, 50, 'RESET TO DEFAULT', 30, () => {
            if (resetQuery) {
                const fresh = SSQE.Settings.clone(SSQE.Settings.DEFAULTS);
                for (const k of Object.keys(s))
                    delete s[k];
                Object.assign(s, fresh);
                save();
                resetQuery = false;
                resetButton.text = 'RESET TO DEFAULT';
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

        const controls = [
            background(),
            NavController,
            btn(660, 930, 600, 100, 'SAVE AND RETURN', 54, () => { save(); app.showMenu(); }),
            resetButton,
            btn(700, 810, 500, 50, 'OPEN EDITOR FOLDER', 30, () => app.openEditorFolder()),
            btn(700, 755, 500, 50, 'CHANGE KEYBINDS', 30, () => app.openKeybinds()),
            btn(1270, 755, 500, 50, 'CREDITS', 30, () => { save(); app.showScreen('credits'); }),
            // web only: whether people can watch you map (SPECTATE in the menu) while you're logged in
            chk(150, 955, 'Let Others Watch Me Map', 'allowSpectators'),
            // web only: whether people can invite you to map together (COLLABORATE)
            chk(150, 1005, 'Let Others Invite Me To Collab', 'allowInvites'),
            // web only: the whole setup (editor and map player settings, background, cursor, note mesh) in one file
            btn(1270, 810, 500, 50, 'EXPORT SETUP (.SSQES)', 30, () => { save(); app.exportSetup(); }),
            btn(1270, 865, 500, 50, 'IMPORT SETUP (.SSQES)', 30, () => app.importSetup()),
        ];

        const screen = new Screen(app, controls);
        screen.update = () => {
            const max = 305;
            fpsLabel.text = `FPS Limit: ${Math.round(fpsLimit.value) === Math.round(max) ? 'Unlimited' : Math.round(fpsLimit.value + 60)}`;
            squirclePreview.cornerRadius = s.gridSquircleRadius;
        };
        return screen;
    }

    // ---------------------------------------------------------------- stats (web only)

    function stats(app) {
        const S = window.SSQEStats;
        let data = S ? S.read() : {};
        let learned = { maps: 0 }, replays = 0;
        if (window.SSQEAutoMapper)
            SSQEAutoMapper.stats().then(r => r && (learned = r)).catch(() => { });
        if (window.SSQEBot)
            SSQEBot.stats().then(r => r && (replays = r.replays || 0)).catch(() => { });
        const n = v => S.number(v), t = v => S.duration(v);
        const pct = v => `${(Number(v) || 0).toFixed(2)}%`;
        // laid out like the main menu: the title top left, the editing numbers in a dark panel on the left, the
        // playing ones in one on the right, and the button under them
        const EDITING = [
            ['Time editing', () => t(data.timeEditing)],
            ['Time in the app', () => t(data.timeInApp)],
            ['Sessions', () => n(data.sessions)],
            ['Days used', () => n(data.daysUsed)],
            ['Notes placed', () => n(data.notesPlaced)],
            ['Notes deleted', () => n(data.notesDeleted)],
            ['Maps created', () => n(data.mapsCreated)],
            ['Maps opened', () => n(data.mapsOpened)],
            ['Maps exported', () => n(data.mapsExported)],
            ['Open maps', () => n(app.openMaps.length)],
            ['Auto maps made', () => n(data.autoMaps)],
            ['Notes auto mapped', () => n(data.notesAutoMapped)],
            ['Maps learned', () => n(learned.maps)],
        ];
        const PLAYING = [
            ['Time playing', () => t(data.timePlaying)],
            ['Plays', () => n(data.plays)],
            ['Playtests', () => n(data.playtests)],
            ['Notes hit', () => n(data.notesHit)],
            ['Notes missed', () => n(data.notesMissed)],
            ['Full combos', () => n(data.fullCombos)],
            ['Best accuracy', () => pct(data.bestAccuracy)],
            ['Average accuracy', () => data.accuracyRuns ? pct(data.accuracySum / data.accuracyRuns) : '-'],
            ['Best combo', () => n(data.bestCombo)],
            ['Autoplays watched', () => n(data.watched)],
            ['Replays learned', () => n(replays)],
            ['Setups shared', () => n(data.setupsShared)],
        ];
        const values = [];
        const rows = (list, x, y, w, step) => list.flatMap(([caption, get], i) => {
            const value = new G.Label(x + w * 0.58, y + i * step, w * 0.42, 36, { text: get(), textSize: 30, centerMode: None });
            values.push([value, get]);
            return [new G.Label(x, y + i * step, w * 0.58, 36, { text: caption, textSize: 30, centerMode: None }), value];
        });
        const since = new G.Label(75, 1000, 900, 36, { text: '', textSize: 24, centerMode: None });
        const controls = [
            background(),
            new G.Square(35, 180, 950, 790, { color: [0, 0, 0, 40] }),
            new G.Square(55, 230, 900, 715, { color: [0, 0, 0, 50] }),
            new G.Square(1150, 180, 735, 670, { color: [0, 0, 0, 40] }),
            new G.Square(1170, 230, 695, 600, { color: [0, 0, 0, 50] }),
            new G.Square(0, 1040, 1920, 40, { color: [0, 0, 0, 50] }),
            new Picture(35, 4, 212, 172, { name: 'logo', align: 'left' }),
            new G.Label(262, 26, 700, 90, { text: 'QUANTUM EDITOR PLUS', textSize: 84, font: 'square', centerMode: None }),
            new G.Label(262, 118, 400, 40, { text: 'STATS', textSize: 38, font: 'square', centerMode: None }),
            new G.Label(60, 188, 400, 40, { text: 'EDITOR', textSize: 42, centerMode: None }),
            new G.Label(1175, 188, 400, 40, { text: 'PLAYER', textSize: 42, centerMode: None }),
            ...rows(EDITING, 80, 248, 850, 53),
            ...rows(PLAYING, 1195, 248, 650, 48),
            since,
            new G.Button(1190, 880, 600, 100, { text: 'BACK TO MENU', textSize: 54, onLeftClick: () => app.showMenu() }),
        ];
        const screen = new Screen(app, controls);
        let wait = 0;
        screen.update = dt => {
            // the numbers keep up while the page is open
            wait -= dt || 0.016;
            if (wait <= 0) {
                wait = 1;
                data = S ? S.read() : {};
                since.text = data.firstUsed ? `since ${data.firstUsed}` : '';
            }
            for (const [label, get] of values)
                label.text = get();
        };
        return screen;
    }

    // ---------------------------------------------------------------- credits (web only)

    function credits(app) {
        const controls = [
            background(),
            new Picture(35, 4, 160, 130, { name: 'logo', align: 'left' }),
            new G.Label(215, 22, 500, 100, { text: 'CREDITS', textSize: 96, font: 'square', centerMode: None }),
            new Picture(660, 170, 600, 600, { name: 'credits' }),
            new G.Label(160, 790, 1600, 100, { text: 'MADE BY MRBRECKEN AND DJ #FAWOREEOUT', textSize: 64, font: 'square' }),
            // (CONVERT TO MP3 uses LAME, which asks to be credited: vendor/lame.LICENSE.txt)
            new G.Label(160, 880, 1600, 40, { text: 'MP3 encoding: LAME (lame.sourceforge.net), as lamejs, under the LGPL', textSize: 24 }),
            new G.Button(660, 930, 600, 100, { text: 'BACK TO SETTINGS', textSize: 52, onLeftClick: () => app.openSettings() }),
        ];
        return new Screen(app, controls);
    }

    // ---------------------------------------------------------------- GuiWindowKeybinds

    function keybinds(app) {
        const s = app.settings;
        const unc = [[255, 255, 255], [75, 75, 75], [13, 13, 13], [52, 52, 52], [255, 255, 255]];
        const D = SSQE.Settings.KEYBINDS;
        const save = () => SSQE.Settings.save(s);
        const name = code => SSQE.Settings.keyName(code).toUpperCase();
        const cas = b => [b.ctrl && 'CTRL', b.alt && 'ALT', b.shift && 'SHIFT'].filter(Boolean).join(' + ');

        const controls = [background()];
        const keybind = (x, y, label, key) => {
            controls.push(
                new G.Label(x, y, 128, 26, { text: label, textSize: 28, centerMode: None }),
                new G.Label(x + 276, y + 30, 256, 40, { textSize: 28, centerMode: None, process() { this.text = cas(s.keybinds[key]); } }),
                new KeybindBox(x, y + 30, 128, 40, {
                    textSize: 28, getText: () => name(s.keybinds[key].key),
                    onKey: (code, ctrl, alt, shift) => { s.keybinds[key] = { key: code, ctrl, alt, shift }; save(); },
                }),
                new G.Button(x + 138, y + 30, 128, 40, { text: 'RESET', textSize: 28, onLeftClick: () => { s.keybinds[key] = { ...D[key] }; save(); } }),
            );
        };

        keybind(1366, 100, 'Horizontal Flip', 'hFlip');
        keybind(1366, 180, 'Vertical Flip', 'vFlip');
        keybind(1366, 260, 'Store Bezier Nodes', 'storeNodes');
        keybind(1366, 340, 'Anchor Bezier Node', 'anchorNode');
        keybind(1366, 420, 'Draw Bezier Curve', 'drawBezier');
        keybind(150, 100, 'Switch Click Function', 'switchClickTool');
        keybind(150, 180, 'Toggle Quantum', 'quantum');
        keybind(150, 300, 'Open Timings', 'openTimings');
        keybind(150, 380, 'Open Bookmarks', 'openBookmarks');
        keybind(150, 540, 'Export SSPM', 'exportSSPM');
        keybind(150, 620, 'Create Timing Point', 'createBPM');

        controls.push(new G.Label(778, 49, 128, 26, { text: 'Grid', textSize: 28, centerMode: None }));
        const defaults = SSQE.Settings.GRID_KEYS;
        for (let i = 0; i < 9; i++) {
            const x = 778 + (i % 3) * 138, y = 75 + Math.trunc(i / 3) * 94;
            controls.push(
                new KeybindBox(x, y, 128, 40, {
                    textSize: 28, getText: () => name(s.gridKeys[i]),
                    onKey: code => { s.gridKeys[i] = code; save(); },
                }),
                new G.Button(x, y + 44, 128, 40, { text: 'RESET', textSize: 36, onLeftClick: () => { s.gridKeys[i] = defaults[i]; save(); } }),
            );
        }

        controls.push(new G.Label(480, 375, 960, 555, {
            textSize: 20,
            text: ['Static keybinds:', '', '> Zoom: CTRL + SCROLL', '', '> Beat Divisor: SHIFT + SCROLL', '>> Hold CTRL to increment by 0.5', '',
                '> Seek: SCROLL/LEFT/RIGHT', '> Play/Pause: SPACE', '', '> Select all: CTRL + A', '> Deselect all: ESCAPE', '',
                '> Delete: DELETE/BACKSPACE', '> Copy: CTRL + C', '> Paste: CTRL + V', '> Cut: CTRL + X', '> Undo: CTRL + Z', '> Redo: CTRL + Y', '',
                '> Fullscreen: F11', '> Save: CTRL + S', '> Save as: CTRL + SHIFT + S', '', '> Place stored patterns: 0-9',
                '>> Hold SHIFT to store selected notes as the key\'s pattern', '>> Hold CTRL to clear the key\'s pattern'].join('\n'),
        }));

        const screen = new Screen(app, controls);
        const held = key => new G.Checkbox(64, 0, 64, 64, { textSize: 36, style: unc, get: () => screen.win.keys[key], set: () => { } });
        const ctrl = held('ctrl'), alt = held('alt'), shift = held('shift');
        ctrl.origin.y = 828; ctrl.text = 'CTRL Held';
        alt.origin.y = 912; alt.text = 'ALT Held';
        shift.origin.y = 996; shift.text = 'SHIFT Held';
        screen.win.root.controls.push(
            new G.Button(655, 930, 600, 100, { text: 'RETURN TO SETTINGS', textSize: 52, onLeftClick: () => app.openSettings() }),
            ctrl, alt, shift);
        screen.win.setWindowRefs(screen.win.root);
        return screen;
    }

    // ---------------------------------------------------------------- spectate (web only, see online.js)

    // the people mapping right now, to pick one to watch (spectator.js: their editor, as they see it)
    function spectate(app) {
        const O = window.SSQEOnline;
        const picks = [];
        for (let i = 0; i < 12; i++)
            picks.push(new G.Button(560, 230 + i * 62, 800, 54, {
                text: '', textSize: 30, onLeftClick: () => {
                    const m = picks[i].mapper;
                    if (m)
                        SSQE.Spectator.start(app, m);
                },
            }));
        const empty = new G.Label(560, 400, 800, 300, { text: '', textSize: 34 });
        const controls = [
            background(),
            new Picture(35, 4, 160, 130, { name: 'logo', align: 'left' }),
            new G.Label(215, 22, 700, 100, { text: 'SPECTATE', textSize: 96, font: 'square', centerMode: None }),
            new G.Label(560, 160, 800, 50, { text: 'MAPPING NOW - PICK SOMEONE TO WATCH', textSize: 36 }),
            new G.Square(530, 215, 860, 770, { color: [0, 0, 0, 40] }),
            empty, ...picks,
            new G.Button(1300, 990, 560, 70, { text: 'BACK TO MENU', textSize: 44, onLeftClick: () => app.showMenu() }),
        ];
        const screen = new Screen(app, controls);
        screen.update = () => {
            if (!O || !O.configured()) {
                picks.forEach(b => b.visible = false);
                empty.text = 'Spectating isn\'t set up\nin this version yet.';
                return;
            }
            O.joinLive();
            const list = O.liveMappers();
            picks.forEach((b, i) => {
                const m = list[i];
                b.mapper = m;
                b.visible = !!m;
                if (m)
                    b.text = `${m.name} - ${m.map}`.slice(0, 50);
            });
            empty.text = list.length ? '' : 'Nobody is mapping right now\n(or they\'ve turned watching off).';
        };
        return screen;
    }

    // ---------------------------------------------------------------- collaborate (web only, see collab.js)

    // everyone online (logged in), to invite one of them to map together
    function collaborate(app) {
        const O = window.SSQEOnline, C = window.SSQECollab;
        const rows = [];
        for (let i = 0; i < 12; i++) {
            const name = new G.Label(580, 238 + i * 62, 480, 50, { text: '', textSize: 30, centerMode: None });
            const inv = new G.Button(1090, 232 + i * 62, 240, 54, {
                text: 'INVITE', textSize: 30, onLeftClick: () => {
                    const u = rows[i].user;
                    if (u && C)
                        C.invite(u);
                },
            });
            rows.push({ name, inv, user: null });
        }
        const info = new G.Label(560, 400, 800, 300, { text: '', textSize: 34 });
        const login = new G.Button(760, 700, 400, 70, { text: 'LOG IN', textSize: 40, onLeftClick: () => app.dialogs.account() });
        const controls = [
            background(),
            new Picture(35, 4, 160, 130, { name: 'logo', align: 'left' }),
            new G.Label(215, 22, 900, 100, { text: 'COLLABORATE', textSize: 96, font: 'square', centerMode: None }),
            new G.Label(560, 160, 800, 50, { text: 'ONLINE NOW - INVITE SOMEONE TO MAP WITH YOU', textSize: 34 }),
            new G.Square(530, 215, 860, 770, { color: [0, 0, 0, 40] }),
            info, login, ...rows.flatMap(r => [r.name, r.inv]),
            new G.Label(480, 990, 800, 40, { text: 'Up to 5 people. When they accept, you pick the song and you all map it at the same time.', textSize: 22 }),
            new G.Button(1300, 990, 560, 70, { text: 'BACK TO MENU', textSize: 44, onLeftClick: () => app.showMenu() }),
        ];
        const screen = new Screen(app, controls);
        screen.update = () => {
            const ok = O && O.configured() && C;
            const inn = ok && O.loggedIn();
            login.visible = !!ok && !inn;
            const list = inn ? O.onlineUsers() : [];
            rows.forEach((r, i) => {
                const u = list[i];
                r.user = u || null;
                r.name.visible = r.inv.visible = !!u;
                if (u) {
                    r.name.text = `${u.name}${u.noInvites ? '  (invites off)' : u.busy ? '  (mapping with someone)' : ''}`.slice(0, 40);
                    const st = C.inviteState(u.id);
                    r.inv.text = st === 'sent' ? 'INVITED...' : st === 'declined' ? 'DECLINED' : 'INVITE';
                }
            });
            info.text = !ok ? 'Collaborating isn\'t set up\nin this version yet.'
                : !inn ? 'Log in to map with other people.\n(Just a username and a password.)'
                    : list.length ? '' : 'Nobody else is online right now.';
        };
        return screen;
    }

    // a guest, waiting for the host to pick the song and for it to arrive
    function collabwait(app) {
        const C = window.SSQECollab;
        const status = new G.Label(360, 420, 1200, 200, { text: '', textSize: 44 });
        const controls = [
            background(),
            new Picture(35, 4, 160, 130, { name: 'logo', align: 'left' }),
            new G.Label(215, 22, 900, 100, { text: 'COLLABORATE', textSize: 96, font: 'square', centerMode: None }),
            status,
            new G.Button(710, 760, 500, 80, { text: 'LEAVE', textSize: 44, onLeftClick: () => C && C.leave() }),
        ];
        const screen = new Screen(app, controls);
        screen.update = () => {
            status.text = C ? C.status() : '';
        };
        return screen;
    }

    SSQE.Screens = { Screen, Picture, menu, create, settings, keybinds, stats, credits, spectate, collaborate, collabwait, wrapText };
})();
