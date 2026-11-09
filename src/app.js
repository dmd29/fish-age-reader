// Fish Age Reader - session flow (start screen, blind randomized reading, saving).
const $ = id => document.getElementById(id);
const bridge = window.api;
const CSV = window.ResultsCSV;
const COLORS = ['#ffd400', '#ff4d4d', '#33d6ff', '#4dff88', '#ff5cf0', '#ffffff'];

const state = {
  profiles: [],
  observer: null,
  folder: null,
  images: [],
  table: null,         // results file as last read from disk
  queue: [],           // shuffled image names for this round
  pos: 0,
  readings: {},        // this session's ages: label -> value
  marks: {},           // annotations per image (kept for the session)
  skipped: new Set(),
  dirty: false,
  allowClose: false,
  scale: { folder: null, images: {} }, // from scale_settings.json in the image folder
  lineSig: {},          // label -> signature of its measured lines (to notice changes)
  measured: {},         // label -> scale used for its measurements (images measured this session)
  pendingScalePx: null, // length of the calibration line waiting in the dialog
};

const cache = new Map(); // image name -> Promise<ImageBitmap>

const viewer = new Viewer($('canvas'), $('stage'), { onChange: updateViewerStats, onScaleLine: openScaleDialog });

// ---------------- helpers ----------------
function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let toastTimer;
function toast(msg, kind = 'ok', ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screen));
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setDirty(v) {
  state.dirty = v;
  $('save-state').textContent = v ? 'Unsaved readings' : 'All readings saved';
}

// ---------------- profiles ----------------
async function initProfiles() {
  state.profiles = await bridge.getProfiles();
  renderProfiles();
}

function renderProfiles() {
  const list = $('profile-list');
  list.innerHTML = '';
  for (const name of state.profiles) {
    const label = document.createElement('label');
    label.className = 'profile' + (name === state.observer ? ' selected' : '');
    const count = state.table ? Object.keys(CSV.readingsFor(state.table, name)).length : 0;
    label.innerHTML = `<input type="radio" name="observer" value="${escapeHtml(name)}" ${name === state.observer ? 'checked' : ''}>
      <span>${escapeHtml(name)}</span>${count ? `<span class="tag">${count} read</span>` : ''}
      <button type="button" class="remove" title="Remove ${escapeHtml(name)} from the list" aria-label="Remove ${escapeHtml(name)}">×</button>`;
    label.querySelector('input').addEventListener('change', () => { state.observer = name; renderProfiles(); updateStart(); });
    label.querySelector('.remove').addEventListener('click', async e => {
      e.preventDefault();
      if (state.profiles.length <= 1) return toast('Keep at least one observer.', 'error');
      if (!confirm(`Remove "${name}" from the observer list?\n(Readings already saved in results files are not deleted.)`)) return;
      state.profiles = await bridge.setProfiles(state.profiles.filter(p => p !== name));
      if (state.observer === name) state.observer = null;
      renderProfiles(); updateStart();
    });
    list.appendChild(label);
  }
}

$('add-profile-form').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('new-profile');
  const name = input.value.trim();
  if (!name) return;
  if (name.toLowerCase() === CSV.LABEL_COL) return toast('"label" is reserved for the image column.', 'error');
  const existing = state.profiles.find(p => p.toLowerCase() === name.toLowerCase());
  if (!existing) state.profiles = await bridge.setProfiles([...state.profiles, name]);
  state.observer = existing || name;
  input.value = '';
  renderProfiles(); updateStart();
});

// ---------------- folder ----------------
$('pick-folder').addEventListener('click', async () => {
  const res = await bridge.pickFolder();
  if (!res) return;
  state.folder = res.folder;
  state.images = res.images;
  cache.clear();
  $('folder-name').textContent = res.folder;
  $('folder-name').title = res.folder;
  await loadResultsTable();
  // Observers found in the file become profiles so the reader can continue as them.
  const missing = state.table.columns.filter(c => !state.profiles.includes(c));
  if (missing.length) state.profiles = await bridge.setProfiles([...state.profiles, ...missing]);
  renderProfiles();
  updateStart();
});

