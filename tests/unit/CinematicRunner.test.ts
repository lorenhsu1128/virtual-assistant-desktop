import { describe, it, expect } from 'vitest';
import {
  CinematicRunner,
  solveFinalPose,
  topMiddleVisualHeadY,
  positionForVisualHead,
} from '../../src/cinematic/CinematicRunner';
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

  it('returns positive max scale', () => {
    const result = solveFinalPose(...baseArgs);
    expect(result.maxScale).toBeGreaterThan(0);
    expect(result.maxScale).toBeLessThanOrEqual(6.0);
  });

  it('finalVisualHeadY is in lower half (>= screenHeight / 2)', () => {
    const result = solveFinalPose(...baseArgs);
    expect(result.finalVisualHeadY).toBeGreaterThanOrEqual(1080 / 2 - 0.001);
  });

  it('keeps face bottom within screen (<= screenHeight - bottomPadding)', () => {
    const result = solveFinalPose(...baseArgs);
    const visualHeight = 500 * (result.maxScale / 1.0);
    const faceBottom = result.finalVisualHeadY + visualHeight * 0.22;
    expect(faceBottom).toBeLessThanOrEqual(1080 - 16 + 0.001);
  });

  it('places face center in lower half (between center and bottom)', () => {
    const result = solveFinalPose(...baseArgs);
    const visualHeight = 500 * (result.maxScale / 1.0);
    const faceCenter = result.finalVisualHeadY + (visualHeight * 0.22) / 2;
    expect(faceCenter).toBeGreaterThan(1080 / 2);
    expect(faceCenter).toBeLessThan(1080);
  });

  it('clamps maxScale on a small screen', () => {
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
    expect(Number.isFinite(result.finalVisualHeadY)).toBe(true);
    expect(result.maxScale).toBeGreaterThan(0);
  });
});

describe('topMiddleVisualHeadY', () => {
  it('returns topPadding directly', () => {
    expect(topMiddleVisualHeadY(24)).toBe(24);
    expect(topMiddleVisualHeadY(0)).toBe(0);
  });
});

describe('positionForVisualHead', () => {
  it('at scale=originalScale, returns visualHeadY directly', () => {
    expect(positionForVisualHead(500, 1.0, 378, 1.0)).toBe(500);
    expect(positionForVisualHead(100, 2.0, 378, 2.0)).toBe(100);
  });

  it('at higher scale, shifts down to keep visual head at target', () => {
    // 1080p, characterHeight 378, scale 6, originalScale 1
    // currentPos.y = visualHeadY + 378 × 5 = visualHeadY + 1890
    expect(positionForVisualHead(540, 6.0, 378, 1.0)).toBeCloseTo(540 + 1890, 1);
  });

  it('handles fractional scale ratios', () => {
    // scale 1.5, originalScale 1 → ratio − 1 = 0.5
    expect(positionForVisualHead(100, 1.5, 400, 1.0)).toBe(100 + 200);
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
    const top = runner.getTopMiddleVisualHead();
    let lastY = 0;
    for (let i = 0; i < 30; i++) {
      const frame = runner.tick(0.033);
      if (frame.phase !== 'approach-top') break;
      lastY = frame.positionY;
    }
    // Y 應該往較小的值靠近（角色往螢幕頂部跑）
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

  it('exposes final and top-middle visual head positions', () => {
    const runner = new CinematicRunner(makeConfig());
    const finalHead = runner.getFinalVisualHead();
    const topHead = runner.getTopMiddleVisualHead();
    expect(finalHead.x).toBeGreaterThan(0);
    expect(finalHead.y).toBeGreaterThan(0);
    expect(topHead.x).toBeGreaterThan(0);
    // top-middle 視覺頭頂應該在 final 之上（Y 較小）
    expect(topHead.y).toBeLessThan(finalHead.y);
  });
});

describe('CinematicRunner — visual head position correctness', () => {
  it('approach-top final visual head Y matches topPadding', () => {
    const runner = new CinematicRunner(makeConfig({ topPadding: 24 }));
    runUntilPhase(runner, 'pause-top');
    // pause-top 第一幀代表 approach-top 結束的位置
    // 透過反推：positionY − characterHeight × (scale/orig − 1) = visualHeadY
    const config = makeConfig({ topPadding: 24 });
    const frame = runner.tick(0.001);
    const visualHeadY =
      frame.positionY - config.characterHeight * (frame.scaleY / config.originalScale - 1);
    expect(visualHeadY).toBeCloseTo(24, 0);
  });

  it('hold visual head Y is in lower half of screen', () => {
    const config = makeConfig();
    const runner = new CinematicRunner(config);
    runUntilPhase(runner, 'hold');
    const frame = runner.tick(0.001);
    // 反推 visual head Y
    const visualHeadY =
      frame.positionY - config.characterHeight * (frame.scaleY / config.originalScale - 1);
    expect(visualHeadY).toBeGreaterThanOrEqual(config.screenHeight / 2 - 0.5);
  });

  it('hold face bottom does not exceed screen bottom', () => {
    const config = makeConfig();
    const runner = new CinematicRunner(config);
    runUntilPhase(runner, 'hold');
    const frame = runner.tick(0.001);
    const visualHeadY =
      frame.positionY - config.characterHeight * (frame.scaleY / config.originalScale - 1);
    const visualHeight = config.characterHeight * (frame.scaleY / config.originalScale);
    const faceBottom = visualHeadY + visualHeight * 0.22;
    expect(faceBottom).toBeLessThanOrEqual(config.screenHeight - 16 + 0.5);
  });

  it('approach-top character actually moves up (visual head Y decreases)', () => {
    const config = makeConfig({ originalPosition: { x: 100, y: 900 } });
    const runner = new CinematicRunner(config);
    runUntilPhase(runner, 'approach-top');
    const f1 = runner.tick(0.05);
    const f2 = runner.tick(0.5);
    const head1 =
      f1.positionY - config.characterHeight * (f1.scaleY / config.originalScale - 1);
    const head2 =
      f2.positionY - config.characterHeight * (f2.scaleY / config.originalScale - 1);
    // 視覺頭頂應該往螢幕頂部移動（Y 較小）
    expect(head2).toBeLessThan(head1);
  });
});
