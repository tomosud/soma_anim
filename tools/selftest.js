// Self test of the in-betweens, run in the page (it needs the MotionBricks session on WebGPU):
//   open http://127.0.0.1:<port>/?debug, wait for "MotionBricks: ..." in the corner, then in the console
//   (await import('/tools/selftest.js')).run()
// The scenes are made the way an animator makes them (a start pose, then one edit after another, each made
// natural as the app does), in-betweened with every method, measured with src/evaluate.js and drawn:
//   eval_out/selftest.txt / .json   the numbers
//   eval_out/strip_<scene>.png      stick figures every few frames, one row per method
//   eval_out/heat.png               what goes wrong at which frame
//   eval_out/selftest.done          written last
import { Project } from '../src/project.js';
import { Evaluator, penalty, SERIES, badness } from '../src/evaluate.js';
import { strip, heatmap, savePng } from './draw.js';

const FEET = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot'];

/**
 * Scenes: [frame, edit, pinned controls] per key.  The first key is the start pose of a new scene; each later
 * key is the key before it with `edit` added (control channels, cm / degrees) - what dragging a control does.
 */
export const SCENARIOS = {
  'hold': [[0, {}, []], [45, {}, []]],
  'hand up and back': [[0, {}, []], [30, { 'R_Hand_trans.tx': 15, 'R_Hand_trans.ty': 60, 'R_Hand_trans.tz': 35 }, ['R_Hand_trans']], [60, { 'R_Hand_trans.tx': -15, 'R_Hand_trans.ty': -60, 'R_Hand_trans.tz': -35 }, ['R_Hand_trans']]],
  'reach forward': [[0, {}, []], [25, { 'R_Hand_trans.tz': 55, 'R_Hand_trans.ty': 35, 'L_Hand_trans.tz': 55, 'L_Hand_trans.ty': 35 }, ['R_Hand_trans', 'L_Hand_trans']], [55, { 'R_Hand_trans.tz': -55, 'R_Hand_trans.ty': -35, 'L_Hand_trans.tz': -55, 'L_Hand_trans.ty': -35 }, ['R_Hand_trans', 'L_Hand_trans']]],
  'small change, long time': [[0, {}, []], [60, { 'R_Hand_trans.ty': 12 }, ['R_Hand_trans']]],
  'fast punch': [[0, {}, []], [8, { 'R_Hand_trans.tz': 60, 'R_Hand_trans.ty': 45, 'R_Hand_trans.tx': 10 }, ['R_Hand_trans']], [20, { 'R_Hand_trans.tz': -60, 'R_Hand_trans.ty': -45, 'R_Hand_trans.tx': -10 }, ['R_Hand_trans']]],
  'crouch and up': [[0, {}, []], [25, { 'Hip_trans.ty': -35 }, ['Hip_trans']], [50, { 'Hip_trans.ty': 35 }, ['Hip_trans']]],
  'look down, bow': [[0, {}, []], [30, { 'Spine_trans.tz': 30, 'Spine_trans.ty': -12, 'Head_trans.ty': -40 }, ['Spine_trans', 'Head_trans']], [60, { 'Spine_trans.tz': -30, 'Spine_trans.ty': 12, 'Head_trans.ty': 40 }, ['Spine_trans', 'Head_trans']]],
  'leg raise': [[0, {}, []], [24, { 'R_Foot_trans.ty': 45, 'R_Foot_trans.tz': 40 }, ['R_Foot_trans']], [48, { 'R_Foot_trans.ty': -45, 'R_Foot_trans.tz': -40 }, ['R_Foot_trans']]],
  'step forward': [[0, {}, []], [24, { 'Hip_trans.tz': 35, 'L_Foot_trans.tz': 70 }, ['Hip_trans', 'L_Foot_trans']], [48, { 'Hip_trans.tz': 35, 'R_Foot_trans.tz': 70 }, ['Hip_trans', 'R_Foot_trans']]],
  'side step': [[0, {}, []], [30, { 'world_ctl.tx': 50 }, []]],
  'turn 90': [[0, {}, []], [30, { 'world_ctl.ry': 90 }, []]],
  'turn 180': [[0, {}, []], [40, { 'world_ctl.ry': 180 }, []]],
  'walk 1 m': [[0, {}, []], [45, { 'world_ctl.tz': 100 }, []]],
  'walk 2.5 m': [[0, {}, []], [90, { 'world_ctl.tz': 250 }, []]],
  'walk back 1.5 m': [[0, {}, []], [75, { 'world_ctl.tz': -150 }, []]],
  'walk and turn': [[0, {}, []], [45, { 'world_ctl.tz': 120 }, []], [90, { 'world_ctl.tz': 60, 'world_ctl.tx': 80, 'world_ctl.ry': 90 }, []]],
  'walk, then wave': [[0, {}, []], [60, { 'world_ctl.tz': 150 }, []], [90, { 'R_Hand_trans.ty': 70, 'R_Hand_trans.tx': -20 }, ['R_Hand_trans']]],
  'arms swap': [[0, { 'R_Hand_trans.ty': 60, 'R_Hand_trans.tz': 20 }, ['R_Hand_trans']], [30, { 'R_Hand_trans.ty': -60, 'R_Hand_trans.tz': -20, 'L_Hand_trans.ty': 60, 'L_Hand_trans.tz': 20 }, ['R_Hand_trans', 'L_Hand_trans']]],
};

