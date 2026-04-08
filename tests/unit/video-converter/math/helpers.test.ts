import { describe, it, expect } from 'vitest';
import {
  clamp,
  lerp,
  remap,
  degToRad,
  radToDeg,
  gaussianWeight,
  DEG2RAD,
  RAD2DEG,
} from '../../../../src/video-converter/math/helpers';

describe('helpers', () => {
  describe('clamp', () => {
    it('returns value when within range', () => {
      expect(clamp(5, 0, 10)).toBe(5);
    });
    it('clamps to lower bound', () => {
      expect(clamp(-3, 0, 10)).toBe(0);
    });
    it('clamps to upper bound', () => {
      expect(clamp(15, 0, 10)).toBe(10);
    });
    it('handles equal bounds', () => {
      expect(clamp(5, 3, 3)).toBe(3);
    });
  });

  describe('lerp', () => {
    it('returns a at t=0', () => {
      expect(lerp(2, 8, 0)).toBe(2);
    });
    it('returns b at t=1', () => {
      expect(lerp(2, 8, 1)).toBe(8);
    });
    it('returns midpoint at t=0.5', () => {
      expect(lerp(2, 8, 0.5)).toBe(5);
    });
    it('extrapolates outside [0,1]', () => {
      expect(lerp(0, 10, 1.5)).toBe(15);
      expect(lerp(0, 10, -0.5)).toBe(-5);
    });
  });

  describe('remap', () => {
    it('maps midpoint correctly', () => {
      expect(remap(5, 0, 10, 100, 200)).toBe(150);
    });
    it('maps endpoints', () => {
      expect(remap(0, 0, 10, 100, 200)).toBe(100);
      expect(remap(10, 0, 10, 100, 200)).toBe(200);
    });
    it('handles inverted target range', () => {
      expect(remap(2, 0, 10, 100, 0)).toBe(80);
    });
    it('returns toLo when source range is degenerate', () => {
      expect(remap(5, 5, 5, 100, 200)).toBe(100);
    });
  });

  describe('degToRad / radToDeg', () => {
    it('round-trips 0', () => {
      expect(radToDeg(degToRad(0))).toBeCloseTo(0, 10);
    });
    it('round-trips 90', () => {
      expect(radToDeg(degToRad(90))).toBeCloseTo(90, 10);
    });
    it('180 degrees = π radians', () => {
      expect(degToRad(180)).toBeCloseTo(Math.PI, 10);
    });
    it('constants are consistent', () => {
      expect(DEG2RAD * RAD2DEG).toBeCloseTo(1, 12);
    });
  });

  describe('gaussianWeight', () => {
    it('peaks at distance 0', () => {
      expect(gaussianWeight(0, 1)).toBe(1);
    });
    it('decreases with distance', () => {
      expect(gaussianWeight(1, 1)).toBeLessThan(gaussianWeight(0, 1));
      expect(gaussianWeight(2, 1)).toBeLessThan(gaussianWeight(1, 1));
    });
    it('symmetric in sign', () => {
      expect(gaussianWeight(2, 1)).toBeCloseTo(gaussianWeight(-2, 1), 12);
    });
    it('exact value at d=σ', () => {
      // exp(-1/2) ≈ 0.6065
      expect(gaussianWeight(1, 1)).toBeCloseTo(Math.exp(-0.5), 10);
    });
    it('handles zero sigma gracefully', () => {
      expect(gaussianWeight(0, 0)).toBe(1);
      expect(gaussianWeight(1, 0)).toBe(0);
    });
  });
});
