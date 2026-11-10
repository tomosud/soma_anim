// Natural posing: the pose the animator set is looked up in the reference motion database, and the parts
// of the body the animator did not place take the pose of the nearest reference frame.
//
// This is the "matching" half of motion matching, used on a single pose: the handles the animator pinned
// (hands, feet, hips, head) are what the search must agree with; everything else comes from real motion.
import * as M from './m4.js';
import { DIM, F_FEET, F_HIPS_H, F_HANDS, F_HEAD } from './motiondb.js';
import { queryFromRig } from './retarget.js';
import { BODY_FIT_CONTROLS } from './fit.js';

/** Which feature dimensions a pinned control speaks for. */
const PIN_DIMS = {
  L_Foot_trans: [F_FEET, 3], R_Foot_trans: [F_FEET + 3, 3], L_Foot_rot: [F_FEET, 3], R_Foot_rot: [F_FEET + 3, 3],
  L_Hand_trans: [F_HANDS, 3], R_Hand_trans: [F_HANDS + 3, 3], L_Hand_rot: [F_HANDS, 3], R_Hand_rot: [F_HANDS + 3, 3],
  Hip_trans: [F_HIPS_H, 1], Head_trans: [F_HEAD, 3], Head_rot: [F_HEAD, 3],
};
const BASE = [[F_FEET, 6, 1], [F_HIPS_H, 1, 2], [F_HANDS, 6, 1], [F_HEAD, 3, 1.5]];

export function poseWeights(pins, pinned = 8) {
  const w = new Float32Array(DIM);
  for (const [o, n, v] of BASE) for (let i = 0; i < n; i++) w[o + i] = v;
  for (const p of pins) { const d = PIN_DIMS[p]; if (d) for (let i = 0; i < d[1]; i++) w[d[0] + i] = pinned; }
  return w;
}

export class Naturalizer {
  constructor(rig, db, re, fitter) {
    this.rig = rig; this.db = db; this.re = re; this.fitter = fitter;
    this.body = new Set(BODY_FIT_CONTROLS);
  }

  /**
   * v: pose vector, pins: Set of control names that must stay as they are, strength 0..1.
   * Returns {vector, match} - the corrected pose and the reference frame it came from.
   */
  naturalize(v, pins, strength = 1) {
    const { rig, db, re } = this;
    rig.setVector(v).evaluate();
    const { q, hip, heading } = queryFromRig(rig, re);
    const hit = db.nearest(q, poseWeights(pins))[0];
    if (!hit) return { vector: v.slice(), match: null };
    const pose = db.pose(hit.clip, hit.frame, hit.mirrored);
    const h = db.rig.heading(db.rig.positions(pose));
    const placed = db.rig.place({ root: [pose.root[0], pose.root[1], pose.root[2]], q: pose.q }, heading - h, hip[0], hip[2]);
    // hips: keep the animator's height when the hips are pinned
    if (pins.has('Hip_trans')) placed.root[1] = hip[1];
    this.fitter.fit(re.targets(placed));
    const nat = rig.getVector();
    const out = v.slice();
    for (let i = 0; i < out.length; i++) {
      const c = rig.channelControl[i];
      if (!this.body.has(c.name) || pins.has(c.name)) continue;
      const ch = rig.channelKeys[i];
      out[i] = ch[ch.length - 2] === 'r' ? v[i] + wrap(nat[i] - v[i]) * strength : v[i] + (nat[i] - v[i]) * strength;
    }
    rig.setVector(out).evaluate();
    return { vector: out, match: { clip: db.clips[hit.clip].name, frame: hit.frame, mirrored: hit.mirrored, cost: hit.cost } };
  }
}

export const wrap = a => a - 360 * Math.round(a / 360);
