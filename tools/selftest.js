// Self test of the in-betweens, run in the page (it needs the MotionBricks session on WebGPU):
//   open http://127.0.0.1:<port>/?debug, wait for "MotionBricks: ..." in the corner, then in the console
//   (await import('/tools/selftest.js')).run()
// The same key poses are in-betweened with every method and measured with src/evaluate.js.
// Writes eval_out/selftest.json through the local server and returns the table as text.
import { Project } from '../src/project.js';
import { Evaluator, penalty } from '../src/evaluate.js';

const FEET = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot', 'L_Toe_rot', 'R_Toe_rot'];

/** Scenarios: [frame, control values, pinned controls] per key.  Poses are made natural as the app does. */
export const SCENARIOS = {
  'hand up and back': [[0, {}, []], [30, { 'R_Hand_trans.tx': 15, 'R_Hand_trans.ty': 60, 'R_Hand_trans.tz': 35 }, ['R_Hand_trans']], [60, {}, []]],
  'reach forward': [[0, {}, []], [25, { 'R_Hand_trans.tz': 55, 'R_Hand_trans.ty': 35, 'L_Hand_trans.tz': 55, 'L_Hand_trans.ty': 35 }, ['R_Hand_trans', 'L_Hand_trans']], [55, {}, []]],
  'small change, long time': [[0, {}, []], [60, { 'R_Hand_trans.ty': 12 }, ['R_Hand_trans']]],
  'fast punch': [[0, {}, []], [8, { 'R_Hand_trans.tz': 60, 'R_Hand_trans.ty': 45, 'R_Hand_trans.tx': 10 }, ['R_Hand_trans']], [20, {}, []]],
  'crouch and up': [[0, {}, []], [25, { 'Hip_trans.ty': -35 }, ['Hip_trans']], [50, {}, []]],
  'step forward': [[0, {}, []], [24, { 'Hip_trans.tz': 35, 'L_Foot_trans.tz': 70 }, ['Hip_trans', 'L_Foot_trans']], [48, { 'world_ctl.tz': 70 }, []]],
  'side step': [[0, {}, []], [30, { 'world_ctl.tx': 50 }, []]],
  'turn 90': [[0, {}, []], [30, { 'world_ctl.ry': 90 }, []]],
  'walk 2.5 m': [[0, {}, []], [90, { 'world_ctl.tz': 250 }, []]],
  'walk and turn': [[0, {}, []], [45, { 'world_ctl.tz': 120 }, []], [90, { 'world_ctl.tz': 180, 'world_ctl.tx': 80, 'world_ctl.ry': 90 }, []]],
  'arms swap': [[0, { 'R_Hand_trans.ty': 60, 'R_Hand_trans.tz': 20 }, ['R_Hand_trans']], [30, { 'L_Hand_trans.ty': 60, 'L_Hand_trans.tz': 20 }, ['L_Hand_trans']]],
};

export const METHODS = { ease: { mode: 'ease' }, mb: { mode: 'mb', flow: false }, 'mb flow': { mode: 'mb', flow: true } };

const COLS = [['slideSpeed', 'slide cm/s', 1], ['slideMax', 'worst', 0], ['airLongest', 'air f', 0], ['sink', 'sink', 1], ['hipRise', 'hip+', 0], ['hipDrop', 'hip-', 0],
  ['stray', 'stray', 0], ['strayRel', 'rel', 2], ['refMean', 'ref', 0], ['refMax', 'refMax', 0], ['accel', 'acc', 1], ['kink', 'kink', 1]];

export async function run({ scenarios = Object.keys(SCENARIOS), methods = Object.keys(METHODS), save = true } = {}) {
  const app = window.app, { rig, nat, inb, mb } = app;
  if (!nat || !inb) throw Error('the motion database is not loaded yet');
  const ev = new Evaluator(rig, inb.db, inb.re);
  const held = rig.getVector();
  const results = [];
  for (const name of scenarios) {
    // the keys, once, shared by every method
    const keys = SCENARIOS[name].map(([frame, values, pins]) => {
      const v = rig.vectorFromValues(values);
      return { frame, pins, v: nat.naturalize(v, new Set([...pins, ...FEET, 'world_ctl']), 0.7).vector };
    });
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
      const m = ev.measure(p.baked, keys.map(k => k.frame));
      const pen = penalty(m);
      results.push({ scenario: name, method, ms, metrics: m, penalty: pen, segments: p.segments.map(s => s.match) });
    }
  }
  rig.setVector(held).evaluate();
  // table
  const lines = [];
  const pad = (s, n) => String(s).padEnd(n);
  lines.push(pad('scenario', 24) + pad('method', 9) + COLS.map(c => pad(c[1], 10)).join('') + 'penalty  what');
  for (const r of results) {
    const what = Object.entries(r.penalty.parts).filter(e => e[1] > 0.15).map(e => `${e[0]} ${e[1].toFixed(1)}`).join(', ');
    lines.push(pad(r.scenario, 24) + pad(r.method, 9) + COLS.map(c => pad(r.metrics[c[0]].toFixed(c[2]), 10)).join('') + pad(r.penalty.total.toFixed(2), 9) + what);
  }
  lines.push('');
  for (const method of methods) {
    const rs = results.filter(r => r.method === method);
    if (!rs.length) continue;
    const sum = k => rs.reduce((a, r) => a + r.penalty.parts[k], 0);
    lines.push(pad('TOTAL ' + method, 33) + 'penalty ' + rs.reduce((a, r) => a + r.penalty.total, 0).toFixed(2) + '   ' + Object.keys(rs[0].penalty.parts).map(k => `${k} ${sum(k).toFixed(1)}`).join('  '));
  }
  const text = lines.join('\n');
  if (save) {
    await fetch('/save/selftest.json', { method: 'POST', body: JSON.stringify({ when: new Date().toISOString(), results }) }).catch(() => {});
    await fetch('/save/selftest.txt', { method: 'POST', body: text }).catch(() => {});
  }
  return text;
}
