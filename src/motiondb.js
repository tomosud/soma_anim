// The reference motion database (Mixamo clips on the SOMA skeleton, built by soma-fighter-web
// tools/build_posedb.mjs) and the SOMA skeleton it is stored on.
//
// SOMA space: metres, Y up, the T-pose faces +Z.  A pose is {root:[x,y,z], q:Float32Array(30*4)}:
// the hips position and the WORLD rotation (quaternion x,y,z,w) of each of the 30 joints.
//
// The feature layout (64 numbers per entry, in the body frame of the frame) is the one of
// soma-fighter-web src/posedb.js.  Only the static part is used here:
//   0-5 feet position L,R   14 hips height   16-21 hands position L,R   22-24 head position
export const DIM = 64;
export const F_FEET = 0, F_HIPS_H = 14, F_HANDS = 16, F_HEAD = 22;

// --- quaternions (x,y,z,w; q1*q2 applies q2 first, as in three.js) ---------
export const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
export const qinv = q => [-q[0], -q[1], -q[2], q[3]];
export function qrot(q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export const qyaw = a => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];
export function qfromTo(a, b) {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const q = [c[0], c[1], c[2], 1 + d];
  const l = Math.hypot(...q);
  return l < 1e-9 ? [0, 0, 0, 1] : q.map(x => x / l);
}

export class SomaRig {
  constructor(json) {
    this.names = json.joints.map(j => j.name);
    this.index = Object.fromEntries(this.names.map((n, i) => [n, i]));
    this.parents = json.joints.map(j => j.parent);
    this.restPos = json.joints.map(j => j.position);
    this.restRot = json.joints.map(j => { const l = Math.hypot(...j.rotation); return j.rotation.map(x => x / l); });
    this.n = this.names.length;
    // bone offset in the frame of the parent
    this.offset = this.names.map((_, j) => {
      const p = this.parents[j];
      if (p < 0) return [0, 0, 0];
      const d = [0, 1, 2].map(k => this.restPos[j][k] - this.restPos[p][k]);
      return qrot(qinv(this.restRot[p]), d);
    });
    this.extra = Object.fromEntries(json.extras.map(e => [e.name, e]));
    this.legR = this.index.RightLeg; this.legL = this.index.LeftLeg;
    this.mirrorIndex = this.names.map(n => this.index[n.startsWith('Left') ? 'Right' + n.slice(4) : n.startsWith('Right') ? 'Left' + n.slice(5) : n]);
    this.hipHeight = this.restPos[0][1];
    this.ankleHeight = this.restPos[this.index.LeftFoot][1];
  }

  rot(pose, j) { const q = pose.q, o = j * 4; return [q[o], q[o + 1], q[o + 2], q[o + 3]]; }

  /** World joint positions. */
  positions(pose) {
    const P = new Array(this.n);
    P[0] = pose.root.slice();
    for (let j = 1; j < this.n; j++) {
      const p = this.parents[j], d = qrot(this.rot(pose, p), this.offset[j]);
      P[j] = [P[p][0] + d[0], P[p][1] + d[1], P[p][2] + d[2]];
    }
    return P;
  }

  /** Facing on the ground (radians, atan2(x, z)) from the two thigh joints. */
  heading(P) {
    const ax = P[this.legR][0] - P[this.legL][0], az = P[this.legR][2] - P[this.legL][2];
    const l = Math.hypot(ax, az);
    return l < 1e-6 ? 0 : Math.atan2(az / l, -ax / l);
  }

  /** Left-right mirror of a pose. */
  mirror(pose) {
    const q = new Float32Array(this.n * 4);
    for (let j = 0; j < this.n; j++) {
      const m = this.mirrorIndex[j];
      const d = qmul(this.rot(pose, m), qinv(this.restRot[m]));
      const r = qmul([d[0], -d[1], -d[2], d[3]], this.restRot[j]);
      q.set(r, j * 4);
    }
    return { root: [-pose.root[0], pose.root[1], pose.root[2]], q };
  }

