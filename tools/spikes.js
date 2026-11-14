// Sudden turns of the limbs: a bone of an arm or a leg (or the hand, the foot) that turns more than `limit` degrees
// from one frame to the next - a flipped elbow or knee, a wrist that spins.  Run in the page (?debug):
//   (await import('/tools/spikes.js')).count()            -> the scene open in the page
//   (await import('/tools/spikes.js')).file('/eval_out/moto.json')   -> a saved project, made again
const BONES = ['upperarm_l', 'lowerarm_l', 'hand_l', 'upperarm_r', 'lowerarm_r', 'hand_r', 'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r'];
const wait = ms => new Promise(r => setTimeout(r, ms));

export async function count(limit = 45) {
  const { project: p, rig } = window.app, M = await import('/src/m4.js');
  const angle = (a, b) => { const q1 = M.toQuat(M.rotation(a)), q2 = M.toQuat(M.rotation(b)); return 2 * Math.acos(Math.min(1, Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]))) * 180 / Math.PI; };
  const held = rig.getVector(), out = [];
  let prev = null;
  for (let f = 0; f <= p.length; f++) {
    rig.setVector(p.baked[f]).evaluate();
    const W = BONES.map(j => rig.jointWorld(j).slice());
    if (prev) BONES.forEach((j, i) => { const a = angle(prev[i], W[i]); if (a > limit) out.push(`${f} ${j} ${Math.round(a)}`); });
    prev = W;
  }
  rig.setVector(held).evaluate();
  return out;
}

/** Open a saved project in the page, let MotionBricks make it, and count. */
export async function file(url, limit = 45) {
  const app = window.app, text = await fetch(url + '?x=' + Date.now()).then(r => r.text());
  const dt = new DataTransfer(); dt.items.add(new File([text], 'p.json', { type: 'application/json' }));
  const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
  await wait(300);
  for (let i = 0; i < 1200 && app.project.todo.length; i++) await wait(100);
  return count(limit);
}
