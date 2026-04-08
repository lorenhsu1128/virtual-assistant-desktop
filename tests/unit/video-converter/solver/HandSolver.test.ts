import { describe, it, expect } from 'vitest';
import { HandSolver } from '../../../../src/video-converter/solver/HandSolver';
import { HAND } from '../../../../src/video-converter/tracking/landmarkTypes';
import type { Landmark } from '../../../../src/video-converter/tracking/landmarkTypes';
import { quatToEuler } from '../../../../src/video-converter/math/Euler';

const lm = (x: number, y: number, z: number): Landmark => ({ x, y, z });

/**
 * 建立 21 點手部 landmarks。
 *
 * 預設「攤平」：手腕在原點，每根手指沿 +X 方向延伸（每節 0.03 長），
 * 不同手指 Y 軸略微分散以維持空間獨立。
 */
function makeFlatHand(): Landmark[] {
  const arr: Landmark[] = new Array(21).fill(null).map(() => lm(0, 0, 0));
  arr[HAND.WRIST] = lm(0, 0, 0);

  // 拇指：略偏 +Y 方向（手側面）
  arr[HAND.THUMB_CMC] = lm(0.02, 0.02, 0);
  arr[HAND.THUMB_MCP] = lm(0.04, 0.04, 0);
  arr[HAND.THUMB_IP] = lm(0.06, 0.06, 0);
  arr[HAND.THUMB_TIP] = lm(0.08, 0.08, 0);

  // 食指
  arr[HAND.INDEX_MCP] = lm(0.05, 0.0, 0);
  arr[HAND.INDEX_PIP] = lm(0.08, 0.0, 0);
  arr[HAND.INDEX_DIP] = lm(0.11, 0.0, 0);
  arr[HAND.INDEX_TIP] = lm(0.14, 0.0, 0);

  // 中指
  arr[HAND.MIDDLE_MCP] = lm(0.05, -0.02, 0);
  arr[HAND.MIDDLE_PIP] = lm(0.08, -0.02, 0);
  arr[HAND.MIDDLE_DIP] = lm(0.11, -0.02, 0);
  arr[HAND.MIDDLE_TIP] = lm(0.14, -0.02, 0);

  // 無名指
  arr[HAND.RING_MCP] = lm(0.05, -0.04, 0);
  arr[HAND.RING_PIP] = lm(0.08, -0.04, 0);
  arr[HAND.RING_DIP] = lm(0.11, -0.04, 0);
  arr[HAND.RING_TIP] = lm(0.14, -0.04, 0);

  // 小指
  arr[HAND.PINKY_MCP] = lm(0.05, -0.06, 0);
  arr[HAND.PINKY_PIP] = lm(0.08, -0.06, 0);
  arr[HAND.PINKY_DIP] = lm(0.11, -0.06, 0);
  arr[HAND.PINKY_TIP] = lm(0.14, -0.06, 0);

  return arr;
}

/** 建立完全彎曲的食指（其他手指攤平） */
function makeFistIndex(side: 'left' | 'right'): Landmark[] {
  const arr = makeFlatHand();
  // 食指彎成 90°：MCP → PIP 沿 +X，PIP → DIP 沿 -Y，DIP → TIP 沿 -X
  arr[HAND.INDEX_PIP] = lm(0.08, 0.0, 0);
  arr[HAND.INDEX_DIP] = lm(0.08, -0.03, 0);
  arr[HAND.INDEX_TIP] = lm(0.05, -0.03, 0);
  return arr;
}

describe('HandSolver — 攤平手', () => {
  const solver = new HandSolver();

  it('攤平時 intermediate / distal 段 z 旋轉皆 ≈ 0', () => {
    // 註：proximal 段（k=0）的 prev 是 wrist，對偏離中軸的手指
    // 永遠存在 splay angle，故僅檢查 intermediate / distal。
    const out = solver.solve(makeFlatHand(), 'left');
    const fingers = [
      'leftIndexIntermediate',
      'leftIndexDistal',
      'leftMiddleIntermediate',
      'leftMiddleDistal',
      'leftRingIntermediate',
      'leftRingDistal',
      'leftLittleIntermediate',
      'leftLittleDistal',
    ] as const;
    for (const f of fingers) {
      const q = out[f];
      expect(q).toBeDefined();
      const e = quatToEuler(q!, 'XYZ');
      expect(Math.abs(e.z)).toBeLessThan(1e-6);
    }
  });

  it('與 wrist 對齊的食指：proximal 段也 ≈ 0', () => {
    // index MCP 與 wrist 在同一條 X 軸線上 (y=z=0)，所以 wrist→MCP→PIP
    // 是直線，proximal bend = π → zRot = 0
    const out = solver.solve(makeFlatHand(), 'left');
    const e = quatToEuler(out.leftIndexProximal!, 'XYZ');
    expect(Math.abs(e.z)).toBeLessThan(1e-6);
  });
});

