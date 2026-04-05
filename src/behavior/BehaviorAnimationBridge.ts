import type { AnimationManager } from '../animation/AnimationManager';
import type { BehaviorOutput, BehaviorState } from '../types/behavior';
import type { AnimationCategory } from '../types/animation';

/** 行為狀態→動畫分類映射 */
const STATE_TO_CATEGORY: Record<BehaviorState, AnimationCategory> = {
  idle: 'idle',
  walk: 'idle', // 行走時使用 idle 動畫（移動是視窗層級，非 3D 動畫）
  sit: 'sit',
  peek: 'peek',
  fall: 'fall',
  drag: 'idle', // 拖曳時使用 idle 動畫
};

/**
 * 行為→動畫橋接
 *
 * 監聽 StateMachine 的狀態變化，將行為狀態對應到動畫分類，
 * 呼叫 AnimationManager 播放對應動畫。
 *
 * 設計原則：StateMachine 不直接呼叫 AnimationManager，
 * 中間由此模組做映射，兩邊可各自獨立修改。
 */
export class BehaviorAnimationBridge {
  private animationManager: AnimationManager;

  constructor(animationManager: AnimationManager) {
    this.animationManager = animationManager;
  }

  /**
   * 每幀更新
   *
   * 由 SceneManager 在 StateMachine.tick() 之後呼叫。
   * 僅在狀態變化時觸發動畫切換。
   */
  update(output: BehaviorOutput): void {
    // 系統動畫播放中，跳過一般狀態→動畫切換
    if (this.animationManager.isSystemAnimationPlaying()) return;

    // 狀態變化時切換動畫
    if (!output.stateChanged) return;

    const category = STATE_TO_CATEGORY[output.currentState];

    // 嘗試播放對應分類；無動畫時 fallback 到 idle
    if (!this.animationManager.playByCategory(category)) {
      if (category !== 'idle') {
        this.animationManager.playByCategory('idle');
      }
    }
  }
}
