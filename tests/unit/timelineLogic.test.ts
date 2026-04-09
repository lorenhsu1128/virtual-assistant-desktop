import { describe, it, expect } from 'vitest';
import {
  MIN_IN_OUT_GAP_SEC,
  timeToPixel,
  pixelToTime,
  clampInTime,
  clampOutTime,
  formatTime,
} from '../../src/mocap-studio/timelineLogic';

describe('timelineLogic', () => {
  describe('timeToPixel / pixelToTime', () => {
    it('round-trips at midpoint', () => {
      const width = 1000;
      const dur = 60;
      const t = 30;
      const px = timeToPixel(t, dur, width);
      expect(px).toBeCloseTo(500);
      expect(pixelToTime(px, dur, width)).toBeCloseTo(t);
    });

    it('timeToPixel handles start and end', () => {
      expect(timeToPixel(0, 60, 1000)).toBe(0);
      expect(timeToPixel(60, 60, 1000)).toBe(1000);
    });

    it('pixelToTime clamps to [0, duration]', () => {
      expect(pixelToTime(-10, 60, 1000)).toBe(0);
      expect(pixelToTime(2000, 60, 1000)).toBe(60);
    });

    it('timeToPixel returns 0 when duration <= 0', () => {
      expect(timeToPixel(5, 0, 1000)).toBe(0);
      expect(timeToPixel(5, -10, 1000)).toBe(0);
    });

    it('pixelToTime returns 0 when trackWidth <= 0', () => {
      expect(pixelToTime(500, 60, 0)).toBe(0);
      expect(pixelToTime(500, 60, -10)).toBe(0);
    });
  });

  describe('clampInTime', () => {
    it('clamps to >= 0', () => {
      expect(clampInTime(-1, 10)).toBe(0);
      expect(clampInTime(-999, 10)).toBe(0);
    });

    it('clamps to <= outSec - minGap', () => {
      expect(clampInTime(10, 10)).toBeCloseTo(10 - MIN_IN_OUT_GAP_SEC);
      expect(clampInTime(15, 10)).toBeCloseTo(10 - MIN_IN_OUT_GAP_SEC);
    });

    it('passes through valid values', () => {
      expect(clampInTime(3, 10)).toBe(3);
      expect(clampInTime(0, 10)).toBe(0);
    });

    it('respects custom minGap', () => {
      expect(clampInTime(10, 10, 1.0)).toBe(9);
    });

    it('returns 0 when outSec < minGap', () => {
      expect(clampInTime(5, 0.05)).toBe(0);
    });
  });

  describe('clampOutTime', () => {
    it('clamps to <= duration', () => {
      expect(clampOutTime(100, 5, 60)).toBe(60);
    });

    it('clamps to >= inSec + minGap', () => {
      expect(clampOutTime(5, 5, 60)).toBeCloseTo(5 + MIN_IN_OUT_GAP_SEC);
      expect(clampOutTime(2, 5, 60)).toBeCloseTo(5 + MIN_IN_OUT_GAP_SEC);
    });

    it('passes through valid values', () => {
      expect(clampOutTime(30, 5, 60)).toBe(30);
      expect(clampOutTime(60, 5, 60)).toBe(60);
    });

    it('respects custom minGap', () => {
      expect(clampOutTime(5, 5, 60, 1.0)).toBe(6);
    });

    it('clamps to duration even when inSec + minGap > duration', () => {
      // Edge case: in 接近尾端，out 被壓到 duration
      expect(clampOutTime(100, 59.99, 60)).toBe(60);
    });
  });

  describe('formatTime', () => {
    it('formats zero', () => {
      expect(formatTime(0)).toBe('00:00.000');
    });

    it('formats sub-second', () => {
      expect(formatTime(0.123)).toBe('00:00.123');
    });

    it('formats single-digit seconds', () => {
      expect(formatTime(7)).toBe('00:07.000');
    });

    it('formats minute crossing', () => {
      expect(formatTime(65.5)).toBe('01:05.500');
    });

    it('formats large durations past 60 minutes', () => {
      expect(formatTime(3725.001)).toBe('62:05.001');
    });

    it('treats negative values as zero', () => {
      expect(formatTime(-5)).toBe('00:00.000');
    });

    it('treats NaN as zero', () => {
      expect(formatTime(NaN)).toBe('00:00.000');
    });

    it('treats Infinity as zero', () => {
      expect(formatTime(Infinity)).toBe('00:00.000');
    });

    it('floors milliseconds (no rounding)', () => {
      expect(formatTime(1.9999)).toBe('00:01.999');
    });
  });
});
