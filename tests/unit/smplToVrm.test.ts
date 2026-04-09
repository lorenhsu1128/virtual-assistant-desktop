import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  SMPL_TO_VRM_PRIMARY,
  SMPL_FALLBACK_TARGETS,
  buildSmplToVrmMapping,
  smplFrameToVrmRotations,
  axisAngleToQuaternion,
} from '../../src/mocap/smpl/smplToVrm';
import { SMPL_JOINT_COUNT } from '../../src/mocap/smpl/SmplSkeleton';
import type { VrmHumanBoneName } from '../../src/mocap/types';

/** 完整 VRM humanoid bone 集合（含所有 optional bone） */
const FULL_BONES: Set<VrmHumanBoneName> = new Set([
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'leftHand',
  'rightHand',
  'leftUpperLeg',
  'rightUpperLeg',
  'leftLowerLeg',
  'rightLowerLeg',
  'leftFoot',
  'rightFoot',
  'leftToes',
  'rightToes',
]);

/** 建立全 0 的 24 × 3 frame（rest pose） */
function restFrame(): number[][] {
  return Array.from({ length: SMPL_JOINT_COUNT }, () => [0, 0, 0]);
}

/** 判斷兩個 quaternion 是否為 identity（分量差 < epsilon） */
function isIdentityQuat(q: THREE.Quaternion, eps = 1e-6): boolean {
  return (
    Math.abs(q.x) < eps &&
    Math.abs(q.y) < eps &&
    Math.abs(q.z) < eps &&
    Math.abs(q.w - 1) < eps
  );
}

describe('axisAngleToQuaternion', () => {
  it('returns identity for zero vector', () => {
    const q = new THREE.Quaternion();
    axisAngleToQuaternion(0, 0, 0, q);
    expect(isIdentityQuat(q)).toBe(true);
  });

  it('returns identity for very small angle', () => {
    const q = new THREE.Quaternion();
    axisAngleToQuaternion(1e-10, 1e-10, 1e-10, q);
    expect(isIdentityQuat(q)).toBe(true);
  });

  it('matches Three.js setFromAxisAngle for 90° around Y', () => {
    const q = new THREE.Quaternion();
    axisAngleToQuaternion(0, Math.PI / 2, 0, q);
    const ref = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 2,
    );
    expect(q.x).toBeCloseTo(ref.x);
    expect(q.y).toBeCloseTo(ref.y);
    expect(q.z).toBeCloseTo(ref.z);
    expect(q.w).toBeCloseTo(ref.w);
  });

  it('matches Three.js setFromAxisAngle for arbitrary axis', () => {
    const axis = new THREE.Vector3(1, 2, 3).normalize();
    const angle = 0.7;
    const q = new THREE.Quaternion();
    axisAngleToQuaternion(axis.x * angle, axis.y * angle, axis.z * angle, q);
    const ref = new THREE.Quaternion().setFromAxisAngle(axis, angle);
    expect(q.x).toBeCloseTo(ref.x);
    expect(q.y).toBeCloseTo(ref.y);
    expect(q.z).toBeCloseTo(ref.z);
    expect(q.w).toBeCloseTo(ref.w);
  });

  it('is a unit quaternion', () => {
    const q = new THREE.Quaternion();
    axisAngleToQuaternion(0.5, 1.2, -0.8, q);
    const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    expect(len).toBeCloseTo(1);
  });
});

describe('buildSmplToVrmMapping — full bone set', () => {
  it('maps each SMPL joint to its primary target', () => {
    const resolved = buildSmplToVrmMapping(FULL_BONES);
    for (let i = 0; i < SMPL_JOINT_COUNT; i++) {
      const primary = SMPL_TO_VRM_PRIMARY[i];
      if (primary) {
        expect(resolved[i]).toBe(primary);
      } else {
        // null primary → should use fallback
        const fallback = SMPL_FALLBACK_TARGETS[i];
        if (fallback) {
          expect(resolved[i]).toBe(fallback);
        }
      }
    }
  });

  it('SMPL leftHand(22) falls back to leftHand (VRM wrist)', () => {
    const resolved = buildSmplToVrmMapping(FULL_BONES);
    expect(resolved[22]).toBe('leftHand');
  });
});

describe('buildSmplToVrmMapping — missing optional bones', () => {
  it('spine3 → chest when upperChest missing', () => {
    const without = new Set(FULL_BONES);
    without.delete('upperChest');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[9]).toBe('chest');
  });

  it('leftCollar → leftUpperArm when leftShoulder missing', () => {
    const without = new Set(FULL_BONES);
    without.delete('leftShoulder');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[13]).toBe('leftUpperArm');
  });

  it('rightCollar → rightUpperArm when rightShoulder missing', () => {
    const without = new Set(FULL_BONES);
    without.delete('rightShoulder');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[14]).toBe('rightUpperArm');
  });

  it('SMPL leftFoot (toes) → VRM leftFoot when leftToes missing', () => {
    const without = new Set(FULL_BONES);
    without.delete('leftToes');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[10]).toBe('leftFoot');
  });

  it('SMPL rightFoot (toes) → VRM rightFoot when rightToes missing', () => {
    const without = new Set(FULL_BONES);
    without.delete('rightToes');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[11]).toBe('rightFoot');
  });

  it('multiple missing bones still resolve via parent chain', () => {
    // 同時缺失 upperChest + leftShoulder，leftCollar 應走 fallback → leftUpperArm
    const without = new Set(FULL_BONES);
    without.delete('upperChest');
    without.delete('leftShoulder');
    const resolved = buildSmplToVrmMapping(without);
    expect(resolved[9]).toBe('chest'); // spine3
    expect(resolved[13]).toBe('leftUpperArm'); // leftCollar
  });
});

