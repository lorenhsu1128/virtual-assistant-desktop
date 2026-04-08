import { describe, it, expect } from 'vitest';
import {
  POSE,
  POSE_LANDMARK_COUNT,
  HAND,
  HAND_LANDMARK_COUNT,
  FACE,
  FACE_LANDMARK_COUNT,
} from '../../../../src/video-converter/tracking/landmarkTypes';

describe('landmarkTypes — POSE', () => {
  it('POSE 索引總數正確', () => {
    expect(POSE_LANDMARK_COUNT).toBe(33);
  });

  it('關鍵點索引符合 MediaPipe 官方規格', () => {
    expect(POSE.NOSE).toBe(0);
    expect(POSE.LEFT_SHOULDER).toBe(11);
    expect(POSE.RIGHT_SHOULDER).toBe(12);
    expect(POSE.LEFT_HIP).toBe(23);
    expect(POSE.RIGHT_HIP).toBe(24);
    expect(POSE.LEFT_ANKLE).toBe(27);
    expect(POSE.RIGHT_FOOT_INDEX).toBe(32);
  });

  it('左右側索引成對', () => {
    expect(POSE.RIGHT_SHOULDER - POSE.LEFT_SHOULDER).toBe(1);
    expect(POSE.RIGHT_ELBOW - POSE.LEFT_ELBOW).toBe(1);
    expect(POSE.RIGHT_WRIST - POSE.LEFT_WRIST).toBe(1);
    expect(POSE.RIGHT_HIP - POSE.LEFT_HIP).toBe(1);
  });

  it('所有 POSE 索引在 [0, 32]', () => {
    for (const v of Object.values(POSE)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(POSE_LANDMARK_COUNT);
    }
  });
});

describe('landmarkTypes — HAND', () => {
  it('HAND 索引總數正確', () => {
    expect(HAND_LANDMARK_COUNT).toBe(21);
  });

  it('WRIST 為 0，TIP 為各指最後', () => {
    expect(HAND.WRIST).toBe(0);
    expect(HAND.THUMB_TIP).toBe(4);
    expect(HAND.INDEX_TIP).toBe(8);
    expect(HAND.MIDDLE_TIP).toBe(12);
    expect(HAND.RING_TIP).toBe(16);
    expect(HAND.PINKY_TIP).toBe(20);
  });

  it('每根手指 4 個關節點，索引連續', () => {
    expect(HAND.THUMB_MCP - HAND.THUMB_CMC).toBe(1);
    expect(HAND.INDEX_PIP - HAND.INDEX_MCP).toBe(1);
    expect(HAND.MIDDLE_DIP - HAND.MIDDLE_PIP).toBe(1);
  });

  it('所有 HAND 索引在 [0, 20]', () => {
    for (const v of Object.values(HAND)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(HAND_LANDMARK_COUNT);
    }
  });
});

describe('landmarkTypes — FACE', () => {
  it('FACE 索引總數正確（含 iris）', () => {
    expect(FACE_LANDMARK_COUNT).toBe(478);
  });

  it('iris 索引在 face mesh 之後', () => {
    expect(FACE.LEFT_IRIS_CENTER).toBeGreaterThanOrEqual(468);
    expect(FACE.RIGHT_IRIS_CENTER).toBeGreaterThanOrEqual(468);
  });

  it('所有 FACE 索引在 [0, 477]', () => {
    for (const v of Object.values(FACE)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(FACE_LANDMARK_COUNT);
    }
  });

  it('左右眼角不衝突', () => {
    expect(FACE.LEFT_EYE_INNER_CORNER).not.toBe(FACE.RIGHT_EYE_INNER_CORNER);
    expect(FACE.LEFT_EYE_OUTER_CORNER).not.toBe(FACE.RIGHT_EYE_OUTER_CORNER);
  });
});
