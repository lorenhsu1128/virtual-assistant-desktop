import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { reverseAnimationClipForEnterdoor } from '../../src/animation/AnimationReverse';
import type { BoneMapping } from '../../src/animation/AnimationMirror';

function createTestBoneMapping(boneNames: string[]): BoneMapping {
  const nodeNameToBone = new Map<string, string>();
  const boneToNodeName = new Map<string, string>();
  for (const name of boneNames) {
    const nodeName = `Node_${name}`;
    nodeNameToBone.set(nodeName, name);
    boneToNodeName.set(name, nodeName);
  }
  return { nodeNameToBone, boneToNodeName };
}

function quatTrack(nodeName: string, times: number[], values: number[]): THREE.QuaternionKeyframeTrack {
  return new THREE.QuaternionKeyframeTrack(
    `${nodeName}.quaternion`,
    new Float32Array(times),
    new Float32Array(values),
  );
}

function posTrack(nodeName: string, times: number[], values: number[]): THREE.VectorKeyframeTrack {
  return new THREE.VectorKeyframeTrack(
    `${nodeName}.position`,
    new Float32Array(times),
    new Float32Array(values),
  );
}

function makeClip(name: string, tracks: THREE.KeyframeTrack[]): THREE.AnimationClip {
  return new THREE.AnimationClip(name, -1, tracks);
}

function expectArrayClose(actual: ArrayLike<number>, expected: number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]).toBeCloseTo(expected[i], 5);
  }
}

describe('AnimationReverse', () => {
  const mapping = createTestBoneMapping(['hips', 'spine', 'leftUpperArm']);

  describe('hips position track', () => {
    it('should negate X and Z, keep Y', () => {
      const original = posTrack('Node_hips', [0, 1], [1, 2, 3, 4, 5, 6]);
      const clip = makeClip('OPENDOOR', [original]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_hips.position')!;

      expectArrayClose(track.values, [-1, 2, -3, -4, 5, -6]);
    });

    it('should not mutate the original clip values', () => {
      const original = posTrack('Node_hips', [0, 1], [1, 2, 3, 4, 5, 6]);
      const clip = makeClip('OPENDOOR', [original]);

      reverseAnimationClipForEnterdoor(clip, mapping);

      expectArrayClose(original.values, [1, 2, 3, 4, 5, 6]);
    });
  });

  describe('hips quaternion track', () => {
    it('should apply q_rotY(π) pre-multiply: (x,y,z,w) → (z,w,-x,-y)', () => {
      const original = quatTrack('Node_hips', [0], [0.1, 0.2, 0.3, 0.4]);
      const clip = makeClip('OPENDOOR', [original]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_hips.quaternion')!;

      expectArrayClose(track.values, [0.3, 0.4, -0.1, -0.2]);
    });

    it('should handle identity quaternion → rotY(π) quaternion', () => {
      // Identity quaternion (0,0,0,1) should become (0,1,0,0) which is rotY(π)
      const original = quatTrack('Node_hips', [0], [0, 0, 0, 1]);
      const clip = makeClip('OPENDOOR', [original]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_hips.quaternion')!;

      expectArrayClose(track.values, [0, 1, 0, 0]);
    });

    it('should handle multiple keyframes', () => {
      const original = quatTrack('Node_hips', [0, 0.5, 1], [
        0.1, 0.2, 0.3, 0.4,
        0.5, 0.6, 0.7, 0.8,
        0.9, 1.0, 1.1, 1.2,
      ]);
      const clip = makeClip('OPENDOOR', [original]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_hips.quaternion')!;

      expectArrayClose(track.values, [
        0.3, 0.4, -0.1, -0.2,
        0.7, 0.8, -0.5, -0.6,
        1.1, 1.2, -0.9, -1.0,
      ]);
    });

    it('should not mutate the original clip values', () => {
      const original = quatTrack('Node_hips', [0], [0.1, 0.2, 0.3, 0.4]);
      const clip = makeClip('OPENDOOR', [original]);

      reverseAnimationClipForEnterdoor(clip, mapping);

      expectArrayClose(original.values, [0.1, 0.2, 0.3, 0.4]);
    });
  });

  describe('non-hips tracks', () => {
    it('should leave spine quaternion track untouched', () => {
      const spineTrack = quatTrack('Node_spine', [0], [0.1, 0.2, 0.3, 0.4]);
      const hipsPosTrack = posTrack('Node_hips', [0], [1, 2, 3]);
      const clip = makeClip('OPENDOOR', [spineTrack, hipsPosTrack]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_spine.quaternion')!;

      expectArrayClose(track.values, [0.1, 0.2, 0.3, 0.4]);
    });

    it('should leave leftUpperArm quaternion track untouched', () => {
      const armTrack = quatTrack('Node_leftUpperArm', [0], [0.5, 0.6, 0.7, 0.8]);
      const hipsPosTrack = posTrack('Node_hips', [0], [1, 2, 3]);
      const clip = makeClip('OPENDOOR', [armTrack, hipsPosTrack]);

      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      const track = reversed.tracks.find((t) => t.name === 'Node_leftUpperArm.quaternion')!;

      expectArrayClose(track.values, [0.5, 0.6, 0.7, 0.8]);
    });
  });

  describe('clip metadata', () => {
    it('should return a new clip instance (not the original)', () => {
      const clip = makeClip('OPENDOOR', [posTrack('Node_hips', [0], [1, 2, 3])]);
      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      expect(reversed).not.toBe(clip);
    });

    it('should suffix clip name with ":reversed"', () => {
      const clip = makeClip('OPENDOOR', [posTrack('Node_hips', [0], [1, 2, 3])]);
      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      expect(reversed.name).toBe('OPENDOOR:reversed');
    });

    it('should have the same number of tracks as the original', () => {
      const clip = makeClip('OPENDOOR', [
        posTrack('Node_hips', [0], [1, 2, 3]),
        quatTrack('Node_hips', [0], [0.1, 0.2, 0.3, 0.4]),
        quatTrack('Node_spine', [0], [0.5, 0.6, 0.7, 0.8]),
      ]);
      const reversed = reverseAnimationClipForEnterdoor(clip, mapping);
      expect(reversed.tracks.length).toBe(3);
    });
  });

  describe('missing hips mapping', () => {
    it('should return a clone of the original clip if hips is not in mapping', () => {
      const emptyMapping = createTestBoneMapping(['spine', 'leftUpperArm']);
      const clip = makeClip('OPENDOOR', [posTrack('Node_hips', [0], [1, 2, 3])]);

      const reversed = reverseAnimationClipForEnterdoor(clip, emptyMapping);
      expect(reversed).not.toBe(clip);
      expect(reversed.tracks.length).toBe(1);
      expectArrayClose(reversed.tracks[0].values, [1, 2, 3]);
    });
  });
});