describe('smplFrameToVrmRotations — rest pose', () => {
  it('all-zero frame produces no non-identity bones', () => {
    const mapping = buildSmplToVrmMapping(FULL_BONES);
    const result = smplFrameToVrmRotations(restFrame(), mapping);
    for (const [name, q] of Object.entries(result)) {
      expect(isIdentityQuat(q as THREE.Quaternion), `${name} should be identity`).toBe(true);
    }
  });
});

describe('smplFrameToVrmRotations — single joint', () => {
  it('leftElbow (SMPL 18) → leftLowerArm with matching rotation', () => {
    const frame = restFrame();
    frame[18] = [0, 0, Math.PI / 2]; // 90° around Z
    const mapping = buildSmplToVrmMapping(FULL_BONES);
    const result = smplFrameToVrmRotations(frame, mapping);

    expect(result.leftLowerArm).toBeDefined();
    const q = result.leftLowerArm!;
    expect(q.z).toBeCloseTo(Math.sin(Math.PI / 4));
    expect(q.w).toBeCloseTo(Math.cos(Math.PI / 4));

    // Other mapped bones should be identity or absent
    expect(result.leftUpperArm === undefined || isIdentityQuat(result.leftUpperArm)).toBe(true);
    expect(result.rightLowerArm === undefined || isIdentityQuat(result.rightLowerArm)).toBe(true);
  });

  it('pelvis (SMPL 0) rotation → hips', () => {
    const frame = restFrame();
    frame[0] = [Math.PI / 4, 0, 0];
    const mapping = buildSmplToVrmMapping(FULL_BONES);
    const result = smplFrameToVrmRotations(frame, mapping);
    expect(result.hips).toBeDefined();
    expect(result.hips!.x).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(result.hips!.w).toBeCloseTo(Math.cos(Math.PI / 8));
  });
});

describe('smplFrameToVrmRotations — bucket merging', () => {
  it('spine2 + spine3 both merge to chest when upperChest missing', () => {
    const frame = restFrame();
    // spine2 (SMPL 6) 繞 Y
    frame[6] = [0, 0.3, 0];
    // spine3 (SMPL 9) 繞 Y
    frame[9] = [0, 0.2, 0];
    const without = new Set(FULL_BONES);
    without.delete('upperChest');
    const mapping = buildSmplToVrmMapping(without);
    const result = smplFrameToVrmRotations(frame, mapping);

    expect(result.chest).toBeDefined();
    // Chest quat should equal q(spine2) * q(spine3)
    const q2 = new THREE.Quaternion();
    axisAngleToQuaternion(0, 0.3, 0, q2);
    const q3 = new THREE.Quaternion();
    axisAngleToQuaternion(0, 0.2, 0, q3);
    const expected = q2.clone().multiply(q3);

    expect(result.chest!.x).toBeCloseTo(expected.x);
    expect(result.chest!.y).toBeCloseTo(expected.y);
    expect(result.chest!.z).toBeCloseTo(expected.z);
    expect(result.chest!.w).toBeCloseTo(expected.w);
    // upperChest 不應出現在結果
    expect(result.upperChest).toBeUndefined();
  });

  it('SMPL leftHand (22) merges into leftHand (20, wrist)', () => {
    const frame = restFrame();
    // leftWrist (SMPL 20)
    frame[20] = [0.1, 0, 0];
    // leftHand fingers root (SMPL 22)
    frame[22] = [0.2, 0, 0];
    const mapping = buildSmplToVrmMapping(FULL_BONES);
    const result = smplFrameToVrmRotations(frame, mapping);

    expect(result.leftHand).toBeDefined();
    // 應該是 q(20) * q(22)
    const q20 = new THREE.Quaternion();
    axisAngleToQuaternion(0.1, 0, 0, q20);
    const q22 = new THREE.Quaternion();
    axisAngleToQuaternion(0.2, 0, 0, q22);
    const expected = q20.clone().multiply(q22);
    expect(result.leftHand!.x).toBeCloseTo(expected.x);
    expect(result.leftHand!.w).toBeCloseTo(expected.w);
  });
});

describe('smplFrameToVrmRotations — robustness', () => {
  it('skips joints with null target (mapping has null)', () => {
    const frame = restFrame();
    frame[22] = [1, 0, 0]; // leftHand fingers
    // Mapping where leftHand is missing entirely (degenerate case)
    const mapping = Array(SMPL_JOINT_COUNT).fill(null);
    const result = smplFrameToVrmRotations(frame, mapping as never);
    expect(Object.keys(result).length).toBe(0);
  });

  it('skips joints with malformed axis-angle (undefined or too short)', () => {
    const frame = restFrame() as (number[] | undefined)[];
    frame[5] = undefined;
    frame[10] = [0, 0]; // too short
    const mapping = buildSmplToVrmMapping(FULL_BONES);
    // Should not throw
    expect(() => smplFrameToVrmRotations(frame as never, mapping)).not.toThrow();
  });
});
