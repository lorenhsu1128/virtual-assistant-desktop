import * as THREE from 'three';
import type { VRMController } from '../core/VRMController';
import type { MouseCursorTracker } from './MouseCursorTracker';
import { buildHeadIKChain, type BuiltIKChain, toV3 } from './IKChainBuilder';
import {
  DEFAULT_CLAMP_RANGES,
  type BoneClampRange,
} from '../types/headTracking';
import type { BehaviorState } from '../types/behavior';

/**
 * 滑鼠頭部追蹤控制器
 *
 * 視覺效果（人體工學三層連動）：
 *   - 眼睛先動：由 vrm.lookAt 自動處理（VRM 規範內建眼球範圍）
 *   - 頭跟著轉（60% 分量，最大 yaw ±60° / pitch ±30°）
 *   - 頸再分擔（30%，yaw ±40° / pitch ±20°）
 *   - 上身微側（10%，yaw ±15° / pitch ±10°）
 *
 * 演算法：
 *   1. ikts Chain3D 解 base→neck→head→virtualEnd，target = 滑鼠對應世界座標
 *      → 提供 chain endpoint 作為「實際可達的看向方向」，並讓 IK 物理意義保留
 *   2. 從 head 世界座標 → smoothed target 算出 total yaw/pitch（YXZ Euler）
 *   3. 按 0.10 / 0.30 / 0.60 分配到 upperChest / neck / head，各自 clamp
 *   4. 每根骨頭 local rotation = clamp(分配角)，slerp 進 mixer 寫入的 local quat
 *      → 既保留動畫風味，又達到「看向滑鼠」
 *
 * 在 VRMController.update() 內、mixer.update() 之後、applyHipSmoothing 之前呼叫。
 */
export class HeadTrackingController {
  private readonly vrmController: VRMController;
  private readonly cursorTracker: MouseCursorTracker;

  /** 主開關（受 config / tray checkbox 控制） */
  private enabled = true;
  /** 動畫混合權重（0..1） */
  private baseWeight = 0.7;
  /** 當前行為狀態 override（會改變實際 weight） */
  private currentState: BehaviorState | null = null;
  /** 已建構的 IK 鏈，model 載入後 setup 時填入 */
  private builtChain: BuiltIKChain | null = null;
  /** 各骨骼限幅 */
  private clamp: Record<'upperChest' | 'neck' | 'head', BoneClampRange> = {
    upperChest: { ...DEFAULT_CLAMP_RANGES.upperChest },
    neck: { ...DEFAULT_CLAMP_RANGES.neck },
    head: { ...DEFAULT_CLAMP_RANGES.head },
  };
  /** 三層分配權重（總和不必為 1，個別 clamp 限制各自上限） */
  private static readonly DISTRIBUTION: Record<'upperChest' | 'neck' | 'head', number> = {
    upperChest: 0.10,
    neck: 0.30,
    head: 0.60,
  };

  /** 取得「想要看向」的世界座標的回呼（由 SceneManager 注入） */
  private targetProvider: (() => THREE.Vector3 | null) | null = null;
  /** VRM lookAt 用的 target Object3D */
  private readonly lookAtTarget: THREE.Object3D;
  /** 上一幀套用的 local quaternion（用於 disable 時平滑歸位） */
  private lastAppliedQuaternions = new Map<string, THREE.Quaternion>();
  /** 預留：未來如要在 cursor 平滑之外再加 per-bone 時間平滑，狀態存這裡 */
  private smoothedLocalQuats = new Map<string, THREE.Quaternion>();
  /** 是否處於「停用平滑歸位中」狀態 */
  private disablingFade = false;
  private static readonly DISABLE_FADE_RATE = 6;

  // 可重用暫存
  private readonly _tmpV3a = new THREE.Vector3();
  private readonly _tmpV3b = new THREE.Vector3();
  private readonly _tmpV3c = new THREE.Vector3();
  private readonly _tmpV3d = new THREE.Vector3();
  private readonly _tmpEuler = new THREE.Euler();

