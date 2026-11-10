// The JS rig must give the same bind skeleton as the Maya rig for every exported case.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import * as M from '../src/m4.js';

const spec = JSON.parse(readFileSync(new URL('../rigspec/bns_rig_spec.json', import.meta.url)));
const cases = JSON.parse(readFileSync(new URL('../rigspec/bns_rig_cases.json', import.meta.url)));
const rig = new BnsRig(spec);

export function compare(c) {
  rig.setValues(c.controls);
  rig.evaluate();
  let posErr = 0, rotErr = 0, worstP = '', worstR = '';
  for (const [name, want] of Object.entries(c.bind_world_matrices)) {
    const got = rig.jointWorld(name);
    const p = M.dist(M.pos(got), M.pos(want));
    let r = 0;
    for (let i = 0; i < 11; i++) r = Math.max(r, Math.abs(got[i] - want[i]));
    if (p > posErr) { posErr = p; worstP = name; }
    if (r > rotErr) { rotErr = r; worstR = name; }
  }
  return { posErr, rotErr, worstP, worstR };
}

test('euler round trip', () => {
  for (const order of ['xyz', 'yzx', 'zxy', 'xzy', 'yxz', 'zyx']) {
    const v = [23, -41, 67];
    const back = M.toEuler(M.euler(v, order), order);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-9, order + ' ' + back);
  }
});

for (const c of cases.cases) {
  test('case: ' + c.name, () => {
    const e = compare(c);
    assert.ok(e.posErr < 0.01 && e.rotErr < 0.001,
      `pos ${e.posErr.toFixed(4)} cm (${e.worstP}), rot ${e.rotErr.toFixed(5)} (${e.worstR})`);
  });
}
test('passes', () => { console.log('passes per evaluation:', rig.passes); });
