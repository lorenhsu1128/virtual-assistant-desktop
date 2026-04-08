import { describe, it, expect } from 'vitest';
import {
  OneEuroFilterScalar,
  OneEuroFilterQuat,
} from '../../../../src/video-converter/filters/OneEuroFilter';
import {
  quatFromAxisAngle,
  quatDot,
  quatIdentity,
} from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';

describe('OneEuroFilterScalar — 常數輸入', () => {
  it('連續餵相同值，輸出趨近該值', () => {
    const f = new OneEuroFilterScalar();
    let last = 0;
    for (let i = 0; i < 50; i++) {
      last = f.filter(5.0, i * 33);
    }
    expect(last).toBeCloseTo(5.0, 6);
  });

  it('第一次呼叫直接回傳原值', () => {
    const f = new OneEuroFilterScalar();
    expect(f.filter(42, 0)).toBe(42);
  });
});

describe('OneEuroFilterScalar — 高頻雜訊', () => {
  it('方波雜訊被衰減（變化幅度減小）', () => {
    const f = new OneEuroFilterScalar({ minCutoff: 1, beta: 0.001 });
    const inputs: number[] = [];
    const outputs: number[] = [];
    for (let i = 0; i < 60; i++) {
      const x = i % 2 === 0 ? 1 : -1; // 方波 ±1
      inputs.push(x);
      outputs.push(f.filter(x, i * 33));
    }
    // 後半段輸入振幅 ≈ 2，輸出振幅應顯著小於輸入
    const tail = outputs.slice(40);
    const tailRange = Math.max(...tail) - Math.min(...tail);
    expect(tailRange).toBeLessThan(1.5);
  });
});

describe('OneEuroFilterScalar — 緩慢漸變', () => {
  it('漸變信號能追上（最終誤差小）', () => {
    const f = new OneEuroFilterScalar({ minCutoff: 1, beta: 0.5 });
    let last = 0;
    for (let i = 0; i < 100; i++) {
      const target = i * 0.1;
      last = f.filter(target, i * 33);
    }
    // 期望追到接近 9.9
    expect(last).toBeGreaterThan(8.0);
  });
});

describe('OneEuroFilterScalar — reset', () => {
  it('reset 後第一次呼叫又直接回傳原值', () => {
    const f = new OneEuroFilterScalar();
    f.filter(10, 0);
    f.filter(20, 33);
    f.reset();
    expect(f.filter(99, 100)).toBe(99);
  });
});

describe('OneEuroFilterQuat', () => {
  it('連續餵相同 quat，輸出趨近該 quat', () => {
    const f = new OneEuroFilterQuat();
    const target = quatFromAxisAngle(v3(0, 1, 0), Math.PI / 4);
    let last = quatIdentity();
    for (let i = 0; i < 50; i++) {
      last = f.filter(target, i * 33);
    }
    // dot 接近 1（同方向）
    expect(quatDot(last, target)).toBeCloseTo(1, 5);
  });

  it('輸出永遠是單位四元數', () => {
    const f = new OneEuroFilterQuat();
    const a = quatFromAxisAngle(v3(1, 0, 0), 0.5);
    const b = quatFromAxisAngle(v3(0, 1, 0), 0.5);
    let last = a;
    for (let i = 0; i < 30; i++) {
      const input = i % 2 === 0 ? a : b;
      last = f.filter(input, i * 33);
      const len = Math.hypot(last.x, last.y, last.z, last.w);
      expect(len).toBeCloseTo(1, 9);
    }
  });

  it('翻號的等價 quat 不會造成震盪（最短路徑保護）', () => {
    const f = new OneEuroFilterQuat();
    const a = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 4);
    const negA = { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
    const sequence = [a, negA, a, negA, a, negA, a, negA];
    let last = a;
    for (let i = 0; i < sequence.length; i++) {
      last = f.filter(sequence[i], i * 33);
    }
    // 應趨近 a（或 -a，等價），dot 絕對值接近 1
    expect(Math.abs(quatDot(last, a))).toBeGreaterThan(0.95);
  });
});
