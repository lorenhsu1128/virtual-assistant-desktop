import { describe, it, expect } from 'vitest';
import { CinematicRunner, solveFinalPose, solveTopMiddle } from '../../src/cinematic/CinematicRunner';
import type { CinematicConfig, CinematicPhase } from '../../src/types/cinematic';

function makeConfig(overrides?: Partial<CinematicConfig>): CinematicConfig {
  return {
    screenWidth: 1920,
    screenHeight: 1080,
    characterWidth: 300,
    characterHeight: 500,
    originalPosition: { x: 800, y: 600 },
    originalScale: 1.0,
    availableExpressions: ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'],
    desiredMaxScale: 6.0,
    ...overrides,
  };
}

/** Helper：從目前狀態快速跑到指定 phase 的結尾 */
function runUntilPhase(runner: CinematicRunner, target: CinematicPhase, maxSteps = 10000): void {
  for (let i = 0; i < maxSteps; i++) {
    const frame = runner.tick(0.016);
    if (frame.phase === target) return;
  }
  throw new Error(`Did not reach phase ${target} within ${maxSteps} steps`);
}

describe('solveFinalPose', () => {
  const baseArgs = [1920, 1080, 300, 500, 1.0, 6.0, 0.22, 24, 16, 0.7] as const;

  it('returns the desired max scale on a large screen', () => {
    const result = solveFinalPose(...baseArgs);
    // 大螢幕應該能塞下 6x scale
    expect(result.maxScale).toBeGreaterThan(0);
    expect(result.maxScale).toBeLessThanOrEqual(6.0);
  });

  it('keeps head top in lower half (>= screenHeight / 2)', () => {
    const result = solveFinalPose(...baseArgs);
    const visualHeight = 500 * (result.maxScale / 1.0);
    const headTop = result.finalPosY - visualHeight;
    expect(headTop).toBeGreaterThanOrEqual(1080 / 2 - 0.001);
  });

  it('keeps face bottom within screen (<= screenHeight - bottomPadding)', () => {
    const result = solveFinalPose(...baseArgs);
    const visualHeight = 500 * (result.maxScale / 1.0);
    const headTop = result.finalPosY - visualHeight;
    const faceBottom = headTop + visualHeight * 0.22;
    expect(faceBottom).toBeLessThanOrEqual(1080 - 16 + 0.001);
  });

  it('places face center in lower half (between center and bottom)', () => {
    const result = solveFinalPose(...baseArgs);
    const visualHeight = 500 * (result.maxScale / 1.0);
    const headTop = result.finalPosY - visualHeight;
    const faceCenter = headTop + visualHeight * 0.22 / 2;
    expect(faceCenter).toBeGreaterThan(1080 / 2);
    expect(faceCenter).toBeLessThan(1080);
  });

  it('clamps maxScale on a small screen', () => {
    // 小螢幕 + 大角色 → 應該降 scale
    const result = solveFinalPose(800, 600, 200, 400, 1.0, 6.0, 0.22, 24, 16, 0.7);
    expect(result.maxScale).toBeLessThan(6.0);
  });

  it('finalPosX places character horizontally centered', () => {
    const result = solveFinalPose(...baseArgs);
    expect(result.finalPosX).toBe(1920 / 2 - 300 / 2);
  });

  it('handles tiny screen without NaN', () => {
    const result = solveFinalPose(640, 480, 200, 400, 1.0, 6.0, 0.22, 24, 16, 0.7);
    expect(Number.isFinite(result.maxScale)).toBe(true);
    expect(Number.isFinite(result.finalPosY)).toBe(true);
    expect(result.maxScale).toBeGreaterThan(0);
  });

  it('respects originalScale != 1.0', () => {
    // originalScale = 2.0 → 視覺尺寸已是 base × 2
    const result = solveFinalPose(1920, 1080, 300, 500, 2.0, 6.0, 0.22, 24, 16, 0.7);
    expect(result.maxScale).toBeGreaterThan(0);
    expect(result.maxScale).toBeLessThanOrEqual(6.0);
  });
});

describe('solveTopMiddle', () => {
  it('places character horizontally centered', () => {
    const result = solveTopMiddle(1920, 300, 500, 1.0, 1.4, 24);
    expect(result.x).toBe(1920 / 2 - 300 / 2);
  });

  it('places foot below top padding by approachScale*characterHeight', () => {
    const result = solveTopMiddle(1920, 300, 500, 1.0, 1.4, 24);
    // visualHeight = 500 × 1.4 = 700, foot = 24 + 700 = 724
    expect(result.y).toBeCloseTo(724, 0);
  });

  it('respects originalScale', () => {
    const result = solveTopMiddle(1920, 300, 500, 2.0, 1.4, 24);
    // visualHeight = 500 × (1.4/2.0) = 350, foot = 24 + 350 = 374
    expect(result.y).toBeCloseTo(374, 0);
  });
});

