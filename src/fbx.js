// Animation FBX: the 89 Manny bones (no mesh) with every frame baked, ASCII FBX 7.4, cm, Y up.
// Opens in Maya and imports into Unreal on the Manny skeleton.
// The layout of the file follows Motion Bricks Studio app/fbx.py (checked there against Maya).
import * as M from './m4.js';

const TICKS = 46186158000;
const TIME_MODES = { 24: 11, 25: 10, 30: 6, 48: 5, 50: 4, 60: 3, 100: 2, 120: 1 };
const num = x => { const s = (+x).toPrecision(12); return String(+s); };
const vec = v => Array.from(v, num).join(',');

/** Local translate + rotate (Euler xyz, degrees) of every bind joint for the pose the rig is in. */
export function sampleJoints(rig) {
  return rig.joints.map(j => {
    const n = j.drv;
    // the root has no parent in the file: its world transform (it carries the Z-up skeleton into the Y-up scene)
    if (!rig.jointIndex.has(j.parent)) return [...M.pos(n.world), ...M.toEuler(M.rotation(n.world), 'xyz')];
    const r = j.orient ? M.mul(n.r, M.transpose3(j.orient)) : n.r;
    return [n.t[0], n.t[1], n.t[2], ...M.toEuler(r, 'xyz')];
  });
}

