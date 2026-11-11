// Experiments with the MotionBricks model itself (no rig, no clean-up): what it makes of a context and targets.
//   (await import('/tools/mblab.js')).run('name', [{label, context, targets, tokens}, ...])
// Poses are SOMA poses; helpers below take them from the reference database.
import { strip, somaPoints, somaFloor, savePng } from './draw.js';
import { qyaw, qmul } from '../src/motiondb.js';

export function tools(app) {
  const { inb, mb } = app, db = inb.db, soma = db.rig;
  const clip = name => { const i = db.clips.findIndex(c => c.name.startsWith(name)); if (i < 0) throw Error('no clip ' + name); return i; };
  /** Frame f of a clip, turned by yaw about the hips and put at (x, z) on the ground. */
  const pose = (name, f, x = 0, z = 0, yaw = 0) => {
    const p = db.pose(clip(name), f);
    const h = soma.heading(soma.positions(p));
    return soma.place(p, yaw - h, x, z);
  };
  /** n consecutive frames of a clip starting at f, the first at (x, z) facing yaw, the others where the clip goes. */
  const window = (name, f, n, x = 0, z = 0, yaw = 0) => {
    const c = clip(name), p0 = db.pose(c, f), h = soma.heading(soma.positions(p0)), a = yaw - h, cs = Math.cos(a), sn = Math.sin(a), out = [];
    for (let i = 0; i < n; i++) {
      const p = db.pose(c, f + i), dx = p.root[0] - p0.root[0], dz = p.root[2] - p0.root[2];
      out.push(soma.place(p, a, x + dx * cs + dz * sn, z - dx * sn + dz * cs));
    }
    return out;
  };
  const mix = (a, b, t) => {
    const q = new Float32Array(a.q.length);
    for (let i = 0; i < q.length; i += 4) {
      const d = a.q[i] * b.q[i] + a.q[i + 1] * b.q[i + 1] + a.q[i + 2] * b.q[i + 2] + a.q[i + 3] * b.q[i + 3], s = d < 0 ? -t : t;
      const v = [0, 1, 2, 3].map(k => a.q[i + k] * (1 - t) + b.q[i + k] * s), l = Math.hypot(...v);
      v.forEach((x, k) => { q[i + k] = x / l; });
    }
    return { root: a.root.map((x, k) => x + (b.root[k] - x) * t), q };
  };
  /** Like window(), the clip played at `rate` (0.5 = half speed: half the stride per frame). */
  const walk = (name, f, n, x, z, yaw, rate = 1) => {
    const c = clip(name), at = g => { const i = Math.floor(g); return mix(db.pose(c, i), db.pose(c, i + 1), g - i); };
    const p0 = at(f), h = soma.heading(soma.positions(p0)), a = yaw - h, cs = Math.cos(a), sn = Math.sin(a), out = [];
    for (let i = 0; i < n; i++) {
      const p = at(f + i * rate), dx = p.root[0] - p0.root[0], dz = p.root[2] - p0.root[2];
      out.push(soma.place(p, a, x + dx * cs + dz * sn, z - dx * sn + dz * cs));
    }
    return out;
  };
  const fromRig = v => { const held = app.rig.getVector(); app.rig.setVector(v).evaluate(); const p = inb.re.fromRig(app.rig); app.rig.setVector(held).evaluate(); return p; };
  return { db, soma, mb, clip, pose, window, walk, mix, fromRig };
}

/** Several generations one after another, each played for `play` frames (or to its end): one row. */
export async function chain(name, label, context, plans, rows = []) {
  const app = window.app, { soma, mb } = tools(app);
  let ctx = context, frames = [], marks = [0], ms = 0;
  for (const p of plans) {
    const r = await mb.raw(ctx, typeof p.targets === 'function' ? p.targets(frames) : p.targets, p.tokens);
    const part = r.frames.slice(0, p.play ? p.play + 1 : r.frames.length);
    frames = frames.concat(frames.length ? part.slice(1) : part);
    ctx = frames.slice(-4); marks.push(frames.length - 1); ms += r.ms;
  }
  const pts = frames.map(p => somaPoints(soma, p));
  rows.push({ label: `${label}: ${frames.length} frames, ${ms.toFixed(0)} ms, plans end at ${marks.join(' ')}`, points: pts, keys: marks });
  await savePng(strip(app.rig, somaFloor(soma), rows, { title: name, per: 30 }), `mblab_${name}.png`);
  return rows;
}

export async function run(name, cases, { per = 20 } = {}) {
  const app = window.app, { soma, mb } = tools(app);
  const rows = [], info = [];
  for (const c of cases) {
    const r = await mb.raw(c.context, c.targets, c.tokens);
    const pts = r.frames.map(p => somaPoints(soma, p));
    const end = pts[pts.length - 1].pelvis, y = pts.map(p => p.pelvis[1]);
    info.push(`${c.label}: tokens ${r.tokens}, frames ${r.frames.length}, ${r.ms.toFixed(0)} ms, end ${end[0].toFixed(0)},${end[2].toFixed(0)}, hips ${Math.min(...y).toFixed(0)}..${Math.max(...y).toFixed(0)}`);
    rows.push({ label: info[info.length - 1], points: pts, keys: [0, pts.length - 1] });
    if (c.keep) c.keep(r);
  }
  await savePng(strip(app.rig, somaFloor(soma), rows, { title: name, per }), `mblab_${name}.png`);
  await fetch('/save/mblab_' + name + '.txt', { method: 'POST', body: info.join('\n') });
  return info.join('\n');
}
