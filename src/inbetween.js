// In-betweens by motion matching.
//
// Between two key poses A and B, n frames apart, the reference database is searched for the stretch of
// real motion that starts like A, ends like B, and travels and turns as far as B is from A.  That stretch
// is put on the rig frame by frame and its two ends are pulled onto the keys (the difference at each end
// fades linearly across the stretch, as MotionBricks' end-point correction does), so the keys are met
// exactly and what happens in between is real movement, not a blend of two poses.
// Feet that are planted in the reference stay where they are (no sliding).
import * as M from './m4.js';
import { DIM, F_FEET, F_HIPS_H, F_HANDS, F_HEAD } from './motiondb.js';
import { queryFromRig, bodyPoint } from './retarget.js';
import { BODY_FIT_CONTROLS } from './fit.js';
import { wrap } from './natural.js';

const POSE_DIMS = [[F_FEET, 6, 1], [F_HIPS_H, 1, 2], [F_HANDS, 6, 1], [F_HEAD, 3, 1.5]];
const SPEEDS = [1, 0.8, 1.25, 0.66, 1.5, 0.5, 2];
const wrapRad = a => Math.atan2(Math.sin(a), Math.cos(a));

export class Inbetweener {
  constructor(rig, db, re, fitter) {
    this.rig = rig; this.db = db; this.re = re; this.fitter = fitter;
    this.bodyChannel = rig.channelControl.map(c => BODY_FIT_CONTROLS.includes(c.name));
    this.isRot = rig.channelKeys.map(k => k[k.length - 2] === 'r');
    // compact pose features: 16 numbers per entry, already multiplied by sqrt(weight)
    const n = db.n, P = this.P = new Float32Array(n * 16);
    this.dims = [];
    for (const [o, c, w] of POSE_DIMS) for (let i = 0; i < c; i++) this.dims.push([o + i, Math.sqrt(w)]);
    for (let i = 0; i < n; i++) for (let d = 0; d < 16; d++) P[i * 16 + d] = db.feat[i * DIM + this.dims[d][0]] * this.dims[d][1];
    // falls, hits and get-ups are never what lies between two ordinary poses
    this.skip = db.tagged(['fall', 'getup', 'hit']);
    const restY = j => rig.joints[rig.jointIndex.get(j)].rest[13];
    this.floor = { foot_l: restY('foot_l'), foot_r: restY('foot_r'), ball_l: restY('ball_l'), ball_r: restY('ball_r') };
    this.feet = ['L', 'R'].map(S => ['x', 'y', 'z'].map(a => rig.channelIndex.get(`${S}_Foot_trans.t${a}`)));
  }

  _compact(q) { return this.dims.map(([d, w]) => q[d] * w); }

