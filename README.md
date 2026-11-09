# Fish Age Reader

Blind, randomized age reading of fish scale and otolith photographs.

## Using it
1. Run `dist/FishAgeReader-1.1.0-portable.exe` (no install needed; Windows may show a
   SmartScreen warning the first time because the app is not code-signed: *More info → Run anyway*).
2. Pick who is reading (Obs 1, Obs 2, Obs 3, or add a new observer).
3. Choose the folder with the photographs (jpg, png, tif, bmp, gif, webp).
4. Images appear one at a time in random order, with their file names hidden.
   Type the age and press **Enter**, or **Skip**. At the end you can go back through the skipped images.
5. Press **Save results** (or Ctrl+S). The app writes `age_readings.csv` in the image folder:

   | label | name_1 | name_2 | name_3 | Obs 1 | Obs 2 |
   |---|---|---|---|---|---|
   | Pflu22_meimoa_1.jpg | Pflu22 | meimoa | 1 | 3 | 4 |

   - File names are split on `_` into the `name_` columns. You can rename those headers in Excel
     (e.g. `species, river, fish`); the app recognises them and keeps your names.

   - If the file already exists, it is updated: a new observer gets a new column, and other observers' values are never changed.
   - When an observer comes back, only the images they have not aged yet are shown (tick *Re-read* to go through all of them again).
   - If Excel opens the file with everything in one column (Portuguese/European settings), choose the
     *Semicolon* separator before the first save. An existing file keeps the separator it already has.

## Tools
- **Move** (H): drag to pan. Scroll to zoom. Right-drag or Space+drag pans with any tool.
- **Draw** (F): freehand. **Line** (L): straight line showing its length in pixels.
  **Point** (P): numbered points, e.g. one per annulus; the panel shows the count.
- **Scale** (S): draw a line along the scale bar in the photo and type its real length (mm, µm or cm).
  Choose *All images in this folder* (saved in `scale_settings.json` and used by every reader until a new
  folder scale is set) or *This image only*. Line lengths are then shown in real units.
- Line measurements are saved with **Save results** to `measurements.csv`
  (label, name columns, observer, measurement number, length, unit, length in pixels, scale source).
- **Brightness / Contrast** sliders (they stay set for the following images; *Reset* goes back to normal).
  Annotated copies are saved with the brightness/contrast you see.
- Colours, size, **Undo** (Ctrl+Z) and **Clear**.
- **Save annotated copy**: writes a full-resolution PNG with the marks to an `annotated` sub-folder.
  The original photo is never modified.

## On a Mac
Open `FishAgeReader-<version>-mac.dmg` and drag **Fish Age Reader** into Applications
(works on Intel and Apple Silicon Macs). The app is not signed by Apple, so the first time:
- Right-click (or Ctrl-click) the app → **Open** → **Open**. On macOS 15 or newer, if there is no Open
  button: try to open it once, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- If macOS says the app "is damaged", open Terminal and run
  `xattr -cr "/Applications/Fish Age Reader.app"`, then open it again.

Shortcuts use ⌘ instead of Ctrl (⌘S save results, ⌘Z undo).

## Getting new builds from GitHub
Every push to `main` builds both versions automatically (see `.github/workflows/build.yml`).
On GitHub: **Actions** tab → latest **Build apps** run → **Artifacts** at the bottom of the page →
download `FishAgeReader-Windows` or `FishAgeReader-Mac` (each is a .zip holding the app).
You can also start a build by hand: Actions → Build apps → **Run workflow**.

## Development
Requires Node.js. `npm install`, `npm start` to run, `npm test` for CSV tests,
`node test/e2e.js <image-folder> <screenshot-folder>` for the end-to-end test, `npm run dist` to build the .exe.
