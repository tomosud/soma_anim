// The centre of gravity control (COG_ctl) put where the hips are, the pose kept.
//
// COG_ctl moves and turns the whole body about the hips (jumps, flips).  The fit of a pose (generated motion, a
// pose of the book) solves the body under the COG of the key, so a COG the animator moved stays behind while the
// hips go elsewhere.  As the Maya rig is built (asked of the rig's maker, 2026-11-14): only Hip_trans, Spine_trans
// and Head_trans hang on COG_ctl directly (the other controls are held by the bones or by the world), so moving
// COG and putting those three back where they were in the world leaves every bone where it was.  The COG's turn is
// never changed (the spine's base takes it: changing it would change the twist of the spine).
import * as M from './m4.js';

const KEPT = ['Hip_trans', 'Spine_trans', 'Head_trans'];

/** Where COG_ctl is from the hips (world, cm), in pose v. */
export function cogOffset(rig, v) {
  rig.setVector(v).evaluate();
  return M.sub(M.pos(rig.controlWorld('COG_ctl')), M.pos(rig.controlWorld('Hip_trans')));
}

/** Pose v with COG_ctl at the hips + offset (world, cm; default: right at the hips).  Leaves the rig evaluated. */
export function cogTo(rig, v, offset = [0, 0, 0]) {
  rig.setVector(v).evaluate();
  const want = M.add(M.pos(rig.controlWorld('Hip_trans')), offset);
  const held = KEPT.map(n => M.pos(rig.controlWorld(n)));
  const cog = rig.node('COG_ctl');
  if (M.dist(M.pos(cog.world), want) < 1e-4) return rig.getVector();
  place(rig, 'COG_ctl', want);
  rig.evaluate();
  KEPT.forEach((n, i) => place(rig, n, held[i]));
  rig.evaluate();
  return rig.getVector();
}

/** The translate of control `name` that puts it at world position p. */
function place(rig, name, p) {
  const n = rig.node(name);
  const t = M.sub(M.xpoint(p, M.inv(n.parent.world)), n.restT);
  for (const ch of n.control.channels) if (ch[0] === 't') rig.set(name + '.' + ch, t['xyz'.indexOf(ch[1])]);
}
