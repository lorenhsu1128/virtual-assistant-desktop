import { describe, it, expect, vi } from 'vitest';
import { drawSkeleton, filterVisibleLandmarks } from '../../src/mocap/mediapipe/SkeletonDrawer';
import { POSE_CONNECTIONS, POSE_LANDMARK_COUNT } from '../../src/mocap/mediapipe/types';
import type { PoseLandmark, PoseLandmarks } from '../../src/mocap/mediapipe/types';

/** 建立 33 個全可見的 landmark，位置從 (0.1, 0.1) 到 (0.9, 0.9) 漸變 */
function makeFullVisibleLandmarks(visibility = 1.0): PoseLandmark[] {
  return Array.from({ length: POSE_LANDMARK_COUNT }, (_, i) => ({
    x: 0.1 + (i / POSE_LANDMARK_COUNT) * 0.8,
    y: 0.1 + (i / POSE_LANDMARK_COUNT) * 0.8,
    z: 0,
    visibility,
  }));
}

/** 建立一個可記錄呼叫的 mock CanvasRenderingContext2D */
function makeMockContext() {
  return {
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    fillStyle: '',
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
}

describe('drawSkeleton', () => {
  it('draws POSE_CONNECTIONS strokes and 33 points when all visible', () => {
    const ctx = makeMockContext();
    const landmarks: PoseLandmarks = {
      image: makeFullVisibleLandmarks(1.0),
      world: [],
    };
    drawSkeleton(
      ctx as unknown as CanvasRenderingContext2D,
      landmarks,
      800,
      600,
    );

    // Each connection → one stroke call
    expect(ctx.stroke).toHaveBeenCalledTimes(POSE_CONNECTIONS.length);
    // Each landmark → one arc call (with full visibility)
    expect(ctx.arc).toHaveBeenCalledTimes(POSE_LANDMARK_COUNT);
    // Each point → one fill call
    expect(ctx.fill).toHaveBeenCalledTimes(POSE_LANDMARK_COUNT);
  });

  it('skips points with visibility below threshold', () => {
    const ctx = makeMockContext();
    const image = makeFullVisibleLandmarks(1.0);
    // 把一半的點設為 visibility 0
    for (let i = 0; i < 15; i++) image[i].visibility = 0;
    const landmarks: PoseLandmarks = { image, world: [] };

    drawSkeleton(
      ctx as unknown as CanvasRenderingContext2D,
      landmarks,
      800,
      600,
      { visibilityThreshold: 0.5 },
    );

    // 只剩 18 個可見點
    expect(ctx.arc).toHaveBeenCalledTimes(POSE_LANDMARK_COUNT - 15);
  });

  it('skips connections where either endpoint is invisible', () => {
    const ctx = makeMockContext();
    const image = makeFullVisibleLandmarks(1.0);
    // 把 landmark 0 設為不可見
    image[0].visibility = 0;
    const landmarks: PoseLandmarks = { image, world: [] };

    drawSkeleton(
      ctx as unknown as CanvasRenderingContext2D,
      landmarks,
      800,
      600,
    );

    // 所有以 landmark 0 為端點的連線應該被跳過
    const connectionsWith0 = POSE_CONNECTIONS.filter(([a, b]) => a === 0 || b === 0).length;
    expect(ctx.stroke).toHaveBeenCalledTimes(POSE_CONNECTIONS.length - connectionsWith0);
  });

  it('converts normalized coordinates to pixel positions', () => {
    const ctx = makeMockContext();
    const image: PoseLandmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => ({
      x: 0.5,
      y: 0.25,
      z: 0,
      visibility: 1,
    }));
    const landmarks: PoseLandmarks = { image, world: [] };

    drawSkeleton(
      ctx as unknown as CanvasRenderingContext2D,
      landmarks,
      1000,
      800,
    );

    // 第一個 arc 呼叫：center (0.5 * 1000, 0.25 * 800) = (500, 200)
    expect(ctx.arc).toHaveBeenCalledWith(500, 200, 4, 0, Math.PI * 2);
  });

  it('respects custom line/point styles', () => {
    const ctx = makeMockContext();
    const landmarks: PoseLandmarks = {
      image: makeFullVisibleLandmarks(1.0),
      world: [],
    };

    drawSkeleton(
      ctx as unknown as CanvasRenderingContext2D,
      landmarks,
      800,
      600,
      {
        lineColor: '#ff0000',
        lineWidth: 5,
        pointColor: '#00ff00',
        pointRadius: 10,
      },
    );

    expect(ctx.strokeStyle).toBe('#ff0000');
    expect(ctx.lineWidth).toBe(5);
    expect(ctx.fillStyle).toBe('#00ff00');
    // Check arc was called with radius 10
    const firstArcCall = ctx.arc.mock.calls[0];
    expect(firstArcCall[2]).toBe(10);
  });

  it('handles empty landmarks gracefully', () => {
    const ctx = makeMockContext();
    const landmarks: PoseLandmarks = { image: [], world: [] };

    expect(() => {
      drawSkeleton(
        ctx as unknown as CanvasRenderingContext2D,
        landmarks,
        800,
        600,
      );
    }).not.toThrow();
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
  });
});

describe('filterVisibleLandmarks', () => {
  it('keeps only landmarks above threshold', () => {
    const image: PoseLandmark[] = [
      { x: 0, y: 0, z: 0, visibility: 0.9 },
      { x: 0, y: 0, z: 0, visibility: 0.3 },
      { x: 0, y: 0, z: 0, visibility: 0.5 },
      { x: 0, y: 0, z: 0, visibility: 0.1 },
    ];
    const filtered = filterVisibleLandmarks(image, 0.5);
    expect(filtered.length).toBe(2);
  });

  it('default threshold is 0.5', () => {
    const image: PoseLandmark[] = [
      { x: 0, y: 0, z: 0, visibility: 0.6 },
      { x: 0, y: 0, z: 0, visibility: 0.4 },
    ];
    const filtered = filterVisibleLandmarks(image);
    expect(filtered.length).toBe(1);
  });
});

describe('POSE_CONNECTIONS integrity', () => {
  it('all indices are within [0, 32]', () => {
    for (const [a, b] of POSE_CONNECTIONS) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(POSE_LANDMARK_COUNT);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(POSE_LANDMARK_COUNT);
    }
  });

  it('has a non-trivial number of connections', () => {
    expect(POSE_CONNECTIONS.length).toBeGreaterThan(20);
  });
});
