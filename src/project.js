// The animation: whole-body key poses on one timeline, and the frames baked from them.
// A key is {frame, v, pins}: v is the pose vector (one number per rig channel), pins the controls the
// animator placed by hand (natural posing never moves those).
export class Project {
  constructor(rig) {
    this.rig = rig;
    this.fps = 30;
    this.length = 300;
    this.mode = 'mb'; // 'mb' = MotionBricks, 'ease' = plain interpolation
    this.flow = false; // MotionBricks: pass through the keys (true) or arrive and hold (false)
    this.todo = [];
    this.tries = new Map();
    this.keys = [];
    this.baked = [];
    this.segments = []; // {from, to, match}
    this.cache = new Map();
    this.undoStack = [];
    this.redoStack = [];
  }

  zero() { return new Float64Array(this.rig.channelKeys.length); }
  /** The pose a scene starts in (a relaxed stand; the rig's own rest pose until it is set). */
  start() { return this.rest ? this.rest.slice() : this.zero(); }
  sort() { this.keys.sort((a, b) => a.frame - b.frame); }
  keyAt(frame) { return this.keys.find(k => k.frame === frame) || null; }

  /**
   * ref: {clip, frame, mirror} when the pose is a frame of the reference motion (the pose book) - the frames
   * around it tell the in-between how the pose is moved through.  'keep' leaves what the key has; anything
   * else (an edit by hand) forgets it.
   */
  setKey(frame, v, pins = null, ref = null) {
    let k = this.keyAt(frame);
    if (!k) { k = { frame, v: v.slice(), pins: new Set(pins || []), ref: ref === 'keep' ? null : ref }; this.keys.push(k); this.sort(); } else { k.v = v.slice(); if (pins) k.pins = new Set(pins); if (ref !== 'keep') k.ref = ref; }
    return k;
  }

  removeKey(frame) { this.keys = this.keys.filter(k => k.frame !== frame); }

  moveKey(key, frame) {
    frame = Math.max(0, Math.min(this.length, frame));
    if (frame === key.frame || this.keyAt(frame)) return false;
    key.frame = frame; this.sort();
    return true;
  }

