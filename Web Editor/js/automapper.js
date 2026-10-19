'use strict';

// Web only: an auto mapper that learns from the maps you import (in the editor or the map player).
//
// It keeps the maps themselves (note positions and timing), not averages: to place notes it copies whole runs of
// notes from them (8-16 at a time), picked because their rhythm matches the new notes' rhythm and because they carry
// on from where the last note is, turned or mirrored to fit. So the patterns that come out are patterns someone
// actually mapped - with one map learned, the result follows that map's design.
//
// Timing comes from the song: drum-like hits (the bass and the high end, which leaves most of the vocals out), lined
// up on the beat (the map's BPM, or one it works out), with more notes and bigger moves where the song is intense
// (drops) and fewer where it's calm.
//
// It maps like a plan: bars that sound the same (a loop coming round again, a chorus coming back) get the same rhythm,
// and mostly the same pattern again, turned or mirrored; parts that sound different get new patterns.
//
// It also comes with example maps (automapperexamples.js): jump maps, stream maps and a quantum map, which lead when a
// jump map, a stream map or quantum is asked for, and fill in while it has learned few maps.
//
// Quantum (0-100%): at 100% the notes are quantum jumps and quantum slides (notes so close together they play as one
// sweep), made for the spot and rhythm (quantumRun) in the design of the quantum maps it learned, averaged
// (quantumProfile: how far off and out they go, how their jumps turn, their slides), with short figures from those maps
// now and then; the example map's design only when it learned none. Lower, only some parts are quantum, fewer and
// tamer the lower, and around 10% only a few quick runs bent onto lines and curves between grid notes (bendCurves).
// Grid patterns are only ever moved by whole cells, never by part of one: a grid pattern sitting off the grid isn't
// quantum mapping. From any learned map it takes a few notes at a time (its feel), never a long stretch.
//
// What it learns is stored in the browser (IndexedDB, see customassets.js).
window.SSQEAutoMapper = (function () {
    const KEY = 'mapperModel';
    const VERSION = 2;
    const MAX_NOTES = 250000;
    const GRID = [0, 2];
    // (as far as the editor lets quantum notes go)
    const QUANTUM = [-0.85, 2.85];

    // the 8 ways to turn or mirror the 3x3 grid around its middle (1, 1); INV[k] undoes SYM[k]
    const SYM = [
        (x, y) => [x, y], (x, y) => [2 - x, y], (x, y) => [x, 2 - y], (x, y) => [2 - x, 2 - y],
        (x, y) => [y, x], (x, y) => [2 - y, x], (x, y) => [y, 2 - x], (x, y) => [2 - y, 2 - x],
    ];
    const INV = [0, 1, 2, 3, 4, 6, 5, 7];

    const isWhole = v => Math.abs(v - Math.round(v)) < 1e-4;
    // A really quantum spot: off the grid's cells and off the half-cell lines between them too, or outside the grid
    // (half-cell steps along the grid lines are a tech map's grid patterns, not quantum mapping)
    const realQuantum = (x, y) => x < -1e-3 || x > 2.001 || y < -1e-3 || y > 2.001 || !isWhole(2 * x) || !isWhole(2 * y);
    // (within 0.2 of a grid cell or a half-cell point of the grid: a note there looks like the 3x3 grid shifted a
    // little, not like a quantum note)
    const nearGrid = (x, y) => Math.hypot(x - Math.min(2, Math.max(0, Math.round(x * 2) / 2)), y - Math.min(2, Math.max(0, Math.round(y * 2) / 2))) < 0.2;
    const posKey = (x, y) => `${Math.round(x * 20)},${Math.round(y * 20)}`;

    // ------------------------------------------------ storage

    function emptyModel() {
        return { version: VERSION, maps: [], seen: [] };
    }

    let model = null;
    let loading = null;
    function load() {
        if (model)
            return Promise.resolve(model);
        if (!loading)
            loading = (window.SSQECustom ? SSQECustom.get(KEY) : Promise.resolve(null))
                .then(m => model = m && m.version === VERSION ? m : emptyModel())
                .catch(() => model = emptyModel());
        return loading;
    }

    let saving = Promise.resolve();
    function save() {
        if (!window.SSQECustom)
            return Promise.resolve();
        saving = saving.then(() => SSQECustom.put(KEY, model)).catch(() => { });
        return saving;
    }

    function fingerprint(notes) {
        let h = 2166136261;
        const text = `${notes.length}|` + notes.map(n => `${n.x},${n.y},${n.ms}`).join(';');
        for (let i = 0; i < text.length; i++)
            h = Math.imul(h ^ text.charCodeAt(i), 16777619);
        return (h >>> 0).toString(36);
    }

    // sorted, one note per timestamp, as a library entry { x, y, t, quantum }
    function toEntry(notes, name = '') {
        const list = notes.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.ms))
            .sort((a, b) => a.ms - b.ms)
            .filter((n, i, a) => i === 0 || n.ms !== a[i - 1].ms);
        const r = v => Math.round(v * 1000) / 1000;
        return {
            name,
            x: Float32Array.from(list, n => r(n.x)),
            y: Float32Array.from(list, n => r(n.y)),
            t: Float64Array.from(list, n => Math.round(n.ms)),
            quantum: list.some(n => !isWhole(n.x) || !isWhole(n.y) || n.x < 0 || n.x > 2 || n.y < 0 || n.y > 2),
        };
    }

    // The example maps that come with it (automapperexamples.js), unpacked the first time they're needed: library
    // entries with their kind ('jumps', 'streams' or 'quantum')
    let examples = null;
    function exampleEntries() {
        if (examples)
            return examples;
        examples = [];
        for (const ex of window.SSQEAutoMapperExamples || []) {
            try {
                const bytes = Uint8Array.from(atob(ex.data), c => c.charCodeAt(0));
                let p = 0;
                const next = () => {
                    let v = 0, mul = 1, b;
                    do {
                        b = bytes[p++];
                        v += (b & 0x7f) * mul;
                        mul *= 128;
                    } while (b & 0x80);
                    return v;
                };
                const unzig = v => v % 2 ? -(v + 1) / 2 : v / 2;
                const notes = [];
                let x = 0, y = 0, ms = 0;
                while (p < bytes.length) {
                    x += unzig(next());
                    y += unzig(next());
                    ms += next();
                    notes.push({ x: x / 100, y: y / 100, ms });
                }
                const entry = toEntry(notes, `${ex.song} (${ex.mapper})`);
                entry.kind = ex.kind;
                examples.push(entry);
            } catch (err) {
                console.warn(`Couldn't unpack the example map ${ex.song}`, err);
            }
        }
        return examples;
    }

    // notes: [{ x, y, ms }] in editor coordinates (0..2). Returns true when the map is new to it.
    // opts.source: where the notes come from (a map made in the editor, learned again each time it's saved): its
    // earlier version is replaced rather than kept as well
    async function learn(notes, name = '', opts = {}) {
        await load();
        if (notes.length < 20)
            return false;
        const id = fingerprint([...notes].sort((a, b) => a.ms - b.ms));
        if (model.seen.includes(id))
            return false;
        const entry = toEntry(notes, name);
        if (entry.t.length < 20)
            return false;
        entry.id = id;
        if (opts.source) {
            entry.source = opts.source;
            model.maps = model.maps.filter(m => m.source !== opts.source);
        }
        model.maps.push(entry);
        model.seen.push(id);
        // keep the newest maps when there are too many notes to store
        let total = model.maps.reduce((n, m) => n + m.t.length, 0);
        while (total > MAX_NOTES && model.maps.length > 1)
            total -= model.maps.shift().t.length;
        if (model.seen.length > 5000)
            model.seen.splice(0, model.seen.length - 5000);
        await save();
        return true;
    }

    function statsSync() {
        return model ? { maps: model.maps.length, notes: model.maps.reduce((n, m) => n + m.t.length, 0) } : null;
    }

    async function stats() {
        await load();
        return statsSync();
    }

    async function reset() {
        model = emptyModel();
        await save();
    }

    // Classic Sound Space patterns, used only until a map has been learned
    function defaultEntry() {
        let seed = 7;
        const random = () => (seed = seed * 16807 % 2147483647) / 2147483647;
        const patterns = [
            [[0, 0], [2, 2], [0, 2], [2, 0]],
            [[0, 1], [2, 1], [0, 1], [2, 1]],
            [[1, 0], [1, 2], [1, 0], [1, 2]],
            [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]],
            [[0, 2], [1, 1], [2, 0], [1, 1]],
            [[0, 0], [2, 0], [1, 2]],
            [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2], [2, 1], [2, 0], [1, 0]],
            [[2, 1], [0, 0], [2, 2], [0, 1]],
            [[0, 0], [1, 1], [2, 2], [1, 1]],
            [[1, 0], [0, 2], [2, 2], [1, 0]],
        ];
        const notes = [];
        let ms = 0;
        for (let p = 0; p < 400; p++) {
            const pattern = patterns[Math.floor(random() * patterns.length)];
            const f = SYM[Math.floor(random() * 8)];
            const gap = [75, 120, 180, 250, 330][Math.floor(random() * 5)];
            const reps = 1 + Math.floor(random() * 3);
            for (let r = 0; r < reps; r++)
                for (const [x, y] of pattern) {
                    const [tx, ty] = f(x, y);
                    if (notes.length && notes[notes.length - 1].x === tx && notes[notes.length - 1].y === ty)
                        continue;
                    notes.push({ x: tx, y: ty, ms });
                    ms += gap;
                }
            ms += 300;
        }
        return toEntry(notes, 'built in');
    }

    // ------------------------------------------------ listening to the song

    // in-place radix-2 FFT
    function fft(re, im) {
        const n = re.length;
        for (let i = 1, j = 0; i < n; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1)
                j ^= bit;
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const ang = -2 * Math.PI / len;
            const wr = Math.cos(ang), wi = Math.sin(ang);
            for (let i = 0; i < n; i += len) {
                let cr = 1, ci = 0;
                for (let k = 0; k < len / 2; k++) {
                    const a = i + k, b = a + len / 2;
                    const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - tr; im[b] = im[a] - ti;
                    re[a] += tr; im[a] += ti;
                    const nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    }

    const percentile = (arr, f) => {
        const s = Float32Array.from(arr).sort();
        return s[Math.min(s.length - 1, Math.floor(s.length * f))] || 0;
    };

    function smooth(arr, radius) {
        const out = new Float32Array(arr.length);
        let sum = 0, count = 0;
        for (let i = 0; i < Math.min(arr.length, radius); i++) {
            sum += arr[i];
            count++;
        }
        for (let i = 0; i < arr.length; i++) {
            if (i + radius < arr.length) {
                sum += arr[i + radius];
                count++;
            }
            if (i - radius - 1 >= 0) {
                sum -= arr[i - radius - 1];
                count--;
            }
            out[i] = sum / count;
        }
        return out;
    }

    // rank of each value among all of them, 0..1
    function rank(a) {
        const sorted = Float32Array.from(a).sort();
        return Float32Array.from(a, v => {
            let lo = 0, hi = sorted.length;
            while (lo < hi) {
                const m = (lo + hi) >> 1;
                if (sorted[m] < v)
                    lo = m + 1;
                else
                    hi = m;
            }
            return lo / Math.max(1, sorted.length - 1);
        });
    }

    // median of the first n values of buf (sorted in place)
    function median(buf, n) {
        for (let i = 1; i < n; i++) {
            const v = buf[i];
            let j = i - 1;
            while (j >= 0 && buf[j] > v) {
                buf[j + 1] = buf[j];
                j--;
            }
            buf[j + 1] = v;
        }
        return buf[n >> 1];
    }

    // Whole-song analysis, done once per song (in 10ms frames).
    // The spectrum is split into its percussive and harmonic parts (median filtering across frequency and across
    // time): drums are short and wide, vocals and instruments are long and narrow. Only the percussive part is used to
    // place notes, so singing doesn't get synced.
    const analyses = new WeakMap();
    async function analyse(buffer, progress = () => { }) {
        if (analyses.has(buffer))
            return analyses.get(buffer);
        const sr = buffer.sampleRate, N = 1024, hop = sr / 100;
        const frames = Math.max(0, Math.floor((buffer.length - N) / hop));
        const B = Math.min(N / 2 - 1, Math.round(11000 / sr * N));
        const bin = f => Math.max(1, Math.min(B, Math.round(f / sr * N)));
        const lowEnd = bin(160), midEnd = bin(4500);
        const chans = [];
        for (let c = 0; c < buffer.numberOfChannels; c++)
            chans.push(buffer.getChannelData(c));
        const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
        const re = new Float32Array(N), im = new Float32Array(N);

        const T = 13, HALF = 6; // median windows: 13 frames (130ms) across time, 13 bins across frequency
        const ring = Array.from({ length: T }, () => new Float32Array(B + 1));
        const tmp = new Float32Array(T);
        let prevLp = new Float32Array(B + 1), lp = new Float32Array(B + 1);
        let prevLh = new Float32Array(B + 1), lh = new Float32Array(B + 1);
        let prevLa = new Float32Array(B + 1), la = new Float32Array(B + 1);
        const melodyRaw = new Float32Array(frames), allRaw = new Float32Array(frames), bassRaw = new Float32Array(frames);
        const low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames);
        const rms = new Float32Array(frames), harmonic = new Float32Array(frames);
        // how much is sounding in each band (held sounds too: a bass line, a pad), in log units
        const bandLow = new Float32Array(frames), bandMid = new Float32Array(frames), bandHigh = new Float32Array(frames);

        // Kicks are found in the bass range of the sound itself. A 1024-point spectrum has only a few bins below
        // 160Hz, and a held bass note there makes them flicker from frame to frame (false kicks, and real ones lost
        // under it). So: the song filtered below ~150Hz, its energy every 5ms, and how sharply that rises over 20ms.
        // A kick jumps within 10-20ms; a held or swelling (side-chained) bass doesn't.
        const lowRise = new Float32Array(frames);
        {
            const blk = sr / 200;
            const nb = Math.floor(buffer.length / blk);
            const e5 = new Float32Array(nb);
            const w0 = 2 * Math.PI * 150 / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
            const b0 = (1 - cs) / 2 / (1 + al), b1 = (1 - cs) / (1 + al), a1 = -2 * cs / (1 + al), a2 = (1 - al) / (1 + al);
            let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0, acc = 0, bi = 0, next = blk;
            const nch = chans.length;
            for (let i = 0; i < buffer.length; i++) {
                let v = chans[0][i];
                for (let c = 1; c < nch; c++)
                    v += chans[c][i];
                v /= nch;
                const y = b0 * v + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
                x2 = x1; x1 = v; y2 = y1; y1 = y;
                const z = b0 * y + b1 * u1 + b0 * u2 - a1 * z1 - a2 * z2;
                u2 = u1; u1 = y; z2 = z1; z1 = z;
                acc += z * z;
                if (i + 1 >= next) {
                    if (bi < nb)
                        e5[bi++] = acc / blk;
                    acc = 0;
                    next += blk;
                }
                if ((i & 0xfffff) === 0xfffff)
                    await new Promise(r => setTimeout(r));
            }
            const floor = percentile(e5, 0.9) * 1e-3 + 1e-12;
            // energy over the 20ms starting `LEAD` ms into a frame (so a kick lands on the same frame as everything
            // else found from the spectrum)
            const LEAD = 12;
            const energy = g => {
                const q = Math.floor((g * 10 + LEAD) / 5);
                let e = 0;
                for (let k = q; k < q + 4; k++)
                    e += k >= 0 && k < nb ? e5[k] : 0;
                return Math.log10(e / 4 + floor);
            };
            // ...and only where it gets louder than anything in the 30-90ms before (a side-chained bass swelling back
            // after a kick rises fast too, but never above the kick)
            const E = new Float32Array(frames);
            for (let g = 0; g < frames; g++)
                E[g] = energy(g);
            for (let g = 9; g < frames; g++) {
                let before = -Infinity;
                for (let k = g - 9; k <= g - 3; k++)
                    before = Math.max(before, E[k]);
                lowRise[g] = Math.max(0, E[g] - E[g - 2]) * Math.min(1, Math.max(0, (E[g] - before + 0.4) / 0.6));
            }
        }

        for (let f = 0; f < frames + HALF; f++) {
            if (f < frames) {
                const o = Math.floor(f * hop);
                let e = 0;
                for (let i = 0; i < N; i++) {
                    let v = 0;
                    for (const ch of chans)
                        v += ch[o + i];
                    v /= chans.length;
                    e += v * v;
                    re[i] = v * win[i];
                    im[i] = 0;
                }
                rms[f] = Math.sqrt(e / N);
                fft(re, im);
                const mag = ring[f % T];
                // on a scale where 1 is a full-volume sine, so near-silent noise stays near 0 after the log below
                for (let k = 1; k <= B; k++)
                    mag[k] = Math.hypot(re[k], im[k]) / (N / 4);
            }
            const g = f - HALF;
            if (g < 0)
                continue;
            const cur = ring[g % T];
            const from = Math.max(0, g - HALF), to = Math.min(frames - 1, g + HALF);
            let l = 0, m = 0, h = 0, harm = 0, mel = 0, all = 0, bass = 0, lc = 0, mc = 0, hc = 0;
            let eL = 0, eM = 0, eH = 0;
            for (let k = 1; k <= B; k++) {
                const pow = cur[k] * cur[k];
                if (k < lowEnd)
                    eL += pow;
                else if (k < midEnd)
                    eM += pow;
                else
                    eH += pow;
                // harmonic: median over time; percussive: median over frequency
                let n = 0;
                for (let q = from; q <= to; q++)
                    tmp[n++] = ring[q % T][k];
                const H = median(tmp, n);
                n = 0;
                for (let j = Math.max(1, k - HALF); j <= Math.min(B, k + HALF); j++)
                    tmp[n++] = cur[j];
                const P = median(tmp, n);
                const mask = P * P / (P * P + H * H + 1e-12);
                lp[k] = Math.log1p(100 * cur[k] * mask);
                lh[k] = Math.log1p(100 * cur[k] * (1 - mask));
                la[k] = Math.log1p(100 * cur[k]);
                harm += cur[k] * (1 - mask);
                if (lh[k] > prevLh[k]) {
                    if (k >= lowEnd)
                        mel += lh[k] - prevLh[k];
                    else
                        bass += lh[k] - prevLh[k];
                }
                if (la[k] > prevLa[k])
                    all += la[k] - prevLa[k];
                const d = lp[k] - prevLp[k];
                if (d > 0) {
                    // also how many frequencies jump at once: a drum hits most of its range, a wobbling voice a few
                    const wide = d > 0.25 ? 1 : 0;
                    if (k < lowEnd) {
                        l += d;
                        lc += wide;
                    } else if (k < midEnd) {
                        m += d;
                        mc += wide;
                    } else {
                        h += d;
                        hc += wide;
                    }
                }
            }
            if (g) {
                // per frequency, weighted by how much of the band jumped together
                low[g] = l / (lowEnd - 1) * (0.4 + 0.6 * lc / (lowEnd - 1));
                mid[g] = m / (midEnd - lowEnd) * Math.min(1, 2.5 * mc / (midEnd - lowEnd));
                high[g] = h / (B + 1 - midEnd) * Math.min(1, 2.5 * hc / (B + 1 - midEnd));
            }
            harmonic[g] = harm;
            bandLow[g] = Math.log10(eL + 1e-7);
            bandMid[g] = Math.log10(eM + 1e-7);
            bandHigh[g] = Math.log10(eH + 1e-7);
            if (g) {
                melodyRaw[g] = mel / (B + 1 - lowEnd);
                allRaw[g] = all / B;
                bassRaw[g] = bass / (lowEnd - 1);
            }
            [prevLp, lp] = [lp, prevLp];
            [prevLh, lh] = [lh, prevLh];
            [prevLa, la] = [la, prevLa];
            if (g % 400 === 399) {
                progress(`LISTENING TO THE SONG ${Math.round(g / frames * 100)}%`);
                await new Promise(r => setTimeout(r));
            }
        }

        // how loud each kind of sound is compared to the others (a song without hi-hats shouldn't get hi-hat notes
        // from noise that was scaled up)
        const rawPeak = {
            kick: percentile(lowRise, 0.98), snare: percentile(mid, 0.98), hat: percentile(high, 0.98),
            melody: percentile(melodyRaw, 0.98), bass: percentile(bassRaw, 0.98),
        };
        // each band on the same scale
        for (const a of [low, mid, high, lowRise]) {
            const p = percentile(a, 0.97) || 1;
            for (let i = 0; i < a.length; i++)
                a[i] = Math.min(2, a[i] / p);
        }
        // what stands out from its surroundings
        const peaky = raw => {
            const base = smooth(raw, 12);
            const out = new Float32Array(raw.length);
            for (let i = 0; i < raw.length; i++)
                out[i] = Math.max(0, raw[i] - base[i] * 1.05);
            const p = percentile(out, 0.98) || 1;
            for (let i = 0; i < out.length; i++)
                out[i] = Math.min(1.5, out[i] / p);
            return out;
        };
        // hits: any drum (kick, snare, hats); beats: the kick and snare, which carry the beat
        const hits = peaky(Float32Array.from(low, (v, i) => (1.2 * v + mid[i] + 0.6 * high[i]) / 2.8));
        const beats = peaky(Float32Array.from(low, (v, i) => (1.4 * v + mid[i]) / 2.4));

        progress('FINDING THE BPM');
        await new Promise(r => setTimeout(r));
        const tempo = await findTempo(beats, hits, frames);

        // for "sync to": melody onsets (notes of vocals and instruments starting) and everything together
        const melody = peaky(melodyRaw);
        const everything = peaky(allRaw);

        const bassline = peaky(bassRaw);
        // (the beat is found from the spectrum's bands above, which it was tuned on; kick notes from the bass range)
        const sources = { kick: peaky(lowRise), snare: peaky(mid), hat: peaky(high), melody, bass: bassline };
        const loudest = Math.max(...Object.values(rawPeak), 1e-9);
        const sourceLevel = {};
        for (const k in rawPeak)
            sourceLevel[k] = Math.min(1, rawPeak[k] / loudest);

        // how loud the song is around each moment compared to its loud parts (0..1): a soft passage's drums count less
        const db = smooth(rms.map(v => 20 * Math.log10(v + 1e-6)), 25);
        const loudRef = percentile(db, 0.95);
        const loudness = db.map(v => Math.min(1, Math.max(0, (v - (loudRef - 30)) / 24)));

        const result = { frames, hits, beats, low, rms, harmonic, melody, everything, sources, sourceLevel, loudness, tempo, bandLow, bandMid, bandHigh };
        analyses.set(buffer, result);
        return result;
    }

    // value of an envelope at a (fractional) frame: the strongest within ±r frames
    function around(env, f, r = 2) {
        const c = Math.round(f);
        let best = 0;
        for (let k = Math.max(0, c - r); k <= Math.min(env.length - 1, c + r); k++)
            if (env[k] > best)
                best = env[k];
        return best;
    }

    // How well a beat grid (period and phase in frames) sits on the kicks and snares: their average strength on its
    // beats, against their average strength anywhere
    function beatScore(env, period, phase, from = 0, to = env.length) {
        let sum = 0, n = 0;
        for (let t = phase + Math.ceil((from - phase) / period) * period; t < to; t += period) {
            sum += around(env, t, 1);
            n++;
        }
        return n ? sum / n : 0;
    }

    // The song's BPM and where its beats are. Every likely tempo (from the rhythm's repetition) and its relatives
    // (x2, /2, x3/2, /3/2) is tried; the one whose beats land on the most kick and snare hits wins, with a nudge
    // towards rhythm game tempos. Then the BPM is fine tuned and checked for drifting.
    async function findTempo(beats, hits, frames) {
        if (frames < 1500)
            return null;
        // it's a lot of work on a long song: the page gets a moment between the steps so it doesn't freeze
        let lastYield = performance.now();
        const breathe = async () => {
            if (performance.now() - lastYield > 25) {
                await new Promise(r => setTimeout(r));
                lastYield = performance.now();
            }
        };
        const mean = beats.reduce((a, b) => a + b, 0) / frames || 1e-6;

        // candidates from the autocorrelation of the drums
        const ac = [];
        for (let lag = 20; lag <= 140; lag++) {
            let s = 0;
            for (let i = 0; i + lag < frames; i += 2)
                s += hits[i] * hits[i + lag];
            ac[lag] = s;
            await breathe();
        }
        const peaks = [];
        for (let lag = 21; lag < 140; lag++)
            if (ac[lag] >= ac[lag - 1] && ac[lag] >= ac[lag + 1])
                peaks.push(lag);
        peaks.sort((a, b) => ac[b] - ac[a]);
        const candidates = [];
        for (const lag of peaks.slice(0, 6)) {
            // between whole frames: the top of a parabola through the peak and its neighbours
            const y0 = ac[lag - 1], y1 = ac[lag], y2 = ac[lag + 1];
            const d = y0 - 2 * y1 + y2;
            const exact = lag + (d ? 0.5 * (y0 - y2) / d : 0);
            for (const r of [1, 2, 0.5, 1.5, 2 / 3, 4 / 3, 0.75]) {
                const bpm = 6000 / exact * r;
                if (bpm >= 85 && bpm <= 280 && !candidates.some(c => Math.abs(c / bpm - 1) < 0.012))
                    candidates.push(bpm);
            }
        }

        // best phase for a period: where the strongest hits gather
        const strong = [];
        const th = percentile(beats, 0.85);
        for (let i = 1; i + 1 < frames; i++)
            if (beats[i] > th && beats[i] >= beats[i - 1] && beats[i] >= beats[i + 1]) {
                // the peak between frames
                const a = beats[i - 1], b = beats[i], c = beats[i + 1];
                const d = a - 2 * b + c;
                strong.push([i + (d ? 0.5 * (a - c) / d : 0), b]);
            }
        if (strong.length < 40)
            return null;
        const phaseFor = period => {
            const BINS = 100;
            const hist = new Float64Array(BINS);
            for (const [t, v] of strong)
                hist[Math.floor((t / period % 1) * BINS) % BINS] += v;
            let best = 0, at = 0;
            for (let k = 0; k < BINS; k++) {
                const v = hist[k] + 0.6 * (hist[(k + 1) % BINS] + hist[(k + BINS - 1) % BINS]);
                if (v > best) {
                    best = v;
                    at = k;
                }
            }
            return (at + 0.5) / BINS * period;
        };
        const prior = bpm => Math.exp(-0.5 * (Math.log2(bpm / 175) / 0.55) ** 2);

        // 1) each candidate tuned in 0.01 BPM steps: the tempo whose beats gather the strong hits most tightly
        const total = strong.reduce((t, x) => t + x[1], 0);
        const gather = bpm => {
            const period = 6000 / bpm, BINS = Math.max(8, Math.round(period * 4));
            const hist = new Float64Array(BINS);
            for (const [t, v] of strong)
                hist[Math.floor((t / period % 1) * BINS) % BINS] += v;
            let best = 0;
            for (let k = 0; k < BINS; k++) {
                let s = 0;
                for (let j = -2; j <= 2; j++)
                    s += hist[(k + j + BINS) % BINS];
                if (s > best)
                    best = s;
            }
            return best / total;
        };
        const tuned = [];
        for (const c of candidates) {
            await breathe();
            let top = null;
            for (let bpm = c * 0.984; bpm <= c * 1.016; bpm += 0.01) {
                const g = gather(bpm);
                if (!top || g > top.g)
                    top = { bpm, g };
            }
            if (!tuned.some(t => Math.abs(t.bpm / top.bpm - 1) < 0.003))
                tuned.push(top);
        }

        // 2) which of them is the beat: kicks and snares on its beats, and on its half beats too (a tempo 2/3 or 3/2 off
        // puts half of its beats between hits), with a nudge towards usual rhythm game tempos
        const fullScore = bpm => {
            const period = 6000 / bpm;
            let top = { s: -1, phase: 0 };
            for (let ph = 0; ph < period; ph += 0.25) {
                const v = beatScore(beats, period, ph);
                if (v > top.s)
                    top = { s: v, phase: ph };
            }
            const half = beatScore(beats, period, top.phase + period / 2);
            return { onBeats: top.s / mean, half: half / mean, phase: top.phase };
        };
        let best = null;
        for (const t of tuned) {
            await breathe();
            const f = fullScore(t.bpm);
            const score = (f.onBeats + 0.5 * f.half) * (0.55 + 0.45 * prior(t.bpm));
            if (!best || score > best.score)
                best = { bpm: t.bpm, phase: f.phase, score, onBeats: f.onBeats };
        }
        if (!best)
            return null;

        // 3) fine: 0.002 BPM steps
        await breathe();
        let fine = { ...best, g: gather(best.bpm) };
        for (let bpm = best.bpm - 0.03; bpm <= best.bpm + 0.03; bpm += 0.002) {
            const g = gather(bpm);
            if (g > fine.g)
                fine = { bpm, g, onBeats: best.onBeats };
        }
        // 4) precise: a straight line through the strong hits that sit on beats (time = offset + beat number x period)
        {
            let period = 6000 / fine.bpm, phase = fullScore(fine.bpm).phase;
            for (let pass = 0; pass < 3; pass++) {
                let n = 0, sk = 0, st = 0, skk = 0, skt = 0;
                for (const [t, v] of strong) {
                    const k = Math.round((t - phase) / period);
                    if (Math.abs(t - (phase + k * period)) > 2)
                        continue;
                    n += v;
                    sk += v * k;
                    st += v * t;
                    skk += v * k * k;
                    skt += v * k * t;
                }
                const det = n * skk - sk * sk;
                if (n < 20 || !det)
                    break;
                const p2 = (n * skt - sk * st) / det;
                if (!(p2 > 0) || Math.abs(p2 / period - 1) > 0.003)
                    break;
                phase = (st - p2 * sk) / n;
                period = p2;
            }
            fine.bpm = 6000 / period;
        }

        // a whole number when it's that close, otherwise two decimals
        let bpm = Math.abs(fine.bpm - Math.round(fine.bpm)) < 0.06 ? Math.round(fine.bpm) : Math.round(fine.bpm * 100) / 100;
        let period = 6000 / bpm;
        // phase to the millisecond for the rounded BPM
        let phase = phaseFor(period), top = -1;
        for (let p = phase - 2; p <= phase + 2; p += 0.1) {
            const s = beatScore(beats, period, p);
            if (s > top) {
                top = s;
                phase = p;
            }
        }
        phase = ((phase % period) + period) % period;

        // All the drums (hats and off-beat hits too) against a grid of quarter beats and one of third beats: the
        // grid they fit tells straight from swung, and when the kick and snare alone put the beat between two
        // groups of hits (a kick on the beat and one just before the next: the beat lands in the middle, off both),
        // the quarter grid the drums sit on puts it right
        const drumHits = [];
        {
            const th2 = percentile(hits, 0.8);
            for (let i = 1; i + 1 < frames; i++)
                if (hits[i] > th2 && hits[i] >= hits[i - 1] && hits[i] >= hits[i + 1]) {
                    const a = hits[i - 1], b = hits[i], c = hits[i + 1];
                    const d = a - 2 * b + c;
                    drumHits.push([i + (d ? 0.5 * (a - c) / d : 0), b]);
                }
        }
        const gridFit = q => {
            let best = { ph: 0, s: -1 };
            for (let ph = 0; ph < q; ph += 0.05) {
                let sc = 0;
                for (const [t, v] of drumHits) {
                    let d = ((t - ph) % q + q) % q;
                    d = Math.min(d, q - d);
                    sc += v * Math.exp(-0.5 * (d / 0.8) ** 2);
                }
                if (sc > best.s)
                    best = { ph, s: sc };
            }
            return best;
        };
        await breathe();
        const quarterFit = gridFit(period / 4), thirdFit = gridFit(period / 3);
        {
            const q = period / 4;
            let near = quarterFit.ph;
            while (near < phase - q / 2)
                near += q;
            while (near > phase + q / 2)
                near -= q;
            if (Math.abs(near - phase) > 1.5)
                phase = ((near % period) + period) % period;
        }
        // Which quarter of the beat is the beat: syncopated kicks (one just after the beat, one just before the next)
        // can pull the phase a 16th note off, so every note on a beat would sit a 16th early or late. Of the four
        // quarter-beat turns of the grid, the one whose beats (and, a little, half beats) carry the most kick and
        // snare wins, but only by a clear margin.
        {
            const q = period / 4;
            const score = ph => beatScore(beats, period, ph) + 0.6 * beatScore(beats, period, ph + period / 2);
            const base = score(phase);
            let best = 0, top = base;
            for (let k = 1; k < 4; k++) {
                const v = score(phase + k * q);
                if (v > top) {
                    top = v;
                    best = k;
                }
            }
            if (best && top >= 1.3 * base)
                phase = ((phase + best * q) % period + period) % period;
        }

        // does the beat stay put? the local shift that fits each 15 seconds' drums to the quarter grid best (not
        // more than half a quarter beat either way, or it would land on the next quarter)
        await breathe();
        const shifts = [];
        const reach = Math.min(5, period / 8 - 0.25);
        for (let from = 0; from + 1500 <= frames; from += 1500) {
            const inWindow = drumHits.filter(([t]) => t >= from && t < from + 1500);
            let bestShift = 0, bestS = -1;
            if (inWindow.length >= 20)
                for (let sh = -reach; sh <= reach + 1e-9; sh += 0.25) {
                    let sc = 0;
                    for (const [t, v] of inWindow) {
                        const q = period / 4;
                        let d = ((t - phase - sh) % q + q) % q;
                        d = Math.min(d, q - d);
                        sc += v * Math.exp(-0.5 * (d / 0.8) ** 2);
                    }
                    // (ties go to no shift)
                    if (sc > bestS * 1.02 || (Math.abs(sc - bestS) <= bestS * 0.02 && Math.abs(sh) < Math.abs(bestShift))) {
                        bestS = Math.max(sc, bestS);
                        bestShift = sh;
                    }
                }
            shifts.push(Math.round(bestShift * 2) / 2);
        }
        // (quiet stretches can't tell where the beat is, so a few windows off don't count against it)
        const steady = shifts.filter(s => Math.abs(s) <= 2).length >= shifts.length * 0.7;

        // swing: are the hits between beats on thirds rather than quarters?
        let thirds = 0, quarters = 0;
        for (let t = phase; t < frames - period; t += period) {
            thirds += around(hits, t + period / 3, 1) + around(hits, t + 2 * period / 3, 1);
            quarters += around(hits, t + period / 4, 1) + around(hits, t + 3 * period / 4, 1);
        }

        return {
            bpm, offsetMs: phase * 10, steady, triplet: thirds > quarters * 1.25 && thirdFit.s >= quarterFit.s * 0.85,
            confidence: fine.onBeats, shifts,
        };
    }


    // ------------------------------------------------ parts of the map that sound like this one

    // What a stretch of the song sounds like (as chooseTimes compares bars): when each kind of sound starts (kick,
    // snare, hats, melody, bass) at each eighth of a beat, and how loud its low, middle and high ends are
    function soundPrint(a, from, to, beatLen) {
        const n = Math.max(1, Math.round((to - from) / beatLen)) * 8;
        const step = (to - from) / n;
        const kinds = [a.sources.kick, a.sources.snare, a.sources.hat, a.sources.melody, a.sources.bass];
        const on = new Float32Array(n * 5);
        let norm = 0;
        for (let q = 0; q < n; q++) {
            const f0 = Math.max(0, Math.floor((from + (q - 0.5) * step) / 10));
            const f1 = Math.min(a.frames, Math.ceil((from + (q + 0.5) * step) / 10));
            for (let k = 0; k < 5; k++) {
                const env = kinds[k];
                let m = 0;
                if (env)
                    for (let f = f0; f < f1; f++)
                        m = Math.max(m, env[f]);
                on[q * 5 + k] = m;
                norm += m * m;
            }
        }
        const band = [0, 0, 0];
        let c = 0;
        for (let f = Math.max(0, Math.floor(from / 10)); f < Math.min(a.frames, to / 10); f++, c++) {
            band[0] += a.bandLow[f];
            band[1] += a.bandMid[f];
            band[2] += a.bandHigh[f];
        }
        return { n, on, norm: Math.sqrt(norm), band: band.map(v => v / Math.max(1, c)) };
    }
    // how alike two of them sound, 0 to 1
    function printSameness(p, q) {
        if (p.n !== q.n || p.norm < 1e-6 || q.norm < 1e-6)
            return 0;
        let dot = 0;
        for (let i = 0; i < p.on.length; i++)
            dot += p.on[i] * q.on[i];
        return dot / (p.norm * q.norm) * Math.exp(-Math.hypot(p.band[0] - q.band[0], p.band[1] - q.band[1], p.band[2] - q.band[2]) / 1.5);
    }

    // Similar to This Map (level 0 to 1): for each bar to be mapped, the bar already mapped (outside what's being
    // mapped) that sounds most like it, if it's alike enough (the higher the level, the less alike it has to be: at
    // 100% the closest one there is, unless it sounds nothing like it). Consecutive bars come from consecutive bars
    // where they can, so a phrase comes over as it was mapped, flowing from bar to bar the same way.
    // Each match: { from, to (the bar being mapped), sim, pts: [{ ms (moved onto this bar), x, y }] (the notes it
    // had), take (its rhythm is taken over with its notes: they go in as they were, turned or mirrored to join on;
    // otherwise its notes are the pattern the auto mapper likes best there) }.
    function similarParts(a, ctx, opts, times, level) {
        const src = (opts.similarNotes || []).filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.ms)
            && (n.ms < opts.startMs - 30 || n.ms > opts.endMs + 30)).sort((p, q) => p.ms - q.ms);
        if (!(level > 0) || src.length < 4)
            return [];
        let bars = ctx.allBars;
        if (!bars || !bars.length) {
            bars = [];
            for (let t = 0; t + 500 < a.frames * 10; t += 2000)
                bars.push({ from: t, to: Math.min(a.frames * 10, t + 2000), beatLen: 500 });
        }
        const notesIn = (from, to) => {
            let lo = 0, hi = src.length;
            while (lo < hi) {
                const m = (lo + hi) >> 1;
                if (src[m].ms < from - 15)
                    lo = m + 1;
                else
                    hi = m;
            }
            const out = [];
            for (let q = lo; q < src.length && src[q].ms < to - 15; q++)
                out.push(src[q]);
            return out;
        };
        // (how loud a stretch is, 0 to 1: the same loop in a quiet verse and in the drop is mapped differently)
        const loudIn = (from, to) => {
            let sum = 0, c = 0;
            for (let f = Math.max(0, Math.floor(from / 10)); f < Math.min(a.frames, to / 10); f++, c++)
                sum += a.loudness[f];
            return c ? sum / c : 0;
        };
        // the bars already mapped (wholly outside the part being mapped, with a couple of notes or more)
        const sources = [];
        bars.forEach((b, j) => {
            if (b.to > opts.startMs - 15 && b.from < opts.endMs + 15)
                return;
            const notes = notesIn(b.from, b.to);
            if (notes.length >= 2)
                sources.push({ j, b, notes, print: soundPrint(a, b.from, b.to, b.beatLen), loud: loudIn(b.from, b.to) });
        });
        if (!sources.length)
            return [];
        const thr = 0.8 - 0.35 * level;
        const out = [];
        const usedCount = new Map();
        let lastJ = -9;
        for (const b of bars) {
            // (bars wholly inside what's being mapped)
            if (b.from < opts.startMs - 15 || b.to > opts.endMs + 15)
                continue;
            const mine = soundPrint(a, b.from, b.to, b.beatLen), loud = loudIn(b.from, b.to);
            const mineCount = times.filter(t => t >= b.from - 15 && t < b.to - 15).length;
            let best = null;
            for (const sb of sources) {
                const sim = printSameness(mine, sb.print) - 0.6 * Math.abs(loud - sb.loud);
                if (sim < thr - 0.05)
                    continue;
                // (the next bar of the phrase being copied, a little preferred; one bar used over and over, a little
                // less, so a loop that comes round many times isn't all the same bar; and of bars that sound alike,
                // one with about as many notes as are wanted here)
                const score = sim + (sb.j === lastJ + 1 ? 0.06 : 0) - 0.03 * (usedCount.get(sb.j) || 0)
                    - 0.12 * Math.abs(Math.log((sb.notes.length + 1) / (mineCount + 1)));
                if (!best || score > best.score)
                    best = { sb, sim, score };
            }
            if (!best || best.sim < thr) {
                lastJ = -9;
                continue;
            }
            const { sb } = best;
            usedCount.set(sb.j, (usedCount.get(sb.j) || 0) + 1);
            lastJ = sb.j;
            const scale = (b.to - b.from) / Math.max(1, sb.b.to - sb.b.from);
            const pts = sb.notes.map(n => ({ ms: Math.round(b.from + (n.ms - sb.b.from) * scale), x: n.x, y: n.y }))
                .filter((p, q, arr) => p.ms > opts.startMs && p.ms < opts.endMs && (q === 0 || p.ms !== arr[q - 1].ms));
            if (pts.length < 2)
                continue;
            // Its rhythm too, where it has about as many notes as were picked for here (so the difficulty holds; from
            // 80%, anywhere from half as many to twice as many, at 100% a third to three times: a star rating asked
            // for is still met, by taking notes out after); less often the lower the level
            const [lo, hi] = level >= 0.95 ? [0.33, 3] : level >= 0.8 ? [0.5, 2] : [0.65, 1.5];
            const take = !(opts.count > 0) && !opts.gridFill && level >= 0.35 && Math.random() < Math.min(1, level * 1.25)
                && pts.length <= hi * mineCount + 1 && pts.length >= lo * mineCount - 1;
            out.push({ from: b.from, to: b.to, sim: best.sim, srcFrom: sb.b.from, srcTo: sb.b.to, pts, take });
        }
        return out;
    }

    // ------------------------------------------------ the song's sections

    // Beat times (ms) between fromMs and toMs, from the map's timing points or the detected tempo
    function beatTimes(timing, fromMs, toMs) {
        const out = [];
        for (let i = 0; i < timing.length; i++) {
            const tp = timing[i];
            const until = i + 1 < timing.length ? timing[i + 1].ms : toMs + 1;
            const beat = 60000 / tp.bpm;
            if (!(beat > 20))
                continue;
            let k = Math.ceil((Math.max(fromMs, tp.ms) - tp.ms) / beat - 1e-6);
            if (i === 0 && fromMs < tp.ms)
                k = Math.ceil((fromMs - tp.ms) / beat - 1e-6);
            for (let ms = tp.ms + k * beat; ms < Math.min(until, toMs + 0.5); ms = tp.ms + ++k * beat)
                out.push({ ms, index: k, tp: i });
        }
        return out;
    }

    // Splits the song into sections wherever its character changes (how loud it is, how much bass, mids and highs
    // are sounding, how many kicks, snares, hi-hats and melody notes there are), each at least 4 bars long, so a drop
    // that brings in an extra layer halfway becomes two sections. Each gets a level from 0 (calmest) to 1 (most
    // intense): mostly how loud the song is and how much bass is going on, then how busy the drums are (a snare roll
    // in a build-up is busy but has no bass, so it stays below the drop). Drops are intense sections that come after
    // a clearly calmer part, and the sections that carry them on.
    function findSections(a, bars) {
        const n = bars.length;
        if (!n)
            return [];
        if (!a.drumEvents)
            a.drumEvents = findEvents(a, DEFAULT_SOURCES, 0.5, 0, a.frames * 10);
        const ev = a.drumEvents;
        const mel = a.sources.melody;
        let e = 0;
        const KEYS = ['loud', 'lo', 'mi', 'hi', 'kick', 'snare', 'hat', 'melody', 'count', 'hits', 'onBeat', 'off8', 'off16'];
        const feat = bars.map(b => {
            const f0 = Math.max(0, Math.floor(b.from / 10)), f1 = Math.min(a.frames, Math.max(f0 + 1, Math.floor(b.to / 10)));
            let loud = 0, hits = 0, lo = 0, mi = 0, hi = 0, melody = 0;
            for (let f = f0; f < f1; f++) {
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
                lo += a.bandLow[f];
                mi += a.bandMid[f];
                hi += a.bandHigh[f];
                melody += mel[f];
            }
            while (e < ev.length && ev[e].ms < b.from)
                e++;
            let kick = 0, snare = 0, hat = 0, count = 0;
            for (let j = e; j < ev.length && ev[j].ms < b.to; j++) {
                const w = Math.min(1, ev[j].strength);
                count += w;
                if (ev[j].kinds.includes('kick'))
                    kick += w;
                if (ev[j].kinds.includes('snare'))
                    snare += w;
                if (ev[j].kinds.includes('hat'))
                    hat += w;
            }
            // the shape of the rhythm: how much of the drums falls on the beats, on the 8th notes between them and on
            // the 16ths (a drop switching to a syncopated kick, or adding 16th hi-hats, changes it)
            const slot = (b.to - b.from) / 16;
            let onBeat = 0, off8 = 0, off16 = 0;
            for (let q = 0; q < 16; q++) {
                const v = around(a.hits, (b.from + q * slot) / 10, 2);
                if (q % 4 === 0)
                    onBeat += v;
                else if (q % 2 === 0)
                    off8 += v;
                else
                    off16 += v;
            }
            const all = onBeat + off8 + off16 + 1e-6;
            const c = f1 - f0, secs = Math.max(0.1, (b.to - b.from) / 1000);
            return {
                loud: loud / c, hits: hits / c, lo: lo / c, mi: mi / c, hi: hi / c, melody: melody / c,
                kick: kick / secs, snare: snare / secs, hat: hat / secs, count: count / secs,
                onBeat: onBeat / all, off8: off8 / all, off16: off16 / all,
            };
        });
        const R = {};
        for (const k of KEYS)
            R[k] = rank(feat.map(f => f[k]));
        const v = bars.map((_, i) => 0.3 * R.loud[i] + 0.3 * R.lo[i] + 0.15 * R.hits[i] + 0.25 * R.count[i]);

        // character: every feature on the same scale (how many spreads from its average), loudness and bass counting
        // a little more
        const WEIGHT = { loud: 1.3, lo: 1.3 };
        const D = KEYS.length;
        const z = new Float64Array(n * D);
        KEYS.forEach((k, d) => {
            const vals = feat.map(f => f[k]);
            const mean = vals.reduce((p, q) => p + q, 0) / n;
            const sd = Math.sqrt(vals.reduce((p, q) => p + (q - mean) ** 2, 0) / n) || 1;
            for (let i = 0; i < n; i++)
                z[i * D + d] = (vals[i] - mean) / sd * (WEIGHT[k] || 1);
        });
        const pre = new Float64Array((n + 1) * D), pre2 = new Float64Array(n + 1);
        for (let i = 0; i < n; i++) {
            let sq = 0;
            for (let d = 0; d < D; d++) {
                pre[(i + 1) * D + d] = pre[i * D + d] + z[i * D + d];
                sq += z[i * D + d] ** 2;
            }
            pre2[i + 1] = pre2[i] + sq;
        }
        const sse = (i, j) => {
            let s2 = pre2[j] - pre2[i];
            for (let d = 0; d < D; d++) {
                const s = pre[j * D + d] - pre[i * D + d];
                s2 -= s * s / (j - i);
            }
            return s2;
        };
        // best split: least spread inside sections, plus a cost per section
        const MIN = Math.min(4, n), LAMBDA = 9;
        const cost = new Float64Array(n + 1).fill(Infinity), from = new Int32Array(n + 1);
        cost[0] = 0;
        for (let j = MIN; j <= n; j++)
            for (let i = 0; i <= j - MIN; i++) {
                if (cost[i] === Infinity)
                    continue;
                const c = cost[i] + sse(i, j) + LAMBDA;
                if (c < cost[j]) {
                    cost[j] = c;
                    from[j] = i;
                }
            }
        if (cost[n] === Infinity) {
            cost[n] = 0;
            from[n] = 0;
        }
        let cuts = [];
        for (let j = n; j > 0; j = from[j])
            cuts.unshift([from[j], j]);

        // Smaller changes inside a section (a drop bringing in an extra layer, switching its kick pattern): the
        // 4 bars after each bar line against the 4 before it. Over 4 bars a song's own little cycle (chords, a
        // repeating fill) evens out, so inside a steady part this stays near zero and a change stands out as a
        // clear peak. Such a part is split there (each side at least 4 bars), so the notes can change with it.
        const W = 4;
        const novelty = i => {
            if (i < W || i + W > n)
                return 0;
            let s2 = 0;
            for (let d = 0; d < D; d++) {
                const after = (pre[(i + W) * D + d] - pre[i * D + d]) / W, before = (pre[i * D + d] - pre[(i - W) * D + d]) / W;
                s2 += (after - before) ** 2;
            }
            return Math.sqrt(s2 / D);
        };
        const split = ([i, j]) => {
            if (j - i < 2 * W)
                return [[i, j]];
            const inner = [];
            for (let k = i + W; k <= j - W; k++)
                inner.push([k, novelty(k)]);
            const [at, peak] = inner.reduce((p, q) => q[1] > p[1] ? q : p);
            // the usual change, away from the peak (a change shows in the 3 bar lines either side of it too)
            const rest = inner.filter(x => Math.abs(x[0] - at) > W - 1).map(x => x[1]).sort((p, q) => p - q);
            const base = rest.length ? rest[Math.floor(rest.length / 2)] : 0;
            // a peak: well above the part's usual change, and higher than its neighbours a bar either side
            if (peak < Math.max(0.12, 2.5 * base, novelty(at - 1) * 1.15, novelty(at + 1) * 1.15))
                return [[i, j]];
            return [...split([i, at]), ...split([at, j]).map((c, q) => q ? c : [c[0], c[1], true])];
        };
        cuts = cuts.flatMap(c => split(c).map((x, q) => q ? [x[0], x[1], true] : x));
        const sections = cuts.map(([i, j, change]) => ({
            from: bars[i].from, to: bars[j - 1].to, level: v.slice(i, j).reduce((p, q) => p + q, 0) / (j - i), bars: j - i, drop: false,
            change: !!change,
        }));
        sections.forEach((s, i) => {
            const before = sections[i - 1];
            s.drop = s.level >= 0.62 && (!before || before.level <= s.level - 0.15 || (before.drop && s.level >= before.level - 0.12));
        });
        return sections;
    }

    // ------------------------------------------------ choosing when notes go

    // beat divisions, and how much a note on each position counts (on the beat most, then 1/2, then the rest)
    const STRAIGHT = [1, 2, 4, 8, 16];
    const SWUNG = [1, 3, 6, 12];
    function slotWeight(pos, div) {
        // pos: 0..div-1 within the beat
        if (pos === 0)
            return 1;
        for (const [d, w] of [[2, 0.72], [3, 0.6], [4, 0.55], [6, 0.42], [8, 0.4], [12, 0.33], [16, 0.3]])
            if (div % d === 0 && (pos * d) % div === 0)
                return w;
        return 0.3;
    }

    // ------------------------------------------------ what to put notes on

    // the kinds of sound notes can sync to, and how much each counts when there's more than the difficulty allows
    const SOURCE_WEIGHT = { kick: 1, snare: 1, hat: 0.55, melody: 0.75, bass: 0.7 };
    const DEFAULT_SOURCES = ['kick', 'snare', 'hat'];

    // The sounds worth a note: moments where one of the chosen kinds of sound starts, loud enough to count
    // (sensitivity 0..1) and standing out from what's around it. Silence and held sounds (pads, long vocal notes)
    // don't start anything, so they get nothing. [{ ms, strength, kinds }] in time order.
    function findEvents(a, sources, sensitivity, fromMs, toMs) {
        const thr = 0.34 - 0.3 * sensitivity;
        const f0 = Math.max(2, Math.floor(fromMs / 10) - 1), f1 = Math.min(a.frames - 2, Math.ceil(toMs / 10) + 1);
        const raw = [];
        for (const kind of sources) {
            const env = a.sources[kind];
            if (!env)
                continue;
            // a kind of sound the song (nearly) doesn't have: its envelope is only scaled-up noise
            if (a.sourceLevel[kind] < 0.01)
                continue;
            const weight = SOURCE_WEIGHT[kind];
            const base = smooth(env, 40);
            // low sounds ring longer: their echoes are ignored for longer
            // low sounds ring longer, and a sung note wobbles (vibrato): their echoes are ignored for longer
            const low = kind === 'kick' || kind === 'bass' || kind === 'melody';
            const tail = low ? 14 : 8;
            let lastF = -1e9, lastV = 0;
            for (let f = f0; f < f1; f++) {
                const v = env[f] * (0.3 + 0.7 * a.loudness[f]);
                if (v < thr || env[f] < base[f] * 1.4)
                    continue;
                if (env[f] < env[f - 1] || env[f] < env[f + 1] || env[f] < env[f - 2] || env[f] <= env[f + 2])
                    continue;
                // not just a bump in the tail of the sound before it
                let before = 0;
                for (let k = Math.max(0, f - tail); k < f - 1; k++)
                    before = Math.max(before, env[k]);
                if (env[f] < before * 0.5)
                    continue;
                // the same sound again: right after a hit (a kick's pitch falling sets the lowest frequencies off a
                // second time), or a clearly weaker one shortly after
                const since = f - lastF;
                if (low ? since < 9 || (since < 25 && v < lastV * 0.7) : since < 4 || (since < 10 && v < lastV * 0.4))
                    continue;
                lastF = f;
                lastV = v;
                // between frames: the top of a parabola through the peak and its neighbours
                const y0 = env[f - 1], y1 = env[f], y2 = env[f + 1], dd = y0 - 2 * y1 + y2;
                const frac = dd < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / dd)) : 0;
                raw.push({ ms: (f + frac) * 10, strength: Math.min(1.5, v) * weight, kinds: [kind] });
            }
        }
        raw.sort((p, q) => p.ms - q.ms);
        // one moment heard in several kinds of sound (a kick and a crash together) is one stronger event
        const out = [];
        for (const e of raw) {
            const last = out[out.length - 1];
            if (last && e.ms - last.ms <= 25) {
                if (e.strength > last.strength)
                    last.ms = e.ms;
                last.strength = Math.max(last.strength, e.strength) + 0.2 * Math.min(last.strength, e.strength);
                last.kinds.push(...e.kinds);
            } else
                out.push(e);
        }
        return out.filter(e => e.ms >= fromMs && e.ms <= toMs);
    }

    // Picks the note times. Notes go on sounds the song actually makes (the chosen kinds of sound), lined up on the
    // beat; where there's nothing, there are no notes. The difficulty sets how many of them may get a note: each
    // section of the song is allowed more or fewer (intense parts and drops more), and when there are more sounds than
    // that, the strongest and most on-beat ones win. Streams are only filled in between sounds where the song itself
    // is busy (Fill Streams).
    // How alike two bars have to sound to count as the same (0..1): then the later one copies the earlier one's
    // rhythm (human maps give such bars the same rhythm 90-100% of the time). Bars that are only alike (a melody note
    // that differs, a fill on top) lean towards the same rhythm and as many notes.
    const SAME_SOUND = 0.78, ALIKE_SOUND = 0.72;

    function chooseTimes(a, opts, nps, ctx) {
        const { startMs, endMs } = opts;
        const songMs = a.frames * 10;
        const beats = beatTimes(ctx.timing, 0, songMs);
        // bars of 4 beats, counted from the timing point
        const bars = [];
        for (let i = 0; i < beats.length; i++) {
            if (((beats[i].index % 4) + 4) % 4 !== 0 && bars.length)
                continue;
            const next = beats.slice(i + 1, i + 9).find(b => ((b.index % 4) + 4) % 4 === 0 || b.tp !== beats[i].tp);
            bars.push({ from: beats[i].ms, to: next ? next.ms : Math.min(songMs, beats[i].ms + 4 * 60000 / ctx.timing[beats[i].tp].bpm), first: i });
        }
        const sections = findSections(a, bars);
        ctx.sections = sections;
        ctx.allBars = bars.map(b => ({ from: b.from, to: b.to, beatLen: 60000 / ctx.timing[beats[b.first].tp].bpm }));

        // how close together notes may come at this difficulty: the fastest stretches get about 2.6x the average
        // notes a second, up to a top speed that rises with the difficulty (about 21 notes a second at 5, 42 at 10:
        // 1/16 streams at 130 BPM)
        const level10 = Math.min(10, Math.max(1, opts.difficulty || 5));
        // (how far the difficulty is from a to b, 0 to 1: what comes in between two difficulties comes in bit by bit
        // in between, so a map at 8.5 is between 8 and 9 rather than the same as 8)
        const ramp = (a, b) => Math.min(1, Math.max(0, (level10 - a) / (b - a)));
        const span_s = Math.max(1, (endMs - startMs) / 1000);
        // (a set number of notes sets its own speed: as fast as it takes to fit them)
        const countNps = opts.count > 0 ? Math.max(opts.count / span_s, 0.5) : 0;
        const dense = (opts.density || 1) >= 1.5;
        // (the shortest gap at a difficulty: lv, with the notes a second it averages)
        // (more Density lets it go faster, but never past difficulty 10's top speed, about 42 notes a second: beyond
        // that a stream can't be played, and a harder map than 10 only gets more notes and bigger jumps)
        const fastestAt = lv => 1000 / Math.min(Math.max(Math.min(12 * Math.pow(1.15, lv - 1) * Math.max(1, opts.density || 1), opts.force ? Infinity : 12 * Math.pow(1.15, 9)), countNps * 2.6),
            (countNps || nps * Math.pow(18, (lv - level10) / 9)) * 2.6);
        const fastest = fastestAt(level10);
        // the finest beat division allowed at a tempo: 1/1 or 1/2 for easy maps up to 1/16 for the hardest
        const topDivAt = (family, beatLen, lv) => {
            const f = fastestAt(lv);
            let top = family[0];
            for (const d of family)
                if (beatLen / d >= f * 0.95)
                    top = d;
            return top;
        };
        const topDiv = (family, beatLen) => topDivAt(family, beatLen, level10);

        // how many notes each section may have, averaging `nps` over the whole song
        const boost = opts.dropBoost ?? 1;
        // Calm Parts (0..1): how much the calm sections (intros, breakdowns) get compared to the intense ones
        const floor = 0.04 + 0.5 * (opts.calm ?? 0.3);
        const shape = s => (floor + (1.9 - floor) * Math.pow(s.level, 1 + 0.5 * boost)) * (s.drop ? 1 + 0.15 * boost : 1);
        const total = sections.reduce((t, s) => t + shape(s) * (s.to - s.from), 0) || 1;
        const span = sections.reduce((t, s) => t + (s.to - s.from), 0) || 1;
        sections.forEach(s => s.nps = nps * shape(s) * span / total);
        // Where the music carries on just as busy (about as many drum hits a second), the notes carry on too: next
        // to each other, two such sections can't differ much in how many notes they get just because the loudness
        // changes a little (a build-up into a drop, or a drop that's split in two). Real changes (a breakdown, the
        // drop kicking in, a quiet verse into a loud chorus over the same drums) still change as much as the music
        // does.
        const ev = a.drumEvents || [];
        for (const sec of sections) {
            let w = 0;
            for (const e of ev)
                if (e.ms >= sec.from && e.ms < sec.to)
                    w += Math.min(1, e.strength);
            sec.rate = w / Math.max(0.5, (sec.to - sec.from) / 1000);
        }
        for (let pass = 0; pass < 3; pass++)
            for (let i = 0; i + 1 < sections.length; i++) {
                const p = sections[i], q = sections[i + 1];
                const same = Math.min(p.rate, q.rate) / Math.max(p.rate, q.rate, 1e-6);
                // (and as much as their loudness changes: a verse and its drop can have the same drums)
                const allowed = 1.25 + 4 * Math.max(0, 0.85 - same) + 3 * Math.abs(p.level - q.level) + (p.drop !== q.drop ? 0.5 : 0);
                const [lo, hi] = p.nps < q.nps ? [p, q] : [q, p];
                if (hi.nps > lo.nps * allowed)
                    lo.nps = hi.nps / allowed;
            }
        // (still averaging `nps` over the song)
        const now = sections.reduce((t, s) => t + s.nps * (s.to - s.from), 0) / span;
        if (now > 0)
            sections.forEach(s => s.nps *= nps / now);
        // Where even the most intense part can't hold what it's allowed (a fast song at 9 or 10: every position at
        // the finest division the difficulty allows is still fewer notes), it would be cut to that ceiling, and so
        // would every part with more than that, so the drop and the parts around it would all come out the same.
        // Instead every part gives up some of its allowance, so the calmer parts stay calmer (most of the way: the
        // difficulty still makes a difference).
        if (!(opts.count > 0)) {
            const family = ctx.triplet ? SWUNG : STRAIGHT;
            const full = Math.min(1, (0.72 + 0.07 * Math.max(0, level10 - 8) + (opts.patterns === 'streams' ? 0.08 : 0)) * Math.max(1, opts.density || 1));
            let over = 1;
            for (const sec of sections) {
                let room = 0;
                for (const b of bars) {
                    if (b.from < sec.from || b.from >= sec.to)
                        continue;
                    const beatLen = 60000 / ctx.timing[beats[b.first].tp].bpm;
                    room += Math.max(1, Math.round((b.to - b.from) / beatLen)) * topDiv(family, beatLen) * full;
                }
                const capacity = room / Math.max(0.5, (sec.to - sec.from) / 1000);
                if (capacity > 0 && sec.to - sec.from >= 4000)
                    over = Math.max(over, sec.nps / capacity);
            }
            if (over > 1)
                sections.forEach(s => s.nps *= Math.pow(1 / over, 0.7));
        }
        const sectionAt = ms => sections.find(s => ms >= s.from && ms < s.to) || sections[sections.length - 1];
        const topLevel = Math.max(...sections.map(s => s.level));

        const inRange = bars.filter(b => b.to > startMs && b.from < endMs);
        // inside a section, a bar with more going on than usual there (a drum fill, a roll into a drop) gets more
        // notes, up to 2.5x, even for that one moment, and a bar with less a few fewer; the section's total stays
        // the same
        let e1 = 0;
        const barRate = bar => {
            while (e1 < ev.length && ev[e1].ms < bar.from)
                e1++;
            let w = 0;
            for (let q = e1; q < ev.length && ev[q].ms < bar.to; q++)
                w += Math.min(1, ev[q].strength);
            return w / Math.max(0.2, (bar.to - bar.from) / 1000);
        };
        let cap = inRange.map(b => {
            const part = (Math.min(b.to, endMs) - Math.max(b.from, startMs)) / (b.to - b.from);
            const sec = sectionAt(b.from);
            const act = sec.rate > 0 ? Math.max(0.6, Math.min(2.5, 0.6 + 0.4 * barRate(b) / sec.rate)) : 1;
            return { sec, w: sec.nps * (b.to - b.from) / 1000 * part, act };
        });
        {
            const plain = new Map(), weighted = new Map();
            for (const c of cap) {
                plain.set(c.sec, (plain.get(c.sec) || 0) + c.w);
                weighted.set(c.sec, (weighted.get(c.sec) || 0) + c.w * c.act);
            }
            cap = cap.map(c => c.w * c.act * plain.get(c.sec) / (weighted.get(c.sec) || 1));
        }
        if (opts.count > 0) {
            const sum = cap.reduce((p, q) => p + q, 0) || 1;
            cap = cap.map(w => w * opts.count / sum);
        }

        const shiftAt = ms => {
            if (!ctx.shifts)
                return 0;
            const i = Math.min(ctx.shifts.length - 1, Math.max(0, Math.floor(ms / 15000)));
            return ctx.shifts[i] * 10;
        };
        const beatAt = ms => {
            let lo = 0, hi = beats.length - 1;
            while (hi - lo > 1) {
                const m = (lo + hi) >> 1;
                if (beats[m].ms <= ms)
                    lo = m;
                else
                    hi = m;
            }
            return lo;
        };
        // where a time falls on the beat divided into `div`: the nearest position, how far off that is and how much
        // a note there counts
        const gridAt = (ms, div) => {
            const i = beatAt(ms - shiftAt(ms));
            const t0 = beats[i].ms + shiftAt(beats[i].ms);
            const len = i + 1 < beats.length ? beats[i + 1].ms - beats[i].ms : 60000 / ctx.timing[beats[i].tp].bpm;
            const step = len / div;
            const p = Math.round((ms - t0) / step);
            const at = t0 + p * step;
            return { at, err: Math.abs(at - ms), step, weight: slotWeight(((p % div) + div) % div, div) };
        };
        // Difficulty in steps rather than jumps: the finest division comes in at a difficulty in short bursts (a beat),
        // the next difficulty up lets it run a bar, and from the one after as long as the music goes. (Otherwise a
        // tempo's 1/16 streams would come in all at once at one difficulty and nothing would change at the next; and
        // in Rhythia a long one-cell stream is easier than bursts with jumps between them.) How many beats a run of
        // notes at the finest division may last:
        const burstAt = (family, beatLen, top = topDiv(family, beatLen)) => {
            if (opts.count > 0)
                return Infinity;
            return top > topDivAt(family, beatLen, level10 - 1) ? 1 : top > topDivAt(family, beatLen, level10 - 2) ? 4 : Infinity;
        };
        // a sound counts as on a position when it's within a quarter of a step of it: at least 12ms (how precisely a
        // sound's start can be heard in the song) and at most 20ms
        const tolerance = step => Math.min(20, Math.max(12, 0.25 * step));
        const finer = (family, d) => family[Math.min(family.length - 1, family.indexOf(d) + 1)];

        const sources = opts.sources && opts.sources.length ? opts.sources : DEFAULT_SOURCES;
        // (a flam: a weaker sound on its own just before a much stronger one, 45ms or less, is part of that hit, not
        // a note of its own; mapped, it would put a 1/16 of a beat into a bar of 1/2 beats. A stream of sounds, each
        // with another just before it, keeps all of them)
        const events = findEvents(a, sources, opts.sensitivity ?? 0.5, startMs - 200, endMs + 200).filter((e, q, all) => {
            const next = all[q + 1], last = all[q - 1];
            return !(next && next.ms - e.ms <= 45 && next.strength >= 1.3 * e.strength && !(last && e.ms - last.ms <= 45));
        });
        // The sounds as found sit a little off the beat grid, all of them the same way (how a sound's peak trails
        // its start, or timing a few ms off): measured once on the strong sounds near the quarter beats, and taken
        // off before asking which division a sound is on, so a fast roll's hits all count as on it. The notes still
        // go exactly on the grid.
        const lag = (() => {
            const offs = [];
            for (const e of events) {
                if (e.strength < 0.5)
                    continue;
                const g = gridAt(e.ms, 4);
                if (g.err <= Math.min(20, 0.3 * g.step))
                    offs.push(e.ms - g.at);
            }
            if (offs.length < 30)
                return 0;
            offs.sort((p, q) => p - q);
            return Math.max(-12, Math.min(12, offs[offs.length >> 1]));
        })();
        const heardOn = (ms, div) => gridAt(ms - lag, div);

        // (a stream map streams wherever the song is busy, unless asked otherwise)
        const fill0 = opts.fill || 'intense';
        const fill = fill0 === 'intense' && opts.patterns === 'streams' ? 'busy' : fill0;
        const avoid = opts.avoid || [];
        let out = [];
        let heard = new Map(); // note time on the grid -> when its sound is heard

        // maps every bar; scale: section -> how much of its note allowance to use; push: more notes everywhere
        // (mult) and, to reach a set number of notes, streams in more places (stage 1: any busy part, 2: also where
        // there's one sound a beat, a division finer, and across gaps of two beats, 3: in any bar with a sound in it,
        // across gaps of four beats; bars with no sound at all stay empty)
        // (notes each bar got the first time, so a section can be scaled down from what it really got: its allowance
        // can be far above what its bars can hold)
        const firstCount = [];

        // Mapped like a plan: bars that sound the same (a loop coming round again, the same fill, a chorus coming
        // back) get the same rhythm, so the same sound never gets a pattern one time and a lone note the next. What a
        // bar sounds like: when each kind of sound starts (kick, snare, hats, melody, bass) at each eighth of a beat,
        // and how loud its low, middle and high ends are. proto[j]: the earlier bar that bar j repeats (or -1); its
        // notes are copied, moved along to bar j (only between parts of the song about as busy as each other: the same
        // loop in a calm intro and in the drop isn't mapped the same).
        const sounds = inRange.map(b => {
            const beatLen = 60000 / ctx.timing[beats[b.first].tp].bpm;
            const n = Math.max(1, Math.round((b.to - b.from) / beatLen)) * 8;
            const step = (b.to - b.from) / n;
            const kinds = [a.sources.kick, a.sources.snare, a.sources.hat, a.sources.melody, a.sources.bass];
            const on = new Float32Array(n * 5);
            let norm = 0;
            for (let q = 0; q < n; q++) {
                const f0 = Math.max(0, Math.floor((b.from + (q - 0.5) * step) / 10));
                const f1 = Math.min(a.frames, Math.ceil((b.from + (q + 0.5) * step) / 10));
                for (let k = 0; k < 5; k++) {
                    let m = 0;
                    for (let f = f0; f < f1; f++)
                        m = Math.max(m, kinds[k][f]);
                    on[q * 5 + k] = m;
                    norm += m * m;
                }
            }
            const band = [0, 0, 0];
            let c = 0;
            for (let f = Math.max(0, Math.floor(b.from / 10)); f < Math.min(a.frames, b.to / 10); f++, c++) {
                band[0] += a.bandLow[f];
                band[1] += a.bandMid[f];
                band[2] += a.bandHigh[f];
            }
            return { n, len: b.to - b.from, on, norm: Math.sqrt(norm), band: band.map(v => v / Math.max(1, c)) };
        });
        const sameness = (p, q) => {
            if (p.n !== q.n || Math.abs(p.len - q.len) > p.len * 0.02 || p.norm < 1e-6 || q.norm < 1e-6)
                return 0;
            let dot = 0;
            for (let i = 0; i < p.on.length; i++)
                dot += p.on[i] * q.on[i];
            return dot / (p.norm * q.norm) * Math.exp(-Math.hypot(p.band[0] - q.band[0], p.band[1] - q.band[1], p.band[2] - q.band[2]) / 1.5);
        };
        // (and by its drums alone, to tell how busy a bar is: the same drums under another bass note are as busy)
        const drumLike = inRange.map((b, j) => {
            const kinds = ['kick', 'snare', 'hat'].map(k => a.sources[k]).filter(Boolean);
            if (!kinds.length || !j)
                return -1;
            const sec = sectionAt(b.from);
            const print = bb => {
                const beatLen = 60000 / ctx.timing[beats[bb.first].tp].bpm;
                const n = Math.max(1, Math.round((bb.to - bb.from) / beatLen)) * 8, step = (bb.to - bb.from) / n;
                const v = new Float32Array(n * kinds.length);
                for (let q = 0; q < n; q++) {
                    const f0 = Math.max(0, Math.floor((bb.from + (q - 0.5) * step) / 10)), f1 = Math.min(a.frames, Math.ceil((bb.from + (q + 0.5) * step) / 10));
                    kinds.forEach((env, k) => {
                        let m = 0;
                        for (let f = f0; f < f1; f++)
                            m = Math.max(m, env[f]);
                        v[q * kinds.length + k] = m;
                    });
                }
                return v;
            };
            const mine = print(b);
            let best = -1, top = ALIKE_SOUND;
            for (let i = Math.max(0, j - 8); i < j; i++) {
                if (sectionAt(inRange[i].from) !== sec)
                    continue;
                const o = print(inRange[i]);
                if (o.length !== mine.length)
                    continue;
                let dot = 0, na = 0, nb = 0;
                for (let q = 0; q < o.length; q++) {
                    dot += o[q] * mine[q];
                    na += o[q] * o[q];
                    nb += mine[q] * mine[q];
                }
                const v = na && nb ? dot / Math.sqrt(na * nb) : 0;
                if (v >= top) {
                    top = v;
                    best = i;
                }
            }
            return best;
        });
        // (a break: a near-silent section between louder ones, the intro and the end aside, where the music stops
        // for a moment before a drop; and how strong a sound has to be to count there, half again its usual one)
        // (and a quiet lead-in or fade-out: a quiet part next to one three times as loud, a riser before the drop
        // or the song dying away, which human maps leave nearly empty; the intro is the song's start, mapped)
        const isBreak = sec => {
            const q = sections.indexOf(sec);
            if (q <= 0 || sec.level >= 0.15)
                return false;
            const next = q + 1 < sections.length ? sections[q + 1].level : 0;
            const lo = Math.min(sections[q - 1].level, next), hi = Math.max(sections[q - 1].level, next);
            return hi >= 3 * sec.level && (sec.level < 0.1 && lo >= 1.5 * sec.level || hi >= 0.3);
        };
        // (a break bar and a bar mapped normally never copy each other: a fade-out replaying the intro's loop is
        // still a fade-out)
        const brkOf = inRange.map(b => isBreak(sectionAt(b.from)));
        const like = inRange.map(() => -1);
        const proto = inRange.map((b, j) => {
            let best = -1, top = ALIKE_SOUND;
            const nj = sectionAt(b.from).nps;
            for (let i = 0; i < j; i++) {
                const ni = sectionAt(inRange[i].from).nps;
                if (ni > nj * 1.43 || ni < nj * 0.7 || brkOf[i] !== brkOf[j])
                    continue;
                const v = sameness(sounds[i], sounds[j]);
                if (v >= top) {
                    top = v;
                    best = i;
                }
            }
            like[j] = best;
            return top >= SAME_SOUND ? best : -1;
        });
        const rootOf = j => {
            while (proto[j] >= 0)
                j = proto[j];
            return j;
        };
        // which bar a note time is in (a bar's sounds count from 20ms before it starts)
        const barIndexOf = t => {
            let lo = 0, hi = inRange.length - 1;
            while (lo < hi) {
                const m = (lo + hi + 1) >> 1;
                if (inRange[m].from - 20 <= t)
                    lo = m;
                else
                    hi = m - 1;
            }
            return lo;
        };
        ctx.bars = inRange.map((b, j) => ({ from: b.from, to: b.to, proto: proto[j], like: like[j] }));

        // How much sound there is at the positions only division `dNew` has, next to at the positions of `dOld`
        // (onset strength, where the sounds are heard): about 0 for a stream between hats with nothing under it,
        // 0.5-1 for a real roll or a hat between the hats
        const hitAt = ms => {
            const f = Math.round((ms + lag) / 10);
            let m = 0;
            for (let g = Math.max(0, f - 1); g <= Math.min(a.frames - 1, f + 1); g++)
                m = Math.max(m, a.hits[g]);
            return m;
        };
        const soundAt = (b, beatsIn, beatLen, dNew, dOld) => {
            let sNew = 0, nNew = 0, sOld = 0, nOld = 0;
            for (let bi = 0; bi < beatsIn; bi++) {
                const t0 = b.from + bi * beatLen;
                for (let p = 0; p < dNew; p++) {
                    const v = hitAt(t0 + p * beatLen / dNew);
                    if ((p * dOld) % dNew === 0) {
                        sOld += v;
                        nOld++;
                    } else {
                        sNew += v;
                        nNew++;
                    }
                }
            }
            return nNew && sOld > 0 ? (sNew / nNew) / (sOld / nOld) : 0;
        };
        const faint = new Map();
        const faintIn = sec => {
            if (!faint.has(sec)) {
                const st = events.filter(e => e.ms >= sec.from && e.ms < sec.to).map(e => e.strength).sort((p, q) => p - q);
                faint.set(sec, st.length ? 1.5 * st[st.length >> 1] : 0);
            }
            return faint.get(sec);
        };
        // (in a jump map, whether a bar is in a stream phrase: decided per two-bar phrase, the same for every bar
        // that repeats it. Human jump maps take turns, a jump phrase then a stream phrase, through their intense
        // parts (about half their busy phrases have streams), every third phrase in medium ones and now and then
        // in calm ones; never a wall of jumps for a minute)
        // A mixed map's Streams / Jumps balance (opts.jumpShare, 0..1): its calmest parts, that share of the song, are
        // jump parts and the rest, the intense parts and the drops, streams (all streams at 0, all jumps at 1)
        const jumpShare = opts.patterns === 'jumps' ? 1 : opts.patterns === 'streams' ? 0 : Math.min(1, Math.max(0, opts.jumpShare ?? 0.5));
        const jumpBelow = (() => {
            if (jumpShare <= 0)
                return -Infinity;
            if (jumpShare >= 1)
                return Infinity;
            const live = sections.filter(x => x.to > startMs && x.from < endMs).slice().sort((p, q) => p.level - q.level);
            const total = live.reduce((t, x) => t + Math.min(endMs, x.to) - Math.max(startMs, x.from), 0);
            let acc = 0;
            for (const x of live) {
                acc += Math.min(endMs, x.to) - Math.max(startMs, x.from);
                if (acc >= jumpShare * total)
                    return x.level + 1e-9;
            }
            return Infinity;
        })();
        // (whether a bar is in a stream part or a jump part: a stream map is all streams and a jump map all jumps, on
        // the song's own rhythm; a mixed map's parts are one or the other by how intense they are, see jumpShare.
        // Decided on the bar a repeat copies, so the copy is the same kind)
        const isStreamBar = j => {
            return sectionAt(inRange[rootOf(j)].from).level >= jumpBelow;
        };
        // (a mixed map's jump parts, so their notes are placed as jumps: see generate)
        if (opts.patterns !== 'jumps' && opts.patterns !== 'streams' && jumpShare > 0) {
            const parts = inRange.filter((b, j) => !isStreamBar(j)).map(b => [b.from - 20, b.to - 20]);
            ctx.jumpPart = ms => parts.some(([f, t]) => ms >= f && ms < t);
        } else
            ctx.jumpPart = null;
        const mapBars = (scale, push = { mult: 1, stage: 0 }) => {
        out = [];
        heard = new Map();
        let carry = 0;
        const firstPass = !firstCount.length;
        // each bar's notes, as times from the bar's start (for the bars that repeat it)
        const rel = [];
        // (the notes that are slides in jump parts, and where they are in each bar: a bar's repeats slide the same)
        const slideTimes = new Set(), slideRel = [];
        ctx.slideTimes = slideTimes;
        // (and whether each bar is a stream or a jump phrase, in a jump map, and whether it was busy)
        const kindOf = [], busyOf = [], fullDivOf = [];
        inRange.forEach((b, j) => {
            const s = sectionAt(b.from);
            const beatLen = 60000 / ctx.timing[beats[b.first].tp].bpm;
            const beatsIn = Math.max(1, Math.round((b.to - b.from) / beatLen));
            // (where the bar's beats are on the grid the notes go on, which a drifting tempo shifts a little)
            const beatT = h => gridAt(b.from + h * beatLen, 1).at;
            // (in a break, a near-silent part between louder ones, only its clearly heard sounds: not every faint one)
            const brk = isBreak(s);
            const raw = events.filter(e => e.ms >= b.from - 20 && e.ms < b.to - 20 && (!brk || e.strength >= faintIn(s)));
            // The finest division this bar may have. One that the difficulty has only just let in comes in a few bars
            // at a time: over the first level after it comes in, in more and more of the bars (spread over the song,
            // a bar and the bars repeating it alike), so a map gets harder bit by bit with the difficulty instead of
            // every drop turning into twice as fast a stream at once.
            // (a bar's place in that order: bars repeating each other alike)
            const order = ((rootOf(j) + 1) * 0.6180339887) % 1;
            // (divAt: the division at a difficulty)
            const eased = divAt => {
                const t = divAt(level10);
                if (opts.count > 0 || divAt(level10 - 1) >= t)
                    return t;
                let lo = level10 - 1, hi = level10;
                for (let q = 0; q < 10; q++) {
                    const m = (lo + hi) / 2;
                    if (divAt(m) >= t)
                        hi = m;
                    else
                        lo = m;
                }
                return order < level10 - hi ? t : divAt(lo);
            };
            // (the top division by how fast notes may come, at `speed` times what this difficulty and Density allow: it
            // comes in over the last 15% of speed before it, so more Density brings it in as gradually as the
            // difficulty does)
            const topHere = (family, beatLen) => {
                const at = speed => {
                    let top = family[0];
                    for (const d of family)
                        if (beatLen / d >= fastest / speed * 0.95)
                            top = d;
                    return top;
                };
                const t = at(1), lowest = 1 / 1.15;
                if (opts.count > 0 || at(lowest) >= t)
                    return t;
                let lo = lowest, hi = 1;
                for (let q = 0; q < 10; q++) {
                    const m = (lo + hi) / 2;
                    if (at(m) >= t)
                        hi = m;
                    else
                        lo = m;
                }
                return order < Math.log(1 / hi) / Math.log(1.15) ? t : at(lo);
            };

            // One beat division for the whole bar: the simplest one (straight 1/1, 1/2, 1/4... or triplet 1/3,
            // 1/6...) that the bar's sounds sit on, but no finer than the difficulty allows. Every note in the bar,
            // streams included, goes on it, so straight and triplet positions never mix and a stream stays even.
            // A division only counts as one the sounds sit on if they do so far more than they would by luck: the
            // finer it is, the more of the bar is near one of its positions anyway (at a twelfth of a beat at 180 BPM
            // nearly all of it). Where none fits, the one that fits best (the coarser of two about as good), and the
            // sounds off it are left out.
            const fit = family => {
                const top = topHere(family, beatLen);
                const total = raw.reduce((t, e) => t + e.strength, 0);
                let best = null;
                for (const div of family) {
                    if (div > top)
                        break;
                    let on = 0;
                    for (const e of raw) {
                        const g = heardOn(e.ms, div);
                        if (g.err <= tolerance(g.step))
                            on += e.strength;
                    }
                    const share = total ? on / total : 1;
                    const step = beatLen / div, luck = Math.min(0.95, 2 * tolerance(step) / step);
                    const sure = (share - luck) / (1 - luck);
                    // (a division so fine that most of the bar is near one of its positions anyway, 1/16 of a beat
                    // at 128 BPM, says nothing about where the sounds are: a bar of scattered, smeared sounds fits it
                    // as well as a real arpeggio. It only counts where the song has sound at its own positions too,
                    // the ones the next coarser division doesn't have, or when nothing coarser fits at all.)
                    const fine = luck > 0.7;
                    const heardFine = fine && share >= 0.85 && sure >= 0.6 && family.indexOf(div) > 0
                        && soundAt(b, beatsIn, beatLen, div, family[family.indexOf(div) - 1]) >= 0.35;
                    if (fine && best && !heardFine)
                        continue;
                    if (share >= 0.85 && sure >= 0.6 && (!fine || heardFine))
                        return { family, div, full: true, share, sure };
                    if (!best || sure > best.sure + 0.05)
                        best = { family, div, full: false, share, sure };
                }
                return best;
            };
            const main = fit(ctx.triplet ? SWUNG : STRAIGHT), other = fit(ctx.triplet ? STRAIGHT : SWUNG);
            // (the other kind, triplets in a straight song or the other way round, only where they clearly fit
            // better, at a division songs really play: a triplet fill, not a bar of noise that half fits anything.
            // And only for sounds the song's own kind can't place even at its 1/8 (or 1/6) beat, at least two of
            // them and a quarter of the bar's sound: a straight 1/8 note just reaches a third of a beat, and one
            // kick a little off would otherwise make the bar triplets)
            const onlyOther = () => {
                const mDiv = main.family === STRAIGHT ? 8 : 6;
                let n = 0, w = 0, total = 0;
                for (const e of raw) {
                    total += e.strength;
                    const go = heardOn(e.ms, other.div), gm = heardOn(e.ms, mDiv);
                    if (go.err <= tolerance(go.step) && gm.err > tolerance(gm.step)) {
                        n++;
                        w += e.strength;
                    }
                }
                return n >= 2 && w >= 0.25 * total;
            };
            const grid = other.full && other.div <= 6 && other.sure >= main.sure + 0.2 && onlyOther() ? other : main;
            const { family } = grid;
            let { div } = grid;
            // (a busy bar whose sounds only half fit, next to a bar with the same sound or drums that fitted clearly:
            // that bar's division, so bars that sound alike aren't mapped one as a stream and one as a few notes)
            let fullFit = grid.full;
            if (!fullFit && push.stage === 0) {
                const ref = [like[j], drumLike[j]].find(r => r >= 0 && fullDivOf[r] && fullDivOf[r].family === family);
                if (ref !== undefined) {
                    div = fullDivOf[ref].div;
                    fullFit = true;
                }
            }
            fullDivOf[j] = fullFit ? { family, div } : null;
            // A jump map has whole phrases (two bars) of jumps on the song's own rhythm, and stream phrases between
            // them, more of those the more intense the part is (every other phrase in the intense parts, every third
            // in medium ones, see isStreamBar), as in human jump maps (decided once for a bar and every bar that
            // repeats it). A jump phrase keeps to a division whose
            // notes are far enough apart to jump between (a quarter of a beat at 180 BPM): its notes go on the
            // strongest sounds there, and the quicker sounds are left to the stream phrases.
            const top = s.level / Math.max(0.05, topLevel);
            const root = rootOf(j);
            const streamBar = push.stage >= 1 || isStreamBar(j);
            if (!streamBar) {
                // (the division for jumps the difficulty allows only in the intense parts, and there every other
                // phrase: the rest one level down, so jump phrases differ and a drop isn't one wall of the same jumps)
                const stepAt = lv => Math.max(65, 2000 / (0.55 * 4 * Math.pow(1.36, lv - 1)));
                // (the same rule the jumps are placed by, jumpGap: a finer division would be timed for jumps and then
                // played as steps)
                // (every other jump phrase of an intense part at the quickest jumps the difficulty takes, the rest one
                // division coarser: at 10 in the medium parts too)
                // (a few percent of leeway, so a tempo just over a step doesn't drop a whole difficulty to half speed)
                const onDiv = eased(lv => family.filter(d => beatLen / d >= 0.95 * stepAt(lv)).pop() || family[0]);
                const offDiv = family.filter(d => d < onDiv).pop() || onDiv;
                const coarse = (top >= 0.8 - 0.25 * ramp(9, 10) || s.drop) && (root >> 2) % 2 === 0 ? onDiv : offDiv;
                div = Math.min(div, coarse);
            }

            // The finest division a stream may fill in at: one finer than the bar's own sounds, and only where they
            // clearly sit on their division (where a few only half fit, the stream stays on it: it would be twice as
            // fast as anything in the music); another in the drops at 9 and 10, as bursts (see burstAt), only where
            // the song has sound at those positions too (a roll, a hat between the hats) and never in a jump map;
            // more with more Density, or to reach a set number of notes.
            // (a bar that only half fits but is full of sounds, as many as half its positions, still streams, a busy
            // part whose sounds wander a little off the grid: at most at 35ms, where it can't be told from a smear)
            let finest = fullFit || push.stage > 0 || (raw.length >= 0.5 * div * beatsIn && beatLen / finer(family, div) >= 35)
                ? finer(family, div) : div;
            if (fullFit && push.stage === 0 && opts.patterns !== 'jumps' && (s.drop || top >= 0.9) && order < ramp(8, 9)) {
                const next = finer(family, finest);
                if (next > finest && soundAt(b, beatsIn, beatLen, next, finest) >= 0.35)
                    finest = next;
            }
            for (let q = (dense ? 1 : 0) + Math.min(2, Math.max(0, push.stage - 1)); q > 0; q--)
                finest = finer(family, finest);

            const sc = scale.get(s);
            const exact = (sc === undefined || firstCount[j] === undefined ? cap[j] * push.mult : Math.min(cap[j], firstCount[j]) * sc * push.mult) + carry;
            // (a bar like an earlier one gets about as many notes as it did)
            const lk = like[j] >= 0 && rel[like[j]] ? rel[like[j]] : null;
            kindOf[j] = streamBar;
            // (only the same kind of phrase: a stream bar isn't held to a jump bar's few notes)
            const want = lk && kindOf[like[j]] === streamBar ? (exact + lk.length) / 2 : exact;
            // never more notes than the bar has positions at the finest division allowed
            // (and not every position at the fastest division either: a bar that would fill all of them keeps its
            // strongest sounds, about three quarters, so even the most intense parts have a rhythm rather than one
            // even stream from start to end; a little more at 9 and 10, so they're harder than 8 even where the tempo
            // allows no faster notes; more Density lets it fill more, and a set number of notes as many as it takes)
            const full = push.stage > 0 || opts.count > 0 ? 1
                : Math.min(1, (0.72 + 0.07 * Math.max(0, level10 - 8) + (opts.patterns === 'streams' ? 0.08 : 0)) * Math.max(1, opts.density || 1));
            const k = Math.max(0, Math.min(Math.round(want), Math.max(1, Math.floor(beatsIn * Math.min(topHere(family, beatLen), Math.max(div, finest)) * full))));
            // how close notes may be: the beat division this many notes needs
            const d = Math.min(topHere(family, beatLen), family.find(d => d >= k / beatsIn * 1.05) || family[family.length - 1]);
            const minGap = beatLen / Math.max(d, 1) * 0.85;
            const ok = ms => ms >= startMs && ms <= endMs && avoid.every(t => Math.abs(t - ms) >= minGap);

            // sounds that aren't on the bar's division (a flam, a grace note, an off-beat sound at an easy
            // difficulty) are left out rather than moved a long way from where they're heard
            // (and in a bar like an earlier one, the sounds where that bar had its notes come first)
            const here = raw.map(e => {
                const g = heardOn(e.ms, div);
                const was = lk && lk.some(dt => Math.abs(b.from + dt - g.at) <= 3);
                return g.err <= Math.max(tolerance(g.step), Math.min(25, 0.5 * g.step))
                    ? { ms: Math.round(g.at), src: e.ms, str: e.strength, score: e.strength * (0.55 + 0.45 * g.weight) * (was ? 1.8 : 1) } : null;
            }).filter(e => e && ok(e.ms));
            // a bar that sounds like one before it: the same notes, moved along
            if (proto[j] >= 0 && rel[proto[j]]) {
                const copied = [];
                for (const dt of rel[proto[j]]) {
                    const ms = Math.round(b.from + dt);
                    if (!ok(ms) || copied.includes(ms))
                        continue;
                    copied.push(ms);
                    const own = here.find(e => Math.abs(e.ms - ms) <= 2);
                    if (own)
                        heard.set(ms, own.src);
                }
                rel[j] = copied.map(t => t - b.from);
                if (slideRel[proto[j]]) {
                    slideRel[j] = slideRel[proto[j]];
                    for (const dt of slideRel[j])
                        if (copied.includes(Math.round(b.from + dt)))
                            slideTimes.add(Math.round(b.from + dt));
                }
                carry = Math.min(2, Math.max(-2, exact - copied.length));
                if (firstPass)
                    firstCount[j] = copied.length;
                out.push(...copied);
                return;
            }
            // the strongest sounds, spread over the bar first (a bar's few notes all bunched at its start, then
            // nothing, feels like the map stopped), then the rest of the strongest wherever they are
            const picked = [];
            // (a bar like an earlier one: first the earlier bar's notes, wherever this bar has the sound for them)
            if (lk)
                for (const dt of lk) {
                    const e = here.find(x => Math.abs(x.ms - (b.from + dt)) <= 3);
                    if (e && picked.length < k && picked.every(t => Math.abs(t - e.ms) >= minGap)) {
                        picked.push(e.ms);
                        heard.set(e.ms, e.src);
                    }
                }
            // A roll (hits about as strong as each other on nearly every position of the bar's division: a snare roll
            // in a build-up, a tom fill) with more hits than the bar may have is thinned evenly, every second or
            // third hit counting back from the downbeat it leads into, not by which hits came out a little louder
            const uniq = [...new Map(here.map(e => [e.ms, e])).values()].sort((p, q) => p.ms - q.ms);
            const mean = uniq.reduce((t, e) => t + e.str, 0) / Math.max(1, uniq.length);
            const sd = Math.sqrt(uniq.reduce((t, e) => t + (e.str - mean) ** 2, 0) / Math.max(1, uniq.length));
            const roll = fullFit && div >= 4 && uniq.length >= 0.7 * beatsIn * div && sd <= 0.35 * mean && uniq.length >= 1.5 * k;
            if (roll) {
                const every = Math.ceil(uniq.length / Math.max(1, k));
                const to = uniq.length - 1 + Math.round((b.to - uniq[uniq.length - 1].ms) / (beatLen / div));
                for (let q = 0; q < uniq.length; q++)
                    if ((to - q) % every === 0 && ok(uniq[q].ms)) {
                        picked.push(uniq[q].ms);
                        heard.set(uniq[q].ms, uniq[q].src);
                    }
            }
            const spread = Math.max(minGap, 0.55 * (b.to - b.from) / Math.max(1, k));
            for (const gap of roll ? [] : [spread, minGap])
                for (const e of here.sort((p, q) => q.score - p.score)) {
                    if (picked.length >= k)
                        break;
                    if (picked.every(t => Math.abs(t - e.ms) >= gap)) {
                        picked.push(e.ms);
                        heard.set(e.ms, e.src);
                    }
                }
            picked.sort((p, q) => p - q);

            // streams between the sounds, only where the song itself is busy (two sounds a beat or more), and at
            // most one division finer than the bar's own rhythm (another at difficulty 8 and up, and another at
            // 150% density or more), within the difficulty's top speed. Hard and dense maps fill the busy medium
            // parts too, not only the drops.
            // (busy by how strong its sounds are, so a pad's slow wobble that only just counts as sounds doesn't make
            // a burst; intense next to the song's own most intense parts)
            // (or as busy as a bar of the same section with the same drums: under another bass note they can come
            // through a little weaker)
            const busy = (push.stage >= 2 ? raw.length : raw.reduce((t, e) => t + Math.min(1, e.strength / 0.6), 0))
                >= (push.stage >= 3 ? 1 : beatsIn * (push.stage >= 2 ? 1 : dense ? 1.5 : 2)) || (drumLike[j] >= 0 && !!busyOf[drumLike[j]]);
            busyOf[j] = busy;
            const intense = top >= 0.8 - 0.1 * ramp(7, 8) || s.drop || (dense && top >= 0.3) || push.stage >= 1;
            // (the sounds a stream jumps into, with the gap before them kept)
            const jumpIns = new Set();
            // (and the beats a stream runs on into, and whether the bar was thinned by whole beats)
            const joined = new Set();
            let tiered = false;
            // (and a jump part's busy bars: a jump on every position of its division where something sounds, not only
            // on the clear sounds, so jump maps are jump streams where the song is busy, as human ones are)
            const jumpFill = !streamBar && busy && fill !== 'never' && !(opts.count > 0) && push.stage === 0
                && raw.length >= beatsIn;
            const streamFill = (busy && streamBar || jumpFill) && (fill === 'busy' || (fill === 'intense' && intense));
            // (how much sound the bar has at its positions, on average)
            let barHitV = -1;
            const barHit = () => {
                if (barHitV < 0) {
                    let t = 0, c = 0;
                    for (let bi = 0; bi < beatsIn; bi++)
                        for (let q = 0; q < div; q++, c++)
                            t += hitAt(b.from + bi * beatLen + q * beatLen / div);
                    barHitV = c ? t / c : 0;
                }
                return barHitV;
            };
            // (streams follow the song's rhythm rather than running at twice or four times anything in it: see
            // finest above)
            const fillDiv = jumpFill ? div : Math.min(topHere(family, beatLen), finest, Math.max(div, d));
            const step = beatLen / fillDiv;
            let extra = [];
            if (picked.length < k && streamFill) {
                // The stretches between sounds that get a stream, whole: first the ones leading into the strongest
                // sounds, the next bar's downbeat among them (so a stream runs on into it rather than stopping short
                // of it), until the bar has its notes
                picked.sort((p, q) => p - q);
                const strengthAt = new Map(here.map(e => [e.ms, e.score]));
                const spans = [];
                const ends = picked.concat(b.to < endMs && b.to - picked[picked.length - 1] <= beatLen * 1.01 ? [Math.round(b.to)] : []);
                for (let i = 0; i + 1 < ends.length; i++) {
                    const p0 = ends[i], p1 = ends[i + 1];
                    if (p1 - p0 > beatLen * (push.stage >= 3 ? 4.01 : push.stage >= 2 || jumpFill ? 2.01 : 1.01))
                        continue;
                    const list = [];
                    for (let t = p0 + step; t < p1 - step * 0.5; t += step) {
                        const ms = Math.round(gridAt(t, fillDiv).at);
                        // (a jump stream only where something sounds, a hat or a ripple: not on silence)
                        if (ok(ms) && ms - p0 >= Math.min(minGap, step) * 0.9 && p1 - ms >= step * 0.5 && (!jumpFill || hitAt(ms) >= 0.3 * barHit()))
                            list.push(ms);
                    }
                    if (list.length)
                        spans.push({ list, into: i + 1 < picked.length ? strengthAt.get(p1) ?? 0 : 1.5 });
                }
                spans.sort((p, q) => q.into - p.into);
                // (a stretch is streamed whole or not at all: a stream with a note missing in it is worse than one
                // note too many or a stretch left as it is)
                for (const sp of spans) {
                    const room = k - picked.length - extra.length;
                    if (room <= 0)
                        break;
                    if (sp.list.length <= room + 2)
                        extra.push(...sp.list);
                }
            }
            // Streams by whole beats: a busy bar that can't have a note at every position doesn't get holes punched
            // here and there inside its streams (the sounds it kept, the stretches that fitted). Instead its
            // strongest beats, two at a time where they can, are streams all through, and the others keep only
            // their main sounds, the one on the beat and the strongest other: a stream, then jumps, as human maps
            // thin a busy part. (The same number of notes; repeated bars keep it.)
            // (a strong sound: clearly louder than the bar's usual one, a snare or a crash over the hats)
            const strs = here.map(e => e.str).sort((p, q) => p - q), usualStr = strs.length ? strs[strs.length >> 1] : 0;
            const strongAt = t => here.some(e => Math.abs(e.ms - t) <= 3 && e.str >= 1.25 * usualStr);
            if (streamFill && !jumpFill && push.stage === 0 && !(opts.count > 0) && picked.length + extra.length >= beatsIn * fillDiv * 0.5) {
                const have = [...new Set(picked.concat(extra))].sort((p, q) => p - q);
                let holes = 0;
                for (let q = 1; q + 1 < have.length; q++) {
                    const g = have[q] - have[q - 1];
                    if (g > step * 1.5 && g < step * 3.5 && have[q + 1] - have[q] < step * 1.5 && gridAt(have[q], 1).err > 3)
                        holes++;
                }
                if (holes >= 2) {
                    const scoreAt = new Map(here.map(e => [e.ms, e.score]));
                    const beatsList = [];
                    for (let bi = 0; bi < beatsIn; bi++) {
                        const t0 = b.from + bi * beatLen, t1 = t0 + beatLen;
                        const pos = [];
                        for (let p = 0; p < fillDiv; p++) {
                            const ms = Math.round(gridAt(t0 + p * step, fillDiv).at);
                            if (ms < b.to - 1 && ok(ms))
                                pos.push(ms);
                        }
                        const own = have.filter(t => t >= beatT(bi) - 1 && t < beatT(bi + 1) - 1);
                        const sounds = own.filter(t => heard.has(t)).sort((p, q) => (scoreAt.get(q) ?? 0) - (scoreAt.get(p) ?? 0));
                        const on = own.find(t => Math.abs(t - beatT(bi)) <= 2);
                        const pulse = [...new Set([on, sounds.find(t => t !== on && gridAt(t, 2).err <= 3) ?? sounds.find(t => t !== on)].filter(t => t !== undefined))];
                        // (three ways a beat can go: its main sounds only; every other position, the bar's own
                        // division; or a stream through it, leaving out the note before the next beat, the jump
                        // into it)
                        const half = pos.filter((t, q) => q % 2 === 0);
                        const full = pos.length >= 4 ? pos.slice(0, -1) : pos;
                        beatsList.push({ bi, pos, tiers: [pulse, half.length > pulse.length ? half : pulse, full], score: own.reduce((t, x) => t + (scoreAt.get(x) ?? 0.2), 0) });
                    }
                    const budget = have.length;
                    const tier = beatsList.map(() => 1);
                    // (two stream beats in a row run on into each other, one longer stream, unless the second starts
                    // on a strong sound: human maps' streams run for a beat or several and break before the accents;
                    // the note that joins them counts against the bar's notes like any other)
                    const runOn = q => tier[q] === 2 && q + 1 < beatsList.length && tier[q + 1] === 2 && beatsList[q + 1].pos.length > 0
                        && !strongAt(beatsList[q + 1].pos[0]);
                    const cost = () => beatsList.reduce((t, x, q) => t + (runOn(q) ? x.pos : x.tiers[tier[q]]).length, 0);
                    // (too many notes even so: beats down to their main sounds, the bar's last one first, a jump into
                    // the next bar, then its first, then the weakest; never one stranded between two busier beats
                    // where that can be helped)
                    const last = beatsList.length - 1;
                    const down = beatsList.map((x, q) => q).sort((p, q) => (p === last ? -2 : p === 0 ? -1 : 0) - (q === last ? -2 : q === 0 ? -1 : 0)
                        || beatsList[p].score - beatsList[q].score);
                    for (const q of down) {
                        if (cost() <= budget + 1)
                            break;
                        tier[q] = 0;
                    }
                    // (room to spare: the strongest beats become streams, two at a time where they can, then one)
                    const pairs = [];
                    for (let bi = 0; bi + 1 < beatsList.length; bi += 2)
                        pairs.push([bi, bi + 1]);
                    pairs.sort((p, q) => (beatsList[q[0]].score + beatsList[q[1]].score) - (beatsList[p[0]].score + beatsList[p[1]].score));
                    for (const pr of pairs) {
                        const was = pr.map(q => tier[q]);
                        pr.forEach(q => tier[q] = 2);
                        if (cost() > budget + 1)
                            pr.forEach((q, z) => tier[q] = was[z]);
                    }
                    for (const q of beatsList.map((x, q) => q).sort((p, q) => beatsList[q].score - beatsList[p].score)) {
                        if (tier[q] === 2)
                            continue;
                        const was = tier[q];
                        tier[q] = 2;
                        if (cost() > budget + 1)
                            tier[q] = was;
                    }
                    const made = [];
                    beatsList.forEach((x, q) => made.push(...(runOn(q) ? x.pos : x.tiers[tier[q]])));
                    // (a stream beat's last note is left out for the jump into the next beat: that beat's note is a
                    // jump-in, so the hole isn't filled again below)
                    beatsList.forEach((x, q) => {
                        if (tier[q] === 2 && !runOn(q) && x.pos.length >= 4 && q + 1 < beatsList.length && beatsList[q + 1].pos.length)
                            jumpIns.add(beatsList[q + 1].pos[0]);
                        if (runOn(q))
                            joined.add(beatsList[q + 1].pos[0]);
                    });
                    tiered = true;
                    picked.length = 0;
                    picked.push(...new Set(made));
                    extra = [];
                }
            }
            // Jumps into the beat: a stream steps along, and the sound on the beat gets a jump into it (the
            // fill note just before it is left out), the same way in every bar, as human maps play a groove.
            // Outside the drops every sound on the beat does; in a drop (and in a stream map) the stream runs
            // on for a bar or so first, into the next bar's downbeat (and half way through a bar of 1/8 beats).
            if (streamFill && !jumpFill && !(opts.count > 0) && push.stage === 0) {
                const all = picked.concat(extra);
                const into = [];
                const groove = !s.drop && top < 0.9 && opts.patterns !== 'streams';
                // (into the strong sounds on the beat, and at least the strongest one in every two beats: a jump
                // into every beat makes every stream the same seven notes)
                if (groove) {
                    const onBeat = all.filter(t => gridAt(t, 1).err <= 3);
                    for (let h = 0; h < beatsIn; h += 2) {
                        const t0 = beatT(h), t1 = beatT(h + 2);
                        const these = onBeat.filter(t => t >= t0 - 3 && t < t1 - 3);
                        const strong = these.filter(strongAt);
                        const str = t => (here.find(e => Math.abs(e.ms - t) <= 3) || { str: 0 }).str;
                        into.push(...(strong.length ? strong : these.filter(t => heard.has(t) && !joined.has(t)).sort((p, q) => str(q) - str(p)).slice(0, 1)));
                    }
                }
                // (a stream map's drop at its fastest: a jump into every beat at 10, every other at 9, the way human
                // stream maps break their walls)
                if (opts.patterns === 'streams' && (s.drop || top >= 0.9) && (fillDiv >= 12 || step <= 45) && order < ramp(8, 9))
                    for (const t of all) {
                        const g1 = gridAt(t, 1);
                        if (g1.err <= 3 && (order < ramp(9, 10) || Math.round((t - b.from) / beatLen) % 2 === 0))
                            into.push(t);
                    }
                // (a jump map's stream phrase runs to its end, into the jumps after it)
                if (opts.patterns === 'jumps' ? j + 1 < inRange.length && !isStreamBar(j + 1) : opts.patterns !== 'streams' || root % 2 === 1)
                    into.push(b.to);
                if (!groove && fillDiv >= 8 && opts.patterns !== 'streams' && opts.patterns !== 'jumps') {
                    const half = all.find(t => Math.abs(t - gridAt(b.from + (b.to - b.from) / 2, 2).at) <= 3);
                    if (half !== undefined)
                        into.push(half);
                }
                // (only fill notes go: a sound of its own stays)
                for (const t0 of into) {
                    jumpIns.add(t0);
                    for (const list of [extra, picked])
                        for (const t of list.filter(t => t < t0 && t0 - t <= step * 1.1 && !heard.has(t)))
                            list.splice(list.indexOf(t), 1);
                }
            }
            picked.push(...extra);
            // (runs at the finest division longer than the difficulty allows: after that, the notes there's no sound
            // for are left out, so the run goes on in the song's own rhythm, its sounds jumps after the burst, rather
            // than at half the speed, which would be a stream of jumps harder than the burst itself)
            const burst = burstAt(family, beatLen, topHere(family, beatLen));
            if (burst < Infinity && picked.length > 2) {
                picked.sort((p, q) => p - q);
                const quick = beatLen / topHere(family, beatLen) * 1.1;
                const keep = [picked[0]];
                let runFrom = picked[0];
                for (let q = 1; q < picked.length; q++) {
                    const t = picked[q];
                    if (t - picked[q - 1] > quick)
                        runFrom = t;
                    else if (t - runFrom > burst * beatLen * 1.01 && !heard.has(t))
                        continue;
                    keep.push(t);
                }
                picked.length = 0;
                picked.push(...keep);
            }
            // (and no lone note missing in the middle of a stream: one more note there rather than a hole)
            if (!(opts.count > 0) && picked.length >= 4) {
                picked.sort((p, q) => p - q);
                const fills = [];
                for (let q = 1; q + 2 < picked.length; q++) {
                    const g0 = picked[q] - picked[q - 1], g1 = picked[q + 1] - picked[q], g2 = picked[q + 2] - picked[q + 1];
                    if (g0 < 70 && Math.abs(g1 - 2 * g0) < 4 && Math.abs(g2 - g0) < 4 && burst === Infinity && !jumpIns.has(picked[q + 1])
                        && (!tiered || picked.length + fills.length < k)) {
                        const ms = Math.round(picked[q] + g0);
                        if (ok(ms) && (!jumpFill || hitAt(ms) >= 0.3 * barHit()))
                            fills.push(ms);
                    }
                }
                picked.push(...fills);
            }
            // Slides in a mixed map's jump parts (the Streams / Jumps balance under 100%): where the music has a quick
            // figure, three to five sounds at least twice as quick as the jumps (a fill, a roll, a quick run into a
            // change), those sounds are notes too, and they're played as a slide: quick notes along the edge of the
            // grid from where the jump lands (see place). One a bar at most, only where the sounds are there, so a bar
            // and its repeats get the same slide.
            if (!streamBar && jumpShare > 0 && jumpShare < 1 && !opts.quantum && !(opts.count > 0) && push.stage === 0) {
                const top = topHere(family, beatLen);
                let found = null;
                for (const fine of family.filter(d => d >= 2 * div && d <= top && beatLen / d >= 40)) {
                    const step = beatLen / fine;
                    const on = new Map();
                    for (const e of raw) {
                        const g = heardOn(e.ms, fine);
                        if (g.err <= tolerance(g.step) && e.strength >= 0.25 && ok(Math.round(g.at)))
                            on.set(Math.round(g.at), Math.max(on.get(Math.round(g.at)) || 0, e.strength));
                    }
                    const ts = [...on.keys()].sort((p, q) => p - q);
                    for (let a = 0; a < ts.length; a++) {
                        let z = a;
                        while (z + 1 < ts.length && z - a < 4 && Math.abs(ts[z + 1] - ts[z] - step) <= 3)
                            z++;
                        const run = ts.slice(a, z + 1);
                        // (the longest, then the latest in the bar: fills come at the end)
                        if (run.length >= 3 && (!found || run.length > found.length || (run.length === found.length && run[0] > found[0])))
                            found = run;
                    }
                    if (found)
                        break;
                }
                if (found) {
                    for (const t of found)
                        if (!picked.some(p => Math.abs(p - t) <= 3))
                            picked.push(t);
                    picked.sort((p, q) => p - q);
                    for (const t of found)
                        slideTimes.add(Math.round(t));
                    slideRel[j] = found.map(t => Math.round(t) - b.from);
                }
            }
            carry = Math.min(2, Math.max(-2, exact - picked.length));
            if (firstPass)
                firstCount[j] = picked.length;
            rel[j] = picked.map(t => t - b.from);
            out.push(...picked);
        });
        // No cuts where the music carries on. A gap much longer than this part's usual spacing (a bar whose share
        // of the notes rounded down to none, half a second or more) is only right when the music itself gives way
        // there: it stops, goes quiet, or its drums thin out. Otherwise the strongest sound near the middle of the
        // gap, on the beat, gets a note, until no such gap is left.
        const activity = (from, to) => {
            let w = 0;
            for (const e of events)
                if (e.ms >= from && e.ms < to)
                    w += Math.min(1, e.strength);
            return w / Math.max(0.2, (to - from) / 1000);
        };
        const loudAt = (from, to) => {
            let sum = 0, n = 0;
            for (let f = Math.max(0, Math.floor(from / 10)); f < Math.min(a.frames, to / 10); f++, n++)
                sum += a.loudness[f];
            return n ? sum / n : 0;
        };
        for (let round = 0; round < 6; round++) {
            const ts = [...new Set(out)].sort((p, q) => p - q);
            const add = [];
            for (let q = 1; q < ts.length; q++) {
                const t0 = ts[q - 1], t1 = ts[q], g = t1 - t0;
                const sec = sectionAt(t0);
                const here = Math.max(0.5, sec.nps * (scale.get(sec) ?? 1) * push.mult);
                // (long next to the notes just before it, or next to this part's usual spacing)
                const prevGaps = [];
                for (let k = Math.max(1, q - 8); k < q; k++)
                    prevGaps.push(ts[k] - ts[k - 1]);
                prevGaps.sort((p, q) => p - q);
                const usual = prevGaps.length ? prevGaps[prevGaps.length >> 1] : Infinity;
                // (and a hole a beat or more long in fast music counts too, not only from 450ms)
                const beatHere = 60000 / ctx.timing[beats[beatAt(t0)].tp].bpm;
                if (g < Math.min(450, Math.max(beatHere * 0.99, 2.5 * usual)) || (g < 2.5 * usual && g < 2.6 * 1000 / here))
                    continue;
                const inside = activity(t0 + 100, t1 - 100), before = activity(t0 - 4000, t0);
                // (and a near-silent part, a break before the drop, is meant to be a break)
                if (inside < 1 || inside < 0.5 * before || loudAt(t0, t1) < loudAt(t0 - 4000, t0) - 0.2 || isBreak(sec))
                    continue;
                let best = null;
                for (const e of events) {
                    if (e.ms <= t0 + g * 0.25 || e.ms >= t1 - g * 0.25)
                        continue;
                    // (on the song's own kind of grid: a third of a beat in a straight song is a phantom triplet)
                    const on = (ctx.triplet ? [heardOn(e.ms, 3), heardOn(e.ms, 6)] : [heardOn(e.ms, 2), heardOn(e.ms, 4)])
                        .find(x => x.err <= tolerance(x.step));
                    if (!on)
                        continue;
                    const score = Math.min(1.5, e.strength) * (0.6 + 0.4 * on.weight) * (1 - Math.abs(e.ms - (t0 + t1) / 2) / g);
                    if (!best || score > best.score)
                        best = { ms: Math.round(on.at), src: e.ms, score };
                }
                if (best) {
                    add.push(best.ms);
                    heard.set(best.ms, best.src);
                }
            }
            if (!add.length)
                break;
            out.push(...add);
        }
        // (and a note filled into a gap in a bar that others repeat goes into them too)
        propagate();
        };
        // every bar that repeats another gets exactly that bar's notes, moved along
        const propagate = () => {
            if (!proto.some(p => p >= 0))
                return;
            const inBar = inRange.map(() => []);
            for (const t of new Set(out))
                inBar[barIndexOf(t)].push(t);
            for (let j = 0; j < inRange.length; j++) {
                const p = proto[j];
                if (p < 0)
                    continue;
                const shift = inRange[j].from - inRange[p].from;
                inBar[j] = inBar[p].map(t => Math.round(t + shift)).filter(t => t >= startMs && t <= endMs && avoid.every(v => Math.abs(v - t) >= 25));
                for (const t of inBar[p])
                    if (heard.has(t))
                        heard.set(Math.round(t + shift), heard.get(t) + shift);
            }
            out = inBar.flat();
        };
        mapBars(new Map());

        // A drop is never easier than the calmer parts: a section that came out with more notes a second than a
        // more intense one (its sounds or rhythm let it fill up more) is mapped again with fewer
        const inSection = sec => {
            const from = Math.max(sec.from, startMs), to = Math.min(sec.to, endMs);
            return to - from >= 2000 ? { n: out.filter(t => t >= from && t < to).length / ((to - from) / 1000) } : null;
        };
        const rates = new Map(sections.map(sec => [sec, inSection(sec)]));
        const scale = new Map();
        for (const sec of sections) {
            const mine = rates.get(sec);
            if (!mine || !mine.n)
                continue;
            let allowed = Infinity;
            for (const other of sections) {
                const theirs = rates.get(other);
                if (theirs && other.level >= sec.level + 0.1)
                    allowed = Math.min(allowed, theirs.n * 0.95);
            }
            if (mine.n > allowed)
                scale.set(sec, allowed / mine.n);
        }
        if (scale.size)
            mapBars(scale);

        // A set number of notes: mapped again with more (or fewer) until it's that many, filling in more places if
        // the song's sounds alone don't have enough; any left over are taken out evenly (streams filled in between
        // sounds first, so the notes on real sounds stay)
        if (opts.count > 0) {
            let mult = 1, stage = 0, lastGot = 0, enough = null;
            for (let it = 0; it < 12; it++) {
                const got = new Set(out).size;
                if (got >= opts.count && (!enough || got < enough.got))
                    enough = { got, out, heard };
                if (got >= opts.count && got <= opts.count * 1.03)
                    break;
                if (got < opts.count) {
                    // not getting any more from more of the same: fill in more places
                    if (it && got <= lastGot * 1.02 || mult >= 8) {
                        if (stage === 3)
                            break;
                        stage++;
                    } else
                        mult *= Math.min(3, opts.count / Math.max(1, got));
                } else
                    mult *= Math.max(0.5, (opts.count * 1.01) / got);
                lastGot = got;
                mapBars(scale, { mult, stage });
            }
            if (enough && new Set(out).size < opts.count)
                ({ out, heard } = enough);
            const all = [...new Set(out)].sort((p, q) => p - q);
            let excess = all.length - opts.count;
            if (excess > 0) {
                // Taken out together: the same note in every bar that repeats a bar, so the repeats stay the same
                // (a group too big for what's left over is skipped; single notes make up the rest)
                const groups = new Map();
                for (const t of all) {
                    const j = barIndexOf(t), r = rootOf(j);
                    const key = `${r}:${Math.round(t - inRange[j].from)}`;
                    if (!groups.has(key))
                        groups.set(key, []);
                    groups.get(key).push(t);
                }
                const list = [...groups.values()];
                const filled = list.filter(g => g.every(t => !heard.has(t)));
                const from = filled.reduce((n, g) => n + g.length, 0) >= excess ? filled : list;
                from.sort((p, q) => p[0] - q[0]);
                const size = from.reduce((n, g) => n + g.length, 0) / Math.max(1, from.length);
                const drop = new Set();
                const stride = Math.max(1, from.length * size / excess);
                for (let q = stride / 2; q < from.length && excess > 0; q += stride) {
                    const g = from[Math.floor(q)];
                    if (g.length <= excess && !g.some(t => drop.has(t))) {
                        g.forEach(t => drop.add(t));
                        excess -= g.length;
                    }
                }
                for (const g of from.slice().sort((p, q) => p.length - q.length)) {
                    if (excess <= 0)
                        break;
                    if (g.length <= excess && !g.some(t => drop.has(t))) {
                        g.forEach(t => drop.add(t));
                        excess -= g.length;
                    }
                }
                for (const t of all) {
                    if (excess <= 0)
                        break;
                    if (!drop.has(t)) {
                        drop.add(t);
                        excess--;
                    }
                }
                out = all.filter(t => !drop.has(t));
            }
        }
        // Streams and other quick runs stay exactly on the grid, so they're perfectly even. A note on its own (no
        // other note within 200ms) whose sound is clearly off the grid goes where it's heard: the sounds of a song
        // never all sit on one perfect grid, and on a slow note being late or early by even 15ms is easy to feel.
        // (Off the grid by more than all the sounds are: one that's only as far off as the rest stays with them,
        // or a straight part would swing.)
        const times = [...new Set(out)].sort((p, q) => p - q);
        return times.map((t, i) => {
            const src = heard.get(t);
            if (src === undefined || Math.abs(src - lag - t) <= 6 || src < startMs || src > endMs)
                return t;
            // (only a note a beat or so from the others: a steady run of half-beat notes stays on the grid, or each
            // jump would need a different speed)
            const gap = Math.min(i ? t - times[i - 1] : Infinity, i + 1 < times.length ? times[i + 1] - t : Infinity);
            return gap >= Math.max(200, 0.9 * 60000 / ctx.timing[beats[beatAt(t)].tp].bpm) ? Math.round(src - lag) : t;
        });
    }

    // No beat to follow (the tempo drifts and the map has no timing points): the sounds themselves, at most as many as
    // the difficulty allows per couple of seconds
    function chooseTimesFree(a, opts, nps) {
        const { startMs, endMs } = opts;
        const WINDOW = 2000;
        const sources = opts.sources && opts.sources.length ? opts.sources : DEFAULT_SOURCES;
        const events = findEvents(a, sources, opts.sensitivity ?? 0.5, startMs, endMs);
        const level = rank(smooth(a.hits, 150));
        const out = [];
        for (let w = startMs; w < endMs; w += WINDOW) {
            const to = Math.min(endMs, w + WINDOW);
            const lv = level[Math.min(a.frames - 1, Math.round((w + to) / 20))] || 0;
            // (at least one note in every stretch with a sound in it, so it never goes quiet while the song doesn't)
            let k = Math.max(1, Math.round(nps * (0.3 + 1.4 * Math.pow(lv, 1.5)) * (to - w) / 1000));
            if (opts.count > 0)
                k = Math.round(opts.count * (to - w) / (endMs - startMs));
            const minGap = Math.max(30, (to - w) / Math.max(1, k) * 0.5);
            const taken = [];
            for (const e of events.filter(e => e.ms >= w && e.ms < to).sort((p, q) => q.strength - p.strength)) {
                if (taken.length >= k)
                    break;
                if (taken.every(t => Math.abs(t - e.ms) >= minGap) && out.every(t => Math.abs(t - e.ms) >= minGap || t < e.ms - 500))
                    taken.push(e.ms);
            }
            out.push(...taken);
        }
        return out.sort((p, q) => p - q);
    }

    // ------------------------------------------------ choosing where notes go

    // Spots in a learned map nobody could actually play, which are never copied: two places at the same moment, a
    // move faster than any human map goes (150 cells a second), a far jump much faster than the notes around it
    // (a glitch, or a joke part of a meme map), or a jerk (turning round at full speed) beyond the hardest human maps.
    // note i is flagged when getting to it from note i - 1 is the problem.
    const impossibleCache = new WeakMap();
    function impossible(e) {
        if (impossibleCache.has(e.t))
            return impossibleCache.get(e.t);
        const n = e.t.length, bad = new Uint8Array(n);
        const sp = new Float64Array(n), mv = new Float64Array(n);
        for (let i = 1; i < n; i++) {
            const g = e.t[i] - e.t[i - 1];
            mv[i] = Math.hypot(e.x[i] - e.x[i - 1], e.y[i] - e.y[i - 1]);
            sp[i] = mv[i] / Math.max(g, 1) * 1000;
            if ((g < 3 && mv[i] > 0.05) || sp[i] > 150)
                bad[i] = 1;
        }
        const pre = new Float64Array(n + 1);
        for (let i = 0; i < n; i++)
            pre[i + 1] = pre[i] + sp[i];
        for (let i = 1; i < n; i++) {
            const lo = Math.max(1, i - 16), hi = Math.min(n - 1, i + 16);
            const around = (pre[hi + 1] - pre[lo] - sp[i]) / Math.max(1, hi - lo);
            if (mv[i] >= 1.5 && sp[i] > Math.max(45, 3.5 * around))
                bad[i] = 1;
            if (i >= 2) {
                const t1 = (e.t[i - 1] - e.t[i - 2]) / 1000, t2 = (e.t[i] - e.t[i - 1]) / 1000;
                if (t1 >= 0.003 && t2 >= 0.003) {
                    const ax = (e.x[i] - e.x[i - 1]) / t2 - (e.x[i - 1] - e.x[i - 2]) / t1;
                    const ay = (e.y[i] - e.y[i - 1]) / t2 - (e.y[i - 1] - e.y[i - 2]) / t1;
                    if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > 12000)
                        bad[i] = 1;
                }
            }
        }
        impossibleCache.set(e.t, bad);
        return bad;
    }

    // What a map's design is like: how far it moves, how often it jumps far or steps to a neighbour, how often it
    // turns right round, how much is off the grid, and its usual gap between notes
    function styleOf(e) {
        const n = Math.min(e.t.length, 4000);
        let moves = 0, sum = 0, jumps = 0, steps = 0, turns = 0, back = 0, off = 0;
        const gaps = [];
        for (let i = 1; i < n; i++) {
            const dx = e.x[i] - e.x[i - 1], dy = e.y[i] - e.y[i - 1], d = Math.hypot(dx, dy);
            if (realQuantum(e.x[i], e.y[i]))
                off++;
            if (e.t[i] - e.t[i - 1] > 5)
                gaps.push(e.t[i] - e.t[i - 1]);
            if (d < 0.05)
                continue;
            moves++;
            sum += d;
            if (d >= 1.5)
                jumps++;
            else if (d <= 1.05)
                steps++;
            if (i >= 2) {
                const px = e.x[i - 1] - e.x[i - 2], py = e.y[i - 1] - e.y[i - 2], pd = Math.hypot(px, py);
                if (pd > 0.3 && d > 0.3) {
                    turns++;
                    if ((px * dx + py * dy) / (pd * d) < -0.7)
                        back++;
                }
            }
        }
        gaps.sort((p, q) => p - q);
        return {
            move: moves ? sum / moves : 1, jumps: moves ? jumps / moves : 0, steps: moves ? steps / moves : 0,
            back: turns ? back / turns : 0, off: off / Math.max(1, n), gap: gaps.length ? gaps[gaps.length >> 1] : 200,
            gapT: timeMedian(gaps),
        };
    }
    // A quantum map's design, measured: how much of it is off the grid and outside it (r90: how far out from the
    // middle nine notes in ten stay, 1 being the grid's edge), how often its jumps land off the grid, its slides
    // (notes under 30ms apart: what share of the notes, how many in a row, how far each step and how fast, how much
    // each step bends), how its jumps turn (a share for each 30 degrees, 0-30 to 150-180, and how often the next
    // turn is the same way) and what its spots are snapped to (a quarter of a cell, an eighth, ...)
    function quantumStyleOf(e) {
        const n = Math.min(e.t.length, 6000);
        let quickN = 0, quickOff = 0, quickOut = 0;
        let off = 0, outside = 0, land = 0, landOff = 0, inSlides = 0, run = 0, same = 0, turnsN = 0, lastSign = 0, bendSum = 0, bendN = 0;
        const rs = [], runs = [], steps = [], speeds = [], hist = [0, 0, 0, 0, 0, 0], jumps = [];
        const snapFit = { 2: 0, 4: 0, 8: 0, 12: 0, 16: 0 };
        let snapN = 0;
        const angle = (ax, ay, bx, by) => Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
        for (let i = 0; i < n; i++) {
            const x = e.x[i], y = e.y[i];
            rs.push(Math.max(Math.abs(x - 1), Math.abs(y - 1)));
            if (realQuantum(x, y)) {
                off++;
                for (const v of [x, y])
                    if (!isWhole(v)) {
                        snapN++;
                        for (const k in snapFit)
                            if (Math.abs(v * k - Math.round(v * k)) < 0.03 * k / 4 + 0.02)
                                snapFit[k]++;
                    }
            }
            if (rs[i] > 1.02)
                outside++;
            if (i === 0)
                continue;
            const g = e.t[i] - e.t[i - 1], dx = x - e.x[i - 1], dy = y - e.y[i - 1], d = Math.hypot(dx, dy);
            if (g < 30 && g > 2 && d > 0.01) {
                run++;
                steps.push(d);
                speeds.push(d / g * 1000);
                if (i >= 2 && run >= 2) {
                    const px = e.x[i - 1] - e.x[i - 2], py = e.y[i - 1] - e.y[i - 2];
                    if (Math.hypot(px, py) > 0.01) {
                        bendSum += Math.abs(angle(px, py, dx, dy));
                        bendN++;
                    }
                }
            } else {
                if (run >= 2) {
                    runs.push(run);
                    inSlides += run;
                }
                run = 0;
            }
            if (g >= 30 && g < 60 && d > 0.01) {
                quickN++;
                if (realQuantum(x, y))
                    quickOff++;
                if (rs[i] > 1.02)
                    quickOut++;
            }
            if (g >= 60 && d >= 0.3) {
                land++;
                if (realQuantum(x, y))
                    landOff++;
                jumps.push(d);
                if (i >= 2) {
                    const g0 = e.t[i - 1] - e.t[i - 2], px = e.x[i - 1] - e.x[i - 2], py = e.y[i - 1] - e.y[i - 2];
                    if (g0 >= 60 && Math.hypot(px, py) >= 0.3) {
                        const a = angle(px, py, dx, dy);
                        hist[Math.min(5, Math.floor(Math.abs(a) / (Math.PI / 6)))]++;
                        const sg = Math.sign(a);
                        if (sg && sg === lastSign)
                            same++;
                        lastSign = sg;
                        turnsN++;
                    }
                }
            }
        }
        const med = list => {
            const v = list.slice().sort((p, q) => p - q);
            return v.length ? v[v.length >> 1] : 0;
        };
        const sortedR = rs.slice().sort((p, q) => p - q);
        let snap = 100;
        for (const k of [2, 4, 8, 12, 16])
            if (snapN && snapFit[k] >= 0.75 * snapN) {
                snap = k;
                break;
            }
        return {
            off: off / Math.max(1, n), outside: outside / Math.max(1, n), r90: sortedR[Math.floor(0.9 * (sortedR.length - 1))] || 1,
            landOff: land ? landOff / land : 0.5, quickOff: quickN ? quickOff / quickN : 0.5, quickOut: quickN ? quickOut / quickN : 0.3, slideShare: inSlides / Math.max(1, n), slideLen: med(runs) || 4,
            slideStep: med(steps) || 0.2, slideSpeed: med(speeds) || 12, slideBend: bendN ? bendSum / bendN : 0.15,
            turns: turnsN ? hist.map(v => v / turnsN) : [0.2, 0.2, 0.2, 0.2, 0.1, 0.1], sameSide: turnsN ? same / turnsN : 0.5,
            jump: med(jumps) || 2, snap,
        };
    }
    // The design to make quantum parts in: the average of the quantum maps it learned (each counting the same: a mix
    // of them, not a copy of one), or of the quantum example that comes with the editor when it learned none
    function quantumProfile(entries) {
        const list = entries.filter(e => e.n >= 40 && e.style && e.style.off >= 0.2);
        if (!list.length)
            return null;
        const all = list.map(e => e.qstyle || (e.qstyle = quantumStyleOf(e)));
        const avg = k => all.reduce((t, p) => t + p[k], 0) / all.length;
        const P = {};
        for (const k of ['off', 'outside', 'r90', 'landOff', 'quickOff', 'quickOut', 'slideShare', 'slideLen', 'slideStep', 'slideSpeed', 'slideBend', 'sameSide', 'jump'])
            P[k] = avg(k);
        P.turns = [0, 1, 2, 3, 4, 5].map(b => all.reduce((t, p) => t + p.turns[b], 0) / all.length);
        P.snap = Math.max(...all.map(p => p.snap));
        P.maps = list.map(e => e.name);
        return P;
    }
    // The profile at a Quantum level (0-1): at the top, the learned design as it is; lower down tamer, closer to the
    // grid (fewer spots off it, nothing far outside it, fewer and shorter slides, gentler turns, coarser spots)
    function profileAt(P, level) {
        const L = Math.min(1, Math.max(0, level));
        const gentle = [0.4, 0.3, 0.18, 0.08, 0.04, 0];
        const toward = (v, l) => Math.min(0.95, v * (0.4 + 0.6 * l) + (1 - v) * 0.7 * l * l);
        const turns = P.turns.map((v, b) => gentle[b] + (v - gentle[b]) * L);
        const tot = turns.reduce((t, v) => t + v, 0) || 1;
        return {
            ...P, level: L,
            // (how much is off the grid goes with the level, from the learned design's own share: at 100% most of it,
            // even when the maps it learned stream on the grid between their quantum parts; what it looks like
            // stays theirs)
            landOff: toward(P.landOff, L),
            quickOff: toward(P.quickOff, L),
            off: toward(P.off, L),
            outside: P.outside * L,
            r90: 1 + Math.max(0, P.r90 - 1) * L,
            slideShare: P.slideShare * Math.pow(L, 1.3),
            slideLen: Math.max(3, P.slideLen * (0.6 + 0.4 * L)),
            turns: turns.map(v => v / tot),
            snap: L < 0.5 ? Math.min(P.snap, 4) : L < 0.8 ? Math.min(P.snap, 8) : P.snap,
        };
    }

    // The gap the notes spend half their time in (gaps under a second): what the map's rhythm is mostly like to
    // play. Unlike the plain median, it barely changes with how many notes there are, so a song mapped at 8, 9 and
    // 10 compares with the learned maps the same way.
    function timeMedian(gaps) {
        const g = gaps.filter(x => x > 5 && x < 1000).sort((p, q) => p - q);
        const total = g.reduce((t, x) => t + x, 0);
        let acc = 0;
        for (const x of g) {
            acc += x;
            if (acc >= total / 2)
                return x;
        }
        return 200;
    }
    const styleDistance = (p, q) => Math.hypot((p.move - q.move) / 0.35, (p.jumps - q.jumps) / 0.15, (p.steps - q.steps) / 0.15,
        (p.back - q.back) / 0.15, (p.off - q.off) / 0.2);

    // Library entries with lookups from a position to the notes there
    function prepare(entries, quantum) {
        return entries.map(e => {
            const n = e.t.length;
            const at = new Map();
            for (let i = 0; i + 1 < n; i++) {
                const key = posKey(e.x[i], e.y[i]);
                let list = at.get(key);
                if (!list)
                    at.set(key, list = []);
                list.push(i);
            }
            // where a run of whole-cell notes ends (for when quantum notes aren't allowed)
            const wholeUntil = new Int32Array(n);
            for (let i = n - 1; i >= 0; i--) {
                const whole = isWhole(e.x[i]) && isWhole(e.y[i]) && e.x[i] >= 0 && e.x[i] <= 2 && e.y[i] >= 0 && e.y[i] <= 2;
                wholeUntil[i] = whole ? (i + 1 < n ? Math.max(i + 1, wholeUntil[i + 1]) : n) : i;
            }
            // where a run without impossible spots ends
            const bad = impossible(e);
            const cleanUntil = new Int32Array(n);
            for (let i = n - 1; i >= 0; i--)
                cleanUntil[i] = bad[i] ? i : (i + 1 < n ? cleanUntil[i + 1] : n);
            return {
                ...e, n, at, wholeUntil, cleanUntil, style: styleOf(e),
                usable: quantum || !e.quantum || wholeUntil.some((u, i) => u - i >= 4),
            };
        }).filter(e => e.n >= 8 && e.usable);
    }

    // How many places in the library to try for each run of notes
    const SEARCH = 2400;

    // Going round the same loop again: how many of `pts` (after the `from` points before them) land where the note
    // 2 to 8 notes before did, coming from the same place too. Human maps do it for about a quarter of their notes
    // (a circle or two in a stream); much more is the same loop over and over.
    // (tol: how near counts as the same spot again; quantum loops drift a little each time round, so there it's wider)
    function lapCount(pts, from = 0, tol = 1e-3) {
        let laps = 0;
        const same = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
        for (let j = Math.max(from, 3); j < pts.length; j++)
            for (let p = 2; p <= 8 && j - p - 1 >= 0; p++)
                if (same(pts[j], pts[j - p]) && same(pts[j - 1], pts[j - p - 1])) {
                    laps++;
                    break;
                }
        return laps;
    }
    const LAPS_OK = 0.25;
    // the longest stretch of notes in a row that each go round a loop again
    function lapStreak(pts, tol = 1e-3) {
        let run = 0, top = 0;
        const same = (a, b) => Math.abs(a[0] - b[0]) < tol && Math.abs(a[1] - b[1]) < tol;
        for (let j = 3; j < pts.length; j++) {
            let lap = false;
            for (let p = 2; p <= 8 && j - p - 1 >= 0 && !lap; p++)
                lap = same(pts[j], pts[j - p]) && same(pts[j - 1], pts[j - p - 1]);
            run = lap ? run + 1 : 0;
            top = Math.max(top, run);
        }
        return top;
    }
    // the longest stretch of moves in a row that all turn the same way (a circle going round and round, even one that
    // drifts a little each time so it never lands on the same spots twice); tiny moves don't count either way
    function turnStreak(pts) {
        let run = 0, top = 0, last = 0;
        for (let j = 2; j < pts.length; j++) {
            const ax = pts[j - 1][0] - pts[j - 2][0], ay = pts[j - 1][1] - pts[j - 2][1];
            const bx = pts[j][0] - pts[j - 1][0], by = pts[j][1] - pts[j - 1][1];
            if (Math.hypot(ax, ay) < 0.3 || Math.hypot(bx, by) < 0.3)
                continue;
            const cross = ax * by - ay * bx, dot = ax * bx + ay * by;
            // (going straight on, within 10 degrees, isn't turning either way)
            const side = Math.abs(Math.atan2(cross, dot)) < 0.17 ? 0 : Math.sign(cross);
            run = side && side === last ? run + 1 : side ? 1 : 0;
            last = side;
            top = Math.max(top, run);
        }
        return top;
    }

    // Awkward spots, the way osu!'s aim rating sees them (snap and flow aim), counted over pts [{x, y, ms}] from
    // index `from` on. Human grid maps have almost none of the first two:
    //  flowBreak:   one sharp turn (under 60 degrees) in the middle of a straight-ish flowing line, at speed
    //  snapBreak:   one wide turn in the middle of a back-and-forth zigzag of big jumps
    //  spacingJump: the spacing changing by half again or more while the rhythm stays the same
    function awkward(pts, from = 0) {
        const angle = (a, b, c) => {
            const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
            if (Math.hypot(v1x, v1y) < 0.05 || Math.hypot(v2x, v2y) < 0.05)
                return null;
            return Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y));
        };
        const SHARP = Math.PI / 3, WIDE = 2 * Math.PI / 3;
        const out = { flowBreak: 0, snapBreak: 0, spacingJump: 0 };
        for (let i = Math.max(from, 2); i < pts.length; i++) {
            const n2 = pts[i - 2], n3 = pts[i - 1], n4 = pts[i];
            const dt3 = n3.ms - n2.ms, dt4 = n4.ms - n3.ms;
            const d3 = Math.hypot(n3.x - n2.x, n3.y - n2.y), d4 = Math.hypot(n4.x - n3.x, n4.y - n3.y);
            if (Math.max(dt3, dt4) < 1.25 * Math.min(dt3, dt4) && d3 > 0.25 && d4 > 0.25 && Math.abs(Math.log(d4 / d3)) > Math.log(1.5))
                out.spacingJump++;
            if (i >= 4) {
                const n1 = pts[i - 3], n0 = pts[i - 4];
                const t1 = angle(n0, n1, n2), t2 = angle(n1, n2, n3), t3 = angle(n2, n3, n4);
                if (t1 !== null && t2 !== null && t3 !== null && Math.max(n2.ms - n1.ms, dt3) < 120) {
                    if (t2 < SHARP && t1 > WIDE && t3 > WIDE)
                        out.flowBreak++;
                    if (t2 > WIDE && t1 < SHARP && t3 < SHARP && Math.hypot(n2.x - n1.x, n2.y - n1.y) > 1.4)
                        out.snapBreak++;
                }
            }
        }
        return out;
    }

    // Time and distance, the way Sound Space maps work (their wiki's spacing rule, and every human map we measured),
    // over pts [{x, y, ms}] from index `from` on:
    //  smallJump: a note timed as a jump (its gap half again as long as the quick notes around it) that only steps
    //             to a neighbouring cell or less: the cursor slows down just where the rhythm asks for a jump
    //  bigJump:   such a note that really is a jump (two cells or more)
    //  speedJump: the cursor's speed doubling (or halving) from one move to the next
    //  rightJump: two big jumps in a row at about a right angle (human jumps go round like a star, 112-172 degrees)
    //  spinFlip:  a run of star jumps changing which way it spins
    // (opts: what reach() needs, so a jump-timed note that the difficulty lets go only a little way isn't too small)
    function timing(pts, from = 0, opts = {}) {
        const out = { smallJump: 0, bigJump: 0, speedJump: 0, rightJump: 0, spinFlip: 0, tooFast: 0 };
        const gaps = [];
        for (let i = 1; i < pts.length; i++)
            gaps.push(pts[i].ms - pts[i - 1].ms);
        let lastSpin = 0;
        for (let i = Math.max(from, 1); i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i], dt = b.ms - a.ms, d = Math.hypot(b.x - a.x, b.y - a.y);
            // the quick notes around it: the 2nd quickest gap of its 12 neighbours
            const w = gaps.slice(Math.max(0, i - 7), i + 6).filter(g => g > 5).sort((p, q) => p - q);
            const fast = Math.max(20, w[Math.min(1, w.length - 1)] || dt);
            // (in a stream map only where the rhythm slows: the rest of a steady slower run are steps; in a mixed map
            // the same for notes closer than a jump is comfortable at, see moveFor)
            if (dt >= 1.6 * fast && dt < 400 && (i < 2 || dt >= 1.4 * (pts[i - 1].ms - pts[i - 2].ms)
                || !(opts.patterns === 'streams' || (opts.patterns !== 'jumps' && !opts.quantum && dt < (opts.jumpGap || 70))))) {
                const far = reach(dt, fast, opts);
                if (d > 0.05 && d < Math.min(1.45, 0.75 * far))
                    out.smallJump++;
                // (a real jump, as long as the time allows it at the difficulty's speed; one far past that is too fast)
                else if (d >= 1.9 && d <= 1.15 * far)
                    out.bigJump++;
                else if (d >= 1.9 && d > 1.2 * far)
                    out.tooFast++;
            }
            if (i >= 2) {
                const z = pts[i - 2], dz = Math.hypot(a.x - z.x, a.y - z.y), dtz = a.ms - z.ms;
                if (dz > 0.05 && d > 0.05 && Math.abs(Math.log((d / Math.max(dt, 25)) / (dz / Math.max(dtz, 25)))) > Math.LN2)
                    out.speedJump++;
                if (dz >= 1.9 && d >= 1.9) {
                    const v1x = a.x - z.x, v1y = a.y - z.y, v2x = b.x - a.x, v2y = b.y - a.y;
                    const cross = v1x * v2y - v1y * v2x, turn = Math.abs(Math.atan2(cross, v1x * v2x + v1y * v2y)) * 180 / Math.PI;
                    if (turn >= 60 && turn < 112)
                        out.rightJump++;
                    const spin = Math.abs(cross) < 1e-6 ? 0 : Math.sign(cross);
                    if (spin && lastSpin && spin !== lastSpin)
                        out.spinFlip++;
                    lastSpin = spin || lastSpin;
                } else
                    lastSpin = 0;
            }
        }
        return out;
    }

    // Time and distance, made sure of after the notes are placed: the map is split where the rhythm slows from quick
    // notes to a jump (a gap half again as long as the quick notes around it, and longer than the one just before),
    // and each stretch after such a jump is turned or mirrored as a whole (its own shape stays the same) so that the
    // move into it really is a jump, about as big as the time allows (twice the quick notes' time, two cells; more,
    // further), spinning on from the jump before like a star jump rather than at a right angle, and never too fast to
    // play.
    // It works as the notes are placed (the next notes join on to where these have been turned to): the function it
    // returns turns every stretch whose notes have all been placed. A stretch with a repeated bar in it stays as it is
    // (the copy has been fitted on already, and turning only part of it would spoil it).
    function reorienter(times, opts) {
        const n = times.length;
        if (n < 6)
            return () => { };
        const gap = i => times[i] - times[i - 1];
        const fast = opts.fastAt || localFast(times);
        // (the note after a quantum slide is always a jump: the slide has used most of the time, and the cursor is
        // going at the slide's speed)
        const slid = new Uint8Array(n);
        for (const [q, m] of opts.slides || [])
            for (let z = 1; z <= m && q + z < n; z++)
                slid[q + z] = 1;
        const afterSlide = i => i >= 2 && slid[i - 1] && !slid[i];
        const starts = [];
        for (let i = 1; i < n; i++) {
            if (afterSlide(i)) {
                starts.push(i);
                continue;
            }
            // (only where the rhythm slows down: the notes of a steady run of such gaps after it are the run's own
            // business, sized like any other run)
            const ro0 = opts.runOptions || {};
            if (i >= 2 && gap(i) >= 1.6 * fast[i] && gap(i) < 400 && (gap(i) >= 1.4 * gap(i - 1)
                || !(opts.patterns === 'streams' || (opts.patterns !== 'jumps' && !opts.quantum && gap(i) < (ro0.jumpGap || 70))))
                && !streamGap(gap(i), fast[i], gap(i - 1), i + 1 < n ? gap(i + 1) : 0, { quantum: opts.quantum, patterns: opts.patterns }))
                starts.push(i);
        }
        const [lo, hi] = opts.quantum ? QUANTUM : GRID;
        let c = 0;
        return (notes, locked) => {
            for (; c < starts.length; c++) {
                const s0 = starts[c], s1 = c + 1 < starts.length ? starts[c + 1] : n;
                if (s1 > notes.length)
                    return;
                let keep = false;
                for (let i = s0; i < s1 && !keep; i++)
                    keep = !!locked[i];
                if (keep)
                    continue;
                const prev = notes[s0 - 1], prev2 = notes[s0 - 2], dt = gap(s0);
                const ro = opts.runOptions || {};
                let far = reach(dt, fast[s0], { ...ro, comfort: ro.comfort && ro.comfort * (opts.levelAt ? opts.levelAt(times[s0]) : 1) });
                if (afterSlide(s0))
                    far = Math.max(far, 2.2);
                const want = Math.min(opts.quantum ? 3.2 : 2.83, Math.max(2, dt / fast[s0]) * (opts.calmAt && !afterSlide(s0) ? opts.calmAt(times[s0]) : 1), far);
                const before = prev2 && Math.hypot(prev.x - prev2.x, prev.y - prev2.y) >= 1.9
                    ? [prev.x - prev2.x, prev.y - prev2.y] : null;
                let best = null;
                for (let k = 0; k < 8; k++) {
                    const [x0, y0] = SYM[k](notes[s0].x, notes[s0].y);
                    const d0 = Math.hypot(x0 - prev.x, y0 - prev.y);
                    if (d0 / Math.max(1, dt) * 1000 > opts.speedCap || d0 < 0.05)
                        continue;
                    // (nor the same spot twice where it joins the notes already placed after it)
                    if (s1 < notes.length) {
                        const [xe, ye] = SYM[k](notes[s1 - 1].x, notes[s1 - 1].y);
                        if (Math.hypot(xe - notes[s1].x, ye - notes[s1].y) < 0.05)
                            continue;
                    }
                    let cost = 2 * Math.abs(Math.log(Math.max(d0, 0.05) / want)) + (d0 < Math.min(1.45, 0.75 * want) ? 3 : 0) + (k ? 0.1 : 0);
                    // (and not much further than the time allows at the difficulty's speed: the spots a turn can land
                    // on are a few fixed distances apart, and the next one up from what's wanted can be far too quick)
                    if (d0 >= 1.3)
                        cost += 10 * Math.max(0, d0 / far - 1.1);
                    if (before && d0 >= 1.9) {
                        const cross = before[0] * (y0 - prev.y) - before[1] * (x0 - prev.x);
                        const turn = Math.abs(Math.atan2(cross, before[0] * (x0 - prev.x) + before[1] * (y0 - prev.y))) * 180 / Math.PI;
                        if (turn >= 60 && turn < 112)
                            cost += 1;
                    }
                    // Where the cursor is coming from: out of a stream, a jump turns off it (about a right angle, a
                    // hook) rather than snapping back the way it came; after a jump, the next one doesn't land back
                    // where that one started (A to B to A); and the turn is never harder than can be played
                    const N0 = { x: x0, y: y0, ms: notes[s0].ms };
                    // (and never straight back at speed where it joins on, at either end, see thereAndBack)
                    const turned = q => { const [tx, ty] = SYM[k](notes[q].x, notes[q].y); return { x: tx, y: ty, ms: notes[q].ms }; };
                    const after = q => q < s1 ? turned(q) : notes[q];
                    if (thereAndBack(prev2, prev, N0) || (s0 + 1 < notes.length && thereAndBack(prev, N0, after(s0 + 1)))
                        || (s1 < notes.length && s1 - 2 >= s0 && thereAndBack(turned(s1 - 2), turned(s1 - 1), notes[s1]))
                        || (s1 + 1 < notes.length && thereAndBack(turned(s1 - 1), notes[s1], notes[s1 + 1])))
                        continue;
                    // (nor back onto one of the notes just played: a stream's end, the hub it went round)
                    for (let back = 2; back <= 5 && s0 - back >= 0; back++)
                        if (Math.hypot(x0 - notes[s0 - back].x, y0 - notes[s0 - back].y) < 0.35)
                            cost += 2;
                    if (prev2) {
                        const ix = prev.x - prev2.x, iy = prev.y - prev2.y, li = Math.hypot(ix, iy);
                        if (li > 0.05) {
                            const defl = Math.abs(Math.atan2(ix * (y0 - prev.y) - iy * (x0 - prev.x), ix * (x0 - prev.x) + iy * (y0 - prev.y))) * 180 / Math.PI;
                            // (a stream map hooks off at about a right angle; a jump map snaps back round like a
                            // star, as human jump maps head back the way they came)
                            // (and a jump map's, not all the way back over the stream either: 100-150 degrees)
                            if (li < 1.5)
                                cost += opts.patterns === 'jumps' ? 1.5 * Math.max(0, 120 - defl) / 70 + 1.5 * Math.max(0, defl - 150) / 30
                                    : 1.5 * Math.max(0, defl - (opts.patterns === 'streams' ? 110 : 135)) / 70;
                            else {
                                if (Math.hypot(x0 - prev2.x, y0 - prev2.y) < 0.35)
                                    cost += 2.5;
                                cost += Math.max(0, defl - 165) / 15;
                            }
                        }
                        const t1 = (prev.ms - prev2.ms) / 1000, t2 = Math.max(1, dt) / 1000;
                        if (t1 > 0 && opts.accelCap) {
                            const ax = (x0 - prev.x) / t2 - ix / t1, ay = (y0 - prev.y) / t2 - iy / t1;
                            if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > opts.accelCap)
                                continue;
                        }
                        cost += 0.75 * Math.max(0, velocityChange(prev2, prev, N0) - 0.85);
                    }
                    // (and on into the stretch's second note, and out of its last into what comes after, if that's
                    // been placed: no jerkier than it was)
                    if (s0 + 1 < s1) {
                        const [x1, y1] = SYM[k](notes[s0 + 1].x, notes[s0 + 1].y);
                        const was = velocityChange(prev, notes[s0], notes[s0 + 1]);
                        cost += 1.5 * Math.max(0, velocityChange(prev, N0, { x: x1, y: y1, ms: notes[s0 + 1].ms }) - Math.max(0.75, was));
                    }
                    if (s1 < notes.length && s1 - 2 >= s0) {
                        const [xa, ya] = SYM[k](notes[s1 - 2].x, notes[s1 - 2].y), [xb, yb] = SYM[k](notes[s1 - 1].x, notes[s1 - 1].y);
                        cost += 1.5 * Math.max(0, velocityChange({ x: xa, y: ya, ms: notes[s1 - 2].ms }, { x: xb, y: yb, ms: notes[s1 - 1].ms }, notes[s1]) - 0.75);
                    }
                    // (and the notes just after it still flow on: no awkward spot right there)
                    const look = [notes[s0 - 3], notes[s0 - 2], prev].filter(Boolean)
                        .concat(notes.slice(s0, Math.min(s1, s0 + 4)).map(nt => { const [x, y] = SYM[k](nt.x, nt.y); return { x, y, ms: nt.ms }; }));
                    const aw = awkward(look, 3);
                    cost += 2 * aw.flowBreak + aw.spacingJump;
                    if (!best || cost < best.cost)
                        best = { k, cost };
                }
                if (!best || !best.k)
                    continue;
                for (let i = s0; i < s1; i++) {
                    const [x, y] = SYM[best.k](notes[i].x, notes[i].y);
                    notes[i].x = Math.round(Math.min(hi, Math.max(lo, x)) * 1000) / 1000;
                    notes[i].y = Math.round(Math.min(hi, Math.max(lo, y)) * 1000) / 1000;
                }
            }
        };
    }

    // how often a note with room after it starts a quantum slide (with the Quantum option)
    const SLIDE_CHANCE = 0.5;

    // How much the Quantum option wants quantum notes over notes on the grid: enough that most of the map comes out
    // as quantum slides and jumps wherever they can be played
    const QUANTUM_WANT = 0.8;
    // (made-up quantum runs come after the learned maps' own quantum patterns, when those fit as well)
    // (with a learned design to follow, the other way round: runs made in that design first, and a learned figure of
    // at most QUANTUM_MOTIF notes now and then)
    const MADE_COST = 0.45;
    const QUANTUM_MOTIF = 6;
    const LEARNED_RUN = 8;
    // (how much less an example map that comes with the editor is wanted than a map it learned)
    const EXAMPLE_COST = 0.3;
    // (how much a lap round the outside is wanted over a stream from the learned maps)
    const RING_WANT = 0.2;

    // A learned run from e[i] on (turned or mirrored by SYM[k]), as an entry whose first note is `from`: the move
    // from there to e[i] is checked and costed like any other
    function jumpInto(e, k, i, from, gaps) {
        const n = Math.max(1, Math.min(gaps.length, e.cleanUntil[i + 1] - i, e.n - i)) + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        x[0] = from.x;
        y[0] = from.y;
        t[0] = e.t[i] - gaps[0];
        for (let q = 1; q < n; q++) {
            [x[q], y[q]] = SYM[k](e.x[i + q - 1], e.y[i + q - 1]);
            t[q] = e.t[i + q - 1];
        }
        return { name: e.name, x, y, t, n, quantum: true, cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n), source: e, srcI: i - 1 };
    }
    const snapTo = (v, d) => Math.round(v * d) / d;

    // A quantum run made for this spot and rhythm, as a library entry whose first note is `start` (`before` is the
    // note before it, for which way the cursor is going):
    // 'slide': the cursor gliding in small steps along a curve that sometimes bends the other way, turning back
    //          off the edges
    // 'jumps': jumps about as big as wanted here, from one spot off the grid to another, turning the same way each
    //          time like a spin
    // (sizeOf(q): how big the jump into note q + 1 should be, from its own gap)
    // (sizeOf(q): the move wanted into note q + 1; quickAt(q): whether that note is a quick one, a stream's)
    // (P: the quantum design to follow, see quantumProfile and profileAt: how its jumps turn, how far out it goes, how
    // often it lands off the grid, its slides' bend and what its spots snap to)
    function quantumRun(kind, start, before, gaps, J, sizeOf = null, quickAt = null, P = null) {
        const snapD = P ? P.snap : 12;
        // (a turn for a jump, as the design's jumps turn: which 30 degrees by how often it turns that much)
        const turnOf = () => {
            let r = Math.random();
            for (let b = 0; b < 6; b++) {
                r -= P.turns[b];
                if (r <= 0)
                    return (b + Math.random()) * Math.PI / 6;
            }
            return (5 + Math.random()) * Math.PI / 6;
        };
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        x[0] = start.x;
        y[0] = start.y;
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        const [lo, hi] = QUANTUM;
        const clamp = v => Math.min(hi, Math.max(lo, v));
        let ang = before && Math.hypot(start.x - before.x, start.y - before.y) > 0.05
            ? Math.atan2(start.y - before.y, start.x - before.x) : Math.random() * 2 * Math.PI;
        let step = 0;
        if (kind === 'slide') {
            step = P ? Math.min(0.75, Math.max(0.15, P.slideStep * (0.8 + 0.4 * Math.random())))
                : Math.min(0.75, Math.max(0.2, J * (0.45 + 0.3 * Math.random())));
            let turn = (Math.random() < 0.5 ? -1 : 1) * (P ? Math.min(0.45, P.slideBend) * (0.4 + 0.8 * Math.random()) : 0.06 + 0.3 * Math.random());
            let px = start.x, py = start.y;
            for (let q = 1; q < n; q++) {
                if (q % 8 === 0 && Math.random() < 0.35)
                    turn = -turn;
                ang += turn;
                // (curving in before the edge, a little at a time, rather than bouncing straight back off it)
                if (Math.max(Math.abs(px + Math.cos(ang) * step - 1), Math.abs(py + Math.sin(ang) * step - 1)) > 1.3) {
                    const m = Math.atan2(1 - py, 1 - px);
                    ang += Math.max(-0.35, Math.min(0.35, Math.atan2(Math.sin(m - ang), Math.cos(m - ang))));
                }
                px = clamp(px + Math.cos(ang) * step);
                py = clamp(py + Math.sin(ang) * step);
                x[q] = snapTo(px, snapD);
                y[q] = snapTo(py, snapD);
            }
        } else {
            // spins (turning 100-150 degrees each jump: triangles and stars), zigzags (nearly straight back and
            // forth, drifting across) or wide circles (turning 40-75 degrees), never going round the same shape twice.
            // Quick notes between the jumps (a stream's) curve on in an arc or an S instead, bending a little each note
            // the same way for 6-10 notes: spinning or zigzagging at stream speed only scribbles on one spot.
            let dir = Math.random() < 0.5 ? 1 : -1;
            const shape = Math.random();
            const bendOf = () => (shape < 0.45 ? 0.55 + 0.28 * Math.random() : shape < 0.75 ? 0.8 + 0.13 * Math.random() : 0.22 + 0.2 * Math.random()) * Math.PI;
            let arc = Math.random() < 0.5 ? 1 : -1, arcLeft = 6 + Math.floor(Math.random() * 5);
            // (an arc's radius, 0.9-1.4 cells: it bends by its step over the radius, so it fits the field whatever the
            // step size, a big step no more a straight line than a small one a tight knot)
            const radius = 0.9 + 0.5 * Math.random();
            // (a star spins one way for a few jumps, then the other: round and round the same way for seconds is a
            // circle, which human quantum maps break out of)
            let spinLeft = 5 + Math.floor(Math.random() * 5);
            for (let q = 1; q < n; q++) {
                const quick = !!(quickAt && quickAt(q - 1));
                // (following a design: the same way round as the last turn as often as its jumps do, and landing off
                // the grid as often as they do, on a cell or half a cell otherwise)
                const offHere = !P || Math.random() < (quick ? P.quickOff : P.landOff);
                if (P) {
                    if (!quick && Math.random() > P.sameSide)
                        dir = -dir;
                } else if (!quick && shape >= 0.45 && shape < 0.75)
                    dir = -dir;
                else if (!quick && --spinLeft <= 0) {
                    dir = -dir;
                    spinLeft = 5 + Math.floor(Math.random() * 5);
                }
                if (quick && --arcLeft <= 0) {
                    arc = -arc;
                    arcLeft = 6 + Math.floor(Math.random() * 5);
                }
                let best = null;
                const size = sizeOf ? sizeOf(q - 1) : Math.max(1.2, J);
                const bend = Math.min(1.25, Math.max(0.2, size / radius));
                // (spins and zigzags only on notes a tenth of a second or more apart: quicker jumps sweep on in
                // wide curves, as human quantum maps' do, rather than snapping back at speed)
                const slowGap = gaps[q - 1] >= 100;
                for (let c = 0; c < 40; c++) {
                    // (an arc that would run into the edge bends harder, or the other way, rather than stopping; a quick
                    // jump that can't curve on turns 75-130 degrees either way before anything sharper)
                    const a2 = quick ? ang + (c < 16 ? arc * bend * (0.8 + 0.4 * Math.random()) : -arc * (0.3 + 1.1 * Math.random()))
                        : P && c < 24 ? ang + dir * turnOf() + (Math.random() - 0.5) * 0.2
                        : c < 24 ? ang + dir * (slowGap || shape >= 0.75 ? bendOf() : (0.22 + 0.2 * Math.random()) * Math.PI) + (Math.random() - 0.5) * 0.4
                        : c < 32 && !slowGap ? ang + (Math.random() < 0.5 ? -1 : 1) * (0.42 + 0.3 * Math.random()) * Math.PI
                        : Math.random() * 2 * Math.PI;
                    const d = size * (quick ? 0.8 + 0.4 * Math.random() : 0.95 + 0.3 * Math.random());
                    // (a spot past the edge isn't moved onto it: that gives jumps back and forth along the edge)
                    let cx = snapTo(x[q - 1] + Math.cos(a2) * d, snapD), cy = snapTo(y[q - 1] + Math.sin(a2) * d, snapD);
                    // (on the grid instead: a jump onto a cell or half a cell, a quick note onto a cell, a stream's step)
                    if (!offHere) {
                        const k = quick ? 1 : 2;
                        cx = Math.min(2, Math.max(0, Math.round(cx * k) / k));
                        cy = Math.min(2, Math.max(0, Math.round(cy * k) / k));
                    }
                    const real = Math.hypot(cx - x[q - 1], cy - y[q - 1]);
                    if (cx !== clamp(cx) || cy !== clamp(cy) || (offHere && nearGrid(cx, cy)) || real < Math.min(quick && !offHere ? 0.9 : 0.6, 0.5 * size))
                        continue;
                    // (keeping to the grid and just round it, as quantum maps mostly do: as far out as the design goes)
                    let score = Math.abs(Math.log(real / size)) + 0.1 * Math.random() + 2 * Math.max(0, Math.max(Math.abs(cx - 1), Math.abs(cy - 1)) - (P ? P.r90 + 0.05 : 1.2))
                        + (P && Math.max(Math.abs(cx - 1), Math.abs(cy - 1)) > 1.02 ? 0.6 * (1 - P.outside) : 0);
                    for (let back = 2; back <= 6; back++)
                        if (q >= back && Math.hypot(cx - x[q - back], cy - y[q - back]) < 0.35)
                            score += 1;
                    // (the turned-round arcs and any-way jumps are for when nothing else fits; quick jumps turning
                    // sharply even then are the last resort)
                    if (c >= (quick ? 16 : 24))
                        score += c >= 32 || quick || slowGap ? 1.5 : 0.8;
                    if (!quick && !slowGap) {
                        const turn = Math.abs(Math.atan2(Math.sin(Math.atan2(cy - y[q - 1], cx - x[q - 1]) - ang), Math.cos(Math.atan2(cy - y[q - 1], cx - x[q - 1]) - ang)));
                        score += turn > 2.6 ? 1.5 : 0;
                    }
                    if (!best || score < best.score)
                        best = { x: cx, y: cy, score, other: quick && c >= 16 };
                }
                // (a quick run that had to bend the other way carries on that way, an S, rather than kinking back for
                // one note)
                if (best && best.other) {
                    arc = -arc;
                    arcLeft = 6 + Math.floor(Math.random() * 5);
                }
                // (boxed in: the heading closest to straight on that stays in the area, turning further and further
                // either way, rather than straight back across the middle; the arc then curves that way)
                for (let turn = 10; !best && turn <= 180; turn += 10)
                    for (const side of [1, -1]) {
                        const a2 = ang + side * turn * Math.PI / 180, d = Math.max(size, 0.5);
                        const cx = snapTo(x[q - 1] + Math.cos(a2) * d, snapD), cy = snapTo(y[q - 1] + Math.sin(a2) * d, snapD);
                        if (!best && cx === clamp(cx) && cy === clamp(cy) && realQuantum(cx, cy)) {
                            best = { x: cx, y: cy };
                            if (quick)
                                arc = side;
                        }
                    }
                if (!best) {
                    const tx = 1 - x[q - 1], ty = 1 - y[q - 1], tl = Math.max(1e-6, Math.hypot(tx, ty));
                    const d = Math.min(tl + 0.5, Math.max(size, 0.5));
                    best = { x: clamp(snapTo(x[q - 1] + tx / tl * d, snapD)), y: clamp(snapTo(y[q - 1] + ty / tl * d, snapD)) };
                }
                x[q] = best.x;
                y[q] = best.y;
                if (Math.hypot(x[q] - x[q - 1], y[q] - y[q - 1]) > 0.05)
                    ang = Math.atan2(y[q] - y[q - 1], x[q] - x[q - 1]);
            }
        }
        return {
            name: kind === 'slide' ? 'quantum slide' : 'quantum jumps', x, y, t, n, quantum: true, made: true,
            // (a slide's moves are meant to be small: it's measured against its own step, not the jump size wanted. It
            // belongs in quick notes: gliding slowly from note to note a second apart isn't a slide)
            target: kind === 'slide' ? step : undefined,
            extra: kind === 'slide' ? 0.9 * Math.min(1, Math.max(0, (t[n - 1] / Math.max(1, n - 1) - 130) / 170)) : 0,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n),
        };
    }

    // Stream shapes made for this spot and rhythm, on the grid (fast parts): what human stream maps do besides going
    // round the outside again and again.
    // 'snake':   along a row (or column) to the edge, a step over, and back the other way, covering the grid
    // 'cross':   round the outside, cutting through the middle now and then (figure eights)
    // 'reverse': round the outside, turning right back now and then (after 6 to 9 notes)
    // 'stairs':  a step one way, a step the other way, like stairs, turning back at the edges
    // A gap much longer than the run's others gets a bigger move (two cells), the way mappers space out emphasis.
    // A stream round the outside of the grid, in full laps, as human stream maps spin (prom night goes round once or
    // twice before anything else): on the way it was going, round and round, and it only changes on a strong sound
    // (acc: how strong the sound at each of its notes is), and only after a lap: from the middle of an edge, through
    // the middle to the other side, and on round from there, the other way (a figure of eight) or the same. So its
    // turns are the song's, and it never turns straight back. A gap half again as long as the quick notes is a
    // hop, two cells round instead of one.
    const RING = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];
    // (stride 2: two cells a note, a square round the corners or a diamond through the middles of the edges, for star
    // ratings past what one-cell streams can reach)
    function ringRun(start, before, gaps, acc, stride = 1) {
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        const at = (px, py) => RING.findIndex(([a, b]) => a === px && b === py);
        let px = Math.min(2, Math.max(0, Math.round(start.x))), py = Math.min(2, Math.max(0, Math.round(start.y)));
        x[0] = px;
        y[0] = py;
        const sorted = gaps.slice().sort((p, q) => p - q), quick = Math.max(20, sorted[Math.min(1, sorted.length - 1)] || 1);
        const accs = acc ? Array.from(acc).slice(0, gaps.length) : [];
        const mean = accs.length ? accs.reduce((p, q) => p + q, 0) / accs.length : 0;
        const strong = q => accs.length && accs[q - 1] >= Math.max(0.45, 1.2 * mean);
        // which way round: the way that carries on from the move before (never back onto it)
        const inX = before ? px - before.x : 0, inY = before ? py - before.y : 0;
        const pick = idx => {
            let best = 1, bestDot = -Infinity;
            for (const d of [1, -1]) {
                const [nx, ny] = RING[(idx + d + 8) % 8];
                const dot = (nx - px) * inX + (ny - py) * inY + Math.random() * 0.01;
                if (dot > bestDot) {
                    bestDot = dot;
                    best = d;
                }
            }
            return best;
        };
        let idx = at(px, py), dir = 1;
        let q = 1;
        if (idx < 0) {
            // (from the middle: out to the middle of the edge it was heading for)
            const ex = Math.abs(inX) >= Math.abs(inY) ? 1 + Math.sign(inX || 1) : 1, ey = Math.abs(inX) >= Math.abs(inY) ? 1 : 1 + Math.sign(inY || 1);
            x[1] = ex;
            y[1] = ey;
            [px, py] = [ex, ey];
            idx = at(px, py);
            q = 2;
            dir = Math.random() < 0.5 ? 1 : -1;
        } else
            dir = pick(idx);
        let since = 0, cut = null;
        for (; q < n; q++) {
            const near = gaps.slice(Math.max(0, q - 5), Math.min(gaps.length, q + 3)).sort((p, r) => p - r);
            const hop = gaps[q - 1] >= 1.6 * Math.max(20, near[0] || quick);
            if (cut) {
                // (through the middle and out the other side)
                [px, py] = cut.shift();
                if (!cut.length) {
                    cut = null;
                    idx = at(px, py);
                    // (on round from there: the other way most of the time, a figure of eight)
                    dir = Math.random() < 0.7 ? -dir : dir;
                    since = 0;
                }
            } else if (!hop && since >= 7 && idx % 2 === 1 && (strong(q) || since >= 15)) {
                // a change, on a strong sound: from the middle of an edge, into the middle...
                const [ox, oy] = RING[(idx + 4) % 8];
                [px, py] = [1, 1];
                cut = [[ox, oy]];
            } else {
                // (a hop: from a corner two cells straight on, from the middle of an edge a knight's move round to
                // the far corner; never across a diagonal, which human streams don't do)
                idx = (idx + dir * stride * (hop ? (idx % 2 ? 3 : 2) : 1) + 8) % 8;
                [px, py] = RING[idx];
                since += hop ? 2 : 1;
            }
            x[q] = px;
            y[q] = py;
        }
        return {
            name: 'stream ring', x, y, t, n, quantum: false, made: true,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n).fill(n),
        };
    }

    function streamRun(kind, start, before, gaps) {
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        const clampG = v => Math.min(2, Math.max(0, v));
        x[0] = clampG(Math.round(start.x));
        y[0] = clampG(Math.round(start.y));
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        // (the quickest of its gaps: a gap half again as long is a jump)
        const sorted = gaps.slice().sort((p, q) => p - q), quick = Math.max(20, sorted[Math.min(1, sorted.length - 1)] || 1);
        const inside = (px, py) => px >= 0 && px <= 2 && py >= 0 && py <= 2;
        // which way it's going: on from the move before, along its main direction
        let dx = 1, dy = 0;
        if (before && Math.hypot(x[0] - before.x, y[0] - before.y) > 0.05) {
            const mx = x[0] - before.x, my = y[0] - before.y;
            if (Math.abs(mx) >= Math.abs(my))
                [dx, dy] = [Math.sign(mx), 0];
            else
                [dx, dy] = [0, Math.sign(my)];
        } else
            [[dx, dy]] = [[[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]];
        // (the way it steps over to the next row, or sideways on the stairs: across the way it's going)
        let ox = -dy, oy = dx;
        if (Math.random() < 0.5)
            [ox, oy] = [-ox, -oy];
        let count = 0, flipAt = 6 + Math.floor(Math.random() * 4);
        for (let q = 1; q < n; q++) {
            const px = x[q - 1], py = y[q - 1];
            // (a jump where the gap is half again as long as the quick notes just around it)
            const near = gaps.slice(Math.max(0, q - 5), Math.min(gaps.length, q + 3)).sort((p, r) => p - r);
            const far = gaps[q - 1] >= 1.6 * Math.max(20, near[0] || quick) ? 2 : 1;
            if (far === 2 && !inside(px + 2 * dx, py + 2 * dy)) {
                // A jump that doesn't fit straight on: two cells, a knight jump or across the corner instead, turning
                // back round like a star jump (about 140 degrees: a right angle off a stream makes square corners),
                // never straight back, never back onto the notes just played or into the middle, and the stream
                // carries on along the way it landed
                let best = null;
                for (const [a, b] of [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
                    const tx = px + a, ty = py + b;
                    if (!inside(tx, ty) || (tx === 1 && ty === 1))
                        continue;
                    let onBefore = false;
                    for (let back = 2; back <= 4 && q - back >= 0; back++)
                        onBefore = onBefore || (tx === x[q - back] && ty === y[q - back]);
                    if (onBefore)
                        continue;
                    const turn = Math.acos(Math.max(-1, Math.min(1, (a * dx + b * dy) / Math.hypot(a, b)))) * 180 / Math.PI;
                    if (turn > 170)
                        continue;
                    // (one block over at about a right angle, as stream maps hop, never straight back)
                    if (turn > 150)
                        continue;
                    const score = Math.abs(turn - 90) + 10 * Math.random();
                    if (!best || score < best.score)
                        best = { tx, ty, a, b, score };
                }
                if (best) {
                    x[q] = best.tx;
                    y[q] = best.ty;
                    // (and the stream goes on turned off the hop, about a right angle again, into the grid)
                    const [hx, hy] = Math.abs(best.a) >= Math.abs(best.b) ? [Math.sign(best.a), 0] : [0, Math.sign(best.b)];
                    [dx, dy] = inside(best.tx - hy, best.ty + hx) ? [-hy, hx] : [hy, -hx];
                    [ox, oy] = [-dy, dx];
                    count = 0;
                    continue;
                }
            }
            const stepOver = () => {
                if (!inside(px + ox, py + oy))
                    [ox, oy] = [-ox, -oy];
                return [px + ox, py + oy];
            };
            let nx = px + dx * far, ny = py + dy * far;
            if (kind === 'reverse' && count + 1 >= flipAt) {
                [dx, dy] = [-dx, -dy];
                count = 0;
                flipAt = 6 + Math.floor(Math.random() * 4);
                nx = px + dx * far;
                ny = py + dy * far;
            }
            if (kind === 'stairs' && q % 2 === 0)
                [nx, ny] = stepOver();
            else if (kind === 'stairs' && !inside(nx, ny)) {
                [dx, dy] = [-dx, -dy];
                nx = px + dx;
                ny = py + dy;
            }
            // (turning in at a right angle while going along the edge, never straight back the way it came)
            const cx = Math.sign(1 - px), cy = Math.sign(1 - py);
            if (kind === 'cross' && Math.random() < 0.35 && (px === 1) !== (py === 1) && cx * dx + cy * dy === 0 && count >= 2) {
                // from the middle of an edge, through the middle to the other side
                [dx, dy] = [cx, cy];
                nx = px + dx * far;
                ny = py + dy * far;
                count = -1;
            }
            count++;
            if (!inside(nx, ny)) {
                if (kind === 'snake') {
                    // a step over to the next row, then back along it
                    [nx, ny] = stepOver();
                    [dx, dy] = [-dx, -dy];
                } else {
                    // round the corner
                    let tx = -dy, ty = dx;
                    if (!inside(px + tx, py + ty))
                        [tx, ty] = [-tx, -ty];
                    [dx, dy] = [tx, ty];
                    nx = px + dx;
                    ny = py + dy;
                }
            }
            if (!inside(nx, ny) || (nx === px && ny === py)) {
                // boxed in: any neighbour but the cell before
                const opts = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([a, b]) => [px + a, py + b])
                    .filter(([a, b]) => inside(a, b) && !(q >= 2 && a === x[q - 2] && b === y[q - 2]));
                [nx, ny] = opts[Math.floor(Math.random() * opts.length)] || [1, 1];
            }
            x[q] = nx;
            y[q] = ny;
        }
        return {
            name: `stream ${kind}`, x, y, t, n, quantum: false, made: true,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n).fill(n),
        };
    }

    // A seeded random number generator (the same seed, the same numbers), so parts of the song that sound the same
    // get stream shapes made the same way
    function seeded(seed) {
        let s = (seed >>> 0) || 1;
        return () => {
            s = (s + 0x6D2B79F5) >>> 0;
            let t = Math.imul(s ^ (s >>> 15), 1 | s);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // Streams made for here, a note at a time, as human stream maps go: a cell a note along the grid's lines (never
    // across a diagonal), turning a right angle where the music hits and carrying straight on between, spinning one
    // way and switching to the other on a strong sound, never back over the cells it has just been on (so it doesn't
    // go round the same little loop), and a hop two cells over (or a knight's move) where the rhythm leaves a note
    // out. Two kinds:
    //   'walk': snakes, crosses and turns along the lines, in a different shape every time
    //   'star': knight's moves and two-cell hops, turning back round about 135 degrees each note, the star streams of
    //           human mixed maps (only in their intense parts, never in a stream map)
    // `seed` picks the shape: the same sounds give the same seed, and so a part that comes back gets a stream like the
    // one it had (turned however it joins on).
    const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const HOP2 = [[2, 0], [-2, 0], [0, 2], [0, -2]];
    const KNIGHT = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
    function walkRun(kind, start, before, gaps, acc, seed) {
        const rnd = seeded(seed);
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        const inside = (px, py) => px >= 0 && px <= 2 && py >= 0 && py <= 2;
        x[0] = Math.min(2, Math.max(0, Math.round(start.x)));
        y[0] = Math.min(2, Math.max(0, Math.round(start.y)));
        const sorted = gaps.slice().sort((p, q) => p - q), quick = Math.max(20, sorted[Math.min(1, sorted.length - 1)] || 1);
        const accs = acc ? Array.from(acc).slice(0, gaps.length) : [];
        const mean = accs.length ? accs.reduce((p, q) => p + q, 0) / accs.length : 0;
        const strong = q => accs.length > 0 && accs[q - 1] >= Math.max(0.45, 1.2 * mean);
        let dx = before ? x[0] - before.x : 0, dy = before ? y[0] - before.y : 0;
        if (Math.hypot(dx, dy) < 0.05)
            [dx, dy] = ORTH[Math.floor(rnd() * 4)];
        let spin = rnd() < 0.5 ? 1 : -1;
        // (how this one likes to go: how long it keeps straight on, and how much it likes the middle)
        const straightFor = 1 + Math.floor(rnd() * 3), middle = rnd() < 0.5 ? 0.2 : 0.9;
        let straight = 0, ringRun = 0, ringDir = 0;
        for (let q = 1; q < n; q++) {
            const px = x[q - 1], py = y[q - 1];
            const near = gaps.slice(Math.max(0, q - 5), Math.min(gaps.length, q + 3)).sort((p, r) => p - r);
            const hop = gaps[q - 1] >= 1.6 * Math.max(20, near[0] || quick);
            const moves = kind === 'star' ? [...KNIGHT, ...HOP2] : hop ? [...HOP2, ...KNIGHT] : ORTH;
            const din = Math.hypot(dx, dy);
            let best = null;
            for (const [mx, my] of moves) {
                const tx = px + mx, ty = py + my;
                if (!inside(tx, ty))
                    continue;
                // (never straight back onto the note before)
                if (q >= 2 && tx === x[q - 2] && ty === y[q - 2])
                    continue;
                const ml = Math.hypot(mx, my);
                const cos = (mx * dx + my * dy) / (ml * din), cross = dx * my - dy * mx;
                const turn = Math.atan2(cross, mx * dx + my * dy) * 180 / Math.PI;
                if (Math.abs(turn) > (kind === 'star' ? 160 : 100))
                    continue;
                let s = 0.35 * rnd();
                // not back onto the cells it has just been on (the shorter ago, the more)
                for (let back = 2; back <= 6 && q - back >= 0; back++)
                    if (tx === x[q - back] && ty === y[q - back])
                        s += 3 / (back - 1);
                if (kind === 'star')
                    s += Math.abs(Math.abs(turn) - 140) / 40;
                else {
                    // straight on for a while, then a turn; a turn on the strong sounds rather than the weak ones
                    const goes = cos > 0.99;
                    if (goes)
                        s += straight >= straightFor ? 0.5 : -0.3;
                    if (strong(q))
                        s += goes ? 0.4 : -0.25;
                    if (hop && ml > 2.1)
                        s += 0.3;
                }
                // spinning one way, and the other way only on a strong sound
                if (Math.abs(turn) > 30 && Math.abs(turn) < 179)
                    s += Math.sign(turn) === spin ? -0.2 : strong(q) ? -0.1 : 0.6;
                if (tx === 1 && ty === 1)
                    s += middle;
                // (round the outside a few steps at most, then in through the middle or back the other way)
                if (ringRun >= 3 && ringStep([px, py], [tx, ty]) === ringDir)
                    s += 0.4 * (ringRun - 2);
                if (!best || s < best.s)
                    best = { tx, ty, mx, my, turn, s };
            }
            if (!best) {
                const opts = ORTH.map(([a, b]) => [px + a, py + b]).filter(([a, b]) => inside(a, b) && !(q >= 2 && a === x[q - 2] && b === y[q - 2]));
                const [a, b] = opts[Math.floor(rnd() * opts.length)] || [1, 1];
                best = { tx: a, ty: b, mx: a - px, my: b - py, turn: 0 };
            }
            x[q] = best.tx;
            y[q] = best.ty;
            const st = ringStep([px, py], [best.tx, best.ty]);
            if (st && (st === ringDir || !ringRun))
                ringRun++;
            else
                ringRun = st ? 1 : 0;
            ringDir = st;
            if (Math.abs(best.turn) > 30 && Math.abs(best.turn) < 179)
                spin = Math.sign(best.turn);
            straight = Math.abs(best.turn) < 1 ? straight + 1 : 0;
            dx = best.mx;
            dy = best.my;
        }
        return {
            name: `stream ${kind}`, x, y, t, n, quantum: false, made: true,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n).fill(n),
        };
    }

    // Flow made for exactly here, any speed (a stream, jumps, or the two mixed): each note goes about as far as its
    // timing wants (`wants`, cells), onto the cell that keeps the cursor flowing: small moves carry on or turn a right
    // angle, jumps swing round the way the cursor is turning (the star shapes of human jump maps, round the middle
    // rather than back and forth), a strong sound gets the bigger move and may switch which way it turns, and it never
    // goes back onto the cells it was just on. `seed` picks among the ways that flow equally well.
    function flowRun(start, before, gaps, wants, acc, seed) {
        const rnd = seeded(seed);
        const n = gaps.length + 1;
        const x = new Float64Array(n), y = new Float64Array(n), t = new Float64Array(n);
        for (let q = 1; q < n; q++)
            t[q] = t[q - 1] + gaps[q - 1];
        x[0] = Math.min(2, Math.max(0, Math.round(start.x)));
        y[0] = Math.min(2, Math.max(0, Math.round(start.y)));
        const accs = acc ? Array.from(acc).slice(0, gaps.length) : [];
        const mean = accs.length ? accs.reduce((p, q) => p + q, 0) / accs.length : 0;
        const strong = q => accs.length > 0 && accs[q - 1] >= Math.max(0.45, 1.2 * mean);
        let dx = before ? x[0] - before.x : 0, dy = before ? y[0] - before.y : 0;
        if (Math.hypot(dx, dy) < 0.05)
            [dx, dy] = ORTH[Math.floor(rnd() * 4)];
        let spin = rnd() < 0.5 ? 1 : -1;
        let lastMove = before ? Math.hypot(x[0] - before.x, y[0] - before.y) : 1;
        for (let q = 1; q < n; q++) {
            const px = x[q - 1], py = y[q - 1];
            const want = Math.min(2.83, Math.max(1, wants[q - 1] * (strong(q) ? 1.15 : 1)));
            const din = Math.hypot(dx, dy);
            let best = null;
            for (let tx = 0; tx <= 2; tx++)
                for (let ty = 0; ty <= 2; ty++) {
                    if (tx === px && ty === py)
                        continue;
                    const mx = tx - px, my = ty - py, ml = Math.hypot(mx, my);
                    const turn = Math.atan2(dx * my - dy * mx, dx * mx + dy * my) * 180 / Math.PI, at = Math.abs(turn);
                    let s = 0.25 * rnd();
                    // as far as the timing wants
                    s += 1.4 * Math.abs(Math.log(ml / want));
                    // (a diagonal step between quick notes isn't how streams go)
                    if (want < 1.3 && Math.abs(ml - Math.SQRT2) < 0.01)
                        s += 0.6;
                    // the turn: steps go on or turn a right angle; jumps swing round, about 110 to 160 degrees
                    if (want < 1.3)
                        s += at < 1 ? 0 : at < 100 ? 0.15 : 2;
                    else if (want < 1.8)
                        s += at < 45 ? 0.3 : at <= 140 ? 0 : 0.8;
                    else
                        s += at >= 100 && at <= 165 ? 0 : at > 165 ? 0.9 : 0.5 + (100 - at) / 100;
                    // turning the way it has been turning (a spin, a star), the other way only on a strong sound
                    if (at > 20 && at < 175)
                        s += Math.sign(turn) === spin ? -0.15 : strong(q) ? 0 : 0.45;
                    // a sudden change of size where the timing doesn't change is a stumble
                    if (q >= 2 && Math.abs(gaps[q - 1] - gaps[q - 2]) <= 0.15 * gaps[q - 1])
                        s += 0.5 * Math.abs(Math.log(ml / Math.max(0.5, lastMove)));
                    // never back onto the cells it was just on
                    for (let back = 2; back <= 5 && q - back >= 0; back++)
                        if (tx === x[q - back] && ty === y[q - back])
                            s += 2.5 / (back - 1);
                    if (!best || s < best.s)
                        best = { tx, ty, mx, my, turn, ml, s };
                }
            x[q] = best.tx;
            y[q] = best.ty;
            if (Math.abs(best.turn) > 20 && Math.abs(best.turn) < 175)
                spin = Math.sign(best.turn);
            dx = best.mx;
            dy = best.my;
            lastMove = best.ml;
        }
        return {
            name: 'flow', x, y, t, n, quantum: false, made: true,
            cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n).fill(n),
        };
    }

    // One note a comfortable move on from `prev` (for when no run at all can be played there, so the map never just
    // stops): on the grid, or anywhere on the quantum grid with the Quantum option
    function stepNote(prev, prev2, ms, J, opts) {
        if (!prev)
            return { x: 1, y: 1, ms };
        const spots = [];
        const [lo, hi] = opts.quantum ? QUANTUM : GRID, d = opts.quantum ? 4 : 1;
        for (let x = Math.ceil(lo * d) / d; x <= hi + 1e-9; x += 1 / d)
            for (let y = Math.ceil(lo * d) / d; y <= hi + 1e-9; y += 1 / d)
                spots.push([x, y]);
        let best = null;
        for (const [x, y] of spots) {
            const dist = Math.hypot(x - prev.x, y - prev.y);
            const tn = streamTurn(prev2, prev, { x, y, ms }, opts.quantum ? 100 : 160);
            if (dist < 0.05 || (prev2 && Math.hypot(x - prev2.x, y - prev2.y) < 0.05) || thereAndBack(prev2, prev, { x, y, ms }) || (tn !== null && Math.abs(tn) >= 120))
                continue;
            const speed = dist / Math.max(1, ms - prev.ms) * 1000;
            const score = Math.abs(Math.log((dist + 0.15) / (J + 0.15))) + (speed > opts.speedCap ? 5 + speed / opts.speedCap : 0) + 0.2 * Math.random();
            if (!best || score < best.score)
                best = { x, y, score };
        }
        return best ? { x: best.x, y: best.y, ms } : { x: prev.x, y: prev.y, ms };
    }

    // Finds the run of library notes to copy next.
    // gaps: the time from the previous note to each new note; prev/prev2: the last two notes placed
    // How quick the quick notes are around each note (ms): the gap most of the nearby gaps are longer than (leaving
    // out the gaps into the notes marked in `skip`, a quantum slide's)
    function localFast(times, skip = null) {
        const n = times.length;
        const fast = new Float64Array(n).fill(20);
        const gap = i => times[i] - times[i - 1];
        for (let i = 1; i < n; i++) {
            const w = [];
            for (let k = Math.max(1, i - 12); k <= Math.min(n - 1, i + 12); k++)
                if (gap(k) > 5 && !(skip && skip[k]))
                    w.push(gap(k));
            w.sort((p, q) => p - q);
            fast[i] = Math.max(20, w[Math.floor(0.15 * w.length)] || 20);
        }
        return fast;
    }

    // The move wanted for a note `gap` ms after the last one, from `size` (the size wanted there). Human maps jump
    // across the grid (2+ cells) on jump-timed notes, ones half again as far apart as the quick notes around them
    // (`fast`, ms): the cursor goes about as fast as in the quick notes, twice the time and twice the distance. And
    // on any notes far enough apart in time, whatever their style (jump maps from where two cells can be played
    // comfortably, stream maps from about 100ms; opts.jumpGap). Never faster than the difficulty's comfortable speed (opts.comfort, cells a second) or
    // the quick notes' own speed allow.
    // (prevGap: the gap before this one, if known: a stream map jumps only where the rhythm slows, and steps on
    // through a steady run of slower notes after that)
    // A to B and straight back to A at stream or jump speed (both moves under 100ms): a jerk no human map has, so
    // nothing is placed that way (a learned run's turn played faster than in its own map, a join, a turned stretch)
    function thereAndBack(a, b, c) {
        return !!a && !!b && !!c && c.ms - b.ms < 100 && b.ms - a.ms < 100 && Math.hypot(c.x - a.x, c.y - a.y) < 0.35
            && Math.hypot(b.x - a.x, b.y - a.y) > 0.5;
    }

    // How the cursor turns at b on its way from a to c (degrees, + one way round, - the other), when both moves are a
    // stream's: quick (under maxGap: 100ms in quantum maps, whose slower small moves are jumps, 160ms on the grid) and
    // steady, and small; null otherwise. A stream spins one way, then the other: it
    // never turns sharply back between quick notes, nor kinks against the way it's turning for a single note (the
    // sudden change against the flow players hate)
    function streamTurn(a, b, c, maxGap = 100) {
        if (!a || !b || !c)
            return null;
        const g1 = b.ms - a.ms, g2 = c.ms - b.ms, ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
        const m1 = Math.hypot(ux, uy), m2 = Math.hypot(vx, vy);
        if (!(g1 > 0 && g2 > 0 && g1 < maxGap && g2 < maxGap && Math.max(g1, g2) <= 1.35 * Math.min(g1, g2) && m1 >= 0.3 && m1 <= 1.6 && m2 >= 0.3 && m2 <= 1.6))
            return null;
        return Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180 / Math.PI;
    }

    // What a note `gap` ms after the last is to a stream on the grid: 'step' (on to a cell next to the last) or 'hop'
    // (one block over, two cells, after a note left out: how stream maps break a stream up without breaking its
    // flow, at about a right angle and on the stream goes), or null where the style decides. The stream's own step is
    // the gaps either side when they're alike and quick. A stream map is only streams: every note a step, or a hop
    // where the rhythm slows; a mixed map's streams step on and hop over a note left out, and a stream at its own
    // speed never suddenly skips across (prevMove: the move before, when known). Jump and quantum maps: null.
    function streamGap(gap, fast, prevGap, nextGap, opts, prevMove = Infinity) {
        if (opts.quantum || opts.patterns === 'jumps' || !(gap > 0))
            return null;
        if (opts.patterns === 'streams')
            return prevGap > 0 && gap >= 1.6 * prevGap ? 'hop' : 'step';
        const step = prevGap > 0 && nextGap > 0 && Math.max(prevGap, nextGap) <= 1.25 * Math.min(prevGap, nextGap) && Math.max(prevGap, nextGap) < 110
            ? Math.min(prevGap, nextGap) : 0;
        if (step && gap >= 1.6 * step && gap <= 2.4 * step)
            return 'hop';
        if (step && Math.abs(gap - step) <= 0.2 * step && prevMove <= 1.5)
            return 'step';
        return null;
    }

    function moveFor(size, gap, opts, fast = 0, prevGap = 0, nextGap = 0, weak = 0) {
        const g = opts.jumpGap || 100;
        // (in a mixed map, notes closer than jumpGap too: a run of 1/8 notes next to 1/16 bursts isn't a chain of
        // jumps, only its first note is)
        const timed = fast > 0 && gap >= 1.6 * fast && (!prevGap || gap >= 1.4 * prevGap
            || !(opts.patterns === 'streams' || (opts.patterns !== 'jumps' && !opts.quantum && gap < g)));
        // (smaller with a small Jump Size, and in calm parts: an intro's slow notes are small jumps, a drop's big ones)
        // (from a little under jumpGap the floor grows from one cell to two, so a tempo a few percent faster or
        // slower doesn't turn a whole part from steps into jumps)
        const floor = gap >= 1.6 * g ? 2.24 : gap >= g || timed ? 2 : gap >= 0.85 * g ? 1 + (gap - 0.85 * g) / (0.15 * g) : 0;
        const want = Math.max(size, floor * Math.min(1, opts.jumpScale || 1) * (opts.calm ?? 1));
        // (and the quick notes themselves, a stream, step a cell at a time in every style, as long as they're quick:
        // a steady run of slower notes, where there's time, is the style's own; and a stream's own, see streamGap)
        const sg = streamGap(gap, fast, prevGap, nextGap, opts);
        // (a map forced past what one-cell streams can rate: its streams spaced out, two cells a note)
        const spaced = opts.force && (opts.jumpScale || 1) >= 1.2 ? 2.05 : 0;
        if (sg === 'hop')
            return spaced || (reach(gap, fast, opts) >= 1.9 ? 2 : 1.41);
        if ((fast > 0 && gap < 1.3 * fast && gap < g && !opts.quantum) || sg === 'step')
            return spaced ? Math.min(want * 2, spaced) : Math.min(want, 1.05, reach(gap, fast, opts));
        const move = Math.min(want, reach(gap, fast, opts));
        // (on the grid, a jump shrunk by a calm part or the difficulty's speed is still a jump: across a corner, or
        // two cells where there's time, not a one-cell step)
        // (a jump part's weaker beat: a short jump, a cell, or across a corner)
        if (weak && floor >= 2 && !opts.quantum)
            return Math.min(move, weak === 2 ? 1 : 1.41);
        if (!opts.quantum && floor >= 2 && move >= 1.2 && move < 2)
            return move >= 1.85 ? 2 : 1.41;
        return move;
    }

    // The furthest a move `gap` ms long should go (cells): at the difficulty's comfortable speed (opts.comfort), or
    // about as fast as the quick notes around it go (one cell every `fast` ms) at 10, less of that below (opts.pace)
    function reach(gap, fast, opts) {
        if (!opts.comfort)
            return Infinity;
        return Math.max(0.95, Math.max(opts.comfort, fast > 0 ? (opts.pace ?? 1) * 1000 / fast : 0) * gap / 1000);
    }

    // A shape of 6 moves however it's turned or mirrored or where it is: each move's length and the turn into it
    // (pts: [x, y] points; the 7 ending at `end`)
    // Where a point is on the ring round the outside of the grid (RING), or -1; and from one to the next: 1 or -1 a
    // step round it (one way or the other), else 0
    const ringAt = (px, py) => isWhole(px) && isWhole(py) ? RING.findIndex(([a, b]) => a === Math.round(px) && b === Math.round(py)) : -1;
    const ringStep = (p, q) => {
        const a = ringAt(p[0], p[1]), b = ringAt(q[0], q[1]);
        return a < 0 || b < 0 ? 0 : (b - a + 8) % 8 === 1 ? 1 : (a - b + 8) % 8 === 1 ? -1 : 0;
    };
    // how many of the last notes went round the ring in a spin of 6 or more steps one way (share of `pts`)
    function spinShare(pts) {
        let inSpin = 0, cur = 0, dir = 0;
        for (let q = 1; q < pts.length; q++) {
            const st = ringStep(pts[q - 1], pts[q]);
            if (st && (st === dir || !cur)) {
                cur++;
                dir = st;
            } else {
                if (cur >= 6)
                    inSpin += cur + 1;
                cur = st ? 1 : 0;
                dir = st;
            }
        }
        if (cur >= 6)
            inSpin += cur + 1;
        return pts.length ? inSpin / pts.length : 0;
    }

    function shapeKey(pts, end) {
        let a = '', b = '';
        for (let z = end - 5; z <= end; z++) {
            const p0 = pts[z - 1], p1 = pts[z];
            const mx = p1[0] - p0[0], my = p1[1] - p0[1];
            const len = Math.round(4 * Math.hypot(mx, my));
            let turn = 0;
            if (z > end - 5) {
                const q = pts[z - 2], ux = p0[0] - q[0], uy = p0[1] - q[1];
                turn = Math.round(Math.atan2(ux * my - uy * mx, ux * mx + uy * my) / (Math.PI / 12));
            }
            a += `${len}:${turn} `;
            b += `${len}:${-turn} `;
        }
        return a < b ? a : b;
    }

    function findRun(lib, gaps, prev, prev2, opts, used) {
        const bounds = opts.quantum ? QUANTUM : GRID;
        // The average move wanted here (opts.jump), but never more than the time allows at a comfortable speed for the
        // difficulty: like human maps, big jumps go where the notes are far enough apart in time, and quick notes
        // (a 1/8 stream between 1/4 jumps) move a cell at a time
        const gm = gaps.slice().sort((p, q) => p - q)[gaps.length >> 1] || 200;
        const runJump = opts.comfort ? Math.min(opts.jump, Math.max(0.95, opts.comfort * gm / 1000)) : opts.jump;
        const vmax = opts.vmax; // the fastest a single move should make the cursor go (cells per second)
        const candidates = [];

        const flow = opts.flow ?? 0.7, follow = opts.follow ?? 0.75, variety = opts.variety ?? 0.5;
        const model = opts.flowModel;
        // how far apart the rhythm may be: a run is matched by the shape of its rhythm (which gaps are short and
        // which long) at any speed from 0.6x to 5x the original, with a small cost for playing it at another speed
        // (wide enough that a pattern carries on through a rhythm a little different from its own, costing for how
        // far it strays, rather than stopping after a few notes: patterns cut every 3 or 4 notes made a patchwork
        // with no flow)
        const relTol = opts.loose ? 3 : 0.6 + 0.5 * (1 - follow);
        const consider = (e, k, i, ox, oy) => {
            // copy e[i + 1 ...] after e[i], which lands on prev
            const f = SYM[k];
            const J = e.target || runJump;
            // (quantum: what it takes from a learned map is a short figure, a few notes, not a stretch of it copied;
            // the rest is made in the maps' design, see quantumRun)
            // (and on the grid at most LEARNED_RUN notes of a learned map at a time: its feel, not a copy of it; the map
            // being made is the exception, its own patterns can carry on)
            const len = Math.min(gaps.length, e.n - i - 1, opts.quantum ? (e.made || !opts.qp ? Infinity : QUANTUM_MOTIF) : e.wholeUntil[i + 1] - i - 1,
                e.cleanUntil[i + 1] - i - 1, e.made || e.bonus || opts.quantum ? Infinity : LEARNED_RUN);
            if (len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            // starting fresh (nothing to land on): the move from the last note placed still has to be playable
            if (!prev && opts.anchor) {
                const [x0, y0] = f(e.x[i + 1], e.y[i + 1]);
                const d0 = Math.hypot(x0 + ox - opts.anchor.x, y0 + oy - opts.anchor.y), s0 = d0 / Math.max(gaps[0], 1) * 1000;
                if (d0 < 0.05 || s0 > opts.speedCap || (d0 >= 1.5 && s0 > Math.max(0.45 * vmax, 3 * (opts.recentSpeed || 0) + 2))
                    || thereAndBack(opts.anchor2, opts.anchor, { x: x0 + ox, y: y0 + oy, ms: opts.anchor.ms + gaps[0] }))
                    return;
            }
            let cost = 0, used_len = 0, dist = 0, spins = 0, spikes = 0, logSum = 0, rough = 0, roughN = 0, off = 0, sized = 0, wanted = 0, lattice = 0;
            let scribble = 0, ball = 0, under = 0, nearRun = 0, kinks = 0, turnA = 0, turnB = 0, bigOnWeak = 0, shortRow = 0;
            let lastShort = prev && prev2 && Math.hypot(prev.x - prev2.x, prev.y - prev2.y) < 1.5 ? 1 : 0;
            // (going round the ring: how many steps one way so far, counting the notes before; and the steps past 3)
            let ringRun = 0, ringDir = 0, ringOver = 0;
            if (opts.recentPts && !opts.quantum) {
                const rp = opts.recentPts;
                for (let z = Math.max(1, rp.length - 10); z < rp.length; z++) {
                    const st = ringStep(rp[z - 1], rp[z]);
                    if (st && (st === ringDir || !ringRun)) {
                        ringRun++;
                        ringDir = st;
                    } else {
                        ringRun = st ? 1 : 0;
                        ringDir = st;
                    }
                }
            }
            const recent = [prev2, prev].filter(Boolean).map(p => [p.x, p.y]);
            let lastGap = prev && prev2 ? prev.ms - prev2.ms : 0;
            for (let q = 0; q < len; q++) {
                const gl = e.t[i + q + 1] - e.t[i + q], gg = gaps[q];
                const r = Math.log((Math.min(gg, 1200) + 10) / (Math.min(gl, 1200) + 10));
                const dev = q ? Math.abs(r - logSum / q) : 0;
                if (dev > relTol && q > 0)
                    break;
                const [x, y] = f(e.x[i + q + 1], e.y[i + q + 1]);
                // (a part of a quantum map being followed may go where it went, off the grid too)
                const [b0, b1] = e.free ? QUANTUM : bounds;
                if (x + ox < b0 - 1e-6 || x + ox > b1 + 1e-6 || y + oy < b0 - 1e-6 || y + oy > b1 + 1e-6)
                    break;
                // (unless the design itself streams on the grid between its quantum parts)
                if (opts.quantum && !e.made && (!opts.qp || opts.qp.off > 0.6)) {
                    nearRun = nearGrid(x + ox, y + oy) ? nearRun + 1 : 0;
                    if (nearRun >= 3)
                        break;
                }
                // Physically playable at the new timing, however fast the map it comes from was: no move faster than
                // the difficulty's top speed, no turning round harder than it allows, and no far jump much faster
                // than the notes just before (the run stops before such a note)
                const move = Math.hypot(e.x[i + q + 1] - e.x[i + q], e.y[i + q + 1] - e.y[i + q]);
                const speed = move / Math.max(gg, 1) * 1000;
                // (how fast it's been going over the last 8 moves: the notes placed before, then the run's own)
                let lately = opts.recentSpeed || 0;
                if (q && opts.recentMoves && isFinite(lately)) {
                    let d = 0, t = 0;
                    const fromRun = Math.min(q, 8);
                    for (const [md, mt] of opts.recentMoves.slice(opts.recentMoves.length - (8 - fromRun))) {
                        d += md;
                        t += mt;
                    }
                    for (let z = q - fromRun; z < q; z++) {
                        d += Math.hypot(e.x[i + z + 1] - e.x[i + z], e.y[i + z + 1] - e.y[i + z]);
                        t += gaps[z];
                    }
                    lately = t > 0 ? d / t * 1000 : lately;
                }
                if (speed > opts.speedCap || (move >= 1.5 && speed > Math.max(0.45 * vmax, 3 * lately + 2)))
                    break;
                // (nor a far move much quicker than the difficulty takes them: a learned map's jump stream, or its
                // quantum circle, at a harder map's pace ends the run there rather than costing a little)
                if (opts.comfort && move >= (opts.quantum ? 0.9 : 1.3) && move > (opts.reachSlack || (opts.quantum ? 1.4 : 1.35)) * reach(gg, opts.fast ? opts.fast[q] : 0, opts))
                    break;
                // (a stream is never forced off: inside one a note steps on, or hops one block over at about a right angle,
                // never further and never back the way it came; a stream map never moves further than that at all)
                if (move > 1.6 && !opts.quantum && opts.patterns !== 'jumps') {
                    const pq = recent.length >= 2 ? recent[recent.length - 2] : null, lq = recent.length ? recent[recent.length - 1] : null;
                    const pm = pq && lq ? Math.hypot(lq[0] - pq[0], lq[1] - pq[1]) : Infinity;
                    const sg = streamGap(gg, opts.fast ? opts.fast[q] : 0, q ? gaps[q - 1] : lastGap, q + 1 < gaps.length ? gaps[q + 1] : 0, opts, pm);
                    if (sg === 'step' || ((sg === 'hop' || opts.patterns === 'streams') && move > 2.3))
                        break;
                    if (sg === 'hop' && pq && lq && pm > 0.3) {
                        const ux = lq[0] - pq[0], uy = lq[1] - pq[1], vx = x + ox - lq[0], vy = y + oy - lq[1];
                        if ((ux * vx + uy * vy) / (pm * move) < Math.cos(140 * Math.PI / 180))
                            break;
                    }
                }
                if (recent.length >= 2 && lastGap > 0) {
                    const [a, b] = recent.slice(-2), t1 = lastGap / 1000, t2 = Math.max(gg, 1) / 1000;
                    const ax = (x + ox - b[0]) / t2 - (b[0] - a[0]) / t1, ay = (y + oy - b[1]) / t2 - (b[1] - a[1]) / t1;
                    if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > opts.accelCap)
                        break;
                }
                // notes on the same spot twice and little 2x2 circles are what make auto maps feel wrong (a learned
                // map's stacked notes, the same spot twice a moment apart, end the run before them)
                const last = recent[recent.length - 1];
                if (last && Math.hypot(last[0] - x - ox, last[1] - y - oy) < 0.05)
                    break;
                // (nor straight back where it was two notes ago, at speed, see thereAndBack)
                const back = recent[recent.length - 2];
                if (back && lastGap > 0 && thereAndBack({ x: back[0], y: back[1], ms: 0 }, { x: last[0], y: last[1], ms: lastGap }, { x: x + ox, y: y + oy, ms: lastGap + gg }))
                    break;
                // (and starting fresh from a note, not back onto it on the run's second note)
                if (!prev && opts.anchor && q === 1 && last
                    && thereAndBack({ ...opts.anchor, ms: 0 }, { x: last[0], y: last[1], ms: gaps[0] }, { x: x + ox, y: y + oy, ms: gaps[0] + gg }))
                    break;
                // (a stream flows: never sharply back between quick notes, and a note turning against the way the stream
                // is spinning, between two turning with it, costs; see streamTurn)
                if (back && lastGap > 0) {
                    const tn = streamTurn({ x: back[0], y: back[1], ms: 0 }, { x: last[0], y: last[1], ms: lastGap }, { x: x + ox, y: y + oy, ms: lastGap + gg }, opts.quantum ? 100 : 160);
                    if (tn !== null && Math.abs(tn) >= 120)
                        break;
                    if (tn === null)
                        turnA = turnB = 0;
                    else if (Math.abs(tn) >= 30) {
                        if (turnA === Math.sign(tn) && turnB === -turnA)
                            kinks++;
                        turnA = turnB;
                        turnB = Math.sign(tn);
                    }
                }
                logSum += r;
                cost += dev;
                recent.push([x + ox, y + oy]);
                if (!opts.quantum && recent.length >= 2) {
                    const st = ringStep(recent[recent.length - 2], recent[recent.length - 1]);
                    if (st && (st === ringDir || !ringRun)) {
                        ringRun++;
                        ringDir = st;
                        if (ringRun > 3)
                            ringOver++;
                    } else {
                        ringRun = st ? 1 : 0;
                        ringDir = st;
                    }
                }
                // how the cursor's velocity changes through here, at the new timing
                if (recent.length >= 3 && lastGap > 0) {
                    const [a, b, c] = recent.slice(-3);
                    rough += velocityChange({ x: a[0], y: a[1], ms: 0 }, { x: b[0], y: b[1], ms: lastGap }, { x: c[0], y: c[1], ms: lastGap + gg });
                    roughN++;
                    // (quantum: quick steady notes that keep turning sharply, small, scribble on one spot instead of
                    // flowing; human quantum maps curve through them)
                    if (opts.quantum && gg >= 25 && gg <= 75 && Math.abs(gg - lastGap) <= 0.2 * gg) {
                        const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
                        const m1 = Math.hypot(ux, uy), m2 = Math.hypot(vx, vy);
                        if (m1 > 0.05 && m2 > 0.05 && m1 < 1.2 && m2 < 1.2 && (ux * vx + uy * vy) / (m1 * m2) <= -0.17)
                            scribble++;
                    }
                }
                if (opts.quantum && !ball && recent.length >= 8) {
                    const last8 = recent.slice(-8);
                    const xs = last8.map(v => v[0]), ys = last8.map(v => v[1]);
                    if (Math.max(...xs) - Math.min(...xs) <= 1.2 && Math.max(...ys) - Math.min(...ys) <= 1.2)
                        ball = 1;
                }
                lastGap = gg;
                if (recent.length >= 4) {
                    const m = recent.length;
                    const w0 = recent[m - 4], w1 = recent[m - 3], w2 = recent[m - 2], w3 = recent[m - 1];
                    const x0 = Math.min(w0[0], w1[0], w2[0], w3[0]), x1 = Math.max(w0[0], w1[0], w2[0], w3[0]);
                    const y0 = Math.min(w0[1], w1[1], w2[1], w3[1]), y1 = Math.max(w0[1], w1[1], w2[1], w3[1]);
                    if (x1 - x0 <= 1.001 && y1 - y0 <= 1.001 && new Set([w0.join(','), w1.join(','), w2.join(','), w3.join(',')]).size === 4
                        && [w0, w1, w2, w3].every(w => isWhole(w[0]) && isWhole(w[1])))
                        spins++;
                }
                dist += move;
                // (each move about as big as its own gap allows: a note after a longer gap a bigger move, one after a
                // shorter gap a smaller one, so the cursor keeps about the same speed through rhythm changes; and
                // notes far enough apart in time are jumps across the grid, as in every human map, see moveFor)
                const want = moveFor(J * Math.min(2.5, Math.max(0.5, Math.pow(gg / gm, opts.beta ?? 0.8))), gg, opts, opts.fast ? opts.fast[q] : 0,
                    q ? gaps[q - 1] : prev && prev2 ? prev.ms - prev2.ms : 0, q + 1 < gaps.length ? gaps[q + 1] : 0,
                    opts.weak && opts.patterns === 'jumps' && !opts.quantum ? opts.weak[q] : 0);
                sized += Math.abs(Math.log((move + 0.15) / (want + 0.15)));
                // (a big jump on a jump part's weak beat, where a short one is wanted: the big ones belong on the strong)
                if (want < 1.5 && move >= 1.9 && opts.weak && opts.weak[q] && opts.patterns === 'jumps')
                    bigOnWeak++;
                // (and short ones a couple at a time, between big ones: a long row of them is a slow stream, not jumps)
                if (opts.patterns === 'jumps' && !opts.quantum && gg >= (opts.jumpGap || 100)) {
                    lastShort = move < 1.5 ? lastShort + 1 : 0;
                    if (lastShort >= 3)
                        shortRow++;
                }
                wanted += want;
                // (a step where a jump is wanted: a steady run of notes far enough apart to jump between, crawled a
                // cell at a time, is what makes auto maps feel too smooth)
                if (!opts.quantum && want >= 1.35 && move < 1.2)
                    under++;
                if (move > Math.max(1.5, 2.1 * want) || move / Math.max(gg, 1) * 1000 > vmax)
                    spikes++;
                // (quantum: only clearly off the grid counts; a learned run stops at its third note in a row that
                // sits just off a grid cell, above: a stretch of those is the shifted 3x3 look, not quantum)
                if (opts.quantum ? !nearGrid(x + ox, y + oy) : realQuantum(x + ox, y + oy))
                    off++;

                // (quantum maps never step half a cell along the grid lines with right-angle corners)
                else if (opts.quantum && last && !realQuantum(last[0], last[1]) && (Math.abs(x + ox - last[0]) < 1e-3 || Math.abs(y + oy - last[1]) < 1e-3)
                    && Math.abs(Math.hypot(x + ox - last[0], y + oy - last[1]) - 0.5) < 1e-3)
                    lattice++;
                used_len++;
            }
            if (used_len < Math.min(opts.loose ? 1 : 3, gaps.length))
                return;
            // (what's added up so far is per note, how far the rhythm strays; what comes next is for the run as a
            // whole, already per note where it should be)
            const rhythm = cost;
            cost = 0;
            // awkward spots in it (and where it joins on): a lone sharp turn in a flowing line, a lone wide turn in a
            // zigzag, the spacing jumping while the rhythm doesn't (quantum maps use lone sharp turns on purpose)
            if (opts.recentNotes) {
                const pts = opts.recentNotes.slice();
                let ms = pts.length ? pts[pts.length - 1].ms : 0;
                const base = [prev2, prev].filter(Boolean).length;
                for (let q = 0; q + base < recent.length; q++) {
                    ms += gaps[q];
                    pts.push({ x: recent[q + base][0], y: recent[q + base][1], ms });
                }
                const aw = awkward(pts, opts.recentNotes.length);
                // (quantum maps make lone sharp turns on purpose, but not at stream speed)
                cost += ((opts.quantum && gm >= 70 ? 1.5 : 6) * aw.flowBreak + 3 * aw.snapBreak + (opts.quantum ? 1.5 : 4) * aw.spacingJump) / used_len;
                // time and distance: jump-timed notes are real jumps, the speed stays even, jumps spin like a star
                const tm = timing(pts, opts.recentNotes.length, opts);
                cost += (3 * tm.smallJump - 0.6 * tm.bigJump + 2.5 * tm.speedJump + 1.5 * tm.rightJump + 0.8 * tm.spinFlip + 2.5 * tm.tooFast) / used_len;
                // (a run usually starts just where the rhythm slows from quick notes to a jump: its first move is that
                // jump, so it has to be one)
                const rn = opts.recentNotes, k0 = rn.length;
                if (k0 >= 2 && pts.length > k0) {
                    const quick = Math.max(20, Math.min(...rn.slice(1).map((nt, q) => nt.ms - rn[q].ms).filter(g => g > 5), gaps[1] || Infinity));
                    const d0 = Math.hypot(pts[k0].x - rn[k0 - 1].x, pts[k0].y - rn[k0 - 1].y);
                    if (gaps[0] >= 1.6 * quick && gaps[0] < 400 && d0 > 0.05 && d0 < Math.min(1.45, 0.75 * reach(gaps[0], quick, opts)))
                        cost += 1.2;
                }
            }
            // the same loop round and round again gets dull
            if (opts.recentPts) {
                const seq = opts.recentPts.concat(recent.slice([prev2, prev].filter(Boolean).length));
                const tol = opts.quantum ? 0.3 : 1e-3;
                const laps = lapCount(seq, opts.recentPts.length, tol) / used_len;
                // (a stream on the grid may go round the outside a lap or two, as human stream maps spin)
                cost += (1 + 2 * variety) * Math.max(0, laps - (opts.quantum ? LAPS_OK : 0.35));
                // (and much more once it has been going round for a while: a loop or two is fine, ten aren't)
                cost += 0.08 * Math.max(0, lapStreak(seq, tol) - (opts.quantum ? 12 : 12));
                // (quantum: a circle that drifts round and round, lap after lap, for seconds; human quantum maps go
                // round one at most and then break out of it with a jump)
                if (opts.quantum)
                    cost += 0.08 * Math.max(0, turnStreak(seq) - 16);
            }
            // variety: the same shape as was just placed (going round the same loop again and again) gets dull
            if (opts.history && recent.length >= 6) {
                let seen = 0, total = 0;
                for (let j = 6; j <= recent.length; j++) {
                    total++;
                    if (opts.history.has(recent.slice(j - 6, j).map(v => v.join(',')).join(' ')))
                        seen++;
                }
                cost += (0.1 + 2.2 * variety) * seen / total;
            }
            // and the same shape again, turned or mirrored, from anywhere earlier in the map: a figure now and then
            // keeps it consistent, the same few over and over is copy and paste
            if (opts.shapes && recent.length >= 7) {
                let seen = 0, total = 0;
                for (let j = 6; j < recent.length; j++) {
                    total++;
                    const c = opts.shapes.get(shapeKey(recent, j));
                    if (c)
                        seen += Math.min(3, c);
                }
                cost += (0.1 + 0.5 * variety) * seen / total;
            }
            const scale = logSum / used_len;
            if (!opts.loose && (scale > Math.log(5) || scale < Math.log(0.6)))
                return;
            // (and every run costs a little for the join it makes: one long run flows better than many short ones)
            cost += rhythm / used_len * 1.5 + 0.12 * Math.abs(scale) * (0.5 + follow) + 1.6 / used_len;
            // (and for stopping short of where the rhythm lets it go on: of thousands of short pieces one always fits a
            // little better by chance than the few long ones, and a map made of 3-note pieces has no flow)
            cost += 0.09 * Math.max(0, Math.min(10, gaps.length) - used_len);
            cost += 1.8 * spins / used_len + 1.2 * scribble / used_len + ball + 1.5 * under / used_len + 3 * kinks / used_len;
            // Spins round the outside of the grid: a half lap is a flourish, lap after lap of them (copied from a
            // spinning map, or made) is the same thing over and over; and more so the more the map has spun lately
            cost += (0.5 + 4 * Math.max(0, (opts.spinShare || 0) - 0.12)) * ringOver / used_len;
            // Flow: no rougher than the learned maps (at 100%, a fair bit smoother)
            if (model && roughN)
                cost += 2.4 * flow * Math.max(0, rough / roughN - model.change * (1.2 - 0.45 * flow));
            // steady difficulty: moves about as big as wanted here, without sudden far jumps
            // (much more so when Jump Size or Patterns ask for bigger or smaller moves than the maps make)
            cost += 1.5 * bigOnWeak / used_len + 1.5 * shortRow / used_len;
            cost += (opts.sizeWeight || 1.5) * (0.5 * Math.abs(Math.log((dist / used_len + 0.15) / (wanted / used_len + 0.15))) + 0.5 * sized / used_len)
                + 1.5 * spikes / used_len;
            // flow: carries on the way the map it comes from did before this point...
            const [fx, fy] = f(e.x[i + 1], e.y[i + 1]);
            if (prev2 && i > 0) {
                const [px, py] = f(e.x[i - 1], e.y[i - 1]);
                const [cx, cy] = f(e.x[i], e.y[i]);
                const v1 = [prev.x - prev2.x, prev.y - prev2.y], v2 = [cx - px, cy - py];
                const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
                if (l1 > 1e-3 && l2 > 1e-3)
                    cost += (0.15 + 0.5 * flow) * (1 - (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)) + (0.08 + 0.15 * flow) * Math.abs(Math.log(l1 / l2));
                else if ((l1 > 1e-3) !== (l2 > 1e-3))
                    cost += 0.3;
                // ...and the turn it makes here is one the learned maps make often at this move size
                if (model) {
                    const v3 = [fx + ox - prev.x, fy + oy - prev.y], l3 = Math.hypot(...v3);
                    if (l1 > 0.05 && l3 > 0.05)
                        cost += flow * 0.3 * model.turnCost(v1, v3, l3);
                }
            }
            cost += (0.15 + 0.4 * follow) * Math.hypot(ox, oy);
            const usedBefore = used.get(e);
            if (usedBefore && usedBefore.some(u => Math.abs(u - i) < 24))
                cost += 0.05 + 1.3 * variety;
            // Emphasis: the bigger moves land on the stronger sounds (a kick or snare gets a jump, the notes between
            // move less), like human maps do
            if (opts.acc && used_len >= 3) {
                const base = [prev2, prev].filter(Boolean).length;
                const moves = [], accs = [];
                for (let q = 0; q < used_len; q++) {
                    const a = recent[base + q - 1], b = recent[base + q];
                    if (!a || !b)
                        continue;
                    moves.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
                    accs.push(opts.acc[q] || 0);
                }
                const mm = moves.reduce((p, q) => p + q, 0) / Math.max(1, moves.length), ma = accs.reduce((p, q) => p + q, 0) / Math.max(1, accs.length);
                if (mm > 0.05) {
                    let align = 0;
                    for (let q = 0; q < moves.length; q++)
                        align += (accs[q] - ma) * (moves[q] / mm - 1);
                    // (most in quantum maps, whose jumps land on the hits; least in jump maps, which jump on
                    // every beat anyway and show the music by their rhythm)
                    cost -= (opts.quantum ? 1.6 : opts.patterns === 'jumps' ? 0.4 : 0.8) * align / moves.length;
                }
            }
            // Turns on the strong sounds: a stream changes direction (turns, or starts spinning the other way) where
            // the music hits, so its shape follows the song
            if (opts.acc && used_len >= 4) {
                const base = [prev2, prev].filter(Boolean).length;
                const ts = [], accs = [];
                let sgn = 0;
                for (let q = 0; q + 1 < used_len; q++) {
                    const a = recent[base + q - 1], b = recent[base + q], c = recent[base + q + 1];
                    const tn = a && b && c ? streamTurn({ x: a[0], y: a[1], ms: 0 }, { x: b[0], y: b[1], ms: gaps[q] }, { x: c[0], y: c[1], ms: gaps[q] + gaps[q + 1] }, opts.quantum ? 100 : 160) : null;
                    if (tn === null) {
                        sgn = 0;
                        continue;
                    }
                    const big = Math.abs(tn) >= 30, flip = big && sgn && Math.sign(tn) !== sgn;
                    if (big)
                        sgn = Math.sign(tn);
                    ts.push(Math.abs(tn) / 90 + (flip ? 1 : 0));
                    accs.push(opts.acc[q] || 0);
                }
                if (ts.length >= 3) {
                    const mt = ts.reduce((p, q) => p + q, 0) / ts.length, ma = accs.reduce((p, q) => p + q, 0) / accs.length;
                    let align = 0;
                    for (let q = 0; q < ts.length; q++)
                        align += (accs[q] - ma) * (ts[q] - mt);
                    cost -= 2 * align / ts.length;
                }
            }
            cost -= e.bonus || 0;
            // (an example map that came with the editor, where it has learned maps of its own: those first)
            cost += e.penalty || 0;
            cost -= 0.006 * used_len;
            // Quantum: real quantum patterns (from quantum maps, or quantum slides and jumps made for here) are
            // wanted over notes on the grid
            // (with a learned design: as much off the grid as it is, over the last notes and this run together, not
            // as much as possible)
            if (opts.quantum && opts.qp) {
                const before = (opts.recentPts || []).filter(([px, py]) => realQuantum(px, py)).length, had = (opts.recentPts || []).length;
                cost += 1.6 * Math.abs((before + off) / Math.max(1, had + used_len) - opts.qp.off) - 0.4;
            }
            if (opts.quantum)
                cost -= (opts.qp ? 0 : QUANTUM_WANT * off / used_len) - 1.2 * lattice / used_len - (e.made ? (opts.qp ? 0.1 : MADE_COST) + e.extra + (opts.lastName === e.name ? 0.4 : 0) : opts.qp ? 0.15 : 0);
            else if (e.made)
                // (laps round the outside are what a stream on the grid is wanted to do: one plan, turning with the
                // song, rather than pieces of the learned maps one after another)
                cost += (e.name === 'stream ring' ? -(opts.ringWant ?? RING_WANT) : e.name === 'stream reverse' ? 0.8 : 0.15) + (opts.lastName === e.name ? 0.3 : 0)
                    // (the shape the sounds here call for, see soundStyle in generate)
                    - (opts.soundStyle && e.name === `stream ${opts.soundStyle}` ? 0.3 : 0);
            // keeps to one map's design rather than hopping between maps; at a change in the music (a new section,
            // a drop bringing in something new) it does the opposite and starts a new pattern
            // (quantum with a learned design: a figure from a learned map never carries straight on from the last one
            // taken from it, which would be copying a stretch of it a few notes at a time)
            if (opts.quantum && opts.qp && !e.made && opts.lastEntry === (e.source || e) && Math.abs((e.srcI ?? i) - opts.lastEnd) < 12)
                cost += 0.8;
            // (nor on the grid: the same map's design again is fine, the next notes of it straight on are a copy)
            else if (!opts.quantum && !e.made && !e.bonus && opts.lastEntry === e && Math.abs(i - opts.lastEnd) < 12)
                cost += 0.5;
            else if (opts.lastEntry === e) {
                if (opts.fresh)
                    cost += Math.abs(i - opts.lastEnd) < 64 ? 0.5 : 0.1;
                else
                    cost -= 0.18 * (0.5 + follow);
            }
            // The join itself, once for the run whatever its length: the two turns it makes (onto the run's first
            // note and on to its second) no sharper or jerkier than the map it comes from made there (or than
            // flowing maps do, for a made-up run), and no sudden change of speed where the rhythm stays even
            if (prev && prev2 && used_len >= 2) {
                const base = 2, F0 = { x: recent[base][0], y: recent[base][1], ms: prev.ms + gaps[0] };
                const F1 = { x: recent[base + 1][0], y: recent[base + 1][1], ms: F0.ms + gaps[1] };
                const ref = model ? model.change * (1.2 - 0.45 * flow) : 0.6;
                const src = q => ({ x: e.x[q], y: e.y[q], ms: e.t[q] });
                const s0 = !e.made && i >= 1 && i + 1 < e.n ? Math.max(ref, velocityChange(src(i - 1), src(i), src(i + 1))) : ref;
                const s1 = !e.made && i + 2 < e.n ? Math.max(ref, velocityChange(src(i), src(i + 1), src(i + 2))) : ref;
                cost += flow * (2 * Math.max(0, velocityChange(prev2, prev, F0) - s0) + Math.max(0, velocityChange(prev, F0, F1) - s1));
                const gIn = prev.ms - prev2.ms, dIn = Math.hypot(prev.x - prev2.x, prev.y - prev2.y), d0 = Math.hypot(F0.x - prev.x, F0.y - prev.y);
                if (gIn > 0 && dIn > 0.05 && d0 > 0.05) {
                    const even = Math.max(gIn, gaps[0]) < 1.3 * Math.min(gIn, gaps[0]);
                    cost += 1.5 * (even ? 1 : 0.3) * Math.max(0, Math.abs(Math.log((d0 / gaps[0]) / (dIn / gIn))) - Math.log(1.4));
                }
                // (and no jumping straight back where the note before came from, A to B to A, at speed)
                if (d0 >= 1.5 && gaps[0] < 150 && Math.hypot(F0.x - prev2.x, F0.y - prev2.y) < 0.35)
                    cost += 2.5;
                // (a stream after a jump hooks off it, about a right angle, rather than heading back the way it came)
                if (!opts.quantum && dIn >= 1.9 && d0 > 0.05 && d0 < 1.5) {
                    const turn = Math.acos(Math.max(-1, Math.min(1, ((prev.x - prev2.x) * (F0.x - prev.x) + (prev.y - prev2.y) * (F0.y - prev.y)) / (dIn * d0)))) * 180 / Math.PI;
                    if (turn > 135)
                        cost += 1 + 1.5 * (turn - 135) / 45;
                }
            }
            if (opts.fresh && opts.lastK === k)
                cost += 0.12;
            candidates.push({ e, k, i, ox, oy, len: used_len, cost });
        };

        const sample = (list, max) => {
            if (list.length <= max)
                return list;
            const out = [];
            for (let s = 0; s < max; s++)
                out.push(list[Math.floor(Math.random() * list.length)]);
            return out;
        };

        // A fixed number of places to try per run however many maps were learned (it used to try every map, which with
        // a big library took minutes and froze the page). Each map gets a share by how much of it starts here; the
        // map being made always gets a good look.
        if (prev) {
            const pools = [];
            let total = 0;
            for (const e of lib)
                for (let k = 0; k < 8; k++) {
                    const [lx, ly] = SYM[INV[k]](prev.x, prev.y);
                    const list = e.at.get(posKey(lx, ly));
                    if (list) {
                        pools.push({ e, k, list });
                        total += list.length;
                    }
                }
            const share = Math.min(1, SEARCH / Math.max(1, total));
            for (const { e, k, list } of pools) {
                let take = list.length * share;
                take = e.bonus ? Math.max(take, Math.min(list.length, 260)) : Math.floor(take) + (Math.random() < take % 1 ? 1 : 0);
                for (const i of sample(list, take))
                    consider(e, k, i, 0, 0);
            }
            // nothing starts exactly here (a spot the maps never use): a run moved over to it by whole cells. Never by
            // part of a cell: that only gives a grid pattern sitting off the grid, which isn't quantum mapping.
            if (candidates.length < 6)
                for (let s = 0; s < Math.min(SEARCH, 120 * lib.length); s++) {
                    const e = lib[Math.floor(Math.random() * lib.length)];
                    const i = Math.floor(Math.random() * (e.n - 2));
                    const k = Math.floor(Math.random() * 8);
                    const [x, y] = SYM[k](e.x[i], e.y[i]);
                    const ox = prev.x - x, oy = prev.y - y;
                    if (isWhole(ox) && isWhole(oy))
                        consider(e, k, i, Math.round(ox), Math.round(oy));
                }
        } else
            for (let s = 0; s < Math.min(SEARCH, 300 * lib.length); s++) {
                const e = lib[Math.floor(Math.random() * lib.length)];
                consider(e, Math.floor(Math.random() * 8), Math.floor(Math.random() * (e.n - 2)), 0, 0);
            }
        // In fast parts on the grid: stream shapes made for here, so it isn't the same loop round the outside every time
        if ((!opts.quantum || (opts.qp && opts.qp.quickOff < 0.5)) && prev && isWhole(prev.x) && isWhole(prev.y) && prev.x >= 0 && prev.x <= 2 && prev.y >= 0 && prev.y <= 2 && gaps.length >= 4) {
            const g = gaps.slice(1).sort((p, q) => p - q);
            // (not where a jump map wants jumps: notes far enough apart to jump between aren't a stream)
            if (g[g.length >> 1] < Math.min(95, opts.patterns === 'jumps' ? opts.jumpGap || 95 : 95))
                // (human streams never zigzag like stairs or turn right back at speed, so those shapes aren't offered;
                // laps round the outside only now and then: a lap after lap of them is what made auto maps samey. The
                // walks are new shapes made for here, from the sounds: see walkRun)
                {
                    const seed = opts.soundSeed ?? Math.floor(Math.random() * 1e9);
                    const kinds = ['ring', 'snake', 'cross', 'walk', 'walk', 'walk'];
                    if (opts.patterns !== 'streams')
                        kinds.push('star', 'star');
                    kinds.forEach((kind, z) => consider(kind === 'ring' ? ringRun(prev, prev2, gaps, opts.acc, opts.force && (opts.jumpScale || 1) >= 1.2 ? 2 : 1)
                        : kind === 'walk' || kind === 'star' ? walkRun(kind, prev, prev2, gaps, opts.acc, seed + 7919 * z) : streamRun(kind, prev, prev2, gaps), 0, 0, 0, 0));
                }
        }
        // Flow made for exactly this rhythm (see flowRun), on the grid, whatever the speed: no learned map's rhythm
        // to stray from, so it can go on as long as the rhythm does
        if (!opts.quantum && prev && isWhole(prev.x) && isWhole(prev.y) && prev.x >= 0 && prev.x <= 2 && prev.y >= 0 && prev.y <= 2 && gaps.length >= 3) {
            const wants = gaps.map((g, q) => moveFor(runJump * Math.min(2.5, Math.max(0.5, Math.pow(g / gm, opts.beta ?? 0.8))), g, opts, opts.fast ? opts.fast[q] : 0,
                q ? gaps[q - 1] : prev2 ? prev.ms - prev2.ms : 0, q + 1 < gaps.length ? gaps[q + 1] : 0, opts.weak && opts.patterns === 'jumps' ? opts.weak[q] : 0));
            const seed = (opts.soundSeed ?? Math.floor(Math.random() * 1e9)) + 104729;
            for (let z = 0; z < 3; z++)
                consider(flowRun(prev, prev2, gaps, wants, opts.acc, seed + 7919 * z), 0, 0, 0, 0);
        }
        // Similar to This Map: the notes of the part of the map that sounds like this one, from here on, turned or
        // mirrored any way, liked best (see similarParts)
        // (its notes in order, each on the note here nearest it in time: where there are more notes here, the next of
        // its notes; where fewer, some of its left out; so its shape is followed at this part's own rhythm)
        if (opts.prefer && prev) {
            const src = opts.prefer.pts.filter(pt => pt.ms > prev.ms - 20);
            const pts = [];
            let ms = prev.ms, from = 0;
            for (let q = 0; q < gaps.length && from < src.length; q++) {
                ms += gaps[q];
                let j = from;
                while (j + 1 < src.length && Math.abs(src[j + 1].ms - ms) <= Math.abs(src[j].ms - ms))
                    j++;
                pts.push({ ms, x: src[j].x, y: src[j].y });
                from = j + 1;
            }
            if (pts.length >= 2) {
                const n = pts.length + 1;
                const t = Float64Array.from([prev.ms, ...pts.map(pt => pt.ms)]);
                for (let k = 0; k < 8; k++) {
                    const x = new Float64Array(n), y = new Float64Array(n);
                    x[0] = prev.x;
                    y[0] = prev.y;
                    pts.forEach((pt, z) => [x[z + 1], y[z + 1]] = SYM[k](pt.x, pt.y));
                    consider({ name: 'similar part', x, y, t, n, quantum: !!opts.quantum, made: true, extra: 0, bonus: opts.prefer.bonus,
                        free: pts.some(pt => !isWhole(pt.x) || !isWhole(pt.y) || pt.x < 0 || pt.x > 2 || pt.y < 0 || pt.y > 2),
                        cleanUntil: new Int32Array(n).fill(n), wholeUntil: new Int32Array(n).fill(n) }, 0, 0, 0, 0);
                }
            }
        }
        // With the Quantum option: quantum parts of the learned maps, jumped into from here (quantum notes seldom
        // land exactly where a learned run starts), and quantum slides and jumps made for exactly this spot and rhythm
        if (opts.quantum) {
            const quantumMaps = opts.qlib || lib.filter(e => e.style && e.style.off >= 0.3);
            for (let s = 0; prev && quantumMaps.length && s < 160; s++) {
                const e = quantumMaps[Math.floor(Math.random() * quantumMaps.length)];
                const i = Math.floor(Math.random() * (e.n - 2));
                // (from its quantum spots, or as often as its own notes are on the grid, from those too)
                if (!nearGrid(e.x[i], e.y[i]) || (opts.qp && Math.random() > opts.qp.off))
                    consider(jumpInto(e, Math.floor(Math.random() * 8), i, prev, gaps), 0, 0, 0, 0);
            }
            const start = prev || opts.anchor || { x: 0.5 + Math.random() * 1.5, y: 0.5 + Math.random() * 1.5 };
            // (with real slides in the map, the notes between them are jumps, and big ones; each jump as big as its
            // own gap allows: quick notes, a stream's, are small quantum steps, never full jumps at stream speed)
            // (and smaller in calm parts, like any jumps there)
            const big = (opts.slidesOn ? Math.max(1.6, 1.5 * runJump) : runJump) * Math.max(0.9, opts.calm ?? 1);
            // (a quick note's step grows with its gap and the difficulty: about a cell for a 1/8 at 124 BPM at 9, half
            // that for a 1/16; a fixed small step made streams crawl)
            const stepSpeed = 0.7 * Math.min(32, 4 + 0.45 * (vmax || 30));
            // (only notes under 60ms apart: from there on, human quantum maps jump on every note, their slides
            // being the stream)
            const quickAt = q => {
                const g = gaps[q], fast = opts.fast ? opts.fast[q] : 0;
                return fast > 0 && g < 1.3 * fast && g < Math.min(60, opts.jumpGap || 70);
            };
            const sizeOf = q => {
                const g = gaps[q], fast = opts.fast ? opts.fast[q] : 0;
                if (quickAt(q))
                    return Math.min(reach(g, fast, opts), Math.min(opts.force ? 1.3 * (opts.jumpScale || 1) : 1.3, Math.max(0.45, stepSpeed * (opts.force ? opts.jumpScale || 1 : 1) * g / 1000)));
                return moveFor(big * Math.min(2.5, Math.max(0.5, Math.pow(g / gm, 0.8))), g, { ...opts, calm: Math.max(0.9, opts.calm ?? 1) }, fast);
            };
            // (a made-up slide only through really quick notes: from about 45ms apart quantum maps jump on every
            // note, and a slide there is a crawl)
            const quick = gm < 45;
            // (a stream of tiny quantum steps as often as the design's quick notes are off the grid; otherwise its
            // streams are the grid's, above)
            // (none when a star rating is being forced past what the song gives: tiny steps add next to nothing to it)
            const slideOk = quick && !opts.force && (!opts.qp || Math.random() < opts.qp.quickOff);
            for (let s = 0; s < 4; s++) {
                if (slideOk)
                    consider(quantumRun('slide', start, prev2, gaps, opts.jump, null, null, opts.qp), 0, 0, 0, 0);
                consider(quantumRun('jumps', start, prev2, gaps, big, sizeOf, quickAt, opts.qp), 0, 0, 0, 0);
            }
        }

        if (!candidates.length)
            return null;

        candidates.sort((p, q) => p.cost - q.cost);
        // (low Variety keeps to the very best fits, which repeat; high picks more freely among good ones)
        const top = candidates.slice(0, 1 + Math.round(variety * 11));
        const weights = top.map(c => Math.exp(-(c.cost - top[0].cost) / (0.015 + 0.14 * variety)));
        let r = Math.random() * weights.reduce((p, q) => p + q, 0);
        for (let j = 0; j < top.length; j++) {
            r -= weights[j];
            if (r <= 0)
                return top[j];
        }
        return top[0];
    }

    // How a player's cursor has to change velocity from one move to the next: 0 = straight on at the same speed,
    // 1 = a full reversal. It doesn't depend on the map's speed, so maps of any density compare.
    function velocityChange(a, b, c) {
        const t1 = Math.max(b.ms - a.ms, 1), t2 = Math.max(c.ms - b.ms, 1);
        const v1 = [(b.x - a.x) / t1, (b.y - a.y) / t1], v2 = [(c.x - b.x) / t2, (c.y - b.y) / t2];
        const s = Math.hypot(...v1) + Math.hypot(...v2);
        return s < 1e-9 ? 0 : Math.hypot(v2[0] - v1[0], v2[1] - v1[1]) / s;
    }

    // What the learned maps are like to play: how often they turn by each angle for each size of move, their usual
    // move size, and how smoothly the cursor travels through them
    function flowModel(lib) {
        const BINS = 12, SIZES = [0.8, 1.6, Infinity];
        const hist = SIZES.map(() => new Float64Array(BINS).fill(1));
        const moves = [];
        let change = 0, changes = 0;
        for (const e of lib) {
            const n = Math.min(e.n, Math.max(400, Math.floor(60000 / lib.length)));
            for (let i = 1; i + 1 < n; i++) {
                const ax = e.x[i] - e.x[i - 1], ay = e.y[i] - e.y[i - 1], bx = e.x[i + 1] - e.x[i], by = e.y[i + 1] - e.y[i];
                const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
                if (lb > 0.05)
                    moves.push(lb);
                if (la > 0.05 && lb > 0.05) {
                    const ang = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
                    hist[SIZES.findIndex(s => lb < s)][Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS))]++;
                }
                change += velocityChange({ x: e.x[i - 1], y: e.y[i - 1], ms: e.t[i - 1] }, { x: e.x[i], y: e.y[i], ms: e.t[i] },
                    { x: e.x[i + 1], y: e.y[i + 1], ms: e.t[i + 1] });
                changes++;
            }
        }
        const logp = hist.map(h => {
            const total = h.reduce((p, q) => p + q, 0), max = Math.max(...h);
            return Array.from(h, v => Math.log(max / v) / Math.log(BINS));
        });
        moves.sort((p, q) => p - q);
        return {
            // 0 for the turn the maps make most at this move size, towards 1 (or more) for turns they never make
            turnCost(v1, v2, size) {
                const l1 = Math.hypot(...v1), l2 = Math.hypot(...v2);
                const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2))));
                return logp[SIZES.findIndex(s => size < s)][Math.min(BINS - 1, Math.floor(ang / Math.PI * BINS))];
            },
            move: moves.length ? moves[Math.floor(moves.length / 2)] : 1,
            change: changes ? change / changes : 0.5,
        };
    }

    // Places notes at `times` by copying runs from the library. jumpAt(ms): the average move wanted there.
    async function place(times, lib, opts, jumpAt) {
        const out = [];
        const yieldNow = opts.yieldNow || (async () => { });
        const before = (opts.before || []).slice(-2);
        let prev = before.length ? before[before.length - 1] : null;
        let prev2 = before.length > 1 ? before[0] : null;
        // (which notes are quantum: all of them with Quantum at 100%, else those in the parts picked for it)
        const qAtI = q => opts.qAt ? opts.qAt(times[Math.min(times.length - 1, q)]) : !!opts.quantum;
        if (prev && !qAtI(0) && (!isWhole(prev.x) || !isWhole(prev.y)))
            prev = { x: Math.min(2, Math.max(0, Math.round(prev.x))), y: Math.min(2, Math.max(0, Math.round(prev.y))), ms: prev.ms };
        const used = new Map();
        const history = new Set();
        // every shape of 6 moves placed so far (see shapeKey), with how often; the last 12 notes' aren't counted
        // yet (a run carrying straight on isn't a copy of itself)
        const shapes = new Map();
        let shapesTo = 6;
        const rememberShapes = () => {
            const upTo = out.length - 12;
            if (upTo <= shapesTo)
                return;
            const pts = out.slice(Math.max(0, shapesTo - 6), upTo).map(nt => [nt.x, nt.y]);
            const off = Math.max(0, shapesTo - 6);
            for (let j = Math.max(6, shapesTo) - off; j < pts.length; j++) {
                const k = shapeKey(pts, j);
                shapes.set(k, (shapes.get(k) || 0) + 1);
            }
            shapesTo = upTo;
        };
        const remember = () => {
            history.clear();
            const tail = out.slice(-64).map(n => `${n.x},${n.y}`);
            for (let j = 6; j <= tail.length; j++)
                history.add(tail.slice(j - 6, j).join(' '));
        };
        let i = 0;
        let lastRun = null;

        // Bars that repeat an earlier bar's sound (and so its rhythm, see chooseTimes) mostly get that bar's pattern
        // again, turned or mirrored: a different way from last time, or the same way as the bar before when a whole
        // phrase is coming round again (so it flows from bar to bar like it did the first time). That keeps the map to
        // a plan. Bars that only sound alike, with the same rhythm, do it less often (human maps bring a bar's pattern
        // back for about a quarter to a third of the bars whose rhythm comes back). The more Variety, the less often
        // it copies.
        const bars = opts.bars || [];
        const barOf = new Int32Array(times.length).fill(-1);
        const firstOf = bars.map(() => -1), countOf = bars.map(() => 0);
        for (let q = 0, j = 0; q < times.length && bars.length; q++) {
            while (j + 1 < bars.length && bars[j + 1].from - 20 <= times[q])
                j++;
            barOf[q] = j;
            if (firstOf[j] < 0)
                firstOf[j] = q;
            countOf[j]++;
        }
        const placedIn = bars.map(() => []);
        const variety = (opts.runOptions && opts.runOptions.variety) ?? 0.5;
        const copyFrom = bars.map(() => -1);
        bars.forEach((b, j) => {
            // (less often than it used to: a bar copied over and over reads as copy and paste; repeats now and then
            // keep it consistent)
            for (const [p, chance] of [[b.proto, 0.6 - 0.45 * variety], [b.like ?? -1, 0.3 - 0.25 * variety]]) {
                if (p < 0 || p >= j || !countOf[j] || countOf[j] !== countOf[p])
                    continue;
                let same = true;
                for (let q = 0; same && q < countOf[j]; q++)
                    same = Math.abs((times[firstOf[j] + q] - b.from) - (times[firstOf[p] + q] - bars[p].from)) <= 25;
                if (!same)
                    continue;
                // (a phrase already being copied bar by bar carries on, mostly; the same one bar again and again, as a
                // loop-based song plays it, only now and then: a whole drop of one bar turned round gets dull)
                // (and a phrase is copied at most 4 bars on end; the more often a bar has come back already, the
                // less often it's copied again)
                let run = 0;
                while (run < j && copyFrom[j - 1 - run] >= 0 && copyFrom[j - 1 - run] === p - 1 - run)
                    run++;
                // (a bar copied from the one just before it is a one-bar loop going round, not a phrase coming back)
                const phrase = run > 0 && run < 4 && p < j - 1;
                let again = 0, before = 0;
                for (let q = Math.max(0, j - 3); q < j; q++)
                    if (copyFrom[q] === p)
                        again++;
                for (let q = 0; q < j; q++)
                    if (copyFrom[q] === p)
                        before++;
                if (Math.random() < (phrase ? 0.85 : (again >= 2 ? 0.3 : 1) * Math.pow(0.8, before) * chance))
                    copyFrom[j] = p;
                break;
            }
        });
        const copyStarts = bars.map((b, j) => copyFrom[j] >= 0 ? firstOf[j] : -1).filter(q => q >= 0);
        const copied = bars.map(() => null);
        const locked = new Uint8Array(times.length);
        const turn = reorienter(times, opts);
        // The best way to turn or mirror a set of points (base: [x, y] for the notes from times[i] on) so it joins on
        // to the notes before; extra(k): what else each way costs. Null if no way can be played.
        const fitAt = (base, qi, extra) => {
            const J = jumpAt(times[i]), flow = (opts.runOptions && opts.runOptions.flow) ?? 0.7;
            let best = null;
            for (let k = 0; k < 8; k++) {
                const pos = base.map(([bx, by]) => SYM[k](bx, by));
                let cost = 0.3 * Math.random() + extra(k);
                if (prev) {
                    const [x0, y0] = pos[0];
                    const d0 = Math.hypot(x0 - prev.x, y0 - prev.y), g0 = Math.max(1, times[i] - prev.ms);
                    // never the same spot twice, nor a move too fast or a turn too hard to play
                    if (d0 < 0.05 || d0 / g0 * 1000 > opts.speedCap)
                        continue;
                    if (prev2 && prev.ms - prev2.ms >= 3) {
                        const t1 = (prev.ms - prev2.ms) / 1000, t2 = g0 / 1000;
                        const ax = (x0 - prev.x) / t2 - (prev.x - prev2.x) / t1, ay = (y0 - prev.y) / t2 - (prev.y - prev2.y) / t1;
                        if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > opts.accelCap)
                            continue;
                        const v1 = [prev.x - prev2.x, prev.y - prev2.y], v2 = [x0 - prev.x, y0 - prev.y];
                        const l1 = Math.hypot(...v1);
                        if (l1 > 0.05)
                            cost += 0.6 * flow * (1 - (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * d0)) / 2;
                    }
                    const want = opts.sizeAt ? opts.sizeAt(i, g0) : J;
                    // (a stream's quick notes join on a cell at a time, not with a skip of two cells)
                    if (!qi && g0 < 70 && d0 > 1.5 * Math.max(want, 1))
                        continue;
                    cost += Math.abs(Math.log((d0 + 0.15) / (want + 0.15)));
                }
                // (a bar going round a loop comes back mirrored, going round the other way, rather than as more laps)
                const before = out.slice(-12).map(nt => [nt.x, nt.y]);
                cost += 2 * Math.max(0, lapCount(before.concat(pos), before.length, qi ? 0.3 : 1e-3) / pos.length - LAPS_OK);
                if (qi)
                    cost += 0.08 * Math.max(0, turnStreak(out.slice(-24).map(nt => [nt.x, nt.y]).concat(pos)) - 16);
                // (and no awkward spot where it joins on)
                const tail = out.slice(-4);
                const joined = tail.concat(pos.map(([px, py], q) => ({ x: px, y: py, ms: times[i + q] })));
                const aw = awkward(joined, tail.length), tm = timing(joined, tail.length, opts.runOptions);
                cost += ((qi ? 0.5 : 2) * aw.flowBreak + aw.snapBreak + 0.7 * aw.spacingJump
                    + tm.smallJump + 0.4 * tm.speedJump + 0.5 * tm.rightJump + tm.tooFast) / Math.max(4, pos.length) * 4;
                // The join, both turns of it (onto the copy's first note and on to its second), played like any other
                // two moves: not turning harder than the difficulty allows, no sudden change of speed or direction
                // beyond what flowing maps do, and no snapping straight back at speed unless the notes before were
                // doing just that (a zigzag of jumps)
                const T0 = prev && streamTurn(prev2, prev, { x: pos[0][0], y: pos[0][1], ms: times[i] }, qi ? 100 : 160);
                if (prev && (thereAndBack(prev2, prev, { x: pos[0][0], y: pos[0][1], ms: times[i] }) || (T0 !== null && Math.abs(T0) >= 120)))
                    continue;
                if (prev && pos.length >= 2) {
                    const P0 = { x: pos[0][0], y: pos[0][1], ms: times[i] }, P1 = { x: pos[1][0], y: pos[1][1], ms: times[i + 1] };
                    const T1 = streamTurn(prev, P0, P1, qi ? 100 : 160);
                    if (thereAndBack(prev, P0, P1) || (T1 !== null && Math.abs(T1) >= 120))
                        continue;
                    const t1 = (P0.ms - prev.ms) / 1000, t2 = (P1.ms - P0.ms) / 1000;
                    if (t1 > 0 && t2 > 0) {
                        const ax = (P1.x - P0.x) / t2 - (P0.x - prev.x) / t1, ay = (P1.y - P0.y) / t2 - (P0.y - prev.y) / t1;
                        if (Math.hypot(ax, ay) / ((t1 + t2) / 2) > opts.accelCap)
                            continue;
                    }
                    cost += 3 * flow * Math.max(0, velocityChange(prev, P0, P1) - 0.75);
                    if (prev2) {
                        cost += 3 * flow * Math.max(0, velocityChange(prev2, prev, P0) - 0.75);
                        // (a jump back onto the note before last, A to B to A)
                        if (Math.hypot(P0.x - prev.x, P0.y - prev.y) >= 1.5 && Math.hypot(P0.x - prev2.x, P0.y - prev2.y) < 0.35)
                            cost += 1.5;
                    }
                    const m1x = P0.x - prev.x, m1y = P0.y - prev.y, m2x = P1.x - P0.x, m2y = P1.y - P0.y;
                    const l1 = Math.hypot(m1x, m1y), l2 = Math.hypot(m2x, m2y);
                    if (l1 > 0.9 && l2 > 0.9 && (m1x * m2x + m1y * m2y) / (l1 * l2) < -0.7 && P1.ms - P0.ms < 120) {
                        const w = out.slice(-3);
                        const chain = w.length === 3 && Math.hypot(w[2].x - w[1].x, w[2].y - w[1].y) >= 1.4 && Math.hypot(w[1].x - w[0].x, w[1].y - w[0].y) >= 1.4
                            && ((w[2].x - w[1].x) * (w[1].x - w[0].x) + (w[2].y - w[1].y) * (w[1].y - w[0].y)) < 0;
                        if (!chain)
                            cost += 2;
                    }
                }
                if (!best || cost < best.cost)
                    best = { k, pos, cost };
            }
            return best;
        };
        const copyBar = j => {
            const p = copyFrom[j], src = placedIn[p];
            if (src.length !== countOf[j])
                return false;
            // (a quantum bar only comes back in a quantum part, a grid bar in a grid part)
            const qi = qAtI(i);
            if (qAtI(firstOf[p]) !== qi)
                return false;
            const phrase = j > 0 && copied[j - 1] && copied[j - 1].p === p - 1 && p < j - 1;
            // (a copy of the bar just before as it is would be the same bar twice in a row)
            const best = fitAt(src.map(o => [out[o].x, out[o].y]), qi,
                k => phrase ? (k === copied[j - 1].k ? -1 : 0.5) : k === 0 ? (p === j - 1 ? 1.5 : 0.35) : 0);
            // (a bar that can't be joined on well is placed like any other instead)
            if (!best || best.cost > 3)
                return false;
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: 'repeat', k: best.k, len: best.pos.length, copyOf: p });
            for (const [x, y] of best.pos) {
                const note = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, ms: times[i] };
                out.push(note);
                placedIn[j].push(out.length - 1);
                locked[i] = 1;
                prev2 = prev;
                prev = note;
                i++;
            }
            copied[j] = { p, k: best.k };
            return true;
        };

        // Similar to This Map: the bars that take over a part of the map that sounds like them (see similarParts),
        // by the index of their first note. Its notes go in as they were, turned or mirrored the way that joins on
        // best (changed round from how they were, unless only that way flows); the next bar of a phrase taken over
        // the same way as the one before, so it flows on as it did.
        const takeAt = new Map();
        for (const m of opts.similar || []) {
            if (!m.take)
                continue;
            const pos = new Map(m.pts.map(pt => [Math.round(pt.ms), pt]));
            const idx = [];
            for (let q = 0; q < times.length && times[q] < m.to; q++)
                if (times[q] >= m.from - 20 && pos.has(Math.round(times[q])))
                    idx.push(q);
            if (idx.length >= 2 && idx[idx.length - 1] - idx[0] === idx.length - 1)
                takeAt.set(idx[0], { m, idx, pts: idx.map(q => pos.get(Math.round(times[q]))) });
        }
        let lastTake = null;
        const placeTaken = g => {
            const qi = qAtI(i);
            const phrase = lastTake && Math.abs(lastTake.m.srcTo - g.m.srcFrom) < 30 && lastTake.end === i;
            const best = fitAt(g.pts.map(pt => [pt.x, pt.y]), qi, k => phrase ? (k === lastTake.k ? -1 : 0.4) : k === 0 ? 0.4 : 0);
            if (!best || best.cost > 6)
                return false;
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: 'similar', k: best.k, len: best.pos.length, from: g.m.srcFrom });
            for (const [x, y] of best.pos) {
                const note = { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000, ms: times[i] };
                out.push(note);
                if (barOf[i] >= 0)
                    placedIn[barOf[i]].push(out.length - 1);
                locked[i] = 1;
                prev2 = prev;
                prev = note;
                i++;
            }
            lastTake = { m: g.m, k: best.k, end: i };
            return true;
        };
        for (const q of takeAt.keys())
            copyStarts.push(q);
        // (a run stops where a bar like a part of the map starts, so that part's pattern can start there)
        for (const m of opts.similar || [])
            if (!m.take) {
                const q = times.findIndex(t => t >= m.from - 15);
                if (q > 0 && times[q] < m.to - 15)
                    copyStarts.push(q);
            }
        copyStarts.sort((p, q) => p - q);
        // (and the bars only like a part of the map: its notes are the pattern liked best there)
        const preferAt = ms => (opts.similar || []).find(m => !m.take && ms >= m.from - 15 && ms < m.to - 15);

        // Quantum slides (see generate): the notes after a slide's first note sweep on from it, along a curve or
        // snaking from side to side, keeping to the edges like quantum maps do, and turning back off them
        const slides = opts.slides || new Map();
        const isSlide = new Uint8Array(times.length);
        for (const [q, n] of slides)
            for (let z = 1; z <= n && q + z < times.length; z++)
                isSlide[q + z] = 1;
        // (the parts with slides in them, give or take a few seconds: there, the notes between slides are big jumps)
        const slideNear = new Uint8Array(times.length);
        {
            const starts = [...slides.keys()].map(q => times[q]).sort((p, q) => p - q);
            let k = 0;
            for (let q = 0; q < times.length; q++) {
                while (k < starts.length && starts[k] < times[q] - 3000)
                    k++;
                slideNear[q] = k < starts.length && starts[k] <= times[q] + 3000 ? 1 : 0;
            }
        }
        const placeSlide = () => {
            let n = 0;
            while (i + n < times.length && isSlide[i + n])
                n++;
            const start = prev;
            if (!n || !start)
                return false;
            const [lo, hi] = QUANTUM;
            const clamp = v => Math.min(hi, Math.max(lo, v));
            const step = Math.min(4.5, (opts.slideSpeed || 12) * Math.max(1, times[i + n - 1] - start.ms) / 1000) / n;
            // A slide hooks off the jump into it: it heads back round the way the cursor came, 40-80 degrees off
            // straight back (or towards the middle, turned up to 60 degrees), as human quantum maps' slides do,
            // rather than carrying on out of the jump into the wall. A few curves tried; the one kept stays in the
            // playfield (curving in before the edge rather than bouncing off it), never runs back over itself or
            // the notes just before, keeps to the grid's outer ring and its edge (where quantum maps' slides go, not
            // out past it) and never turns sharply inside the sweep
            const inX = prev2 ? start.x - prev2.x : 0, inY = prev2 ? start.y - prev2.y : 0;
            const backA = Math.hypot(inX, inY) > 0.05 ? Math.atan2(-inY, -inX) : Math.random() * 2 * Math.PI;
            const toMid = Math.atan2(1 - start.y, 1 - start.x);
            const near = out.slice(-16);
            const rOf = (px, py) => Math.max(Math.abs(px - 1), Math.abs(py - 1));
            let best = null;
            for (let t = 0; t < 16; t++) {
                const base = t % 2 === 0 ? backA + (Math.random() < 0.5 ? -1 : 1) * (0.7 + 0.7 * Math.random())
                    : toMid + (Math.random() * 2 - 1) * 1.05;
                // (bending a little each note, never more than about two right angles over the whole slide)
                const turn = (Math.random() * 2 - 1) * Math.min(0.3, 2 / n, opts.qp ? 0.05 + 0.8 * opts.qp.slideBend : 0.3);
                // (one smooth curve: a slide that snakes from side to side flicks against its own flow on every note)
                let a = base, x = start.x, y = start.y, edge = 0, overlap = 0, out2 = 0, sharp = 0, walls = 0, against = 0;
                const pts = [], path = [[x, y]];
                for (let z = 1; z <= n; z++) {
                    a += turn;
                    let nx = x + Math.cos(a) * step, ny = y + Math.sin(a) * step;
                    // (curving in before the edge: turned towards the middle, a little at a time)
                    if (rOf(nx, ny) > (opts.qp ? Math.max(1.05, opts.qp.r90 + 0.05) : 1.3)) {
                        const m = Math.atan2(1 - y, 1 - x);
                        let d = Math.atan2(Math.sin(m - a), Math.cos(m - a));
                        a += Math.max(-0.35, Math.min(0.35, d));
                        nx = x + Math.cos(a) * step;
                        ny = y + Math.sin(a) * step;
                    }
                    if (nx < lo || nx > hi || ny < lo || ny > hi)
                        walls++;
                    x = clamp(nx);
                    y = clamp(ny);
                    for (let k = 0; k + 2 < path.length; k++)
                        if (Math.hypot(path[k][0] - x, path[k][1] - y) < 0.15)
                            overlap++;
                    for (const nt of near)
                        if (Math.hypot(nt.x - x, nt.y - y) < 0.15)
                            overlap += 0.5;
                    path.push([x, y]);
                    const px = x, py = y;
                    const r = rOf(px, py);
                    if (r >= 0.5 && r <= 1.15)
                        edge++;
                    out2 += Math.max(0, r - (opts.qp ? Math.max(1.05, opts.qp.r90 + 0.05) : 1.3));
                    const pt = [Math.round(px * 100) / 100, Math.round(py * 100) / 100], last = pts.length ? pts[pts.length - 1] : [start.x, start.y];
                    // (never the same spot twice, nor back on the note two before: a hairpin inside the sweep)
                    if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) < 0.02)
                        overlap += 5;
                    const two = pts.length >= 2 ? pts[pts.length - 2] : pts.length ? [start.x, start.y] : null;
                    if (two && Math.hypot(pt[0] - two[0], pt[1] - two[1]) < 0.12)
                        overlap += 3;
                    // (and no sharp turn inside it, over 100 degrees between the notes' own moves, nor a bend back against
                    // the way it curves, where the edge or the wall pushed it round: it sweeps one way)
                    if (pts.length >= 1) {
                        const p0 = pts.length >= 2 ? pts[pts.length - 2] : [start.x, start.y], p1 = last;
                        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], vx = pt[0] - p1[0], vy = pt[1] - p1[1];
                        const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
                        if (lu > 0.02 && lv > 0.02 && (ux * vx + uy * vy) / (lu * lv) < Math.cos(100 * Math.PI / 180))
                            sharp++;
                        if (pts.length >= 2 && lu > 0.02 && lv > 0.02 && turn && Math.sign(ux * vy - uy * vx) === -Math.sign(turn)
                            && Math.abs(Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)) > 0.2)
                            against++;
                    }
                    pts.push(pt);
                }
                // (and not straight back down the jump into it, within 20 degrees)
                let retrace = 0;
                if (prev2 && pts.length) {
                    const ox = pts[0][0] - start.x, oy = pts[0][1] - start.y, li = Math.hypot(inX, inY), lo2 = Math.hypot(ox, oy);
                    if (li > 0.05 && lo2 > 0.01 && (inX * ox + inY * oy) / (li * lo2) < Math.cos(160 * Math.PI / 180))
                        retrace = 1;
                }
                const score = 0.6 * walls + 2 * overlap + 3 * sharp + 1.5 * against - 0.8 * edge / n + 2 * out2 / n + retrace + 0.3 * Math.random();
                if (!best || score < best.score)
                    best = { pts, score };
            }
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: 'slide', len: n });
            for (const [x, y] of best.pts) {
                const note = { x, y, ms: times[i] };
                out.push(note);
                if (barOf[i] >= 0)
                    placedIn[barOf[i]].push(out.length - 1);
                prev2 = prev;
                prev = note;
                i++;
            }
            return true;
        };

        // Slides in a mixed map's jump parts (chooseTimes: a quick figure in the music): from where the jump lands,
        // on along the edge of the grid, a cell a note, round the corners (top right down the right side and along
        // the bottom, say), the way that carries on from the jump
        const gridSlide = opts.gridSlide || null;
        const placeGridSlide = () => {
            let n = 0;
            // (at most four notes on from the jump's: two figures in a row are two slides)
            while (i + n < times.length && gridSlide[i + n] && n < 4)
                n++;
            if (!n || !prev)
                return false;
            const gaps = [];
            for (let z = 0; z < n; z++)
                gaps.push(times[i + z] - (z ? times[i + z - 1] : prev.ms));
            // (a cell a note on from the jump, turning where the sounds say: along the edge, in through the middle or
            // round a corner, not always round the outside, which made lap after lap of them)
            const r = walkRun('walk', prev, prev2, gaps, opts.accents ? opts.accents.subarray(i, i + n) : null, soundOf(i, gaps).soundSeed ?? Math.floor(Math.random() * 1e9));
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: 'jump slide', len: n });
            for (let z = 1; z <= n; z++) {
                const note = { x: r.x[z], y: r.y[z], ms: times[i] };
                out.push(note);
                if (barOf[i] >= 0)
                    placedIn[barOf[i]].push(out.length - 1);
                prev2 = prev;
                prev = note;
                i++;
            }
            return true;
        };

        const copyRun = r => {
            const f = SYM[r.k];
            for (let q = 0; q < r.len && i < times.length; q++, i++) {
                const [x, y] = f(r.e.x[r.i + q + 1], r.e.y[r.i + q + 1]);
                const note = { x: Math.round((x + r.ox) * 1000) / 1000, y: Math.round((y + r.oy) * 1000) / 1000, ms: times[i] };
                out.push(note);
                if (barOf[i] >= 0)
                    placedIn[barOf[i]].push(out.length - 1);
                prev2 = prev;
                prev = note;
            }
            const list = used.get(r.e) || [];
            list.push(r.i);
            if (list.length > 40)
                list.shift();
            used.set(r.e, list);
            lastRun = r;
        };
        // the last 8 moves placed ([distance, time]), and how fast the cursor went over them
        const recentMoves = () => {
            const list = [];
            for (let j = Math.max(1, out.length - 8); j < out.length; j++)
                list.push([Math.hypot(out[j].x - out[j - 1].x, out[j].y - out[j - 1].y), out[j].ms - out[j - 1].ms]);
            return list;
        };
        const recentSpeed = () => {
            let d = 0, t = 0;
            for (let j = Math.max(1, out.length - 8); j < out.length; j++) {
                d += Math.hypot(out[j].x - out[j - 1].x, out[j].y - out[j - 1].y);
                t += out[j].ms - out[j - 1].ms;
            }
            return t > 0 ? d / t * 1000 : 0;
        };

        // The stream shape the sounds of a run call for, and the seed its made-up shapes are made from (the same
        // sounds in the same rhythm, the same seed): rolling hats snake along the lines, kicks cut across through the
        // middle, a snare roll (in a mixed map) goes into star streams, a melody walks and turns with it, a bass line
        // spins round the outside
        const STYLE_OF = ['cross', 'star', 'snake', 'walk', 'ring'];
        const soundOf = (q, gaps) => {
            if (!opts.voice)
                return {};
            const count = [0, 0, 0, 0, 0];
            let h = 2166136261;
            for (let z = 0; z < Math.min(8, gaps.length); z++) {
                const v = opts.voice[q + z];
                count[v]++;
                h = Math.imul(h ^ (v * 31 + Math.round(4 * Math.log2(Math.max(10, gaps[z]) / 10))), 16777619);
            }
            let top = 0;
            for (let v = 1; v < 5; v++)
                if (count[v] > count[top])
                    top = v;
            let style = STYLE_OF[top];
            if (style === 'star' && opts.runOptions && opts.runOptions.patterns === 'streams')
                style = 'walk';
            return { soundSeed: h >>> 0, soundStyle: style };
        };

        // where the music changes (a new section, or something new inside one): runs stop there, and what comes
        // after starts a new pattern
        const bounds = (opts.boundaries || []).slice().sort((p, q) => p - q);
        let bi = 0, fresh = false, ci = 0;
        while (i < times.length) {
            await yieldNow(i / times.length);
            turn(out, locked);
            while (bi < bounds.length && bounds[bi] <= times[i]) {
                bi++;
                fresh = true;
            }
            const j = barOf[i];
            if (takeAt.has(i) && placeTaken(takeAt.get(i)))
                continue;
            if (j >= 0 && copyFrom[j] >= 0 && i === firstOf[j]) {
                if (copyBar(j))
                    continue;
                copyFrom[j] = -1;
            }
            if (isSlide[i] && placeSlide())
                continue;
            if (gridSlide && gridSlide[i] && placeGridSlide())
                continue;
            const limit = bi < bounds.length ? bounds[bi] : Infinity;
            // (runs stop where a repeated bar starts)
            while (ci < copyStarts.length && copyStarts[ci] <= i)
                ci++;
            const nextCopy = ci < copyStarts.length ? copyStarts[ci] : Infinity;
            // a run of up to 12-24 notes (fewer joins, more of the original flow), ending at a long pause
            const L = 12 + Math.floor(Math.random() * 13);
            const gaps = [];
            for (let q = 0; q < L && i + q < times.length; q++) {
                if (q > 0 && (times[i + q] >= limit || i + q >= nextCopy || isSlide[i + q] || (gridSlide && gridSlide[i + q])))
                    break;
                const g = times[i + q] - (q === 0 ? (prev ? prev.ms : times[i] - 500) : times[i + q - 1]);
                if (q > 2 && g > 4 * gaps[q - 1] && g > 600)
                    break;
                gaps.push(g);
                // (a slide goes on from this note)
                if (slides.has(i + q))
                    break;
            }
            remember();
            rememberShapes();
            const ropts = {
                ...(opts.qAt && qAtI(i) ? opts.qRunOptions : opts.jumpPart && opts.jumpPart(times[i]) ? opts.jumpRunOptions : opts.runOptions), quantum: qAtI(i), jump: jumpAt(times[i]), vmax: opts.vmax, history,
                // (the comfortable speed goes up and down with the sections too)
                comfort: opts.runOptions && opts.runOptions.comfort ? opts.runOptions.comfort * (opts.levelAt ? opts.levelAt(times[i]) : 1) : undefined,
                calm: opts.calmAt ? opts.calmAt(times[i]) : 1,
                speedCap: opts.speedCap, accelCap: opts.accelCap, recentSpeed: recentSpeed(), recentMoves: recentMoves(), fresh,
                lastEntry: lastRun && (lastRun.e.source || lastRun.e), lastEnd: lastRun ? (lastRun.e.srcI ?? lastRun.i) + lastRun.len : 0, lastK: lastRun && lastRun.k,
                lastName: lastRun && lastRun.e.name, slidesOn: !!slideNear[i],
                recentPts: out.slice(-24).map(nt => [nt.x, nt.y]), recentNotes: out.slice(-4),
                acc: opts.accents ? opts.accents.subarray(i, i + gaps.length) : null,
                fast: opts.fastAt ? opts.fastAt.subarray(i, i + gaps.length) : null,
                weak: opts.weakAt && !qAtI(i) ? opts.weakAt.subarray(i, i + gaps.length) : null,
                ...soundOf(i, gaps), shapes,
                prefer: preferAt(times[i]) ? { pts: preferAt(times[i]).pts, bonus: opts.similarBonus || 0.5 } : null,
                spinShare: spinShare(out.slice(-160).map(nt => [nt.x, nt.y])),
            };
            // nothing carries on from here: anything that does, then a fresh start (still a playable move away)
            let run = findRun(lib, gaps, prev, prev2, ropts, used)
                || findRun(lib, gaps, prev, prev2, { ...ropts, loose: true }, used)
                || findRun(lib, gaps, null, null, { ...ropts, loose: true, anchor: prev, anchor2: prev2 }, used);
            // (and if nothing at all can be played in time, the limits give a little rather than leaving a hole)
            for (let relax = 1.5; !run && relax <= 12; relax *= 2)
                run = findRun(lib, gaps, prev, prev2, {
                    ...ropts, loose: true, speedCap: opts.speedCap * relax, accelCap: opts.accelCap * relax, reachSlack: 1.25 * relax,
                    recentSpeed: relax > 6 ? Infinity : ropts.recentSpeed * relax,
                }, used);
            if (!run) {
                const note = stepNote(prev, prev2, times[i], prev && opts.sizeAt ? opts.sizeAt(i, times[i] - prev.ms) : jumpAt(times[i]), { ...opts, quantum: qAtI(i) });
                out.push(note);
                if (barOf[i] >= 0)
                    placedIn[barOf[i]].push(out.length - 1);
                prev2 = prev;
                prev = note;
                i++;
                continue;
            }
            if (opts.trace)
                opts.trace.push({ ms: times[i], name: run.e.name, entry: run.e, k: run.k, len: run.len, fresh });
            fresh = false;
            copyRun(run);
        }
        turn(out, locked);
        return out;
    }

    // Basic quantum (a low Quantum level), in the parts picked for it: the quick notes between some of the grid's
    // notes moved onto a line or a curve from one to the next, as the editor's Bezier tool draws them (plain, or
    // Curve Bezier). The notes it bends between stay where they were, on the grid; the ones between glide, spaced by
    // their timing. The higher the level, the more of them are curves and the rounder (and a little past the grid's
    // edge); a group bends its curves the same way round (an arc) or each the other way (an S).
    function bendCurves(notes, inPart, level, trace = null) {
        const out = notes.map(n => ({ ...n }));
        const lo = -0.35 * Math.min(1, level * 2), hi = 2 - lo;
        let i = 0;
        while (i < out.length) {
            if (!inPart(out[i].ms)) {
                i++;
                continue;
            }
            // (a group: notes in the part, quick and about evenly spaced, under 220ms apart)
            let j = i + 1, quick = Infinity;
            while (j < out.length && inPart(out[j].ms)) {
                const g = out[j].ms - out[j - 1].ms;
                if (g > 220 || (quick < Infinity && (g > 2 * quick || g < quick / 2)))
                    break;
                quick = Math.min(quick, g);
                j++;
            }
            if (j - i >= 4) {
                const m = level < 0.12 ? 4 : 3 + (Math.random() < 0.5 ? 1 : 0);
                const anchors = [];
                for (let k = i; k < j - 1; k += m)
                    anchors.push(k);
                if (j - 1 - anchors[anchors.length - 1] < 2 && anchors.length > 1)
                    anchors.pop();
                anchors.push(j - 1);
                const curved = Math.random() < 0.3 + 1.4 * level;
                const side0 = Math.random() < 0.5 ? 1 : -1, arc = Math.random() < 0.6;
                let bent = 0;
                for (let k = 0; k + 1 < anchors.length; k++) {
                    const A = out[anchors[k]], B = out[anchors[k + 1]];
                    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
                    if (L < 0.5 || anchors[k + 1] - anchors[k] < 2)
                        continue;
                    const side = arc ? side0 : k % 2 ? -side0 : side0;
                    const bulge = curved ? (0.25 + 0.45 * Math.min(1, level * 2.5)) * L * 0.5 * side : 0;
                    const cx = (A.x + B.x) / 2 - dy / L * bulge, cy = (A.y + B.y) / 2 + dx / L * bulge;
                    for (let z = anchors[k] + 1; z < anchors[k + 1]; z++) {
                        const u = (out[z].ms - A.ms) / Math.max(1, B.ms - A.ms);
                        const x = (1 - u) * (1 - u) * A.x + 2 * u * (1 - u) * cx + u * u * B.x;
                        const y = (1 - u) * (1 - u) * A.y + 2 * u * (1 - u) * cy + u * u * B.y;
                        out[z].x = Math.round(Math.min(hi, Math.max(lo, x)) * 100) / 100;
                        out[z].y = Math.round(Math.min(hi, Math.max(lo, y)) * 100) / 100;
                        bent++;
                    }
                }
                if (trace && bent)
                    trace.push({ ms: out[i].ms, name: curved ? 'curve bezier' : 'bezier', len: bent });
            }
            i = Math.max(i + 1, j);
        }
        return out;
    }

    // How unbalanced or awkward a generated map is (lower is better): moves drifting away from what's wanted where they
    // are, sudden far jumps, notes on the same spot twice and little 2x2 circles
    // (sizeAt(i, gap): the move wanted into note i)
    function badness(notes, sizeAt, vmax = Infinity, model = null, flow = 0.7, quantum = false, runOptions = {}) {
        const n = notes.length;
        if (n < 2)
            return 0;
        let drift = 0, spikes = 0, jacks = 0, spins = 0;
        const moves = [], wants = [];
        for (let i = 1; i < n; i++) {
            const a = notes[i - 1], b = notes[i];
            const d = Math.hypot(b.x - a.x, b.y - a.y);
            const J = sizeAt(i, b.ms - a.ms);
            moves.push(d);
            wants.push(J);
            if (moves.length > 8) {
                moves.shift();
                wants.shift();
            }
            const avg = moves.reduce((p, q) => p + q, 0) / moves.length, want = wants.reduce((p, q) => p + q, 0) / wants.length;
            drift += Math.log((avg + 0.15) / (want + 0.15)) ** 2;
            if (d > Math.max(1.5, 2.2 * J) || d / Math.max(1, b.ms - a.ms) * 1000 > vmax * 1.1)
                spikes++;
            if (d < 1e-3)
                jacks++;
            if (i >= 3) {
                const w = notes.slice(i - 3, i + 1);
                const xs = w.map(v => v.x), ys = w.map(v => v.y);
                if (Math.max(...xs) - Math.min(...xs) <= 1.001 && Math.max(...ys) - Math.min(...ys) <= 1.001
                    && new Set(w.map(v => `${v.x},${v.y}`)).size === 4 && w.every(v => isWhole(v.x) && isWhole(v.y)))
                    spins++;
            }
        }
        let feel = 0;
        if (model && n > 3) {
            // played through like a player would: how much rougher than the learned maps, overall and at its worst
            const ch = [];
            for (let i = 1; i + 1 < n; i++)
                ch.push(velocityChange(notes[i - 1], notes[i], notes[i + 1]));
            const mean = ch.reduce((p, q) => p + q, 0) / ch.length;
            let worst = 0;
            for (let i = 0; i + 16 <= ch.length; i += 4) {
                let s = 0;
                for (let k = i; k < i + 16; k++)
                    s += ch[k];
                worst = Math.max(worst, s / 16);
            }
            const target = model.change * (1.2 - 0.45 * flow);
            feel = 4 * Math.max(0, mean - target) + 2 * Math.max(0, worst - target * 1.4);
        }
        // awkward spots (see awkward()), which human grid maps hardly have
        const aw = awkward(notes), tm = timing(notes, 0, runOptions);
        return 3 * drift / n + 4 * spikes / n + 8 * jacks / n + 6 * spins / n + flow * feel
            + (quantum ? 4 : 20) * aw.flowBreak / n + 10 * aw.snapBreak / n + 6 * aw.spacingJump / n
            + (12 * tm.smallJump + 4 * tm.speedJump + 5 * tm.rightJump + 2 * tm.spinFlip + 4 * tm.tooFast) / n;
    }

    // swing for a given beat (period/phase in frames): are the hits between beats on thirds rather than quarters?
    function isSwung(hits, period, phase) {
        let thirds = 0, quarters = 0;
        for (let t = phase; t < hits.length - period; t += period) {
            thirds += around(hits, t + period / 3, 1) + around(hits, t + 2 * period / 3, 1);
            quarters += around(hits, t + period / 4, 1) + around(hits, t + 3 * period / 4, 1);
        }
        return thirds > quarters * 1.25;
    }

    // Which beat of four starts a bar (0..3), for a beat `beat` ms long whose beats fall at offsetMs + k * beat. Songs
    // change on the first beat of a bar (a drop comes in, a layer is added), so the bar lines that see the biggest
    // changes from one bar to the next are the real ones.
    function findDownbeat(a, beat, offsetMs) {
        const step = beat / 10;
        const count = Math.floor((a.frames - offsetMs / 10) / step);
        if (count < 16)
            return 0;
        const D = 5;
        const per = new Float64Array(count * D);
        for (let k = 0; k < count; k++) {
            const f0 = Math.floor(offsetMs / 10 + k * step), f1 = Math.min(a.frames, Math.floor(offsetMs / 10 + (k + 1) * step));
            let lo = 0, mi = 0, hi = 0, loud = 0, hits = 0;
            for (let f = f0; f < f1; f++) {
                lo += a.bandLow[f];
                mi += a.bandMid[f];
                hi += a.bandHigh[f];
                loud += Math.log10(a.rms[f] + 1e-4);
                hits += a.hits[f];
            }
            const c = Math.max(1, f1 - f0);
            [lo, mi, hi, loud, hits].forEach((v, d) => per[k * D + d] = v / c);
        }
        for (let d = 0; d < D; d++) {
            let mean = 0, sq = 0;
            for (let k = 0; k < count; k++)
                mean += per[k * D + d];
            mean /= count;
            for (let k = 0; k < count; k++)
                sq += (per[k * D + d] - mean) ** 2;
            const sd = Math.sqrt(sq / count) || 1;
            for (let k = 0; k < count; k++)
                per[k * D + d] = (per[k * D + d] - mean) / sd;
        }
        let best = 0, top = -1;
        for (let phase = 0; phase < 4; phase++) {
            // squared change between neighbouring bars: a change right on a bar line counts in full, one in the
            // middle of a bar is split over two smaller ones
            let score = 0, prev = null;
            for (let k = phase; k + 4 <= count; k += 4) {
                const bar = new Float64Array(D);
                for (let q = 0; q < 4; q++)
                    for (let d = 0; d < D; d++)
                        bar[d] += per[(k + q) * D + d] / 4;
                if (prev)
                    for (let d = 0; d < D; d++)
                        score += (bar[d] - prev[d]) ** 2;
                prev = bar;
            }
            if (score > top) {
                top = score;
                best = phase;
            }
        }
        return best;
    }

    const TRIES = 8;

    // opts: { buffer (AudioBuffer), startMs, endMs, difficulty (1..10), density (1 = normal), count (0 = by difficulty),
    //         flow (0..1: how smooth to keep the cursor's path), follow (0..1: how closely to stick to the learned maps),
    //         jumpScale (1 = like the maps), patterns ('mixed' | 'streams' | 'jumps'), dropBoost (0..2: how much harder
    //         intense parts and drops are), variety (0..1), sources (kinds of sound to sync to: 'kick', 'snare',
    //         'hat', 'melody', 'bass'), sensitivity (0..1: how quiet a sound can be and still get a note),
    //         fill ('never' | 'intense' | 'busy': where streams may be filled in between sounds),
    //         calm (0..1: how many notes calm parts like intros and breakdowns get),
    //         quantum (allow notes off the 3x3 grid), timing ([{ bpm, ms }] from the map, if it has any),
    //         before (the notes just before startMs), styleNotes (the map's own notes: their patterns are preferred),
    //         avoid (times already taken), progress (text => void) }
    // Resolves to the notes, with .info = { bpm, offsetMs, steady (when the BPM was detected), sections }.
    // The star rating a map at each difficulty usually comes out at (1 to 10; Rhythia's SR, see starrating.js), for the
    // first guess at the difficulty a star rating asks for
    const STARS_AT = [0, 0.9, 1.2, 1.5, 2.0, 2.5, 3.5, 4.6, 6.3, 7.5, 8.3];
    const difficultyFor = stars => {
        if (stars <= STARS_AT[1])
            return Math.max(0.4, stars / STARS_AT[1]);
        for (let d = 2; d <= 10; d++)
            if (stars <= STARS_AT[d])
                return d - 1 + (stars - STARS_AT[d - 1]) / (STARS_AT[d] - STARS_AT[d - 1]);
        return 10 + (stars - STARS_AT[10]) / 0.9;
    };

    // A map at a star rating (opts.stars, Rhythia's SR), exactly: one knob for how hard (the difficulty from 1 to 10,
    // in between too; past 10 bigger jumps, more notes and, as far as it takes, faster streams; under 1 fewer notes),
    // started where that rating usually comes out, then searched with quick maps (one pass each) for the easiest
    // setting that makes it at least that hard. That's made properly, and then brought down to the rating exactly by
    // taking out notes, the ones that make it hardest on the weakest sounds first (fast moves in and out of a quiet
    // note), never inside a stream if a jump will do. Without a target the map is made once and its rating noted.
    async function generate(opts) {
        const rate = window.SSQEStarRating && window.SSQEStarRating.rate;
        const target = +opts.stars;
        if (!(target > 0) || !rate || opts.count > 0) {
            const notes = await generateAt(opts);
            if (rate && notes.info)
                notes.info.stars = rate(notes);
            return notes;
        }
        const js = opts.jumpScale || 1, dens = opts.density || 1;
        // (past 20, when the song's own sounds can't make it that hard, as with a short stretch of a song: a note on every
        // beat, then every half, third, quarter, sixth, eighth, twelfth and sixteenth of one, as spaced-out flowing
        // streams, the setting up to 40)
        const GRID_DIVS = [1, 2, 3, 4, 6, 8, 12, 16];
        const at = u => u > 20 ? { difficulty: 10, jumpScale: js * (2.2 + 0.02 * (u - 20)), density: dens * 3.5, force: true,
            gridFill: GRID_DIVS[Math.min(GRID_DIVS.length - 1, Math.floor((u - 20) / 2.5))] }
            : u > 10 ? { difficulty: 10, jumpScale: js * (1 + 0.12 * (u - 10)), density: dens * (1 + 0.25 * (u - 10)), force: true }
            : u < 1 ? { difficulty: 1, density: dens * Math.max(0.3, u) } : { difficulty: u };
        const progress = opts.progress || (() => { });
        const SEARCH = 14, LO = 0.3, HI = 40;
        const make = async (u, label, tries) => {
            const trace = opts.trace ? [] : undefined;
            const notes = await generateAt({ ...opts, ...at(u), trace, tries, progress: text => progress(`MAKING ${target.toFixed(1)} STARS (${label}) - ${text}`) });
            return { u, notes, sr: rate(notes), trace };
        };
        const tried = [];
        let u = Math.max(LO, Math.min(HI, difficultyFor(target)));
        for (let t = 0; t < SEARCH; t++) {
            const r = await make(u, `TRY ${t + 1}`, 1);
            tried.push(r);
            const above = tried.filter(x => x.sr >= target).sort((p, q) => p.u - q.u)[0];
            const below = tried.filter(x => x.sr < target).sort((p, q) => q.u - p.u)[0];
            // (a little over is what's wanted: the notes that take it over come out after)
            if (above && above.sr - target <= 0.5)
                break;
            let next;
            if (above && below && below.u < above.u) {
                if (above.u - below.u < 0.08)
                    break;
                const f = Math.min(0.85, Math.max(0.15, (target + 0.2 - below.sr) / Math.max(1e-6, above.sr - below.sr)));
                next = below.u + (above.u - below.u) * f;
            } else if (r.sr < target) {
                if (u >= HI)
                    break;
                // (as far up as the rating rose over the last step says it takes: where the song's own sounds are all
                // used and it hardly rises, big steps, so it gets to where it fills in beats rather than running out)
                const prev = tried.filter(x => x.sr < target && x.u < u).sort((p, q) => q.u - p.u)[0];
                const slope = prev ? Math.max(0.12, (r.sr - prev.sr) / Math.max(0.1, u - prev.u)) : 0.9;
                next = Math.min(HI, u + Math.max(0.3, Math.min(6, (target - r.sr) / slope + 0.2)));
            } else {
                if (u <= LO)
                    break;
                next = Math.max(LO, u - Math.max(0.2, Math.min(3, (r.sr - target) / 0.9)));
            }
            u = next;
        }
        let base = tried.filter(x => x.sr >= target).sort((p, q) => p.u - q.u)[0];
        let keep;
        if (base) {
            // made properly at that setting (several passes, the most balanced kept); if that one comes out under,
            // a little harder, and failing that the quick one, which was over
            keep = await make(base.u, 'FINISHING', undefined);
            for (let k = 0; keep.sr < target && k < 2; k++) {
                const again = await make(base.u + 0.3 * (k + 1), 'FINISHING', undefined);
                if (again.sr >= target)
                    keep = again;
            }
            if (keep.sr < target)
                keep = base;
        } else
            keep = tried.slice().sort((p, q) => Math.abs(p.sr - target) - Math.abs(q.sr - target))[0];
        progress(`MAKING ${target.toFixed(1)} STARS - EXACTLY`);
        const a = opts.buffer ? await analyse(opts.buffer) : null;
        const trimmed = keep.sr > target ? trimToStars(keep.notes, target, rate, a) : { notes: keep.notes, sr: keep.sr };
        const notes = trimmed.notes;
        notes.info = { ...keep.notes.info, stars: trimmed.sr, difficulty: keep.u, target, search: tried.map(x => [+x.u.toFixed(2), +x.sr.toFixed(2)]) };
        if (opts.trace && keep.trace)
            opts.trace.push(...keep.trace);
        return notes;
    }

    // Takes notes out of a map until its star rating is the target (to a hundredth or so, where single notes can
    // still tell; when one note too many or too few, whichever is closer). Which ones: those whose moves in and out
    // are fastest on the quietest sounds, notes between jumps first and stream notes only after, and never a note
    // whose going would put the cursor back on the spot it just left.
    function trimToStars(notesIn, target, rate, a) {
        const all = notesIn.slice().sort((p, q) => p.ms - q.ms);
        let best = trimRound(all, target, rate, a, 0);
        // Then a note at a time, where taking notes out in order doesn't land on it (a nearly empty map's rating
        // goes up and down as notes go): each step the one note out, or one taken out put back, that brings it
        // closest, until it's on it or nothing brings it closer
        if (Math.abs(best.sr - target) > 0.01) {
            let kept = best.notes.slice();
            const steps = kept.length < 800 ? 120 : kept.length < 2500 ? 30 : 12;
            const tries = kept.length < 800 ? 40 : 14;
            for (let step = 0; step < steps && Math.abs(best.sr - target) > 0.01; step++) {
                const keptSet = new Set(kept);
                const out = all.filter(n => !keptSet.has(n));
                const options = [];
                // (out: the ones moving fastest in and out; back: the ones nearest the hardest of what's left)
                const speed = (list, i) => {
                    const p = list[i - 1], c = list[i], q = list[i + 1];
                    return (p ? Math.hypot(c.x - p.x, c.y - p.y) / Math.max(15, c.ms - p.ms) : 0) + (q ? Math.hypot(q.x - c.x, q.y - c.y) / Math.max(15, q.ms - c.ms) : 0);
                };
                if (best.sr > target)
                    kept.map((n, i) => [n, speed(kept, i)]).sort((p, q) => q[1] - p[1]).slice(0, tries)
                        .forEach(([n]) => options.push(kept.filter(m => m !== n)));
                else
                    out.slice().sort(() => Math.random() - 0.5).slice(0, tries)
                        .forEach(n => options.push([...kept, n].sort((p, q) => p.ms - q.ms)));
                let pick = null;
                for (const o of options) {
                    const sr = rate(o);
                    if (!pick || Math.abs(sr - target) < Math.abs(pick.sr - target))
                        pick = { notes: o, sr };
                }
                if (!pick || Math.abs(pick.sr - target) >= Math.abs(best.sr - target))
                    break;
                best = pick;
                kept = pick.notes;
            }
        }
        return best;
    }

    function trimRound(notesIn, target, rate, a, round = 0) {
        const ns = notesIn.slice().sort((p, q) => p.ms - q.ms);
        const accAt = ms => {
            if (!a)
                return 0.5;
            let m = 0;
            for (let f = Math.max(0, Math.round(ms / 10) - 2); f <= Math.min(a.frames - 1, Math.round(ms / 10) + 2); f++)
                m = Math.max(m, a.beats[f], 0.6 * a.hits[f]);
            return Math.min(1.2, m);
        };
        const jumpsFirst = [], streamsAfter = [];
        for (let i = 1; i + 1 < ns.length; i++) {
            const p = ns[i - 1], c = ns[i], q = ns[i + 1];
            // (back on the spot it just left: only in the last round, when nothing else will do)
            if (Math.hypot(p.x - q.x, p.y - q.y) < 0.05 && round < 3)
                continue;
            const g1 = Math.max(15, c.ms - p.ms), g2 = Math.max(15, q.ms - c.ms);
            const v = Math.hypot(c.x - p.x, c.y - p.y) / g1 + Math.hypot(q.x - c.x, q.y - c.y) / g2;
            const score = v * (1.3 - accAt(c.ms));
            (Math.min(g1, g2) >= 110 ? jumpsFirst : streamsAfter).push([i, score]);
        }
        const order = [...jumpsFirst.sort((p, q) => q[1] - p[1]), ...streamsAfter.sort((p, q) => q[1] - p[1])].map(x => x[0]);
        const cache = new Map();
        const after = k => {
            if (!cache.has(k)) {
                const drop = new Set(order.slice(0, k));
                const kept = ns.filter((_, i) => !drop.has(i));
                cache.set(k, { notes: kept, sr: rate(kept) });
            }
            return cache.get(k);
        };
        // (the fewest notes out that bring it to the target or just under, then the closest around there)
        let lo = 0, hi = order.length;
        // (all of them out and still over: again, on what's left, its notes' new neighbours)
        if (after(hi).sr > target)
            return round < 3 && hi > 0 ? trimRound(after(hi).notes, target, rate, a, round + 1) : after(hi);
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (after(mid).sr > target)
                lo = mid;
            else
                hi = mid;
        }
        let best = null;
        for (let k = Math.max(0, lo - 4); k <= Math.min(order.length, hi + 4); k++) {
            const r = after(k);
            if (!best || Math.abs(r.sr - target) < Math.abs(best.sr - target))
                best = r;
        }
        return best;
    }

    // A set number of notes, exactly: more times than that (rare), the ones closest to their neighbours go; fewer
    // (the song's sounds and beat divisions have run out), the rest go evenly into the longest gaps between notes,
    // each gap split into equal parts (one long gap twice as long as another gets twice the notes), so it's always
    // the number asked for, as playable as that many notes can be.
    // The song's own times, and a note on every 1/gridFill of a beat besides (where something's playing: not in
    // silence), for a star rating its sounds alone can't reach. A beat's point near one of the song's own notes is
    // left out, so the stream runs through the notes already there.
    function fillGrid(times, a, opts, ctx) {
        const d = opts.gridFill;
        const points = (ctx.timing || []).filter(p => p.bpm > 0).sort((p, q) => p.ms - q.ms);
        if (!points.length)
            points.push({ bpm: 120, ms: 0 });
        let loudMax = 0;
        for (let f = 0; f < a.frames; f++)
            loudMax = Math.max(loudMax, a.loudness[f]);
        const loudAt = ms => a.loudness[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0;
        const avoid = opts.avoid || [];
        const kept = times.slice().sort((p, q) => p - q);
        const add = [];
        for (let k = 0; k < points.length; k++) {
            const pt = points[k], step = 60000 / pt.bpm / d;
            const from = Math.max(opts.startMs, k ? pt.ms : -Infinity), to = Math.min(opts.endMs, k + 1 < points.length ? points[k + 1].ms : Infinity);
            for (let t = pt.ms + Math.ceil((from - pt.ms) / step) * step; t < to - 1; t += step) {
                const ms = Math.round(t);
                if (ms <= opts.startMs || ms >= opts.endMs || loudAt(ms) < 0.12 * loudMax || avoid.some(v => Math.abs(v - ms) < step * 0.45))
                    continue;
                add.push([ms, step]);
            }
        }
        const out = kept.slice();
        let j = 0;
        for (const [ms, step] of add) {
            while (j < kept.length && kept[j] < ms - step * 0.45)
                j++;
            if (j < kept.length && Math.abs(kept[j] - ms) < step * 0.45)
                continue;
            out.push(ms);
        }
        return [...new Set(out)].sort((p, q) => p - q);
    }

    function exactTimes(times, count, startMs, endMs) {
        times = times.slice().sort((p, q) => p - q);
        if (!(count > 0) || times.length === count)
            return times;
        if (times.length > count) {
            while (times.length > count) {
                let at = -1, gap = Infinity;
                for (let q = 0; q < times.length; q++) {
                    const g = Math.min(q ? times[q] - times[q - 1] : Infinity, q + 1 < times.length ? times[q + 1] - times[q] : Infinity);
                    if (g < gap) {
                        gap = g;
                        at = q;
                    }
                }
                times.splice(at, 1);
            }
            return times;
        }
        if (times.length < 2) {
            const from = times.length ? times[0] : startMs, span = Math.max(1, endMs - from);
            return Array.from({ length: count }, (_, q) => Math.round(from + span * q / count));
        }
        const missing = count - times.length;
        const gaps = times.slice(1).map((t, q) => t - times[q]);
        const need = T => gaps.reduce((n, g) => n + Math.max(0, Math.ceil(g / T - 1e-9) - 1), 0);
        // (the longest piece any gap is cut into: as long as it can be while still taking all of them)
        let lo = 0.5, hi = Math.max(...gaps);
        for (let k = 0; k < 50; k++) {
            const m = (lo + hi) / 2;
            if (need(m) >= missing)
                lo = m;
            else
                hi = m;
        }
        const split = gaps.map(g => Math.max(0, Math.ceil(g / lo - 1e-9) - 1));
        let extra = split.reduce((n, v) => n + v, 0) - missing;
        // (one too many here and there: taken back where the pieces are shortest)
        const byPiece = split.map((v, q) => q).filter(q => split[q] > 0).sort((p, q) => gaps[p] / (split[p] + 1) - gaps[q] / (split[q] + 1));
        for (let k = 0; extra > 0 && k < byPiece.length; k++, extra--)
            split[byPiece[k]]--;
        const out = [];
        for (let q = 0; q < times.length; q++) {
            out.push(times[q]);
            if (q < gaps.length)
                for (let z = 1; z <= split[q]; z++)
                    out.push(Math.round(times[q] + gaps[q] * z / (split[q] + 1)));
        }
        return out;
    }

    async function generateAt(opts) {
        await load();
        // Quantum, 0 to 1 (true is 1): at 1 the whole map is quantum; lower, only some of its parts, fewer the lower,
        // and tamer: around 0.1 just a few runs bent onto lines and curves between grid notes like the Bezier tool's
        const qLevel = Math.min(1, Math.max(0, typeof opts.quantum === 'number' ? opts.quantum : opts.quantum ? 1 : 0));
        const fullQ = qLevel >= 0.999;
        opts = { ...opts, quantum: fullQ };
        // (a mixed map with the Streams / Jumps balance at an end is a stream map or a jump map)
        if (!opts.quantum && (!opts.patterns || opts.patterns === 'mixed') && opts.jumpShare !== undefined && (opts.jumpShare <= 0 || opts.jumpShare >= 1))
            opts = { ...opts, patterns: opts.jumpShare <= 0 ? 'streams' : 'jumps' };
        const progress = opts.progress || (() => { });
        const tick = () => new Promise(r => setTimeout(r));
        const a = await analyse(opts.buffer, progress);
        const difficulty = Math.min(10, Math.max(1, opts.difficulty || 5));
        // 1 = ~1.5 notes a second on average, 5 = ~5.5, 8 = ~17, 10 = ~27 asked for (about 15-24 comes out, like
        // human Tasukete maps at 15-26: the busiest bars keep a rhythm rather than filling every position). Hard maps
        // are hard from fast parts, big jumps and changing rhythm, not from a wall of even streams everywhere (the
        // peaks still reach 40+ notes a second; Density adds more)
        const nps = 1.5 * Math.pow(18, (difficulty - 1) / 9) * (opts.density || 1);

        progress('STUDYING THE SECTIONS AND DROPS');
        await tick();
        const ctx = {};
        let detected = null;
        if (opts.timing && opts.timing.length) {
            ctx.timing = opts.timing;
            ctx.triplet = isSwung(a.hits, 6000 / opts.timing[0].bpm, opts.timing[0].ms / 10);
        } else if (a.tempo) {
            // the timing point on a downbeat (the first beat of a bar), so bars and sections start where the music's do
            const beat = 60000 / a.tempo.bpm;
            detected = { ...a.tempo, offsetMs: a.tempo.offsetMs + findDownbeat(a, beat, a.tempo.offsetMs) * beat };
            ctx.timing = [{ bpm: detected.bpm, ms: detected.offsetMs }];
            ctx.triplet = a.tempo.triplet;
            ctx.shifts = a.tempo.steady ? null : a.tempo.shifts;
        }
        let times = ctx.timing ? chooseTimes(a, opts, nps, ctx) : chooseTimesFree(a, opts, nps);
        if (opts.gridFill > 0)
            times = fillGrid(times, a, opts, ctx);
        if (opts.count > 0)
            times = exactTimes(times, opts.count, opts.startMs, opts.endMs);
        // Similar to This Map: the bars that sound like a part of the map already mapped take it over, its rhythm
        // with its notes where it can (see similarParts)
        const simLevel = Math.min(1, Math.max(0, +opts.similarity || 0));
        const similar = simLevel > 0 ? similarParts(a, ctx, opts, times, simLevel) : [];
        const taken = similar.filter(m => m.take);
        const takenAt = ms => taken.some(m => ms >= m.from - 15 && ms < m.to - 15);
        if (taken.length) {
            const avoid = (opts.avoid || []).map(Number);
            const list = times.filter(t => !takenAt(t));
            for (const m of taken)
                for (const pt of m.pts)
                    if (!avoid.some(v => Math.abs(v - pt.ms) < 5))
                        list.push(pt.ms);
            times = list.sort((p, q) => p - q).filter((t, q, arr) => q === 0 || t - arr[q - 1] >= 5);
        }
        await tick();
        if (!times.length)
            return Object.assign([], { info: { bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady) } });

        // what to copy from: the learned maps, the map being made (preferred), and the example maps that come with it
        const entries = model.maps.slice();
        // (with Similar to This Map, the map's own notes even when its patterns aren't otherwise followed; and the
        // more similar, the more they're liked everywhere)
        const styleSrc = opts.styleNotes && opts.styleNotes.length ? opts.styleNotes : simLevel > 0 ? opts.similarNotes || [] : [];
        const style = styleSrc.filter(n => n.ms < opts.startMs || n.ms > opts.endMs);
        if (style.length >= 12) {
            const own = toEntry(style, 'this map');
            own.bonus = 0.12 + 0.5 * simLevel;
            entries.push(own);
        }
        // The maps it learned lead, always: every map loaded into the editor teaches it, and what it makes should look
        // like them. With jumps, streams or quantum asked for, the learned maps whose design is like that kind first
        // (and if none are, all of them still); otherwise one learned map leads, with the learned maps closest to its
        // design (copying from all of them at once gives a patchwork: a stretch in one map's design, then suddenly a
        // completely different one). The example maps that come with the editor only help out: wherever a learned
        // map has something that fits, it's used first.
        const learned = prepare(entries, qLevel > 0);
        // The quantum design: the average of the quantum maps it learned (the example's only if it learned none)
        let qlib = learned.filter(e => e.n >= 40 && e.style.off >= 0.2);
        let qBase = qLevel > 0 ? quantumProfile(qlib) : null;
        if (qLevel > 0 && !qBase) {
            qlib = prepare(exampleEntries().filter(e => e.kind === 'quantum'), true);
            qBase = quantumProfile(qlib);
        }
        const helpers = list => {
            for (const e of list)
                e.penalty = learned.length ? EXAMPLE_COST : 0;
            return list;
        };
        let lib = learned;
        const want = opts.quantum ? 'quantum' : opts.patterns === 'jumps' || opts.patterns === 'streams' ? opts.patterns : null;
        // (the song's rhythm against each map's, by the gap the notes spend half their time in, which comes out
        // about the same at 8, 9 and 10, so every difficulty of a song picks from the same maps)
        const usualGap = timeMedian(times.slice(1).map((t, q) => t - times[q]));
        const fit = e => Math.abs(Math.log((e.style.gapT || e.style.gap) / usualGap));
        if (want) {
            const kindEx = prepare(exampleEntries().filter(e => e.kind === want), !!opts.quantum);
            const ref = kindEx.map(e => e.style);
            const like = e => ref.length ? Math.min(...ref.map(r => styleDistance(e.style, r))) : 0;
            // (for quantum, the quantum maps it learned, whatever their design: the example only when there are none)
            const learnedQ = want === 'quantum' ? learned.filter(e => e.bonus || e.style.off >= 0.2) : [];
            let alike = learned.filter(e => e.bonus || like(e) < 2.2 || (want === 'quantum' && e.style.off >= 0.4));
            if (!alike.length)
                alike = learned.slice();
            alike = alike.sort((p, q) => like(p) - like(q)).slice(0, 8);
            lib = learnedQ.length ? learnedQ.slice(0, 10) : [...alike, ...helpers(kindEx)];
        } else {
            if (learned.length > 1) {
                let lead = learned.find(e => e.bonus);
                if (!lead) {
                    // (a jump map or a quantum map leads a mixed map only when it's all there is to go on)
                    const plain = learned.filter(e => e.style.off <= 0.4 && !(e.style.jumps > 0.45 && e.style.back > 0.3));
                    const ranked = (plain.length ? plain : learned).slice().sort((p, q) => fit(p) - fit(q)).slice(0, 3);
                    // (the same one for every difficulty of a song, picked by the song itself)
                    const songKey = Math.round(a.frames / 7) + Math.round(1000 * (ctx.timing && ctx.timing[0] ? ctx.timing[0].bpm : 0));
                    lead = ranked[(Math.imul(songKey, 2654435761) >>> 0) % ranked.length];
                }
                const near = learned.filter(e => e !== lead)
                    .map(e => ({ e, d: styleDistance(e.style, lead.style) + 0.6 * fit(e) }))
                    .filter(x => x.d < 3).sort((p, q) => p.d - q.d).slice(0, 9).map(x => x.e);
                lib = [lead, ...near];
            }
            // (the example maps help out while there are few learned maps)
            if (lib.length < 4)
                lib = [...lib, ...helpers(prepare(exampleEntries(), !!opts.quantum))];
        }
        // (one entry per map: a map that came with the editor and was learned too counts once)
        {
            const seen = new Set();
            lib = lib.filter(e => {
                const key = `${e.n}:` + Array.from(e.t.subarray(0, 24), (t, q) => `${Math.round((t - e.t[0]) / 10)},${posKey(e.x[q], e.y[q])}`).join(' ');
                if (seen.has(key))
                    return false;
                seen.add(key);
                return true;
            });
        }
        if (!lib.length)
            lib = prepare([defaultEntry()], !!opts.quantum);
        await tick();
        const fm = flowModel(lib);
        await tick();

        // how big the moves should be: like the learned maps (Jump Size and Patterns adjust it), bigger in intense
        // sections and drops and smaller in calm ones (human maps' moves differ 1.3-2x between sections over what the
        // number of notes alone makes them, more where the song is louder)
        const sections = ctx.sections || [];
        const styleScale = { streams: 0.6, jumps: 1.6 }[opts.patterns] || 1;
        // (harder maps jump further: 0.8x at 1, 1.15x at 8, about 1.5x at 10)
        const base = fm.move * (opts.jumpScale || 1) * styleScale * (0.8 + 0.05 * (difficulty - 1)) * (1 + 0.12 * Math.max(0, difficulty - 8));
        const boost = opts.dropBoost ?? 1;
        const free = rank(smooth(a.hits, 150));
        const levelAt = ms => {
            const s = sections.find(x => ms >= x.from && ms < x.to);
            const level = s ? s.level : free[Math.min(a.frames - 1, Math.max(0, Math.round(ms / 10)))] || 0.5;
            return 0.8 + 0.4 * level * (0.5 + 0.5 * boost) + (s && s.drop ? 0.1 * boost : 0);
        };
        const jumpAt = ms => base * levelAt(ms) * (ctx.jumpPart && ctx.jumpPart(ms) ? 1.6 : 1);
        // (how big the jumps on slow notes are by how intense the part is: 0.6 of a full jump in an intro or an outro,
        // the song's quietest parts, and full jumps from about a third of the way up: a medium part's slow notes
        // are real jumps, as in every human map; calm parts are calm by their speed and fewer notes)
        const calmAt = ms => {
            const s = sections.find(x => ms >= x.from && ms < x.to);
            return Math.min(1, Math.max(0.6, 0.6 + 2 * ((s ? s.level : 0.5) - 0.1)));
        };
        // the speed big moves are comfortable at (cells a second): about 19 at 8, 25 at 9 and 35 at 10 (human jump
        // maps at those levels jump at 25-35, whatever their style: a jump map's jumps are bigger where there's time
        // for them, not faster); Jump Size scales it too
        const comfort = 0.55 * 4 * Math.pow(1.36, difficulty - 1) * Math.max(1, opts.jumpScale || 1);
        const runOptions = {
            // (laps round the outside: less wanted where it has learned maps, whose own streams come first)
            ringWant: learned.length ? 0 : RING_WANT,
            // (a star rating past what this difficulty's own maps reach, see generate)
            force: !!opts.force,
            flow: opts.flow ?? 0.7, follow: opts.follow ?? 0.75, variety: opts.variety ?? 0.5, flowModel: fm, patterns: opts.patterns, quantum: !!opts.quantum,
            // how much the moves grow and shrink with the gaps (jump maps keep their jumps big even on quicker notes)
            beta: opts.patterns === 'jumps' ? 0.5 : 0.8,
            // how far apart in time notes have to be to always be jumps (see moveFor)
            // (a jump map jumps wherever two cells can be played comfortably: 1/8 notes at 128 BPM at 10, not at 8)
            // (never under 65ms: no human map jumps across the grid on notes closer than that)
            // (and in a quantum map from 60ms: its slides are the stream, every other note is a jump)
            jumpGap: opts.quantum ? 60 : opts.patterns === 'jumps' ? Math.max(65, 2000 / comfort) : opts.patterns === 'streams' ? 100 : 70, jumpScale: opts.jumpScale || 1,
            sizeWeight: 1.5 + 3.5 * Math.abs(Math.log((opts.jumpScale || 1) * styleScale)),
            comfort,
            // how fast a jump between quick notes may go next to the quick notes' own speed: a little faster at 10
            // (like human maps' jumps), slower and slower below
            // (quantum maps a step faster at 8: their jumps are their difficulty, with no grid streams to add any)
            // (in between, in between)
            pace: (() => {
                const at = [0.5, opts.quantum ? 0.85 : 0.65, 0.85, 1.15], d = Math.min(10, Math.max(7, difficulty)) - 7, i = Math.min(2, Math.floor(d));
                return at[i] + (at[i + 1] - at[i]) * (d - i);
            })(),
        };
        // (a mixed map's jump parts are placed like a jump map: its jumps, sized like a jump map's)
        const jumpRunOptions = { ...runOptions, patterns: 'jumps', beta: 0.5, jumpGap: Math.max(65, 2000 / comfort), sizeWeight: 1.5 + 3.5 * Math.abs(Math.log((opts.jumpScale || 1) * 1.6)) };


        // how fast one move may make the cursor go: comfortable for the difficulty (about 12 cells a second at 5)
        // (about 63 at 10, which the hardest human maps go past one move in ten)
        // (forced past 10: as much faster as the jumps are bigger, so spaced-out streams can be played at speed)
        const vmax = 4 * Math.pow(1.36, difficulty - 1) * (opts.force ? Math.pow(Math.max(1, opts.jumpScale || 1), 2) : 1);
        // what can physically be played: the top speed of a single move and how hard the cursor may turn round
        // (about what the hardest human maps reach at 10, far gentler at the easy end)
        const speedCap = Math.max(8, vmax * 1.6), accelCap = vmax * 160;
        const boundaries = sections.slice(1).map(x => x.from).filter(ms => ms > opts.startMs && ms < opts.endMs);

        // Quantum under 100%: which parts are quantum. As much of the song as the level (a little more: 0.1 is about a
        // sixth of it, 0.5 about three fifths), the more intense parts and drops first, in pieces of up to about 10
        // seconds; picked from the song itself, so 8, 9 and 10 pick the same. Each is either made quantum (jumps
        // and slides in the learned design, tamed to the level) or, more of them the lower the level, the grid's
        // notes with the quick ones between bent onto lines and curves (see bendCurves)
        const qParts = [];
        if (qLevel > 0 && !fullQ) {
            const from = Math.max(0, opts.startMs || 0), to = opts.endMs;
            let pieces = sections.filter(x => x.to > from && x.from < to)
                .map(x => ({ from: Math.max(x.from, from), to: Math.min(x.to, to), level: x.level, drop: !!x.drop }));
            if (!pieces.length)
                for (let t = from; t < to; t += 8000)
                    pieces.push({ from: t, to: Math.min(to, t + 8000), level: free[Math.min(a.frames - 1, Math.round((t + 4000) / 10))] || 0.5, drop: false });
            pieces = pieces.flatMap(x => {
                const k = Math.max(1, Math.round((x.to - x.from) / 10000)), w = (x.to - x.from) / k;
                return Array.from({ length: k }, (_, z) => ({ ...x, from: Math.round(x.from + z * w), to: z === k - 1 ? x.to : Math.round(x.from + (z + 1) * w) }));
            });
            const hash = (v, salt) => ((Math.imul(Math.round(v / 10) + salt * 7919 + a.frames, 2654435761) >>> 0) % 1000) / 1000;
            const total = pieces.reduce((t, x) => t + x.to - x.from, 0);
            const wantMs = Math.pow(qLevel, 0.75) * total;
            const genShare = Math.min(1, Math.max(0, (qLevel - 0.2) / 0.55));
            let got = 0;
            for (const x of pieces.slice().sort((p, q) => (q.level + (q.drop ? 0.3 : 0) + 0.35 * hash(q.from, 1)) - (p.level + (p.drop ? 0.3 : 0) + 0.35 * hash(p.from, 1)))) {
                if (got >= wantMs)
                    break;
                if (got + (x.to - x.from) / 2 > wantMs)
                    continue;
                got += x.to - x.from;
                qParts.push({ from: x.from, to: x.to, gen: hash(x.from, 2) < genShare });
            }
            qParts.sort((p, q) => p.from - q.from);
            for (const x of qParts)
                boundaries.push(x.from, x.to);
            boundaries.sort((p, q) => p - q);
        }
        const qPartAt = ms => qParts.find(x => ms >= x.from - 1 && ms < x.to);
        const qGenAt = ms => fullQ || !!(qParts.length && (qPartAt(ms) || {}).gen);
        const qCurveAt = ms => !fullQ && !!(qParts.length && qPartAt(ms) && !qPartAt(ms).gen);
        const anyGen = fullQ || qParts.some(x => x.gen);
        // (the design those parts follow, tamed to the level)
        const qp = qBase && anyGen ? profileAt(qBase, qLevel) : null;
        runOptions.qp = qp;
        runOptions.qlib = qlib.length ? qlib : null;
        jumpRunOptions.qp = qp;
        jumpRunOptions.qlib = runOptions.qlib;
        // (the made-quantum parts of a map that isn't all quantum, placed as a quantum map is)
        const qRunOptions = { ...runOptions, quantum: true, jumpGap: 60, patterns: 'mixed', beta: 0.8,
            pace: (() => {
                const at = [0.5, 0.85, 0.85, 1.15], d = Math.min(10, Math.max(7, difficulty)) - 7, k = Math.min(2, Math.floor(d));
                return at[k] + (at[k + 1] - at[k]) * (d - k);
            })() };

        // Quantum slides (with jumps, what quantum maps are made of): from some notes the cursor slides on for part of
        // the way to the next note, along a curve or a snaking line of notes so close together they play as one sweep
        // (about a third of a beat, going about as fast as the difficulty's moves), and the next note is a jump from
        // where it ends. Bars that repeat each other get them in the same places.
        const slides = new Map();
        if (anyGen && !opts.gridFill && ctx.bars && ctx.bars.length && ctx.timing) {
            const bars = ctx.bars;
            const rootOf = j => {
                while (bars[j].proto >= 0)
                    j = bars[j].proto;
                return j;
            };
            const barAt = t => {
                let lo = 0, hi = bars.length - 1;
                while (lo < hi) {
                    const m = (lo + hi + 1) >> 1;
                    if (bars[m].from - 20 <= t)
                        lo = m;
                    else
                        hi = m - 1;
                }
                return lo;
            };
            const beatAt = t => {
                let tp = ctx.timing[0];
                for (const p of ctx.timing)
                    if (p.ms <= t)
                        tp = p;
                return 60000 / tp.bpm;
            };
            const decided = new Map();
            // Slides a section at a time, like quantum maps: more likely the more intense the section, never in the
            // calm parts (an intro or a breakdown gets quantum jumps, not sweeps)
            // (which sections: the song's more intense ones, decided from the song itself, so a map at 8, 9 and 10
            // slides in the same parts; the most intense always, a medium one now and then, the calm ones never)
            const sectionOn = new Map();
            const topLevel = Math.max(0.05, ...sections.map(x => x.level));
            const slidesIn = t => {
                if (!qGenAt(t))
                    return false;
                const sec = sections.find(x => t >= x.from - 50 && t < x.to + 50);
                if (!sec)
                    return false;
                if (!sectionOn.has(sec)) {
                    const rel = sec.level / topLevel;
                    const pick = ((Math.imul(Math.round(sec.from / 10) + a.frames * 7, 2654435761) >>> 0) % 1000) / 1000;
                    sectionOn.set(sec, sec.level >= 0.3 && (rel >= 0.7 || (rel >= 0.5 && pick < (rel - 0.5) * 3.5)));
                }
                return sectionOn.get(sec);
            };
            // how strong the sound at a time is next to the notes around it (1 = as strong as they are on average):
            // the jump after a slide lands on the note after it, so slides go more often before strong sounds
            const strength = ms => {
                let m = 0;
                for (let f = Math.max(0, Math.round(ms / 10) - 2); f <= Math.min(a.frames - 1, Math.round(ms / 10) + 2); f++)
                    m = Math.max(m, a.beats[f], 0.6 * a.hits[f]);
                return m;
            };
            // the slides for a set of note times: after which note, how far apart their notes are, how many there are
            // and how many there's room for (leaving time for the jump after: a cell and a half at the top speed)
            const plan = main => {
                const list = [];
                for (let q = 0; q + 1 < main.length; q++) {
                    const beat = beatAt(main[q]), gap = main[q + 1] - main[q];
                    const step = Math.max(14, beat / 24);
                    // (leaving time for the jump after it, about a cell and a half at a comfortable speed, but never more
                    // than half the gap)
                    const room = gap - Math.min(0.45 * gap, Math.max(0.18 * beat, 1500 / speedCap, 1600 / runOptions.comfort));
                    // (at 9 and 10 a quarter of a beat is enough: the busy parts there have few longer gaps)
                    if (gap < (0.4 - 0.15 * Math.min(1, Math.max(0, difficulty - 8))) * beat || gap > 2 * beat || room < 3 * step || !slidesIn(main[q])
                        || takenAt(main[q]) || takenAt(main[q + 1]))
                        continue;
                    // (keyed by the position in the bar in 48ths of a beat, so a repeat whose bar starts a millisecond
                    // off from the rounding still gets the same slides)
                    const j = barAt(main[q]), key = `${rootOf(j)}:${Math.round((main[q] - bars[j].from) / (beat / 48))}`;
                    // (each slide its own length, a short flick to a long sweep; repeats of a bar keep theirs)
                    if (!decided.has(key)) {
                        let near = 0, cnt = 0;
                        for (let z = Math.max(0, q - 8); z <= Math.min(main.length - 1, q + 8); z++, cnt++)
                            near += strength(main[z]);
                        const rel = strength(main[q + 1]) / Math.max(1e-3, near / cnt);
                        // (in a section with slides, most of the room for them gets one: more of it at harder levels and
                        // before stronger sounds)
                        // (few at the easy end: one gap in ten at 3, half at 6, most from 8)
                        // (and as often as the learned design slides: about a third of a quantum map's notes in slides is
                        // the usual, more or fewer as its maps do)
                        const often = qp ? Math.min(1.6, Math.max(0.15, qp.slideShare / 0.35)) : 1;
                        const on = Math.random() < Math.min(0.92, 2.2 * SLIDE_CHANCE * often * Math.pow((difficulty - 1) / 9, 1.5) * Math.sqrt(Math.min(1.6, Math.max(0.4, rel))));
                        // (as a share of the room there is: a flick, a sweep or the whole of it)
                        decided.set(key, on ? [0.45, 0.65, 0.85, 1][Math.floor(Math.random() * 4)] : 0);
                    }
                    // (and never longer than the difficulty takes: a short flick at 3, up to about 0.6 of a beat at 10)
                    // (about as many notes as the learned design's slides have)
                    const n = Math.min(Math.floor(decided.get(key) * Math.min(room, (0.15 + 0.045 * difficulty) * beat) / step),
                        qp ? Math.max(3, Math.round(qp.slideLen * (0.5 + 0.9 * decided.get(key)))) : Infinity);
                    if (decided.get(key) && n >= 3)
                        list.push({ q, step, n, most: Math.max(n, Math.floor(room / step)) });
                }
                return list;
            };
            let list = plan(times);
            // A set number of notes counts the slides' notes too: the song is mapped again with as many fewer notes
            // as the slides add, and the slides are made a note or two longer or shorter to land on it exactly
            if (opts.count > 0 && list.length) {
                const added = list.reduce((n, l) => n + l.n, 0);
                let want = Math.round(opts.count * times.length / (times.length + added));
                // (and if the slides of the new times can't stretch to make up the rest, again with that many more)
                for (let round = 0; round < 4; round++) {
                    times = exactTimes(chooseTimes(a, { ...opts, count: Math.max(2, want) }, nps, ctx), Math.max(2, want), opts.startMs, opts.endMs);
                    list = plan(times);
                    let diff = opts.count - times.length - list.reduce((n, l) => n + l.n, 0);
                    for (let pass = 0; diff !== 0 && pass < 200; pass++) {
                        let changed = false;
                        for (const l of list) {
                            if (diff > 0 && l.n < l.most) {
                                l.n++;
                                diff--;
                                changed = true;
                            } else if (diff < 0 && l.n > 3) {
                                l.n--;
                                diff++;
                                changed = true;
                            }
                            if (!diff)
                                break;
                        }
                        if (!changed && diff < 0 && list.length) {
                            diff += list.splice(Math.floor(list.length / 2), 1)[0].n;
                            changed = true;
                        }
                        if (!changed)
                            break;
                    }
                    if (diff <= 0)
                        break;
                    want += diff;
                }
            }
            const withSlides = [];
            let li = 0;
            for (let q = 0; q < times.length; q++) {
                withSlides.push(times[q]);
                if (li < list.length && list[li].q === q) {
                    const { step, n } = list[li++];
                    slides.set(withSlides.length - 1, n);
                    for (let z = 1; z <= n; z++)
                        withSlides.push(Math.round(times[q] + z * step));
                }
            }
            times = withSlides;
        }
        const slideSpeed = Math.min(32, 4 + 0.45 * vmax, qp ? Math.max(8, 1.2 * qp.slideSpeed) : Infinity);
        // the move wanted into note i, `gap` ms after the one before
        const inSlide = new Uint8Array(times.length);
        for (const [q, n] of slides)
            for (let z = 1; z <= n && q + z < times.length; z++)
                inSlide[q + z] = 1;
        const fastAt = localFast(times, inSlide);
        // (the notes after the first of a slide in a jump part, see chooseTimes)
        const gridSlide = !opts.quantum && ctx.slideTimes && ctx.slideTimes.size ? Uint8Array.from(times, (ms, q) =>
            q > 0 && !qGenAt(ms) && ctx.slideTimes.has(Math.round(ms)) && ctx.slideTimes.has(Math.round(times[q - 1])) ? 1 : 0) : null;
        // how strong the sound at each note is (the kick and snare most): bigger moves go on the stronger ones
        const accents = Float32Array.from(times, ms => {
            let m = 0;
            for (let f = Math.max(0, Math.round(ms / 10) - 2); f <= Math.min(a.frames - 1, Math.round(ms / 10) + 2); f++)
                m = Math.max(m, a.beats[f], 0.6 * a.hits[f]);
            return Math.min(1.5, m);
        });

        // which kind of sound each note is on, the loudest of them there (0 kick, 1 snare, 2 hats, 3 melody, 4 bass):
        // stream shapes are picked from it, so the map's shapes change with the song's sounds (see findRun)
        const VOICES = ['kick', 'snare', 'hat', 'melody', 'bass'];
        const voice = Uint8Array.from(times, ms => {
            let best = 0, top = -1;
            VOICES.forEach((k, v) => {
                const env = a.sources[k];
                if (!env)
                    return;
                let m = 0;
                for (let f = Math.max(0, Math.round(ms / 10) - 2); f <= Math.min(a.frames - 1, Math.round(ms / 10) + 2); f++)
                    m = Math.max(m, env[f]);
                m *= a.sourceLevel && a.sourceLevel[k] !== undefined ? 0.5 + 0.5 * a.sourceLevel[k] : 1;
                if (m > top) {
                    top = m;
                    best = v;
                }
            });
            return best;
        });

        // In jump parts (jump maps, and a mixed map's jump parts) the weaker beats are short jumps, a cell or across
        // a corner, and the big ones go on the stronger sounds, as human jump maps do (about half their jumps are
        // short): otherwise every jump is two cells and a jump map is one long zigzag. Weaker: a note's sound next to
        // the notes around it.
        // (also where the beats are all about as strong: the weakest third of the notes around it, if a little weaker
        // than they are on average)
        const weakAt = Uint8Array.from(times, (ms, i) => {
            let sum = 0, cnt = 0, below = 0;
            for (let z = Math.max(0, i - 8); z <= Math.min(times.length - 1, i + 8); z++, cnt++) {
                sum += accents[z];
                if (accents[z] < accents[i])
                    below++;
            }
            const rel = accents[i] / Math.max(1e-3, sum / cnt);
            return rel < 0.7 ? 2 : rel < 0.92 || (below < cnt * 0.34 && rel < 0.99) ? 1 : 0;
        });
        const sizeAt = (i, gap) => {
            const jp = ctx.jumpPart && ctx.jumpPart(times[i]);
            const qi = qGenAt(times[i]);
            const o = qi && !fullQ ? qRunOptions : jp ? jumpRunOptions : runOptions;
            return moveFor(jumpAt(times[i]), gap, { ...o, comfort: runOptions.comfort * levelAt(times[i]), calm: calmAt(times[i]) }, fastAt[i],
                i >= 2 ? times[i - 1] - times[i - 2] : 0, i + 1 < times.length ? times[i + 1] - times[i] : 0, !qi && o.patterns === 'jumps' ? weakAt[i] : 0);
        };
        // map it a few times and keep the most balanced (fewer tries for long stretches, so it doesn't take ages)
        // (it hands the page back every few milliseconds so the editor never freezes, and stops trying once it has
        // spent about 20 seconds)
        let best = null;
        let tries = opts.tries || (times.length < 600 ? TRIES : times.length < 1500 ? 5 : 3);
        const started = performance.now();
        for (let t = 0; t < tries; t++) {
            const label = `MAPPING (TRY ${t + 1} OF ${tries})`;
            progress(label);
            await tick();
            let last = performance.now();
            const yieldNow = async done => {
                if (performance.now() - last < 25)
                    return;
                progress(`${label} ${Math.floor(done * 100)}%`);
                await tick();
                last = performance.now();
            };
            const trace = opts.trace ? [] : null;
            let notes = await place(times, lib, { ...opts, vmax, speedCap, accelCap, boundaries, runOptions, jumpRunOptions, jumpPart: ctx.jumpPart, yieldNow, trace, bars: ctx.bars, slides, slideSpeed, accents, levelAt, calmAt, sizeAt, fastAt, weakAt: opts.quantum ? null : weakAt, gridSlide, voice,
                similar, similarBonus: 0.3 + 1.0 * simLevel,
                qAt: qParts.length ? qGenAt : null, qRunOptions, qp }, jumpAt);
            if (qParts.some(x => !x.gen))
                notes = bendCurves(notes, qCurveAt, qLevel, trace);
            const score = badness(notes, sizeAt, vmax, fm, runOptions.flow, fullQ || qParts.some(x => x.gen), runOptions);
            if (!best || score < best.score)
                best = { notes, score, trace };
            const each = (performance.now() - started) / (t + 1);
            tries = Math.min(tries, Math.max(t + 1, Math.floor(20000 / each)));
        }
        if (opts.trace && best.trace)
            opts.trace.push(...best.trace);
        best.notes.info = {
            bpm: detected && detected.bpm, offsetMs: detected && detected.offsetMs, steady: !!(detected && detected.steady), times: times.length,
            quantumParts: qParts.map(x => ({ from: x.from, to: x.to, kind: x.gen ? 'quantum' : 'curves' })), quantumDesign: qp ? qp.maps : null,
            similar: similar.map(m => ({ from: m.from, to: m.to, srcFrom: m.srcFrom, sim: +m.sim.toFixed(2), take: m.take })),
            bars: ctx.bars ? ctx.bars.length : 0, repeats: ctx.bars ? ctx.bars.filter(b => b.proto >= 0).length : 0, barList: ctx.bars,
            sections: sections.map(s => ({ from: s.from, to: s.to, level: +s.level.toFixed(2), drop: s.drop, change: s.change, rate: s.rate && +s.rate.toFixed(1), nps: s.nps && +s.nps.toFixed(1) })),
        };
        return best.notes;
    }

    // DETECT BPM (the BPM Setup window and the Timing tab): the song's tempo between two times (the whole song if
    // `toMs` isn't after `fromMs`), the same detection the auto mapper times its notes by. Resolves to { bpm, offsetMs
    // (the first downbeat from `fromMs` on, so bars line up), steady (whether the beat holds all through) } or null
    // when it can't tell (under about 15 seconds, or no clear beat).
    async function detectBpm(buffer, fromMs = 0, toMs = 0, progress = () => { }) {
        const a = await analyse(buffer, progress);
        const f0 = Math.max(0, Math.floor(fromMs / 10));
        const f1 = toMs > fromMs ? Math.min(a.frames, Math.ceil(toMs / 10)) : a.frames;
        if (f1 - f0 < 1500)
            return null;
        progress('DETECTING THE BPM');
        const tempo = f0 === 0 && f1 === a.frames ? a.tempo : await findTempo(a.beats.subarray(f0, f1), a.hits.subarray(f0, f1), f1 - f0);
        if (!tempo || !(tempo.bpm > 0))
            return null;
        const beat = 60000 / tempo.bpm, offset = tempo.offsetMs + f0 * 10;
        const down = offset + findDownbeat(a, beat, offset) * beat;
        // (the first downbeat from where it starts, whole bars back from the one found)
        const bar = 4 * beat;
        const first = down - Math.floor((down - f0 * 10) / bar) * bar;
        return { bpm: tempo.bpm, offsetMs: Math.max(0, Math.round(first)), steady: !!tempo.steady };
    }

    // Bulk learning: reads every map file (.sspm, .rhm, .txt, .osu) and learns from it.
    // report(text, isError) shows progress. Resolves to { learned, known, failed }.
    async function learnFiles(files, report = () => { }) {
        const maps = files.filter(f => /\.(sspm|rhm|txt|osu)$/i.test(f.name));
        if (!maps.length) {
            report('PICK .SSPM, .RHM, .TXT OR .OSU MAPS', true);
            return { learned: 0, known: 0, failed: 0 };
        }
        let learned = 0, known = 0, failed = 0;
        for (let i = 0; i < maps.length; i++) {
            const f = maps[i];
            report(`LEARNING FROM MAP ${i + 1} OF ${maps.length}...`);
            await new Promise(r => setTimeout(r, 20));
            try {
                const map = new SSQE.Map();
                const name = f.name.toLowerCase();
                if (name.endsWith('.sspm'))
                    SSQE.Formats.readSspm(map, await f.arrayBuffer());
                else if (name.endsWith('.rhm'))
                    await SSQE.Formats.readRhm(map, await f.arrayBuffer(), f.name);
                else if (name.endsWith('.osu'))
                    SSQE.Formats.readOsu(map, await f.text());
                else
                    SSQE.Formats.readTxt(map, await f.text());
                const notes = map.notes.items.map(n => ({ x: n.x, y: n.y, ms: n.ms }));
                if (notes.length < 20)
                    failed++;
                else if (await learn(notes, map.props.songName || f.name))
                    learned++;
                else
                    known++;
            } catch (err) {
                console.warn(`Couldn't learn from ${f.name}`, err);
                failed++;
            }
        }
        const parts = [`LEARNED FROM ${learned} OF ${maps.length} MAPS`];
        if (known)
            parts.push(`${known} ALREADY LEARNED`);
        if (failed)
            parts.push(`${failed} UNREADABLE OR TOO SHORT`);
        report(parts.join(' - '), !learned && failed > 0);
        return { learned, known, failed };
    }

    load();
    return { learn, learnFiles, stats, statsSync, reset, generate, analyse, findTempo, findEvents, trimToStars, detectBpm, quantumStyleOf: notes => quantumStyleOf(toEntry(notes)) };
})();