/** Harder scenes: far, fast, sideways, turned around - where the model used to dive, roll or run on the spot. */
export const STRESS = {
  'far and fast (2.5 m in 40 f)': [[0, {}, []], [40, { 'world_ctl.tz': 250 }, []]],
  'run 5 m in 75 f': [[0, {}, []], [75, { 'world_ctl.tz': 500 }, []]],
  'long walk 6 m': [[0, {}, []], [200, { 'world_ctl.tz': 600 }, []]],
  'slow walk 1.5 m in 120 f': [[0, {}, []], [120, { 'world_ctl.tz': 150 }, []]],
  'sideways 2 m': [[0, {}, []], [80, { 'world_ctl.tx': 200 }, []]],
  'turn around and go 2 m': [[0, {}, []], [90, { 'world_ctl.tz': -200, 'world_ctl.ry': 180 }, []]],
  'diagonal with a turn': [[0, {}, []], [90, { 'world_ctl.tx': 150, 'world_ctl.tz': 150, 'world_ctl.ry': 45 }, []]],
  'crouched walk 2 m': [[0, { 'Hip_trans.ty': -35 }, ['Hip_trans']], [75, { 'world_ctl.tz': 200 }, []]],
  'walk into a crouch': [[0, {}, []], [70, { 'world_ctl.tz': 200 }, []], [95, { 'Hip_trans.ty': -40 }, ['Hip_trans']]],
  'walk, hand raised all the way': [[0, { 'R_Hand_trans.ty': 70, 'R_Hand_trans.tz': 20 }, ['R_Hand_trans']], [80, { 'world_ctl.tz': 220 }, []]],
  'keys every 10 frames': [[0, {}, []], [10, { 'R_Hand_trans.ty': 40 }, ['R_Hand_trans']], [20, { 'L_Hand_trans.ty': 40 }, ['L_Hand_trans']], [30, { 'Hip_trans.ty': -15 }, ['Hip_trans']], [40, { 'R_Hand_trans.ty': -40, 'L_Hand_trans.ty': -40 }, ['R_Hand_trans', 'L_Hand_trans']]],
  'crouch, long hold, up': [[0, {}, []], [20, { 'Hip_trans.ty': -45 }, ['Hip_trans']], [80, {}, []], [100, { 'Hip_trans.ty': 45 }, ['Hip_trans']]],
  'touch the floor and up': [[0, {}, []], [30, { 'R_Hand_trans.ty': -70, 'R_Hand_trans.tz': 35 }, ['R_Hand_trans']], [60, 'start', []]],
  'big step to the side and back': [[0, {}, []], [25, { 'R_Foot_trans.tx': -60 }, ['R_Foot_trans']], [50, { 'R_Foot_trans.tx': 60 }, ['R_Foot_trans']]],
  'short hop of the whole body (40 cm in 14 f)': [[0, {}, []], [14, { 'world_ctl.tz': 40 }, []]],
};

export const METHODS = { ease: { mode: 'ease' }, mb: { mode: 'mb', flow: false }, 'mb flow': { mode: 'mb', flow: true } };

const COLS = [['slideSpeed', 'slide', 1], ['airLongest', 'air f', 0], ['sink', 'sink', 1], ['hipRise', 'hip+', 0], ['hipDrop', 'hip-', 0],
  ['tilt', 'tilt', 0], ['spin', 'spin', 0], ['path', 'path', 0], ['gesture', 'gest', 0], ['refMax', 'refMax', 0], ['accel', 'acc', 1], ['kink', 'kink', 1]];

const file = s => s.replace(/[^\w]+/g, '_');
const post = (name, body) => fetch('/save/' + name, { method: 'POST', body }).catch(() => {});

