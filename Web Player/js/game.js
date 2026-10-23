'use strict';

// Port of the Sound Space Map Player (Map Player/SSQE Player) to WebGL2.
// Structure mirrors the C# sources: MainWindow (frame loop / input), GuiWindowMain (gameplay),
// Camera, GLU (line geometry), ModelManager (instanced models) and MusicPlayer/SoundPlayer.
window.SSQEGame = (function () {
    const NOTE_SIZE = [0.875, 0.875, 0.875];
    const CURSOR_SIZE = [0.2625, 0.2625, 0];

    // assets/models/note.obj (cursor.obj is identical)
    const OBJ_VERTICES = [
        [-0.776877, 0.776877, -0.115129], [-0.776877, -0.776877, -0.115129], [0.776877, 0.776877, -0.115129], [0.776877, -0.776877, -0.115129],
        [-0.776877, 0.776877, 0.115129], [-0.776877, -0.776877, 0.115129], [0.776877, 0.776877, 0.115129], [0.776877, -0.776877, 0.115129],
        [-1, -1, 0.115129], [1, -1, 0.115129], [-1, 1, -0.115129], [-1, -1, -0.115129],
        [1, 1, 0.115129], [1, 1, -0.115129], [1, -1, -0.115129], [-1, 1, 0.115129],
    ];
    const OBJ_FACES = [
        [16, 14, 11], [14, 10, 15], [12, 10, 9], [16, 12, 9], [6, 10, 8], [2, 11, 1], [8, 13, 7], [3, 15, 4],
        [5, 9, 6], [1, 14, 3], [7, 16, 5], [4, 12, 2], [8, 2, 6], [7, 4, 8], [3, 5, 1], [1, 6, 2],
        [16, 13, 14], [14, 13, 10], [12, 15, 10], [16, 11, 12], [6, 9, 10], [2, 12, 11], [8, 10, 13], [3, 14, 15],
        [5, 16, 9], [1, 11, 14], [7, 13, 16], [4, 15, 12], [8, 4, 2], [7, 3, 4], [3, 7, 5], [1, 5, 6],
    ];

    // ---------------------------------------------------------------- shaders (GUI/Shader.cs)

    const VERTEX_SHADER = `#version 300 es
layout (location = 0) in vec3 position;
layout (location = 1) in vec4 color;
out vec4 pass_color;

uniform mat4 projectionMatrix;

void main()
{
    gl_Position = projectionMatrix * vec4(position, 1.0);
    pass_color = color;
}`;

    const FRAGMENT_SHADER = `#version 300 es
precision mediump float;
in vec4 pass_color;
out vec4 out_Color;

void main()
{
    out_Color = pass_color;
}`;

    const MODEL_VERT_SHADER = `#version 300 es
layout (location = 0) in vec3 position;
layout (location = 1) in vec3 mPosition;
layout (location = 2) in vec4 mColor;
layout (location = 3) in vec3 normal;
out vec4 pass_color;

uniform mat4 transformationMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform float shade; // web only: light custom note meshes so their shape shows

void main()
{
    mat4 m = mat4(1.0);
    m[3] = vec4(mPosition, 1.0);

    vec4 worldPos = m * transformationMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
    float light = 0.5 + 0.5 * abs(normalize(normal).z) + 0.25 * max(normalize(normal).y, 0.0);
    pass_color = vec4(mColor.rgb * mix(1.0, min(light, 1.0), shade), mColor.a);
}`;

    // ---------------------------------------------------------------- math (column-major mat4)

    const mat4 = {
        identity() {
            const m = new Float32Array(16);
            m[0] = m[5] = m[10] = m[15] = 1;
            return m;
        },
        mul(a, b) {
            const o = new Float32Array(16);
            for (let c = 0; c < 4; c++)
                for (let r = 0; r < 4; r++)
                    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
            return o;
        },
        perspective(fovy, aspect, near, far) {
            const f = 1 / Math.tan(fovy / 2);
            const m = new Float32Array(16);
            m[0] = f / aspect;
            m[5] = f;
            m[10] = (far + near) / (near - far);
            m[11] = -1;
            m[14] = 2 * far * near / (near - far);
            return m;
        },
        rotationX(a) {
            const m = mat4.identity(), c = Math.cos(a), s = Math.sin(a);
            m[5] = c; m[6] = s; m[9] = -s; m[10] = c;
            return m;
        },
        rotationY(a) {
            const m = mat4.identity(), c = Math.cos(a), s = Math.sin(a);
            m[0] = c; m[2] = -s; m[8] = s; m[10] = c;
            return m;
        },
        translation(x, y, z) {
            const m = mat4.identity();
            m[12] = x; m[13] = y; m[14] = z;
            return m;
        },
        scale(s) {
            const m = mat4.identity();
            m[0] = m[5] = m[10] = s;
            return m;
        },
    };

    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const lerp2 = (a, b, t) => [(b[0] - a[0]) * t + a[0], (b[1] - a[1]) * t + a[1]];

    // ---------------------------------------------------------------- GLU.cs

    const GLU = {
        line(out, x1, y1, z1, x2, y2, z2, lw, c) {
            if (x1 !== x2) { y1 -= lw / 2; y2 += lw / 2; }
            else { x1 -= lw / 2; x2 += lw / 2; }

            out.push(
                x1, y1, z1, c[0], c[1], c[2], c[3],
                x2, y1, z1, c[0], c[1], c[2], c[3],
                x1, y2, z2, c[0], c[1], c[2], c[3],

                x2, y2, z2, c[0], c[1], c[2], c[3],
                x1, y2, z2, c[0], c[1], c[2], c[3],
                x2, y1, z1, c[0], c[1], c[2], c[3],
            );
        },
        fadingLine(out, x1, y1, z1, x2, y2, z2, lw, c) {
            if (x1 !== x2) { y1 -= lw / 2; y2 += lw / 2; }
            else { x1 -= lw / 2; x2 += lw / 2; }

            out.push(
                x1, y1, z1, c[0], c[1], c[2], c[3],
                x2, y1, z1, c[0], c[1], c[2], c[3],
                x1, y2, z2, 0, 0, 0, c[3],

                x2, y2, z2, 0, 0, 0, c[3],
                x1, y2, z2, 0, 0, 0, c[3],
                x2, y1, z1, c[0], c[1], c[2], c[3],
            );
        },
        outline(out, x, y, z, sx, sy, lw, c) {
            x -= lw / 2;
            y -= lw / 2;
            const quad = (ax, ay, bx, by, cx, cy) => out.push(
                ax, ay, z, c[0], c[1], c[2], c[3],
                bx, by, z, c[0], c[1], c[2], c[3],
                cx, cy, z, c[0], c[1], c[2], c[3],
            );

            quad(x, y, x + sx, y, x, y + lw);
            quad(x + sx, y + lw, x, y + lw, x + sx, y);
            quad(x + sx + lw, y, x + sx + lw, y + sy, x + sx, y);
            quad(x + sx, y + sy, x + sx, y, x + sx + lw, y + sy);
            quad(x + sx + lw, y + sy + lw, x + lw, y + sy + lw, x + sx + lw, y + sy);
            quad(x + lw, y + sy, x + sx + lw, y + sy, x + lw, y + sy + lw);
            quad(x, y + sy + lw, x, y + lw, x + lw, y + sy + lw);
            quad(x + lw, y + lw, x + lw, y + sy + lw, x, y + lw);
        },
    };

    // ---------------------------------------------------------------- map / replay parsing

    // MainWindow.LoadMap: "id,x|y|ms,x|y|ms,..."
    function parseMap(text, noteColors) {
        const split = text.trim().split(',');
        if (split.length < 1 || !split[0].trim())
            throw new Error('Map is empty');

        const id = split[0].trim();
        const raw = [];

        for (let i = 1; i < split.length; i++) {
            const part = split[i].trim();
            if (!part)
                continue;
            const sub = part.split('|');
            const x = parseFloat(sub[0]);
            const y = parseFloat(sub[1]);
            const ms = Math.round(parseFloat(sub[2]));

            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ms))
                throw new Error(`Invalid note #${i}: "${part}"`);
            raw.push({ x, y, ms });
        }

        raw.sort((a, b) => a.ms - b.ms);

        const colors = noteColors.map(c => [c[0] / 255, c[1] / 255, c[2] / 255]);
        const notes = raw.map((n, i) => ({ X: n.x, Y: n.y, Ms: n.ms, Color: colors[i % colors.length] }));

        return { id, notes };
    }

    // MainWindow.LoadReplay (.qer, little-endian BinaryWriter output)
    // Sound Space Plus / Rhythia replay (.sspre): "Ss*R", a version, the map's id and name on text lines, a settings line
    // ("ar:..;hbox:..;hitw:..;s:..;so:<start offset ms>"), some player settings, the end time and record count,
    // then records: a type byte and a u32 time, followed for type 0 (cursor) by the cursor's x and y.
    // Positions are mirrored from the editor's (like SSPM notes); times are from the start of the replay, which may
    // not be the start of the song (see alignReplay).
    // the "s" setting: speed mods ("+++" was measured at 1.35x and "---" at 1/1.35x)
    const SSPRE_SPEEDS = { '': 1, '+': 1.15, '++': 1.25, '+++': 1.35, '++++': 1.45, '-': 1 / 1.15, '--': 1 / 1.25, '---': 1 / 1.35 };

    function parseSspre(buffer) {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        const decoder = new TextDecoder();
        let o = 4;
        const version = view.getUint16(o, true);
        o = 6;
        while (o < bytes.length && bytes[o] === 0)
            o++;
        const line = () => {
            let e = o;
            while (e < bytes.length && bytes[e] !== 0x0a)
                e++;
            const text = decoder.decode(bytes.subarray(o, e));
            o = e + 1;
            return text;
        };
        const mapId = line();
        const name = line();
        const settings = {};
        for (const part of line().split(';')) {
            const [k, v] = part.split(':');
            if (k)
                settings[k] = v;
        }

        // 8 floats of player settings, a u16, the end time and the record count
        o += 32 + 2;
        const endMs = view.getUint32(o, true);
        o += 8;

        const cursor = [];
        const events = [];
        while (o + 5 <= bytes.length) {
            const type = bytes[o];
            const ms = view.getUint32(o + 1, true);
            if (type === 0) {
                if (o + 13 > bytes.length)
                    break;
                cursor.push({ X: 2 - view.getFloat32(o + 5, true), Y: 2 - view.getFloat32(o + 9, true), Ms: ms });
                o += 13;
            } else {
                // type 1 = note hit, 2 = note miss (value = note index), others are markers; "at" is the replay
                // time of the cursor record before it
                const last = cursor[cursor.length - 1];
                events.push({ type, value: ms, at: last ? last.Ms : 0, x: last ? last.X : 1, y: last ? last.Y : 1 });
                o += 5;
            }
        }
        if (!cursor.length)
            throw new Error('This replay has no cursor data');

        const startOffset = parseFloat(settings.so) || 0;
        return {
            format: 'sspre', version, mapId, name, settings, endMs, events,
            tempo: SSPRE_SPEEDS[settings.s] || 1,
            cursor, skips: [], startOffset,
        };
    }

    // Replay times are real time from the start of the replay, while the map is in song time: the replay may start
    // part way into the song and the song may have been sped up or slowed down. Newer replays record which notes were
    // hit, which gives the mapping directly; older ones are matched by searching for the speed and start that put the
    // cursor on the notes. Returns a copy of the replay in song time, with the tempo it was played at.
    function alignReplay(replay, notes) {
        if (!notes.length || replay.format !== 'sspre')
            return replay;
        const cursor = replay.cursor;
        const convert = (tempo, shift) => cursor.map(c => ({ X: c.X, Y: c.Y, Ms: c.Ms * tempo + shift }));

        const noteTimes = notes.map(n => n.Ms);
        const firstAtOrAfter = ms => {
            let lo = 0, hi = noteTimes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (noteTimes[mid] < ms)
                    lo = mid + 1;
                else
                    hi = mid;
            }
            return lo;
        };
        // the note within `window` ms of song time t that the cursor (x, y) is on, if any
        const noteAt = (t, x, y, window) => {
            for (let i = firstAtOrAfter(t - window); i < notes.length && noteTimes[i] <= t + window; i++)
                if (Math.abs(notes[i].X - x) < 0.6 && Math.abs(notes[i].Y - y) < 0.6)
                    return notes[i];
            return null;
        };
        const fitLine = pairs => {
            const n = pairs.length;
            const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
            const slope = pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
            const icpt = my - slope * mx;
            const resid = pairs.map(p => Math.abs(p[1] - (slope * p[0] + icpt))).sort((a, b) => a - b)[n >> 1];
            return { slope, icpt, resid };
        };

        // 1. newer replays record each hit: find the speed and start that put those hits on notes the cursor is over,
        // then fit replay time = song time / tempo + start through the matched pairs. Skips (type 9) jump the song
        // forward, so each stretch between skips gets its own start, and the replay's skips jump to exactly there.
        const hitEvents = replay.events.filter(e => e.type === 1);
        if (hitEvents.length >= 20) {
            const thin = (list, n) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0);
            const countHits = (list, tempo, shift, window = 40) => {
                let hits = 0;
                for (const e of list)
                    if (noteAt(e.at * tempo + shift, e.x, e.y, window))
                        hits++;
                return hits;
            };
            const searchShift = (list, tempo, from, to) => {
                const sample = thin(list, 200);
                let best = { shift: from, hits: -1 };
                for (let shift = from; shift <= to; shift += 10) {
                    const hits = countHits(sample, tempo, shift);
                    if (hits > best.hits)
                        best = { shift, hits };
                }
                return best;
            };
            const pairsFor = (list, tempo, shift) => {
                const pairs = [];
                for (const e of list) {
                    const n = noteAt(e.at * tempo + shift, e.x, e.y, 60);
                    if (n)
                        pairs.push([n.Ms, e.at]);
                }
                return pairs;
            };

            // the stretches between skips
            const skipTimes = replay.events.filter(e => e.type === 9).map(e => e.at).sort((a, b) => a - b);
            const bounds = [-Infinity, ...skipTimes, Infinity];
            const segments = [];
            for (let i = 0; i < bounds.length - 1; i++) {
                const hits = hitEvents.filter(e => e.at >= bounds[i] && e.at < bounds[i + 1]);
                if (hits.length >= 5)
                    segments.push({ start: bounds[i], hits });
            }

            // speed: from the replay's settings if it fits the longest stretch, otherwise the best of the known speeds
            const longest = segments.reduce((a, b) => b.hits.length > a.hits.length ? b : a, segments[0]);
            const so = replay.startOffset || 0;
            const speed = replay.tempo || 1;
            let tempo = speed, found = null;
            for (const t of [speed, ...Object.values(SSPRE_SPEEDS).filter(t => t !== speed)]) {
                const r = searchShift(longest.hits, t, so - 10000, notes[notes.length - 1].Ms);
                if (!found || r.hits > found.hits) {
                    found = r;
                    tempo = t;
                }
                if (r.hits > Math.min(200, longest.hits.length) * 0.6)
                    break;
            }
            const longPairs = pairsFor(longest.hits, tempo, found.shift);
            if (longPairs.length >= 10) {
                const f = fitLine(longPairs);
                if (f.slope > 0.2 && f.slope < 5 && f.resid < 60)
                    tempo = 1 / f.slope;
            }

            // each stretch's start, in order (the song only moves forward)
            let prev = so - 10000, matched = 0;
            for (const seg of segments) {
                const coarse = seg === longest ? found : searchShift(seg.hits, tempo, prev - 2000, prev + 150000 + (seg === segments[0] ? notes[notes.length - 1].Ms : 0));
                const diffs = pairsFor(seg.hits, tempo, coarse.shift).map(p => p[0] - p[1] * tempo).sort((a, b) => a - b);
                seg.shift = diffs.length ? diffs[diffs.length >> 1] : coarse.shift;
                matched += diffs.length;
                prev = seg.shift;
            }

            if (matched >= hitEvents.length * 0.3) {
                // cursor and skips in song time: each stretch uses its own start, and a skip fires when the song
                // reaches the end of the stretch before it
                const shiftAt = at => {
                    let shift = segments[0].shift;
                    for (const seg of segments)
                        if (at >= seg.start)
                            shift = seg.shift;
                    return shift;
                };
                const skips = segments.slice(1).map((seg, i) => ({ X: 0, Y: 0, Ms: seg.start * tempo + segments[i].shift, To: seg.start * tempo + seg.shift }));
                return {
                    ...replay, tempo, skips, songTime: true,
                    alignment: { tempo, shift: segments[0].shift, matched: matched / hitEvents.length, from: 'hits', sections: segments.map(sg => Math.round(sg.shift)) },
                    cursor: cursor.map(c => ({ X: c.X, Y: c.Y, Ms: c.Ms * tempo + shiftAt(c.Ms) })),
                };
            }
        }

        // 2. search: score how often the cursor is on a note at the note's time
        const times = cursor.map(c => c.Ms);
        const at = ms => {
            let lo = 0, hi = times.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (times[mid] <= ms)
                    lo = mid;
                else
                    hi = mid - 1;
            }
            return cursor[lo];
        };
        const step = Math.max(1, Math.floor(notes.length / 300));
        const sample = notes.filter((_, i) => i % step === 0);
        const score = (tempo, shift) => {
            let hits = 0;
            for (const n of sample) {
                const t = (n.Ms - shift) / tempo;
                if (t < times[0] || t > times[times.length - 1])
                    continue;
                const c = at(t);
                if (Math.abs(c.X - n.X) < 0.6 && Math.abs(c.Y - n.Y) < 0.6)
                    hits++;
            }
            return hits;
        };

        const lastNote = notes[notes.length - 1].Ms;
        const tempos = [1, 1 / 1.35, 0.75, 0.8, 0.85, 0.9, 1.15, 1.25, 1.35, 1.45];
        let best = { tempo: 1, shift: 0, hits: -1 };
        for (const tempo of tempos)
            for (let shift = -5000; shift <= lastNote; shift += 50) {
                const hits = score(tempo, shift);
                if (hits > best.hits)
                    best = { tempo, shift, hits };
            }
        for (let shift = best.shift - 50; shift <= best.shift + 50; shift++) {
            const hits = score(best.tempo, shift);
            if (hits > best.hits)
                best = { ...best, shift, hits };
        }

        return {
            ...replay,
            tempo: best.tempo,
            alignment: { tempo: best.tempo, shift: best.shift, matched: best.hits / sample.length, from: 'search' },
            cursor: convert(best.tempo, best.shift),
        };
    }

    function parseReplay(buffer) {
        if (new TextDecoder().decode(new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength))) === 'Ss*R')
            return parseSspre(buffer);

        const view = new DataView(buffer);
        let o = 0;
        const f32 = () => { const v = view.getFloat32(o, true); o += 4; return v; };
        const i32 = () => { const v = view.getInt32(o, true); o += 4; return v; };

        const tempo = f32();

        const cursorCount = i32();
        const cursor = new Array(cursorCount);
        for (let i = 0; i < cursorCount; i++)
            cursor[i] = { X: f32(), Y: f32(), Ms: i32() };

        const skipCount = i32();
        const skips = new Array(skipCount);
        for (let i = 0; i < skipCount; i++)
            skips[i] = { X: 0, Y: 0, Ms: i32() };

        return { tempo, cursor, skips };
    }

    // ---------------------------------------------------------------- audio (Audio/*.cs)

    const VOLUME_MULT = 2;

    // iOS only lets a media element start playing from a tap or click, but the music starts after the map and audio
    // have loaded. One element is unlocked on the first tap, click or key press and reused for every game.
    const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    let sharedAudio = null;
    function sharedAudioElement() {
        if (!sharedAudio) {
            sharedAudio = new Audio();
            sharedAudio.preload = 'auto';
            sharedAudio.setAttribute('playsinline', '');
        }
        return sharedAudio;
    }
    function unlockAudio() {
        const a = sharedAudioElement();
        if (a.dataset.unlocked || (a.src && !a.src.startsWith('data:')))
            return;
        a.src = SILENT_WAV;
        const p = a.play();
        if (p && p.then)
            p.then(() => {
                a.pause();
                a.dataset.unlocked = '1';
            }).catch(() => { });
    }
    for (const type of ['touchend', 'click', 'keydown'])
        window.addEventListener(type, unlockAudio, true);

    // loads a song file into the shared element; resolves once its length is known
    function loadAudio(file) {
        return new Promise((resolve, reject) => {
            const a = sharedAudioElement();
            if (a.src && a.src.startsWith('blob:'))
                URL.revokeObjectURL(a.src);
            a.onloadedmetadata = () => {
                a.onloadedmetadata = a.onerror = null;
                resolve(a);
            };
            a.onerror = () => {
                a.onloadedmetadata = a.onerror = null;
                reject(new Error(`${file.name || 'The audio'} could not be decoded by this browser`));
            };
            a.src = URL.createObjectURL(file);
            a.load();
            // iOS may not load anything until the element is played; carry on and let the game find the length later
            setTimeout(() => {
                if (a.onloadedmetadata) {
                    a.onloadedmetadata = a.onerror = null;
                    resolve(a);
                }
            }, 4000);
        });
    }

    // Plays the song either from the decoded audio (exact seeking, no media element restrictions on iOS) or, when the
    // tempo isn't 100% and an element is available, from the <audio> element so the pitch stays the same.
    class MusicPlayer {
        constructor(game, audioCtx, element, fallbackDuration, buffer = null) {
            this.game = game;
            this.ctx = audioCtx;
            this.el = element;
            this.buffer = buffer;
            this.node = null;       // AudioBufferSourceNode while the decoded audio plays
            this.state = 'stopped';
            this.pos = 0;           // media position in seconds
            this.basePos = 0;
            this.basePerf = 0;
            this.baseCtx = 0;
            this.started = false;   // whether the media clock is actually running yet
            this.elFailed = false;  // the element refused to play (no user gesture): keep time with the clock
            this.tempo = 1;
            this.duration = buffer ? buffer.duration : element && Number.isFinite(element.duration) ? element.duration : fallbackDuration;
            this.ended = false;

            if (element || buffer) {
                this.gain = audioCtx.createGain();
                if (game.settings.monoAudio) {
                    this.gain.channelCount = 1;
                    this.gain.channelCountMode = 'explicit';
                    this.gain.channelInterpretation = 'speakers';
                }
                this.gain.connect(audioCtx.destination);
            }

            if (element) {
                element.preservesPitch = true;
                element.mozPreservesPitch = true;
                element.webkitPreservesPitch = true;

                // an element can only be wired into an audio context once, so the source node is kept on it
                if (!element._ssqeSource || element._ssqeCtx !== audioCtx) {
                    element._ssqeSource = audioCtx.createMediaElementSource(element);
                    element._ssqeCtx = audioCtx;
                }
                this.source = element._ssqeSource;
                try { this.source.disconnect(); } catch { }
                this.source.connect(this.gain);

                this.onPlaying = () => {
                    if (this.state === 'playing' && !this.node) {
                        this.basePos = element.currentTime;
                        this.basePerf = performance.now();
                        this.started = true;
                    }
                };
                this.onEnded = () => { this.ended = true; };
                element.addEventListener('playing', this.onPlaying);
                element.addEventListener('ended', this.onEnded);
            }
        }

        // MusicPlayer.MusicOffset
        get offset() {
            return (this.game.settings.musicOffset - 28) / 1000;
        }

        set volume(v) {
            if (this.gain)
                this.gain.gain.value = Math.max(v * VOLUME_MULT, 0);
        }

        get isPlaying() {
            return this.state === 'playing';
        }

        get useBuffer() {
            return !!this.buffer && (!this.el || Math.abs(this.tempo - 1) < 1e-6);
        }

        startBuffer() {
            this.stopBuffer();
            const node = this.ctx.createBufferSource();
            node.buffer = this.buffer;
            node.playbackRate.value = this.tempo;
            node.connect(this.gain);
            node.start(0, clamp(this.pos, 0, this.duration));
            this.node = node;
            this.basePos = this.pos;
            this.basePerf = performance.now();
            this.baseCtx = this.ctx.currentTime;
            this.started = true;
        }

        stopBuffer() {
            if (!this.node)
                return;
            try { this.node.stop(); } catch { }
            try { this.node.disconnect(); } catch { }
            this.node = null;
        }

        setTempo(t) {
            if (this.node) {
                this.pos = this.mediaPos();
                this.tempo = t;
                this.startBuffer();
            }
            this.tempo = t;
            if (this.el)
                this.el.playbackRate = t;
        }

        seekMs(ms) {
            const p = clamp(ms / 1000 - this.offset, 0, this.duration);
            this.pos = p;
            this.basePos = p;
            this.basePerf = performance.now();
            if (this.node)
                this.startBuffer();
            else if (this.el && !this.elFailed)
                this.el.currentTime = p;
        }

        mediaPos() {
            if (this.state !== 'playing')
                return this.pos;

            if (this.node) {
                // the audio clock while it runs, the system clock if the context is suspended (iOS interruptions)
                const elapsed = this.ctx.state === 'running' ? this.ctx.currentTime - this.baseCtx : (performance.now() - this.basePerf) / 1000;
                let p = this.basePos + elapsed * this.tempo;
                if (p >= this.duration) {
                    this.ended = true;
                    p = this.duration;
                }
                return p;
            }

            if (this.el && !this.started && !this.elFailed) {
                // some browsers don't fire 'playing' after a seek; treat the clock moving as started
                if (!this.el.paused && this.el.currentTime > this.basePos + 0.02) {
                    this.basePos = this.el.currentTime;
                    this.basePerf = performance.now();
                    this.started = true;
                }
                return this.basePos;
            }

            let p = this.basePos + (performance.now() - this.basePerf) / 1000 * this.tempo;

            if (this.el && !this.elFailed) {
                // interpolate between the element's coarse currentTime updates, resyncing on drift
                const real = this.el.currentTime;
                if (!this.el.seeking && Math.abs(real - p) > 0.075) {
                    this.basePos = real;
                    this.basePerf = performance.now();
                    p = real;
                }
            } else if (p >= this.duration) {
                this.ended = true;
                p = this.duration;
            }

            return p;
        }

        // MusicPlayer.CurrentTime (ms)
        currentTimeMs() {
            return (this.mediaPos() + this.offset) * 1000;
        }

        play() {
            this.seekMs(this.game.currentTime);
            this.state = 'playing';
            this.started = false;
            if (this.ctx.state === 'suspended')
                this.ctx.resume().catch(() => { });

            if (this.useBuffer) {
                this.startBuffer();
                return;
            }
            if (this.el && !this.elFailed) {
                this.el.playbackRate = this.tempo;
                const p = this.el.play();
                if (p)
                    p.catch(() => {
                        // not allowed to play (iOS without a tap): the map still runs, just silently
                        this.elFailed = true;
                        this.basePos = this.pos;
                        this.basePerf = performance.now();
                        this.started = true;
                    });
            } else {
                this.basePerf = performance.now();
                this.started = true;
            }
        }

        pause() {
            this.game.currentTime = this.currentTimeMs();
            this.pos = this.mediaPos();
            this.state = 'paused';
            this.stopBuffer();
            if (this.el)
                this.el.pause();
        }

        stop() {
            this.stopBuffer();
            if (this.el)
                this.el.pause();
            this.state = 'stopped';
            this.seekMs(0);
        }

        dispose() {
            this.stopBuffer();
            if (this.el) {
                this.el.pause();
                this.el.removeEventListener('playing', this.onPlaying);
                this.el.removeEventListener('ended', this.onEnded);
                try { this.source.disconnect(); } catch { }
            }
            try { this.gain && this.gain.disconnect(); } catch { }
        }
    }

    class SoundPlayer {
        constructor(audioCtx, buffer, settings) {
            this.ctx = audioCtx;
            this.buffer = buffer;
            this.settings = settings;
        }

        play() {
            if (!this.buffer || this.settings.muteSfx)
                return;
            const src = this.ctx.createBufferSource();
            src.buffer = this.buffer;
            const gain = this.ctx.createGain();
            gain.gain.value = Math.max(this.settings.sfxVolume * VOLUME_MULT, 0);
            src.connect(gain);
            gain.connect(this.ctx.destination);
            src.start();
        }
    }

    // ---------------------------------------------------------------- GL helpers

    function compileShader(gl, vertSrc, fragSrc) {
        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                throw new Error(gl.getShaderInfoLog(s));
            return s;
        };
        const vs = compile(gl.VERTEX_SHADER, vertSrc);
        const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS))
            throw new Error(gl.getProgramInfoLog(program));
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        return program;
    }

    // Models/Model.cs + ModelManager.cs
    // custom: flat triangle positions from a user's .obj (web only)
    function createModel(gl, scaleSetting, custom = null) {
        let verts = [];
        if (custom)
            verts = custom;
        else
            for (const face of OBJ_FACES)
                for (const idx of face)
                    verts.push(...OBJ_VERTICES[idx - 1]);

        const normals = new Float32Array(verts.length);
        for (let i = 0; i + 8 < verts.length; i += 9) {
            const a = [verts[i + 3] - verts[i], verts[i + 4] - verts[i + 1], verts[i + 5] - verts[i + 2]];
            const b = [verts[i + 6] - verts[i], verts[i + 7] - verts[i + 1], verts[i + 8] - verts[i + 2]];
            const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
            const l = Math.hypot(...n) || 1;
            for (let k = 0; k < 9; k++)
                normals[i + k] = n[k % 3] / l;
        }

        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < verts.length; i += 3)
            for (let a = 0; a < 3; a++) {
                min[a] = Math.min(min[a], verts[i + a]);
                max[a] = Math.max(max[a], verts[i + a]);
            }

        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const vbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
        gl.enableVertexAttribArray(0);

        const normalVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, normalVbo);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
        gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 12, 0);
        gl.enableVertexAttribArray(3);

        const posVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posVbo);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 12, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribDivisor(1, 1);

        const colVbo = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, colVbo);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribDivisor(2, 1);

        gl.bindVertexArray(null);

        return {
            vao, posVbo, colVbo, custom: !!custom,
            vertexCount: verts.length / 3,
            size: [0, 1, 2].map(a => (max[a] - min[a]) / scaleSetting),
        };
    }

    // ---------------------------------------------------------------- Camera.cs

    class Camera {
        constructor(game) {
            const s = game.settings;
            this.game = game;
            this.rotation = [0, Math.PI];
            this.projection = mat4.identity();
            this.view = mat4.identity();
            this.lookVector = [0, 0, 1];
            this.cameraPos = [0, 0, -3.5];
            this.camOffset = [0, 0, 0];

            this.rad88 = 88 * Math.PI / 180;
            this.radFoV = s.fov * Math.PI / 180;
            this.camMode = s.cameraMode;
            this.lockCursor = s.lockCursor;
            this.sensitivity = s.sensitivity;
            this.parallax = s.parallax;

            this.LockedPos = [0, 0];
        }

        update() {
            const rot = mat4.mul(mat4.rotationX(this.rotation[0]), mat4.rotationY(this.rotation[1]));

            // inverse rotation (transpose) applied to -Z
            this.lookVector = [-rot[2], -rot[6], -rot[10]];
            const lv = this.lookVector;
            this.cameraPos = [lv[0] * 1.25 + this.camOffset[0], lv[1] * 1.25 + this.camOffset[1], -3.5 + this.camOffset[2]];

            const cp = this.cameraPos;
            this.view = mat4.mul(rot, mat4.translation(-cp[0], -cp[1], -cp[2]));

            // update cursor
            let pos;
            if (this.camMode === 'spin') {
                const d = Math.abs(Math.abs(cp[2] + 0.15) / lv[2]);
                pos = [cp[0] + lv[0] * d, cp[1] + lv[1] * d];
            } else
                pos = this.LockedPos;

            const xf = clamp(pos[0], -1.5 + CURSOR_SIZE[0] / 2, 1.5 - CURSOR_SIZE[0] / 2);
            const yf = clamp(pos[1], -1.5 + CURSOR_SIZE[1] / 2, 1.5 - CURSOR_SIZE[1] / 2);

            this.game.CursorPos = [xf, yf, 0];
        }

        applyLocked() {
            const xf = clamp(this.LockedPos[0], -1.5 + CURSOR_SIZE[0] / 2, 1.5 - CURSOR_SIZE[0] / 2);
            const yf = clamp(this.LockedPos[1], -1.5 + CURSOR_SIZE[1] / 2, 1.5 - CURSOR_SIZE[1] / 2);

            if (this.lockCursor)
                this.LockedPos = [xf, yf];

            if (this.camMode === 'half lock')
                this.camOffset = [xf * this.parallax / 5, yf * this.parallax / 5, 0];
        }

        setReplay(mouse) {
            if (this.camMode === 'spin')
                this.rotation = [clamp(-mouse[1] / 4.6, -this.rad88, this.rad88), Math.PI - mouse[0] / 4.6];
            else {
                this.LockedPos = [mouse[0], mouse[1]];
                this.applyLocked();
            }
            this.update();
        }

        setMouse(dx, dy) {
            if (this.camMode === 'spin')
                this.rotation = [
                    clamp(this.rotation[0] + dy / 1000 * this.sensitivity, -this.rad88, this.rad88),
                    this.rotation[1] + dx / 1000 * this.sensitivity,
                ];
            else {
                this.LockedPos = [this.LockedPos[0] - dx / 250 * this.sensitivity, this.LockedPos[1] - dy / 250 * this.sensitivity];
                this.applyLocked();
            }
            this.update();
        }

        calculateProjection(width, height) {
            this.projection = mat4.perspective(this.radFoV, width / height, 0.1, 1000);
        }
    }

    // ---------------------------------------------------------------- MainWindow + GuiWindowMain

    class Game {
        // opts: { canvas, overlay, settings, mapText, audioElement, audioCtx, hitBuffer, replayBuffer, mode, startTime, fromStart, onExit }
        constructor(opts) {
            this.opts = opts;
            this.settings = opts.settings;
            this.statsStart = performance.now();
            const s = this.settings;

            this.Replay = opts.mode === 'replay' && !!opts.replayBuffer;
            this.Autoplay = opts.mode === 'autoplay' && !this.Replay;
            // web only: a bot that moves like a person and is judged like one (bot.js)
            this.AutoIndex = 0;

            this.canvas = opts.canvas;
            this.overlay = opts.overlay;
            this.ctx2d = this.overlay.getContext('2d');

            // (web only, for speed: no multisampling on a high-density screen like a MacBook's, where it was 4x the
            // work on 4x the pixels and the edges are already too fine to see steps in)
            const gl = this.canvas.getContext('webgl2', { antialias: (window.devicePixelRatio || 1) < 1.75, alpha: false, preserveDrawingBuffer: false });
            if (!gl)
                throw new Error('WebGL2 is not supported by this browser');
            this.gl = gl;

            const { id, notes } = parseMap(opts.mapText, s.noteColors);
            this.mapId = id;
            this.Notes = notes;
            this.CursorNodes = [];
            this.SkipNodes = [];

            this.CursorPos = [0, 0, 0];
            this.LastCursorPos = [0, 0, 0];

            const lastMs = notes.length ? notes[notes.length - 1].Ms : 0;
            const fallbackDuration = (lastMs + 2000) / 1000;

            this.music = new MusicPlayer(this, opts.audioCtx, opts.audioElement, fallbackDuration, opts.audioBuffer || null);
            this.sound = new SoundPlayer(opts.audioCtx, opts.hitBuffer, s);
            this.timeMax = this.music.duration * 1000; // Settings.currentTime.Max

            // startup (MainWindow constructor)
            this.currentTime = opts.fromStart ? 0 : clamp(opts.startTime || 0, 0, this.timeMax);
            this.StartTime = this.currentTime;

            let startIndex = 0;
            for (const n of notes)
                if (n.Ms < this.currentTime)
                    startIndex++;

            this.initGL();

            this.music.volume = s.masterVolume;
            this.setTempo(s.tempo);
            if (this.Replay)
                this.loadReplay(opts.replayBuffer);

            // web only: with Realistic Autoplay on, autoplay is done by the bot (bot.js)
            const realistic = opts.mode === 'bot' || (this.Autoplay && s.realisticAutoplay);
            this.Bot = realistic && window.SSQEBot ? new SSQEBot.Driver(notes, s.botSkill) : null;
            if (this.Bot)
                this.Autoplay = false;

            this.Camera = new Camera(this);
            this.initWindow(startIndex);

            this.time = -65;
            this.ReplayCursorIndex = 0;
            this.ReplaySkipIndex = 0;

            this.mouseDX = 0;
            this.mouseDY = 0;
            this.running = false;
            this.closed = false;
        }

        // ------------------------------------------------ setup

        initGL() {
            const gl = this.gl;
            const s = this.settings;

            this.program = compileShader(gl, VERTEX_SHADER, FRAGMENT_SHADER);
            this.modelProgram = compileShader(gl, MODEL_VERT_SHADER, FRAGMENT_SHADER);

            this.uniforms = {
                vertexProjection: gl.getUniformLocation(this.program, 'projectionMatrix'),
                modelTransformation: gl.getUniformLocation(this.modelProgram, 'transformationMatrix'),
                modelProjection: gl.getUniformLocation(this.modelProgram, 'projectionMatrix'),
                modelView: gl.getUniformLocation(this.modelProgram, 'viewMatrix'),
                modelShade: gl.getUniformLocation(this.modelProgram, 'shade'),
            };

            // RegisterModels
            const custom = window.SSQECustom && SSQECustom.state.noteMesh;
            this.noteModel = createModel(gl, s.noteScale, custom || null);
            this.cursorModel = createModel(gl, s.cursorScale);

            // dynamic line geometry (GuiWindowMain.Init)
            this.lineVao = gl.createVertexArray();
            this.lineVbo = gl.createBuffer();
            gl.bindVertexArray(this.lineVao);
            gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
            gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 28, 0);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 28, 12);
            gl.enableVertexAttribArray(1);
            gl.bindVertexArray(null);

            // web only: a 3D background world behind the grid
            this.world = null;
            if (window.SSQEWorlds && s.background && s.background !== 'None')
                try {
                    this.world = SSQEWorlds.create(gl, {
                        name: s.background,
                        color: this.Notes.length ? this.Notes[0].Color : [1, 1, 1],
                        speed: () => this.NoteSpeed * 0.17,
                        effects: !s.disableBgEffects,
                    });
                } catch (e) {
                    console.warn('The background could not be created', e);
                }

            // OnLoad
            const clear = this.world ? this.world.clearColor : [0, 0, 0];
            gl.clearColor(clear[0], clear[1], clear[2], 1);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.enable(gl.DEPTH_TEST);
            gl.enable(gl.CULL_FACE);
            gl.cullFace(gl.BACK);
        }

        initWindow(startIndex) {
            const s = this.settings;

            this.misses = 0;
            this.hits = 0;
            this.combo = 0;
            this.maxCombo = 0;

            this.health = 10;
            this.maxHealth = this.health;
            this.healthRegen = 1;
            this.healthPenalty = 2;
            this.healthColor = [0, 1, 0, 1];

            this.waitTimer = 2000 * this.Tempo;
            this.started = false;

            this.Resetting = false;
            this.resetTimer = 0;

            this.Paused = false;
            this.Unpausing = false;
            this.Pauses = 0;
            this.PauseTime = -Number.MAX_VALUE;

            this.frames = 0;
            this.fpsTime = 0;
            this.fpsText = '';
            this.startIndex = startIndex;
            this.Offset = 0;
            this.frameHit = 0;

            this.noteSet = new Uint8Array(this.Notes.length + 1);
            for (let i = startIndex; i < this.noteSet.length; i++)
                this.noteSet[i] = 1;

            this.hitWindow = Math.trunc(s.hitWindow);
            const tempo = Math.round(this.Tempo * 10000) / 100;

            let hwText = '';
            if (this.hitWindow !== 55)
                hwText = `HW: ${this.hitWindow}ms`;
            if (tempo !== 100)
                hwText += (this.hitWindow !== 55 ? ' | ' : '') + `Tempo: ${+tempo.toFixed(2)}%`;
            this.hitWindowTempoText = hwText;

            const minScale = (size, model, extra = 0) => Math.min(1, size[0] / model.size[0], size[1] / model.size[1], (size[2] + extra) / model.size[2]);
            this.noteScaleMatrix = mat4.scale(minScale(NOTE_SIZE, this.noteModel));
            this.cursorScaleValue = minScale(CURSOR_SIZE, this.cursorModel, 0.05);

            this.positions = new Float32Array(32 * 3);
            this.colors = new Float32Array(32 * 4);
        }

        setTempo(value) {
            this.confirmTempo(SSQESettings.tempoFromSlider(value));
        }

        confirmTempo(t) {
            this.Tempo = t;
            this.music.setTempo(t);
        }

        loadReplay(buffer) {
            const r = buffer instanceof ArrayBuffer ? parseReplay(buffer) : buffer;
            this.confirmTempo(r.tempo);
            this.CursorNodes = r.cursor;
            this.SkipNodes = r.skips;
            // .sspre replays are kept in song time, so the cursor can't drift from the music
            this.ReplaySongTime = !!r.songTime;
            this.ReplayHitWindow = (r.settings && parseFloat(r.settings.hitw)) || this.hitWindow || 55;
        }

        get SpawnZ() {
            return this.settings.approachDistance * 25;
        }

        get NoteSpeed() {
            return (this.settings.playerApproachRate + 1) * 2.5 / this.Tempo;
        }

        // ------------------------------------------------ lifecycle

        start() {
            this.running = true;
            this.attachInput();
            this.resize();
            this.Camera.update();
            this.lastFrame = performance.now();
            this.schedule();
        }

        close() {
            if (this.closed)
                return;
            this.closed = true;
            this.running = false;
            cancelAnimationFrame(this.raf);
            this.detachInput();
            this.music.dispose();
            if (this.world)
                this.world.dispose();

            const gl = this.gl;
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.ctx2d.clearRect(0, 0, this.overlay.width, this.overlay.height);

            if (document.pointerLockElement)
                document.exitPointerLock();

            // (for the STATS page)
            if (window.SSQEStats)
                SSQEStats.recordPlay({
                    hits: this.hits, misses: this.misses, maxCombo: this.maxCombo,
                    mode: this.Replay ? 'replay' : this.Autoplay ? 'autoplay' : this.Bot ? 'realistic autoplay' : 'play',
                    seconds: (performance.now() - this.statsStart) / 1000,
                });
            this.opts.onExit && this.opts.onExit({
                accuracy: this.calculateAccuracy(),
                hits: this.hits,
                misses: this.misses,
                maxCombo: this.maxCombo,
                pauses: this.Pauses,
                mode: this.Replay ? 'replay' : this.Autoplay ? 'autoplay' : this.Bot ? 'realistic autoplay' : 'play',
            });
        }

        // ------------------------------------------------ input (MainWindow On* handlers)

        attachInput() {
            this.handlers = {
                mousemove: e => { this.mouseDX += e.movementX; this.mouseDY += e.movementY; },
                mousedown: e => {
                    if (e.button === 0 && !this.Replay && !this.Autoplay && !this.Bot && document.pointerLockElement !== this.canvas)
                        this.lockPointer();
                },
                keydown: e => this.onKeyDown(e),
                keyup: e => this.onKeyUp(e),
                wheel: e => {
                    e.preventDefault();
                    if (e.deltaY !== 0)
                        this.Offset += e.deltaY < 0 ? 1 : -1;
                },
                resize: () => this.resize(),
                contextmenu: e => e.preventDefault(),
            };

            // touch screens: drag anywhere to move the cursor (like a trackpad), with buttons for the keyboard keys
            let lastTouch = null;
            const key = code => ({ code, repeat: false, ctrlKey: false, preventDefault() { } });
            this.handlers.touchstart = e => {
                e.preventDefault();
                const t = e.changedTouches[0];
                lastTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
            };
            this.handlers.touchmove = e => {
                e.preventDefault();
                const t = lastTouch && [...e.touches].find(t => t.identifier === lastTouch.id);
                if (!t)
                    return;
                // half the short side of the screen moves the cursor across the grid at sensitivity 1
                const k = 1500 / Math.min(window.innerWidth, window.innerHeight);
                this.mouseDX += (t.clientX - lastTouch.x) * k;
                this.mouseDY += (t.clientY - lastTouch.y) * k;
                lastTouch.x = t.clientX;
                lastTouch.y = t.clientY;
            };
            this.handlers.touchend = e => {
                e.preventDefault();
                if (lastTouch && [...e.changedTouches].some(t => t.identifier === lastTouch.id))
                    lastTouch = null;
            };
            for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
                this.canvas.addEventListener(type, this.handlers[type === 'touchcancel' ? 'touchend' : type], { passive: false });
            this.canvas.style.touchAction = 'none';

            if (window.matchMedia && matchMedia('(pointer: coarse)').matches) {
                const button = (text, title, down, up) => {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.textContent = text;
                    b.title = title;
                    Object.assign(b.style, {
                        width: '56px', height: '56px', border: '2px solid rgba(255,255,255,0.35)', borderRadius: '12px',
                        background: 'rgba(0,0,0,0.35)', color: '#fff', font: '24px sans-serif', touchAction: 'none', padding: '0',
                    });
                    b.addEventListener('touchstart', e => { e.preventDefault(); down(); }, { passive: false });
                    b.addEventListener('touchend', e => { e.preventDefault(); up && up(); }, { passive: false });
                    return b;
                };
                this.touchButtons = document.createElement('div');
                Object.assign(this.touchButtons.style, {
                    position: 'fixed', top: 'max(10px, env(safe-area-inset-top))', right: 'max(10px, env(safe-area-inset-right))',
                    display: 'flex', gap: '10px', zIndex: '50',
                });
                this.touchButtons.append(
                    button('↻', 'Restart', () => this.onKeyDown(key('Tab'))),
                    // like Space: tap to pause, then hold to unpause
                    button('❚❚', 'Pause (hold to unpause)', () => this.onKeyDown(key('Space')), () => this.onKeyUp(key('Space'))),
                    button('✕', 'Quit', () => this.onKeyDown(key('Escape'))),
                );
                document.body.append(this.touchButtons);
            }

            document.addEventListener('mousemove', this.handlers.mousemove);
            this.canvas.addEventListener('mousedown', this.handlers.mousedown);
            this.canvas.addEventListener('contextmenu', this.handlers.contextmenu);
            window.addEventListener('keydown', this.handlers.keydown);
            window.addEventListener('keyup', this.handlers.keyup);
            window.addEventListener('wheel', this.handlers.wheel, { passive: false });
            window.addEventListener('resize', this.handlers.resize);
        }

        detachInput() {
            const h = this.handlers;
            if (!h)
                return;
            for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel'])
                this.canvas.removeEventListener(type, h[type === 'touchcancel' ? 'touchend' : type]);
            if (this.touchButtons) {
                this.touchButtons.remove();
                this.touchButtons = null;
            }
            document.removeEventListener('mousemove', h.mousemove);
            this.canvas.removeEventListener('mousedown', h.mousedown);
            this.canvas.removeEventListener('contextmenu', h.contextmenu);
            window.removeEventListener('keydown', h.keydown);
            window.removeEventListener('keyup', h.keyup);
            window.removeEventListener('wheel', h.wheel);
            window.removeEventListener('resize', h.resize);
        }

        lockPointer() {
            try {
                const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
                if (p && p.catch)
                    p.catch(() => {
                        try { this.canvas.requestPointerLock(); } catch { }
                    });
            } catch {
                try { this.canvas.requestPointerLock(); } catch { }
            }
        }

        onKeyDown(e) {
            if (['Tab', 'Space', 'F11'].includes(e.code) || (e.ctrlKey && e.code === 'KeyU'))
                e.preventDefault();
            if (e.repeat)
                return;

            switch (e.code) {
                case 'Escape':
                    this.close();
                    break;

                case 'F11':
                    if (document.fullscreenElement)
                        document.exitFullscreen().catch(() => { });
                    else
                        document.documentElement.requestFullscreen().catch(() => { });
                    break;

                case 'KeyR':
                    if (!e.ctrlKey)
                        this.Resetting = true;
                    break;

                case 'Tab':
                    this.reset();
                    break;

                case 'Space':
                    if (this.Paused && !this.Unpausing) {
                        this.currentTime = this.PauseTime - 750;
                        this.music.play();
                        this.Unpausing = true;
                    } else if (!this.Unpausing && this.music.isPlaying && this.PauseTime + 1500 <= this.currentTime) {
                        this.music.pause();

                        this.PauseTime = this.currentTime;
                        this.Pauses++;
                        this.Paused = true;
                    }
                    break;

                case 'KeyU':
                    if (e.ctrlKey && document.pointerLockElement)
                        document.exitPointerLock();
                    break;
            }
        }

        onKeyUp(e) {
            switch (e.code) {
                case 'KeyR':
                    this.Resetting = false;
                    break;

                case 'Space':
                    if (this.Paused) {
                        this.music.pause();
                        this.currentTime = this.PauseTime;
                    }
                    this.Unpausing = false;
                    break;
            }
        }

        resize() {
            const dpr = window.devicePixelRatio || 1;
            const w = Math.max(1, Math.floor(window.innerWidth * dpr));
            const h = Math.max(1, Math.floor(window.innerHeight * dpr));

            for (const c of [this.canvas, this.overlay]) {
                c.width = w;
                c.height = h;
            }

            this.gl.viewport(0, 0, w, h);
            this.Camera.calculateProjection(w, h);
        }

        // ------------------------------------------------ frame (MainWindow.OnRenderFrame)

        frame(now) {
            if (!this.running)
                return;

            const frametime = Math.max(0, (now - this.lastFrame) / 1000);
            this.lastFrame = now;

            const dx = this.mouseDX, dy = this.mouseDY;
            this.mouseDX = this.mouseDY = 0;

            const gl = this.gl;
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.time += frametime * 1000;

            if (this.music.isPlaying)
                this.currentTime = this.music.currentTimeMs();
            if (this.music.ended) {
                this.music.pause();
                this.close();
                return;
            }
            const currentTime = this.currentTime;

            if (this.Replay) {
                const clock = this.ReplaySongTime ? this.currentTime - this.waitTimer - this.Offset : this.time;
                if (this.ReplayCursorIndex < this.CursorNodes.length) {
                    let a = this.CursorNodes[Math.max(this.ReplayCursorIndex - 1, 0)];
                    let b = this.CursorNodes[this.ReplayCursorIndex];

                    while (b.Ms <= clock && ++this.ReplayCursorIndex < this.CursorNodes.length) {
                        a = b;
                        b = this.CursorNodes[this.ReplayCursorIndex];
                    }

                    const t = b.Ms === a.Ms ? 1 : clamp((clock - a.Ms) / (b.Ms - a.Ms), 0, 1);
                    const result = lerp2([a.X, a.Y], [b.X, b.Y], t);

                    this.Camera.setReplay(result);
                    this.LastCursorPos = [result[0], result[1], 0];
                } else {
                    this.close();
                    return;
                }

                while (this.ReplaySkipIndex < this.SkipNodes.length && this.SkipNodes[this.ReplaySkipIndex].Ms <= clock) {
                    this.skip(this.SkipNodes[this.ReplaySkipIndex]);
                    this.ReplaySkipIndex++;
                }
            } else if (this.Autoplay) {
                const Notes = this.Notes;
                if (this.AutoIndex < Notes.length) {
                    const index = Math.max(0, this.AutoIndex - 1);
                    const defaultNote = { X: 1, Y: 1, Ms: 0 };

                    let lastFar = index > 0 && index < Notes.length ? Notes[index - 1] : defaultNote;
                    let last = index < Notes.length ? Notes[index] : defaultNote;
                    let next = index + 1 < Notes.length ? Notes[index + 1] : last;
                    let nextFar = index + 2 < Notes.length ? Notes[index + 2] : next;

                    if (currentTime > next.Ms) {
                        lastFar = last;
                        last = next;
                    }

                    if (currentTime < last.Ms) {
                        nextFar = next;
                        next = last;
                    }

                    let result;

                    const diff = next.Ms - last.Ms;
                    const t = diff === 0 ? 1 : (currentTime - last.Ms - this.Offset) / diff;

                    if (this.settings.smoothAutoplay) {
                        const p0 = [lastFar.X, lastFar.Y], p1 = [last.X, last.Y], p2 = [next.X, next.Y], p3 = [nextFar.X, nextFar.Y];
                        const t2 = t * t, t3 = t2 * t;
                        result = [0, 1].map(i => 0.5 * (
                            2 * p1[i] +
                            (-p0[i] + p2[i]) * t +
                            (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 +
                            (-p0[i] + 3 * p1[i] - 3 * p2[i] + p3[i]) * t3
                        ) - 1);
                    } else
                        result = lerp2([last.X - 1, last.Y - 1], [next.X - 1, next.Y - 1], Math.sin(clamp(t, 0, 1) * Math.PI / 2));

                    this.Camera.setReplay(result);
                    this.LastCursorPos = [result[0], result[1], 0];
                }
            } else if (this.Bot) {
                const p = this.Bot.position(currentTime - this.Offset);
                this.LastCursorPos = this.CursorPos;
                this.Camera.setReplay([p[0] - 1, p[1] - 1]);
            } else {
                this.LastCursorPos = this.CursorPos;
                this.Camera.setMouse(dx, dy);
            }

            this.render(frametime);

            if (this.running)
                this.schedule();
        }

        // web only: with Uncap FPS, frames run as fast as the browser allows instead of once per screen refresh
        schedule() {
            if (this.settings.uncapFps) {
                if (!this.channel) {
                    this.channel = new MessageChannel();
                    this.channel.port1.onmessage = () => this.running && this.frame(performance.now());
                }
                this.channel.port2.postMessage(0);
            } else
                this.raf = requestAnimationFrame(t => this.frame(t));
        }

        skip(node) {
            // .sspre replays know exactly where their skips landed
            if (node && node.To !== undefined) {
                this.music.pause();
                this.currentTime = node.To;
                this.music.play();
                return;
            }
            if (this.AutoIndex < this.Notes.length) {
                this.music.pause();
                this.currentTime = this.Notes[this.AutoIndex].Ms - 1000 * (0.875 + this.Tempo);
                this.music.play();
            }
        }

        // ------------------------------------------------ GuiWindowMain.Render

        render(frametime) {
            const gl = this.gl;
            this.frameHit = 0;

            if (this.Resetting)
                this.resetTimer += frametime;
            else
                this.resetTimer = 0;

            if (this.resetTimer >= 0.75) {
                this.close();
                return;
            }

            if (this.Paused && this.Unpausing && this.currentTime >= this.PauseTime)
                this.Paused = false;

            if (this.world)
                this.world.render(this.Camera.projection, this.Camera.view, frametime);

            // lines
            const projView = mat4.mul(this.Camera.projection, this.Camera.view);
            gl.useProgram(this.program);
            gl.uniformMatrix4fv(this.uniforms.vertexProjection, false, projView);
            gl.bindVertexArray(this.lineVao);

            gl.disable(gl.CULL_FACE);
            const vertices = this.updateLines();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo);
            gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.DYNAMIC_DRAW);
            gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 7);
            gl.enable(gl.CULL_FACE);

            // models
            gl.useProgram(this.modelProgram);
            gl.uniformMatrix4fv(this.uniforms.modelProjection, false, this.Camera.projection);
            gl.uniformMatrix4fv(this.uniforms.modelView, false, this.Camera.view);
            this.renderCursor();
            if (!this.renderNotes(frametime))
                return;

            this.frames++;
            this.fpsTime += frametime;

            if (this.fpsTime >= 0.25) {
                this.fpsText = `FPS: ${Math.round(this.frames / this.fpsTime)}`;
                this.frames = 0;
                this.fpsTime = 0;
            }

            for (let i = 0; i < Math.min(this.frameHit, this.settings.maxPolyphony); i++)
                this.sound.play();

            this.renderLabels();
        }

        renderModel(model, positions, colors, count) {
            const gl = this.gl;
            gl.uniform1f(this.uniforms.modelShade, model.custom ? 1 : 0);
            // a user's mesh can be wound either way
            if (model.custom)
                gl.disable(gl.CULL_FACE);
            gl.bindVertexArray(model.vao);
            gl.bindBuffer(gl.ARRAY_BUFFER, model.posVbo);
            gl.bufferData(gl.ARRAY_BUFFER, positions.subarray(0, count * 3), gl.DYNAMIC_DRAW);
            gl.bindBuffer(gl.ARRAY_BUFFER, model.colVbo);
            gl.bufferData(gl.ARRAY_BUFFER, colors.subarray(0, count * 4), gl.DYNAMIC_DRAW);
            gl.drawArraysInstanced(gl.TRIANGLES, 0, model.vertexCount, count);
            if (model.custom)
                gl.enable(gl.CULL_FACE);
        }

        binarySearchFirst(key) {
            let first = 0, count = this.Notes.length - 1;
            while (count > 0) {
                const step = Math.trunc(count / 2);
                const iter = first + step;
                if (this.Notes[iter].Ms < key) {
                    first = iter + 1;
                    count -= step + 1;
                } else
                    count = step;
            }
            return first;
        }

        binarySearchLast(key) {
            let first = 0, count = this.Notes.length - 1;
            while (count > 0) {
                const step = Math.trunc(count / 2);
                const iter = first + step;
                if (this.Notes[iter].Ms <= key) {
                    first = iter + 1;
                    count -= step + 1;
                } else
                    count = step;
            }
            return first;
        }

        renderNotes(frametime) {
            const s = this.settings;
            const Notes = this.Notes;
            const currentTime = this.currentTime - this.waitTimer - this.Offset;

            this.waitTimer = Math.max(0, this.waitTimer - frametime * 1000 * this.Tempo);
            if (this.waitTimer <= 0 && !this.started) {
                this.started = true;
                this.music.play();
            }

            const NoteSpeed = this.NoteSpeed;
            const SpawnZ = this.SpawnZ;
            const trackLength = SpawnZ / NoteSpeed * 1000;
            const zHitbox = this.hitWindow * NoteSpeed / 1000 * this.Tempo;

            const minMs = Math.trunc(currentTime - 2 * zHitbox / NoteSpeed * 1000 - frametime);
            const maxMs = Math.trunc(currentTime + trackLength);

            let low = this.binarySearchFirst(minMs);
            let high = this.binarySearchLast(maxMs);
            while (low > 0 && this.noteSet[low - 1])
                low--;
            if (Notes.length > 0 && Notes[high].Ms <= maxMs && Notes[low].Ms >= minMs)
                high++;
            const range = Math.max(0, high - low);

            if (range * 3 > this.positions.length) {
                const size = range + Math.trunc(range / 2);
                this.positions = new Float32Array(size * 3);
                this.colors = new Float32Array(size * 4);
            }

            const fade = s.approachFade;
            const positions = this.positions, colors = this.colors;

            for (let i = low; i < high; i++) {
                const index = i - low;
                const note = Notes[i];

                const x = note.X - 1;
                const y = note.Y - 1;
                const timeDiff = note.Ms - currentTime;
                const prevZ = NoteSpeed * (timeDiff - frametime) / 1000;
                const z = NoteSpeed * timeDiff / 1000;

                if (this.noteSet[i] && this.ReplaySongTime) {
                    // Sound Space Plus judging for its replays: a hit is any recorded cursor position on the note
                    // within the hit window either side of it (early hits count), shown when the song gets there
                    const window = this.ReplayHitWindow * this.Tempo;
                    const hitAt = this.replayHitTime(i, x, y, window);
                    if (hitAt !== null && currentTime >= hitAt)
                        this.hitNote(i);
                    else if (hitAt === null && timeDiff < -window)
                        this.missNote(i);
                } else if (this.noteSet[i] && z <= 0) {
                    const hovering = !this.Paused && this.isOverNote([x, y, z], zHitbox, prevZ);
                    const passed = hovering || z < -zHitbox;

                    if (hovering)
                        this.hitNote(i);
                    else if (passed)
                        this.missNote(i);
                }

                positions[index * 3] = x;
                positions[index * 3 + 1] = y;
                positions[index * 3 + 2] = (this.noteSet[i] && (s.notePushback || z >= 0)) ? z : -10;

                colors[index * 4] = note.Color[0];
                colors[index * 4 + 1] = note.Color[1];
                colors[index * 4 + 2] = note.Color[2];
                colors[index * 4 + 3] = fade ? Math.min(1, (1 - z / SpawnZ) * 2) : 1;
            }

            this.gl.uniformMatrix4fv(this.uniforms.modelTransformation, false, this.noteScaleMatrix);
            if (range > 0)
                this.renderModel(this.noteModel, positions, colors, range);

            while (!this.noteSet[this.AutoIndex])
                this.AutoIndex++;

            return this.running;
        }

        renderCursor() {
            const gl = this.gl;
            const c2 = this.settings.color2;
            const scale = this.cursorScaleValue;

            gl.uniformMatrix4fv(this.uniforms.modelTransformation, false, mat4.scale(scale));
            this.renderModel(this.cursorModel,
                new Float32Array([this.CursorPos[0], this.CursorPos[1], this.CursorPos[2] - 0.01]),
                new Float32Array([c2[0] / 255, c2[1] / 255, c2[2] / 255, 1]), 1);

            if (!this.settings.lockCursor && this.settings.cameraMode !== 'spin') {
                const p = this.Camera.LockedPos;
                gl.uniformMatrix4fv(this.uniforms.modelTransformation, false, mat4.scale(scale * 0.95));
                this.renderModel(this.cursorModel, new Float32Array([p[0], p[1], 0]), new Float32Array([0.5, 0.5, 0.5, 0.5]), 1);
            }
        }

        // GuiWindowMain.Update
        updateLines() {
            const v = [];
            const s = this.settings;
            const c1 = [s.color1[0] / 255, s.color1[1] / 255, s.color1[2] / 255, 1];

            const ratio = this.health / this.maxHealth * 2.5;

            const progress = this.timeMax > 0 ? this.currentTime / this.timeMax : 0;
            const final = progress * 2.8;
            const first = this.timeMax > 0 ? this.StartTime / this.timeMax : 0;
            const firstFinal = first * 2.8;

            // grid
            GLU.outline(v, -1.5, -1.5, 0, 3, 3, 0.02, c1);

            // grid guides
            if (s.gridGuides) {
                const g = [0.5, 0.5, 0.5, 0.5];
                GLU.line(v, -0.5, -1.5, 0, -0.5, 1.5, 0, 0.01, g);
                GLU.line(v, 0.5, -1.5, 0, 0.5, 1.5, 0, 0.01, g);
                GLU.line(v, -1.5, -0.5, 0, 1.5, -0.5, 0, 0.01, g);
                GLU.line(v, -1.5, 0.5, 0, 1.5, 0.5, 0, 0.01, g);
            }

            // lines
            GLU.fadingLine(v, -2.5, -1.5, -10, -2.5, -1.5, 75, 0.06, c1);
            GLU.fadingLine(v, 2.5, -1.5, -10, 2.5, -1.5, 75, 0.06, c1);
            // health
            GLU.line(v, 1.25, -1.7, 0, 1.25 - ratio, -1.7, 0, 0.03, this.healthColor);
            GLU.line(v, 1.25 - ratio, -1.7, 0, -1.25, -1.7, 0, 0.03, [1, 0, 0, 1]);
            // progress
            GLU.line(v, 1.4, 1.75, -0.1, 1.4 - final, 1.75, -0.1, 0.03, [1, 1, 1, 1]);
            GLU.line(v, 1.4 - final, 1.8, -0.101, 1.4 - final, 1.7, -0.101, 0.03, [1, 1, 1, 1]);
            GLU.line(v, 1.4 - firstFinal, 1.8, -0.099, 1.4 - firstFinal, 1.7, -0.099, 0.03, [1, 0.4, 0, 1]);
            GLU.line(v, 1.4 - final, 1.75, -0.1, -1.4, 1.75, -0.1, 0.03, [0.5, 0.5, 0.5, 1]);
            // quit
            GLU.line(v, 2, -2, 0, 2 - this.resetTimer / 0.75 * 4, -2, 0, 0.06, [1, 0, 0, 1]);
            // unpause
            if (this.Paused && this.Unpausing)
                GLU.line(v, 2, -2, 0.001, 2 - (750 - this.PauseTime + this.currentTime) / 750 * 4, -2, 0.001, 0.06, [0, 0.5, 1, 1]);

            return new Float32Array(v);
        }

        // ------------------------------------------------ labels (GuiLabel / GuiWindow.OnResize)

        renderLabels() {
            const ctx = this.ctx2d;
            const W = this.overlay.width, H = this.overlay.height;
            const wd = W / 1920, hd = H / 1080;
            const s = this.settings;
            const css = c => `rgb(${c[0]},${c[1]},${c[2]})`;

            ctx.clearRect(0, 0, W, H);
            ctx.textBaseline = 'top';

            const label = (x, y, w, h, text, size, centered, color) => {
                if (!text)
                    return;
                const px = Math.max(1, Math.trunc(size * hd));
                ctx.font = `${px}px SSQEMain, "Source Sans Pro", "Segoe UI", Arial, sans-serif`;
                ctx.fillStyle = color;

                let tx = x * wd, ty = y * hd;
                const lines = text.split('\n');

                if (centered) {
                    const width = Math.max(...lines.map(l => ctx.measureText(l).width));
                    const height = px * 0.72;
                    tx += w * wd / 2 - width / 2;
                    ty += h * hd / 2 - height / 2;
                }

                lines.forEach((l, i) => ctx.fillText(l, tx, ty + i * px));
            };

            const currentTime = this.currentTime;
            const mins = Math.trunc(currentTime / 60000);
            const secs = Math.trunc(currentTime % 60000 / 1000);

            label(930, 10, 60, 24, this.calculateAccuracy(), 28, true, css(s.color1));
            label(930, 35, 60, 24, String(this.combo), 28, true, css(s.color1));
            label(930, 60, 60, 24, `${this.misses} | ${this.Pauses}`, 28, true, css(s.color2));
            label(10, 10, 100, 50, 'QUIT: Escape or R\nRESTART: Tab\nPAUSE: Space\n\nOFFSET: Scroll\nUNFOCUS: CTRL+U\nFOCUS: LMB', 20, false, css(s.color2));
            if (this.Paused && !this.Unpausing)
                label(930, 980, 60, 60, 'PAUSED', 72, true, 'rgb(0,127,255)');
            label(10, 1050, 60, 40, this.hitWindowTempoText, 28, false, css(s.color2));
            label(0, 1010, 1920, 40, this.Offset !== 0 ? `Offset: ${this.Offset}ms` : '', 28, true, css(s.color2));
            label(1800, 1050, 60, 40, this.fpsText, 28, false, css(s.color2));
            label(0, 1045, 1920, 40, `${mins}:${secs >= 0 && secs < 10 ? '0' : ''}${secs}`, 28, true, css(s.color2));
        }

        calculateAccuracy() {
            if (this.hits + this.misses === 0)
                return '--.--%';
            return `${(this.hits / (this.hits + this.misses) * 100).toFixed(2)}%`;
        }

        // ------------------------------------------------ hit logic

        hitNote(index) {
            this.health = clamp(this.health + this.healthRegen, 0, this.maxHealth);

            this.frameHit++;

            this.hits++;
            this.combo++;
            if (this.world && this.Notes[index])
                this.world.hit(this.Notes[index].Color);
            this.maxCombo = Math.max(this.maxCombo, this.combo);

            this.noteSet[index] = 0;
        }

        missNote(index) {
            this.health = clamp(this.health - this.healthPenalty, 0, this.maxHealth);

            if (this.health <= 0)
                this.healthColor = [1, 100 / 255, 0, 1];

            this.misses++;
            this.combo = 0;

            this.noteSet[index] = 0;
        }

        // the song time the replay's cursor first touches note i within its hit window, or null for a miss
        replayHitTime(i, x, y, window) {
            this.replayHits = this.replayHits || new Map();
            if (this.replayHits.has(i))
                return this.replayHits.get(i);
            const nodes = this.CursorNodes, ms = this.Notes[i].Ms;
            const half = (NOTE_SIZE[0] + CURSOR_SIZE[0]) / 2;
            let lo = 0, hi = nodes.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (nodes[mid].Ms < ms - window)
                    lo = mid + 1;
                else
                    hi = mid;
            }
            let result = null;
            for (let k = lo; k < nodes.length && nodes[k].Ms <= ms + window; k++)
                if (Math.abs(nodes[k].X - x) <= half && Math.abs(nodes[k].Y - y) <= half) {
                    result = nodes[k].Ms;
                    break;
                }
            this.replayHits.set(i, result);
            return result;
        }

        isOverNote(notePos, zHitbox, prevZ) {
            if (prevZ + zHitbox < 0 || notePos[2] > 0)
                return false;

            const halfMax = [0, 1, 2].map(a => (NOTE_SIZE[a] + CURSOR_SIZE[a]) / 2);
            const halfMin = [halfMax[0], halfMax[1], 0];

            const max = [0, 1, 2].map(a => notePos[a] + halfMax[a]);
            const min = [0, 1, 2].map(a => notePos[a] - halfMin[a]);

            const prevVec = this.LastCursorPos;
            const vec = this.CursorPos;

            let start = prevZ / (notePos[2] - prevZ);
            let end = zHitbox / (notePos[2] - prevZ);

            start = clamp(start, 0, 1);
            end = clamp(end, 0, 1);

            const v1 = [0, 1, 2].map(a => prevVec[a] + (vec[a] - prevVec[a]) * start);
            const v2 = [0, 1, 2].map(a => prevVec[a] + (vec[a] - prevVec[a]) * end);

            const m1 = [Math.min(v1[0], v2[0]), Math.min(v1[1], v2[1])];
            const m2 = [Math.max(v1[0], v2[0]), Math.max(v1[1], v2[1])];

            if (m2[0] < min[0] || max[0] < m1[0])
                return false;
            if (m2[1] < min[1] || max[1] < m1[1])
                return false;

            if (Math.hypot(v2[0] - v1[0], v2[1] - v1[1], v2[2] - v1[2]) <= 0)
                return true;

            const sv = [-(v2[1] - v1[1]), v2[0] - v1[0]];
            const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
            const signedDist = p => {
                const d = dot(p, sv);
                const proj = [d * sv[0], d * sv[1]];
                return Math.hypot(proj[0], proj[1]) * (dot(proj, sv) < 0 ? -1 : 1);
            };

            const dist1 = signedDist([v1[0], v1[1]]);
            const dist2 = signedDist([v2[0], v2[1]]);
            const distBox = [
                signedDist([min[0], min[1]]),
                signedDist([min[0], max[1]]),
                signedDist([max[0], min[1]]),
                signedDist([max[0], max[1]]),
            ];

            return Math.max(dist1, dist2) >= Math.min(...distBox) && Math.max(...distBox) >= Math.min(dist1, dist2);
        }

        // GuiWindowMain.Reset
        reset() {
            this.noteSet = new Uint8Array(this.Notes.length + 1);
            for (let i = this.startIndex; i < this.noteSet.length; i++)
                this.noteSet[i] = 1;

            this.hits = 0;
            this.misses = 0;
            this.combo = 0;
            this.maxCombo = 0;
            this.AutoIndex = 0;

            this.health = this.maxHealth;
            this.healthColor = [0, 1, 0, 1];

            this.waitTimer = 2000 * this.Tempo;
            this.started = false;

            this.Paused = false;
            this.Unpausing = false;
            this.PauseTime = -Number.MAX_VALUE;
            this.Pauses = 0;

            this.resetTimer = 0;
            this.ReplayCursorIndex = 0;
            this.ReplaySkipIndex = 0;
            this.time = -65;

            this.music.stop();
            this.currentTime = this.StartTime;
        }
    }

    return { Game, parseMap, parseReplay, alignReplay, loadAudio };
})();
