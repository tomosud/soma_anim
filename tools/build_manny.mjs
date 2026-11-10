// Skinned Manny for the web: target-character.json (extracted from SKM_Manny_Simple.FBX with mayapy,
// Motion Bricks Studio scripts/extract_character_maya.py) -> assets/manny.json + assets/manny.bin
//   node tools/build_manny.mjs [path/to/target-character.json]
import { readFileSync, writeFileSync } from 'node:fs';

const src = process.argv[2];
if (!src) { console.error('usage: node tools/build_manny.mjs <target-character.json>'); process.exit(1); }
const data = JSON.parse(readFileSync(src, 'utf8'));
const mesh = data.meshes[0];
const nv = mesh.positions.length / 3;
const pos = Float32Array.from(mesh.positions);
const idx = Uint32Array.from(mesh.indices);
const skinI = new Uint8Array(nv * 8), skinW = new Uint16Array(nv * 8);
for (let v = 0; v < nv; v++) {
  const list = mesh.weights[v].slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sum = list.reduce((s, x) => s + x[1], 0);
  list.forEach(([j, w], k) => { skinI[v * 8 + k] = j; skinW[v * 8 + k] = Math.round(w / sum * 65535); });
}
const parts = [pos, idx, skinW, skinI];
let offset = 0;
const layout = {};
for (const [name, a] of [['positions', pos], ['indices', idx], ['skinWeights', skinW], ['skinIndices', skinI]]) {
  layout[name] = { offset, count: a.length };
  offset += a.byteLength;
}
const bin = Buffer.concat(parts.map(a => Buffer.from(a.buffer, a.byteOffset, a.byteLength)));
writeFileSync('assets/manny.bin', bin);
writeFileSync('assets/manny.json', JSON.stringify({
  about: 'UE5 Manny (SKM_Manny_Simple), bind pose, cm, Y up. 8 skin influences per vertex.',
  vertices: nv, influences: mesh.influences, inverseRest: mesh.inverseRest.map(m => m.map(x => +x.toFixed(6))), layout,
}));
console.log('vertices', nv, 'triangles', idx.length / 3, 'bytes', bin.length);
