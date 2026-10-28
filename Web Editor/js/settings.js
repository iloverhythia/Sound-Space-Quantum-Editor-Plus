'use strict';

// Port of the editor-relevant parts of Preferences/AllSettings.cs and SettingsManager.cs
(function () {
    const STORAGE_KEY = 'ssqe-web-editor-settings';

    // KeyboardEvent.code based keybinds
    const KEYBINDS = {
        selectAll: { key: 'KeyA', ctrl: true, alt: false, shift: false },
        save: { key: 'KeyS', ctrl: true, alt: false, shift: false },
        saveAs: { key: 'KeyS', ctrl: true, alt: false, shift: true },
        undo: { key: 'KeyZ', ctrl: true, alt: false, shift: false },
        redo: { key: 'KeyY', ctrl: true, alt: false, shift: false },
        copy: { key: 'KeyC', ctrl: true, alt: false, shift: false },
        paste: { key: 'KeyV', ctrl: true, alt: false, shift: false },
        cut: { key: 'KeyX', ctrl: true, alt: false, shift: false },
        delete: { key: 'Delete', ctrl: false, alt: false, shift: false },
        hFlip: { key: 'KeyH', ctrl: false, alt: false, shift: true },
        vFlip: { key: 'KeyV', ctrl: false, alt: false, shift: true },
        switchClickTool: { key: 'Tab', ctrl: false, alt: false, shift: false },
        quantum: { key: 'KeyQ', ctrl: true, alt: false, shift: false },
        // Ctrl+T is reserved by browsers, so the web version uses Alt+T
        openTimings: { key: 'KeyT', ctrl: false, alt: true, shift: false },
        openBookmarks: { key: 'KeyB', ctrl: true, alt: false, shift: false },
        storeNodes: { key: 'KeyS', ctrl: false, alt: false, shift: true },
        drawBezier: { key: 'KeyD', ctrl: false, alt: false, shift: true },
        anchorNode: { key: 'KeyA', ctrl: false, alt: false, shift: true },
        exportSSPM: { key: 'KeyE', ctrl: true, alt: true, shift: false },
        createBPM: { key: 'KeyB', ctrl: true, alt: false, shift: true },
    };

    const KEYBIND_LABELS = {
        selectAll: 'Select All', save: 'Save', saveAs: 'Save As', undo: 'Undo', redo: 'Redo', copy: 'Copy', paste: 'Paste',
        cut: 'Cut', delete: 'Delete', hFlip: 'Horizontal Flip', vFlip: 'Vertical Flip', switchClickTool: 'Switch Click Tool',
        quantum: 'Toggle Quantum', openTimings: 'Open BPM Setup', openBookmarks: 'Open Bookmarks', storeNodes: 'Store Bezier Nodes',
        drawBezier: 'Draw Bezier', anchorNode: 'Anchor Node', exportSSPM: 'Export SSPM', createBPM: 'Create BPM From Selection',
    };

    const GRID_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyA', 'KeyS', 'KeyD', 'KeyZ', 'KeyX', 'KeyC'];
    const NUMPAD_KEYS = ['Numpad7', 'Numpad8', 'Numpad9', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad1', 'Numpad2', 'Numpad3'];
    const PATTERN_KEYS = ['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

    const DEFAULTS = {
        waveform: true,
        classicWaveform: false,
        enableAutosave: true,
        autosaveInterval: 5,
        correctOnCopy: true,
        gridNumbers: false,
        approachSquares: false,
        autoplay: true,
        numpad: false,
        quantumGridLines: true,
        quantumGridSnap: true,
        metronome: false,
        separateClickTools: false,
        enableQuantum: false,
        autoAdvance: false,
        selectTool: false,
        curveBezier: true,
        gridLetters: true,
        reverseScroll: false,
        applyOnPaste: false,
        jumpPaste: false,
        pauseScroll: true,
        clampSR: true,
        pasteReversed: false,
        adjustNotes: false,
        monoAudio: false,
        muteSfx: false,
        muteMusic: false,
        smoothAutoplay: true,
        gridSquircles: true,
        oldQuantumSnap: false,
        scaleMetronome: false,
        moveOnGridKey: false,

        editorBGOpacity: 255,
        editorBackground: 'Default', // web only, see EDITOR_BACKGROUNDS
        autoMapDensity: 100, // web only: % of the density the auto mapper learned
        autoMapDifficulty: 5, // web only: 1..10 (before star targets; still read when autoMapStars isn't set)
        autoMapStars: 5, // web only: the star rating the auto mapper aims its maps at (Rhythia's SR)
        autoMapQuantum: false, // web only: (before the Quantum slider) the auto mapper may place notes off the 3x3 grid
        autoMapQuantumPct: 0, // web only: how much of an auto map is quantum, 0-100 (100: all of it)
        autoMapFlow: 70, // web only: auto mapper options (dialogs.autoMapOptions)
        autoMapFollow: 75,
        autoMapJump: 100,
        autoMapPatterns: 'mixed',
        autoMapJumpShare: 50, // web only: in a mixed auto map, how much of the song (its calmer parts) is jumps
        autoMapDrops: 100,
        autoMapVariety: 50,
        autoMapSources: 'kick,snare,hat', // web only: kinds of sound the auto mapper syncs to
        autoMapSensitivity: 50,
        autoMapFill: 'intense',
        autoMapCalm: 30,
        autoMapUseMap: true,
        autoMapSimilarity: 0, // web only: 0-100, how much of an auto map takes over the map's own parts that sound like it
        allowSpectators: true, // web only: when logged in, people can watch you map (SPECTATE)
        allowInvites: true, // web only: when logged in, people can invite you to map together (COLLABORATE)
        autoMapSetBpm: true,
        autoMapCount: 0, // web only: how many notes the auto mapper adds (0 = as many as the difficulty asks for)
        gridZoom: 100, // web only: size of the 3x3 grid in %
        gridNoteSize: 100, // web only: size of the notes on the grid in %
        cursorScale: 100, // web only: size of the custom grid cursor image (customassets.js), in %
        gridOpacity: 255,
        trackOpacity: 255,
        sfxOffset: 0,
        musicOffset: 0,
        bezierDivisor: 4,
        placeOverNotes: false, // web only: clicks on the grid place notes even where a note is showing
        maxPolyphony: 1,
        rotateBy: 90,
        scaleBy: 150,

        cursorPos: 40,
        approachRate: 14,
        masterVolume: 0.05,
        sfxVolume: 0.1,
        quantumSnapping: 0,
        quantumXOffset: 1,
        quantumYOffset: 1,

        color1: [0, 255, 200],
        color2: [255, 0, 255],
        color3: [255, 0, 100],
        color4: [90, 90, 90],
        color5: [255, 204, 0],
        noteColors: [[255, 0, 255], [0, 255, 200]],

        keybinds: KEYBINDS,
        gridKeys: GRID_KEYS,
        patterns: ['', '', '', '', '', '', '', '', '', ''],

        lastLeftNav: '',
        lastRightNav: '',
        modchartGame: 'Novastra',
        modchartStyle: 0,
        modchartDirection: 0,

        // settings screen (most only matter to the desktop renderer, but are kept so the screen matches)
        skipDownload: true,
        useVSync: false,
        checkUpdates: true,
        limitPlayerFPS: false,
        lowerBackgroundFPS: true,
        controlGradients: true,
        buttonGradients: false, // web only: the gradient on buttons (Show Control Gradients), off unless turned on
        msaa: true,
        waveformDetail: 5,
        fontScale: 1,
        gridSquircleDetail: 8,
        gridSquircleRadius: 0.125,
        fpsLimit: 60,
        createGame: 'Sound Space',
        mode3D: false,
        mode3DHitEffect: false,
        grid3DOpacity: 80,
        playtestGame: 'SSQE Player',
    };

    const clone = v => JSON.parse(JSON.stringify(v));

    function load() {
        const s = clone(DEFAULTS);
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const saved = JSON.parse(raw);
                for (const key of Object.keys(DEFAULTS)) {
                    if (!(key in saved))
                        continue;
                    if (key === 'keybinds')
                        Object.assign(s.keybinds, saved.keybinds);
                    else if (typeof saved[key] === typeof DEFAULTS[key])
                        s[key] = saved[key];
                }
                // (the old Quantum checkbox, on: the slider at 100%)
                if (!('autoMapQuantumPct' in saved) && saved.autoMapQuantum === true)
                    s.autoMapQuantumPct = 100;
            }
        } catch { /* storage unavailable */ }
        return s;
    }

    function save(s) {
        // (a spectator's copy of someone else's settings is never saved over the user's own)
        if (s && s.mirror)
            return;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
        } catch { /* storage unavailable */ }
    }

    // Settings.CompareKeybind + RefreshKeyMapping
    function compareKeybind(s, code, ctrl, alt, shift) {
        const result = [];
        if (code === 'Backspace')
            code = 'Delete';

        for (const [name, bind] of Object.entries(s.keybinds))
            if (bind.key === code && bind.ctrl === ctrl && bind.alt === alt && bind.shift === shift)
                result.push(name);

        const pattern = PATTERN_KEYS.indexOf(code);
        if (pattern >= 0)
            result.push(`pattern${pattern}`);

        if (ctrl || alt || shift)
            return result;

        const keys = s.numpad ? NUMPAD_KEYS : s.gridKeys;
        const i = keys.indexOf(code);
        if (i >= 0)
            result.push(`gridKey${i % 3}|${Math.trunc(i / 3)}`);

        return result;
    }

    function keyName(code) {
        return code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, '').replace(/^Arrow/, '');
    }

    function keybindText(bind) {
        return [bind.ctrl && 'CTRL', bind.alt && 'ALT', bind.shift && 'SHIFT', keyName(bind.key).toUpperCase()].filter(Boolean).join('+');
    }

    // web only: pictures the editor can use as its background (the map player's worlds plus the user's own image)
    const EDITOR_BACKGROUNDS = {
        'Default': 'background_editor',
        'Custom Image': null,
        // (the map player's worlds as its camera sees them, rendered at 3840x2160 so they're sharp on any screen)
        'Grid': 'backgrounds/grid',
        'Vaporwave': 'backgrounds/vaporwave',
        'Neon Tunnel': 'backgrounds/neon_tunnel',
        'Space Tunnel': 'backgrounds/space_tunnel',
        'Deep Space': 'backgrounds/deep_space',
        'Cubic': 'backgrounds/cubic',
    };

    function editorBackgroundImage(s) {
        const name = s.editorBackground || 'Default';
        if (name === 'Custom Image')
            return (window.SSQECustom && SSQECustom.state.imageUrl) || EDITOR_BACKGROUNDS.Default;
        return EDITOR_BACKGROUNDS[name] || EDITOR_BACKGROUNDS.Default;
    }

    SSQE.Settings = { EDITOR_BACKGROUNDS, editorBackgroundImage, DEFAULTS, KEYBINDS, KEYBIND_LABELS, GRID_KEYS, NUMPAD_KEYS, PATTERN_KEYS, load, save, clone, compareKeybind, keyName, keybindText };
})();
