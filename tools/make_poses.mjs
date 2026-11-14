// The pose book: poses of the reference motion an animator can drop on a frame with one click (stances,
// punches, kicks ...).  For each entry the clip is named and the frame is found by what the pose is about
// (the hand farthest forward, the foot highest ...).   node tools/make_poses.mjs   -> assets/poses.json
import { readFileSync, writeFileSync } from 'node:fs';
import { SomaRig, MotionDB } from '../src/motiondb.js';

const read = p => readFileSync(new URL(p, import.meta.url));
const soma = new SomaRig(JSON.parse(read('../assets/soma_rig.json')));
const bin = read('../assets/motiondb.bin');
const db = new MotionDB(soma, JSON.parse(read('../assets/motiondb.json')), bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength));

// [group, label, clip (start of its name), what to look for (or a frame number), offset in frames from there]
const BOOK = [
  ['立ち・構え', '立ち', 'standard_idle', 10],
  ['立ち・構え', 'ボクシングの構え', 'stance_boxing_idle', 20],
  ['立ち・構え', '格闘の構え', 'stance_male_fight_idle_empty_stance', 20],
  ['立ち・構え', '低い構え', 'stance_male_fight_idle_thai_chi_to_open_s', 'hipLow'],
  ['立ち・構え', 'しゃがむ', 'crouching_from_standing_position', 'hipLow'],
  ['立ち・構え', '勝利', 'aj_victory_idle', 'handHigh'],
  ['パンチ', 'ジャブ', 'punch_jab_punch', 'handFwd'],
  ['パンチ', 'クロス', 'punch_cross_punch', 'handFwd'],
  ['パンチ', 'ロングジャブ', 'punch_long_head_jab', 'handFwd'],
  ['パンチ', 'ボディ', 'punch_mid_body_jab', 'handFwd'],
  ['パンチ', 'フック', 'punch_hook_with_the_lead_hand', 'handSide'],
  // (the fist on its way up, at chin height: at the top of the swing it reads as a raised hand)
  ['パンチ', 'アッパー', 'punch_standing_left_uppercut_punch', 'handHigh', -2],
  ['パンチ', 'アッパーの溜め', 'punch_standing_left_uppercut_punch', 'handHigh', -9],
  ['パンチ', '肘打ち', 'punch_male_elbow_punch', 'elbowFwd'],
  ['パンチ', '振りかぶり', 'punch_cross_punch', 'handFwd', -7],
  ['キック', '前蹴り', 'kick_male_front_snap_kick_with_the_lead', 'footHigh'],
  ['キック', '回し蹴り', 'kick_mma_roundhouse_kick', 'footHigh'],
  ['キック', 'ハイキック', 'kick_mma_high_kick', 'footHigh'],
  ['キック', 'ミドルキック', 'kick_mma_medium_kick', 'footHigh'],
  ['キック', 'ローキック', 'kick_mma_low_kick', 'footFar'],
  ['キック', 'サイドキック', 'kick_mma_side_kick', 'footHigh'],
  ['キック', '突き蹴り', 'kick_male_thrust_kick_with_the_rear_foo', 'footFar'],
  ['キック', '膝蹴り', 'kick_boxing_illegal_knee', 'kneeHigh'],
  ['キック', '蹴りの溜め', 'kick_mma_roundhouse_kick', 'footHigh', -9],
  ['防御・よけ', '上段ブロック', 'block_high_center_block', 'handHigh'],
  ['防御・よけ', '下段ブロック', 'block_low_center_block', 'handLow'],
  ['防御・よけ', '両腕ガード', 'block_blocking_the_chest_area_with_both_', 'handHigh'],
  ['防御・よけ', '下がってよける', 'block_boxing_dodge_retreat', 'lean'],
  ['防御・よけ', 'ダッキング', 'block_boxing_dodge_advance', 'hipLow'],
  // (jumps, flips: clips added with tools/add_clips.mjs - put them on keys with the feet check off, so that they stay
  //  in the air)
  ['ジャンプ', '踏み切りの溜め', 'jump_idle', 'hipLow'],
  ['ジャンプ', '跳び上がる', 'jump_idle', 16],
  ['ジャンプ', 'ジャンプの頂点', 'jump_idle', 'hipHigh'],
  ['ジャンプ', '着地', 'jump_idle', 40],
  ['ジャンプ', '喜びのジャンプ', 'jump_joy', 'hipHigh'],
  ['ジャンプ', 'その場で跳ぶ', 'jump_place', 'hipHigh'],
  ['ジャンプ', 'バク宙の踏み切り', 'backflip', 'hipLow'],
  ['ジャンプ', 'バク宙（逆さま）', 'backflip', 'upside'],
  ['ジャンプ', '前宙の踏み切り', 'running_forward_flip', 8],
  ['ジャンプ', '前宙（逆さま）', 'running_forward_flip', 'upside'],
  ['倒れる・寝る', '後ろに倒れかける', 'fall_dying_falling_backward', 14],
  ['倒れる・寝る', '前に倒れかける', 'fall_dying_falling_forward', 22],
  ['倒れる・寝る', 'つまずく', 'tripping_forward_while_walking', 36],
  ['倒れる・寝る', '足を滑らせる', 'hit_slip_and_fall_backwards', 33],
  ['倒れる・寝る', '尻もち', 'hit_slip_and_fall_backwards', 90],
  ['倒れる・寝る', '仰向け', 'hit_knocked_out_falling_to_back', 120],
  ['倒れる・寝る', 'うつ伏せ', 'hit_knocked_out_falling_to_stomach', 140],
  ['倒れる・寝る', '起き上がる途中', 'getup_getting_up_from_back', 130],
  ['倒れる・寝る', '手をついてしゃがむ', 'standing_from_crouched_hands_on', 10],
  ['倒れる・寝る', '寝ている', 'sleeping_deeply', 100],
  ['日常', '歩く', 'standard_walk', 12],
  ['日常', '走る', 'running_forward_c9', 15],
  ['日常', 'こっそり歩く', 'sneaking_forward_quickly', 20],
  ['日常', '手を振る', 'intercept_and_wave_to_stop', 20],
  ['日常', '指さす', 'pointing_onward_charge', 56],
  ['日常', '親指を立てる', 'giving_thumbs_up', 30],
  ['日常', '考える', 'thinking_while_standing', 50],
  ['日常', '肩をすくめる', 'shoulder_shrug', 22],
  ['日常', '手を伸ばす', 'reach_out', 108],
  ['日常', '遠くを見る', 'looking_with_hand_shading', 50],
  ['日常', '水を飲む', 'stopping_to_drink', 120],
  ['日常', 'のぞき込む', 'crouch_looking_around_corner', 30],
  ['日常', '大喜び', 'big_vegas_victory_idle', 22],
];

