import type { VRMController } from '../core/VRMController';
import { Quaternion, Euler } from 'three';

/** 呼吸動畫參數 */
const BREATH_SPEED = 1.5; // 呼吸頻率（Hz 的一半，因為用 sin）
const BREATH_AMPLITUDE = 0.015; // 胸部骨骼上下幅度（弧度）

/** 眨眼動畫參數 */
const BLINK_INTERVAL_MIN = 3.0; // 最短眨眼間隔（秒）
const BLINK_INTERVAL_MAX = 7.0; // 最長眨眼間隔（秒）
const BLINK_DURATION = 0.15; // 眨眼持續時間（秒）

/**
 * 內建 fallback 動畫
 *
 * 純程式碼驅動的呼吸（胸部骨骼正弦波上下）與眨眼（BlendShape 週期觸發）。
 * 當 AnimationManager 無可用 idle 動畫時啟用。
 */
export class FallbackAnimation {
  private vrmController: VRMController;
  private active = false;

  /** 呼吸用的時間累計 */
  private breathTime = 0;

  /** 眨眼計時器 */
  private blinkTimer = 0;
  private blinkInterval = 0;
  private blinkProgress = -1; // -1 = 非眨眼中

  /** 暫存用的四元數 */
  private tempQuaternion = new Quaternion();
  private tempEuler = new Euler();

  constructor(vrmController: VRMController) {
    this.vrmController = vrmController;
    this.resetBlinkInterval();
  }

  /** 啟動 fallback 動畫 */
  start(): void {
    this.active = true;
    this.breathTime = 0;
    this.blinkTimer = 0;
    this.blinkProgress = -1;
    this.resetBlinkInterval();
  }

  /** 停止 fallback 動畫 */
  stop(): void {
    this.active = false;
    // 重置表情
    this.vrmController.setBlendShape('blink', 0);
  }

  /**
   * 更新 fallback 動畫
   *
   * 由 SceneManager render loop 呼叫。
   */
  update(deltaTime: number): void {
    if (!this.active) return;

    this.updateBreathing(deltaTime);
    this.updateBlinking(deltaTime);
  }

  /** 呼吸動畫 — 胸部骨骼微幅正弦波上下 */
  private updateBreathing(deltaTime: number): void {
    this.breathTime += deltaTime;

    const breathValue = Math.sin(this.breathTime * BREATH_SPEED * Math.PI * 2) * BREATH_AMPLITUDE;

    // 設定胸部骨骼的微幅旋轉（模擬呼吸起伏）
    this.tempEuler.set(breathValue, 0, 0);
    this.tempQuaternion.setFromEuler(this.tempEuler);
    this.vrmController.setBoneRotation('upperChest', this.tempQuaternion);
  }

  /** 眨眼動畫 — 週期性觸發 BlendShape */
  private updateBlinking(deltaTime: number): void {
    if (this.blinkProgress >= 0) {
      // 眨眼進行中
      this.blinkProgress += deltaTime;

      if (this.blinkProgress >= BLINK_DURATION) {
        // 眨眼結束
        this.vrmController.setBlendShape('blink', 0);
        this.blinkProgress = -1;
        this.resetBlinkInterval();
      } else {
        // 眨眼中：三角波 0→1→0
        const t = this.blinkProgress / BLINK_DURATION;
        const blinkValue = t < 0.5 ? t * 2 : (1 - t) * 2;
        this.vrmController.setBlendShape('blink', blinkValue);
      }
    } else {
      // 等待下次眨眼
      this.blinkTimer += deltaTime;
      if (this.blinkTimer >= this.blinkInterval) {
        this.blinkProgress = 0;
        this.blinkTimer = 0;
      }
    }
  }

  /** 重置眨眼間隔 */
  private resetBlinkInterval(): void {
    this.blinkInterval =
      BLINK_INTERVAL_MIN + Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN);
  }
}
