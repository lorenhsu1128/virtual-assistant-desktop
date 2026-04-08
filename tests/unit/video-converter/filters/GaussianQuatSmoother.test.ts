import { describe, it, expect } from 'vitest';
import { GaussianQuatSmoother } from '../../../../src/video-converter/filters/GaussianQuatSmoother';
import {
  quatIdentity,
  quatFromAxisAngle,
  quatDot,
  quatNormalize,
} from '../../../../src/video-converter/math/Quat';
import type { Quat } from '../../../../src/video-converter/math/Quat';
import { v3 } from '../../../../src/video-converter/math/Vector';

describe('GaussianQuatSmoother — 全 identity 輸入', () => {
  it('輸出仍全為 identity', () => {
    const smoother = new GaussianQuatSmoother({ halfWindow: 3, sigma: 1.5 });
    const track: Quat[] = new Array(10).fill(null).map(() => quatIdentity());
    const out = smoother.smoothTrack(track);
    expect(out.length).toBe(10);
    for (const q of out) {
      expect(q.w).toBeCloseTo(1, 9);
      expect(q.x).toBeCloseTo(0, 9);
      expect(q.y).toBeCloseTo(0, 9);
      expect(q.z).toBeCloseTo(0, 9);
    }
  });
});

describe('GaussianQuatSmoother — 尖刺 90°', () => {
  it('單一尖刺被衰減（中心點更接近兩側）', () => {
    const smoother = new GaussianQuatSmoother({ halfWindow: 3, sigma: 1.0 });
    const spike = quatFromAxisAngle(v3(0, 0, 1), Math.PI / 2);
    const track: Quat[] = [
      quatIdentity(),
      quatIdentity(),
      quatIdentity(),
      spike, // 中心是尖刺
      quatIdentity(),
      quatIdentity(),
      quatIdentity(),
    ];
    const out = smoother.smoothTrack(track);
    // 中心點被相鄰的 identity 拉回，dot(out[3], identity) 應比 dot(spike, identity) 大
    const beforeDot = Math.abs(quatDot(spike, quatIdentity()));
    const afterDot = Math.abs(quatDot(out[3], quatIdentity()));
    expect(afterDot).toBeGreaterThan(beforeDot);
  });
});

describe('GaussianQuatSmoother — 線性漸變', () => {
  it('已平滑的線性漸變幾乎不變（只有微小衰減）', () => {
    const smoother = new GaussianQuatSmoother({ halfWindow: 2, sigma: 1.0 });
    const track: Quat[] = [];
    for (let i = 0; i < 11; i++) {
      track.push(quatFromAxisAngle(v3(0, 1, 0), (i / 10) * Math.PI / 2));
    }
    const out = smoother.smoothTrack(track);
    expect(out.length).toBe(11);
    // 中段每個輸出與輸入差異應很小
    for (let i = 3; i < 8; i++) {
      const d = Math.abs(quatDot(out[i], track[i]));
      expect(d).toBeGreaterThan(0.99);
    }
  });
});

describe('GaussianQuatSmoother — 邊界處理', () => {
  it('短 track（< window）也能處理', () => {
    const smoother = new GaussianQuatSmoother({ halfWindow: 5, sigma: 2.0 });
    const track = [quatIdentity(), quatFromAxisAngle(v3(1, 0, 0), 0.3)];
    const out = smoother.smoothTrack(track);
    expect(out.length).toBe(2);
    for (const q of out) {
      expect(Number.isFinite(q.w)).toBe(true);
    }
  });

  it('空 track 回傳空陣列', () => {
    expect(new GaussianQuatSmoother().smoothTrack([])).toEqual([]);
  });

  it('輸出永遠是單位四元數', () => {
    const smoother = new GaussianQuatSmoother();
    const track: Quat[] = [];
    for (let i = 0; i < 20; i++) {
      track.push(quatFromAxisAngle(v3(Math.cos(i), Math.sin(i), 0), 0.5));
    }
    const out = smoother.smoothTrack(track);
    for (const q of out) {
      const len = Math.hypot(q.x, q.y, q.z, q.w);
      expect(len).toBeCloseTo(1, 9);
    }
  });
});

describe('GaussianQuatSmoother — 與分量加權平均的差異', () => {
  it('遠離 identity 的 quat 平滑後仍保持單位長度（分量平均會破壞）', () => {
    // 兩個相距較大的 quat
    const a = quatFromAxisAngle(v3(0, 1, 0), Math.PI * 0.6);
    const b = quatFromAxisAngle(v3(0, 1, 0), Math.PI * 0.7);
    const track = [a, a, a, b, b, b];

    const smoother = new GaussianQuatSmoother({ halfWindow: 2, sigma: 1.0 });
    const out = smoother.smoothTrack(track);

    // 對照組：分量加權平均（不歸一化）
    const naive = (i: number): Quat => {
      const w = [0.4, 0.3, 0.2, 0.1];
      let acc = { x: 0, y: 0, z: 0, w: 0 };
      let totalW = 0;
      for (let k = -2; k <= 2; k++) {
        const idx = Math.max(0, Math.min(track.length - 1, i + k));
        const q = track[idx];
        const ww = w[Math.abs(k)] ?? 0.05;
        acc = { x: acc.x + q.x * ww, y: acc.y + q.y * ww, z: acc.z + q.z * ww, w: acc.w + q.w * ww };
        totalW += ww;
      }
      return { x: acc.x / totalW, y: acc.y / totalW, z: acc.z / totalW, w: acc.w / totalW };
    };

    // 我們的 slerp 結果是單位向量
    const ourLen = Math.hypot(out[2].x, out[2].y, out[2].z, out[2].w);
    expect(ourLen).toBeCloseTo(1, 9);

    // 分量加權平均後再正規化會丟失資訊（角度不對）
    const naiveQ = naive(2);
    const naiveNormalized = quatNormalize(naiveQ);
    // 兩者方向應該都接近 a/b 之間，但具體值會不同
    // 我們只要驗證 dot 不同即可
    const dotOurs = quatDot(out[2], a);
    const dotNaive = quatDot(naiveNormalized, a);
    expect(dotOurs).not.toBe(dotNaive);
  });
});

describe('GaussianQuatSmoother — setOptions', () => {
  it('變更 halfWindow / sigma 後重新平滑結果不同', () => {
    const track: Quat[] = [];
    for (let i = 0; i < 7; i++) {
      track.push(i === 3 ? quatFromAxisAngle(v3(1, 0, 0), 1) : quatIdentity());
    }
    const s = new GaussianQuatSmoother({ halfWindow: 1, sigma: 0.5 });
    const out1 = s.smoothTrack(track);
    s.setOptions({ halfWindow: 3, sigma: 2 });
    const out2 = s.smoothTrack(track);
    // 中心點平滑強度不同
    expect(quatDot(out1[3], out2[3])).not.toBe(1);
  });
});
