'use strict';

// Port of NewMaps/Parsing/TXT.cs, INI.cs, SSPM.cs and FormatUtils.cs
(function () {
    const { Note, TimingPoint, Bookmark, parseObject, DIFFICULTIES, clamp, fmt } = SSQE;

    // true: vfx, false: special
    const VFX_LOOKUP = [false, false, true, true, true, true, true, true, true, true, true, true, false, false, false, false, false, false];

    function fixId(id) {
        return [...id].map(c => /[0-9a-z-]/.test(c) ? c : /[A-Z]/.test(c) ? c.toLowerCase() : '_').join('');
    }

    // TXT.ReadObjects - splits on ',' and '|' while honouring "quoted \"strings\""
    function readObjects(data) {
        const result = [];
        let obj = [];
        let chars = '';
        let escaped = false, quoted = false;

        for (const c of data) {
            if (quoted) {
                if (escaped) {
                    escaped = false;
                    chars += c;
                    continue;
                }
                if (c === '\\')
                    escaped = true;
                else if (c === '"')
                    quoted = false;
                else
                    chars += c;
            } else {
                if (c === '"')
                    quoted = true;
                else if (c === '|') {
                    obj.push(chars);
                    chars = '';
                } else if (c === ',') {
                    obj.push(chars);
                    chars = '';
                    result.push(obj);
                    obj = [];
                } else
                    chars += c;
            }
        }

        obj.push(chars);
        result.push(obj);
        return result;
    }

    // FormatUtils timestamp delta encoding (ssmapv2)
    function decoder() {
        let total = 0, delta = 0;
        return ms => {
            delta += ms;
            total += delta;
            return total;
        };
    }

    // TXT.ReadData
    function readTxt(map, data) {
        const split = data.split('`');

        if (split.length === 1) {
            const mapData = readObjects(split[0].trim());
            map.soundId = mapData[0][0].trim();

            for (let i = 1; i < mapData.length; i++) {
                const sub = mapData[i];
                if (!sub.join('|').trim())
                    continue;

                const x = parseFloat(sub[0]);
                const y = parseFloat(sub[1]);
                const ms = parseInt(sub[2], 10);

                if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(ms))
                    throw new Error(`Note failed to parse: ${sub.join('|')}`);
                map.notes.add(new Note(x, y, ms));
            }

            return true;
        }

        if (split[0] !== 'ssmapv2')
            throw new Error(`Map format not supported - ${split[0]}`);

        map.soundId = split[1];
        const diffName = DIFFICULTIES[parseInt(split[2], 10)] || 'N/A';
        map.props.difficulty = diffName;
        map.props.customDifficulty = split[3] === diffName ? '' : split[3];

        const sets = split[4].split('/');
        for (let i = 0; i < sets.length; i++) {
            if (!sets[i].trim())
                continue;

            const decode = decoder();
            for (const fields of readObjects(sets[i])) {
                const obj = parseObject(i, fields);
                if (!obj)
                    continue;

                obj.ms = decode(obj.ms);

                if (obj instanceof Note)
                    map.notes.add(obj);
                else if (obj instanceof TimingPoint)
                    map.timingPoints.push(obj);
                else if (VFX_LOOKUP[i])
                    map.vfxObjects.add(obj);
                else
                    map.specialObjects.add(obj);
            }
        }

        return true;
    }

    // TXT.CopyLegacy (what the editor currently saves)
    function writeTxt(map, correctNotes = false) {
        map.notes.sort();
        const offset = Math.trunc(map.props.exportOffset);
        const final = [map.soundId.replace(/,/g, '')];

        for (const note of map.notes.items) {
            let x = note.x, y = note.y, ms = note.ms + offset;

            if (correctNotes) {
                x = clamp(x, -0.85, 2.85);
                y = clamp(y, -0.85, 2.85);
                ms = Math.trunc(clamp(ms, 0, map.duration));
            }

            final.push(`${fmt(x)}|${fmt(y)}|${ms}`);
        }

        return final.join(',');
    }

    // INI.ReadLegacy
    function readIniLegacy(map, data) {
        let oldVer = false;

        for (const line of data.split('\n')) {
            const split = line.split('=');
            const value = (split[1] || '').trim();

            switch (split[0]) {
                case 'BPM':
                    for (const point of value.split(',')) {
                        let ps = point.split('|');
                        if (ps.length === 1) {
                            ps = [ps[0], '0'];
                            oldVer = true;
                        }
                        const bpm = parseFloat(ps[0]), ms = parseInt(ps[1], 10);
                        if (ps.length === 2 && Number.isFinite(bpm) && Number.isFinite(ms))
                            map.timingPoints.push(new TimingPoint(bpm, ms));
                    }
                    map.sortTimings();
                    break;

                case 'Bookmarks':
                    for (const bookmark of value.split(',')) {
                        const bs = bookmark.split('|');
                        if (bs.length === 2 && /^-?\d+$/.test(bs[1]))
                            map.bookmarks.push(new Bookmark(bs[0], +bs[1], +bs[1]));
                        else if (bs.length === 3 && /^-?\d+$/.test(bs[1]) && /^-?\d+$/.test(bs[2]))
                            map.bookmarks.push(new Bookmark(bs[0], +bs[1], +bs[2]));
                    }
                    map.sortBookmarks();
                    break;

                case 'Offset': {
                    const offset = parseInt(value, 10);
                    if (!Number.isFinite(offset))
                        break;
                    if (oldVer) {
                        if (map.timingPoints.length)
                            map.timingPoints[0].ms = offset;
                    } else
                        setExportOffset(map, offset);
                    break;
                }

                case 'Time': {
                    const time = parseInt(value, 10);
                    if (Number.isFinite(time))
                        map.currentTime = time;
                    break;
                }

                case 'Divisor': {
                    const divisor = parseFloat(value);
                    if (Number.isFinite(divisor))
                        map.beatDivisor = divisor - 1;
                    break;
                }
            }
        }

        return true;
    }

    // notes are stored internally without the export offset
    function setExportOffset(map, offset) {
        for (const note of map.notes.items)
            note.ms += Math.trunc(map.props.exportOffset);
        map.props.exportOffset = offset;
        for (const note of map.notes.items)
            note.ms -= Math.trunc(map.props.exportOffset);
    }

    const STRING_PROPS = ['mappers', 'songName', 'difficulty', 'cover', 'customDifficulty', 'songOffset', 'songTitle', 'songArtist',
        'romanizedTitle', 'romanizedArtist', 'mapCreator', 'mapCreatorPersonalLink', 'previewStartTime', 'previewDuration',
        'novaCover', 'novaIcon', 'phxmPlatform', 'video'];

    // INI.Read
    function readIni(map, data) {
        let json;
        try {
            json = JSON.parse(data);
            if (!json || typeof json !== 'object' || Array.isArray(json))
                throw new Error('not an object');
        } catch {
            return readIniLegacy(map, data);
        }

        map.timingPoints = [];
        map.bookmarks = [];

        for (const [key, value] of Object.entries(json)) {
            try {
                switch (key) {
                    case 'songLinks':
                        map.songLinks = value || [];
                        break;
                    case 'artistLinks':
                        map.artistLinks = value || {};
                        break;
                    case 'mapperIds':
                        map.mapperIds = value || {};
                        break;
                    case 'timings':
                        for (const t of value)
                            map.timingPoints.push(new TimingPoint(Number(t[0]), Math.trunc(Number(t[1]))));
                        break;
                    case 'bookmarks':
                        for (const b of value)
                            map.bookmarks.push(new Bookmark(String(b[0] ?? ''), Math.trunc(Number(b[1])), Math.trunc(Number(b[b.length - 1]))));
                        break;
                    case 'vfxObjects':
                    case 'specialObjects': {
                        const list = key === 'vfxObjects' ? map.vfxObjects : map.specialObjects;
                        list.items = [];
                        for (const str of value) {
                            const obj = parseObject(null, readObjects(str)[0]);
                            if (obj)
                                list.add(obj);
                        }
                        list.sort();
                        break;
                    }
                    case 'noteData':
                        map.notes.sort();
                        for (const nd of value) {
                            const note = map.notes.items[nd[0]];
                            if (note) {
                                note.enableEasing = true;
                                note.style = nd[1];
                                note.direction = nd[2];
                            }
                        }
                        break;
                    case 'currentTime':
                        map.currentTime = Number(value) || 0;
                        break;
                    case 'beatDivisor':
                        map.beatDivisor = Number(value);
                        break;
                    case 'exportOffset':
                        setExportOffset(map, Number(value) || 0);
                        break;
                    case 'useCover':
                    case 'useVideo':
                        map.props[key] = !!value;
                        break;
                    case 'rating':
                        map.props.rating = Number(value) || 0;
                        break;
                    default:
                        if (STRING_PROPS.includes(key))
                            map.props[key] = value == null ? '' : String(value);
                        break;
                }
            } catch (e) {
                console.warn('Failed to read ini key', key, e);
            }
        }

        map.sortTimings();
        map.sortBookmarks();
        map.clearSelected();
        return true;
    }

    // INI.Write
    function writeIni(map) {
        map.notes.sort();
        const noteData = [];
        map.notes.items.forEach((n, i) => {
            if (n.enableEasing)
                noteData.push([i, n.style, n.direction]);
        });

        const p = map.props;
        const json = {
            songLinks: map.songLinks,
            artistLinks: map.artistLinks,
            mapperIds: map.mapperIds,

            timings: map.timingPoints.map(t => [t.bpm, t.ms]),
            bookmarks: map.bookmarks.map(b => [b.text, b.ms, b.endMs]),
            vfxObjects: map.vfxObjects.items.map(o => `${o.id}|${o.toString()}`),
            specialObjects: map.specialObjects.items.map(o => `${o.id}|${o.toString()}`),
            noteData,

            currentTime: map.currentTime,
            beatDivisor: map.beatDivisor,
            exportOffset: p.exportOffset,
        };

        for (const key of ['mappers', 'songName', 'difficulty', 'useCover', 'cover', 'customDifficulty', 'songOffset', 'songTitle', 'songArtist',
            'romanizedTitle', 'romanizedArtist', 'mapCreator', 'mapCreatorPersonalLink', 'previewStartTime', 'previewDuration',
            'novaCover', 'novaIcon', 'phxmPlatform', 'rating', 'useVideo', 'video'])
            json[key] = p[key];

        return JSON.stringify(json);
    }

    // ---------------------------------------------------------------- SSPM

    class Reader {
        constructor(buffer) {
            this.view = new DataView(buffer);
            this.bytes = new Uint8Array(buffer);
            this.o = 0;
        }
        u8() { return this.view.getUint8(this.o++); }
        bool() { return this.u8() !== 0; }
        u16() { const v = this.view.getUint16(this.o, true); this.o += 2; return v; }
        u32() { const v = this.view.getUint32(this.o, true); this.o += 4; return v; }
        u64() { const v = this.view.getBigUint64(this.o, true); this.o += 8; return Number(v); }
        f32() { const v = this.view.getFloat32(this.o, true); this.o += 4; return v; }
        take(n) { const v = this.bytes.slice(this.o, this.o + n); this.o += n; return v; }
        skip(n) { this.o += n; }
        str(four = false) { const len = four ? this.u32() : this.u16(); return new TextDecoder().decode(this.take(len)); }
        line() {
            const start = this.o;
            while (this.bytes[this.o] !== 0x0a)
                this.o++;
            const s = new TextDecoder().decode(this.bytes.slice(start, this.o));
            this.o++;
            return s;
        }
    }

    // SSPM.Read - returns { audio: Uint8Array|null, cover: Uint8Array|null }
    function readSspm(map, buffer) {
        const r = new Reader(buffer);
        const sig = new TextDecoder().decode(r.take(4));
        if (sig !== 'SS+m')
            throw new Error(`Unknown file type: ${sig} | Supported: SS+m V1/V2`);

        const version = r.u16();
        const result = { audio: null, cover: null };
        const setDifficulty = d => map.props.difficulty = DIFFICULTIES[d] || 'N/A';

        const readNote = isV2 => {
            const ms = r.u32();
            if (isV2)
                r.u8();
            const quantum = r.bool();
            const x = quantum ? r.f32() : r.u8();
            const y = quantum ? r.f32() : r.u8();
            map.notes.add(new Note(2 - x, 2 - y, ms));
        };

        if (version === 1) {
            r.skip(2);
            map.soundId = fixId(r.line());
            map.props.songName = r.line();
            map.props.mappers = r.line();

            r.u32(); // last ms
            const noteCount = r.u32();
            setDifficulty(r.u8());

            const containsCover = r.u8();
            map.props.useCover = containsCover === 0x02;
            if (containsCover === 0x02)
                result.cover = r.take(r.u64());

            if (r.bool())
                result.audio = r.take(r.u64());

            for (let i = 0; i < noteCount; i++)
                readNote(false);
            return result;
        }

        if (version !== 2)
            throw new Error(`Unknown file version: ${version} | Supported: SS+m V1/V2`);

        r.skip(4);
        r.skip(20); // hash
        r.u32(); // last ms
        const noteCount = r.u32();
        r.u32(); // marker count

        setDifficulty(r.u8());
        r.u16(); // rating
        const containsAudio = r.bool();
        const containsCover = r.bool();
        r.bool(); // requires mod

        r.u64(); r.u64(); // custom data offset/length
        const audioOffset = r.u64(), audioLength = r.u64();
        const coverOffset = r.u64(), coverLength = r.u64();
        const defOffset = r.u64();
        r.u64(); // marker definitions length
        const markerOffset = r.u64();
        r.u64(); // marker length

        map.soundId = fixId(r.str());
        map.props.songName = r.str();
        r.str(); // song name

        const mapperCount = r.u16();
        const mappers = [];
        for (let i = 0; i < mapperCount; i++)
            mappers.push(r.str());
        map.props.mappers = mappers.join('\n');
        map.props.mapCreator = mappers.join(' | ');

        try {
            const customCount = r.u16();
            for (let i = 0; i < customCount; i++) {
                const field = r.str();
                const type = r.u8();
                switch (type) {
                    case 0x00: break;
                    case 0x01: r.skip(1); break;
                    case 0x02: r.skip(2); break;
                    case 0x03: case 0x05: r.skip(4); break;
                    case 0x04: case 0x06: r.skip(8); break;
                    case 0x07: r.skip(r.bool() ? 8 : 2); break;
                    case 0x08: r.str(); break;
                    case 0x09: { const v = r.str(); if (field === 'difficulty_name') map.props.customDifficulty = v; break; }
                    case 0x0a: r.str(true); break;
                    case 0x0b: { const v = r.str(true); if (field === 'difficulty_name') map.props.customDifficulty = v; break; }
                    case 0x0c: r.skip(1); r.skip(r.u32()); break;
                }
            }
        } catch { /* custom data is optional */ }

        if (containsAudio && audioLength > 0)
            result.audio = new Uint8Array(buffer, audioOffset, audioLength).slice();

        map.props.useCover = containsCover;
        if (containsCover && coverLength > 0)
            result.cover = new Uint8Array(buffer, coverOffset, coverLength).slice();

        r.o = defOffset;
        let hasNotes = false;
        const numDefinitions = r.u8();
        for (let i = 0; i < numDefinitions; i++) {
            const def = r.str();
            hasNotes ||= def === 'ssp_note' && i === 0;
            r.u8();
            while (r.u8() !== 0x00);
        }

        if (!hasNotes)
            return result;

        r.o = markerOffset;
        for (let i = 0; i < noteCount; i++)
            readNote(true);

        return result;
    }

    class Writer {
        constructor() {
            this.chunks = [];
            this.length = 0;
        }
        push(bytes) { this.chunks.push(bytes); this.length += bytes.length; }
        u8(v) { this.push(new Uint8Array([v])); }
        bool(v) { this.u8(v ? 1 : 0); }
        u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.push(b); }
        u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
        u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.push(b); }
        f32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this.push(b); }
        zeros(n) { this.push(new Uint8Array(n)); }
        str(s) { const b = new TextEncoder().encode(s); this.u16(b.length); this.push(b); }
        concat() {
            const out = new Uint8Array(this.length);
            let o = 0;
            for (const c of this.chunks) {
                out.set(c, o);
                o += c.length;
            }
            return out;
        }
    }

    // SSPM.Write - meta: { songId, mapName, mappers, difficulty, customDifficulty }, audio/cover: Uint8Array
    function writeSspm(map, meta, audio, cover) {
        map.notes.sort();
        const exportOffset = Math.trunc(map.props.exportOffset) || 0;
        // web only: whole, non-negative times (a negative export offset would otherwise wrap around to ~49 days),
        // and no notes with broken positions
        const msOf = note => Math.max(0, Math.round(note.ms + exportOffset));
        const notes = map.notes.items.filter(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.ms));
        const w = new Writer();

        w.push(new Uint8Array([0x53, 0x53, 0x2b, 0x6d, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00]));

        w.zeros(20); // hash
        w.u32(notes.length ? msOf(notes[notes.length - 1]) : 0);
        w.u32(notes.length);
        w.u32(notes.length);

        w.u8(Math.max(0, DIFFICULTIES.indexOf(meta.difficulty)));
        w.zeros(2);
        w.bool(true);
        w.bool(!!cover);
        w.bool(false);

        const pointerIndex = w.chunks.length;
        w.zeros(80);

        w.str(meta.songId);
        w.str(meta.mapName);
        w.str(meta.mapName);

        const mappers = meta.mappers.split('\n');
        w.u16(mappers.length);
        for (const m of mappers)
            w.str(m);

        let customOffset = 0, customLength = 0;
        if (meta.customDifficulty.trim()) {
            customOffset = w.length;
            w.push(new Uint8Array([0x01, 0x00]));
            w.str('difficulty_name');
            w.u8(0x09);
            w.str(meta.customDifficulty);
            customLength = w.length - customOffset;
        } else
            w.zeros(2);

        const audioOffset = w.length;
        w.push(audio);
        const audioLength = audio.length;

        let coverOffset = 0, coverLength = 0;
        if (cover) {
            coverOffset = w.length;
            w.push(cover);
            coverLength = cover.length;
        }

        const defOffset = w.length;
        w.u8(0x01);
        w.str('ssp_note');
        w.push(new Uint8Array([0x01, 0x07, 0x00]));
        const defLength = w.length - defOffset;

        const markerOffset = w.length;

        for (const note of notes) {
            w.u32(msOf(note));
            w.u8(0x00);

            let quantum = Math.round(note.x) !== SSQE.round2(note.x) || Math.round(note.y) !== SSQE.round2(note.y);
            quantum ||= note.x < 0 || note.x > 2 || note.y < 0 || note.y > 2;
            w.bool(quantum);

            if (quantum) {
                w.f32(2 - note.x);
                w.f32(2 - note.y);
            } else {
                // rounded rather than cut off like the desktop editor does: a note at 1.001 (left by rotating or
                // scaling) would otherwise land on 2 - 0.999 -> 0, a whole cell away
                w.u8(Math.round(2 - note.x));
                w.u8(Math.round(2 - note.y));
            }
        }
        const markerLength = w.length - markerOffset;

        const pointers = new Writer();
        for (const v of [customOffset, customLength, audioOffset, audioLength, coverOffset, coverLength, defOffset, defLength, markerOffset, markerLength])
            pointers.u64(v);
        w.chunks[pointerIndex] = pointers.concat();

        return w.concat();
    }

    // ---------------------------------------------------------------- osu! map import (NewMaps/Parsing/OSU.cs)

    // returns the audio file name the .osu refers to (the caller loads it)
    function readOsu(map, data) {
        let timing = false, hitObj = false;
        let artist = '', title = '', audioPath = '';

        for (const raw of data.split('\n')) {
            const line = raw.trim();
            const sub = line.split(':');
            const set = line.split(',');

            if (!timing && !hitObj) {
                switch (sub[0]) {
                    case 'Artist': artist = (sub[1] || '').trim(); break;
                    case 'Title': title = (sub[1] || '').trim(); break;
                    case 'AudioFilename': audioPath = (sub[1] || '').trim(); break;
                }
            }

            if (timing && line) {
                const time = parseFloat(set[0]);
                let bpm = parseFloat(set[1]);
                if (Number.isFinite(time) && Number.isFinite(bpm)) {
                    const inherited = set.length > 6 ? set[6] === '1' : bpm > 0;
                    bpm = Math.abs(Math.round(60000 / bpm * 1000) / 1000);
                    if (bpm > 0 && inherited)
                        map.timingPoints.push(new TimingPoint(bpm, Math.trunc(time)));
                }
            }

            if (hitObj && line) {
                let x = parseFloat(set[0]), y = parseFloat(set[1]);
                const time = parseFloat(set[2]), type = parseInt(set[3], 10);
                if ([x, y, time, type].every(Number.isFinite)) {
                    x = 5 - x / 64;
                    y = 4 - y / 64;
                    if (type & 1)
                        map.notes.add(new Note(x, y, Math.trunc(time)));
                }
            }

            timing = line !== '[HitObjects]' && (timing || line === '[TimingPoints]');
            hitObj = line !== '[TimingPoints]' && (hitObj || line === '[HitObjects]');
        }

        if (audioPath)
            map.soundId = fixId(`${artist} - ${title}`);
        map.sortTimings();
        return audioPath || null;
    }

    // ---------------------------------------------------------------- zip (for .rhm)

    // Reads a zip's entries into { name: Uint8Array }. Stored and deflated entries are supported; deflate uses the
    // browser's DecompressionStream.
    async function readZip(buffer) {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        let end = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
            if (view.getUint32(i, true) === 0x06054b50) {
                end = i;
                break;
            }
        if (end < 0)
            throw new Error('Not a zip file');

        const count = view.getUint16(end + 10, true);
        let p = view.getUint32(end + 16, true);
        const files = {};
        const decoder = new TextDecoder();
        for (let n = 0; n < count; n++) {
            if (view.getUint32(p, true) !== 0x02014b50)
                throw new Error('Broken zip directory');
            const method = view.getUint16(p + 10, true);
            const compressed = view.getUint32(p + 20, true);
            const nameLength = view.getUint16(p + 28, true);
            const extraLength = view.getUint16(p + 30, true);
            const commentLength = view.getUint16(p + 32, true);
            const local = view.getUint32(p + 42, true);
            const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength));
            p += 46 + nameLength + extraLength + commentLength;

            const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
            const data = bytes.subarray(start, start + compressed);
            if (method === 0)
                files[name] = data.slice();
            else if (method === 8) {
                if (!window.DecompressionStream)
                    throw new Error('This browser can\'t unpack compressed files');
                const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
                files[name] = new Uint8Array(await new Response(stream).arrayBuffer());
            } else
                throw new Error(`Unsupported zip compression (${method})`);
        }
        return files;
    }

    // ---------------------------------------------------------------- Rhythia .rhm

    // A .rhm is a zip of "map" (JSON: notes, timing points, title, mappers, difficulty), "audio" and "cover".
    // Positions use the same orientation as SSPM, which is mirrored from the editor's.
    async function readRhm(map, buffer, fileName = '') {
        const files = await readZip(buffer);
        if (!files.map)
            throw new Error('This .rhm has no map data');
        const data = JSON.parse(new TextDecoder().decode(files.map));

        for (const n of data.Notes || [])
            map.notes.add(new Note(2 - n.X, 2 - n.Y, Math.round(n.Time)));
        for (const t of data.TimingPoints || [])
            if (t.Bpm > 0)
                map.timingPoints.push(new TimingPoint(t.Bpm, Math.round(t.OffsetMs)));

        const title = data.Title || data.SongName || '';
        map.soundId = fixId(title || fileName.replace(/\.[^.]*$/, '') || 'rhythia_map');
        map.props.songName = data.SongName || title;
        map.props.songTitle = title;
        map.props.mappers = (Array.isArray(data.Mappers) ? data.Mappers : [data.Mappers || '']).filter(Boolean).join('\n');
        map.props.difficulty = DIFFICULTIES[data.Difficulty] || 'N/A';
        map.props.customDifficulty = data.CustomDifficultyName || '';
        map.props.useCover = !!files.cover;
        map.sortAll && map.sortAll();

        return { audio: files.audio || null, cover: files.cover || null };
    }

    // Rhythia .rhm: the "map" JSON as Rhythia writes it. Coordinates are mirrored like in SSPM.
    // meta: { songId, mapName, mappers (one per line), difficulty, customDifficulty, duration (ms) }
    function writeRhmMap(map, meta) {
        map.notes.sort();
        const exportOffset = Math.trunc(map.props.exportOffset) || 0;
        const r = v => Math.round(v * 1e6) / 1e6;
        const mappers = meta.mappers.split('\n').map(m => m.trim()).filter(Boolean);
        const notes = map.notes.items.map(n => ({ Time: n.ms + exportOffset, X: r(2 - n.x) || 0, Y: r(2 - n.y) || 0 }));
        const data = {
            OnlineId: null,
            OnlineStatus: null,
            LegacyId: null,
            SongName: meta.mapName,
            Mappers: mappers.length ? mappers : ['None'],
            Title: meta.mapName,
            Duration: Math.round(meta.duration || (notes.length ? notes[notes.length - 1].Time : 0)),
            Difficulty: Math.max(0, DIFFICULTIES.indexOf(meta.difficulty)),
            CustomDifficultyName: meta.customDifficulty.trim() || null,
            StarRating: 0,
            Notes: notes,
            AudioFileName: `${meta.songId}.mp3`,
            ImagePath: 'cover',
            AudioTimingMode: 'Native',
            TimingPoints: map.timingPoints.map(t => ({ OffsetMs: t.ms + exportOffset, Bpm: t.bpm })),
        };
        return new TextEncoder().encode(JSON.stringify(data));
    }


    // ---------------------------------------------------------------- Novastra (NPK.WriteNCH / WriteNLR)

    // The chart Novastra plays (chart.nch, JSON): the notes (Novastra's grid is mirrored left to right and centred on
    // the middle cell), mines, beats, glides, fever and tempo events, as the desktop editor writes it for a playtest
    function writeNch(map) {
        const notes = map.notes.items.map(n => {
            const o = { x: 1 - n.x, y: n.y - 1, t: n.ms };
            if (n.enableEasing)
                o.e = { s: n.style | 0, d: n.direction | 0 };
            return o;
        });
        const beats = [], glides = [], events = [];
        const special = map.specialObjects.items.slice().sort((a, b) => a.ms - b.ms);
        const valid = special.filter(o => o.id === 12 || o.id === 13 || o.id === 14);
        const lastMs = Math.max(map.notes.items.length ? map.notes.items[map.notes.items.length - 1].ms : 0, valid.length ? valid[valid.length - 1].ms : 0);
        let prevFever = null;
        for (const o of special) {
            if (o.id === 12)
                beats.push({ t: o.ms });
            else if (o.id === 13)
                glides.push({ t: o.ms, d: (['up', 'right', 'down', 'left'][o.direction] || 'none') });
            else if (o.id === 14)
                notes.push({ x: 1 - o.x, y: o.y - 1, t: o.ms, m: true });
            else if (o.id === 16 && o.ms < lastMs) {
                const from = Math.max(prevFever ?? 0, o.ms);
                prevFever = o.ms + o.duration;
                events.push({ type: 'fever', t: from, active: true });
                events.push({ type: 'fever', t: Math.min(o.ms + o.duration, lastMs), active: false });
            }
        }
        for (const p of map.timingPoints)
            events.push({ type: 'tempo', t: p.ms, bpm: p.bpm });
        const byT = (a, b) => a.t - b.t;
        const songOffset = parseInt(map.props.songOffset, 10) || 0;
        return JSON.stringify({
            songOffset: songOffset - (Math.trunc(map.props.exportOffset) || 0),
            notes: notes.sort(byT), beats: beats.sort(byT), glides: glides.sort(byT), events: events.sort(byT),
        });
    }

    // Its lyrics (lyrics.nlr): "ms|properties|text" a line, or '' when there are none
    function writeNlr(map) {
        const lines = [];
        for (const l of map.specialObjects.items.filter(o => o.id === 15).sort((a, b) => a.ms - b.ms)) {
            let text = l.text || '', props = '';
            if (!text.trim() && !l.fadeOut)
                props += 'r';
            if (text.startsWith('-')) {
                props += 'r';
                text = text.slice(1);
            }
            if (text.endsWith('-')) {
                props += 'n';
                text = text.slice(0, -1);
            }
            if (l.fadeIn)
                props += 'i';
            if (l.fadeOut)
                props += 'o';
            lines.push(`${l.ms}|${props || 'x'}|${text}`);
        }
        return lines.join('\n');
    }

    // ---------------------------------------------------------------- Rewrite (PHXM.Write)

    // A .phxm (a zip): metadata.json, objects.phxmo (the notes: little-endian, as the desktop editor writes them;
    // Rewrite's grid is mirrored left to right), the audio and, if any, the cover. Resolves to the zip's bytes.
    async function writePhxm(map, meta, audio, cover) {
        const head = new Uint8Array(await audio.slice(0, 4).arrayBuffer());
        const ext = String.fromCharCode(...head) === 'OggS' ? 'ogg'
            : (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) ? 'mp3' : 'asset';
        const notes = map.notes.items;
        const isWhole = v => Math.abs(v - Math.round(v)) < 1e-6;
        let size = 8 + 4 * 11;
        for (const n of notes)
            size += 5 + (isWhole(n.x) && isWhole(n.y) ? 2 : 8);
        const buf = new ArrayBuffer(size), v = new DataView(buf);
        let o = 0;
        v.setInt32(o, 12, true); o += 4;
        v.setInt32(o, notes.length, true); o += 4;
        for (const n of notes) {
            const quantum = !(isWhole(n.x) && isWhole(n.y));
            v.setUint32(o, Math.max(0, Math.round(n.ms)), true); o += 4;
            v.setUint8(o++, quantum ? 1 : 0);
            if (quantum) {
                v.setFloat32(o, 1 - n.x, true); o += 4;
                v.setFloat32(o, n.y - 1, true); o += 4;
            } else {
                v.setUint8(o++, 2 - Math.round(n.x));
                v.setUint8(o++, Math.round(n.y));
            }
        }
        const json = {
            Artist: meta.artist || '', AudioExt: ext, Difficulty: Math.max(0, DIFFICULTIES.indexOf(meta.difficulty)),
            DifficultyName: meta.customDifficulty || meta.difficulty || 'N/A', HasAudio: true, HasCover: !!cover, HasVideo: false,
            ID: fixId(`${meta.mappers.split('\n')[0] || 'None'} - ${meta.artist || ''} - ${meta.title || ''}`),
            Mappers: meta.mappers.split('\n'), Rating: +meta.rating || 0, Title: meta.title || '',
            ArtistLink: meta.artistLink || '', ArtistPlatform: meta.artistPlatform || '', Length: Math.round(meta.duration || 0),
        };
        const files = [
            { name: 'metadata.json', blob: new Blob([JSON.stringify(json, null, 2)]) },
            { name: 'objects.phxmo', blob: new Blob([buf]) },
            { name: `audio.${ext}`, blob: audio },
        ];
        if (cover)
            files.push({ name: 'cover.png', blob: new Blob([cover]) });
        return SSQE.zipFiles(files);
    }

    SSQE.Formats = { VFX_LOOKUP, fixId, readObjects, readTxt, writeTxt, readIni, writeIni, readSspm, writeSspm, readOsu, setExportOffset, readZip, readRhm, writeRhmMap, writeNch, writeNlr, writePhxm };
})();
