import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  computeAlpha,
  OneEuroScalarFilter,
  OneEuroQuaternionFilter,
} from '../../src/mocap/filters/OneEuroFilter';

describe('computeAlpha', () => {
  it('returns 1 when cutoff <= 0', () => {
    expect(computeAlpha(0, 1 / 30)).toBe(1);
    expect(computeAlpha(-1, 1 / 30)).toBe(1);
  });

  it('returns 1 when dt <= 0', () => {
    expect(computeAlpha(1, 0)).toBe(1);
    expect(computeAlpha(1, -0.5)).toBe(1);
  });

  it('returns value in (0, 1) for normal parameters', () => {
    const a = computeAlpha(1, 1 / 30);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(1);
  });

  it('higher cutoff → higher alpha', () => {
    const low = computeAlpha(0.5, 1 / 30);
    const high = computeAlpha(10, 1 / 30);
    expect(high).toBeGreaterThan(low);
  });

  it('larger dt → higher alpha for same cutoff', () => {
    const small = computeAlpha(1, 1 / 60);
    const large = computeAlpha(1, 1 / 15);
    expect(large).toBeGreaterThan(small);
  });
});

describe('OneEuroScalarFilter', () => {
  it('first call returns input unchanged', () => {
    const f = new OneEuroScalarFilter(1);
    expect(f.filter(5, 1 / 30)).toBe(5);
  });

  it('steady input converges to that value', () => {
    const f = new OneEuroScalarFilter(1);
    for (let i = 0; i < 20; i++) f.filter(10, 1 / 30);
    expect(f.filter(10, 1 / 30)).toBeCloseTo(10);
  });

  it('step input lags behind target', () => {
    const f = new OneEuroScalarFilter(1);
    f.filter(0, 1 / 30);
    const out = f.filter(100, 1 / 30);
    // 輸出應介於 0 和 100 之間，非立即到達
    expect(out).toBeGreaterThan(0);
    expect(out).toBeLessThan(100);
  });

  it('reset clears state', () => {
    const f = new OneEuroScalarFilter(1);
    f.filter(10, 1 / 30);
    f.filter(10, 1 / 30);
    f.reset();
    expect(f.filter(20, 1 / 30)).toBe(20); // 當作首次輸入
  });

  it('setCutoff changes behavior', () => {
    const f = new OneEuroScalarFilter(0.1);
    f.filter(0, 1 / 30);
    const slow = f.filter(100, 1 / 30);
    f.reset();
    f.setCutoff(10);
    f.filter(0, 1 / 30);
    const fast = f.filter(100, 1 / 30);
    // 更高 cutoff 應更接近目標
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('OneEuroQuaternionFilter', () => {
  const IDENTITY = (): THREE.Quaternion => new THREE.Quaternion(0, 0, 0, 1);
  const rotY90 = (): THREE.Quaternion =>
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);

  it('first call returns a clone equal to input', () => {
    const f = new OneEuroQuaternionFilter();
    const q = IDENTITY();
    const out = f.filter(q, 1 / 30);
    expect(out.x).toBe(q.x);
    expect(out.y).toBe(q.y);
    expect(out.z).toBe(q.z);
    expect(out.w).toBe(q.w);
  });

  it('returns a new quaternion instance (not the input)', () => {
    const f = new OneEuroQuaternionFilter();
    const q = IDENTITY();
    const out = f.filter(q, 1 / 30);
    expect(out).not.toBe(q);
  });

  it('steady identity input stays at identity', () => {
    const f = new OneEuroQuaternionFilter();
    let out = IDENTITY();
    for (let i = 0; i < 30; i++) {
      out = f.filter(IDENTITY(), 1 / 30);
    }
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(0);
    expect(out.w).toBeCloseTo(1);
  });

  it('step input: output is between prev and target', () => {
    const f = new OneEuroQuaternionFilter({ minCutoff: 1, beta: 0 });
    f.filter(IDENTITY(), 1 / 30);
    const target = rotY90();
    const out = f.filter(target, 1 / 30);
    // 應落在 identity 和 target 之間
    expect(Math.abs(out.y)).toBeGreaterThan(0);
    expect(Math.abs(out.y)).toBeLessThan(Math.abs(target.y) - 0.001);
  });

  it('output converges to target over many frames', () => {
    const f = new OneEuroQuaternionFilter({ minCutoff: 5, beta: 0 });
    f.filter(IDENTITY(), 1 / 30);
    const target = rotY90();
    let out = IDENTITY();
    for (let i = 0; i < 200; i++) {
      out = f.filter(target, 1 / 30);
    }
    expect(out.y).toBeCloseTo(target.y, 2);
    expect(out.w).toBeCloseTo(target.w, 2);
  });

  it('higher beta responds faster to sudden motion', () => {
    const lowBeta = new OneEuroQuaternionFilter({ minCutoff: 1, beta: 0 });
    const highBeta = new OneEuroQuaternionFilter({ minCutoff: 1, beta: 10 });

    lowBeta.filter(IDENTITY(), 1 / 30);
    highBeta.filter(IDENTITY(), 1 / 30);

    const target = rotY90();
    const outLow = lowBeta.filter(target, 1 / 30);
    const outHigh = highBeta.filter(target, 1 / 30);

    // high beta → 截止頻率 = 1 + 10 × speed，alpha 更大，output 更接近 target
    expect(Math.abs(outHigh.y)).toBeGreaterThanOrEqual(Math.abs(outLow.y));
  });

  it('output is still a unit quaternion after filtering', () => {
    const f = new OneEuroQuaternionFilter({ minCutoff: 1, beta: 0.5 });
    const inputs = [
      IDENTITY(),
      rotY90(),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.2),
    ];
    for (const input of inputs) {
      const out = f.filter(input, 1 / 30);
      const len = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z + out.w * out.w);
      expect(len).toBeCloseTo(1, 5);
    }
  });

  it('reset restores initial state', () => {
    const f = new OneEuroQuaternionFilter();
    f.filter(IDENTITY(), 1 / 30);
    f.filter(rotY90(), 1 / 30);
    f.reset();
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
    const out = f.filter(q, 1 / 30);
    // 首次 filter 回傳 clone，應該與輸入相等
    expect(out.x).toBeCloseTo(q.x);
    expect(out.w).toBeCloseTo(q.w);
  });

  it('zero dtSec treats input as initial state', () => {
    const f = new OneEuroQuaternionFilter();
    const out = f.filter(rotY90(), 0);
    const target = rotY90();
    expect(out.y).toBeCloseTo(target.y);
    expect(out.w).toBeCloseTo(target.w);
  });
});
