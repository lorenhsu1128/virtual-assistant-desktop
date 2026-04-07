import type { AnimationManager } from '../animation/AnimationManager';
import type { StateMachine } from './StateMachine';
import type { BehaviorOutput, BehaviorState } from '../types/behavior';
import type { AnimationCategory } from '../types/animation';

/** 行為狀態→動畫分類映射 */
const STATE_TO_CATEGORY: Record<BehaviorState, AnimationCategory> = {
  idle: 'idle',
  walk: 'idle', // walk 由系統動畫處理，fallback 到 idle
  sit: 'sit',
  hide: 'idle', // hide 由系統動畫處理（walk），fallback 到 idle
  peek: 'peek',
  fall: 'fall',
  drag: 'idle', // drag 由系統動畫處理，fallback 到 idle
};

/** 需要系統動畫的狀態（sit 使用隨機選取，見 pickSitAnimation） */
const STATE_TO_SYSTEM_ANIMATION: Partial<Record<BehaviorState, string>> = {
  walk: 'walk',
  hide: 'walk', // hide 移動階段使用 walk 動畫（到達邊緣後雖仍播放，但角色已藏在視窗後不可見）
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
  private stateMachine: StateMachine | null;
  /** 最新的 peekSide（用於系統動畫選擇） */
  private lastPeekSide: 'left' | 'right' | null = null;

  constructor(animationManager: AnimationManager, stateMachine?: StateMachine) {
    this.animationManager = animationManager;
    this.stateMachine = stateMachine ?? null;
  }

  /**
   * 每幀更新
   *
   * 由 SceneManager 在 StateMachine.tick() 之後呼叫。
   * 僅在狀態變化時觸發動畫切換。
   */
  update(output: BehaviorOutput): void {
    // 追蹤最新 peekSide
    if (output.peekSide !== undefined) {
      this.lastPeekSide = output.peekSide;
    }

    if (!output.stateChanged) return;

    // peek 狀態：根據 peekSide 選擇左右系統動畫，用 clip duration 設定狀態持續時間
    if (output.currentState === 'peek' && this.lastPeekSide) {
      const peekAnim = this.lastPeekSide === 'left'
        ? 'hide_show_loop_left'
        : 'hide_show_loop_right';
      this.animationManager.playSystemAnimation(peekAnim, false, 0.5);

      // 用實際動畫長度覆蓋 StateMachine 的 peek duration
      const clip = this.animationManager.getSystemAnimationClip(peekAnim);
      if (clip && this.stateMachine) {
        this.stateMachine.setStateDuration(clip.duration);
      }
      return;
    }

    // sit 狀態：隨機選取一個 sit 動畫（站姿到坐姿差異最大，用最長 crossfade）
    if (output.currentState === 'sit') {
      const sitAnim = SIT_ANIMATION_NAMES[Math.floor(Math.random() * SIT_ANIMATION_NAMES.length)];
      // 診斷：sit 狀態渲染消失 bug 調查用，記錄選中的動畫名
      console.log('[BehaviorBridge] sit → playing system animation:', sitAnim);
      // 與 AnimationManager.getCrossfadeDurationFor('sit') = 1.5 對齊
      this.animationManager.playSystemAnimation(sitAnim, true, 1.5);
      return;
    }

    // 檢查是否需要系統動畫（stateChanged 已在上方過濾，直接播放）
    const systemAnim = STATE_TO_SYSTEM_ANIMATION[output.currentState];
    if (systemAnim) {
      this.animationManager.playSystemAnimation(systemAnim);
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
