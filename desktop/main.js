// Sound Space Quantum Editor Plus as a desktop app: the web editor and map player in their own window, served from
// the files that come with the app, with Discord rich presence, files opened with the app (.ssqes setups, .sspm
// maps) and a check for new releases.
const { app, BrowserWindow, protocol, net, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const update = require('./update');

// While updating, this is the new version's .exe in the download, started to put its files in place (update.js): it
// opens no window and closes when it's done
const finishJob = process.argv.find(a => a.startsWith(update.FLAG));
if (finishJob) {
    const job = finishJob.slice(update.FLAG.length);
    app.setPath('userData', path.join(path.dirname(job), 'helper-data'));
    app.disableHardwareAcceleration();
    update.finish(app, job);
    return;
}

const NAME = 'Sound Space Quantum Editor Plus';
const REPO = 'iloverhythia/Sound-Space-Quantum-Editor-Plus';
// Discord: the application whose name Discord shows, and the picture for the presence (a link, so it can be changed
// without uploading anything to Discord)
const DISCORD_CLIENT_ID = '1560459200541364264';
const DISCORD_IMAGE = 'https://iloverhythia.github.io/Sound-Space-Quantum-Editor-Plus/discord.png';

// the web editor, map player and changelog: next to this folder while developing, in resources/app when installed
const ROOT = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const START = 'ssqe://app/Web%20Editor/index.html';
const OPENABLE = /\.(ssqes|sspm|rhm|txt|ini|osu|mp3|ogg|wav|flac|m4a|opus)$/i;

app.setName(NAME);
if (process.platform === 'win32')
    app.setAppUserModelId('io.github.swellsthewells.ssqeplus');

// ------------------------------------------------ the pages, served as ssqe://app/...

protocol.registerSchemesAsPrivileged([{
    scheme: 'ssqe',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain',
    '.md': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.woff': 'font/woff',
    '.woff2': 'font/woff2', '.webm': 'video/webm', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.wav': 'audio/wav', '.obj': 'text/plain', '.wasm': 'application/wasm', '': 'text/plain',
};

// Files are sent in the parts asked for (byte ranges): videos and long songs need that to load and seek
function serve(request) {
    const url = new URL(request.url);
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    // nothing outside the app's own files
    if (file !== ROOT && !file.startsWith(ROOT + path.sep))
        return new Response('Not found', { status: 404 });
    let stat;
    try {
        stat = fs.statSync(file);
        if (stat.isDirectory()) {
            file = path.join(file, 'index.html');
            stat = fs.statSync(file);
        }
    } catch {
        return new Response('Not found', { status: 404 });
    }
    const size = stat.size;
    const headers = { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
    if (range && size > 0) {
        let start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size)
            return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
        return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
            status: 206,
            headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
        });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
}

// ------------------------------------------------ files opened with the app

let win = null, pageReady = false;
let pending = [];

function filesFrom(argv) {
    return argv.slice(1).filter(a => !a.startsWith('-') && OPENABLE.test(a) && fs.existsSync(a));
}

function sendFiles(paths) {
    if (!paths.length)
        return;
    if (!win || !pageReady) {
        pending.push(...paths);
        return;
    }
    const files = paths.map(p => ({ name: path.basename(p), bytes: new Uint8Array(fs.readFileSync(p)) }));
    win.webContents.send('ssqe-open-files', files);
}

// ------------------------------------------------ Discord rich presence

let rpc = null, rpcReady = false, rpcRetry = null;
let presence = { details: 'In the menu', state: '' }, presenceSince = Date.now(), sent = '';

function startDiscord() {
    clearTimeout(rpcRetry);
    try {
        const { Client } = require('@xhayper/discord-rpc');
        rpc = new Client({ clientId: DISCORD_CLIENT_ID });
        rpc.on('ready', () => {
            rpcReady = true;
            sent = '';
            pushPresence();
        });
        rpc.on('disconnected', () => {
            rpcReady = false;
            rpcRetry = setTimeout(startDiscord, 30000);
        });
        // Discord isn't open: try again in a while
        rpc.login().catch(() => {
            rpcReady = false;
            rpcRetry = setTimeout(startDiscord, 30000);
        });
    } catch {
        rpc = null;
    }
}

function pushPresence() {
    if (!rpc || !rpcReady || !rpc.user)
        return;
    const key = JSON.stringify(presence);
    if (key === sent)
        return;
    sent = key;
    rpc.user.setActivity({
        details: String(presence.details || NAME).slice(0, 128),
        state: presence.state ? String(presence.state).slice(0, 128) : undefined,
        startTimestamp: presenceSince,
        largeImageKey: DISCORD_IMAGE,
        largeImageText: `${NAME} ${app.getVersion()}`,
    }).catch(() => { sent = ''; });
}

ipcMain.on('ssqe-presence', (_, next) => {
    if (!next || typeof next !== 'object')
        return;
    // the timer starts again when what you're doing changes (menu, editing, playing)
    if (next.details !== presence.details && String(next.details).split(' - ')[0] !== String(presence.details).split(' - ')[0])
        presenceSince = Date.now();
    presence = { details: next.details, state: next.state };
    pushPresence();
});

ipcMain.on('ssqe-version', e => { e.returnValue = app.getVersion(); });
let startupChecked = false;
// the editor asks for the update check once it's open (it has the 'Check For Updates' setting)
ipcMain.on('ssqe-check-updates', (_, enabled) => {
    if (enabled !== false && !startupChecked) {
        startupChecked = true;
        setTimeout(() => checkForUpdate(false), 1500);
        // (and while it's open: a version that comes out meanwhile is offered then, not at the next start)
        setInterval(() => checkForUpdate(false), 10 * 60 * 1000);
    }
});
// the CHECK FOR UPDATES button
ipcMain.on('ssqe-check-updates-now', () => checkForUpdate(true));
ipcMain.on('ssqe-ready', () => {
    pageReady = true;
    const paths = pending;
    pending = [];
    sendFiles(paths);
});

// ------------------------------------------------ new releases

function newer(a, b) {
    const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++)
        if ((pa[i] || 0) !== (pb[i] || 0))
            return (pa[i] || 0) > (pb[i] || 0);
    return false;
}

// Auto update (Windows): the new release's zip is downloaded and unpacked, the new version's .exe from it is started
// to finish the update, the editor saves what it has and the app closes. The new .exe waits until it has, copies the
// new files over the old ones and starts the app again (update.js). Settings and maps are kept (they live in the
// user's app data, not next to the .exe). How it went is written to update-result.json in the app data and shown on
// the next start, and every step to update-log.txt. Where the app's folder can't be written to, the download page
// opens instead.
const resultFile = () => path.join(app.getPath('userData'), 'update-result.json');
const logFile = () => path.join(app.getPath('userData'), 'update-log.txt');
let updating = false, updateDir = null;

async function latestRelease() {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${NAME.replace(/ /g, '-')}/${app.getVersion()}` },
    });
    if (!res.ok)
        throw new Error(`GitHub answered ${res.status}`);
    return res.json();
}

// manual: from the CHECK FOR UPDATES button, which also says when there's nothing new (or the check failed)
let declined = null, asking = false;
async function checkForUpdate(manual = false) {
    if ((!app.isPackaged && !manual) || updating)
        return;
    const tell = (message, type = 'info') => manual && dialog.showMessageBox(win, { type, title: NAME, message, buttons: ['OK'] });
    let release;
    try {
        release = await latestRelease();
    } catch (e) {
        tell(`Couldn't check for updates: ${e.message}`, 'error');
        return;
    }
    if (!release.tag_name || !newer(release.tag_name, app.getVersion())) {
        tell(`You have the latest version (${app.getVersion()}).`);
        return;
    }
    const version = release.tag_name.replace(/^v/, '');
    // (a version offered already and put off isn't asked about again until the next one, or a check by hand)
    if ((!manual && declined === version) || asking)
        return;
    const asset = (release.assets || []).find(a => /^SSQEPlus.*\.zip$/i.test(a.name));
    const installDir = path.dirname(process.execPath);
    const canInstall = app.isPackaged && process.platform === 'win32' && asset && writable(installDir);
    asking = true;
    const { response } = await dialog.showMessageBox(win, {
        type: 'info',
        title: NAME,
        message: `${NAME} ${version} is out (you have ${app.getVersion()}).`,
        detail: `${String(release.body || '').split('\n---')[0].slice(0, 900)}${canInstall ? '' : `\n\n(The new version opens in your browser to download${asset && process.platform === 'win32' && app.isPackaged ? `: the app's folder (${installDir}) can't be written to` : ''}.)`}`,
        buttons: [canInstall ? 'Update Now' : 'Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
    });
    asking = false;
    if (response !== 0) {
        declined = version;
        return;
    }
    if (!canInstall) {
        shell.openExternal(release.html_url);
        return;
    }
    try {
        updating = true;
        await installUpdate(asset, installDir, version);
    } catch (e) {
        updating = false;
        progress(null);
        update.logger(logFile())('FAILED:', e.message);
        const again = await dialog.showMessageBox(win, {
            type: 'error', title: NAME, message: `The update couldn't be installed: ${e.message}`,
            buttons: ['Open Download Page', 'Close'], defaultId: 0, cancelId: 1,
        });
        if (again.response === 0)
            shell.openExternal(release.html_url);
    }
}

// what the last update did, told once on the next start
async function reportUpdate() {
    if (app.isPackaged)
        update.cleanUp(app.getPath('temp'), () => updateDir);
    let result;
    try {
        result = JSON.parse(fs.readFileSync(resultFile(), 'utf8').replace(/^﻿/, ''));
        fs.unlinkSync(resultFile());
    } catch {
        return;
    }
    if (result.ok && result.version === app.getVersion()) {
        progress(`UPDATED TO ${app.getVersion()}`);
        setTimeout(() => progress(null), 2500);
        return;
    }
    const { response } = await dialog.showMessageBox(win, {
        type: 'error', title: NAME,
        message: `The update to ${result.version || 'the new version'} didn't finish.`,
        detail: `${result.error || `The app is still ${app.getVersion()}.`}\n\nYou can download the new version and unzip it over this one. (What happened is in ${logFile()})`,
        buttons: ['Open Download Page', 'Close'], defaultId: 0, cancelId: 1,
    });
    if (response === 0)
        shell.openExternal(`https://github.com/${REPO}/releases/latest`);
}

function writable(dir) {
    try {
        const probe = path.join(dir, `.ssqe-write-test-${process.pid}`);
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}

// shows the download in the window (and on the taskbar button); null hides it
function progress(text, fraction = -1) {
    if (!win)
        return;
    win.setProgressBar(text === null ? -1 : fraction < 0 ? 2 : fraction);
    win.webContents.send('ssqe-update-progress', text);
}

async function installUpdate(asset, installDir, version) {
    const log = update.logger(logFile());
    log('updating', app.getVersion(), 'to', version, 'in', installDir);
    const dir = updateDir = path.join(app.getPath('temp'), `ssqe-plus-update-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const zip = path.join(dir, 'update.zip');

    progress('DOWNLOADING UPDATE...', 0);
    const res = await net.fetch(asset.browser_download_url);
    if (!res.ok || !res.body)
        throw new Error(`the download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || asset.size || 0;
    const out = fs.createWriteStream(zip);
    let done = 0, shown = -1;
    for await (const chunk of res.body) {
        done += chunk.length;
        if (!out.write(chunk))
            await new Promise(r => out.once('drain', r));
        const pct = total ? Math.floor(done / total * 100) : -1;
        if (pct !== shown) {
            shown = pct;
            progress(`DOWNLOADING UPDATE ${version}${pct >= 0 ? ` - ${pct}%` : '...'}`, total ? done / total : -1);
        }
    }
    await new Promise((resolve, reject) => out.end(err => err ? reject(err) : resolve()));
    if (total && done < total)
        throw new Error('the download was cut off');
    log('downloaded', done, 'bytes');

    const files = path.join(dir, 'files');
    shown = -1;
    await update.unzip(zip, files, f => {
        const pct = Math.floor(f * 100);
        if (pct !== shown) {
            shown = pct;
            progress(`UNPACKING UPDATE ${version} - ${pct}%`, f);
        }
    });
    const helper = path.join(files, path.basename(process.execPath));
    if (!fs.existsSync(helper))
        throw new Error("the update's zip doesn't have the app in it");
    log('unpacked to', files);

    progress('INSTALLING UPDATE - THE APP WILL RESTART');
    const job = path.join(dir, 'job.json');
    fs.writeFileSync(job, JSON.stringify({
        pid: process.pid, files, installDir, exe: process.execPath, result: resultFile(), version, log: logFile(),
    }));
    log('started the new version to finish, process', await update.launch(helper, [update.FLAG + job], files));
    await quitForUpdate();
}

// The editor saves what it has, then the app closes for real: an open map's 'save before closing?' guard mustn't
// keep it open (its files couldn't be replaced while it runs)
async function quitForUpdate() {
    if (win && !win.isDestroyed()) {
        win.webContents.on('will-prevent-unload', e => e.preventDefault());
        await Promise.race([
            new Promise(resolve => {
                ipcMain.once('ssqe-saved-for-update', resolve);
                win.webContents.send('ssqe-save-for-update');
            }),
            new Promise(resolve => setTimeout(resolve, 3000)),
        ]);
    }
    setTimeout(() => app.exit(0), 4000);
    app.quit();
}

// ------------------------------------------------ playtesting in Rhythia

// The games' paths are kept here, chosen with the file picker, never taken from the editor's settings (so a shared
// setup file can't make PLAYTEST start some other program)
const prefsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json');
function prefs() {
    try {
        return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    } catch {
        return {};
    }
}

// CALCULATE SR/RP: the map goes to Rhythia's star rating service, as the original editor sends it, from here rather
// than from the page (where the browser's cross-site rules could stop the answer being read)
ipcMain.handle('ssqe-star-rating', async (_, body) => {
    try {
        const res = await net.fetch('https://development.rhythia.com/api/getRawStarRating', {
            method: 'POST', body: String(body), headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
        return { ok: res.ok, status: res.status, text: await res.text() };
    } catch (err) {
        return { ok: false, status: 0, text: String(err && err.message || err) };
    }
});

ipcMain.handle('ssqe-playtest-paths', () => {
    const p = prefs();
    return { Rhythia: p.rhythiaPath || '', Novastra: p.novaPath || '' };
});

ipcMain.handle('ssqe-pick-playtest', async (_, game) => {
    const key = game === 'Novastra' ? 'novaPath' : 'rhythiaPath';
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        title: `Choose ${game === 'Novastra' ? 'Novastra' : 'Rhythia'}`,
        properties: ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }, { name: 'All Files', extensions: ['*'] }] : [],
    });
    if (canceled || !filePaths.length)
        return null;
    const p = prefs();
    p[key] = filePaths[0];
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
    return filePaths[0];
});

// Saving a map like the original editor: SAVE AS picks where the .txt goes (its .ini goes next to it, the same name),
// and from then on SAVE (and autosave) writes straight to those two files. Only .txt paths (and the .ini beside them)
// are ever written or read here.
const mapPath = file => typeof file === 'string' && path.isAbsolute(file) && /\.txt$/i.test(file) ? file : null;
function writeMap(file, txt, ini) {
    fs.writeFileSync(file, String(txt ?? ''));
    fs.writeFileSync(file.replace(/\.txt$/i, '.ini'), String(ini ?? ''));
}
// the editor's folder: where maps were last saved, or a folder of its own in Documents (made the first time)
function mapsDir() {
    const p = prefs();
    try {
        if (p.saveDir && fs.statSync(p.saveDir).isDirectory())
            return p.saveDir;
    } catch { /* gone: the default */ }
    const dir = path.join(app.getPath('documents'), NAME);
    try {
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    } catch {
        return app.getPath('documents');
    }
}
// OPEN EDITOR FOLDER (Settings, and its keybind): that folder in the file manager
ipcMain.handle('ssqe-open-folder', async () => {
    const dir = mapsDir();
    const err = await shell.openPath(dir);
    return err ? { error: err } : { ok: true, dir };
});
ipcMain.handle('ssqe-save-as', async (_, { name, txt, ini }) => {
    const p = prefs();
    const safe = String(name || 'map').replace(/[\\/:*?"<>|]/g, '_') || 'map';
    const dir = mapsDir();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: 'Save Map As',
        defaultPath: path.join(dir, `${safe}.txt`),
        filters: [{ name: 'Map', extensions: ['txt'] }],
    });
    if (canceled || !filePath)
        return null;
    const file = /\.txt$/i.test(filePath) ? filePath : `${filePath}.txt`;
    writeMap(file, txt, ini);
    p.saveDir = path.dirname(file);
    fs.mkdirSync(path.dirname(prefsFile()), { recursive: true });
    fs.writeFileSync(prefsFile(), JSON.stringify(p, null, 2));
    return file;
});
ipcMain.handle('ssqe-save-to', async (_, { file, txt, ini }) => {
    const f = mapPath(file);
    if (!f)
        return false;
    writeMap(f, txt, ini);
    return true;
});
// the .ini beside a .txt map that was opened, like the original editor reads it
ipcMain.handle('ssqe-read-ini', async (_, file) => {
    const f = mapPath(file);
    if (!f)
        return null;
    try {
        return fs.readFileSync(f.replace(/\.txt$/i, '.ini'), 'utf8');
    } catch {
        return null;
    }
});

// Like the original editor: the map as a .txt and the song next to it in a temp folder, and Rhythia started with
// --a=<audio> --t=<map> --sp=<speed> --sf=<start ms>
ipcMain.handle('ssqe-playtest', async (_, job) => {
    if (job && job.game === 'Novastra')
        return playtestNovastra(job);
    try {
        if (!job || job.game !== 'Rhythia')
            return { error: 'Only Rhythia and Novastra playtests are supported.' };
        const exe = prefs().rhythiaPath;
        if (!exe || !fs.existsSync(exe))
            return { error: 'INVALID RHYTHIA PATH [MENU > SETTINGS > PLAYER]' };
        const dir = path.join(app.getPath('temp'), 'ssqe-plus-playtest');
        fs.mkdirSync(dir, { recursive: true });
        const ext = /^(mp3|ogg|wav|flac|m4a)$/.test(job.audioExt) ? job.audioExt : 'mp3';
        const audio = path.join(dir, `tempaudio.${ext}`), txt = path.join(dir, 'tempmap.txt');
        fs.writeFileSync(audio, Buffer.from(job.audio));
        fs.writeFileSync(txt, String(job.txt));
        const slash = p => p.replace(/\\/g, '/');
        const args = [`--a=${slash(audio)}`, `--t=${slash(txt)}`, `--sp=${Number(job.tempo) || 1}`, `--sf=${Math.max(0, Math.floor(Number(job.startMs) || 0))}`];
        spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
    } catch (e) {
        return { error: `FAILED TO START RHYTHIA (${e.message})` };
    }
});

// Novastra, like the original editor: the song (audio.mp3 or .ogg), the chart (chart.nch) and its lyrics
// (lyrics.nlr) in a temp folder, and Novastra started in demo mode on it: --demo-mode -c=<folder>
// -m=<speed>,<ctrl>,<alt>,<shift> -f=<map id> -p=<start, seconds>
function playtestNovastra(job) {
    try {
        const exe = prefs().novaPath;
        if (!exe || !fs.existsSync(exe))
            return { error: 'INVALID NOVASTRA PATH [MENU > SETTINGS > PLAYER]' };
        const dir = path.join(app.getPath('temp'), 'ssqe-plus-novaPlaytest');
        fs.mkdirSync(dir, { recursive: true });
        for (const f of fs.readdirSync(dir))
            fs.rmSync(path.join(dir, f), { force: true, recursive: true });
        fs.writeFileSync(path.join(dir, `audio.${job.audioExt === 'ogg' ? 'ogg' : 'mp3'}`), Buffer.from(job.audio));
        fs.writeFileSync(path.join(dir, 'chart.nch'), String(job.nch || '{}'));
        if (job.nlr)
            fs.writeFileSync(path.join(dir, 'lyrics.nlr'), String(job.nlr));
        const flags = (job.keys || []).map(k => k ? 1 : 0);
        const args = ['--demo-mode', `-c=${dir.replace(/\\/g, '/')}`, `-m=${Number(job.tempo) || 1},${flags[0] || 0},${flags[1] || 0},${flags[2] || 0}`,
            `-f=${String(job.fileId || '').replace(/[^\w .-]/g, '_')}`, `-p=${Math.max(0, (Number(job.startMs) || 0) / 1000)}`];
        spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
    } catch (e) {
        return { error: `FAILED TO START NOVASTRA (${e.message})` };
    }
}

// ------------------------------------------------ the window

function createWindow() {
    win = new BrowserWindow({
        width: 1600,
        height: 900,
        minWidth: 960,
        minHeight: 540,
        title: NAME,
        backgroundColor: '#1e1e1e',
        icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
        autoHideMenuBar: true,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
    });
    win.once('ready-to-show', () => win.show());
    // links (feedback form, GitHub) open in the browser
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url))
            shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('ssqe://')) {
            e.preventDefault();
            if (/^https?:/i.test(url))
                shell.openExternal(url);
        }
    });
    // a reload (after importing a setup) asks for the opened files again
    win.webContents.on('did-start-navigation', (_, url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace)
            pageReady = false;
    });
    win.webContents.on('before-input-event', (e, input) => {
        if (input.type === 'keyDown' && input.key === 'F11') {
            win.setFullScreen(!win.isFullScreen());
            e.preventDefault();
        }
    });
    win.on('closed', () => { win = null; });
    win.loadURL(START);
}

if (!app.requestSingleInstanceLock())
    app.quit();
else {
    // opening another file while the app is open: it goes to this window
    app.on('second-instance', (_, argv) => {
        if (win) {
            if (win.isMinimized())
                win.restore();
            win.focus();
        }
        sendFiles(filesFrom(argv));
    });
    app.on('open-file', (e, file) => {
        e.preventDefault();
        sendFiles([file]);
    });
    pending.push(...filesFrom(process.argv));

    app.whenReady().then(() => {
        Menu.setApplicationMenu(null);
        protocol.handle('ssqe', serve);
        createWindow();
        startDiscord();
        win.webContents.once('did-finish-load', () => setTimeout(reportUpdate, 1200));
        app.on('activate', () => {
            if (!BrowserWindow.getAllWindows().length)
                createWindow();
        });
    });
    app.on('window-all-closed', () => {
        try {
            rpc && rpc.destroy();
        } catch { /* closing anyway */ }
        app.quit();
    });
}
