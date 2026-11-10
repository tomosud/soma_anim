// The character on screen: the skinned UE5 Manny (assets/manny.*, eight influences per vertex),
// or a mannequin of capsules built from the skeleton when the mesh is not there.
import * as T from 'three';

/** Skinned mesh driven by world matrices given from outside (rig.jointWorld). */
export async function loadManny(url, v = '') {
  const meta = await fetch(url + '.json' + v).then(r => { if (!r.ok) throw Error('no mesh'); return r.json(); });
  const buf = await fetch(url + '.bin' + v).then(r => { if (!r.ok) throw Error('no mesh'); return r.arrayBuffer(); });
  const L = meta.layout, nv = meta.vertices;
  const g = new T.BufferGeometry();
  g.setAttribute('position', new T.BufferAttribute(new Float32Array(buf, L.positions.offset, L.positions.count), 3));
  g.setIndex(new T.BufferAttribute(new Uint32Array(buf, L.indices.offset, L.indices.count), 1));
  g.computeVertexNormals();
  const sw = new Uint16Array(buf, L.skinWeights.offset, L.skinWeights.count), si = new Uint8Array(buf, L.skinIndices.offset, L.skinIndices.count);
  const i1 = new Uint16Array(nv * 4), i2 = new Uint16Array(nv * 4), w1 = new Float32Array(nv * 4), w2 = new Float32Array(nv * 4);
  for (let v = 0; v < nv; v++) for (let k = 0; k < 4; k++) {
    i1[v * 4 + k] = si[v * 8 + k]; i2[v * 4 + k] = si[v * 8 + 4 + k];
    w1[v * 4 + k] = sw[v * 8 + k] / 65535; w2[v * 4 + k] = sw[v * 8 + 4 + k] / 65535;
  }
  g.setAttribute('skinIndex', new T.BufferAttribute(i1, 4)); g.setAttribute('skinWeight', new T.BufferAttribute(w1, 4));
  g.setAttribute('skinIndex2', new T.BufferAttribute(i2, 4)); g.setAttribute('skinWeight2', new T.BufferAttribute(w2, 4));
  const material = new T.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6, metalness: 0.1 });
  material.onBeforeCompile = shader => {
    shader.vertexShader = 'attribute vec4 skinIndex2;\nattribute vec4 skinWeight2;\n' + shader.vertexShader;
    let base = T.ShaderChunk.skinbase_vertex, skin = T.ShaderChunk.skinning_vertex, normal = T.ShaderChunk.skinnormal_vertex;
    const ax = ['X', 'Y', 'Z', 'W'];
    base = base.replace('#endif', ax.map((a, i) => `mat4 boneMat${a}2 = getBoneMatrix( skinIndex2.${'xyzw'[i]} );`).join('\n') + '\n#endif');
    skin = skin.replace('transformed =', ax.map((a, i) => `skinned += boneMat${a}2 * skinVertex * skinWeight2.${'xyzw'[i]};`).join('\n') + '\ntransformed =');
    normal = normal.replace('skinMatrix = bindMatrixInverse', ax.map((a, i) => `skinMatrix += skinWeight2.${'xyzw'[i]} * boneMat${a}2;`).join('\n') + '\nskinMatrix = bindMatrixInverse');
    shader.vertexShader = shader.vertexShader.replace('#include <skinbase_vertex>', base).replace('#include <skinning_vertex>', skin).replace('#include <skinnormal_vertex>', normal);
  };
  material.customProgramCacheKey = () => 'eight-influences';
  const bones = meta.influences.map(() => new T.Bone());
  const skeleton = new T.Skeleton(bones, meta.inverseRest.map(a => new T.Matrix4().fromArray(a)));
  const mesh = new T.SkinnedMesh(g, material);
  mesh.bind(skeleton, new T.Matrix4());
  mesh.bindMode = 'detached';
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  const group = new T.Group();
  group.add(mesh);
  group.userData.update = rig => {
    meta.influences.forEach((n, i) => bones[i].matrixWorld.fromArray(rig.jointWorld(n)));
    skeleton.update();
  };
  return group;
}

/** Capsules between the joints (no mesh needed). */
export function makeMannequin(rig) {
  const group = new T.Group();
  const mat = new T.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.6 });
  const skip = /^(ik_|interaction|center_of_mass|root$)|twist|metacarpal/;
  const parts = [];
  const thick = n => /thigh|pelvis|spine/.test(n) ? 7 : /calf|upperarm|neck|head/.test(n) ? 4.5 : /lowerarm|foot|clavicle/.test(n) ? 3.6 : /hand|ball/.test(n) ? 3 : 0.9;
  for (const j of rig.joints) {
    if (skip.test(j.name) || skip.test(j.parent) || !rig.jointIndex.has(j.parent)) continue;
    const m = new T.Mesh(new T.CylinderGeometry(0.8, 1, 1, 12), mat);
    const ball = new T.Mesh(new T.SphereGeometry(1, 12, 8), mat);
    ball.castShadow = true; group.add(ball);
    m.castShadow = true;
    group.add(m);
    parts.push({ m, ball, a: j.parent, b: j.name, r: thick(j.parent) });
  }
  const head = new T.Mesh(new T.SphereGeometry(10, 20, 14), mat);
  head.castShadow = true;
  group.add(head);
  const A = new T.Vector3(), B = new T.Vector3(), up = new T.Vector3(0, 1, 0), d = new T.Vector3();
  group.userData.update = r => {
    for (const p of parts) {
      const a = r.jointWorld(p.a), b = r.jointWorld(p.b);
      A.set(a[12], a[13], a[14]); B.set(b[12], b[13], b[14]);
      const len = d.subVectors(B, A).length();
      p.m.position.addVectors(A, B).multiplyScalar(0.5);
      p.m.quaternion.setFromUnitVectors(up, d.normalize());
      p.m.scale.set(p.r, Math.max(0.01, len), p.r);
      p.ball.position.copy(A); p.ball.scale.setScalar(p.r);
    }
    const h = r.jointWorld('head');
    head.position.set(h[12] + h[0] * 9, h[13] + h[1] * 9, h[14] + h[2] * 9);
  };
  return group;
}
