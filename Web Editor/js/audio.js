'use strict';

// Port of Audio/MusicPlayer.cs, SoundPlayer.cs and Waveform.cs using an <audio> element (pitch-preserving tempo)
// for playback and a decoded AudioBuffer for the waveform.
(function () {
    const VOLUME_MULT = 2;
    let ctx = null;

    function audioContext() {
        if (!ctx)
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === 'suspended')
            ctx.resume().catch(() => { });
        return ctx;
    }

    // ---------------------------------------------------------------- sound effects

    const buffers = {};
    let loadingSounds = null;

    function loadSounds() {
        if (!loadingSounds) {
            const ac = audioContext();
            loadingSounds = Promise.all(Object.entries(window.SSQE_SOUNDS || {}).map(async ([name, url]) => {
                try {
                    const res = await fetch(url);
                    buffers[name] = await ac.decodeAudioData(await res.arrayBuffer());
                } catch (e) {
                    console.warn('Failed to load sound', name, e);
                }
            }));
        }
        return loadingSounds;
    }

    const SoundPlayer = {
        settings: null,

        play(name, volume) {
            const s = SoundPlayer.settings;
            const buffer = buffers[name];
            if (!buffer || !s || s.muteSfx)
                return;

            const ac = audioContext();
            const src = ac.createBufferSource();
            src.buffer = buffer;
            const gain = ac.createGain();
            gain.gain.value = Math.max((volume ?? s.sfxVolume) * VOLUME_MULT, 0);
            src.connect(gain);
            gain.connect(ac.destination);
            src.start();
        },
    };

    // ---------------------------------------------------------------- music

    class MusicPlayer {
        constructor(settings) {
            this.settings = settings;
            this.el = null;
            this.url = null;
            this.state = 'stopped';
            this.pos = 0;
            this.basePos = 0;
            this.basePerf = 0;
            this.started = false;
            this.tempo = 1;
            this.duration = 0; // seconds
            this.ended = false;
            this.waveform = null;
            this.buffer = null; // decoded audio: played directly at 100% tempo for exact seeking
            this.node = null;
            this.baseCtx = 0;
            this.onEnded = null;
        }

        // MusicPlayer.MusicOffset (ms)
        get musicOffset() {
            return this.settings.musicOffset - 28;
        }

        get loaded() {
            return !!this.el;
        }

        async load(blob) {
            this.dispose();
            const ac = audioContext();

            const url = URL.createObjectURL(blob);
            const el = new Audio();
            el.preload = 'auto';
            el.preservesPitch = el.mozPreservesPitch = el.webkitPreservesPitch = true;

            await new Promise((resolve, reject) => {
                el.onloadedmetadata = resolve;
                el.onerror = () => reject(new Error('This audio file could not be decoded by your browser'));
                el.src = url;
            });

            this.el = el;
            this.url = url;
            this.duration = el.duration;

            this.gain = ac.createGain();
            if (this.settings.monoAudio) {
                this.gain.channelCount = 1;
                this.gain.channelCountMode = 'explicit';
            }
            this.source = ac.createMediaElementSource(el);
            this.source.connect(this.gain);
            this.gain.connect(ac.destination);
            this.updateVolume();

            el.addEventListener('playing', () => {
                if (this.state === 'playing' && !this.node) {
                    this.basePos = el.currentTime;
                    this.basePerf = performance.now();
                    this.started = true;
                }
            });
            el.addEventListener('ended', () => {
                this.ended = true;
            });
            // (the length known when the file opens is the browser's first guess, which for many mp3s is off; it's
            // put right when the browser knows better, and when the whole song has been decoded)
            el.addEventListener('durationchange', () => {
                if (this.el === el && !this.buffer && Number.isFinite(el.duration) && el.duration > 0)
                    this.duration = el.duration;
            });

            this.stop();

            // decode in the background for the waveform
            blob.arrayBuffer()
                .then(buf => ac.decodeAudioData(buf))
                .then(audio => {
                    if (this.el !== el)
                        return;
                    this.buffer = audio;
                    this.duration = audio.duration;
                    this.waveform = new Waveform(audio);
                })
                .catch(e => console.warn('Waveform decode failed', e));
        }

        // web only: <audio> seeking is inexact for many mp3s (especially in Safari), so once the song is decoded it's
        // played from that instead, which lands exactly where the timeline says; at other speeds stretched to them
        // without changing its pitch (stretch.js), smooth at any speed where the <audio> element's own stretching
        // warbles at low speeds and only says where it is every so often
        get useBuffer() {
            return !!this.buffer && (Math.abs(this.tempo - 1) < 1e-6 || !!window.SSQEStretch);
        }

        startBuffer() {
            this.stopBuffer();
            const ac = audioContext();
            if (Math.abs(this.tempo - 1) >= 1e-6) {
                const stream = new SSQEStretch.Stream(ac, this.gain, this.buffer, this.tempo, Math.min(Math.max(this.pos, 0), this.duration));
                stream.start();
                this.node = stream;
                this.basePos = this.pos;
                this.basePerf = performance.now();
                this.baseCtx = stream.startTime;
                this.started = true;
                return;
            }
            const node = ac.createBufferSource();
            node.buffer = this.buffer;
            node.connect(this.gain);
            node.start(0, Math.min(Math.max(this.pos, 0), this.duration));
            this.node = node;
            this.basePos = this.pos;
            this.basePerf = performance.now();
            this.baseCtx = ac.currentTime;
            this.started = true;
        }

        stopBuffer() {
            if (!this.node)
                return;
            try { this.node.stop(); } catch { }
            try { this.node.disconnect(); } catch { }
            this.node = null;
        }

        dispose() {
            this.stopBuffer();
            this.buffer = null;
            if (this.el) {
                this.el.pause();
                try { this.source.disconnect(); this.gain.disconnect(); } catch { }
                URL.revokeObjectURL(this.url);
            }
            this.el = null;
            this.waveform = null;
            this.state = 'stopped';
        }

        updateVolume() {
            if (this.gain)
                this.gain.gain.value = this.settings.muteMusic ? 0 : Math.max(this.settings.masterVolume * VOLUME_MULT, 0);
        }

        setTempo(t) {
            if (this.state === 'playing') {
                // switch between the decoded audio and the element when crossing 100%
                const ms = this.currentTimeMs();
                this.pause();
                this.tempo = t;
                if (this.el)
                    this.el.playbackRate = t;
                this.play(ms);
                return;
            }
            this.tempo = t;
            if (this.el)
                this.el.playbackRate = t;
        }

        get isPlaying() {
            return this.state === 'playing';
        }

        // Where playback is (seconds). The audio's own clock only moves in steps (every 10-40ms, more over
        // Bluetooth) and now and then lags behind a little, so the timeline runs on a steady clock of its own that's
        // eased towards the audio's a little every frame: smooth, and never stepping backwards. Only a real jump (the
        // audio stalled or skipped, a quarter of a second or more out) is followed straight away.
        mediaPos() {
            if (this.state !== 'playing' || !this.el)
                return this.pos;
            if (this.node) {
                const ac = audioContext();
                // (the audio isn't running, so nothing is playing: the timeline waits for it rather than running on
                // and jumping back when it starts)
                if (ac.state !== 'running') {
                    ac.resume && ac.resume().catch(() => { });
                    return this.steady(null);
                }
                const elapsed = this.node.elapsed ? this.node.elapsed() : ac.currentTime - this.baseCtx;
                const p = this.steady(this.basePos + elapsed * this.tempo);
                if (p >= this.duration)
                    this.ended = true;
                return Math.min(p, this.duration);
            }
            if (!this.started) {
                // some browsers don't fire 'playing' after a seek; treat the clock moving as started
                if (!this.el.paused && this.el.currentTime > this.basePos + 0.02) {
                    this.basePos = this.el.currentTime;
                    this.basePerf = performance.now();
                    this.started = true;
                }
                return this.steady(null);
            }
            return Math.min(this.steady(this.el.seeking ? null : this.el.currentTime), this.duration);
        }

        // the steady clock: real is where the audio says it is (null when it can't say, so it holds still)
        steady(real) {
            const now = performance.now();
            const c = this.clock;
            if (!c) {
                const start = real ?? this.basePos;
                this.clock = { pos: start, perf: now, out: start };
                return start;
            }
            if (real === null) {
                c.perf = now;
                return c.out;
            }
            let pos = c.pos + (now - c.perf) / 1000 * this.tempo;
            const err = real - pos;
            pos = Math.abs(err) > 0.25 ? real : pos + err * 0.1;
            c.pos = pos;
            c.perf = now;
            // (a little behind where it was shown: held there until it catches up, never drawn going back)
            const out = pos < c.out && c.out - pos < 0.25 ? c.out : pos;
            c.out = out;
            return out;
        }

        // MusicPlayer.CurrentTime getter (ms)
        currentTimeMs() {
            return this.mediaPos() * 1000 + this.musicOffset;
        }

        // MusicPlayer.CurrentTime setter (ms)
        seek(ms) {
            const p = Math.min(Math.max((ms - this.musicOffset) / 1000, 0), this.duration);
            this.clock = null;
            this.pos = p;
            this.basePos = p;
            this.basePerf = performance.now();
            if (this.node)
                this.startBuffer();
            else if (this.el)
                this.el.currentTime = p;
        }

        play(fromMs) {
            if (!this.el)
                return;
            audioContext();
            this.ended = false;
            this.state = 'playing';
            this.seek(fromMs);
            this.started = false;
            if (this.useBuffer) {
                this.el.pause();
                this.startBuffer();
                return;
            }
            this.el.playbackRate = this.tempo;
            const p = this.el.play();
            if (p)
                p.catch(() => { });
        }

        // returns the time playback stopped at
        pause() {
            const t = this.currentTimeMs();
            this.pos = this.mediaPos();
            this.clock = null;
            this.state = 'paused';
            this.stopBuffer();
            if (this.el)
                this.el.pause();
            return t;
        }

        stop() {
            this.stopBuffer();
            if (this.el)
                this.el.pause();
            this.state = 'stopped';
            this.seek(0);
        }
    }

    // ---------------------------------------------------------------- waveform

    // Waveform.Load: one left/right sample pair every 2ms (Settings.waveformDetail = 5), normalised to the peak
    class Waveform {
        constructor(audio) {
            this.resolution = 0.002;
            const per = audio.sampleRate * this.resolution;
            const length = audio.length;
            const count = Math.floor(length / per);
            const l = audio.getChannelData(0);
            const r = audio.numberOfChannels > 1 ? audio.getChannelData(1) : l;
            const left = new Float32Array(count);
            const right = new Float32Array(count);

            let peak = 0;
            for (let i = 0; i < count; i++) {
                const index = Math.min(length - 1, Math.round((i + 1) * per));
                left[i] = l[index];
                right[i] = r[index];
                peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
            }

            if (peak > 0)
                for (let i = 0; i < count; i++) {
                    left[i] /= peak;
                    right[i] /= peak;
                }

            this.left = left;
            this.right = right;
            this.count = count;
        }
    }

    SSQE.Audio = { audioContext, loadSounds, SoundPlayer, MusicPlayer, Waveform, VOLUME_MULT };
})();
