// Image viewer: zoom / pan plus freehand, line and numbered-point annotations.
// Marks are stored in image pixel coordinates so they stay put while zooming and
// can be burned into a full-resolution copy of the original.
class Viewer {
  constructor(canvas, stage, { onChange, onScaleLine } = {}) {
    this.canvas = canvas;
    this.stage = stage;
    this.ctx = canvas.getContext('2d');
    this.onChange = onChange || (() => {});
    this.onScaleLine = onScaleLine || (() => {});
    this.adjust = { brightness: 100, contrast: 100 }; // percent
    this.formatLength = px => `${Math.round(px)} px`; // replaced by the app when a scale is set
    this.scaleDraft = null; // calibration line waiting for the user to type its real length
    this.image = null;
    this.marks = [];
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.tool = 'pan';
    this.color = '#ffd400';
    this.size = 3; // screen pixels at the moment a mark is made
    this.drag = null;   // active pointer interaction
    this.draft = null;  // mark being drawn
    this.spaceDown = false;

    new ResizeObserver(() => this.resize()).observe(stage);
    canvas.addEventListener('pointerdown', e => this.pointerDown(e));
    canvas.addEventListener('pointermove', e => this.pointerMove(e));
    canvas.addEventListener('pointerup', e => this.pointerUp(e));
    canvas.addEventListener('pointercancel', e => this.pointerUp(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => this.wheel(e), { passive: false });
    window.addEventListener('keydown', e => { if (e.code === 'Space' && !isTyping(e)) { this.spaceDown = true; e.preventDefault(); } });
    window.addEventListener('keyup', e => { if (e.code === 'Space') this.spaceDown = false; });
    this.resize();
  }

  // ---------- public API ----------
  setImage(bitmap, marks) {
    this.image = bitmap;
    this.marks = marks || [];
    this.draft = null;
    this.scaleDraft = null;
    this.fit();
  }

  setAdjust(brightness, contrast) {
    this.adjust = { brightness, contrast };
    this.render();
  }

  clearScaleDraft() { this.scaleDraft = null; this.render(); }

  filterCss() {
    const { brightness, contrast } = this.adjust;
    return brightness === 100 && contrast === 100 ? 'none' : `brightness(${brightness}%) contrast(${contrast}%)`;
  }

  // Measured lines, in drawing order: [{ n, px }]
  lines() {
    return this.marks.filter(m => m.type === 'line').map(m => ({ n: m.n, px: lineLength(m) }));
  }

  clearImage() { this.image = null; this.marks = []; this.render(); }

  setTool(tool) { this.tool = tool; this.stage.dataset.tool = tool; }

  fit() {
    if (!this.image) return this.render();
    const { w, h } = this.viewSize();
    const s = Math.min(w / this.image.width, h / this.image.height) * 0.96;
    this.scale = s;
    this.tx = (w - this.image.width * s) / 2;
    this.ty = (h - this.image.height * s) / 2;
    this.changed();
  }

  zoomBy(factor, cx, cy) {
    if (!this.image) return;
    const { w, h } = this.viewSize();
    if (cx === undefined) { cx = w / 2; cy = h / 2; }
    const next = Math.min(40, Math.max(0.02, this.scale * factor));
    const f = next / this.scale;
    this.tx = cx - (cx - this.tx) * f;
    this.ty = cy - (cy - this.ty) * f;
    this.scale = next;
    this.changed();
  }

  zoomTo(scale) { this.zoomBy(scale / this.scale); }

  undo() { if (this.marks.pop()) { this.renumber(); this.changed(); } }
  clearMarks() { this.marks.length = 0; this.changed(); }

  pointCount() { return this.marks.filter(m => m.type === 'point').length; }

  // Full-resolution PNG of the image (with the current brightness/contrast) and all marks burned in.
  async exportPNG() {
    const c = document.createElement('canvas');
    c.width = this.image.width; c.height = this.image.height;
    const ctx = c.getContext('2d');
    ctx.filter = this.filterCss();
    ctx.drawImage(this.image, 0, 0);
    ctx.filter = 'none';
    for (const m of this.marks) drawMark(ctx, m, 1, this.formatLength);
    const blob = await new Promise(res => c.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---------- internals ----------
  viewSize() { return { w: this.stage.clientWidth, h: this.stage.clientHeight }; }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = this.viewSize();
    const hadSize = this.canvas.width > 0 && this.lastW;
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    if (hadSize && this.image) { // keep the image centred where it was
      this.tx += (w - this.lastW) / 2; this.ty += (h - this.lastH) / 2;
    }
    this.lastW = w; this.lastH = h;
    this.render();
  }

  toImage(e) {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left - this.tx) / this.scale, (e.clientY - r.top - this.ty) / this.scale];
  }