/** frames: pose vectors, one per frame.  Returns the text of the FBX file. */
export function writeFbx(rig, frames, fps = 30, name = 'SomaAnim') {
  const held = rig.getVector();
  const samples = frames.map(v => { rig.setVector(v).evaluate(); return sampleJoints(rig); });
  rig.setVector(held).evaluate();
  const joints = rig.joints, count = samples.length, end = Math.round((count - 1) / fps * TICKS);
  const times = Array.from({ length: count }, (_, i) => Math.round(i / fps * TICKS)).join(',');
  const prop = (n, kind, value, flags = '') => {
    const sub = { int: 'Integer', double: 'Number', KTime: 'Time', Vector3D: 'Vector' }[kind] || '';
    return `P: "${n}", "${kind}", "${sub}", "${flags}",${value}`;
  };
  const id = i => 1000 + i;
  const objects = [], connections = ['C: "OO", 2, 1'];
  let curve = 10000;
  objects.push(`AnimationStack: 1, "AnimStack::${name}", "" {\nProperties70: {\n${prop('LocalStart', 'KTime', 0)}\n${prop('LocalStop', 'KTime', end)}\n${prop('ReferenceStart', 'KTime', 0)}\n${prop('ReferenceStop', 'KTime', end)}\n}\n}`);
  objects.push('AnimationLayer: 2, "AnimLayer::BaseLayer", "" {\nVersion: 100\n}');
  joints.forEach((j, i) => {
    const first = samples[0][i], mid = id(i);
    const props = [prop('Lcl Translation', 'Lcl Translation', vec(first.slice(0, 3)), 'A'), prop('Lcl Rotation', 'Lcl Rotation', vec(first.slice(3)), 'A'),
      prop('Lcl Scaling', 'Lcl Scaling', '1,1,1', 'A'), prop('PreRotation', 'Vector3D', vec(j.orientEuler || [0, 0, 0])), prop('RotationOrder', 'enum', 0),
      prop('RotationActive', 'bool', 1), prop('InheritType', 'enum', 1), prop('DefaultAttributeIndex', 'int', 0)];
    objects.push(`Model: ${mid}, "Model::${j.name}", "LimbNode" {\nVersion: 232\nProperties70: {\n${props.join('\n')}\n}\nShading: T\nCulling: "CullingOff"\n}`);
    const attr = mid + 1000;
    objects.push(`NodeAttribute: ${attr}, "NodeAttribute::${j.name}", "LimbNode" {\nTypeFlags: "Skeleton"\nProperties70: {\nP: "Size", "double", "Number", "",1\n}\n}`);
    const parent = rig.jointIndex.has(j.parent) ? id(rig.jointIndex.get(j.parent)) : 0;
    connections.push(`C: "OO", ${mid}, ${parent}`, `C: "OO", ${attr}, ${mid}`);
    for (const [group, start] of [['T', 0], ['R', 3]]) {
      const node = curve++;
      objects.push(`AnimationCurveNode: ${node}, "AnimCurveNode::${group}", "" {\nProperties70: {\n${[0, 1, 2].map(a => prop('d|' + 'XYZ'[a], 'Number', num(first[start + a]), 'A')).join('\n')}\n}\n}`);
      connections.push(`C: "OO", ${node}, 2`, `C: "OP", ${node}, ${mid}, "Lcl ${group === 'T' ? 'Translation' : 'Rotation'}"`);
      for (let a = 0; a < 3; a++) {
        const cid = curve++, values = samples.map(s => s[i][start + a]);
        if (group === 'R') for (let k = 1; k < count; k++) values[k] += 360 * Math.round((values[k - 1] - values[k]) / 360);
        objects.push(`AnimationCurve: ${cid}, "AnimCurve::", "" {\nDefault: ${num(values[0])}\nKeyVer: 4008\nKeyTime: *${count} { a: ${times} }\nKeyValueFloat: *${count} { a: ${vec(values)} }\nKeyAttrFlags: *1 { a: 24836 }\nKeyAttrDataFloat: *4 { a: 0,0,0,0 }\nKeyAttrRefCount: *1 { a: ${count} }\n}`);
        connections.push(`C: "OP", ${cid}, ${node}, "d|${'XYZ'[a]}"`);
      }
    }
  });
  const nj = joints.length;
  let text = '; FBX 7.4.0 project file\n;\n; ----------------------------------------------------\n\nFBXHeaderExtension: {\nFBXHeaderVersion: 1003\nFBXVersion: 7400\nCreator: "SOMA Anim"\n}\n';
  text += 'GlobalSettings: {\nVersion: 1000\nProperties70: {\n';
  for (const [n, v] of [['UpAxis', 1], ['UpAxisSign', 1], ['FrontAxis', 2], ['FrontAxisSign', 1], ['CoordAxis', 0], ['CoordAxisSign', 1], ['OriginalUpAxis', 1], ['OriginalUpAxisSign', 1]]) text += prop(n, 'int', v) + '\n';
  text += prop('TimeMode', 'enum', TIME_MODES[fps] ?? 14) + '\n' + prop('UnitScaleFactor', 'double', 1) + '\n' + prop('OriginalUnitScaleFactor', 'double', 1) + '\n' + prop('CustomFrameRate', 'double', fps) + '\n' + prop('TimeSpanStart', 'KTime', 0) + '\n' + prop('TimeSpanStop', 'KTime', end) + '\n}\n}\n';
  text += `Documents: {\nCount: 1\nDocument: 3, "", "Scene" {\nProperties70: {\nP: "ActiveAnimStackName", "KString", "", "", "${name}"\n}\nRootNode: 0\n}\n}\n`;
  text += `Definitions: {\nVersion: 100\nCount: ${objects.length + 1}\n`;
  const templates = { Model: 'FbxNode', NodeAttribute: 'FbxSkeleton', AnimationStack: 'FbxAnimStack', AnimationLayer: 'FbxAnimLayer', AnimationCurveNode: 'FbxAnimCurveNode' };
  for (const [typ, c] of [['GlobalSettings', 1], ['Model', nj], ['NodeAttribute', nj], ['AnimationStack', 1], ['AnimationLayer', 1], ['AnimationCurveNode', nj * 2], ['AnimationCurve', nj * 6]]) {
    text += `ObjectType: "${typ}" {\nCount: ${c}\n`;
    if (templates[typ]) text += `PropertyTemplate: "${templates[typ]}" {\nProperties70: {\n}\n}\n`;
    text += '}\n';
  }
  text += `}\nObjects: {\n${objects.join('\n')}\n}\nConnections: {\n${connections.join('\n')}\n}\nTakes: {\nCurrent: "${name}"\n}\n`;
  // (arrays end their record with a newline; indentation by depth)
  text = text.replaceAll(' { a: ', ' {\n a: ').replaceAll(' }\n', '\n}\n');
  let depth = 0;
  const out = [];
  for (const line of text.split('\n')) {
    depth -= (line.match(/}/g) || []).length;
    out.push('\t'.repeat(Math.max(0, depth)) + line.trim());
    depth += (line.match(/{/g) || []).length;
  }
  return out.join('\n') + '\n';
}
