import type { AnimationManager } from '../animation/AnimationManager';
import type { BehaviorOutput, BehaviorState } from '../types/behavior';
import type { AnimationCategory } from '../types/animation';

/** 行為狀態→動畫分類映射 */
const STATE_TO_CATEGORY: Record<BehaviorState, AnimationCategory> = {
  idle: 'idle',
  walk: 'idle', // walk 由系統動畫處理，fallback 到 idle
  sit: 'sit',
  peek: 'peek',
  fall: 'fall',
  drag: 'idle', // drag 由系統動畫處理，fallback 到 idle
};

/** 需要系統動畫的狀態（sit 使用隨機選取，見 pickSitAnimation） */
const STATE_TO_SYSTEM_ANIMATION: Partial<Record<BehaviorState, string>> = {
  walk: 'walk',
  drag: 'drag',
};

/** sit 動畫名稱（隨機選取） */
const SIT_ANIMATION_NAMES = [
  'sit_01', 'sit_02', 'sit_03', 'sit_04', 'sit_05', 'sit_06', 'sit_07',
];

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
    if (!output.stateChanged) return;

    // sit 狀態：隨機選取一個 sit 動畫
    if (output.currentState === 'sit') {
      const sitAnim = SIT_ANIMATION_NAMES[Math.floor(Math.random() * SIT_ANIMATION_NAMES.length)];
      this.animationManager.playSystemAnimation(sitAnim);
      return;
    }

    // 檢查是否需要系統動畫
    const systemAnim = STATE_TO_SYSTEM_ANIMATION[output.currentState];
    if (systemAnim) {
      if (!this.animationManager.isSystemAnimationPlaying()) {
        this.animationManager.playSystemAnimation(systemAnim);
      }
      return;
    }

    // 離開系統動畫狀態 → 停止系統動畫
    if (this.animationManager.isSystemAnimationPlaying()) {
      this.animationManager.stopSystemAnimation();
      return; // stopSystemAnimation 會恢復先前動畫
    }

    // 一般狀態→動畫分類映射
    const category = STATE_TO_CATEGORY[output.currentState];
    if (!this.animationManager.playByCategory(category)) {
      if (category !== 'idle') {
        this.animationManager.playByCategory('idle');
      }
    }
  }
}