async function loadResultsTable() {
  const text = await bridge.readResults();
  state.table = CSV.toTable(text);
  state.hasResultsFile = text !== null;
  state.scale = await readScaleFile();
}

// ---------------- scale ----------------
async function readScaleFile() {
  try {
    const s = JSON.parse((await bridge.readScale()) || 'null');
    if (s && typeof s === 'object') return { folder: s.folder || null, images: s.images || {} };
  } catch (_) { /* missing or unreadable: no scale */ }
  return { folder: null, images: {} };
}

function scaleFor(label) {
  if (label && state.scale.images[label]) return { ...state.scale.images[label], source: 'image' };
  if (state.scale.folder) return { ...state.scale.folder, source: 'folder' };
  return null;
}

function fmtNum(v) {
  const a = Math.abs(v);
  return v.toFixed(a >= 100 ? 1 : a >= 10 ? 2 : 3);
}

function lengthText(px, s) {
  return s ? `${fmtNum(px / s.pxPerUnit)} ${s.unit}` : `${Math.round(px)} px`;
}

function currentLabel() { return state.queue[state.pos]; }

// Scale that measurements on this image use: the one active when it was measured this session.
function measureScale(label) {
  return Object.prototype.hasOwnProperty.call(state.measured, label) ? state.measured[label] : scaleFor(label);
}

function applyScaleToViewer() {
  const label = currentLabel();
  const s = measureScale(label);
  viewer.formatLength = px => lengthText(px, s);
  const status = $('scale-status');
  const active = scaleFor(label);
  if (active) {
    status.textContent = `${active.source === 'image' ? 'This image' : 'Folder'} scale: ${active.realLength} ${active.unit} = ${Math.round(active.linePx)} px  (1 ${active.unit} = ${active.pxPerUnit.toFixed(1)} px)`;
    status.classList.add('set');
  } else {
    status.textContent = 'No scale set – lengths are in pixels. Use the Scale tool on the scale bar.';
    status.classList.remove('set');
  }
  $('scale-image-remove').classList.toggle('hidden', !(label && state.scale.images[label]));
  viewer.render();
  updateViewerStats(viewer);
}

function openScaleDialog(px) {
  state.pendingScalePx = px;
  $('scale-px').textContent = `${Math.round(px)} px`;
  const prev = scaleFor(currentLabel());
  $('scale-length').value = prev ? prev.realLength : '';
  if (prev) $('scale-unit').value = prev.unit;
  $('scale-msg').textContent = '';
  $('scale-overlay').classList.remove('hidden');
  $('scale-length').focus();
  $('scale-length').select();
}

function closeScaleDialog() {
  $('scale-overlay').classList.add('hidden');
  state.pendingScalePx = null;
  viewer.clearScaleDraft();
}

$('scale-cancel').addEventListener('click', closeScaleDialog);
$('scale-overlay').addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); closeScaleDialog(); } });

$('scale-form').addEventListener('submit', async e => {
  e.preventDefault();
  const real = Number($('scale-length').value.trim().replace(',', '.'));
  if (!(real > 0) || !isFinite(real)) { $('scale-msg').textContent = 'Type the real length shown by the scale bar, e.g. 1 or 0,5.'; return; }
  const apply = document.querySelector('input[name=scale-apply]:checked').value;
  const label = currentLabel();
  const entry = {
    realLength: real,
    unit: $('scale-unit').value,
    linePx: Math.round(state.pendingScalePx * 10) / 10,
    pxPerUnit: state.pendingScalePx / real,
    setBy: state.observer,
    date: new Date().toISOString().slice(0, 10),
  };
  // Re-read so a scale saved by someone else meanwhile is not lost.
  const latest = await readScaleFile();
  if (apply === 'folder') latest.folder = entry; else latest.images[label] = entry;
  const res = await bridge.writeScale(JSON.stringify(latest, null, 2));
  if (!res.ok) { $('scale-msg').textContent = res.error; return; }
  state.scale = latest;
  // Lines already drawn on this image are measured with the new scale.
  if (state.measured[label] !== undefined) state.measured[label] = scaleFor(label);
  closeScaleDialog();
  selectTool('line');
  applyScaleToViewer();
  toast(apply === 'folder'
    ? `Scale set for the whole folder: 1 ${entry.unit} = ${entry.pxPerUnit.toFixed(1)} px. Now measure with the Line tool.`
    : `Scale set for this image only: 1 ${entry.unit} = ${entry.pxPerUnit.toFixed(1)} px.`, 'ok', 5000);
});

