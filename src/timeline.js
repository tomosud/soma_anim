// The timeline: one row of whole-body keys.  Drag on the ruler to scrub, drag a key to move it
// (Alt + drag copies it).  The band between two keys names the reference motion used for the in-between.
export class Timeline {
  constructor(canvas, project, api) {
    this.canvas = canvas; this.project = project; this.api = api;
    this.ctx = canvas.getContext('2d');
    this.drag = null;
    this.hover = null;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown', e => this.down(e));
    canvas.addEventListener('pointermove', e => this.move(e));
    canvas.addEventListener('pointerup', e => this.up(e));
    canvas.addEventListener('pointercancel', e => this.up(e));
  }

  get pad() { return 22; }
  x(f) { return this.pad + f * (this.w - this.pad * 2) / this.project.length; }
  f(x) { return Math.max(0, Math.min(this.project.length, Math.round((x - this.pad) * this.project.length / (this.w - this.pad * 2)))); }

  keyNear(x, y) {
    if (y < 30) return null;
    let best = null, bd = 9;
    for (const k of this.project.keys) { const d = Math.abs(this.x(k.frame) - x); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  down(e) {
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    this.canvas.setPointerCapture(e.pointerId);
    const k = this.keyNear(x, y);
    if (k) {
      this.drag = { key: k, started: false, copy: e.altKey, from: k.frame };
      this.api.seek(k.frame);
    } else {
      this.drag = { scrub: true };
      this.api.seek(this.f(x));
    }
  }

  move(e) {
    const r = this.canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    if (!this.drag) {
      const k = this.keyNear(x, y);
      this.canvas.style.cursor = k ? 'grab' : 'pointer';
      return;
    }
    if (this.drag.scrub) { this.api.seek(this.f(x)); return; }
    const f = this.f(x), d = this.drag;
    if (f === d.key.frame) return;
    if (!d.started) {
      d.started = true;
      this.api.beforeMove();
      if (d.copy) { d.key = this.project.setKey(f, d.key.v, d.key.pins); this.api.seek(f); this.draw(); return; }
    }
    if (this.project.moveKey(d.key, f)) this.api.seek(f), this.draw();
  }

  up() {
    const d = this.drag;
    this.drag = null;
    if (d && d.started) this.api.moved();
  }

  draw() {
    const c = this.canvas, dpr = Math.min(2, devicePixelRatio || 1);
    const w = this.w = c.clientWidth, h = this.h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = this.ctx, p = this.project;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#1f2227'; g.fillRect(0, 0, w, h);
    // ruler
    const px = (w - this.pad * 2) / p.length;
    const major = [1, 2, 5, 10, 20, 30, 60, 120, 300].find(s => s * px >= 46) || 600;
    const minor = major >= 10 ? major / (major % 10 === 0 ? 10 : 5) : 1;
    g.font = '11px "Segoe UI", sans-serif'; g.textBaseline = 'top';
    for (let f = 0; f <= p.length; f += minor) {
      const x = Math.round(this.x(f)) + 0.5, big = f % major === 0;
      g.strokeStyle = big ? '#5a626f' : '#353a43';
      g.beginPath(); g.moveTo(x, big ? 14 : 22); g.lineTo(x, 28); g.stroke();
      if (big) { g.fillStyle = '#8a929e'; g.fillText(String(f), x + 3, 3); }
    }
    g.strokeStyle = '#353a43'; g.beginPath(); g.moveTo(0, 28.5); g.lineTo(w, 28.5); g.stroke();
    // in-between bands
    const y0 = 40, bh = 26;
    for (const s of p.segments) {
      const a = this.x(s.from), b = this.x(s.to);
      const mb = s.match?.clip === 'MotionBricks';
      g.fillStyle = mb ? 'rgba(118,140,255,0.32)' : s.match ? 'rgba(63,174,122,0.28)' : 'rgba(120,130,150,0.2)';
      g.fillRect(a, y0, b - a, bh);
      if (s.match && b - a > 40) {
        g.save(); g.beginPath(); g.rect(a + 8, y0, b - a - 16, bh); g.clip();
        g.fillStyle = mb ? '#c3ccff' : '#9fd9bb'; g.textBaseline = 'middle';
        const sp = Math.abs(s.match.speed - 1) > 0.05 ? ` ×${s.match.speed.toFixed(2)}` : '';
        g.fillText((s.pending ? '生成中…  ' : '') + s.match.clip.replace(/_[0-9a-f]{6}$/, '').replace(/_/g, ' ') + sp, a + 12, y0 + bh / 2);
        g.restore();
      }
    }
    // keys
    for (const k of p.keys) {
      const x = this.x(k.frame), y = y0 + bh / 2, r = 7;
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
      g.fillStyle = k.frame === this.api.frame() ? '#ffffff' : '#ffd24a';
      g.fill(); g.strokeStyle = '#1b1d21'; g.lineWidth = 1.5; g.stroke(); g.lineWidth = 1;
    }
    // playhead
    const x = Math.round(this.x(this.api.frame())) + 0.5;
    g.strokeStyle = '#4fb0ff'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillStyle = '#4fb0ff'; g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 9); g.closePath(); g.fill();
  }
}
