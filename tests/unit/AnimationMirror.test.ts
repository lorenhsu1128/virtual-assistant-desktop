import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { mirrorAnimationClip, type BoneMapping } from '../../src/animation/AnimationMirror';

/** 建立測試用 BoneMapping（node name = bone name，方便對照） */
function createTestBoneMapping(boneNames: string[]): BoneMapping {
  const nodeNameToBone = new Map<string, string>();
  const boneToNodeName = new Map<string, string>();
  for (const name of boneNames) {
    // 用 "Node_{boneName}" 作為 node name 以便區分
    const nodeName = `Node_${name}`;
    nodeNameToBone.set(nodeName, name);
    boneToNodeName.set(name, nodeName);
  }
  return { nodeNameToBone, boneToNodeName };
}

/** 建立 QuaternionKeyframeTrack */
function quatTrack(nodeName: string, times: number[], values: number[]): THREE.QuaternionKeyframeTrack {
  return new THREE.QuaternionKeyframeTrack(
    `${nodeName}.quaternion`,
    new Float32Array(times),
    new Float32Array(values),
  );
}

/** 建立 VectorKeyframeTrack (position) */
function posTrack(nodeName: string, times: number[], values: number[]): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    `${nodeName}.position`,
    new Float32Array(times),
    new Float32Array(values),
  );
}

/** 建立 NumberKeyframeTrack (expression/morph) */
function numTrack(name: string, times: number[], values: number[]): THREE.NumberKeyframeTrack {
  return new THREE.NumberKeyframeTrack(
    name,
    new Float32Array(times),
    new Float32Array(values),
  );
}

/** 建立 AnimationClip */
function makeClip(name: string, tracks: THREE.KeyframeTrack[]): THREE.AnimationClip {
  return new THREE.AnimationClip(name, -1, tracks);
}

/** 比較 Float32Array，允許浮點誤差 */
function expectArrayClose(actual: ArrayLike<number>, expected: number[], _epsilon = 1e-6): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
}