$('scale-image-remove').addEventListener('click', async () => {
  const label = currentLabel();
  const latest = await readScaleFile();
  delete latest.images[label];
  const res = await bridge.writeScale(JSON.stringify(latest, null, 2));
  if (!res.ok) return toast(res.error, 'error', 7000);
  state.scale = latest;
  if (state.measured[label] !== undefined) state.measured[label] = scaleFor(label);
  applyScaleToViewer();
  toast(state.scale.folder ? 'This image now uses the folder scale.' : 'Image scale removed. No folder scale is set.');
});

// ---------------- brightness / contrast ----------------
function updateAdjust() {
  const b = Number($('brightness').value), c = Number($('contrast').value);
  $('brightness-val').textContent = `${b}%`;
  $('contrast-val').textContent = `${c}%`;
  viewer.setAdjust(b, c);
}
$('brightness').addEventListener('input', updateAdjust);
$('contrast').addEventListener('input', updateAdjust);
$('adjust-reset').addEventListener('click', () => { $('brightness').value = 100; $('contrast').value = 100; updateAdjust(); });

function remainingFor(observer, reread) {
  if (!observer) return [];
  if (reread) return state.images.slice();
  const done = CSV.readingsFor(state.table, observer);
  return state.images.filter(n => !(n in done));
}

function updateStart() {
  const summary = $('folder-summary');
  const ready = state.folder && state.observer;
  $('new-file-options').classList.toggle('hidden', !state.folder || state.hasResultsFile);
  if (!state.folder) {
    summary.classList.add('hidden');
  } else {
    summary.classList.remove('hidden');
    const parts = [];
    parts.push(state.images.length
      ? `<strong>${state.images.length}</strong> image${state.images.length === 1 ? '' : 's'} found.`
      : `<span class="warn">No images found in this folder (jpg, png, tif, bmp, gif, webp).</span>`);
    if (state.hasResultsFile) {
      const cols = state.table.columns;
      parts.push(`Existing results file <em>age_readings.csv</em> found${cols.length ? ` with readings from: ${cols.map(c => `${escapeHtml(c)} (${Object.keys(CSV.readingsFor(state.table, c)).length})`).join(', ')}` : ''}.`);
    } else {
      parts.push('A new results file <em>age_readings.csv</em> will be created in this folder when you save.');
    }
    if (state.observer) {
      const already = Object.keys(CSV.readingsFor(state.table, state.observer)).filter(l => state.images.includes(l)).length;
      const left = remainingFor(state.observer, $('reread').checked).length;
      parts.push(already
        ? `<strong>${escapeHtml(state.observer)}</strong> has already aged ${already} of these images · <strong>${left}</strong> to read now.`
        : `<strong>${escapeHtml(state.observer)}</strong> will read <strong>${left}</strong> images${state.hasResultsFile ? ' (new column in the results file)' : ''}.`);
      $('reread-row').classList.toggle('hidden', !already);
    }
    summary.innerHTML = parts.join('<br>');
  }
  const left = remainingFor(state.observer, $('reread').checked).length;
  $('start-btn').disabled = !(ready && left > 0);
  $('start-hint').textContent = !state.observer ? 'Choose who is reading.'
    : !state.folder ? 'Choose the folder with the photographs.'
    : left === 0 ? (state.images.length ? 'All images in this folder are already aged by this observer. Tick "Re-read" to go again.' : 'This folder has no images.')
    : 'Images will be shown in random order without their names.';
}
$('reread').addEventListener('change', updateStart);