describe('CinematicRunner — phase transitions', () => {
  it('starts in anticipate phase', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame = runner.tick(0.001);
    expect(frame.phase).toBe('anticipate');
    expect(runner.isFinished()).toBe(false);
  });

  it('progresses through all phases in order', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    const seen = new Set<CinematicPhase>();
    for (let i = 0; i < 1000; i++) {
      const frame = runner.tick(0.05);
      seen.add(frame.phase);
      if (frame.phase === 'done') break;
    }
    expect(seen.has('anticipate')).toBe(true);
    expect(seen.has('approach-top')).toBe(true);
    expect(seen.has('pause-top')).toBe(true);
    expect(seen.has('dash-down')).toBe(true);
    expect(seen.has('impact')).toBe(true);
    expect(seen.has('settle')).toBe(true);
    expect(seen.has('hold')).toBe(true);
    expect(seen.has('recoil')).toBe(true);
    expect(seen.has('retreat')).toBe(true);
    expect(seen.has('done')).toBe(true);
  });

  it('finishes after all phases', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    for (let i = 0; i < 2000; i++) {
      runner.tick(0.05);
      if (runner.isFinished()) break;
    }
    expect(runner.isFinished()).toBe(true);
  });
});

describe('CinematicRunner — anticipate phase', () => {
  it('stays at start position', () => {
    const config = makeConfig({ originalPosition: { x: 400, y: 300 } });
    const runner = new CinematicRunner(config);
    const frame = runner.tick(0.1);
    expect(frame.positionX).toBeCloseTo(400, 0);
    expect(frame.positionY).toBeCloseTo(300, 0);
    expect(frame.phase).toBe('anticipate');
  });

  it('squashes Y briefly (< startScale)', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame = runner.tick(0.25); // mid anticipate
    expect(frame.scaleY).toBeLessThan(1.0);
  });

  it('has no walk during anticipate', () => {
    const runner = new CinematicRunner(makeConfig());
    const frame = runner.tick(0.1);
    expect(frame.walkSpeed).toBe(0);
  });
});

describe('CinematicRunner — approach-top phase', () => {
  it('moves toward top-middle position', () => {
    const config = makeConfig({ originalPosition: { x: 100, y: 900 } });
    const runner = new CinematicRunner(config);
    runUntilPhase(runner, 'approach-top');
    const top = runner.getTopMiddlePosition();
    // 跑一段時間後位置應該移向 top-middle
    let lastY = 0;
    for (let i = 0; i < 30; i++) {
      const frame = runner.tick(0.033);
      if (frame.phase !== 'approach-top') break;
      lastY = frame.positionY;
    }
    // Y 應該往 topMiddleY 接近（topMiddleY 較小，900 → 較小）
    expect(lastY).toBeLessThan(900);
    expect(top.x).toBeGreaterThan(0);
  });

  it('has walk speed > 0', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'approach-top');
    const frame = runner.tick(0.1);
    expect(frame.walkSpeed).toBeGreaterThan(0);
  });
});

describe('CinematicRunner — dash-down phase', () => {
  it('scale grows toward maxScale', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'dash-down');
    const f1 = runner.tick(0.1);
    const f2 = runner.tick(0.3);
    expect(f2.scaleY).toBeGreaterThan(f1.scaleY);
  });

  it('camera zoom increases', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'dash-down');
    const f1 = runner.tick(0.05);
    const f2 = runner.tick(0.4);
    expect(f2.cameraZoom).toBeGreaterThan(f1.cameraZoom);
  });

  it('walk speed is fast (>= dash speed)', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'dash-down');
    const frame = runner.tick(0.1);
    expect(frame.walkSpeed).toBeGreaterThanOrEqual(2.0);
  });
});

describe('CinematicRunner — impact phase', () => {
  it('produces non-zero camera shake', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'impact');
    const frame = runner.tick(0.02);
    // 至少 X 或 Y 有 shake
    const totalShake = Math.abs(frame.cameraShakeX) + Math.abs(frame.cameraShakeY);
    expect(totalShake).toBeGreaterThan(0);
  });

  it('produces non-uniform scale (squash X != Y)', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'impact');
    const frame = runner.tick(0.08); // mid impact
    expect(frame.scaleX).not.toBe(frame.scaleY);
  });

  it('triggers springBoneReset on first impact frame', () => {
    const runner = new CinematicRunner(makeConfig());
    // 手動推進，捕捉 phase 從非 impact 變為 impact 的第一幀
    let firstImpactFrame = null;
    let prevPhase: CinematicPhase = 'anticipate';
    for (let i = 0; i < 1000; i++) {
      const frame = runner.tick(0.016);
      if (frame.phase === 'impact' && prevPhase !== 'impact') {
        firstImpactFrame = frame;
        break;
      }
      prevPhase = frame.phase;
    }
    expect(firstImpactFrame).not.toBeNull();
    expect(firstImpactFrame!.springBoneReset).toBe(true);
  });
});

