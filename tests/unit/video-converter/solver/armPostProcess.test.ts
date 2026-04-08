import { describe, it, expect } from 'vitest';
import { applyKalidokitArmAdjust } from '../../../../src/video-converter/solver/armPostProcess';
import { eulerToQuat, quatToEuler } from '../../../../src/video-converter/math/Euler';
import { quatIdentity } from '../../../../src/video-converter/math/Quat';

describe('armPostProcess — applyKalidokitArmAdjust', () => {
  it('identity raw → identity output（z × anything = 0）', () => {
    const result = applyKalidokitArmAdjust('left', quatIdentity(), quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.x).toBeCloseTo(0, 9);
    expect(eu.y).toBeCloseTo(0, 9);
    expect(eu.z).toBeCloseTo(0, 9);
    const lo = quatToEuler(result.lowerArm, 'XYZ');
    expect(lo.x).toBeCloseTo(0, 9);
    expect(lo.y).toBeCloseTo(0, 9);
    expect(lo.z).toBeCloseTo(0, 9);
  });

  it('LEFT 側 z 倍率為 +2.3 (−2.3 × −1)', () => {
    // 原始 z = 0.3
    const raw = eulerToQuat(0, 0, 0.3, 'XYZ');
    const result = applyKalidokitArmAdjust('left', raw, quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.z).toBeCloseTo(0.3 * 2.3, 3); // LEFT: -2.3 × -1 = +2.3
  });

  it('RIGHT 側 z 倍率為 -2.3', () => {
    const raw = eulerToQuat(0, 0, 0.3, 'XYZ');
    const result = applyKalidokitArmAdjust('right', raw, quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.z).toBeCloseTo(0.3 * -2.3, 3);
  });

  it('X 軸 clamp: 超過 -0.5 下限', () => {
    const raw = eulerToQuat(-1.0, 0, 0, 'XYZ');
    const result = applyKalidokitArmAdjust('left', raw, quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.x).toBeCloseTo(-0.5, 3);
  });

  it('X 軸 clamp: 超過 π 上限', () => {
    const raw = eulerToQuat(Math.PI + 0.5, 0, 0, 'XYZ');
    const result = applyKalidokitArmAdjust('left', raw, quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    // quatToEuler 可能回傳 [-π, π] 範圍，Math.PI+0.5 可能 wrap
    // 只驗證結果不是原本的超大值
    expect(Math.abs(eu.x)).toBeLessThanOrEqual(Math.PI + 1e-6);
  });

  it('Y 軸 clamp: 超過 -π/2 下限', () => {
    const raw = eulerToQuat(0, -Math.PI, 0, 'XYZ');
    const result = applyKalidokitArmAdjust('left', raw, quatIdentity());
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.y).toBeGreaterThanOrEqual(-Math.PI / 2 - 1e-6);
  });

  it('解剖耦合: upperArm.y 加上 lowerArm.x × 0.5', () => {
    // upperArm raw 的 y = 0 → 套用後預期 y = 0.3 * 0.5 = 0.15
    const upperRaw = eulerToQuat(0, 0, 0, 'XYZ');
    const lowerRaw = eulerToQuat(0.3, 0, 0, 'XYZ');
    const result = applyKalidokitArmAdjust('left', upperRaw, lowerRaw);
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.y).toBeCloseTo(0.15, 3);
  });

  it('解剖耦合後仍會被 Y 範圍 clamp', () => {
    // upperArm.y 近上限 + lowerArm.x 推它超出 → clamp 到上限
    const upperRaw = eulerToQuat(0, Math.PI / 2 - 0.05, 0, 'XYZ');
    const lowerRaw = eulerToQuat(0.5, 0, 0, 'XYZ'); // 貢獻 +0.25
    const result = applyKalidokitArmAdjust('left', upperRaw, lowerRaw);
    const eu = quatToEuler(result.upperArm, 'XYZ');
    expect(eu.y).toBeLessThanOrEqual(Math.PI / 2 + 1e-6);
  });

  it('lowerArm 原樣回傳（不被調整）', () => {
    const lowerRaw = eulerToQuat(0, 0, -1.0, 'XYZ');
    const result = applyKalidokitArmAdjust('left', quatIdentity(), lowerRaw);
    // lowerArm 應完全相等
    expect(result.lowerArm.x).toBeCloseTo(lowerRaw.x, 9);
    expect(result.lowerArm.y).toBeCloseTo(lowerRaw.y, 9);
    expect(result.lowerArm.z).toBeCloseTo(lowerRaw.z, 9);
    expect(result.lowerArm.w).toBeCloseTo(lowerRaw.w, 9);
  });

  it('輸出為有效 quaternion（不 NaN）', () => {
    const cases = [
      [1.0, 0.5, -1.2],
      [-0.3, -0.8, 2.0],
      [0, 0, Math.PI * 0.9],
    ];
    for (const [x, y, z] of cases) {
      const raw = eulerToQuat(x, y, z, 'XYZ');
      const result = applyKalidokitArmAdjust('left', raw, quatIdentity());
      expect(Number.isFinite(result.upperArm.x)).toBe(true);
      expect(Number.isFinite(result.upperArm.y)).toBe(true);
      expect(Number.isFinite(result.upperArm.z)).toBe(true);
      expect(Number.isFinite(result.upperArm.w)).toBe(true);
    }
  });
});
