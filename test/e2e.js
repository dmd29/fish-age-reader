// End-to-end check: drives the real app window with Playwright.
// Usage: node test/e2e.js <folder-with-images> <screenshot-dir>
const { _electron: electron } = require('playwright-core');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const folder = path.resolve(process.argv[2]);
const shots = path.resolve(process.argv[3] || '.');
const csvFile = path.join(folder, 'age_readings.csv');
const images = fs.readdirSync(folder).filter(f => /\.(jpe?g|png|tiff?)$/i.test(f));

const testUserData = path.join(shots, 'test-user-data');

async function launch() {
  const app = await electron.launch({
    args: ['.'],
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, FAR_TEST_USER_DATA: testUserData },
  });
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, folder);
  const page = await app.firstWindow();
  page.on('pageerror', e => { throw new Error('Page error: ' + e.message); });
  await page.waitForSelector('#profile-list .profile');
  return { app, page };
}

async function assertNoNames(page) {
  const text = await page.evaluate(() => document.body.innerText);
  for (const img of images) {
    assert.ok(!text.includes(img) && !text.includes(path.parse(img).name), `image name ${img} visible on screen`);
  }
}

(async () => {
  for (const f of ['age_readings.csv', 'measurements.csv', 'scale_settings.json']) fs.rmSync(path.join(folder, f), { force: true });
  fs.rmSync(path.join(folder, 'annotated'), { recursive: true, force: true });

  // ---------- Observer 1 ----------
  fs.rmSync(testUserData, { recursive: true, force: true });
  let { app, page } = await launch();
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  assert.strictEqual(path.resolve(userData), path.resolve(testUserData), 'test must use its own settings folder');
  const profiles = await page.$$eval('#profile-list .profile span:not(.tag)', els => els.map(e => e.textContent));
  assert.deepStrictEqual(profiles, ['Obs 1', 'Obs 2', 'Obs 3']);

  await page.click('#pick-folder');
  await page.waitForSelector('#folder-summary:not(.hidden)');
  await page.click('text=Obs 1');
  assert.ok((await page.textContent('#folder-summary')).includes(`${images.length} images found`));
  await page.screenshot({ path: path.join(shots, '1-start.png') });
  await page.click('#start-btn');
  await page.waitForSelector('#loading.hidden', { state: 'attached' });
  await page.waitForTimeout(300);
  await assertNoNames(page);

  // Annotate first image: zoom, line, two points, save copy
  const box = await page.locator('#canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -400);
  await page.click('[data-tool=line]');
  await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + 200, cy - 60, { steps: 5 }); await page.mouse.up();
  await page.click('[data-tool=point]');
  await page.mouse.click(cx + 60, cy - 18);
  await page.mouse.click(cx + 130, cy - 39);
  await page.click('[data-tool=free]');
  await page.mouse.move(cx - 100, cy + 50); await page.mouse.down(); await page.mouse.move(cx - 20, cy + 120, { steps: 8 }); await page.mouse.up();
  assert.strictEqual(await page.textContent('#point-count'), '2');
  assert.ok((await page.textContent('#measure-list')).includes('px'), 'line measured in px before scale');

  // Set a folder scale: 300 screen px line = 2 mm
  await page.click('[data-tool=scale]');
  await page.mouse.move(cx - 150, cy + 200); await page.mouse.down(); await page.mouse.move(cx + 150, cy + 200, { steps: 5 }); await page.mouse.up();
  await page.waitForSelector('#scale-overlay:not(.hidden)');
  await page.screenshot({ path: path.join(shots, '2a-scale-dialog.png') });
  await page.fill('#scale-length', '2');
  await page.click('#scale-form button[type=submit]');
  await page.waitForSelector('#scale-overlay.hidden', { state: 'attached' });
  assert.ok((await page.textContent('#scale-status')).startsWith('Folder scale: 2 mm'));
  const measured = await page.textContent('#measure-list');
  assert.ok(/L1\d+\.\d+ mm/.test(measured), 'line now in mm: ' + measured);
  // Length in mm = line length in image pixels / (scale-line pixels / 2 mm)
  const mm = Number(measured.match(/^L1([\d.]+) mm/)[1]);
  const { linePx, scalePx } = await page.evaluate(() => ({ linePx: viewer.lines()[0].px, scalePx: state.scale.folder.linePx }));
  assert.ok(Math.abs(mm - (linePx / scalePx) * 2) < 0.002, `measurement uses the scale: ${mm} vs ${(linePx / scalePx) * 2}`);
  // Second line in mm too
  await page.mouse.move(cx, cy - 100); await page.mouse.down(); await page.mouse.move(cx + 150, cy - 100, { steps: 4 }); await page.mouse.up();
  assert.ok((await page.textContent('#measure-list')).includes('L2'));

  // Brightness / contrast
  await page.locator('#brightness').fill('160');
  await page.locator('#contrast').fill('140');
  assert.strictEqual(await page.evaluate(() => viewer.filterCss()), 'brightness(160%) contrast(140%)');
  await page.screenshot({ path: path.join(shots, '2-reading.png') });
  await page.click('#save-annotated');
  await page.waitForTimeout(800);
  const annotated = fs.readdirSync(path.join(folder, 'annotated'));
  assert.strictEqual(annotated.length, 1);
  assert.ok(annotated[0].endsWith('_Obs1_annotated.png'));

  // Read all: age = position, skip the 2nd one
  const seen = [];
  for (let i = 0; i < images.length; i++) {
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
    await assertNoNames(page);
    seen.push(await page.textContent('#image-code'));
    assert.ok(!(await page.textContent('#age-msg')).includes('could not'), 'image failed to open');
    assert.ok(await page.evaluate(() => !!viewer.image), 'no image displayed');
    if (i === 1) await page.click('#skip-btn');
    else { await page.fill('#age-input', String(i + 1)); await page.press('#age-input', 'Enter'); }
  }
  await page.waitForSelector('#done-overlay:not(.hidden)');
  assert.ok((await page.textContent('#done-summary')).includes('skipped 1'));
  await page.screenshot({ path: path.join(shots, '3-done.png') });
  await page.click('#review-skipped');
  await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
  assert.strictEqual(await page.textContent('#image-code'), 'Image 1 of 1');
  await page.fill('#age-input', '9');
  await page.press('#age-input', 'Enter');
  await page.waitForSelector('#done-overlay:not(.hidden)');
  await page.click('#done-save');
  await page.waitForTimeout(500);

  let csv = fs.readFileSync(csvFile, 'utf8');
  let rows = csv.replace(/^﻿/, '').trim().split(/\r\n/).map(r => r.split(','));
  assert.deepStrictEqual(rows[0], ['label', 'name_1', 'name_2', 'name_3', 'Obs 1']);
  assert.strictEqual(rows.length, images.length + 1);
  for (const r of rows.slice(1)) assert.deepStrictEqual(r.slice(1, 4), path.parse(r[0]).name.split('_'), 'name columns');
  assert.ok(rows.slice(1).every(r => r[4] !== ''), 'every image has an Obs 1 age');
  const obs1 = Object.fromEntries(rows.slice(1).map(r => [r[0], r[4]]));

  const meas = fs.readFileSync(path.join(folder, 'measurements.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r\n/).map(r => r.split(','));
  assert.deepStrictEqual(meas[0], ['label', 'name_1', 'name_2', 'name_3', 'observer', 'measurement', 'length', 'unit', 'length_px', 'scale_source']);
  assert.strictEqual(meas.length, 3, 'two measurements saved');
  assert.deepStrictEqual(meas.slice(1).map(r => [r[4], r[5], r[7], r[9]]), [['Obs 1', '1', 'mm', 'folder'], ['Obs 1', '2', 'mm', 'folder']]);
  const scaleFile = JSON.parse(fs.readFileSync(path.join(folder, 'scale_settings.json'), 'utf8'));
  assert.strictEqual(scaleFile.folder.unit, 'mm');
  assert.strictEqual(scaleFile.folder.realLength, 2);
  console.log('Measurements:', meas.slice(1).map(r => r.join(',')).join(' | '));
  await app.close();

  // ---------- Observer 2: new column, reads 3 then stops (with close guard) ----------
  ({ app, page } = await launch());
  await page.click('#pick-folder');
  await page.waitForSelector('#folder-summary:not(.hidden)');
  await page.click('text=Obs 2');
  assert.ok((await page.textContent('#folder-summary')).includes(`will read ${images.length} images`));
  await page.click('#start-btn');
  for (let i = 0; i < 3; i++) {
    await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'));
    await page.fill('#age-input', String(20 + i));
    await page.press('#age-input', 'Enter');
  }
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(500);
  csv = fs.readFileSync(csvFile, 'utf8');
  rows = csv.replace(/^﻿/, '').trim().split(/\r\n/).map(r => r.split(','));
  assert.deepStrictEqual(rows[0], ['label', 'name_1', 'name_2', 'name_3', 'Obs 1', 'Obs 2']);
  assert.strictEqual(rows.slice(1).filter(r => r[5] !== '').length, 3);
  for (const r of rows.slice(1)) assert.strictEqual(r[4], obs1[r[0]], 'Obs 1 values untouched');
  // Folder scale is remembered for the next reader
  assert.ok((await page.textContent('#scale-status')).startsWith('Folder scale: 2 mm'));
  await page.click('#exit-btn');

  // Resume as Obs 2: only the remaining images
  await page.click('text=Obs 2');
  assert.ok((await page.textContent('#folder-summary')).includes(`${images.length - 3} to read now`));
  // Obs 1 has nothing left
  await page.click('text=Obs 1');
  assert.ok(await page.isDisabled('#start-btn'));
  // Add a 4th observer
  await page.fill('#new-profile', 'Ana');
  await page.click('text=Add observer');
  assert.ok((await page.textContent('#folder-summary')).includes('Ana'));
  await page.screenshot({ path: path.join(shots, '4-resume.png') });
  await app.close();

  console.log('E2E passed. Order seen:', seen.join(' | '));
  console.log(fs.readFileSync(csvFile, 'utf8'));
})().catch(err => { console.error('E2E FAILED:', err); process.exit(1); });
