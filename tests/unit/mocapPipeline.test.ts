import { describe, it, expect } from 'vitest';
import { buildMocapFrames } from '../../src/mocap/pipeline';
import { generateLeftArmRaiseFixture } from '../../src/mocap/fixtures/testFixtures';
import type { SmplTrack, VrmHumanBoneName } from '../../src/mocap/types';

/** 完整 VRM bone 集合（含所有 optional） */
const FULL_BONES: Set<VrmHumanBoneName> = new Set([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'rightShoulder',
  'leftUpperArm', 'rightUpperArm',
  'leftLowerArm', 'rightLowerArm',
  'leftHand', 'rightHand',
  'leftUpperLeg', 'rightUpperLeg',
  'leftLowerLeg', 'rightLowerLeg',
  'leftFoot', 'rightFoot',
  'leftToes', 'rightToes',
]);

function isIdentityQuat(q: { x: number; y: number; z: number; w: number }, eps = 1e-3): boolean {
  return (
    Math.abs(q.x) < eps &&
    Math.abs(q.y) < eps &&
    Math.abs(q.z) < eps &&
    Math.abs(q.w - 1) < eps
  );
}

describe('buildMocapFrames', () => {
  it('returns empty array for empty track', () => {
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 0,
      frames: [],
      trans: [],
    };
    const frames = buildMocapFrames(track, FULL_BONES);
    expect(frames).toEqual([]);
  });

  it('produces correct frame count for generated fixture', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    expect(frames.length).toBe(60);
  });

  it('first frame is all-identity (rest pose before t=0.5s)', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const first = frames[0];
    for (const q of Object.values(first.boneRotations)) {
      expect(isIdentityQuat(q as never)).toBe(true);
    }
  });

  it('last frame has non-identity leftLowerArm (elbow bent)', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const last = frames[frames.length - 1];
    expect(last.boneRotations.leftLowerArm).toBeDefined();
    expect(isIdentityQuat(last.boneRotations.leftLowerArm as never)).toBe(false);
    // leftLowerArm 應該有顯著的 Z 分量（因為 fixture 是繞 Z 軸旋轉）
    expect(Math.abs((last.boneRotations.leftLowerArm as never).z)).toBeGreaterThan(0.3);
  });

  it('last frame has non-identity leftUpperArm (shoulder raised)', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES, { skipFilter: true });
    const last = frames[frames.length - 1];
    expect(last.boneRotations.leftUpperArm).toBeDefined();
    expect(isIdentityQuat(last.boneRotations.leftUpperArm as never)).toBe(false);
  });

  it('timestamps are monotonically increasing', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const frames = buildMocapFrames(track, FULL_BONES);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i].timestampMs).toBeGreaterThan(frames[i - 1].timestampMs);
    }
  });

  it('timestamp spacing matches fps', () => {
    const track = generateLeftArmRaiseFixture(30, 1.0);
    const frames = buildMocapFrames(track, FULL_BONES);
    const dt = frames[1].timestampMs - frames[0].timestampMs;
    expect(dt).toBeCloseTo(1000 / 30);
  });

  it('hipsWorldPosition reflects trans entries', () => {
    const track = generateLeftArmRaiseFixture(30, 0.5);
    // Inject translation
    track.trans[5] = [1.5, 2.5, -0.3];
    const frames = buildMocapFrames(track, FULL_BONES);
    expect(frames[5].hipsWorldPosition).toEqual({ x: 1.5, y: 2.5, z: -0.3 });
  });

  it('empty blendShapes (Phase 2c scope)', () => {
    const track = generateLeftArmRaiseFixture(30, 1.0);
    const frames = buildMocapFrames(track, FULL_BONES);
    expect(frames[0].blendShapes).toEqual({});
  });

  it('filter smooths successive frame differences', () => {
    const track = generateLeftArmRaiseFixture(30, 2.0);
    const withFilter = buildMocapFrames(
      generateLeftArmRaiseFixture(30, 2.0),
      FULL_BONES,
      { filter: { minCutoff: 0.5, beta: 0 } },
    );
    const noFilter = buildMocapFrames(track, FULL_BONES, { skipFilter: true });

    // Pick a frame in the middle of the transition (around t=1.0s, frame 30)
    const idx = 30;
    const filteredQ = withFilter[idx].boneRotations.leftLowerArm!;
    const rawQ = noFilter[idx].boneRotations.leftLowerArm!;

    // Filtered quat should lag behind raw (i.e., closer to identity than raw)
    const filteredZ = Math.abs(filteredQ.z);
    const rawZ = Math.abs(rawQ.z);
    expect(filteredZ).toBeLessThan(rawZ);
  });

  it('fallback mapping works when optional bones missing', () => {
    const withoutOptional = new Set(FULL_BONES);
    withoutOptional.delete('upperChest');
    withoutOptional.delete('leftShoulder');
    withoutOptional.delete('rightShoulder');
    withoutOptional.delete('leftToes');
    withoutOptional.delete('rightToes');

    const track = generateLeftArmRaiseFixture(30, 1.0);
    // Should not throw, and should still produce correct leftUpperArm rotation
    const frames = buildMocapFrames(track, withoutOptional);
    expect(frames.length).toBe(30);
    const last = frames[frames.length - 1];
    expect(last.boneRotations.leftUpperArm).toBeDefined();
    expect(last.boneRotations.leftLowerArm).toBeDefined();
  });

  it('skipClamp option bypasses clamp step', () => {
    // 建立一個有超範圍值的軌道
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 1,
      frames: [
        Array.from({ length: 24 }, (_, i) => (i === 0 ? [10, 0, 0] : [0, 0, 0])),
      ],
      trans: [[0, 0, 0]],
    };
    // 不 clamp → 輸入應保持為 10（pipeline 內部呼叫 axisAngleToQuaternion，
    // 雖然 quat 本身會正規化，但 track.frames[0][0][0] 不應被改動）
    buildMocapFrames(track, FULL_BONES, { skipClamp: true });
    expect(track.frames[0][0][0]).toBe(10);
  });

  it('default clamp reduces out-of-range values', () => {
    const track: SmplTrack = {
      version: 1,
      fps: 30,
      frameCount: 1,
      frames: [
        Array.from({ length: 24 }, (_, i) => (i === 0 ? [10, 0, 0] : [0, 0, 0])),
      ],
      trans: [[0, 0, 0]],
    };
    buildMocapFrames(track, FULL_BONES);
    // Default limits 是 [-π, π]
    expect(track.frames[0][0][0]).toBeLessThanOrEqual(Math.PI);
  });
});