  local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  pointerDown(e) {
    if (!this.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const panGesture = this.tool === 'pan' || e.button === 1 || e.button === 2 || this.spaceDown;
    if (panGesture) {
      const [x, y] = this.local(e);
      this.drag = { kind: 'pan', x, y, tx: this.tx, ty: this.ty };
      this.stage.classList.add('panning');
      return;
    }
    if (e.button !== 0) return;
    const p = this.toImage(e);
    const width = this.size / this.scale; // keep the on-screen thickness the user chose
    if (this.tool === 'point') {
      this.marks.push({ type: 'point', color: this.color, r: Math.max(2.5, this.size * 1.6) / this.scale, x: p[0], y: p[1] });
      this.renumber();
      this.changed();
      return;
    }
    if (this.tool === 'scale') this.scaleDraft = null;
    this.draft = this.tool === 'free'
      ? { type: 'free', color: this.color, width, pts: [p] }
      : this.tool === 'scale'
        ? { type: 'scale', color: '#ffffff', width: 2 / this.scale, pts: [p, p] }
        : { type: 'line', color: this.color, width, pts: [p, p] };
    this.drag = { kind: 'draw' };
  }

  pointerMove(e) {
    if (!this.drag) return;
    if (this.drag.kind === 'pan') {
      const [x, y] = this.local(e);
      this.tx = this.drag.tx + (x - this.drag.x);
      this.ty = this.drag.ty + (y - this.drag.y);
      this.render();
      return;
    }
    const p = this.toImage(e);
    if (this.draft.type === 'free') {
      const last = this.draft.pts[this.draft.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) * this.scale >= 1.5) this.draft.pts.push(p);
    } else {
      this.draft.pts[1] = p;
    }
    this.render();
  }

  pointerUp(e) {
    if (!this.drag) return;
    if (this.drag.kind === 'draw' && this.draft) {
      const d = this.draft;
      const keep = d.type === 'free' ? d.pts.length > 1 : lineLength(d) * this.scale > 2;
      this.draft = null;
      if (keep && d.type === 'scale') {
        this.scaleDraft = d;
        this.render();
        this.onScaleLine(lineLength(d));
      } else if (keep) {
        this.marks.push(d);
        this.renumber();
      }
    }
    this.drag = null;
    this.stage.classList.remove('panning');
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    this.changed();
  }

  wheel(e) {
    e.preventDefault();
    const [x, y] = this.local(e);
    const factor = Math.pow(1.0015, -e.deltaY);
    this.zoomBy(factor, x, y);
  }

  renumber() {
    const n = { point: 0, line: 0 };
    for (const m of this.marks) if (m.type in n) m.n = ++n[m.type];
  }

  changed() { this.render(); this.onChange(this); }

  render() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.image) return;
    ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, dpr * this.tx, dpr * this.ty);
    // Show crisp pixels when zoomed far in, smooth when zoomed out.
    ctx.imageSmoothingEnabled = this.scale < 3;
    ctx.imageSmoothingQuality = 'high';
    ctx.filter = this.filterCss();
    ctx.drawImage(this.image, 0, 0);
    ctx.filter = 'none';
    for (const m of this.marks) drawMark(ctx, m, this.scale, this.formatLength);
    if (this.scaleDraft) drawMark(ctx, this.scaleDraft, this.scale, this.formatLength);
    if (this.draft) drawMark(ctx, this.draft, this.scale, this.formatLength);
  }
}

function lineLength(m) {
  const [a, b] = m.pts;
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

// Draw one mark in image coordinates. `scale` is the current zoom (1 when exporting) and is
// only used to keep the length label readable on screen.
function drawMark(ctx, m, scale, fmt) {
  ctx.save();
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (m.type === 'scale') {
    // Calibration line: dashed white over a dark outline so it shows on any background.
    const [a, b] = m.pts;
    const w = 2 / scale;
    ctx.lineWidth = w * 2.5; ctx.strokeStyle = 'rgba(0,0,0,.8)';
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.lineWidth = w; ctx.strokeStyle = '#fff'; ctx.setLineDash([8 / scale, 5 / scale]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    const fs = 13 / scale;
    label(ctx, `Scale line: ${Math.round(lineLength(m))} px`, b[0] + fs * 0.5, b[1] - fs * 0.5, fs, '#fff');
  } else if (m.type === 'free' || m.type === 'line') {
    ctx.lineWidth = m.width;
    ctx.beginPath();
    m.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    if (m.type === 'line') {
      const [a, b] = m.pts;
      for (const p of [a, b]) { ctx.beginPath(); ctx.arc(p[0], p[1], m.width * 1.2, 0, Math.PI * 2); ctx.fill(); }
      const len = lineLength(m);
      if (len > 0) {
        const fs = Math.max(12 / scale, m.width * 4);
        label(ctx, `${m.n ? 'L' + m.n + ': ' : ''}${fmt ? fmt(len) : Math.round(len) + ' px'}`, b[0] + fs * 0.5, b[1] - fs * 0.5, fs, m.color);
      }
    }
  } else if (m.type === 'point') {
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = m.r * 0.35;
    ctx.strokeStyle = 'rgba(0,0,0,.75)';
    ctx.stroke();
    if (m.n) label(ctx, String(m.n), m.x + m.r * 1.4, m.y - m.r * 1.4, m.r * 2.6, m.color);
  }
  ctx.restore();
}

function label(ctx, text, x, y, size, color) {
  ctx.font = `600 ${size}px "Segoe UI", sans-serif`;
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = size * 0.22;
  ctx.strokeStyle = 'rgba(0,0,0,.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}