// ---------------- reading round ----------------
$('start-btn').addEventListener('click', () => {
  state.readings = {};
  state.marks = {};
  state.lineSig = {};
  state.measured = {};
  state.skipped = new Set();
  state.queue = shuffle(remainingFor(state.observer, $('reread').checked));
  state.pos = 0;
  setDirty(false);
  $('save-state').textContent = '';
  $('observer-chip').textContent = `Reader: ${state.observer}`;
  show('screen-read');
  showCurrent();
});

function loadBitmap(name) {
  if (!cache.has(name)) {
    const p = (async () => {
      const r = await bridge.readImage(name);
      if (r.kind === 'rgba') {
        const px = new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        return createImageBitmap(new ImageData(px, r.width, r.height));
      }
      return createImageBitmap(new Blob([r.data], { type: r.mime }));
    })();
    p.catch(() => cache.delete(name));
    cache.set(name, p);
    // keep memory bounded
    if (cache.size > 6) cache.delete(cache.keys().next().value);
  }
  return cache.get(name);
}

let showToken = 0;
async function showCurrent() {
  const name = state.queue[state.pos];
  const token = ++showToken;
  const total = state.queue.length;
  $('image-code').textContent = `Image ${state.pos + 1} of ${total}`;
  $('progress-text').textContent = `${state.pos + 1} / ${total}${state.roundLabel ? ' · ' + state.roundLabel : ''}`;
  $('progress-bar').style.width = `${(state.pos / total) * 100}%`;
  $('prev-btn').disabled = state.pos === 0;
  $('age-input').value = state.readings[name] || '';
  setAgeMsg(state.readings[name] ? `You entered ${state.readings[name]} for this image.` : '', true);
  $('loading').classList.remove('hidden');
  viewer.clearImage();
  try {
    const bmp = await loadBitmap(name);
    if (token !== showToken) return;
    if (!state.marks[name]) state.marks[name] = [];
    viewer.setImage(bmp, state.marks[name]);
    applyScaleToViewer();
  } catch (err) {
    if (token !== showToken) return;
    setAgeMsg('This image could not be opened. You can skip it.');
  } finally {
    if (token === showToken) $('loading').classList.add('hidden');
  }
  const next = state.queue[state.pos + 1];
  if (next) loadBitmap(next).catch(() => {});
  $('age-input').focus();
  $('age-input').select();
}

function setAgeMsg(msg, ok) {
  $('age-msg').textContent = msg;
  $('age-msg').classList.toggle('ok', !!ok);
}

function advance() {
  if (state.pos < state.queue.length - 1) { state.pos++; showCurrent(); }
  else openDone();
}

$('age-form').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('age-input').value.trim();
  if (!v) { setAgeMsg('Type an age, or use Skip.'); return; }
  if (/[,;"\r\n]/.test(v)) { setAgeMsg('Please avoid commas, semicolons and quotes.'); return; }
  const name = state.queue[state.pos];
  state.readings[name] = v;
  state.skipped.delete(name);
  setDirty(true);
  advance();
});

$('skip-btn').addEventListener('click', () => {
  const name = state.queue[state.pos];
  if (!state.readings[name]) state.skipped.add(name);
  advance();
});

$('prev-btn').addEventListener('click', () => {
  if (state.pos > 0) { state.pos--; showCurrent(); }
});

