// Numbers for how an animation moves: foot sliding, leaving the floor, going through it, tipping over, spinning,
// leaving the way between the keys, gestures nobody asked for, distance from the reference motion, and kinks.
// Used by tools/selftest.js (which also draws them as heat maps).
//
// All lengths in cm, 30 fps.  `frames` are pose vectors (one per frame), `keys` the frame numbers of the keys.
import * as M from './m4.js';
import { queryFromRig, rigHeading } from './retarget.js';
import { poseWeights } from './natural.js';

const JOINTS = ['pelvis', 'neck_01', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r'];
const MOVERS = ['pelvis', 'head', 'hand_l', 'hand_r'];
const LIMBS = ['head', 'hand_l', 'hand_r'];
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const over = (x, ok, bad) => Math.max(0, Math.min(1, (x - ok) / (bad - ok)));

/** What is measured per frame, and from where to where it counts as [fine, bad]. */
export const SERIES = {
  slide: ['foot slide cm/s', 3, 25], air: ['both feet off (frames)', 2, 10], sink: ['foot under floor cm', 1.5, 8],
  hips: ['hips above/below keys cm', 6, 30], tilt: ['body tips deg', 15, 50], spin: ['facing off deg', 30, 90],
  path: ['off the way cm', 15, 50], gesture: ['unasked gesture cm', 15, 45], ref: ['far from reference', 28, 55], accel: ['jerk cm/f2', 4, 12],
};

export class Evaluator {
  constructor(rig, db, re) {
    this.rig = rig; this.db = db; this.re = re;
    const rest = n => rig.joints[rig.jointIndex.get(n)].rest[13];
    this.floor = { foot_l: rest('foot_l'), foot_r: rest('foot_r'), ball_l: rest('ball_l'), ball_r: rest('ball_r') };
    this.weights = poseWeights(new Set());
    this.skip = db.tagged(['fall', 'getup', 'hit']);
  }

  /** Positions of the joints that matter, facing, and the distance to the nearest reference pose, per frame. */
  sample(frames, ref = true) {
    const { rig } = this, held = rig.getVector(), out = [];
    for (const v of frames) {
      rig.setVector(v).evaluate();
      const P = {};
      for (const j of JOINTS) P[j] = M.pos(rig.jointWorld(j));
      const q = queryFromRig(rig, this.re);
      const hit = ref ? this.db.nearest(q.q, this.weights, 1, this.skip)[0] : null;
      const h = rigHeading(rig), c = Math.cos(h), s = Math.sin(h);
      // the limbs as the body sees them (hips on the floor, facing +z)
      const B = {};
      for (const j of LIMBS) { const dx = P[j][0] - P.pelvis[0], dz = P[j][2] - P.pelvis[2]; B[j] = [dx * c - dz * s, P[j][1], dx * s + dz * c]; }
      out.push({ P, B, h, up: M.norm(M.sub(P.neck_01, P.pelvis)), ref: hit ? Math.sqrt(hit.cost) * 100 : 0 });
    }
    rig.setVector(held).evaluate();
    return out;
  }

  measure(frames, keys, fps = 30, { ref: withRef = true } = {}) {
    const S = this.sample(frames, withRef), n = S.length, F = this.floor;
    const series = Object.fromEntries(Object.keys(SERIES).map(k => [k, new Float32Array(n)]));
    // height of the lowest point of a foot above where it rests on the floor
    const lift = (s, side) => Math.min(s.P['foot_' + side][1] - F['foot_' + side], s.P['ball_' + side][1] - F['ball_' + side]);
    // (flat on the floor: within 1.5 cm at the ankle and at the ball. A foot swinging low over the floor is not planted)
    const planted = (s, side) => s.P['foot_' + side][1] - F['foot_' + side] < 1.5 && s.P['ball_' + side][1] - F['ball_' + side] < 1.5;
    let slide = 0, slideMax = 0, contact = 0, air = 0, airRun = 0, airLongest = 0, sink = 0;
    for (let k = 0; k < n; k++) {
      const s = S[k];
      const l = lift(s, 'l'), r = lift(s, 'r');
      sink = Math.min(sink, l, r);
      series.sink[k] = Math.max(0, -Math.min(l, r));
      if (l > 4 && r > 4) { air++; airRun++; airLongest = Math.max(airLongest, airRun); } else airRun = 0;
      series.air[k] = airRun;
      if (!k) continue;
      for (const side of 'lr') {
        if (!planted(s, side) || !planted(S[k - 1], side)) continue;
        const a = S[k - 1].P['foot_' + side], b = s.P['foot_' + side];
        const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
        slide += d; slideMax = Math.max(slideMax, d); contact++;
        series.slide[k] = Math.max(series.slide[k], d * fps);
      }
    }
    // between each pair of keys: against the straight way from one to the other
    let stray = 0, strayRel = 0, kink = 0, accel = 0, speed = 0;
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1], A = S[a], Bk = S[b];
      const pa = A.P.pelvis, pb = Bk.P.pelvis, travel = Math.hypot(pb[0] - pa[0], pb[2] - pa[2]);
      const dir = travel > 1 ? [(pb[0] - pa[0]) / travel, (pb[2] - pa[2]) / travel] : [0, 0];
      const turn = wrap(Bk.h - A.h);
      for (let k = a + 1; k < b; k++) {
        const u = (k - a) / (b - a), s = S[k];
        for (const j of MOVERS) {
          const span = M.dist(A.P[j], Bk.P[j]), d = M.dist(s.P[j], M.lerp(A.P[j], Bk.P[j], u));
          stray = Math.max(stray, d);
          strayRel = Math.max(strayRel, d / (span + 20));
        }
        const y = s.P.pelvis[1];
        series.hips[k] = Math.max(0, y - Math.max(pa[1], pb[1]), Math.min(pa[1], pb[1]) - y);
        series.tilt[k] = Math.acos(Math.max(-1, Math.min(1, M.dot(s.up, M.norm(M.lerp(A.up, Bk.up, u)))))) / M.DEG;
        series.spin[k] = Math.abs(wrap(s.h - (A.h + turn * u))) / M.DEG;
        // off the line from key to key: sideways, or beyond either end
        const dx = s.P.pelvis[0] - pa[0], dz = s.P.pelvis[2] - pa[2], along = dx * dir[0] + dz * dir[1];
        series.path[k] = Math.hypot(dx - along * dir[0], dz - along * dir[1]) + Math.max(0, -along, along - travel);
        // limbs that are in the same place (as the body sees them) in both keys, the body not going anywhere
        if (travel < 30) for (const j of LIMBS) {
          if (M.dist(A.B[j], Bk.B[j]) > 12) continue;
          series.gesture[k] = Math.max(series.gesture[k], M.dist(s.B[j], M.lerp(A.B[j], Bk.B[j], u)));
        }
      }
    }
    for (let k = 1; k + 1 < n; k++) for (const j of MOVERS) {
      const p0 = S[k - 1].P[j], p1 = S[k].P[j], p2 = S[k + 1].P[j];
      const acc = Math.hypot(p2[0] - 2 * p1[0] + p0[0], p2[1] - 2 * p1[1] + p0[1], p2[2] - 2 * p1[2] + p0[2]);
      accel = Math.max(accel, acc);
      series.accel[k] = Math.max(series.accel[k], acc);
      if (keys.includes(k)) kink = Math.max(kink, acc);
      speed = Math.max(speed, M.dist(p1, p0));
    }
    const pel = S.map(s => s.P.pelvis[1]);
    const keyPel = keys.map(k => pel[k]);
    const ref = S.map(s => s.ref);
    ref.forEach((x, k) => { series.ref[k] = x; });
    const max = k => Math.max(...series[k]);
    return {
      frames: n, series,
      slideSpeed: contact ? slide / contact * fps : 0, // cm/s while planted
      slideMax: slideMax * fps, // worst single frame, cm/s
      airborne: air / n, // share of frames with both feet off the floor
      airLongest, // frames
      sink: -sink, // deepest a foot goes under the floor, cm
      hipRise: Math.max(...pel) - Math.max(...keyPel), // hips above the highest key, cm
      hipDrop: Math.min(...keyPel) - Math.min(...pel), // hips below the lowest key, cm
      tilt: max('tilt'), spin: max('spin'), path: max('path'), gesture: max('gesture'), // degrees, degrees, cm, cm
      stray, strayRel, // cm, and relative to the distance travelled (+20 cm)
      refMean: ref.reduce((x, y) => x + y, 0) / n, refMax: Math.max(...ref), // distance to the nearest reference pose
      accel, kink, // cm per frame^2: worst anywhere, worst at a key
      speedMax: speed * fps / 100, // m/s
    };
  }
}

/** Points off for what the eye catches first (0 = clean).  The scale is rough: it is for comparing methods. */
export function penalty(m) {
  const parts = {
    slide: over(m.slideSpeed, 3, 25),
    air: over(m.airLongest, 2, 10),
    sink: over(m.sink, 1.5, 8),
    hips: over(Math.max(m.hipRise, m.hipDrop), 6, 30),
    tilt: over(m.tilt, 15, 50),
    spin: over(m.spin, 30, 90),
    path: over(m.path, 15, 50),
    gesture: over(m.gesture, 15, 45),
    ref: over(m.refMax, 28, 55),
    kink: over(m.kink, 3, 10),
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

/** 0..1 per frame for one series (0 = fine, 1 = bad). */
export const badness = (name, x) => over(x, SERIES[name][1], SERIES[name][2]);
