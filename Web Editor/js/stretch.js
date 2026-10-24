'use strict';

// Playback speed without the pitch changing (web only), for the editor and the map player: the decoded song is
// stretched here, the way the original editor's audio library (BASS, with SoundTouch) does it (WSOLA: the song cut
// into short overlapping pieces, each one played at its own speed and laid down a little further apart or closer
// together, every piece placed where it lines up best with the one before so the joins don't click or warble), and
// played straight through Web Audio. It used to be left to the browser's <audio> element, which at low speeds sounds
// glitchy and only says where it is every so often, so the timeline and the notes stuttered and jumped.
//
// Made a second or so at a time, a few seconds ahead of where the song is, each part queued to start exactly where
// the one before ends: it starts at once, works at any speed from 10% to 200%, and never holds a whole slowed-down copy
// of the song.
(function () {
    // (a mono mix of the song to line the pieces up by, made once a song)
    const monos = new WeakMap();
    function monoOf(buffer) {
        let m = monos.get(buffer);
        if (!m) {
            const l = buffer.getChannelData(0), r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;
            m = new Float32Array(buffer.length);
            for (let i = 0; i < m.length; i++)
                m[i] = r ? (l[i] + r[i]) * 0.5 : l[i];
            monos.set(buffer, m);
        }
        return m;
    }

    // Stretches `buffer` to `tempo` (0.5 = half speed) from `startSec` on: next(n) gives the next n pieces of the
    // stretched song, one Float32Array per channel
    class Stretcher {
        constructor(buffer, tempo, startSec) {
            this.sr = buffer.sampleRate;
            this.ch = Math.min(2, buffer.numberOfChannels);
            this.data = [];
            for (let c = 0; c < this.ch; c++)
                this.data.push(buffer.getChannelData(c));
            this.mono = monoOf(buffer);
            this.n = buffer.length;
            this.tempo = tempo;
            // (longer pieces and a wider search the slower it goes, as SoundTouch's automatic settings do: 90ms pieces
            // searched 20ms either way at half speed, 40ms and 15ms at double)
            const t = Math.min(2, Math.max(0.5, tempo));
            const seqMs = 90 - 50 * (t - 0.5) / 1.5, seekMs = 20 - 5 * (t - 0.5) / 1.5;
            this.ov = Math.max(16, Math.round(0.008 * this.sr));
            this.seq = Math.max(3 * this.ov, Math.round(seqMs / 1000 * this.sr));
            this.seek = Math.round(seekMs / 1000 * this.sr);
            this.hop = this.seq - this.ov;
            this.start = Math.round(startSec * this.sr);
            this.k = 0;
            this.prev = -1;
        }

        // where piece k would start in the song without any lining up
        nominal(k) {
            return this.start + Math.round(k * this.hop * this.tempo);
        }

        get done() {
            return this.nominal(this.k) >= this.n;
        }

        // the start near `around` whose first moment sounds most like the song carrying on from `ref` (normalised
        // cross-correlation over the overlap, every other sample: coarse steps of 4, then each sample around the best)
        best(ref, around) {
            const m = this.mono, ov = this.ov, n = this.n;
            const lo = Math.max(0, around - this.seek), hi = Math.min(n - ov - 1, around + this.seek);
            if (hi < lo || ref < 0 || ref + ov >= n)
                return Math.min(Math.max(around, 0), Math.max(0, n - 1));
            const score = s => {
                let dot = 0, e = 1e-9;
                for (let i = 0; i < ov; i += 2) {
                    const v = m[s + i];
                    dot += m[ref + i] * v;
                    e += v * v;
                }
                return dot / Math.sqrt(e);
            };
            let bestS = lo, top = -Infinity;
            for (let s = lo; s <= hi; s += 4) {
                const v = score(s);
                if (v > top) {
                    top = v;
                    bestS = s;
                }
            }
            for (let s = Math.max(lo, bestS - 3); s <= Math.min(hi, bestS + 3); s++) {
                const v = score(s);
                if (v > top) {
                    top = v;
                    bestS = s;
                }
            }
            return bestS;
        }

        next(pieces) {
            const hop = this.hop, ov = this.ov, n = this.n;
            const out = this.data.map(() => new Float32Array(pieces * hop));
            for (let j = 0; j < pieces; j++) {
                const k = this.k++;
                let s = this.nominal(k);
                const first = this.prev < 0;
                if (!first)
                    s = this.best(this.prev + hop, s);
                const o = j * hop;
                for (let c = 0; c < this.ch; c++) {
                    const d = this.data[c], dst = out[c];
                    for (let i = 0; i < hop; i++) {
                        const si = s + i;
                        let v = si >= 0 && si < n ? d[si] : 0;
                        // (the join: the piece before carrying on fades into this one over the overlap)
                        if (i < ov && !first) {
                            const pi = this.prev + hop + i;
                            const pv = pi >= 0 && pi < n ? d[pi] : 0;
                            const w = (i + 0.5) / ov;
                            v = pv * (1 - w) + v * w;
                        }
                        dst[o + i] = v;
                    }
                }
                this.prev = s;
            }
            return out;
        }
    }

    // Plays `buffer` at `tempo` from `startSec`, into `destination`: start() begins it a moment from now (startTime
    // says exactly when, on the audio context's clock), stop() ends it
    const CHUNK_SEC = 1, AHEAD_SEC = 3;
    class Stream {
        constructor(ctx, destination, buffer, tempo, startSec) {
            this.ctx = ctx;
            this.destination = destination;
            this.stretcher = new Stretcher(buffer, tempo, startSec);
            this.sources = [];
            this.stopped = false;
            this.startTime = 0;
            this.endTime = 0;
            this.produced = 0;
            this.lag = 0;
            this.timer = null;
        }

        // how far into the stretched song it has played (seconds of it), on the audio clock: the song's position is
        // startSec + elapsed() * tempo
        elapsed() {
            return Math.min(this.produced, Math.max(0, this.ctx.currentTime - this.startTime - this.lag));
        }

        start() {
            this.startTime = this.ctx.currentTime + 0.03;
            this.endTime = this.startTime;
            this.pump();
            // (kept topped up from a timer rather than the screen's frames, which slow down when nothing is moving)
            this.timer = setInterval(() => this.pump(), 200);
        }

        pump() {
            if (this.stopped)
                return;
            const st = this.stretcher;
            const pieces = Math.max(1, Math.ceil(CHUNK_SEC * st.sr / st.hop));
            // (a source that's finished is let go)
            this.sources = this.sources.filter(s => s.end > this.ctx.currentTime);
            // (and after a long stall, like a sleeping laptop, it starts again from now rather than in the past)
            if (this.endTime < this.ctx.currentTime) {
                const restart = this.ctx.currentTime + 0.03;
                this.lag += restart - this.endTime;
                this.endTime = restart;
            }
            while (!st.done && this.endTime - this.ctx.currentTime < AHEAD_SEC) {
                const data = st.next(pieces);
                const b = this.ctx.createBuffer(st.ch, data[0].length, st.sr);
                data.forEach((d, c) => b.copyToChannel(d, c));
                const src = this.ctx.createBufferSource();
                src.buffer = b;
                src.connect(this.destination);
                src.start(this.endTime);
                this.endTime += b.duration;
                this.produced += b.duration;
                this.sources.push({ src, end: this.endTime });
            }
        }

        stop() {
            this.stopped = true;
            clearInterval(this.timer);
            for (const { src } of this.sources) {
                try { src.stop(); } catch { }
                try { src.disconnect(); } catch { }
            }
            this.sources = [];
        }

        disconnect() { }
    }

    // A steady clock over the audio clock (web only): the audio context's time only moves on in steps (every few to
    // 20-odd milliseconds), so read straight it makes notes judder. This runs on the system clock and is eased
    // towards the audio clock a little each time it's read, never going back; a real jump (over 0.1s) is followed at
    // once. smooth(real) -> the smoothed time; rate: how fast real time runs against the system clock
    function steadyClock(rate = 1) {
        let pos = null, perf = 0, out = 0;
        return real => {
            const now = performance.now();
            if (pos === null) {
                pos = out = real;
                perf = now;
                return real;
            }
            let p = pos + (now - perf) / 1000 * rate;
            const err = real - p;
            p = Math.abs(err) > 0.1 ? real : p + err * 0.1;
            pos = p;
            perf = now;
            out = p < out && out - p < 0.1 ? out : p;
            return out;
        };
    }

    window.SSQEStretch = { Stretcher, Stream, steadyClock };
})();
