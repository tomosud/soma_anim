// Putting generated motion on the rig, and the plain in-between.
//
// finish(): SOMA poses (from MotionBricks) are fitted to the rig frame by frame, the two ends are pulled onto
// the keys (the difference at each end fades linearly across the stretch), and feet that are planted stay where
// they are (no sliding).
import * as M from './m4.js';
import { BODY_FIT_CONTROLS } from './fit.js';
import { wrap } from './natural.js';
import { sameSwitches, switchesOf } from './switches.js';
import { cogOffset, cogTo } from './cog.js';

export class Inbetweener {
  constructor(rig, db, re, fitter) {
    this.rig = rig; this.db = db; this.re = re; this.fitter = fitter;
    this.bodyChannel = rig.channelControl.map(c => BODY_FIT_CONTROLS.includes(c.name));
    this.isRot = rig.channelKeys.map(k => k[k.length - 2] === 'r');
    const restY = j => rig.joints[rig.jointIndex.get(j)].rest[13];
    this.floor = { foot_l: restY('foot_l'), foot_r: restY('foot_r'), ball_l: restY('ball_l'), ball_r: restY('ball_r') };
    this.feet = ['L', 'R'].map(S => ['x', 'y', 'z'].map(a => rig.channelIndex.get(`${S}_Foot_trans.t${a}`)));
  }

  /**
   * Put n+1 placed SOMA poses (frame 0 = at key A ... frame n = at key B) on the rig and pull the two ends
   * onto the keys.  contact: [left[], right[]] booleans per frame (the foot is planted).
   */
  finish(A, B, n, placedAll, contact) {
    const it = this._finish(A, B, n, placedAll, contact);
    for (let r = it.next(); ; r = it.next()) if (r.done) return r.value;
  }

  /**
   * finish() that gives way to the page now and then: `pause()` is awaited between frames (it returns soon, or
   * waits while the animator drags a control).  The rig is put back as the page has it before each pause and at
   * the end - the page uses it.
   */
  async finishAsync(A, B, n, placedAll, contact, pause) {
    const { rig } = this, held = rig.getVector(), it = this._finish(A, B, n, placedAll, contact);
    for (let r = it.next(); ; r = it.next()) {
      if (r.done) { rig.setVector(held).evaluate(); return r.value; }
      if (pause.due()) { const mine = rig.getVector(); rig.setVector(held).evaluate(); await pause(); held.set(rig.getVector()); rig.setVector(mine).evaluate(); }
    }
  }

  *_finish(A, B, n, placedAll, contact) {
    const { rig, re, fitter } = this;
    // everything the reference does not drive (fingers, the whole-body control): plain ease from A to B
    // (the switches - follow, pvFollow ... - are not in-betweened: the stretch keeps those of key A, and key B
    //  is seen through them, with its pose kept)
    if (!sameSwitches(rig, A, B)) B = switchesOf(rig, A, B);
    const other = k => { const u = ease(k / n), v = new Float64Array(A.length); for (let i = 0; i < v.length; i++) v[i] = A[i] + (this.isRot[i] ? wrap(B[i] - A[i]) : B[i] - A[i]) * u; return v; };
    const V = [];
    for (let k = 0; k <= n; k++) {
      // the body is fitted under the whole-body control of this frame
      rig.setVector(other(k));
      fitter.fit(re.targets(placedAll[k]));
      V.push(rig.getVector());
      yield;
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
    // The COG goes along with the hips (fitted, the body moves under the COG of the keys and leaves it behind): it
    // keeps to the hips as far off them as it is in the keys, that distance changing evenly from key A to key B.
    const offA = cogOffset(rig, A), offB = cogOffset(rig, B);
    for (let k = 1; k < n; k++) { out[k] = cogTo(rig, out[k], M.lerp(offA, offB, k / n)); yield; }
    // A hand or a foot that turns over in a frame or two (the model can flip a wrist on its way to a key) is turned
    // evenly over the frames around the flip instead; then every frame is kept inside the joint ranges.
    if (this.limits) {
      for (let k = 1; k < n; k++) { out[k] = this.limits.apply(out[k]); yield; }
      this.limits.smooth(out);
    } else this.smoothTurns(out);
    return { frames: out.slice(1, n), match: null };
  }

  /** Turns of the hands and feet faster than SNAP degrees a frame spread over the frames around them. */
  smoothTurns(out) {
    const { rig, fitter } = this, n = out.length - 1;
    for (const [ctl, joint] of [['L_Hand_rot', 'hand_l'], ['R_Hand_rot', 'hand_r'], ['L_Foot_rot', 'foot_l'], ['R_Foot_rot', 'foot_r']]) {
      const R = out.map(v => (rig.setVector(v).evaluate(), M.toQuat(M.rotation(rig.jointWorld(joint)))));
      for (let k = 1; k <= n; k++) {
        if (angle(R[k - 1], R[k]) <= SNAP) continue;
        const a = Math.max(0, k - 4), b = Math.min(n, k + 3);
        for (let i = a + 1; i < b; i++) {
          const q = M.qslerp(R[a], R[b], (i - a) / (b - a));
          rig.setVector(out[i]).evaluate();
          fitter._rot(ctl, M.mul(fitter.k[ctl], M.fromQuat(q)));
          rig.evaluate();
          out[i] = rig.getVector();
          R[i] = q;
        }
        k = b;
      }
    }
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

  /**
   * The plain in-between with its feet looked after: a foot that stands in both keys stays where it stands, and
   * steps over (lifted, one foot after the other) if the keys have it in two places.  Frames 1..n-1.
   */
  steps(A, B, n) {
    const out = [A, ...this.interpolate(A, B, n).frames, B];
    const { rig } = this, down = v => { rig.setVector(v).evaluate(); return [['foot_l', 'ball_l'], ['foot_r', 'ball_r']].map(([f, b]) => rig.jointWorld(f)[13] - this.floor[f] < 4 && rig.jointWorld(b)[13] - this.floor[b] < 4); };
    const a = down(A), b = down(B);
    this.plantFeet(out, [0, 1].map(e => out.map(() => a[e] && b[e])));
    return out.slice(1, n);
  }

  /** Plain eased interpolation (no reference motion). */
  interpolate(A, B, n) {
    const out = [];
    if (!sameSwitches(this.rig, A, B)) { const held = this.rig.getVector(); B = switchesOf(this.rig, A, B); this.rig.setVector(held).evaluate(); }
    for (let k = 1; k < n; k++) {
      const u = ease(k / n), v = new Float64Array(A.length);
      for (let i = 0; i < v.length; i++) v[i] = A[i] + (this.isRot[i] ? wrap(B[i] - A[i]) : B[i] - A[i]) * u;
      out.push(v);
    }
    return { frames: out, match: null };
  }
}

const ease = u => u * u * (3 - 2 * u);
// (degrees a hand or a foot may turn in one frame: a fast wrist in a strike turns about 25)
const SNAP = 35;
const angle = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]))) * 180 / Math.PI;

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
