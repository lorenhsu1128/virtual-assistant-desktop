import * as THREE from 'three';
import type { VRMController } from '../core/VRMController';

/**
 * 步伐分析結果
 */
export interface StepAnalysis {
  /** 單步步伐長度（世界單位，scale=1 基準） */
  stepLength: number;
  /** 動畫完整週期時長（秒） */
  cycleDuration: number;
  /** 一個週期的步數 */
  stepsPerCycle: number;
  /** 世界空間移動速度（世界單位/秒，scale=1 基準） */
  worldSpeed: number;
}

/**
 * 步伐長度分析器
 *
 * 透過虛擬播放行走動畫，取樣腳底骨骼的 Z 軸位移，
 * 計算步伐長度和擬真移動速度。
 *
 * 分析在 scale=1 下進行，結果作為基準值。
 * 實際移動速度 = worldSpeed × scale（由 StateMachine 自動套用）。
 */
export function analyzeWalkAnimation(
  clip: THREE.AnimationClip,
  vrmController: VRMController,
): StepAnalysis | null {
  const vrm = vrmController.getVRM();
  if (!vrm) return null;

  // 建立臨時 mixer 做虛擬播放（不影響正在播放的動畫）
  const tempMixer = new THREE.AnimationMixer(vrm.scene);
  const action = tempMixer.clipAction(clip);
  action.play();

  // 記錄原始 model scale，暫時設為 1 分析基礎步伐
  const originalScale = vrm.scene.scale.x;
  vrm.scene.scale.setScalar(1.0);

  const duration = clip.duration;
  const sampleRate = 60; // 每秒 60 個取樣點
  const totalSamples = Math.ceil(duration * sampleRate);
  const dt = duration / totalSamples;

  // 取樣左腳 Z 軸位置（VRM 模型面向 +Z，旋轉 π 後面向 -Z）
  // 腳向前擺動 = Z 值變化
  const leftFootSamples: number[] = [];
  const rightFootSamples: number[] = [];
  const leftFootYSamples: number[] = [];

  const tempVec = new THREE.Vector3();

  for (let i = 0; i <= totalSamples; i++) {
    // 設定動畫時間
    tempMixer.setTime(i * dt);
    // 強制更新骨骼矩陣
    vrm.scene.updateMatrixWorld(true);

    // 取得腳底世界座標
    const leftFoot = vrm.humanoid?.getNormalizedBoneNode('leftFoot');
    const rightFoot = vrm.humanoid?.getNormalizedBoneNode('rightFoot');

    if (leftFoot) {
      leftFoot.getWorldPosition(tempVec);
      leftFootSamples.push(tempVec.z);
      leftFootYSamples.push(tempVec.y);
    }
    if (rightFoot) {
      rightFoot.getWorldPosition(tempVec);
      rightFootSamples.push(tempVec.z);
    }
  }

  // 還原 model scale 和動畫狀態
  vrm.scene.scale.setScalar(originalScale);
  action.stop();
  tempMixer.stopAllAction();
  tempMixer.uncacheRoot(vrm.scene);

  if (leftFootSamples.length < 2) return null;

  // 分析步伐：找 Y 軸最低點（落地瞬間），測量 Z 軸位移
  const groundContacts = findGroundContacts(leftFootYSamples);

  let stepLength: number;
  let stepsPerCycle: number;

  if (groundContacts.length >= 2) {
    // 有明確的落地點 → 測量連續落地點之間的 Z 位移
    const zDisplacements: number[] = [];
    for (let i = 1; i < groundContacts.length; i++) {
      const dz = Math.abs(leftFootSamples[groundContacts[i]] - leftFootSamples[groundContacts[i - 1]]);
      zDisplacements.push(dz);
    }
    stepLength = zDisplacements.reduce((a, b) => a + b, 0) / zDisplacements.length;
    stepsPerCycle = groundContacts.length - 1;
  } else {
    // 無法偵測落地點 → 用 Z 軸振幅估算
    const leftZRange = Math.max(...leftFootSamples) - Math.min(...leftFootSamples);
    const rightZRange = rightFootSamples.length > 0
      ? Math.max(...rightFootSamples) - Math.min(...rightFootSamples)
      : leftZRange;
    stepLength = (leftZRange + rightZRange) / 2;
    stepsPerCycle = 2; // 假設一個週期兩步
  }

  // fallback：步伐長度太小（可能是原地踏步動畫）→ 用模型高度估算
  if (stepLength < 0.01) {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const modelHeight = box.max.y - box.min.y;
    stepLength = modelHeight * 0.4; // 人類步幅約 40% 身高
    stepsPerCycle = 2;
  }

  const worldSpeed = (stepLength * stepsPerCycle) / duration;

  return {
    stepLength,
    cycleDuration: duration,
    stepsPerCycle,
    worldSpeed,
  };
}

/**
 * 找 Y 軸局部最低點（落地瞬間）
 *
 * 使用簡單的谷值偵測：前後值都比當前值高。
 */
function findGroundContacts(ySamples: number[]): number[] {
  const contacts: number[] = [];
  const windowSize = 3; // 前後 3 個取樣點做比較

  for (let i = windowSize; i < ySamples.length - windowSize; i++) {
    let isValley = true;
    for (let j = 1; j <= windowSize; j++) {
      if (ySamples[i] > ySamples[i - j] || ySamples[i] > ySamples[i + j]) {
        isValley = false;
        break;
      }
    }
    if (isValley) {
      // 避免連續偵測同一個谷值
      if (contacts.length === 0 || i - contacts[contacts.length - 1] > windowSize * 2) {
        contacts.push(i);
      }
    }
  }

  return contacts;
}