function openDone() {
  $('progress-bar').style.width = '100%';
  const read = Object.keys(state.readings).length;
  const skipped = [...state.skipped].filter(n => !state.readings[n]).length;
  $('done-summary').innerHTML = `You have aged <strong>${read}</strong> image${read === 1 ? '' : 's'} in this session` +
    (skipped ? ` and skipped <strong>${skipped}</strong>.` : '.') +
    (state.dirty ? '<br>Remember to save the results.' : '<br>Your results are saved.');
  $('review-skipped').classList.toggle('hidden', !skipped);
  $('review-skipped').textContent = `Review skipped images (${skipped})`;
  $('done-overlay').classList.remove('hidden');
  $('done-save').focus();
}

$('review-skipped').addEventListener('click', () => {
  state.queue = shuffle([...state.skipped].filter(n => !state.readings[n]));
  state.skipped = new Set();
  state.pos = 0;
  state.roundLabel = 'skipped images';
  $('done-overlay').classList.add('hidden');
  showCurrent();
});
$('done-back').addEventListener('click', () => { $('done-overlay').classList.add('hidden'); $('age-input').focus(); });
$('done-save').addEventListener('click', async () => { if (await saveResults()) openDone(); });
$('done-exit').addEventListener('click', () => exitToStart());

// ---------------- saving ----------------
// This observer's measurements for every image whose lines changed this session.
function measurementEntries() {
  const entries = {};
  for (const label of Object.keys(state.measured)) {
    const s = state.measured[label];
    entries[label] = (state.marks[label] || []).filter(m => m.type === 'line').map(m => {
      const px = lineLength(m);
      return {
        measurement: m.n,
        length: s ? fmtNum(px / s.pxPerUnit) : '',
        unit: s ? s.unit : '',
        length_px: px.toFixed(1),
        scale_source: s ? s.source : 'none',
      };
    });
  }
  return entries;
}

async function saveResults() {
  const entries = measurementEntries();
  const hasAges = Object.keys(state.readings).length > 0;
  const hasMeasures = Object.keys(entries).length > 0;
  if (!hasAges && !hasMeasures) { toast('No ages or measurements yet - nothing to save.', 'error'); return false; }
  try {
    const saved = [];
    if (hasAges) {
      // Re-read the file right before writing so readings saved by other observers
      // (e.g. on another computer using a shared folder) are never overwritten.
      const latest = await bridge.readResults();
      const images = await bridge.rescanFolder();
      const text = CSV.merge(latest, images, state.observer, state.readings, $('delimiter').value);
      const res = await bridge.writeResults(text);
      if (!res.ok) { toast(res.error, 'error', 7000); return false; }
      state.table = CSV.toTable(text);
      state.hasResultsFile = true;
      saved.push(res.file);
    }
    if (hasMeasures) {
      const latestM = await bridge.readMeasurements();
      const textM = CSV.mergeMeasurements(latestM, state.observer, entries, $('delimiter').value);
      const resM = await bridge.writeMeasurements(textM);
      if (!resM.ok) { toast(resM.error, 'error', 7000); return false; }
      saved.push(resM.file);
    }
    setDirty(false);
    toast(`Saved ${saved.join(' and ')} in the image folder.`);
    return true;
  } catch (err) {
    toast(`Saving failed: ${err.message}`, 'error', 7000);
    return false;
  }
}
$('save-results').addEventListener('click', saveResults);

$('save-annotated').addEventListener('click', async () => {
  const name = state.queue[state.pos];
  if (!viewer.image) return;
  if (!viewer.marks.length) return toast('Draw some marks first.', 'error');
  try {
    const bytes = await viewer.exportPNG();
    const res = await bridge.writeAnnotated(name, state.observer, bytes);
    toast(res.ok ? 'Annotated copy saved in the "annotated" sub-folder. The original is unchanged.' : res.error, res.ok ? 'ok' : 'error', 5000);
  } catch (err) {
    toast(`Could not save the copy: ${err.message}`, 'error', 6000);
  }
});