const J = n => soma.index[n];
function measure(pose) {
  const P = soma.positions(pose), h = soma.heading(P), c = Math.cos(h), s = Math.sin(h), hip = P[0];
  const body = j => { const dx = P[j][0] - hip[0], dz = P[j][2] - hip[2]; return [dx * c - dz * s, P[j][1], dx * s + dz * c]; }; // x left, z forward
  const hands = [body(J('LeftHand')), body(J('RightHand'))], feet = [body(J('LeftFoot')), body(J('RightFoot'))];
  const elbows = [body(J('LeftForeArm')), body(J('RightForeArm'))], knees = [body(J('LeftShin')), body(J('RightShin'))], head = body(J('Head'));
  return {
    // (a punch: the fist farthest from the chest, toward where the clip faces)
    handFwd: Math.max(...[J('LeftHand'), J('RightHand')].map(j => Math.hypot(P[j][0] - P[J('Chest')][0], P[j][1] - P[J('Chest')][1], P[j][2] - P[J('Chest')][2]) + 0.5 * (P[j][2] - P[J('Chest')][2]))), handBack: -Math.min(hands[0][2], hands[1][2]) + 0.3 * Math.max(hands[0][2], hands[1][2]),
    handHigh: Math.max(hands[0][1], hands[1][1]), handLow: -Math.min(hands[0][1], hands[1][1]) + Math.max(hands[0][2], hands[1][2]),
    handSide: Math.max(Math.abs(hands[0][0]), Math.abs(hands[1][0])) + 0.5 * Math.max(hands[0][2], hands[1][2]),
    elbowFwd: Math.max(elbows[0][2], elbows[1][2]), footHigh: Math.max(feet[0][1], feet[1][1]),
    footFar: Math.max(Math.hypot(feet[0][0], feet[0][2]), Math.hypot(feet[1][0], feet[1][2])) + Math.max(feet[0][1], feet[1][1]),
    kneeHigh: Math.max(knees[0][1], knees[1][1]), hipLow: -hip[1], lean: -head[2],
    // (a jump at its top; a flip upside down: the head under the hips)
    hipHigh: hip[1], upside: hip[1] - head[1],
  };
}

const out = [];
for (const [group, label, name, what, shift = 0] of BOOK) {
  const clip = db.clips.findIndex(c => c.name.startsWith(name));
  if (clip < 0) { console.log('missing', name); continue; }
  let frame = what;
  if (typeof what === 'string') {
    let best = -Infinity;
    for (let f = 2; f < db.clips[clip].frames - 2; f++) { const v = measure(db.pose(clip, f))[what]; if (v > best) { best = v; frame = f; } }
  }
  frame = Math.max(0, Math.min(db.clips[clip].frames - 1, frame + shift));
  out.push({ group, label, clip: db.clips[clip].name, frame });
  console.log(group, label, db.clips[clip].name, frame, '/', db.clips[clip].frames);
}
writeFileSync(new URL('../assets/poses.json', import.meta.url), JSON.stringify({ about: 'pose book: frames of the reference motion (tools/make_poses.mjs)', poses: out }, null, 1));
