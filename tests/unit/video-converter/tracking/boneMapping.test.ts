import { describe, it, expect } from 'vitest';
import {
  ALL_VRM_BONES,
  VRM_BONE_PARENT_CHAIN,
  A_POSE_REFERENCE_DIR,
  FINGER_CHAINS,
} from '../../../../src/video-converter/tracking/boneMapping';
import type { VRMHumanoidBoneName } from '../../../../src/video-converter/tracking/boneMapping';
import { length } from '../../../../src/video-converter/math/Vector';

describe('boneMapping — 骨骼集合', () => {
  it('總共 53 根骨骼', () => {
    expect(ALL_VRM_BONES.length).toBe(53);
  });

  it('不含 leftToes / rightToes（MVP 決策）', () => {
    expect(ALL_VRM_BONES).not.toContain('leftToes');
    expect(ALL_VRM_BONES).not.toContain('rightToes');
  });

  it('包含 hips 作為唯一 root', () => {
    expect(ALL_VRM_BONES).toContain('hips');
    expect(VRM_BONE_PARENT_CHAIN.hips).toEqual([]);
  });

  it('沒有重複骨骼', () => {
    const set = new Set(ALL_VRM_BONES);
    expect(set.size).toBe(ALL_VRM_BONES.length);
  });

  it('包含全部 4 大區塊（軀幹 / 手臂 / 腿 / 手指）', () => {
    // 軀幹（含頭部附屬）
    expect(ALL_VRM_BONES).toContain('hips');
    expect(ALL_VRM_BONES).toContain('head');
    expect(ALL_VRM_BONES).toContain('jaw');
    // 手臂
    expect(ALL_VRM_BONES).toContain('leftUpperArm');
    expect(ALL_VRM_BONES).toContain('rightHand');
    // 腿
    expect(ALL_VRM_BONES).toContain('leftFoot');
    expect(ALL_VRM_BONES).toContain('rightUpperLeg');
    // 手指（拇指 + 四指）
    expect(ALL_VRM_BONES).toContain('leftThumbDistal');
    expect(ALL_VRM_BONES).toContain('rightLittleProximal');
  });

  it('5 指 × 3 節 × 2 手 = 30 根手指骨', () => {
    const fingerBones = ALL_VRM_BONES.filter((b) =>
      /(Thumb|Index|Middle|Ring|Little)/.test(b)
    );
    expect(fingerBones.length).toBe(30);
  });
});

describe('boneMapping — VRM_BONE_PARENT_CHAIN', () => {
  it('每根骨骼都有 parent chain 條目', () => {
    for (const bone of ALL_VRM_BONES) {
      expect(VRM_BONE_PARENT_CHAIN).toHaveProperty(bone);
    }
  });

  it('hips 之外所有骨骼的 chain 起點都是 hips', () => {
    for (const bone of ALL_VRM_BONES) {
      if (bone === 'hips') continue;
      const chain = VRM_BONE_PARENT_CHAIN[bone];
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0]).toBe('hips');
    }
  });

  it('chain 不包含自己', () => {
    for (const bone of ALL_VRM_BONES) {
      expect(VRM_BONE_PARENT_CHAIN[bone]).not.toContain(bone);
    }
  });

  it('chain 中所有元素都是有效骨骼名', () => {
    const valid = new Set(ALL_VRM_BONES);
    for (const bone of ALL_VRM_BONES) {
      for (const ancestor of VRM_BONE_PARENT_CHAIN[bone]) {
        expect(valid.has(ancestor)).toBe(true);
      }
    }
  });

  it('chain 中沒有重複元素', () => {
    for (const bone of ALL_VRM_BONES) {
      const chain = VRM_BONE_PARENT_CHAIN[bone];
      expect(new Set(chain).size).toBe(chain.length);
    }
  });

  it('leftUpperArm 的 chain 順序正確', () => {
    expect(VRM_BONE_PARENT_CHAIN.leftUpperArm).toEqual([
      'hips',
      'spine',
      'chest',
      'upperChest',
      'leftShoulder',
    ]);
  });

  it('leftFoot 的 chain 不經過 spine（腿是 hips 直接子孫）', () => {
    const chain = VRM_BONE_PARENT_CHAIN.leftFoot;
    expect(chain).not.toContain('spine');
    expect(chain).toEqual(['hips', 'leftUpperLeg', 'leftLowerLeg']);
  });

  it('左右對稱性：左手 chain 與右手 chain 結構相同（換邊）', () => {
    const left = VRM_BONE_PARENT_CHAIN.leftHand;
    const right = VRM_BONE_PARENT_CHAIN.rightHand;
    expect(left.length).toBe(right.length);
  });

  it('手指 chain 經過 hand', () => {
    expect(VRM_BONE_PARENT_CHAIN.leftIndexDistal).toContain('leftHand');
    expect(VRM_BONE_PARENT_CHAIN.rightThumbDistal).toContain('rightHand');
  });

  it('chain 長度遞增：父骨骼的 chain ⊂ 子骨骼的 chain', () => {
    // spine 的 chain 應比 chest 的短 1
    expect(VRM_BONE_PARENT_CHAIN.spine.length + 1).toBe(
      VRM_BONE_PARENT_CHAIN.chest.length
    );
    // chest ⊂ upperChest ⊂ neck ⊂ head
    expect(VRM_BONE_PARENT_CHAIN.upperChest.length).toBe(
      VRM_BONE_PARENT_CHAIN.chest.length + 1
    );
    expect(VRM_BONE_PARENT_CHAIN.head.length).toBe(
      VRM_BONE_PARENT_CHAIN.neck.length + 1
    );
  });
});