  /** The best stretch of reference motion from pose a to pose b in n frames. */
  search(qa, qb, n) {
    const { db, P } = this;
    const T = db.track();
    const a = this._compact(qa.q), b = this._compact(qb.q);
    // how far and how much B is turned from A, seen from A
    const want = bodyPoint(qb.hip, qa.hip, qa.heading);
    const turn = wrapRad(qb.heading - qa.heading);
    const N = db.n, skip = this.skip;
    // cost of starting at each entry / ending at each entry
    const ca = new Float32Array(N), cb = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let x = 0, y = 0;
      for (let d = 0, o = i * 16; d < 16; d++) { const e = P[o + d] - a[d], f = P[o + d] - b[d]; x += e * e; y += f * f; }
      ca[i] = x; cb[i] = y;
    }
    let best = null;
    for (const speed of SPEEDS) {
      const step = Math.max(1, Math.round(n * speed / 2)); // entries are 2 frames apart
      const pen = 0.12 * Math.abs(Math.log2(step * 2 / n));
      for (let i = 0; i + step < N; i++) {
        const j = i + step;
        if (skip[i] || (best && ca[i] + pen >= best.cost)) continue;
        if (db.entClip[i] !== db.entClip[j] || db.entMirror[i] !== db.entMirror[j] || db.entFrame[j] - db.entFrame[i] !== step * 2) continue;
        const h = T[i * 4 + 3], c = Math.cos(h), s = Math.sin(h);
        const dx = T[j * 4] - T[i * 4], dz = T[j * 4 + 2] - T[i * 4 + 2];
        const ex = dx * c - dz * s - want[0], ez = dx * s + dz * c - want[2];
        const et = wrapRad(T[j * 4 + 3] - h - turn);
        // how far the stretch strays from the straight way between its own ends (at its middle): the calm one wins
        let stray = 0;
        for (let d = 0, m = (i + (step >> 1)) * 16, oi = i * 16, oj = j * 16; d < 16; d++) { const e = P[m + d] - 0.5 * (P[oi + d] + P[oj + d]); stray += e * e; }
        const cost = ca[i] + cb[j] + 4 * (ex * ex + ez * ez) + 0.5 * et * et + pen + 1.5 * stray;
        if (!best || cost < best.cost) best = { cost, i, j, frames: step * 2, speed: step * 2 / n };
      }
    }
    return best;
  }

  /** The reference stretch for A -> B placed in the world: n+1 SOMA poses, foot contacts, and what it is. */
  stretch(A, B, n) {
    const { rig, db, re, fitter } = this;
    rig.setVector(A).evaluate(); const qa = queryFromRig(rig, re);
    rig.setVector(B).evaluate(); const qb = queryFromRig(rig, re);
    const hit = this.search(qa, qb, n);
    if (!hit) return null;
    const clip = db.entClip[hit.i], mirrored = !!db.entMirror[hit.i], f0 = db.entFrame[hit.i];
    const T = db.track();
    const h0 = T[hit.i * 4 + 3], x0 = T[hit.i * 4], z0 = T[hit.i * 4 + 2];
    const yaw = qa.heading - h0, c = Math.cos(yaw), s = Math.sin(yaw);
    const soma = db.rig;
    const placedAll = [], contact = [[], []];
    const feetIdx = [soma.index.LeftFoot, soma.index.RightFoot];
    let prevFeet = null;
    for (let k = 0; k <= n; k++) {
      // (eased a little into and out of the keys: a stretch cut out of a longer motion arrives at full speed)
      const u = k / n, f = f0 + (0.5 * u + 0.5 * ease(u)) * hit.frames, fa = Math.floor(f), t = f - fa;
      let pose = db.pose(clip, fa, mirrored);
      if (t > 1e-3) pose = lerpPose(pose, db.pose(clip, fa + 1, mirrored), t);
      const dx = pose.root[0] - x0, dz = pose.root[2] - z0;
      const placed = soma.place(pose, yaw, qa.hip[0] + dx * c + dz * s, qa.hip[2] - dx * s + dz * c);
      // planted feet of the reference: low and not moving
      const Pp = soma.positions(placed), feet = feetIdx.map(j => Pp[j]);
      for (let e = 0; e < 2; e++) {
        const sp = prevFeet ? M.dist(feet[e], prevFeet[e]) * db.fps * (hit.frames / n) : 0;
        contact[e].push(feet[e][1] < soma.ankleHeight + 0.05 && sp < 0.35);
      }
      prevFeet = feet;
      placedAll.push(placed);
    }
    for (let e = 0; e < 2; e++) contact[e][0] = contact[e][1] ?? contact[e][0];
    return { placed: placedAll, contact, a: qa, b: qb, match: { clip: db.clips[clip].name, frame: f0, frames: hit.frames, speed: hit.speed, mirrored, cost: hit.cost } };
  }

  /**
   * A, B: pose vectors of the two keys, n: frames from A to B.
   * Returns {frames: [vector for frame 1 .. n-1], match} or null when there is nothing to do.
   */
  generate(A, B, n) {
    if (n < 2) return { frames: [], match: null };
    const st = this.stretch(A, B, n);
    if (!st) return null;
    const r = this.finish(A, B, n, st.placed, st.contact);
    r.match = st.match;
    return r;
  }

  /**
   * Put n+1 placed SOMA poses (frame 0 = at key A ... frame n = at key B) on the rig and pull the two ends
   * onto the keys.  contact: [left[], right[]] booleans per frame (the foot is planted).
   */
  finish(A, B, n, placedAll, contact) {
    const { rig, re, fitter } = this;
    // everything the reference does not drive (fingers, the whole-body control): plain ease from A to B
    const other = k => { const u = ease(k / n), v = new Float64Array(A.length); for (let i = 0; i < v.length; i++) v[i] = A[i] + (this.isRot[i] ? wrap(B[i] - A[i]) : B[i] - A[i]) * u; return v; };
    const V = [];
    for (let k = 0; k <= n; k++) {
      // the body is fitted under the whole-body control of this frame
      rig.setVector(other(k));
      fitter.fit(re.targets(placedAll[k]));
      V.push(rig.getVector());
    }
    // continuous Euler angles along the stretch
    for (let k = 1; k <= n; k++) for (let i = 0; i < V[k].length; i++) if (this.isRot[i]) V[k][i] = V[k - 1][i] + wrap(V[k][i] - V[k - 1][i]);
    // pull the ends onto the keys
    const eA = new Float64Array(A.length), eB = new Float64Array(A.length);
    for (let i = 0; i < A.length; i++) {
      eA[i] = this.isRot[i] ? wrap(A[i] - V[0][i]) : A[i] - V[0][i];
      eB[i] = this.isRot[i] ? wrap(B[i] - V[n][i]) : B[i] - V[n][i];
    }
    const out = [];
    for (let k = 0; k <= n; k++) {
      const u = k / n, v = new Float64Array(A.length);
      for (let i = 0; i < v.length; i++) {
        if (this.bodyChannel[i]) v[i] = V[k][i] + (1 - u) * eA[i] + u * eB[i];
        else v[i] = V[k][i];
      }
      out.push(v);
    }
    this.plantFeet(out, contact);
    return { frames: out.slice(1, n), match: null };
  }

  /**
   * Feet that are planted stay where they are - in the world, whatever the whole-body control does under them -
   * and no foot goes under the floor.  out[0] and out[n] are the keys and are not touched.
   */
  plantFeet(out, contact) {
    const { rig } = this, n = out.length - 1;
    const feet = [['L_Foot_trans', 'foot_l', 'ball_l'], ['R_Foot_trans', 'foot_r', 'ball_r']];
    const rec = feet.map(() => ({ pos: [], inv: [], lift: [] }));
    for (let k = 0; k <= n; k++) {
      rig.setVector(out[k]).evaluate();
      feet.forEach(([c, f, b], e) => {
        const node = rig.node(c);
        rec[e].pos.push(M.pos(node.world));
        rec[e].inv.push(M.inv(node.parent.world));
        rec[e].lift.push(Math.min(rig.jointWorld(f)[13] - this.floor[f], rig.jointWorld(b)[13] - this.floor[b]));
      });
    }
    // (a contact that drops out for a frame or two is still the same plant; one that lasts a frame or two is none)
    const clean = flags => {
      const f = flags.slice();
      for (let k = 1; k < n; k++) if (!f[k]) { let e = k; while (e < n && !f[e + 1]) e++; if (f[k - 1] && e < n && e - k < 3) for (let g = k; g <= e; g++) f[g] = true; k = e; }
      for (let k = 0; k <= n; k++) if (f[k]) { let e = k; while (e < n && f[e + 1]) e++; if (e - k < 3 && k > 0 && e < n) for (let g = k; g <= e; g++) f[g] = false; k = e; }
      return f;
    };
    feet.forEach(([c], e) => {
      const r = rec[e], restT = rig.node(c).restT;
      // (the foot that has farther to go steps first)
      const first = M.dist(rec[0].pos[0], rec[0].pos[n]) >= M.dist(rec[1].pos[0], rec[1].pos[n]) ? 0 : 1;
      const held = lockFoot(r.pos, clean(contact[e]), e === first ? 0 : 1);
      for (let k = 1; k < n; k++) {
        let p = held[k];
        const lift = r.lift[k] + (p[1] - r.pos[k][1]);
        if (lift < 0) p = [p[0], p[1] - lift, p[2]];
        const t = M.sub(M.xpoint(p, r.inv[k]), restT);
        this.feet[e].forEach((i, a2) => { out[k][i] = t[a2]; });
      }
    });
  }

  /** Plain eased interpolation (no reference motion). */
  interpolate(A, B, n) {
    const out = [];
    for (let k = 1; k < n; k++) {
      const u = ease(k / n), v = new Float64Array(A.length);
      for (let i = 0; i < v.length; i++) v[i] = A[i] + (this.isRot[i] ? wrap(B[i] - A[i]) : B[i] - A[i]) * u;
      out.push(v);
    }
    return { frames: out, match: null };
  }
}

