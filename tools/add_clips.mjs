// More clips for the pose book (jumps, flips ...): Mixamo animations already on the SOMA skeleton (the JSON that
// soma-fighter-web tools/mixamo_clips.mjs writes: {joints, clips: {name: {fps, frames: [{root, rot}]}}}) are put
// at the end of the reference motion (assets/motiondb.*).  Only their poses are added - no search entries, so
// what natural posing and motion matching find does not change.  A clip that is there already is left alone.
//
//   node tools/add_clips.mjs <clips.json> <tag> [name ...]      (no names: every clip of the file)
import { readFileSync, writeFileSync } from 'node:fs';
import { SomaRig } from '../src/motiondb.js';

const [file, tag, ...only] = process.argv.slice(2);
if (!file || !tag) { console.log('node tools/add_clips.mjs <clips.json> <tag> [name ...]'); process.exit(1); }
const read = p => readFileSync(new URL(p, import.meta.url));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const meta = JSON.parse(read('../assets/motiondb.json'));
const old = read('../assets/motiondb.bin');
const src = JSON.parse(readFileSync(file));
if (JSON.stringify(src.joints) !== JSON.stringify(meta.joints)) throw Error('the joints of the clips are not those of the database');

const n = soma.n, frameBytes = 12 + n * 8;
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const ANK = soma.restPos[soma.index.LeftFoot][1], TOE = soma.restPos[soma.index.LeftToeBase][1];

const added = [];
for (const [name, clip] of Object.entries(src.clips)) {
  if (only.length && !only.includes(name)) continue;
  if (meta.clips.some(c => c.name === name)) { console.log('there already:', name); continue; }
  // 30 fps (a clip kept at 15 has every frame doubled up by halfway poses is not needed for single poses: repeated)
  let poses = clip.frames.map(f => ({ root: f.root.slice(), q: Float32Array.from(f.rot.flat()) }));
  if (clip.fps !== 30) poses = poses.flatMap(p => Array(Math.round(30 / clip.fps)).fill(p));
  // the first frame faces +Z with the hips over the origin, as every clip of the database
  const h = soma.heading(soma.positions(poses[0])), x0 = poses[0].root[0], z0 = poses[0].root[2];
  const c = Math.cos(-h), s = Math.sin(-h), yq = [0, Math.sin(-h / 2), 0, Math.cos(-h / 2)];
  poses = poses.map(p => {
    const dx = p.root[0] - x0, dz = p.root[2] - z0, q = new Float32Array(n * 4);
    for (let j = 0; j < n; j++) q.set(qmul(yq, Array.from(p.q.subarray(j * 4, j * 4 + 4))), j * 4);
    return { root: [dx * c + dz * s, p.root[1], -dx * s + dz * c], q };
  });
  // its floor at 0: where the feet are lowest most of the time (as the database was built)
  const lows = poses.map(p => { const P = soma.positions(p); return Math.min(P[soma.index.LeftFoot][1] - ANK, P[soma.index.RightFoot][1] - ANK, P[soma.index.LeftToeBase][1] - TOE, P[soma.index.RightToeBase][1] - TOE); }).sort((a, b) => a - b);
  const floor = lows[Math.floor(lows.length * 0.1)] ?? 0;
  for (const p of poses) p.root[1] -= floor;
  added.push({ name, tag, poses });
  console.log(`${name.padEnd(24)} ${poses.length} frames  floor ${(floor * 100).toFixed(1)} cm`);
}
if (!added.length) process.exit(0);

// the poses go after the poses there are; everything after them in the file moves along
const end = meta.poses.offset + meta.poses.bytes, total = added.reduce((a, c) => a + c.poses.length, 0) * frameBytes;
const bytes = new Uint8Array(total), dv = new DataView(bytes.buffer);
let o = 0, start = meta.poses.bytes / frameBytes;
for (const c of added) {
  meta.clips.push({ name: c.name, start, frames: c.poses.length, own: c.poses.length, loop: false, tag: c.tag, strike: null });
  start += c.poses.length;
  for (const p of c.poses) {
    for (const v of p.root) { dv.setFloat32(o, v, true); o += 4; }
    for (let i = 0; i < n * 4; i += 4) {
      const l = Math.hypot(p.q[i], p.q[i + 1], p.q[i + 2], p.q[i + 3]) || 1;
      for (let k = 0; k < 4; k++) { dv.setInt16(o, Math.round(p.q[i + k] / l * 32767), true); o += 2; }
    }
  }
}
const out = Buffer.concat([old.subarray(0, end), Buffer.from(bytes), old.subarray(end)]);
meta.poses.bytes += total;
for (const k of ['clipOffset', 'frameOffset', 'mirrorOffset']) if (meta.entries[k] >= end) meta.entries[k] += total;
if (meta.features.offset >= end) meta.features.offset += total;
writeFileSync(new URL('../assets/motiondb.bin', import.meta.url), out);
writeFileSync(new URL('../assets/motiondb.json', import.meta.url), JSON.stringify(meta));
console.log(`${added.length} clips, ${total} bytes added`);
