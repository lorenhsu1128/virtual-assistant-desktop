/**
 * 演出控制器 — 角色衝向鏡頭大臉貼螢幕
 *
 * 純邏輯模組，不依賴 Three.js。
 * 每幀由 SceneManager 呼叫 tick()，取得 CinematicFrame 後套用到角色。
 *
 * 重要：模型 3D 定位以腳底為基準（SceneManager.updateModelWorldPosition
 * 使用 posY + characterSize.height 作為腳底位置），放大時模型從腳底向上延伸。
 * 因此 endY 需要大幅下移，讓放大後的頭部落在螢幕中央。
 *
 * 時間軸：
 *   run-in  (~2.5s) — 從當前位置衝向螢幕中央，scale 逐漸放大
 *   hold    (~1.5s) — 大臉停留
 *   run-out (~2.0s) — 轉身跑回原位
 *   done           — 演出結束，恢復原狀
 */

import type { CinematicConfig, CinematicFrame, CinematicPhase } from '../types/cinematic';

/** 演出參數常數（可調） */
const SCALE_MAX = 6.0;
const RUN_IN_DURATION = 2.5;
/** hold 階段表情參數 */
const EXPRESSION_DISPLAY_DURATION = 2.0;
const EXPRESSION_GAP_DURATION = 1.0;
const EXPRESSION_CYCLE = EXPRESSION_DISPLAY_DURATION + EXPRESSION_GAP_DURATION;
const RUN_OUT_DURATION = 2.0;
const WALK_SPEED_MULTIPLIER = 2.0;

/** easeInQuad：加速感（跑向鏡頭） */
function easeInQuad(t: number): number {
  return t * t;
}

/** easeOutQuad：減速感（跑離鏡頭） */
function easeOutQuad(t: number): number {
  return 1 - (1 - t) * (1 - t);
}

export class CinematicRunner {
  private readonly config: CinematicConfig;
  private phase: CinematicPhase = 'run-in';
  private phaseElapsed = 0;

  /** 起始位置（角色當前位置） */
  private readonly startX: number;
  private readonly startY: number;
  /** 起始 scale（角色當前 scale） */
  private readonly startScale: number;
  /** 結束 X（螢幕水平置中） */
  private readonly endX: number;
  /** 結束 Y（腳底位置，讓放大後頭部在螢幕中央） */
  private readonly endY: number;
  /** hold 階段隨機選取的表情序列 */
  private readonly holdExpressions: string[];
  /** hold 階段總時長（動態計算） */
  private readonly holdDuration: number;

  constructor(config: CinematicConfig) {
    this.config = config;

    // 起始：角色當前位置和 scale
    this.startX = config.originalPosition.x;
    this.startY = config.originalPosition.y;
    this.startScale = config.originalScale;

    // 結束 X：螢幕水平置中
    this.endX = config.screenWidth / 2 - config.characterWidth / 2;

    // 結束 Y：讓放大後的頭部在螢幕中央
    // 模型定位以腳底為基準：feetY = posY + characterSize.height
    // 放大後模型視覺高度 = characterSize.height * (SCALE_MAX / originalScale)
    // 頭部位置 = feetY - 視覺高度 = posY + charH - charH * (SCALE_MAX / originalScale)
    //          = posY + charH * (1 - SCALE_MAX / originalScale)
    // 要讓頭部 ≈ 螢幕中心：
    //   screenH/2 = posY + charH * (1 - SCALE_MAX / originalScale)
    //   posY = screenH/2 - charH * (1 - SCALE_MAX / originalScale)
    //        = screenH/2 + charH * (SCALE_MAX / originalScale - 1)
    const scaleRatio = SCALE_MAX / config.originalScale;
    this.endY = config.screenHeight / 2 + config.characterHeight * (scaleRatio - 1);

    // 隨機選取 hold 階段的表情（不重複）
    this.holdExpressions = this.shuffleExpressions(config.availableExpressions);
    // hold 時長 = 表情數 × (顯示 + 間隔)，無表情時保持最低 2 秒
    this.holdDuration = this.holdExpressions.length > 0
      ? this.holdExpressions.length * EXPRESSION_CYCLE
      : 2.0;
  }

  /** 隨機打亂表情順序 */
  private shuffleExpressions(available: string[]): string[] {
    if (available.length === 0) return [];
    return [...available].sort(() => Math.random() - 0.5);
  }

  /**
   * 每幀更新，回傳當前演出狀態
   * @param deltaTime 幀間時間（秒）
   */
  tick(deltaTime: number): CinematicFrame {
    this.phaseElapsed += deltaTime;

    switch (this.phase) {
      case 'run-in':
        return this.tickRunIn();
      case 'hold':
        return this.tickHold();
      case 'run-out':
        return this.tickRunOut();
      case 'done':
        return this.makeDoneFrame();
    }
  }

  /** 演出是否已結束 */
  isFinished(): boolean {
    return this.phase === 'done';
  }

  private tickRunIn(): CinematicFrame {
    const t = Math.min(this.phaseElapsed / RUN_IN_DURATION, 1);
    const eased = easeInQuad(t);

    const scale = this.startScale + (SCALE_MAX - this.startScale) * eased;
    const posX = this.startX + (this.endX - this.startX) * eased;
    const posY = this.startY + (this.endY - this.startY) * eased;

    if (t >= 1) {
      this.advancePhase('hold');
    }

    return {
      scale,
      positionX: posX,
      positionY: posY,
      facingReversed: false,
      walkSpeed: WALK_SPEED_MULTIPLIER,
      phase: 'run-in',
      expression: null,
    };
  }

  private tickHold(): CinematicFrame {
    if (this.phaseElapsed >= this.holdDuration) {
      this.advancePhase('run-out');
    }

    // 計算當前應顯示的表情
    let expression: string | null = null;
    if (this.holdExpressions.length > 0) {
      const cycleIndex = Math.floor(this.phaseElapsed / EXPRESSION_CYCLE);
      const cycleTime = this.phaseElapsed % EXPRESSION_CYCLE;
      if (cycleIndex < this.holdExpressions.length && cycleTime < EXPRESSION_DISPLAY_DURATION) {
        expression = this.holdExpressions[cycleIndex];
      }
    }

    return {
      scale: SCALE_MAX,
      positionX: this.endX,
      positionY: this.endY,
      facingReversed: false,
      walkSpeed: 0,
      phase: 'hold',
      expression,
    };
  }

  private tickRunOut(): CinematicFrame {
    const t = Math.min(this.phaseElapsed / RUN_OUT_DURATION, 1);
    const eased = easeOutQuad(t);

    // 反向：從 end → start
    const scale = SCALE_MAX - (SCALE_MAX - this.startScale) * eased;
    const posX = this.endX + (this.startX - this.endX) * eased;
    const posY = this.endY + (this.startY - this.endY) * eased;

    if (t >= 1) {
      this.advancePhase('done');
    }

    return {
      scale,
      positionX: posX,
      positionY: posY,
      facingReversed: true,
      walkSpeed: WALK_SPEED_MULTIPLIER,
      phase: 'run-out',
      expression: null,
    };
  }

  private makeDoneFrame(): CinematicFrame {
    return {
      scale: this.config.originalScale,
      positionX: this.config.originalPosition.x,
      positionY: this.config.originalPosition.y,
      facingReversed: false,
      walkSpeed: 0,
      phase: 'done',
      expression: null,
    };
  }

  private advancePhase(next: CinematicPhase): void {
    this.phase = next;
    this.phaseElapsed = 0;
  }
}
