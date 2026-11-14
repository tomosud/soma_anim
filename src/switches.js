// Switching an option (follow, pvFollow, wristFollow, ankleFollow, autoShoulder) without the pose jumping:
// the controls whose place hangs on the options are put back where they were in the world.  The same thing
// the Maya tools do when the switch buttons of the picker are pressed (they key the corrected controls).
import * as M from './m4.js';

/** Controls whose world transform depends on the options. */
export const SWITCHED = ['L', 'R'].flatMap(S => [`${S}_Hand_trans`, `${S}_Foot_trans`, `${S}_elbow_pv`, `${S}_knee_pv`, `${S}_Shoulder_rot`, `${S}_Hand_rot`, `${S}_Foot_rot`]);

/**
 * v: pose vector; values: {"L_Foot_rot.pvFollow": 0, ...} (option values, not differences).
 * Returns the vector with those options and the same pose.
 */
export function withOptions(rig, v, values) {
  rig.setVector(v).evaluate();
  const keep = SWITCHED.map(n => [rig.controlByName.get(n), rig.controlWorld(n).slice()]).filter(e => e[0]);
  for (const [k, x] of Object.entries(values)) rig.set(k, x);
  // (some of them hang on others - the pole vector on the hand, the left hand on the right one: a few rounds)
  for (let round = 0; round < 3; round++) {
    rig.evaluate();
    for (const [c, w] of keep) {
      const n = c.node, pw = n.parent.world;
      if (c.hasT) {
        const t = M.sub(M.xpoint(M.pos(w), M.inv(pw)), n.restT);
        for (const ch of c.channels) if (ch[0] === 't') rig.set(c.name + '.' + ch, t['xyz'.indexOf(ch[1])]);
      }
      if (c.hasR) {
        const e = M.toEuler(M.mul(M.mul(M.rotation(w), M.transpose3(M.rotation(pw))), M.transpose3(n.restR)), n.order);
        for (const ch of c.channels) if (ch[0] === 'r') rig.set(c.name + '.' + ch, e['xyz'.indexOf(ch[1])]);
      }
    }
  }
  rig.evaluate();
  return rig.getVector();
}

/** The option values of a pose vector, as {"Control.option": value}. */
export function optionsOf(rig, v) {
  const out = {};
  rig.channelKeys.forEach((k, i) => { if (rig.channelBase[i] !== 0 || rig.channelControl[i].options.includes(k.split('.')[1])) out[k] = v[i] + rig.channelBase[i]; });
  return out;
}

/** True when two pose vectors have the same options that pick (the enumerations). */
export function sameSwitches(rig, a, b) {
  for (let i = 0; i < a.length; i++) if (rig.channelStep[i] && Math.round(a[i]) !== Math.round(b[i])) return false;
  return true;
}

/** B with the switches of A (the pose of B kept). */
export function switchesOf(rig, A, B) {
  const values = {};
  for (let i = 0; i < A.length; i++) if (rig.channelStep[i]) values[rig.channelKeys[i]] = Math.round(A[i]) + rig.channelBase[i];
  return withOptions(rig, B, values);
}