const ease = u => u * u * (3 - 2 * u);

function lerpPose(a, b, t) {
  const q = new Float32Array(a.q.length);
  for (let i = 0; i < q.length; i += 4) {
    const d = a.q[i] * b.q[i] + a.q[i + 1] * b.q[i + 1] + a.q[i + 2] * b.q[i + 2] + a.q[i + 3] * b.q[i + 3];
    const s = d < 0 ? -t : t;
    let x = a.q[i] * (1 - t) + b.q[i] * s, y = a.q[i + 1] * (1 - t) + b.q[i + 1] * s, z = a.q[i + 2] * (1 - t) + b.q[i + 2] * s, w = a.q[i + 3] * (1 - t) + b.q[i + 3] * s;
    const l = Math.hypot(x, y, z, w);
    q[i] = x / l; q[i + 1] = y / l; q[i + 2] = z / l; q[i + 3] = w / l;
  }
  return { root: M.lerp(a.root, b.root, t), q };
}

/**
 * Keep a foot still while it is planted.  pos: its world position per frame, contact: planted or not.
 * Returns the new positions.  The first and last frames are the keys and never change: a plant that touches
 * a key holds the key's position, one that lasts from key to key goes straight from one to the other, one in
 * the middle holds where it landed, and the steps in between take up the difference.
 */
