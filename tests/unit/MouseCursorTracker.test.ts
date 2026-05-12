import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Mock ElectronIPC before importing the module under test
vi.mock('../../src/bridge/ElectronIPC', () => {
  return {
    ipc: {
      onCursorPosition: vi.fn(() => () => {}),
    },
  };
});

import { MouseCursorTracker } from '../../src/headtracking/MouseCursorTracker';
import { ipc } from '../../src/bridge/ElectronIPC';

describe('MouseCursorTracker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers cursor listener via ipc on construction', () => {
    new MouseCursorTracker();
    expect(ipc.onCursorPosition).toHaveBeenCalledOnce();
  });

  it('isReady() is false until cursor event arrives', () => {
    let pushCursor: ((p: { x: number; y: number }) => void) | null = null;
    (ipc.onCursorPosition as ReturnType<typeof vi.fn>).mockImplementation(
      (cb: (p: { x: number; y: number }) => void) => {
        pushCursor = cb;
        return () => {};
      },
    );
    const tracker = new MouseCursorTracker();
    expect(tracker.isReady()).toBe(false);
    pushCursor!({ x: 100, y: 200 });
    expect(tracker.isReady()).toBe(true);
    expect(tracker.getRawScreen()).toEqual({ x: 100, y: 200 });
  });

  it('first update() snaps smoothed target to desired (no lerp delay)', () => {
    const tracker = new MouseCursorTracker(10);
    const desired = new THREE.Vector3(5, 5, 5);
    const out = tracker.update(desired, 0.016);
    expect(out.x).toBeCloseTo(5);
    expect(out.y).toBeCloseTo(5);
    expect(out.z).toBeCloseTo(5);
  });

  it('subsequent update() approaches desired via exponential smoothing', () => {
    const tracker = new MouseCursorTracker(10);
    tracker.update(new THREE.Vector3(0, 0, 0), 0.016); // seed
    const out = tracker.update(new THREE.Vector3(10, 0, 0), 1.0);
    // 1s @ rate 10 → factor = 1 - exp(-10) ≈ 0.99995 → very close to 10
    expect(out.x).toBeGreaterThan(9.9);
    expect(out.x).toBeLessThanOrEqual(10);
  });

  it('forceTarget bypasses smoothing', () => {
    const tracker = new MouseCursorTracker(10);
    tracker.update(new THREE.Vector3(0, 0, 0), 0.016);
    tracker.forceTarget(new THREE.Vector3(99, 88, 77));
    const out = tracker.getSmoothedTarget();
    expect(out.x).toBe(99);
    expect(out.y).toBe(88);
    expect(out.z).toBe(77);
  });

  it('dispose() invokes unlisten', () => {
    const unlisten = vi.fn();
    (ipc.onCursorPosition as ReturnType<typeof vi.fn>).mockReturnValue(unlisten);
    const tracker = new MouseCursorTracker();
    tracker.dispose();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});
