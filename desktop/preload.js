// The bridge between the editor (a web page) and the desktop app: Discord presence, files opened with the app,
// updates and playtesting in Rhythia.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ssqeDesktop', {
    version: ipcRenderer.sendSync('ssqe-version'),
    // { details, state } shown on Discord
    setPresence: presence => ipcRenderer.send('ssqe-presence', presence),
    // files the app was opened with (double-clicking a .ssqes or .sspm): cb([{ name, bytes: Uint8Array }])
    onOpenFiles: cb => {
        ipcRenderer.on('ssqe-open-files', (_, files) => cb(files));
        ipcRenderer.send('ssqe-ready');
    },
    // looks for a new release (when 'Check For Updates' is on); cb(text) shows how the update is going, null when done
    checkForUpdates: enabled => ipcRenderer.send('ssqe-check-updates', enabled),
    checkForUpdatesNow: () => ipcRenderer.send('ssqe-check-updates-now'),
    onUpdateProgress: cb => ipcRenderer.on('ssqe-update-progress', (_, text) => cb(text)),
    // before the app closes for an update: cb() saves what the editor has, then the app goes on
    onSaveForUpdate: cb => ipcRenderer.on('ssqe-save-for-update', async () => {
        try {
            await cb();
        } finally {
            ipcRenderer.send('ssqe-saved-for-update');
        }
    }),
    // playtesting in Rhythia: { Rhythia, Novastra } paths, choosing one, and starting a playtest
    playtestPaths: () => ipcRenderer.invoke('ssqe-playtest-paths'),
    pickPlaytestPath: game => ipcRenderer.invoke('ssqe-pick-playtest', game),
    playtest: job => ipcRenderer.invoke('ssqe-playtest', job),
    // CALCULATE SR/RP: Rhythia's star rating and ranked points for a map (body: the request), asked from the app
    starRating: body => ipcRenderer.invoke('ssqe-star-rating', body),
    // saving a map like the original editor: SAVE AS asks where (the .ini goes next to the .txt), SAVE writes there
    saveMapAs: (name, txt, ini) => ipcRenderer.invoke('ssqe-save-as', { name, txt, ini }),
    saveMapTo: (file, txt, ini) => ipcRenderer.invoke('ssqe-save-to', { file, txt, ini }),
    readIniFor: file => ipcRenderer.invoke('ssqe-read-ini', file),
    // OPEN EDITOR FOLDER: the folder maps are saved in, in the file manager
    openFolder: () => ipcRenderer.invoke('ssqe-open-folder'),
    // where a file that was opened or dropped is on the computer ('' when it isn't one)
    pathOf: file => {
        try {
            return webUtils.getPathForFile(file) || '';
        } catch {
            return '';
        }
    },
});