function lockFoot(pos, contact, order = 0) {
  const n = pos.length - 1;
  const off = pos.map(() => null); // offset to add
  const step = (from, to, u) => { // a step from one place to another: off the floor in the middle
    const t = u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u), d = M.dist(from, to);
    const p = M.lerp(from, to, t);
    p[1] += Math.min(9, 2 + 0.12 * d) * 4 * t * (1 - t) * (d > 3 ? 1 : 0);
    return p;
  };
  let k = 0;
  while (k <= n) {
    if (!contact[k]) { k++; continue; }
    let e = k;
    while (e < n && contact[e + 1]) e++;
    if (e - k >= 2) {
      const whole = k === 0 && e === n;
      // (planted from key to key, yet the keys have it in two places: one step, the two feet one after the other)
      const u0 = order ? 0.5 : 0.08, u1 = order ? 0.92 : 0.5;
      for (let f = k; f <= e; f++) {
        const want = whole ? step(pos[0], pos[n], (f / n - u0) / (u1 - u0)) : pos[k === 0 ? 0 : e === n ? n : k];
        off[f] = M.sub(want, pos[f]);
      }
    }
    k = e + 1;
  }
  off[0] = [0, 0, 0]; off[n] = [0, 0, 0];
  // steps: carry the offset from one plant to the next, lifting the foot if it is carried far
  let last = 0;
  for (let f = 1; f <= n; f++) {
    if (!off[f]) continue;
    const d = M.dist(off[last], off[f]);
    for (let g = last + 1; g < f; g++) {
      const u = (g - last) / (f - last);
      off[g] = M.lerp(off[last], off[f], u);
      if (d > 6) off[g][1] += Math.min(6, 0.1 * d) * 4 * u * (1 - u);
    }
    last = f;
  }
  return pos.map((p, f) => M.add(p, off[f]));
}