describe('AnimationMirror', () => {
  describe('center bone quaternion mirror', () => {
    it('should mirror quaternion values: (x, -y, -z, w)', () => {
      const mapping = createTestBoneMapping(['hips', 'spine']);
      const clip = makeClip('test', [
        quatTrack('Node_hips', [0, 1], [
          0.1, 0.5, 0.3, 0.8,   // frame 0
          0.2, -0.4, 0.6, 0.7,  // frame 1
        ]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      const track = mirrored.tracks.find((t) => t.name === 'Node_hips.quaternion')!;

      expectArrayClose(track.values, [
        0.1, -0.5, -0.3, 0.8,   // frame 0: y,z negated
        0.2, 0.4, -0.6, 0.7,    // frame 1: y,z negated
      ]);
    });

    it('should mirror hips translation: (-x, y, z)', () => {
      const mapping = createTestBoneMapping(['hips']);
      const clip = makeClip('test', [
        posTrack('Node_hips', [0, 1], [
          1.5, 2.0, 3.0,   // frame 0
          -0.5, 1.0, 0.0,  // frame 1
        ]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      const track = mirrored.tracks.find((t) => t.name === 'Node_hips.position')!;

      expectArrayClose(track.values, [
        -1.5, 2.0, 3.0,  // frame 0: x negated
        0.5, 1.0, 0.0,   // frame 1: x negated
      ]);
    });
  });

  describe('paired bone swap + mirror', () => {
    it('should swap and mirror quaternion data between left and right', () => {
      const mapping = createTestBoneMapping(['leftUpperArm', 'rightUpperArm']);
      const clip = makeClip('test', [
        quatTrack('Node_leftUpperArm', [0], [0.0, 0.707, 0.0, 0.707]),
        quatTrack('Node_rightUpperArm', [0], [0.1, -0.3, 0.5, 0.8]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      const leftTrack = mirrored.tracks.find((t) => t.name === 'Node_leftUpperArm.quaternion')!;
      const rightTrack = mirrored.tracks.find((t) => t.name === 'Node_rightUpperArm.quaternion')!;

      // left ← mirror(right's original): (0.1, 0.3, -0.5, 0.8)
      expectArrayClose(leftTrack.values, [0.1, 0.3, -0.5, 0.8]);
      // right ← mirror(left's original): (0.0, -0.707, 0.0, 0.707)
      expectArrayClose(rightTrack.values, [0.0, -0.707, 0.0, 0.707]);
    });

    it('should swap and mirror position data between paired bones', () => {
      const mapping = createTestBoneMapping(['leftHand', 'rightHand']);
      const clip = makeClip('test', [
        posTrack('Node_leftHand', [0], [1.0, 2.0, 3.0]),
        posTrack('Node_rightHand', [0], [-1.0, 2.0, 3.0]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      const leftTrack = mirrored.tracks.find((t) => t.name === 'Node_leftHand.position')!;
      const rightTrack = mirrored.tracks.find((t) => t.name === 'Node_rightHand.position')!;

      // left ← mirror(right's original): (1.0, 2.0, 3.0)
      expectArrayClose(leftTrack.values, [1.0, 2.0, 3.0]);
      // right ← mirror(left's original): (-1.0, 2.0, 3.0)
      expectArrayClose(rightTrack.values, [-1.0, 2.0, 3.0]);
    });
  });

  describe('expression tracks unchanged', () => {
    it('should not modify expression/morph tracks', () => {
      const mapping = createTestBoneMapping(['hips']);
      const clip = makeClip('test', [
        numTrack('BlendShape.blink', [0, 1], [0.0, 1.0]),
        numTrack('BlendShape.happy', [0, 0.5, 1], [0.0, 0.5, 1.0]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      expect(mirrored.tracks).toHaveLength(2);

      const blink = mirrored.tracks.find((t) => t.name === 'BlendShape.blink')!;
      expectArrayClose(blink.values, [0.0, 1.0]);

      const happy = mirrored.tracks.find((t) => t.name === 'BlendShape.happy')!;
      expectArrayClose(happy.values, [0.0, 0.5, 1.0]);
    });
  });

  describe('single-side track edge case', () => {
    it('should move track to opposite side when only one side exists', () => {
      const mapping = createTestBoneMapping(['leftHand', 'rightHand']);
      const clip = makeClip('test', [
        quatTrack('Node_leftHand', [0], [0.0, 0.5, 0.3, 0.8]),
        // rightHand has no track
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      // leftHand track should be moved to rightHand (with mirror)
      expect(mirrored.tracks).toHaveLength(1);
      const track = mirrored.tracks[0];
      expect(track.name).toBe('Node_rightHand.quaternion');
      expectArrayClose(track.values, [0.0, -0.5, -0.3, 0.8]);
    });
  });

  describe('identity quaternion', () => {
    it('should remain identity after mirror', () => {
      const mapping = createTestBoneMapping(['spine']);
      const clip = makeClip('test', [
        quatTrack('Node_spine', [0], [0, 0, 0, 1]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      const track = mirrored.tracks[0];
      expectArrayClose(track.values, [0, 0, 0, 1]);
    });
  });

  describe('original clip immutability', () => {
    it('should not modify the original clip data', () => {
      const mapping = createTestBoneMapping(['hips', 'leftUpperArm', 'rightUpperArm']);
      const originalHipsValues = [0.1, 0.5, 0.3, 0.8];
      const originalLeftValues = [0.0, 0.707, 0.0, 0.707];
      const originalRightValues = [0.2, -0.4, 0.6, 0.7];

      const clip = makeClip('test', [
        quatTrack('Node_hips', [0], [...originalHipsValues]),
        quatTrack('Node_leftUpperArm', [0], [...originalLeftValues]),
        quatTrack('Node_rightUpperArm', [0], [...originalRightValues]),
      ]);

      // Save references to original arrays
      const hipsValuesRef = clip.tracks[0].values;
      const leftValuesRef = clip.tracks[1].values;
      const rightValuesRef = clip.tracks[2].values;

      mirrorAnimationClip(clip, mapping);

      // Original arrays should be unchanged
      expectArrayClose(hipsValuesRef, originalHipsValues);
      expectArrayClose(leftValuesRef, originalLeftValues);
      expectArrayClose(rightValuesRef, originalRightValues);
    });
  });

  describe('mixed tracks', () => {
    it('should handle clip with center, paired, and expression tracks together', () => {
      const mapping = createTestBoneMapping([
        'hips', 'spine', 'leftUpperArm', 'rightUpperArm',
      ]);
      const clip = makeClip('test', [
        quatTrack('Node_hips', [0], [0.0, 0.1, 0.2, 0.9]),
        quatTrack('Node_spine', [0], [0.0, 0.3, 0.4, 0.85]),
        quatTrack('Node_leftUpperArm', [0], [0.1, 0.2, 0.3, 0.9]),
        quatTrack('Node_rightUpperArm', [0], [0.4, 0.5, 0.6, 0.7]),
        posTrack('Node_hips', [0], [1.0, 2.0, 3.0]),
        numTrack('Expression.happy', [0], [0.8]),
      ]);

      const mirrored = mirrorAnimationClip(clip, mapping);
      expect(mirrored.tracks).toHaveLength(6);

      // Center: hips quaternion mirrored
      const hipsQ = mirrored.tracks.find((t) => t.name === 'Node_hips.quaternion')!;
      expectArrayClose(hipsQ.values, [0.0, -0.1, -0.2, 0.9]);

      // Center: spine quaternion mirrored
      const spineQ = mirrored.tracks.find((t) => t.name === 'Node_spine.quaternion')!;
      expectArrayClose(spineQ.values, [0.0, -0.3, -0.4, 0.85]);

      // Paired: left ← mirror(right original)
      const leftQ = mirrored.tracks.find((t) => t.name === 'Node_leftUpperArm.quaternion')!;
      expectArrayClose(leftQ.values, [0.4, -0.5, -0.6, 0.7]);

      // Paired: right ← mirror(left original)
      const rightQ = mirrored.tracks.find((t) => t.name === 'Node_rightUpperArm.quaternion')!;
      expectArrayClose(rightQ.values, [0.1, -0.2, -0.3, 0.9]);

      // Center: hips position mirrored
      const hipsP = mirrored.tracks.find((t) => t.name === 'Node_hips.position')!;
      expectArrayClose(hipsP.values, [-1.0, 2.0, 3.0]);

      // Expression: unchanged
      const expr = mirrored.tracks.find((t) => t.name === 'Expression.happy')!;
      expectArrayClose(expr.values, [0.8]);
    });
  });
});