describe('HandSolver — 完全彎曲（拳頭 ≈ -π/2）', () => {
  const solver = new HandSolver();

  it('左手食指 90° 彎曲時，至少有一節接近 -π/2', () => {
    const out = solver.solve(makeFistIndex('left'), 'left');
    // 1 DOF clamp 範圍是 [-π/2, 0]，左手 invert=-1
    // 「最彎」對應 zRot * invert = (-π/2) * (-1) = +π/2
    // 注意：clamp 是在 zRot * invert 前，所以左手會看到 +π/2
    const eP = quatToEuler(out.leftIndexProximal!, 'XYZ');
    const eI = quatToEuler(out.leftIndexIntermediate!, 'XYZ');
    const eD = quatToEuler(out.leftIndexDistal!, 'XYZ');
    const maxAbs = Math.max(Math.abs(eP.z), Math.abs(eI.z), Math.abs(eD.z));
    expect(maxAbs).toBeGreaterThan(Math.PI / 4);
  });

  it('右手 invert 翻轉：相同彎曲時 z 旋轉符號相反', () => {
    const leftOut = solver.solve(makeFistIndex('left'), 'left');
    const rightOut = solver.solve(makeFistIndex('right'), 'right');
    const leftZ = quatToEuler(leftOut.leftIndexIntermediate!, 'XYZ').z;
    const rightZ = quatToEuler(rightOut.rightIndexIntermediate!, 'XYZ').z;
    // 左右手同樣彎曲，z 應符號相反（或都接近 0）
    if (Math.abs(leftZ) > 1e-6 || Math.abs(rightZ) > 1e-6) {
      expect(Math.sign(leftZ)).toBe(-Math.sign(rightZ));
    }
  });
});

describe('HandSolver — V 字手勢', () => {
  const solver = new HandSolver();

  it('食指中指攤平、無名指小指彎 → 食指中指 z ≈ 0、無名指小指 z 偏離 0', () => {
    const arr = makeFlatHand();
    // 無名指彎曲
    arr[HAND.RING_PIP] = lm(0.08, -0.04, 0);
    arr[HAND.RING_DIP] = lm(0.08, -0.07, 0);
    arr[HAND.RING_TIP] = lm(0.05, -0.07, 0);
    // 小指彎曲
    arr[HAND.PINKY_PIP] = lm(0.08, -0.06, 0);
    arr[HAND.PINKY_DIP] = lm(0.08, -0.09, 0);
    arr[HAND.PINKY_TIP] = lm(0.05, -0.09, 0);

    const out = solver.solve(arr, 'left');
    // 食指中指攤平
    expect(Math.abs(quatToEuler(out.leftIndexIntermediate!, 'XYZ').z)).toBeLessThan(1e-6);
    expect(Math.abs(quatToEuler(out.leftMiddleIntermediate!, 'XYZ').z)).toBeLessThan(1e-6);
    // 無名指 / 小指至少 PIP 中間段有彎曲
    expect(Math.abs(quatToEuler(out.leftRingIntermediate!, 'XYZ').z)).toBeGreaterThan(0.1);
    expect(Math.abs(quatToEuler(out.leftLittleIntermediate!, 'XYZ').z)).toBeGreaterThan(0.1);
  });
});

describe('HandSolver — 退化輸入', () => {
  it('空輸入回傳空物件', () => {
    expect(Object.keys(new HandSolver().solve([], 'left')).length).toBe(0);
  });

  it('identity() 為對應側別的所有手指 identity', () => {
    const out = new HandSolver().identity('left');
    expect(out.leftIndexProximal).toBeDefined();
    expect(out.leftIndexProximal!.w).toBe(1);
    expect(out.rightIndexProximal).toBeUndefined();
  });
});
