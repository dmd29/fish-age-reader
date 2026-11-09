// Results-file logic: parse, merge and write the age-readings and measurements CSVs.
// Works both in the app window (window.ResultsCSV) and in Node (for tests).
//
// age_readings.csv layout:
//   label | name_1 | name_2 | ... | Obs 1 | Obs 2 | ...
// The name_N columns come from splitting the file name (without extension) on "_",
// e.g. Pflu22_meimoa_1.jpg -> Pflu22 | meimoa | 1. Their headers can be renamed in Excel;
// the app recognises them by their content and keeps the names.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResultsCSV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const LABEL_COL = 'label';

  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    let commas = 0, semis = 0, inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === ',') commas++;
      else if (!inQ && ch === ';') semis++;
    }
    return semis > commas ? ';' : ',';
  }

  function parse(text, delimiter) {
    text = String(text || '').replace(/^﻿/, '');
    const delim = delimiter || detectDelimiter(text);
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else field += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return { delimiter: delim, rows: rows.filter(r => r.some(c => c.trim() !== '')) };
  }

  // "Pflu22_meimoa_1.jpg" -> ["Pflu22", "meimoa", "1"]
  function nameParts(label) {
    const stem = String(label).replace(/\.[^.]+$/, '');
    return stem.split('_').map(s => s.trim());
  }

  // Number of name columns for a set of labels (0 when no name contains "_").
  function partCount(labels) {
    let max = 0;
    for (const l of labels) max = Math.max(max, nameParts(l).length);
    return max > 1 ? max : 0;
  }

  // Turn CSV text into
  // { delimiter, partHeaders: [...], columns: [observer...], labels: [...], values: {label: {observer: value}} }
  function toTable(text) {
    const empty = { delimiter: ',', partHeaders: [], columns: [], labels: [], values: {} };
    if (!text || !String(text).trim()) return empty;
    const { delimiter, rows } = parse(text);
    if (!rows.length) return { ...empty, delimiter };
    const header = rows[0].map(h => h.trim());
    const body = rows.slice(1).filter(r => (r[0] || '').trim());

    // Leading columns whose every value equals that part of the file name are name columns.
    const maxParts = partCount(body.map(r => r[0].trim()));
    let parts = 0;
    while (parts < maxParts && parts + 1 < header.length) {
      const j = parts;
      const isPart = body.every(r => (r[j + 1] || '').trim() === (nameParts(r[0].trim())[j] || ''));
      if (!isPart) break;
      parts++;
    }
    const partHeaders = header.slice(1, 1 + parts);
    const obsHeader = header.slice(1 + parts);
    const columns = obsHeader.filter(Boolean);
    const labels = [], values = {};
    for (const r of body) {
      const label = r[0].trim();
      if (values[label]) continue;
      labels.push(label);
      values[label] = {};
      obsHeader.forEach((col, i) => { if (col) values[label][col] = (r[i + 1 + parts] || '').trim(); });
    }
    return { delimiter, partHeaders, columns, labels, values };
  }

  function readingsFor(table, observer) {
    const out = {};
    for (const label of table.labels) {
      const v = table.values[label] && table.values[label][observer];
      if (v !== undefined && v !== '') out[label] = v;
    }
    return out;
  }

  function quote(value, delim) {
    const s = value == null ? '' : String(value);
    return /["\r\n]/.test(s) || s.includes(delim) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function line(cells, delim) { return cells.map(c => quote(c, delim)).join(delim); }

  // Name-column headers: keep names already in the file (possibly renamed by the user),
  // default to name_1, name_2, ... for new ones.
  function partHeadersFor(existing, count) {
    const out = [];
    for (let j = 0; j < count; j++) out.push(existing[j] || `name_${j + 1}`);
    return out;
  }

  function finish(lines) {
    // BOM so Excel opens accents correctly; CRLF for Windows tools.
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  // Merge this observer's readings into the latest file contents and return new CSV text.
  // Other observers' columns are never touched. `readings` maps label -> age; a label set to
  // null clears that observer's value.
  function merge(existingText, images, observer, readings, preferredDelimiter) {
    const table = toTable(existingText);
    const delim = existingText && String(existingText).trim() ? table.delimiter : (preferredDelimiter || ',');
    const columns = table.columns.slice();
    if (!columns.includes(observer)) columns.push(observer);

    const labels = table.labels.slice();
    const known = new Set(labels);
    for (const img of images) if (!known.has(img)) { labels.push(img); known.add(img); }

    const nParts = partCount(labels);
    const partHeaders = partHeadersFor(table.partHeaders, nParts);

    const lines = [line([LABEL_COL, ...partHeaders, ...columns], delim)];
    for (const label of labels) {
      const row = Object.assign({}, table.values[label] || {});
      if (Object.prototype.hasOwnProperty.call(readings, label)) row[observer] = readings[label] == null ? '' : readings[label];
      const parts = nameParts(label);
      const partCells = partHeaders.map((_, j) => (nParts ? parts[j] || '' : ''));
      lines.push(line([label, ...partCells, ...columns.map(c => row[c] || '')], delim));
    }
    return finish(lines);
  }

  // ---------------- measurements.csv ----------------
  // One row per measured line:
  //   label | name_1.. | observer | measurement | length | unit | length_px | scale_source
  const MEAS_FIXED = ['observer', 'measurement', 'length', 'unit', 'length_px', 'scale_source'];

  function readMeasurements(text) {
    if (!text || !String(text).trim()) return { delimiter: ',', partHeaders: [], rows: [] };
    const { delimiter, rows } = parse(text);
    const header = rows[0].map(h => h.trim());
    const obsIdx = header.indexOf('observer');
    if (obsIdx < 0) return { delimiter, partHeaders: [], rows: [] };
    const partHeaders = header.slice(1, obsIdx);
    const out = rows.slice(1).map(r => {
      const o = { label: (r[0] || '').trim() };
      MEAS_FIXED.forEach((k, i) => { o[k] = (r[obsIdx + i] || '').trim(); });
      return o;
    }).filter(o => o.label);
    return { delimiter, partHeaders, rows: out };
  }

  // `entries` maps label -> [{measurement, length, unit, length_px, scale_source}] for this observer.
  // For each label in `entries`, this observer's previous rows are replaced (an empty list removes them).
  function mergeMeasurements(existingText, observer, entries, preferredDelimiter) {
    const prev = readMeasurements(existingText);
    const delim = existingText && String(existingText).trim() ? prev.delimiter : (preferredDelimiter || ',');
    const replaced = new Set(Object.keys(entries));
    const rows = prev.rows.filter(r => !(r.observer === observer && replaced.has(r.label)));
    for (const [label, list] of Object.entries(entries)) {
      for (const m of list) rows.push({ label, observer, ...m });
    }
    rows.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) ||
      a.observer.localeCompare(b.observer) || Number(a.measurement) - Number(b.measurement));
    const nParts = partCount(rows.map(r => r.label));
    const partHeaders = partHeadersFor(prev.partHeaders, nParts);
    const lines = [line([LABEL_COL, ...partHeaders, ...MEAS_FIXED], delim)];
    for (const r of rows) {
      const parts = nameParts(r.label);
      lines.push(line([r.label, ...partHeaders.map((_, j) => parts[j] || ''), ...MEAS_FIXED.map(k => r[k] == null ? '' : r[k])], delim));
    }
    return finish(lines);
  }

  return { LABEL_COL, detectDelimiter, parse, nameParts, partCount, toTable, readingsFor, merge, readMeasurements, mergeMeasurements };
});