describe('boneMapping — A_POSE_REFERENCE_DIR', () => {
  it('每根骨骼都有 reference direction', () => {
    for (const bone of ALL_VRM_BONES) {
      expect(A_POSE_REFERENCE_DIR).toHaveProperty(bone);
    }
  });

  it('每個 reference direction 都是單位向量（誤差 < 1e-9）', () => {
    for (const bone of ALL_VRM_BONES) {
      const dir = A_POSE_REFERENCE_DIR[bone];
      const len = length(dir);
      expect(Math.abs(len - 1)).toBeLessThan(1e-9);
    }
  });

  it('沒有 NaN / Infinity', () => {
    for (const bone of ALL_VRM_BONES) {
      const dir = A_POSE_REFERENCE_DIR[bone];
      expect(Number.isFinite(dir.x)).toBe(true);
      expect(Number.isFinite(dir.y)).toBe(true);
      expect(Number.isFinite(dir.z)).toBe(true);
    }
  });

  it('左右肩往相反方向（X 軸對稱）', () => {
    const left = A_POSE_REFERENCE_DIR.leftShoulder;
    const right = A_POSE_REFERENCE_DIR.rightShoulder;
    expect(left.x).toBe(-right.x);
    expect(left.y).toBe(right.y);
    expect(left.z).toBe(right.z);
  });

  it('vertical chain 都沿父 +Y（spine→neck）', () => {
    const verticalBones: VRMHumanoidBoneName[] = ['spine', 'chest', 'upperChest', 'neck'];
    for (const bone of verticalBones) {
      expect(A_POSE_REFERENCE_DIR[bone].y).toBeGreaterThan(0);
    }
  });

  it('head 沿父 -Z（earMid - nose 在 rest 時為向後）', () => {
    expect(A_POSE_REFERENCE_DIR.head.z).toBeLessThan(0);
  });

  it('腳掌沿父 +Z（向前）', () => {
    expect(A_POSE_REFERENCE_DIR.leftFoot.z).toBeGreaterThan(0);
    expect(A_POSE_REFERENCE_DIR.rightFoot.z).toBeGreaterThan(0);
  });
});

describe('boneMapping — FINGER_CHAINS', () => {
  it('共 10 條手指鏈（5 指 × 2 手）', () => {
    expect(FINGER_CHAINS.length).toBe(10);
  });

  it('每隻手的 5 指都有對應 entry', () => {
    const fingers = ['thumb', 'index', 'middle', 'ring', 'little'] as const;
    for (const side of ['left', 'right'] as const) {
      for (const finger of fingers) {
        const entry = FINGER_CHAINS.find((c) => c.side === side && c.finger === finger);
        expect(entry, `${side} ${finger}`).toBeDefined();
      }
    }
  });

  it('每條鏈剛好 3 根骨骼 + 4 個 landmark 索引', () => {
    for (const entry of FINGER_CHAINS) {
      expect(entry.bones.length).toBe(3);
      expect(entry.landmarkIndices.length).toBe(4);
    }
  });

  it('鏈中所有骨骼都在 ALL_VRM_BONES 內', () => {
    const valid = new Set(ALL_VRM_BONES);
    for (const entry of FINGER_CHAINS) {
      for (const bone of entry.bones) {
        expect(valid.has(bone)).toBe(true);
      }
    }
  });

  it('landmarkIndices 在 [1, 20] 範圍內（避開 wrist=0）', () => {
    for (const entry of FINGER_CHAINS) {
      for (const idx of entry.landmarkIndices) {
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThanOrEqual(20);
      }
    }
  });

  it('鏈的骨骼名稱與側別一致', () => {
    for (const entry of FINGER_CHAINS) {
      for (const bone of entry.bones) {
        expect(bone.startsWith(entry.side)).toBe(true);
      }
    }
  });

  it('左右手對稱：相同手指索引相同', () => {
    const leftIndex = FINGER_CHAINS.find((c) => c.side === 'left' && c.finger === 'index')!;
    const rightIndex = FINGER_CHAINS.find((c) => c.side === 'right' && c.finger === 'index')!;
    expect(leftIndex.landmarkIndices).toEqual(rightIndex.landmarkIndices);
  });

  it('拇指 landmark 從 CMC(1) 開始，食指從 MCP(5) 開始', () => {
    const leftThumb = FINGER_CHAINS.find((c) => c.side === 'left' && c.finger === 'thumb')!;
    expect(leftThumb.landmarkIndices[0]).toBe(1);
    const leftIndex = FINGER_CHAINS.find((c) => c.side === 'left' && c.finger === 'index')!;
    expect(leftIndex.landmarkIndices[0]).toBe(5);
  });
});