  /** Rotate a pose about the vertical through its hips and put the hips at (x, z). */
  place(pose, yaw, x, z) {
    const y = qyaw(yaw), q = new Float32Array(this.n * 4);
    for (let j = 0; j < this.n; j++) q.set(qmul(y, this.rot(pose, j)), j * 4);
    return { root: [x, pose.root[1], z], q };
  }
}

export class MotionDB {
  constructor(rig, meta, buf) {
    this.rig = rig;
    this.meta = meta;
    this.clips = meta.clips;
    this.frameBytes = 12 + rig.n * 8;
    this.view = new DataView(buf, meta.poses.offset, meta.poses.bytes);
    this.n = meta.entries.count;
    this.entClip = new Uint16Array(buf, meta.entries.clipOffset, this.n);
    this.entFrame = new Uint16Array(buf, meta.entries.frameOffset, this.n);
    this.entMirror = new Uint8Array(buf, meta.entries.mirrorOffset, this.n);
    const raw = new Int16Array(buf, meta.features.offset, this.n * DIM);
    const k = 1 / meta.features.quant, s = meta.features.scale;
    // features in metres (body frame)
    this.feat = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) this.feat[i] = raw[i] * k * s[i % DIM];
    this.fps = meta.fps || 30;
    this._track = null;
  }

  static async load(rig, url) {
    const [meta, buf] = await Promise.all([fetch(url + '.json').then(r => r.json()), fetch(url + '.bin').then(r => r.arrayBuffer())]);
    return new MotionDB(rig, meta, buf);
  }

  /** Frame f of clip c (canonical placement: the clip starts over the origin facing +Z). */
  pose(c, f, mirrored = false) {
    const clip = this.clips[c];
    f = Math.max(0, Math.min(clip.frames - 1, f));
    const v = this.view, n = this.rig.n;
    let o = (clip.start + f) * this.frameBytes;
    const root = [v.getFloat32(o, true), v.getFloat32(o + 4, true), v.getFloat32(o + 8, true)];
    o += 12;
    const q = new Float32Array(n * 4);
    for (let i = 0; i < n * 4; i += 4, o += 8) {
      const x = v.getInt16(o, true), y = v.getInt16(o + 2, true), z = v.getInt16(o + 4, true), w = v.getInt16(o + 6, true);
      const l = Math.hypot(x, y, z, w) || 1;
      q[i] = x / l; q[i + 1] = y / l; q[i + 2] = z / l; q[i + 3] = w / l;
    }
    const p = { root, q };
    return mirrored ? this.rig.mirror(p) : p;
  }

  /** Hips position and facing of every entry (computed once): Float32Array [x, y, z, heading] per entry. */
  track() {
    if (this._track) return this._track;
    const t = new Float32Array(this.n * 4), rig = this.rig;
    for (let i = 0; i < this.n; i++) {
      const p = this.pose(this.entClip[i], this.entFrame[i], !!this.entMirror[i]);
      const P = rig.positions(p);
      t[i * 4] = p.root[0]; t[i * 4 + 1] = p.root[1]; t[i * 4 + 2] = p.root[2]; t[i * 4 + 3] = rig.heading(P);
    }
    return this._track = t;
  }

  /**
   * Nearest entry to a static pose.  q: Float32Array(DIM) in metres (body frame),
   * w: weight per dimension (0 = not compared).
   */
  nearest(q, w, k = 1) {
    const F = this.feat, dims = [];
    for (let d = 0; d < DIM; d++) if (w[d] > 0) dims.push(d);
    const best = [];
    let worst = Infinity;
    for (let i = 0; i < this.n; i++) {
      const o = i * DIM;
      let c = 0;
      for (let j = 0; j < dims.length && c < worst; j++) { const d = dims[j], e = F[o + d] - q[d]; c += w[d] * e * e; }
      if (c >= worst) continue;
      best.push({ i, cost: c });
      best.sort((a, b) => a.cost - b.cost);
      if (best.length > k) best.length = k;
      if (best.length === k) worst = best[k - 1].cost;
    }
    return best.map(b => ({ ...b, clip: this.entClip[b.i], frame: this.entFrame[b.i], mirrored: !!this.entMirror[b.i] }));
  }
}
