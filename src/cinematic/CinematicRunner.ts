/**
 * 演出控制器 — 角色衝向鏡頭撞玻璃（搞笑版）
 *
 * 純邏輯模組，不依賴 Three.js。
 * 每幀由 SceneManager 呼叫 tick()，取得 CinematicFrame 後套用到角色與攝影機。
 *
 * 設計重點：
 *   1. 兩段路徑：先衝到螢幕頂部正中央，再從上往下暴衝（增強縱深感）
 *   2. 安全邊界：solveFinalPose 會自動 clamp scale，確保頭部不超出螢幕、
 *      面部位於下半部
 *   3. 鏡頭推拉：用 cameraZoom（ortho 縮小可見區域）模擬透視推進
 *   4. 撞擊節奏：anticipate 蓄力 → dash → impact squash + shake → settle 還原
 *   5. 表情輪換：hold 階段沿用既有的隨機表情循環邏輯
 *
 * 模型 3D 定位以**腳底**為基準：feetY = posY + characterSize.height
 */

import type {
  CinematicConfig,
  CinematicFrame,
  CinematicPhase,
  FinalPoseSolution,
} from '../types/cinematic';

// ── 演出參數常數（可調） ──
const DEFAULT_DESIRED_MAX_SCALE = 6.0;
const DEFAULT_HEAD_HEIGHT_RATIO = 0.22;
const DEFAULT_TOP_PADDING = 24;
const DEFAULT_BOTTOM_PADDING = 16;
const DEFAULT_TARGET_FACE_CENTER_RATIO = 0.7;

// 各階段時長（秒）
const ANTICIPATE_DURATION = 0.5;
const APPROACH_TOP_DURATION = 1.0;
const PAUSE_TOP_DURATION = 0.25;
const DASH_DOWN_DURATION = 0.7;
const IMPACT_DURATION = 0.18;
const SETTLE_DURATION = 0.25;
const RECOIL_DURATION = 0.35;
const RETREAT_DURATION = 1.5;

// 表情輪換
const EXPRESSION_DISPLAY_DURATION = 1.6;
const EXPRESSION_GAP_DURATION = 0.4;
const EXPRESSION_CYCLE = EXPRESSION_DISPLAY_DURATION + EXPRESSION_GAP_DURATION;

// approach-top 階段的 scale
const APPROACH_TOP_SCALE_RATIO = 1.4;
// dash-down 階段攝影機 zoom
const DASH_DOWN_CAMERA_ZOOM_PEAK = 1.6;
// impact squash
const IMPACT_SQUASH_X = 1.18;
const IMPACT_SQUASH_Y = 0.82;
const IMPACT_OVERSHOOT_SCALE = 1.06;
// camera shake
const IMPACT_SHAKE_INTENSITY = 18; // px
const IMPACT_SHAKE_FREQ = 60; // Hz
const IMPACT_SHAKE_DECAY = 14;

// walk 速度倍率
const APPROACH_WALK_SPEED = 1.5;
const DASH_WALK_SPEED = 2.5;
const RETREAT_WALK_SPEED = 1.8;

