// A small sample: three keys baked with motion matching -> samples/sample_project.json, samples/sample_bake.json
// and, for the Maya check (tools/maya_check.py), the world positions of some joints at every frame.
import { readFileSync, writeFileSync } from 'node:fs';
import { BnsRig } from '../src/rig.js';
import { SomaRig, MotionDB } from '../src/motiondb.js';
import { SomaToManny } from '../src/retarget.js';
import { RigFitter } from '../src/fit.js';
import { Naturalizer } from '../src/natural.js';
import { Inbetweener } from '../src/inbetween.js';
import { Project } from '../src/project.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const rig = new BnsRig(JSON.parse(read('../assets/bns_rig.json')));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));
const re = new SomaToManny(rig, soma), fitter = new RigFitter(rig);
const nat = new Naturalizer(rig, db, re, fitter), inb = new Inbetweener(rig, db, re, fitter);
const feet = ['L_Foot_trans', 'R_Foot_trans', 'L_Foot_rot', 'R_Foot_rot'];

const p = new Project(rig);
p.length = 75;
const key = (frame, values, pins) => {
  const r = nat.naturalize(rig.vectorFromValues(values), new Set([...pins, ...feet]), 1);
  p.setKey(frame, r.vector, pins);
  console.log('key', frame, r.match.clip);
};
key(0, {}, []);
key(25, { 'R_Hand_trans.tx': 15, 'R_Hand_trans.ty': 60, 'R_Hand_trans.tz': 35 }, ['R_Hand_trans']);
key(50, { 'L_Foot_trans.tz': 45, 'Hip_trans.tz': 25, 'Hip_trans.ty': -8 }, ['L_Foot_trans', 'Hip_trans']);
p.setKey(75, p.keys[0].v, []);
p.bake(inb);
for (const s of p.segments) console.log('in-between', s.from, s.to, s.match?.clip, 'x' + s.match?.speed.toFixed(2));
writeFileSync('samples/sample_project.json', JSON.stringify(p.toJSON(), null, 1));
const bake = p.toBake();
const joints = ['pelvis', 'spine_05', 'head', 'hand_l', 'hand_r', 'lowerarm_l', 'foot_l', 'foot_r', 'calf_r', 'index_03_l', 'ball_r'];
bake.check = { joints, positions: bake.frames.map(v => { rig.setVector(v).evaluate(); return joints.map(j => rig.jointWorld(j).slice(12, 15).map(x => +x.toFixed(4))); }) };
writeFileSync('samples/sample_bake.json', JSON.stringify(bake));
console.log('frames', bake.frames.length);
