// Numbers for how an animation moves: foot sliding, leaving the floor, going through it, straying from the
// way between the keys, distance from the reference motion, and kinks.  Used by tools/selftest.js.
//
// All lengths in cm, 30 fps.  `frames` are pose vectors (one per frame), `keys` the frame numbers of the keys.
import * as M from './m4.js';
import { queryFromRig } from './retarget.js';
import { poseWeights } from './natural.js';

const JOINTS = ['pelvis', 'head', 'hand_l', 'hand_r', 'foot_l', 'foot_r', 'ball_l', 'ball_r'];
const MOVERS = ['pelvis', 'head', 'hand_l', 'hand_r'];

export class Evaluator {
  constructor(rig, db, re) {
    this.rig = rig; this.db = db; this.re = re;
    const rest = n => rig.joints[rig.jointIndex.get(n)].rest[13];
    this.floor = { foot_l: rest('foot_l'), foot_r: rest('foot_r'), ball_l: rest('ball_l'), ball_r: rest('ball_r') };
    this.weights = poseWeights(new Set());
    this.skip = db.tagged(['fall', 'getup', 'hit']);
  }

  /** Positions of the joints that matter, and the distance to the nearest reference pose, per frame. */
  sample(frames) {
    const { rig } = this, held = rig.getVector(), out = [];
    for (const v of frames) {
      rig.setVector(v).evaluate();
      const P = {};
      for (const j of JOINTS) P[j] = M.pos(rig.jointWorld(j));
      const q = queryFromRig(rig, this.re);
      const hit = this.db.nearest(q.q, this.weights, 1, this.skip)[0];
      out.push({ P, ref: hit ? Math.sqrt(hit.cost) * 100 : 0 });
    }
    rig.setVector(held).evaluate();
    return out;
  }

  measure(frames, keys, fps = 30) {
    const S = this.sample(frames), n = S.length, F = this.floor;
    // height of the lowest point of a foot above where it rests on the floor
    const lift = (s, side) => Math.min(s.P['foot_' + side][1] - F['foot_' + side], s.P['ball_' + side][1] - F['ball_' + side]);
    // (flat on the floor: within 1.5 cm at the ankle and at the ball. A foot swinging low over the floor is not planted)
    const planted = (s, side) => s.P['foot_' + side][1] - F['foot_' + side] < 1.5 && s.P['ball_' + side][1] - F['ball_' + side] < 1.5;
    let slide = 0, slideMax = 0, contact = 0, air = 0, airRun = 0, airLongest = 0, sink = 0;
    for (let k = 0; k < n; k++) {
      const s = S[k];
      const l = lift(s, 'l'), r = lift(s, 'r');
      sink = Math.min(sink, l, r);
      if (l > 4 && r > 4) { air++; airRun++; airLongest = Math.max(airLongest, airRun); } else airRun = 0;
      if (!k) continue;
      for (const side of 'lr') {
        if (!planted(s, side) || !planted(S[k - 1], side)) continue;
        const a = S[k - 1].P['foot_' + side], b = s.P['foot_' + side];
        const d = Math.hypot(b[0] - a[0], b[2] - a[2]);
        slide += d; slideMax = Math.max(slideMax, d); contact++;
      }
    }
    // straying: how far the movers go from the straight way between the two keys around them
    let stray = 0, strayRel = 0, kink = 0, accel = 0, speed = 0;
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1];
      for (const j of MOVERS) {
        const pa = S[a].P[j], pb = S[b].P[j], span = M.dist(pa, pb);
        for (let k = a + 1; k < b; k++) {
          const d = M.dist(S[k].P[j], M.lerp(pa, pb, (k - a) / (b - a)));
          stray = Math.max(stray, d);
          strayRel = Math.max(strayRel, d / (span + 20));
        }
      }
    }
    for (let k = 1; k + 1 < n; k++) for (const j of MOVERS) {
      const p0 = S[k - 1].P[j], p1 = S[k].P[j], p2 = S[k + 1].P[j];
      const acc = Math.hypot(p2[0] - 2 * p1[0] + p0[0], p2[1] - 2 * p1[1] + p0[1], p2[2] - 2 * p1[2] + p0[2]);
      accel = Math.max(accel, acc);
      if (keys.includes(k)) kink = Math.max(kink, acc);
      speed = Math.max(speed, M.dist(p1, p0));
    }
    const pel = S.map(s => s.P.pelvis[1]);
    const keyPel = keys.map(k => pel[k]);
    const ref = S.map(s => s.ref);
    return {
      frames: n,
      slideSpeed: contact ? slide / contact * fps : 0, // cm/s while planted
      slideMax: slideMax * fps, // worst single frame, cm/s
      airborne: air / n, // share of frames with both feet off the floor
      airLongest, // frames
      sink: -sink, // deepest a foot goes under the floor, cm
      hipRise: Math.max(...pel) - Math.max(...keyPel), // hips above the highest key, cm
      hipDrop: Math.min(...keyPel) - Math.min(...pel), // hips below the lowest key, cm
      stray, strayRel, // cm, and relative to the distance travelled (+20 cm)
      refMean: ref.reduce((x, y) => x + y, 0) / n, refMax: Math.max(...ref), // distance to the nearest reference pose
      accel, kink, // cm per frame^2: worst anywhere, worst at a key
      speedMax: speed * fps / 100, // m/s
    };
  }
}

/** Points off for what the eye catches first (0 = clean).  The scale is rough: it is for comparing methods. */
export function penalty(m) {
  const over = (x, ok, bad) => Math.max(0, Math.min(1, (x - ok) / (bad - ok)));
  const parts = {
    slide: over(m.slideSpeed, 3, 25),
    air: over(m.airLongest, 2, 10),
    sink: over(m.sink, 1.5, 8),
    hips: over(Math.max(m.hipRise, m.hipDrop), 6, 30),
    stray: over(m.strayRel, 0.6, 2),
    ref: over(m.refMax, 28, 55),
    kink: over(m.kink, 3, 10),
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}
