import { describe, it, expect } from 'vitest';
import { EyeGazeSolver } from '../../../../src/video-converter/solver/EyeGazeSolver';
import { FACE, FACE_LANDMARK_COUNT } from '../../../../src/video-converter/tracking/landmarkTypes';
import type { Landmark } from '../../../../src/video-converter/tracking/landmarkTypes';
import { quatToEuler } from '../../../../src/video-converter/math/Euler';

const lm = (x: number, y: number, z: number): Landmark => ({ x, y, z });

/** 建立 478 點 face landmarks，預設眼眶中心對齊、虹膜置中 */
function makeNeutralFace(): Landmark[] {
  const arr: Landmark[] = new Array(FACE_LANDMARK_COUNT).fill(null).map(() => lm(0, 0, 0));
  // 左眼：內角 (0.45, 0.5)、外角 (0.4, 0.5)
  arr[FACE.LEFT_EYE_INNER_CORNER] = lm(0.45, 0.5, 0);
  arr[FACE.LEFT_EYE_OUTER_CORNER] = lm(0.4, 0.5, 0);
  arr[FACE.LEFT_EYE_TOP] = lm(0.425, 0.48, 0);
  arr[FACE.LEFT_EYE_BOTTOM] = lm(0.425, 0.52, 0);
  arr[FACE.LEFT_IRIS_CENTER] = lm(0.425, 0.5, 0); // 中心

  // 右眼
  arr[FACE.RIGHT_EYE_INNER_CORNER] = lm(0.55, 0.5, 0);
  arr[FACE.RIGHT_EYE_OUTER_CORNER] = lm(0.6, 0.5, 0);
  arr[FACE.RIGHT_EYE_TOP] = lm(0.575, 0.48, 0);
  arr[FACE.RIGHT_EYE_BOTTOM] = lm(0.575, 0.52, 0);
  arr[FACE.RIGHT_IRIS_CENTER] = lm(0.575, 0.5, 0);

  return arr;
}

describe('EyeGazeSolver — 直視', () => {
  const solver = new EyeGazeSolver();

  it('虹膜置中 → eye rotation 為 identity', () => {
    const out = solver.solve(makeNeutralFace());
    expect(out.leftEye).not.toBeNull();
    expect(out.rightEye).not.toBeNull();
    const eL = quatToEuler(out.leftEye!, 'XYZ');
    const eR = quatToEuler(out.rightEye!, 'XYZ');
    expect(eL.x).toBeCloseTo(0, 9);
    expect(eL.y).toBeCloseTo(0, 9);
    expect(eR.x).toBeCloseTo(0, 9);
    expect(eR.y).toBeCloseTo(0, 9);
  });
});

describe('EyeGazeSolver — 右看', () => {
  const solver = new EyeGazeSolver();

  it('左眼虹膜偏 +X（內角方向）→ yaw > 0', () => {
    const face = makeNeutralFace();
    // 把左虹膜中心往內角推（+X）：原本 0.425，內角 0.45
    face[FACE.LEFT_IRIS_CENTER] = lm(0.44, 0.5, 0);
    const out = solver.solve(face);
    const e = quatToEuler(out.leftEye!, 'XYZ');
    expect(e.y).toBeGreaterThan(0); // yaw 正
  });

  it('右眼虹膜偏 -X → yaw < 0', () => {
    const face = makeNeutralFace();
    face[FACE.RIGHT_IRIS_CENTER] = lm(0.56, 0.5, 0); // 偏左（-X 相對中心 0.575）
    const out = solver.solve(face);
    const e = quatToEuler(out.rightEye!, 'XYZ');
    expect(e.y).toBeLessThan(0);
  });
});

describe('EyeGazeSolver — 上下看', () => {
  const solver = new EyeGazeSolver();

  it('虹膜偏 +Y（影像中往下）→ pitch > 0', () => {
    const face = makeNeutralFace();
    face[FACE.LEFT_IRIS_CENTER] = lm(0.425, 0.51, 0); // 往下
    const out = solver.solve(face);
    const e = quatToEuler(out.leftEye!, 'XYZ');
    expect(e.x).toBeGreaterThan(0);
  });

  it('虹膜偏 -Y → pitch < 0', () => {
    const face = makeNeutralFace();
    face[FACE.LEFT_IRIS_CENTER] = lm(0.425, 0.49, 0); // 往上
    const out = solver.solve(face);
    const e = quatToEuler(out.leftEye!, 'XYZ');
    expect(e.x).toBeLessThan(0);
  });
});

describe('EyeGazeSolver — 退化輸入', () => {
  const solver = new EyeGazeSolver();

  it('face landmarks 不足 → 兩眼皆 null', () => {
    expect(solver.solve([])).toEqual({ leftEye: null, rightEye: null });
  });

  it('眼眶寬度為 0 → 對應 eye 為 null', () => {
    const face = makeNeutralFace();
    face[FACE.LEFT_EYE_INNER_CORNER] = lm(0.4, 0.5, 0);
    face[FACE.LEFT_EYE_OUTER_CORNER] = lm(0.4, 0.5, 0); // 與內角重合
    const out = solver.solve(face);
    expect(out.leftEye).toBeNull();
    expect(out.rightEye).not.toBeNull(); // 右眼正常
  });
});

describe('EyeGazeSolver — 範圍 clamp', () => {
  const solver = new EyeGazeSolver();

  it('虹膜超出眼眶：yaw 不超過 ±π/6（30°）', () => {
    const face = makeNeutralFace();
    face[FACE.LEFT_IRIS_CENTER] = lm(0.6, 0.5, 0); // 遠超內角
    const out = solver.solve(face);
    const e = quatToEuler(out.leftEye!, 'XYZ');
    expect(Math.abs(e.y)).toBeLessThanOrEqual(Math.PI / 6 + 1e-9);
  });
});