/** The keys of a scene, made as the app makes them. */
export function makeKeys(app, scene) {
  const { rig, nat } = app;
  let v = app.startPose();
  return scene.map(([frame, edit, pins]) => {
    // ('start': the start pose pasted - what copying the first key gives)
    if (edit === 'start') { const w = app.startPose(); rig.channelKeys.forEach((k, i) => { if (!k.startsWith('world_ctl.')) v[i] = w[i]; }); v = v.slice(); return { frame, pins, v }; }
    const before = v.slice();
    v = v.slice();
    for (const [k, x] of Object.entries(edit)) v[rig.channelIndex.get(k)] += x;
    const touched = [...new Set(Object.keys(edit).map(k => k.split('.')[0]))];
    if (touched.some(t => t !== 'world_ctl')) v = nat.naturalize(v, new Set(pins), 0.8, { before, touched, held: new Set([...touched, ...FEET]) }).vector;
    return { frame, pins, v };
  });
}

export async function run({ set = SCENARIOS, scenarios = Object.keys(set), methods = Object.keys(METHODS), save = true, tag = '' } = {}) {
  const app = window.app, { rig, nat, inb, mb } = app;
  if (!nat || !inb) throw Error('the motion database is not loaded yet');
  if (save) await post('selftest.done', 'running');
  const ev = new Evaluator(rig, inb.db, inb.re);
  const held = rig.getVector();
  const results = [], blocks = [];
  for (const name of scenarios) {
    const keys = makeKeys(app, set[name]);
    const rows = [];
    for (const method of methods) {
      const cfg = METHODS[method];
      if (cfg.mode === 'mb' && !(mb && mb.state === 'ready')) continue;
      const p = new Project(rig);
      p.length = keys[keys.length - 1].frame;
      p.mode = cfg.mode; p.flow = !!cfg.flow;
      for (const k of keys) p.setKey(k.frame, k.v, k.pins);
      const t0 = performance.now();
      p.bake(inb, mb);
      if (p.todo.length) await p.fill(inb, mb, () => {});
      const ms = performance.now() - t0;
      const kf = keys.map(k => k.frame);
      const m = ev.measure(p.baked, kf);
      const pen = penalty(m);
      const bad = new Float32Array(m.frames);
      for (const s of Object.keys(SERIES)) if (s !== 'ref') m.series[s].forEach((x, f) => { bad[f] = Math.max(bad[f], badness(s, x)); });
      const { series, ...numbers } = m;
      results.push({ scenario: name, method, ms, metrics: numbers, penalty: pen, segments: p.segments.map(s => s.match) });
      rows.push({ label: `${method}   penalty ${pen.total.toFixed(2)}`, frames: p.baked, keys: kf, bad });
      if (cfg.mode === 'mb') rows.push({ label: `${method}   the same, seen from the side (the character faces RIGHT in this row)`, frames: p.baked, keys: kf, bad, side: true });
      blocks.push({ label: `${name} / ${method}   (${pen.total.toFixed(2)})`, metrics: m, keys: kf });
    }
    if (save && rows.length) await savePng(strip(rig, ev.floor, rows, { title: name, shot: app.shot }), `strip_${file(name)}${tag}.png`);
  }
  rig.setVector(held).evaluate();
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(pad('scenario', 25) + pad('method', 9) + COLS.map(c => pad(c[1], 7)).join('') + 'penalty  what');
  for (const r of results) {
    const what = Object.entries(r.penalty.parts).filter(e => e[1] > 0.15).map(e => `${e[0]} ${e[1].toFixed(1)}`).join(', ');
    lines.push(pad(r.scenario, 25) + pad(r.method, 9) + COLS.map(c => pad(r.metrics[c[0]].toFixed(c[2]), 7)).join('') + pad(r.penalty.total.toFixed(2), 9) + what);
  }
  lines.push('');
  for (const method of methods) {
    const rs = results.filter(r => r.method === method);
    if (!rs.length) continue;
    const sum = k => rs.reduce((a, r) => a + r.penalty.parts[k], 0);
    lines.push(pad('TOTAL ' + method, 34) + 'penalty ' + rs.reduce((a, r) => a + r.penalty.total, 0).toFixed(2) + '   ' + Object.keys(rs[0].penalty.parts).map(k => `${k} ${sum(k).toFixed(1)}`).join('  '));
  }
  const text = lines.join('\n');
  if (save) {
    // (the heat map in pieces: one image per method keeps each readable)
    for (const method of methods) { const b = blocks.filter(x => x.label.includes(' / ' + method + ' ')); if (b.length) await savePng(heatmap(b), `heat_${file(method)}${tag}.png`); }
    await post(`selftest${tag}.json`, JSON.stringify({ when: new Date().toISOString(), results }));
    await post(`selftest${tag}.txt`, text);
    await post('selftest.done', 'done ' + new Date().toISOString());
  }
  return text;
}