  /**
   * Bake every frame.  inb: Inbetweener or null (plain interpolation until the database is there),
   * mb: MotionBricks or null.  In 'mb' mode a stretch the model has not made yet is shown with the
   * motion-matched in-between and listed in this.todo (fill() makes those, one after another).
   */
  bake(inb, mb = null) {
    const n = this.length, out = new Array(n + 1), keys = this.keys;
    this.segments = [];
    this.todo = [];
    if (!keys.length) { for (let f = 0; f <= n; f++) out[f] = this.start(); this.baked = out; return; }
    for (let f = 0; f <= Math.min(n, keys[0].frame); f++) out[f] = keys[0].v;
    for (let f = keys[keys.length - 1].frame; f <= n; f++) out[f] = keys[keys.length - 1].v;
    const used = new Set();
    const useMb = this.mode === 'mb' && inb && mb && mb.state === 'ready';
    let prevId = '';
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1], len = b.frame - a.frame;
      let seg = null, pending = false;
      // (the model's shortest move is 17 frames: for keys closer than that it is played that much faster - a
      //  strike is a fast move; under 5 frames there is nothing to make)
      if (useMb && len >= 5) {
        // (the model continues from the motion that arrives at this key, so a stretch depends on the one before)
        const next = this.flow ? keys[i + 2] : null;
        const id = 'mb|' + len + '|' + sig(a.v) + '|' + sig(b.v) + '|' + refSig(a.ref) + refSig(b.ref) + '|' + hash(prevId) + (this.flow ? '|flow|' + (next ? sig(next.v) + '|' + (next.frame - b.frame) : '') : '');
        seg = this.cache.get(id);
        used.add(id);
        if (seg && seg.failed) { if (seg.failed < 3) { this.cache.delete(id); this.tries.set(id, seg.failed); } seg = null; }
        if (!this.cache.has(id)) { this.todo.push({ id, a: a.v, b: b.v, len, prevId, opts: { flow: this.flow, next: next?.v ?? null, nextLen: next ? next.frame - b.frame : 0, refA: a.ref || null, refB: b.ref || null } }); pending = true; }
        prevId = id;
      } else prevId = '';
      if (!seg) {
        // (what MotionBricks has not made, or cannot make, is eased)
        const id = (this.mode === 'mb' ? 'steps|' : 'ease|') + len + '|' + sig(a.v) + '|' + sig(b.v);
        seg = this.cache.get(id);
        // (in MotionBricks mode what the model does not make still keeps its feet: planted, or stepping over)
        if (!seg && inb) { seg = this.mode === 'mb' ? { frames: inb.steps(a.v, b.v, len), match: null } : inb.interpolate(a.v, b.v, len); this.cache.set(id, seg); }
        if (!seg) seg = { frames: plain(a.v, b.v, len), match: null };
        used.add(id);
      }
      for (let k = 1; k < len; k++) if (a.frame + k <= n) out[a.frame + k] = seg.frames[k - 1];
      if (a.frame <= n) out[a.frame] = a.v;
      if (b.frame <= n) out[b.frame] = b.v;
      this.segments.push({ from: a.frame, to: b.frame, match: seg.match, pending });
    }
    if (this.cache.size > 80) for (const id of [...this.cache.keys()]) if (!used.has(id)) this.cache.delete(id);
    this.baked = out;
  }

  /** Make the stretches bake() left for MotionBricks, in order; onUpdate() after each one lands. */
  async fill(inb, mb, onUpdate) {
    const version = this.fillVersion = (this.fillVersion || 0) + 1;
    while (version === this.fillVersion && this.todo.length) {
      const t = this.todo[0];
      let r;
      try { r = await mb.generate(t.a, t.b, t.len, this.cache.get(t.prevId)?.tail ?? null, t.opts); } catch (e) {
        console.error(e);
        r = { failed: (this.tries.get(t.id) || 0) + 1, error: String(e?.message ?? e) };
      }
      this.cache.set(t.id, r);
      if (version !== this.fillVersion) return;
      this.bake(inb, mb);
      onUpdate(r.failed >= 3 ? r.error : null);
    }
  }

  pose(frame) { return this.keyAt(frame)?.v || this.baked[Math.max(0, Math.min(this.length, frame))] || this.start(); }

  // -- undo ---------------------------------------------------------------
  snapshot() { return JSON.stringify(this.toJSON()); }
  pushUndo() { this.undoStack.push(this.snapshot()); if (this.undoStack.length > 100) this.undoStack.shift(); this.redoStack.length = 0; }
  undo() { if (!this.undoStack.length) return false; this.redoStack.push(this.snapshot()); this.fromJSON(JSON.parse(this.undoStack.pop())); return true; }
  redo() { if (!this.redoStack.length) return false; this.undoStack.push(this.snapshot()); this.fromJSON(JSON.parse(this.redoStack.pop())); return true; }

  // -- files --------------------------------------------------------------
  toJSON() {
    return {
      format: 'soma_anim', version: 1, rig: 'Rig_Manny_BNS', fps: this.fps, length: this.length, mode: this.mode, flow: this.flow,
      keys: this.keys.map(k => ({ frame: k.frame, pins: [...k.pins], ...(k.ref ? { ref: k.ref } : {}), values: this.rig.valuesFromVector(k.v) })),
    };
  }

  fromJSON(d) {
    if (d.format !== 'soma_anim') throw Error('soma_anim のファイルではありません');
    this.fps = d.fps || 30; this.length = d.length || 300; this.mode = d.mode === 'ease' ? 'ease' : 'mb'; this.flow = !!d.flow;
    this.keys = d.keys.map(k => ({ frame: k.frame, pins: new Set(k.pins || []), ref: k.ref || null, v: this.rig.vectorFromValues(k.values) }));
    this.sort();
  }

  /** Every frame as control values, for Maya (maya/soma_anim_import.py). */
  toBake() {
    return {
      format: 'soma_anim_bake', version: 1, rig: 'Rig_Manny_BNS', fps: this.fps, start: 0, end: this.length,
      note: 'values are offsets from the rest value of each channel (the rest of every control of Rig_Manny_BNS is 0)',
      channels: this.rig.channelKeys, keys: this.keys.map(k => k.frame),
      frames: this.baked.map(v => Array.from(v, x => +x.toFixed(4))),
    };
  }
}

const refSig = r => (r ? `${r.clip}@${r.frame}${r.mirror ? 'm' : ''};` : ';');
const hash = t => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const sig = v => { let h = 2166136261; for (let i = 0; i < v.length; i++) { h ^= Math.round(v[i] * 1000); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + ':' + v.length; };

function plain(a, b, n) {
  const out = [];
  for (let k = 1; k < n; k++) { const u = k / n, s = u * u * (3 - 2 * u); out.push(a.map((x, i) => x + (b[i] - x) * s)); }
  return out;
}

/** A new scene: the rest pose at frame 0. */
export function newScene(project) {
  project.length = 300;
  project.keys = [];
  project.setKey(0, project.start());
}