// ── Easing ──

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** ease-out back：結尾有 overshoot 回彈 */
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/** ease-out elastic：彈簧式還原 */
function easeOutElastic(t: number): number {
  if (t === 0) return 0;
  if (t === 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

/** 線性插值 */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 阻尼震動：sin 載波 × 指數衰減 */
function dampedShake(elapsed: number, intensity: number, freq: number, decay: number): number {
  return intensity * Math.sin(elapsed * freq) * Math.exp(-elapsed * decay);
}

// ── 純函式：幾何約束求解 ──

/**
 * 求解最終定格的 scale 與 Y 座標
 *
 * 約束：
 *   1. 面部中心 ≈ screenHeight × targetFaceCenterRatio（下半部）
 *   2. 頭頂 ≥ topPadding（不超出螢幕頂）
 *   3. 面部底（≈ headTop + headHeight）≤ screenHeight − bottomPadding
 *
 * 模型定位以腳底為基準：feetY = posY + characterHeight × scale
 * 頭頂 = feetY − characterHeight × scale = posY
 * 面部高度 ≈ characterHeight × scale × headHeightRatio
 * 面部中心 ≈ headTop + faceHeight/2 = posY + characterHeight × scale × headHeightRatio / 2
 *
 * 若 desiredMaxScale 會導致頭超出螢幕或面部超出底部，自動降 scale。
 */
export function solveFinalPose(
  screenWidth: number,
  screenHeight: number,
  characterWidth: number,
  characterHeight: number,
  originalScale: number,
  desiredMaxScale: number,
  headHeightRatio: number,
  topPadding: number,
  bottomPadding: number,
  targetFaceCenterRatio: number,
): FinalPoseSolution {
  // 注意：scale 是「相對於 originalScale」的倍率
  // 角色實際視覺高度 = characterHeight × (scale / originalScale)
  // 但 SceneManager 套用時用 baseScale × frame.scaleY，所以 frame.scale 已是
  // 「相對於 baseScale」的比例，這裡 characterHeight 已是 base scale 的視覺高度。

  // 嘗試從 desiredMaxScale 往下找一個安全 scale
  let scale = desiredMaxScale;
  const minScale = Math.max(originalScale * 1.2, 1.5);
  const safeBottom = screenHeight - bottomPadding;
  let finalPosY = 0;

  for (let i = 0; i < 30; i++) {
    const visualHeight = characterHeight * (scale / originalScale);
    const faceHeight = visualHeight * headHeightRatio;
    const targetFaceCenter = screenHeight * targetFaceCenterRatio;

    // 面部中心 = posY + faceHeight/2 = targetFaceCenter
    // → posY (頭頂) = targetFaceCenter − faceHeight/2
    // 注意：posY 在我們的約定裡是「腳底」，所以要再加上 visualHeight
    const headTop = targetFaceCenter - faceHeight / 2;
    const faceBottom = targetFaceCenter + faceHeight / 2;

    // 安全檢查
    const headTopOk = headTop >= topPadding;
    const faceBottomOk = faceBottom <= safeBottom;

    if (headTopOk && faceBottomOk) {
      finalPosY = headTop + visualHeight;
      break;
    }

    // 不安全 → 把 scale 縮小 8%
    scale *= 0.92;
    if (scale < minScale) {
      scale = minScale;
      const visualH = characterHeight * (scale / originalScale);
      const faceH = visualH * headHeightRatio;
      const headTopFinal = Math.max(topPadding, screenHeight * targetFaceCenterRatio - faceH / 2);
      finalPosY = headTopFinal + visualH;
      break;
    }
  }

  const finalPosX = screenWidth / 2 - characterWidth / 2;

  return {
    maxScale: scale,
    finalPosY,
    finalPosX,
  };
}

/**
 * 求解 approach-top 階段的目標位置（螢幕頂部正中央）
 *
 * 角色以 approachTopScaleRatio 倍率呈現，頭頂留有 topPadding 邊距。
 */
export function solveTopMiddle(
  screenWidth: number,
  characterWidth: number,
  characterHeight: number,
  originalScale: number,
  approachTopScaleRatio: number,
  topPadding: number,
): { x: number; y: number } {
  const visualHeight = characterHeight * (approachTopScaleRatio / originalScale);
  // 頭頂 = topPadding → 腳底 = topPadding + visualHeight
  return {
    x: screenWidth / 2 - characterWidth / 2,
    y: topPadding + visualHeight,
  };
}

/** Fisher-Yates shuffle */
function shuffleExpressions(available: string[]): string[] {
  if (available.length === 0) return [];
  const arr = [...available];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── CinematicRunner ──

export class CinematicRunner {
  private phase: CinematicPhase = 'anticipate';
  private phaseElapsed = 0;

  // ── 預先解出的位置 ──
  private readonly startX: number;
  private readonly startY: number;
  private readonly startScale: number;
  private readonly topMiddleX: number;
  private readonly topMiddleY: number;
  private readonly finalX: number;
  private readonly finalY: number;
  private readonly maxScale: number;

  // ── hold 階段表情序列 ──
  private readonly holdExpressions: string[];
  private readonly holdDuration: number;

  /** 是否已在當前 phase 觸發過 SpringBone reset */
  private springBoneResetSent = false;

  constructor(config: CinematicConfig) {
    this.startX = config.originalPosition.x;
    this.startY = config.originalPosition.y;
    this.startScale = config.originalScale;

    const desiredMaxScale = config.desiredMaxScale ?? DEFAULT_DESIRED_MAX_SCALE;
    const headHeightRatio = config.headHeightRatio ?? DEFAULT_HEAD_HEIGHT_RATIO;
    const topPadding = config.topPadding ?? DEFAULT_TOP_PADDING;
    const bottomPadding = config.bottomPadding ?? DEFAULT_BOTTOM_PADDING;
    const targetFaceCenterRatio = config.targetFaceCenterRatio ?? DEFAULT_TARGET_FACE_CENTER_RATIO;

    const finalPose = solveFinalPose(
      config.screenWidth,
      config.screenHeight,
      config.characterWidth,
      config.characterHeight,
      config.originalScale,
      desiredMaxScale,
      headHeightRatio,
      topPadding,
      bottomPadding,
      targetFaceCenterRatio,
    );
    this.finalX = finalPose.finalPosX;
    this.finalY = finalPose.finalPosY;
    this.maxScale = finalPose.maxScale;

    const top = solveTopMiddle(
      config.screenWidth,
      config.characterWidth,
      config.characterHeight,
      config.originalScale,
      APPROACH_TOP_SCALE_RATIO,
      topPadding,
    );
    this.topMiddleX = top.x;
    this.topMiddleY = top.y;

    this.holdExpressions = shuffleExpressions(config.availableExpressions);
    this.holdDuration =
      this.holdExpressions.length > 0
        ? this.holdExpressions.length * EXPRESSION_CYCLE
        : 2.0;
  }

  /** 演出是否已結束 */
  isFinished(): boolean {
    return this.phase === 'done';
  }

  /** 取得計算出的 maxScale（測試用） */
  getMaxScale(): number {
    return this.maxScale;
  }

  /** 取得最終定格位置（測試用） */
  getFinalPosition(): { x: number; y: number } {
    return { x: this.finalX, y: this.finalY };
  }

  /** 取得 top-middle 位置（測試用） */
  getTopMiddlePosition(): { x: number; y: number } {
    return { x: this.topMiddleX, y: this.topMiddleY };
  }

  /**
   * 每幀更新，回傳當前演出狀態
   * @param deltaTime 幀間時間（秒）
   */
  tick(deltaTime: number): CinematicFrame {
    this.phaseElapsed += deltaTime;

    switch (this.phase) {
      case 'anticipate':
        return this.tickAnticipate();
      case 'approach-top':
        return this.tickApproachTop();
      case 'pause-top':
        return this.tickPauseTop();
      case 'dash-down':
        return this.tickDashDown();
      case 'impact':
        return this.tickImpact();
      case 'settle':
        return this.tickSettle();
      case 'hold':
        return this.tickHold();
      case 'recoil':
        return this.tickRecoil();
      case 'retreat':
        return this.tickRetreat();
      case 'done':
        return this.makeDoneFrame();
    }
  }

  // ── 各階段 tick ──

  private tickAnticipate(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / ANTICIPATE_DURATION);
    // 輕微 squashY：1.0 → 0.92 → 1.0（用 sin 形成單峰）
    const squash = 1 - 0.08 * Math.sin(t * Math.PI);

    if (t >= 1) {
      this.advancePhase('approach-top');
    }

    return this.makeFrame({
      scaleX: this.startScale,
      scaleY: this.startScale * squash,
      scaleZ: this.startScale,
      positionX: this.startX,
      positionY: this.startY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: 1.0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'anticipate',
      expression: null,
    });
  }

  private tickApproachTop(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / APPROACH_TOP_DURATION);
    const eased = easeInOutCubic(t);
    const targetScale = this.startScale * APPROACH_TOP_SCALE_RATIO;
    const scale = lerp(this.startScale, targetScale, eased);
    const posX = lerp(this.startX, this.topMiddleX, eased);
    const posY = lerp(this.startY, this.topMiddleY, eased);
    const cameraZoom = lerp(1.0, 1.05, eased);

    if (t >= 1) {
      this.advancePhase('pause-top');
    }

    return this.makeFrame({
      scaleX: scale,
      scaleY: scale,
      scaleZ: scale,
      positionX: posX,
      positionY: posY,
      facingReversed: false,
      walkSpeed: APPROACH_WALK_SPEED,
      cameraZoom,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'approach-top',
      expression: null,
    });
  }

  private tickPauseTop(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / PAUSE_TOP_DURATION);
    const targetScale = this.startScale * APPROACH_TOP_SCALE_RATIO;

    if (t >= 1) {
      this.advancePhase('dash-down');
    }

    return this.makeFrame({
      scaleX: targetScale,
      scaleY: targetScale,
      scaleZ: targetScale,
      positionX: this.topMiddleX,
      positionY: this.topMiddleY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: 1.05,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'pause-top',
      expression: null,
    });
  }

  private tickDashDown(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / DASH_DOWN_DURATION);
    const eased = easeInCubic(t);
    const startScale = this.startScale * APPROACH_TOP_SCALE_RATIO;
    const scale = lerp(startScale, this.maxScale, eased);
    const posX = lerp(this.topMiddleX, this.finalX, eased);
    const posY = lerp(this.topMiddleY, this.finalY, eased);
    const cameraZoom = lerp(1.05, DASH_DOWN_CAMERA_ZOOM_PEAK, eased);

    if (t >= 1) {
      this.advancePhase('impact');
      // 進入 impact 時先發送一次 SpringBone reset
      this.springBoneResetSent = false;
    }

    return this.makeFrame({
      scaleX: scale,
      scaleY: scale,
      scaleZ: scale,
      positionX: posX,
      positionY: posY,
      facingReversed: false,
      walkSpeed: DASH_WALK_SPEED,
      cameraZoom,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'dash-down',
      expression: null,
    });
  }

  private tickImpact(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / IMPACT_DURATION);
    // overshoot scale 在前 30% 達到 peak 然後回穩
    const overshootCurve = t < 0.3 ? t / 0.3 : 1 - (t - 0.3) / 0.7;
    const overshoot = 1 + (IMPACT_OVERSHOOT_SCALE - 1) * overshootCurve;
    // squash 在 t=0.4 達到峰值
    const squashCurve = Math.sin(clamp01(t / 0.7) * Math.PI);
    const scaleX = this.maxScale * overshoot * lerp(1, IMPACT_SQUASH_X, squashCurve);
    const scaleY = this.maxScale * overshoot * lerp(1, IMPACT_SQUASH_Y, squashCurve);
    const scaleZ = this.maxScale * overshoot;

    // shake 沿用 dampedShake，X / Y 不同相位
    const shakeX = dampedShake(
      this.phaseElapsed,
      IMPACT_SHAKE_INTENSITY,
      IMPACT_SHAKE_FREQ,
      IMPACT_SHAKE_DECAY,
    );
    const shakeY = dampedShake(
      this.phaseElapsed + 0.05,
      IMPACT_SHAKE_INTENSITY * 0.8,
      IMPACT_SHAKE_FREQ * 1.1,
      IMPACT_SHAKE_DECAY,
    );

    const springReset = !this.springBoneResetSent;
    if (springReset) {
      this.springBoneResetSent = true;
    }

    if (t >= 1) {
      this.advancePhase('settle');
    }

    return this.makeFrame({
      scaleX,
      scaleY,
      scaleZ,
      positionX: this.finalX,
      positionY: this.finalY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: DASH_DOWN_CAMERA_ZOOM_PEAK,
      cameraShakeX: shakeX,
      cameraShakeY: shakeY,
      phase: 'impact',
      expression: null,
      springBoneReset: springReset,
    });
  }

  private tickSettle(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / SETTLE_DURATION);
    const eased = easeOutElastic(t);
    // 從 squash 還原到等向 maxScale
    const scaleX = lerp(this.maxScale * IMPACT_SQUASH_X, this.maxScale, eased);
    const scaleY = lerp(this.maxScale * IMPACT_SQUASH_Y, this.maxScale, eased);

    // shake 殘餘
    const shakeX = dampedShake(
      this.phaseElapsed + IMPACT_DURATION,
      IMPACT_SHAKE_INTENSITY,
      IMPACT_SHAKE_FREQ,
      IMPACT_SHAKE_DECAY,
    );
    const shakeY = dampedShake(
      this.phaseElapsed + IMPACT_DURATION + 0.05,
      IMPACT_SHAKE_INTENSITY * 0.8,
      IMPACT_SHAKE_FREQ * 1.1,
      IMPACT_SHAKE_DECAY,
    );

    if (t >= 1) {
      this.advancePhase('hold');
    }

    return this.makeFrame({
      scaleX,
      scaleY,
      scaleZ: this.maxScale,
      positionX: this.finalX,
      positionY: this.finalY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: DASH_DOWN_CAMERA_ZOOM_PEAK,
      cameraShakeX: shakeX,
      cameraShakeY: shakeY,
      phase: 'settle',
      expression: null,
    });
  }

  private tickHold(): CinematicFrame {
    if (this.phaseElapsed >= this.holdDuration) {
      this.advancePhase('recoil');
    }

    let expression: string | null = null;
    if (this.holdExpressions.length > 0) {
      const cycleIndex = Math.floor(this.phaseElapsed / EXPRESSION_CYCLE);
      const cycleTime = this.phaseElapsed % EXPRESSION_CYCLE;
      if (
        cycleIndex < this.holdExpressions.length &&
        cycleTime < EXPRESSION_DISPLAY_DURATION
      ) {
        expression = this.holdExpressions[cycleIndex];
      }
    }

    return this.makeFrame({
      scaleX: this.maxScale,
      scaleY: this.maxScale,
      scaleZ: this.maxScale,
      positionX: this.finalX,
      positionY: this.finalY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: DASH_DOWN_CAMERA_ZOOM_PEAK,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'hold',
      expression,
    });
  }

  private tickRecoil(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / RECOIL_DURATION);
    const eased = easeOutCubic(t);
    const scale = lerp(this.maxScale, this.maxScale * 0.9, eased);
    const posY = lerp(this.finalY, this.finalY - 30, eased);
    const cameraZoom = lerp(DASH_DOWN_CAMERA_ZOOM_PEAK, 1.5, eased);

    if (t >= 1) {
      this.advancePhase('retreat');
      this.springBoneResetSent = false;
    }

    return this.makeFrame({
      scaleX: scale,
      scaleY: scale,
      scaleZ: scale,
      positionX: this.finalX,
      positionY: posY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'recoil',
      expression: null,
    });
  }

  private tickRetreat(): CinematicFrame {
    const t = clamp01(this.phaseElapsed / RETREAT_DURATION);
    const eased = easeOutBack(t);
    const startScale = this.maxScale * 0.9;
    const scale = lerp(startScale, this.startScale, clamp01(eased));
    const posX = lerp(this.finalX, this.startX, eased);
    const posY = lerp(this.finalY - 30, this.startY, eased);
    const cameraZoom = lerp(1.5, 1.0, easeOutCubic(t));

    // 進入 retreat 時送一次 SpringBone reset（從 maxScale 大幅縮小）
    const springReset = !this.springBoneResetSent;
    if (springReset) {
      this.springBoneResetSent = true;
    }

    if (t >= 1) {
      this.advancePhase('done');
    }

    return this.makeFrame({
      scaleX: scale,
      scaleY: scale,
      scaleZ: scale,
      positionX: posX,
      positionY: posY,
      facingReversed: true,
      walkSpeed: RETREAT_WALK_SPEED,
      cameraZoom,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'retreat',
      expression: null,
      springBoneReset: springReset,
    });
  }

  private makeDoneFrame(): CinematicFrame {
    return this.makeFrame({
      scaleX: this.startScale,
      scaleY: this.startScale,
      scaleZ: this.startScale,
      positionX: this.startX,
      positionY: this.startY,
      facingReversed: false,
      walkSpeed: 0,
      cameraZoom: 1.0,
      cameraShakeX: 0,
      cameraShakeY: 0,
      phase: 'done',
      expression: null,
    });
  }

  private makeFrame(partial: Omit<CinematicFrame, 'springBoneReset'> & {
    springBoneReset?: boolean;
  }): CinematicFrame {
    return {
      ...partial,
      springBoneReset: partial.springBoneReset ?? false,
    };
  }

  private advancePhase(next: CinematicPhase): void {
    this.phase = next;
    this.phaseElapsed = 0;
  }
}
