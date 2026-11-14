// Why a stretch between two keys is the plain in-between, or why the MotionBricks motion on it is warned about
// (too fast for a person, broken): a short label for the timeline band, what is wrong, and what to do about it.  A reason is {code, ...numbers}; text(reason)
// turns it into words.

/** Fastest a person goes from standing to standing over `dist` metres (seconds): speeding up and slowing down
 *  at about 6 m/s², at most 6 m/s. */
export function quickest(dist) {
  const acc = 6, top = 6;
  const reach = top * top / acc; // the distance it takes to get to top speed and stop again
  return dist <= reach ? 2 * Math.sqrt(dist / acc) : 2 * top / acc + (dist - reach) / top;
}

/**
 * What makes keys a and b (hips {x, z} in metres, facing in radians) n frames apart more than a person can do,
 * or null.  flow: the motion goes on through the keys (no stop at either end).
 */
export function infeasible(dist, turn, n, fps = 30, flow = false) {
  const t = n / fps;
  const need = flow ? dist / 7 : quickest(dist);
  if (dist > 0.5 && t < need * 0.8) return { code: 'fast', dist, n, speed: dist / t, frames: Math.ceil(need * fps) };
  // (a half turn takes about a third of a second, standing)
  const turnNeed = Math.abs(turn) / Math.PI * 0.35;
  if (Math.abs(turn) > 1.2 && t < turnNeed * 0.8) return { code: 'spin', turn, n, frames: Math.ceil(turnNeed * fps) };
  return null;
}

const PART = {
  air: ['跳んでしまう', '両足が床から離れる（跳ぶ・飛び込む）'],
  tilt: ['倒れる', '体が大きく傾く・倒れる'],
  spin: ['回ってしまう', '体が勝手に回る'],
  path: ['道から外れる', '腰がキーとキーを結ぶ道から大きく外れる'],
  hips: ['腰が上下する', '腰がキーより大きく上がる・下がる'],
  gesture: ['余計な身振り', '頼んでいない手や頭の動きが入る'],
  slide: ['足が滑る', '着いている足が滑る'],
  sink: ['足が沈む', '足が床に沈む'],
};
const FIX = {
  air: 'キーの間隔を広げる、または間にキーを足す',
  tilt: 'どちらかのキーの傾きを小さくする、または間にキーを足す',
  spin: 'キーの間隔を広げる、または向きを変える途中のキーを足す',
  path: '間にキーを足して道を決める',
  hips: '腰の高さが違いすぎるなら間にキーを足す（しゃがむ途中など）',
  gesture: '手や頭の位置を両方のキーで決める（ピン）か、間にキーを足す',
  slide: 'キーの間隔を広げる、または足の位置を見直す',
  sink: '足が床の下に入らないようにキーを直す',
};

/** {label (short, for the band), text (what is wrong), fix (what to do)} for a reason. */
export function text(r) {
  if (!r) return null;
  switch (r.code) {
    case 'short': return { label: '補間（間隔が短い）', text: `キーの間が ${r.n} フレームしかなく、動きを生成できません（5 フレーム以上で生成します）`, fix: 'キーの間隔を 5 フレーム以上にする' };
    case 'loading': return { label: '補間（モデル準備中）', text: 'MotionBricks のモデルを準備中です。準備ができると作り直します', fix: '少し待つ' };
    case 'unavailable': return { label: '補間（モデルなし）', text: 'MotionBricks を使えないため単純な補間にしています', fix: 'WebGPU の使えるブラウザで開く' };
    case 'failed': return { label: '補間（生成エラー）', text: `MotionBricks の生成に 3 回失敗しました: ${r.error || ''}`, fix: '「R」で作り直す。直らなければキーを少し動かす' };
    case 'fast': return {
      label: '速すぎる',
      text: `${r.n} フレーム（${(r.n / 30).toFixed(1)} 秒）で ${r.dist.toFixed(1)} m 移動して止まるのは、人には速すぎます。生成はしますが、跳んだり滑ったりします（平均 ${r.speed.toFixed(1)} m/s。走り出して止まるまでに約 ${r.frames} フレームかかる距離です）`,
      fix: `キーの間隔を ${r.frames} フレーム以上にする、または移動の距離を短くする`,
    };
    case 'spin': return {
      label: '回るのが速すぎる',
      text: `${r.n} フレームで ${Math.round(Math.abs(r.turn) * 180 / Math.PI)}° 向きを変えるのは速すぎます。生成はしますが、跳んだり崩れたりします`,
      fix: `キーの間隔を ${r.frames} フレーム以上にする`,
    };
    case 'bad': {
      const parts = (r.parts || []).filter(p => PART[p]);
      const main = parts[0];
      return {
        label: main ? PART[main][0] : '崩れる',
        text: `MotionBricks の動きで、${parts.length ? parts.map(p => PART[p][1]).join('、') : '体が崩れる'}（${r.tried} 通り試した中で一番よいものを使っています）`,
        fix: main ? FIX[main] : '間にキーを足す',
      };
    }
  }
  return { label: '補間', text: '単純な補間です', fix: '' };
}

/** One line for the status bar / tooltip. */
export function line(r) {
  const t = text(r);
  return t ? `${t.text}。→ ${t.fix}` : '';
}
