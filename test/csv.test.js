const assert = require('assert');
const C = require('../src/csv.js');

// New file for first observer
let csv = C.merge(null, ['a.jpg', 'b.jpg', 'c.jpg'], 'Obs 1', { 'a.jpg': '3', 'c.jpg': '5' });
let t = C.toTable(csv);
assert.deepStrictEqual(t.columns, ['Obs 1']);
assert.deepStrictEqual(t.labels, ['a.jpg', 'b.jpg', 'c.jpg']);
assert.strictEqual(t.values['b.jpg']['Obs 1'], '');
assert.deepStrictEqual(C.readingsFor(t, 'Obs 1'), { 'a.jpg': '3', 'c.jpg': '5' });

// Second observer adds a column and leaves Obs 1 untouched
csv = C.merge(csv, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], 'Obs 2', { 'a.jpg': '4', 'd.jpg': '2' });
t = C.toTable(csv);
assert.deepStrictEqual(t.columns, ['Obs 1', 'Obs 2']);
assert.deepStrictEqual(t.labels, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);
assert.strictEqual(t.values['a.jpg']['Obs 1'], '3');
assert.strictEqual(t.values['a.jpg']['Obs 2'], '4');
assert.strictEqual(t.values['d.jpg']['Obs 1'], '');

// Obs 1 resumes: fills b, keeps earlier values, clears c
csv = C.merge(csv, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg'], 'Obs 1', { 'b.jpg': '6', 'c.jpg': null });
t = C.toTable(csv);
assert.deepStrictEqual(C.readingsFor(t, 'Obs 1'), { 'a.jpg': '3', 'b.jpg': '6' });
assert.deepStrictEqual(C.readingsFor(t, 'Obs 2'), { 'a.jpg': '4', 'd.jpg': '2' });

// Semicolon file (e.g. re-saved by Portuguese Excel) keeps its separator
const semi = 'label;Obs 1\r\n"x;1.jpg";3\r\ny.jpg;\r\n';
csv = C.merge(semi, ['x;1.jpg', 'y.jpg'], 'Obs 3', { 'y.jpg': '1+' });
assert.ok(csv.includes('label;Obs 1;Obs 3'));
t = C.toTable(csv);
assert.strictEqual(t.delimiter, ';');
assert.strictEqual(t.values['x;1.jpg']['Obs 1'], '3');
assert.strictEqual(t.values['y.jpg']['Obs 3'], '1+');

// Preferred delimiter for a brand-new file
csv = C.merge('', ['a.jpg'], 'Obs 1', { 'a.jpg': '2' }, ';');
assert.ok(csv.startsWith('﻿label;Obs 1\r\n'));

// ---------- file-name columns ----------
assert.deepStrictEqual(C.nameParts('Pflu22_meimoa_1.jpg'), ['Pflu22', 'meimoa', '1']);
const imgs = ['Pflu22_meimoa_1.jpg', 'Pflu22_meimoa_2.tif', 'Pflu23_sabor_10.png'];
csv = C.merge(null, imgs, 'Obs 1', { 'Pflu22_meimoa_1.jpg': '3' });
let lines = csv.replace(/^﻿/, '').trim().split('\r\n');
assert.strictEqual(lines[0], 'label,name_1,name_2,name_3,Obs 1');
assert.strictEqual(lines[1], 'Pflu22_meimoa_1.jpg,Pflu22,meimoa,1,3');
t = C.toTable(csv);
assert.deepStrictEqual(t.partHeaders, ['name_1', 'name_2', 'name_3']);
assert.deepStrictEqual(t.columns, ['Obs 1']);

// User renamed headers in Excel -> names kept, second observer appended after them
const renamed = csv.replace('name_1,name_2,name_3', 'species,river,fish');
csv = C.merge(renamed, imgs, 'Obs 2', { 'Pflu23_sabor_10.png': '5' });
lines = csv.replace(/^﻿/, '').trim().split('\r\n');
assert.strictEqual(lines[0], 'label,species,river,fish,Obs 1,Obs 2');
assert.strictEqual(lines[3], 'Pflu23_sabor_10.png,Pflu23,sabor,10,,5');

// Old file (no name columns) gets them added without losing readings
const old = 'label,Obs 1\r\nPflu22_meimoa_1.jpg,4\r\n';
csv = C.merge(old, ['Pflu22_meimoa_1.jpg'], 'Obs 2', { 'Pflu22_meimoa_1.jpg': '5' });
assert.ok(csv.includes('label,name_1,name_2,name_3,Obs 1,Obs 2\r\nPflu22_meimoa_1.jpg,Pflu22,meimoa,1,4,5'));

// Names with a different number of parts; a name without "_" gives no extra columns
csv = C.merge(null, ['a_b.jpg', 'a_b_c_d.jpg'], 'Obs 1', {});
assert.ok(csv.includes('label,name_1,name_2,name_3,name_4,Obs 1\r\na_b.jpg,a,b,,,\r\n'));
assert.ok(C.merge(null, ['plain.jpg'], 'Obs 1', {}).includes('label,Obs 1\r\n'));

// ---------- measurements ----------
let m = C.mergeMeasurements(null, 'Obs 1', {
  'Pflu22_meimoa_1.jpg': [
    { measurement: 1, length: '1.234', unit: 'mm', length_px: '617', scale_source: 'folder' },
    { measurement: 2, length: '0.5', unit: 'mm', length_px: '250', scale_source: 'folder' },
  ],
});
lines = m.replace(/^﻿/, '').trim().split('\r\n');
assert.strictEqual(lines[0], 'label,name_1,name_2,name_3,observer,measurement,length,unit,length_px,scale_source');
assert.strictEqual(lines.length, 3);
m = C.mergeMeasurements(m, 'Obs 2', { 'Pflu22_meimoa_1.jpg': [{ measurement: 1, length: '1.3', unit: 'mm', length_px: '650', scale_source: 'image' }] });
m = C.mergeMeasurements(m, 'Obs 1', { 'Pflu22_meimoa_1.jpg': [{ measurement: 1, length: '1.2', unit: 'mm', length_px: '600', scale_source: 'folder' }] });
const mr = C.readMeasurements(m).rows;
assert.strictEqual(mr.length, 2, 'Obs 1 rows replaced, Obs 2 kept');
assert.deepStrictEqual(mr.map(r => [r.observer, r.length]), [['Obs 1', '1.2'], ['Obs 2', '1.3']]);

console.log('All CSV tests passed');