describe('CinematicRunner — hold phase expressions', () => {
  it('cycles through all available expressions', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'hold');
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const frame = runner.tick(0.05);
      if (frame.expression) seen.add(frame.expression);
      if (frame.phase !== 'hold') break;
    }
    expect(seen.size).toBe(6);
  });

  it('handles empty expression list without error', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'hold');
    const frame = runner.tick(0.1);
    expect(frame.expression).toBeNull();
  });

  it('has zero walk speed', () => {
    const runner = new CinematicRunner(makeConfig());
    runUntilPhase(runner, 'hold');
    const frame = runner.tick(0.1);
    expect(frame.walkSpeed).toBe(0);
  });
});

describe('CinematicRunner — retreat phase', () => {
  it('reverses facing near the end', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'retreat');
    // 跑過轉身時間（retreat 前 30% 轉身 = 0.45s）
    runner.tick(0.5);
    const frame = runner.tick(0.1);
    expect(frame.facingRotationY).toBeCloseTo(Math.PI, 1);
  });

  it('moves back toward start position', () => {
    const config = makeConfig({
      originalPosition: { x: 100, y: 900 },
      availableExpressions: [],
    });
    const runner = new CinematicRunner(config);
    runUntilPhase(runner, 'retreat');
    const f1 = runner.tick(0.1);
    const f2 = runner.tick(0.5);
    // 應該往 startX = 100 移動
    expect(Math.abs(f2.positionX - 100)).toBeLessThan(Math.abs(f1.positionX - 100));
  });
});

describe('CinematicRunner — facing rotation transitions', () => {
  it('anticipate faces camera (rotation 0)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    const frame = runner.tick(0.1);
    expect(frame.phase).toBe('anticipate');
    expect(frame.facingRotationY).toBe(0);
  });

  it('approach-top turns back to camera over time (0 → π)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'approach-top');
    // 追蹤 rotation 隨時間遞增
    const f1 = runner.tick(0.05);
    const f2 = runner.tick(0.5);
    expect(f2.facingRotationY).toBeGreaterThan(f1.facingRotationY);
    // 到尾端應該接近 π
    runner.tick(0.5);
    // 已在 pause-top 或 approach-top 尾段
  });

  it('approach-top ends with back to camera (rotation close to π)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'approach-top');
    // approach-top 總長 1s，前 60% 完成轉身 → 0.6s 後應該 ≈ π
    const frame = runner.tick(0.7);
    expect(frame.facingRotationY).toBeCloseTo(Math.PI, 1);
  });

  it('pause-top turns to face camera (π → 0)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'pause-top');
    const f1 = runner.tick(0.01);
    // pause-top 總長 0.25s，結尾應該 ≈ 0
    const f2 = runner.tick(0.24);
    expect(f1.facingRotationY).toBeGreaterThan(f2.facingRotationY);
    expect(f2.facingRotationY).toBeLessThan(0.5);
  });

  it('dash-down faces camera (rotation 0)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'dash-down');
    const frame = runner.tick(0.1);
    expect(frame.facingRotationY).toBe(0);
  });

  it('hold faces camera (rotation 0)', () => {
    const runner = new CinematicRunner(makeConfig({ availableExpressions: [] }));
    runUntilPhase(runner, 'hold');
    const frame = runner.tick(0.1);
    expect(frame.facingRotationY).toBe(0);
  });
});

describe('CinematicRunner — done frame', () => {
  it('restores original position and scale', () => {
    const config = makeConfig({
      originalPosition: { x: 123, y: 456 },
      originalScale: 1.5,
      availableExpressions: [],
    });
    const runner = new CinematicRunner(config);
    for (let i = 0; i < 2000; i++) {
      runner.tick(0.05);
      if (runner.isFinished()) break;
    }
    const frame = runner.tick(0.016);
    expect(frame.positionX).toBe(123);
    expect(frame.positionY).toBe(456);
    expect(frame.scaleX).toBe(1.5);
    expect(frame.scaleY).toBe(1.5);
    expect(frame.facingRotationY).toBe(0);
    expect(frame.cameraZoom).toBe(1.0);
  });
});

describe('CinematicRunner — public getters', () => {
  it('exposes maxScale', () => {
    const runner = new CinematicRunner(makeConfig());
    expect(runner.getMaxScale()).toBeGreaterThan(0);
  });

  it('exposes final and top-middle positions', () => {
    const runner = new CinematicRunner(makeConfig());
    const finalPos = runner.getFinalPosition();
    const topPos = runner.getTopMiddlePosition();
    expect(finalPos.x).toBeGreaterThan(0);
    expect(finalPos.y).toBeGreaterThan(0);
    expect(topPos.x).toBeGreaterThan(0);
    // top-middle 應該在 final 之上
    expect(topPos.y).toBeLessThan(finalPos.y);
  });
});