  /** 總旋轉角度的上限（弧度）— 超過會 clamp，避免 setFromUnitVectors 在反向奇異點失穩 */
  private static readonly MAX_TOTAL_YAW = (100 * Math.PI) / 180;
  private static readonly MAX_TOTAL_PITCH = (60 * Math.PI) / 180;

  constructor(vrmController: VRMController, cursorTracker: MouseCursorTracker) {
    this.vrmController = vrmController;
    this.cursorTracker = cursorTracker;
    this.lookAtTarget = new THREE.Object3D();
  }

  /** 取得提供給 vrm.lookAt 的 target Object3D */
  getLookAtTarget(): THREE.Object3D {
    return this.lookAtTarget;
  }

  setTargetProvider(fn: () => THREE.Vector3 | null): void {
    this.targetProvider = fn;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.disablingFade = true;
    } else {
      this.disablingFade = false;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setWeight(weight: number): void {
    this.baseWeight = Math.max(0, Math.min(1, weight));
  }

  setStateOverride(state: BehaviorState | null): void {
    this.currentState = state;
  }

  /** 從目前 VRM bones 重建 IK chain */
  rebuildChain(): void {
    const chain = buildHeadIKChain((name) => this.vrmController.getBoneNode(name));
    this.builtChain = chain;
    this.lastAppliedQuaternions.clear();
    this.smoothedLocalQuats.clear();
    if (chain) {
      console.log(
        `[headtracking] chain ready: ${chain.bones.map((b) => b.vrmBoneName).join(' → ')} + virtual`,
      );
    } else {
      console.warn('[headtracking] chain build failed; disabled for this model');
    }
  }

  /** 取得目前實際生效的混合權重 */
  private getEffectiveWeight(): number {
    if (!this.enabled) return 0;
    switch (this.currentState) {
      case 'hide':
      case 'peek':
      case 'enterdoor':
      case 'opendoor':
        return 0;
      case 'drag':
      case 'sit':
      case 'fall':
        return this.baseWeight * 0.4;
      default:
        return this.baseWeight;
    }
  }

  /**
   * 每幀套用（在 VRMController.update() 內 mixer.update 後呼叫）。
   */
  applyPerFrame(deltaTime: number): void {
    const chain = this.builtChain;
    if (!chain) return;

    const weight = this.getEffectiveWeight();

    // disable fade-out
    if (this.disablingFade && weight === 0) {
      this.fadeOutToAnimation(deltaTime);
      return;
    }

    if (weight === 0) return;

    const desired = this.targetProvider?.();
    if (!desired) return;

    const smoothed = this.cursorTracker.update(desired, deltaTime);

    // 更新 vrm.lookAt target（VRM 內部處理眼球範圍）
    this.lookAtTarget.position.copy(smoothed);

    // 取得模型根節點的 world forward 當靜態參考軸
    // 用模型 root（含 rotation.y = π 翻轉）的 world forward，不會被
    // 我們上一幀寫進去的 head 旋轉污染 → 沒有回授迴圈
    // 又是 world frame → yaw/pitch 符號直接對應 bone local rotation
    const modelRoot = this.vrmController.getModelRoot();
    if (!modelRoot) return;
    modelRoot.updateWorldMatrix(true, false);

    const modelQuat = new THREE.Quaternion();
    modelRoot.getWorldQuaternion(modelQuat);
    // three-vrm normalized head bone 的 local forward = -Z（搭配 vrm.scene.rotation.y = π
    // 後在 world 是 +Z，朝向 OrthographicCamera 的 z=10）
    // 此參考軸是靜態的 — 不依賴 head 當前 quaternion → 沒有回授迴圈
    const modelForwardWorld = this._tmpV3a
      .set(0, 0, -1)
      .applyQuaternion(modelQuat)
      .normalize();

    const headNode = this.vrmController.getBoneNode('head');
    if (!headNode) return;
    const headWorld = headNode.getWorldPosition(this._tmpV3b);
    const toTarget = this._tmpV3c.copy(smoothed).sub(headWorld);
    if (toTarget.lengthSq() < 1e-6) return;
    toTarget.normalize();

    // 解 ikts 鏈（不影響本演算法輸出，保留 IK 物理意義 + 未來擴充點）
    const firstSpec = chain.bones[0];
    const firstNode = this.vrmController.getBoneNode(firstSpec.vrmBoneName);
    if (firstNode) {
      firstNode.getWorldPosition(this._tmpV3d);
      chain.chain.setBaseLocation(toV3(this._tmpV3d));
    }
    chain.chain.solveForTarget(toV3(smoothed));

    // 算「總旋轉」（world frame）：從模型 world forward 旋轉到 toTarget
    const totalRot = new THREE.Quaternion().setFromUnitVectors(
      modelForwardWorld,
      toTarget,
    );
    this._tmpEuler.setFromQuaternion(totalRot, 'YXZ');
    let totalYaw = this._tmpEuler.y;
    let totalPitch = this._tmpEuler.x;
    const totalRoll = this._tmpEuler.z;

    // 全域 clamp：避免 setFromUnitVectors 在 180° 反向奇異點翻轉
    totalYaw = clampSigned(totalYaw, HeadTrackingController.MAX_TOTAL_YAW);
    totalPitch = clampSigned(totalPitch, HeadTrackingController.MAX_TOTAL_PITCH);

    // 對 upperChest / neck / head 依分配權重套用（順序從 base → tip）
    for (const spec of chain.bones) {
      const boneName = spec.vrmBoneName;
      const node = this.vrmController.getBoneNode(boneName);
      if (!node) continue;

      const ratio = HeadTrackingController.DISTRIBUTION[boneName];
      const range = this.clamp[boneName];

      const yaw = clampSigned(totalYaw * ratio, range.yawMax);
      const pitch = clampSigned(totalPitch * ratio, range.pitchMax);
      const roll = clampSigned(totalRoll * ratio * 0.5, range.rollMax);

      // 期望的 local rotation（在 bone 父座標系內）
      // 由於 vrm.scene.rotation.y = π，bone 的 local X / Z 軸在 world 中是反向的
      // （Y 軸不變），所以套用為 local Euler 時需翻轉 pitch / roll 符號
      // （否則上下/側傾跟視覺直覺相反）
      const desiredLocal = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(-pitch, yaw, -roll, 'YXZ'),
      );

      // 與 mixer 寫入的 local quaternion 加權混合
      // 時間平滑由 MouseCursorTracker 負責（單層即可，多層串聯反而會幾乎不動）
      const animLocal = node.quaternion.clone();
      const finalLocal = animLocal.slerp(desiredLocal, weight);

      this.vrmController.setBoneRotation(boneName, finalLocal);

      let stored = this.lastAppliedQuaternions.get(boneName);
      if (!stored) {
        stored = new THREE.Quaternion();
        this.lastAppliedQuaternions.set(boneName, stored);
      }
      stored.copy(finalLocal);
    }
  }

  /** 停用過程：把套用的旋轉慢慢淡回 mixer 寫入的（動畫）旋轉 */
  private fadeOutToAnimation(deltaTime: number): void {
    if (this.lastAppliedQuaternions.size === 0) {
      this.disablingFade = false;
      return;
    }
    const factor = 1 - Math.exp(-HeadTrackingController.DISABLE_FADE_RATE * deltaTime);
    let stillFading = false;
    for (const [boneName, stored] of this.lastAppliedQuaternions) {
      const node = this.vrmController.getBoneNode(boneName);
      if (!node) continue;
      const animLocal = node.quaternion;
      stored.slerp(animLocal, factor);
      this.vrmController.setBoneRotation(boneName, stored);
      if (1 - Math.abs(stored.dot(animLocal)) > 1e-4) {
        stillFading = true;
      }
    }
    if (!stillFading) {
      this.disablingFade = false;
      this.lastAppliedQuaternions.clear();
    }
  }

  dispose(): void {
    this.lastAppliedQuaternions.clear();
    this.smoothedLocalQuats.clear();
    this.builtChain = null;
  }
}

function clampSigned(value: number, absMax: number): number {
  if (value > absMax) return absMax;
  if (value < -absMax) return -absMax;
  return value;
}