async function exitToStart() {
  if (state.dirty) {
    const choice = await bridge.confirmClose();
    if (choice === 'cancel') return;
    if (choice === 'save' && !(await saveResults())) return;
  }
  $('done-overlay').classList.add('hidden');
  state.roundLabel = '';
  setDirty(false);
  viewer.clearImage();
  show('screen-start');
  renderProfiles();
  updateStart();
}
$('exit-btn').addEventListener('click', exitToStart);

// Guard against closing the window with unsaved readings.
window.addEventListener('beforeunload', e => {
  if (state.dirty && !state.allowClose) {
    e.returnValue = false;
    setTimeout(async () => {
      const choice = await bridge.confirmClose();
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await saveResults())) return;
      state.allowClose = true;
      bridge.closeNow();
    }, 0);
  }
});

// ---------------- tools ----------------
document.querySelectorAll('.tool[data-tool]').forEach(btn => btn.addEventListener('click', () => selectTool(btn.dataset.tool)));
function selectTool(tool) {
  viewer.setTool(tool);
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}

COLORS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (i === 0 ? ' active' : '');
  b.style.background = c;
  b.title = 'Mark colour';
  b.setAttribute('aria-label', `Colour ${c}`);
  b.addEventListener('click', () => {
    viewer.color = c;
    document.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === b));
  });
  $('swatches').appendChild(b);
});
$('stroke-width').addEventListener('input', e => { viewer.size = Number(e.target.value); });

$('undo-btn').addEventListener('click', () => viewer.undo());
$('clear-btn').addEventListener('click', () => { if (viewer.marks.length && confirm('Remove all marks on this image?')) viewer.clearMarks(); });
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => viewer.fit());
$('zoom-100').addEventListener('click', () => viewer.zoomTo(1));

function updateViewerStats(v) {
  $('zoom-level').textContent = `${Math.round(v.scale * 100)}%`;
  $('point-count').textContent = v.pointCount();
  const label = currentLabel();
  const lines = v.image ? v.lines() : [];
  // Notice when this image's measured lines change, so they get saved.
  if (label && v.image) {
    const sig = lines.map(l => l.px.toFixed(2)).join('|');
    if (state.lineSig[label] === undefined) state.lineSig[label] = sig;
    else if (state.lineSig[label] !== sig) {
      state.lineSig[label] = sig;
      if (!Object.prototype.hasOwnProperty.call(state.measured, label)) state.measured[label] = scaleFor(label);
      setDirty(true);
    }
  }
  const s = measureScale(label);
  $('measure-list').innerHTML = lines.map(l => `<li><span>L${l.n}</span>${escapeHtml(lengthText(l.px, s))}</li>`).join('');
  $('measure-empty').classList.toggle('hidden', lines.length > 0);
}

// On a Mac the shortcuts use Cmd (⌘) instead of Ctrl.
const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent);
if (IS_MAC) {
  document.querySelectorAll('kbd').forEach(k => { if (k.textContent === 'Ctrl') k.textContent = '⌘'; });
  document.querySelectorAll('[title*="Ctrl+"]').forEach(el => { el.title = el.title.replace(/Ctrl\+/g, '⌘'); });
}

window.addEventListener('keydown', e => {
  if (!$('screen-read').classList.contains('active')) return;
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveResults(); return; }
  if (mod && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); viewer.undo(); return; }
  if (e.key === 'Escape' && typing) { e.target.blur(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || !$('done-overlay').classList.contains('hidden') || !$('scale-overlay').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  const tools = { h: 'pan', f: 'free', l: 'line', p: 'point', s: 'scale' };
  if (tools[k]) selectTool(tools[k]);
  else if (k === '0') viewer.fit();
  else if (k === '1') viewer.zoomTo(1);
  else if (k === '+' || k === '=') viewer.zoomBy(1.25);
  else if (k === '-') viewer.zoomBy(0.8);
  else if (/^[2-9]$/.test(k)) { $('age-input').focus(); }
});

initProfiles().then(updateStart);
