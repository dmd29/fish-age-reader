// Fish Age Reader - main process.
// Handles everything that touches the disk; the window (renderer) never sees file paths
// beyond the folder the user picked, so image names stay hidden from the reader.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp', '.tif', '.tiff']);
const RESULTS_FILE = 'age_readings.csv';
const MEASUREMENTS_FILE = 'measurements.csv';
const SCALE_FILE = 'scale_settings.json';
const ANNOTATED_DIR = 'annotated';
const DEFAULT_PROFILES = ['Obs 1', 'Obs 2', 'Obs 3'];

// Automated tests run with their own settings folder so they never touch the user's profiles.
if (process.env.FAR_TEST_USER_DATA) app.setPath('userData', process.env.FAR_TEST_USER_DATA);

let win;
let currentFolder = null; // only folder the renderer may read from / write to

function profilesFile() {
  return path.join(app.getPath('userData'), 'profiles.json');
}

function loadProfiles() {
  try {
    const list = JSON.parse(fs.readFileSync(profilesFile(), 'utf8'));
    if (Array.isArray(list) && list.length) return list.map(String);
  } catch (_) { /* first run or unreadable: fall back to defaults */ }
  return DEFAULT_PROFILES.slice();
}

function saveProfiles(list) {
  fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
  fs.writeFileSync(profilesFile(), JSON.stringify(list, null, 2), 'utf8');
}

function requireFolder() {
  if (!currentFolder) throw new Error('No image folder selected.');
  return currentFolder;
}

// Resolve a bare file name inside the current folder, refusing anything that escapes it.
function insideFolder(name) {
  const folder = requireFolder();
  const base = path.basename(String(name));
  if (base !== name) throw new Error('Invalid file name.');
  return path.join(folder, base);
}

function listImages(folder) {
  return fs.readdirSync(folder, { withFileTypes: true })
    .filter(d => d.isFile() && IMAGE_EXT.has(path.extname(d.name).toLowerCase()))
    .map(d => d.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function friendlyWriteError(err, file) {
  if (err && (err.code === 'EBUSY' || err.code === 'EPERM')) {
    return `Could not write "${file}". It may be open in Excel or another program - close it and try again.`;
  }
  return `Could not write "${file}": ${err.message}`;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    title: 'Fish Age Reader',
    backgroundColor: '#1d2126',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  // Keep the window title fixed so image names never leak into it.
  win.on('page-title-updated', e => e.preventDefault());
}

ipcMain.handle('profiles:get', () => loadProfiles());
ipcMain.handle('profiles:set', (_e, list) => {
  const clean = [...new Set((list || []).map(s => String(s).trim()).filter(Boolean))];
  saveProfiles(clean);
  return clean;
});

ipcMain.handle('folder:pick', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Select the folder with the scale / otolith photographs',
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  currentFolder = res.filePaths[0];
  return { folder: currentFolder, images: listImages(currentFolder) };
});

ipcMain.handle('folder:rescan', () => listImages(requireFolder()));

ipcMain.handle('image:read', (_e, name) => {
  const file = insideFolder(name);
  const ext = path.extname(file).toLowerCase();
  const data = fs.readFileSync(file);
  if (ext === '.tif' || ext === '.tiff') {
    // Chromium cannot display TIFF, so decode it here to raw RGBA pixels.
    const UTIF = require('utif');
    const ifds = UTIF.decode(data);
    const page = ifds[0];
    UTIF.decodeImage(data, page, ifds);
    const rgba = UTIF.toRGBA8(page);
    return { kind: 'rgba', width: page.width, height: page.height, data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
  }
  const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.bmp': 'image/bmp', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
  return { kind: 'encoded', mime, data };
});

// Files the app keeps next to the images. The window can only name one of these keys.
const DATA_FILES = { results: RESULTS_FILE, measurements: MEASUREMENTS_FILE, scale: SCALE_FILE };

function dataFile(key) {
  const name = DATA_FILES[key];
  if (!name) throw new Error('Unknown data file.');
  return { name, file: path.join(requireFolder(), name) };
}

ipcMain.handle('data:read', (_e, key) => {
  const { file } = dataFile(key);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
});

ipcMain.handle('data:write', (_e, key, text) => {
  const { name, file } = dataFile(key);
  const tmp = file + '.tmp';
  try {
    // Write to a temp file first so a crash never leaves a half-written file.
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, file: name };
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    // Rename can fail if Excel holds the file; try a direct overwrite before giving up.
    try {
      fs.writeFileSync(file, text, 'utf8');
      return { ok: true, file: name };
    } catch (err2) {
      return { ok: false, error: friendlyWriteError(err2, name) };
    }
  }
});

ipcMain.handle('annotated:write', (_e, name, observer, pngBytes) => {
  const src = insideFolder(name);
  const dir = path.join(path.dirname(src), ANNOTATED_DIR);
  const stem = path.parse(src).name;
  const tag = String(observer).replace(/[^A-Za-z0-9_-]+/g, '');
  const outName = `${stem}_${tag || 'obs'}_annotated.png`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, outName), Buffer.from(pngBytes));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyWriteError(err, `${ANNOTATED_DIR}/${outName}`) };
  }
});

ipcMain.handle('app:confirm-close', async () => {
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Save and close', 'Close without saving', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    title: 'Unsaved readings',
    message: 'You have age readings that have not been saved to the results file.',
  });
  return ['save', 'discard', 'cancel'][res.response];
});

ipcMain.on('app:close-now', () => { if (win) win.destroy(); });

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
