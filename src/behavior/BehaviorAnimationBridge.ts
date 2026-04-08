import type * as THREE from 'three';
import type { AnimationManager } from '../animation/AnimationManager';
import type { StateMachine } from './StateMachine';
import type { BehaviorOutput, BehaviorState } from '../types/behavior';
import type { SystemAnimationState } from '../types/animation';

/**
 * 行為狀態 → 系統動畫池 的對照
 *
 * 所有狀態都透過 AnimationManager.playStateRandom 從對應狀態池隨機取一支。
 * idle 不在此表：idle 由 AnimationManager 內部以 LoopOnce + finished 事件
 * 自動接力，Bridge 只需呼叫 stopStateAnimation（若從其他狀態轉回）。
 */
const STATE_TO_POOL: Partial<Record<BehaviorState, SystemAnimationState>> = {
  walk: 'walk',
  hide: 'hide',
  sit: 'sit',
  drag: 'drag',
  peek: 'peek',
  fall: 'fall',
};

/**
 * walk / hide 狀態切換時觸發的 callback 型別
 *
 * 由 SceneManager 注入，在收到 picked clip 後執行 `analyzeWalkAnimation`
 * 並把結果（stepLength, worldSpeed）推回 StateMachine。
 * 讓每次切換 walk 動畫都能依該 clip 的實際步伐更新移動速度。
 */
export type WalkClipPickedCallback = (clip: THREE.AnimationClip) => void;

/**
 * 行為→動畫橋接
 *
 * 監聽 StateMachine 的狀態變化，將行為狀態對應到系統動畫池，
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
  /** walk/hide 狀態切換時的 callback（通常用於步伐重分析） */
  private onWalkClipPicked: WalkClipPickedCallback | null = null;

  constructor(
    animationManager: AnimationManager,
    stateMachine?: StateMachine,
    onWalkClipPicked?: WalkClipPickedCallback,
  ) {
    this.animationManager = animationManager;
    this.stateMachine = stateMachine ?? null;
    this.onWalkClipPicked = onWalkClipPicked ?? null;
  }

  /** 設定 walk/hide 狀態切換 callback（事後注入用） */
  setWalkClipPickedCallback(callback: WalkClipPickedCallback | null): void {
    this.onWalkClipPicked = callback;
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

    const currentState = output.currentState;

    // 回到 idle → 停止狀態動畫，由 AnimationManager 接管 idle 輪播
    if (currentState === 'idle') {
      this.animationManager.stopStateAnimation();
      return;
    }

    const poolState = STATE_TO_POOL[currentState];
    if (!poolState) {
      console.warn(`[BehaviorBridge] no pool mapping for state: ${currentState}`);
      return;
    }

    // peek 狀態：根據 peekSide 選擇左右
    if (poolState === 'peek') {
      const side = this.lastPeekSide ?? 'right';
      const picked = this.animationManager.playStateRandom('peek', side);
      if (picked && this.stateMachine) {
        // 用實際動畫長度覆蓋 StateMachine 的 peek duration
        this.stateMachine.setStateDuration(picked.clip.duration);
      } else if (!picked) {
        console.warn('[BehaviorBridge] peek pool empty, no animation played');
      }
      return;
    }

    // walk / hide 狀態：播放後呼叫 callback 重新分析步伐
    if (poolState === 'walk' || poolState === 'hide') {
      const picked = this.animationManager.playStateRandom(poolState);
      if (picked) {
        this.onWalkClipPicked?.(picked.clip);
      } else {
        console.warn(`[BehaviorBridge] ${poolState} pool empty, no animation played`);
      }
      return;
    }

    // sit / drag / fall 等其他狀態：直接播放對應池
    const picked = this.animationManager.playStateRandom(poolState);
    if (!picked) {
      console.warn(`[BehaviorBridge] ${poolState} pool empty, no animation played`);
    }
  }
}
