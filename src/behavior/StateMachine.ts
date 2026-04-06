import type {
  BehaviorState,
  BehaviorOutput,
  BehaviorInput,
  BehaviorConfig,
} from '../types/behavior';
import { DEFAULT_BEHAVIOR_CONFIG } from '../types/behavior';

/**
 * 自主移動行為狀態機
 *
 * 純邏輯模組 —— 不 import Three.js、不 import Tauri、不直接操作動畫。
 * 每幀接收 BehaviorInput + CollisionResult，輸出 BehaviorOutput。
 * 狀態→動畫的映射由 BehaviorAnimationBridge 負責。
 */
export class StateMachine {
  private state: BehaviorState = 'idle';
  private previousState: BehaviorState = 'idle';
  private paused = false;
  private config: BehaviorConfig;

  // 計時器
  private stateTimer = 0;
  private stateDuration = 0;

  // walk 狀態
  private walkTarget: { x: number; y: number } | null = null;
  private facingDirection = 1;

  // 速率倍率
  private speedMultiplier = 1.0;

  // forceState 觸發的狀態變化（tick early return 時回報）
  private pendingStateChange = false;

  // sit 狀態
  private attachedWindowHwnd: number | null = null;
  /** sit 時角色相對於視窗左邊的 X 偏移（邏輯像素），用於跟隨視窗移動時保持相對位置 */
  private sitWindowOffsetX = 0;
  /** 當前坐在的平面 ID（未來用於多平面識別） */
  sitPlatformId: string | null = null;

  // peek 狀態
  private peekTargetHwnd: number | null = null;

  // fall 狀態
  private fallSpeed = 0;

  constructor(config?: Partial<BehaviorConfig>) {
    this.config = { ...DEFAULT_BEHAVIOR_CONFIG, ...config };
    this.enterState('idle');
  }

  /**
   * 每幀更新
   *
   * 由 SceneManager render loop 呼叫。
   */
  tick(input: BehaviorInput): BehaviorOutput {
    const prevState = this.state;

    if (this.paused || this.state === 'drag') {
      const changed = this.pendingStateChange;
      this.pendingStateChange = false;
      return this.makeOutput(changed, null);
    }

    this.stateTimer += input.deltaTime;

    switch (this.state) {
      case 'idle':
        this.tickIdle(input);
        break;
      case 'walk':
        this.tickWalk(input);
        break;
      case 'sit':
        this.tickSit(input);
        break;
      case 'peek':
        this.tickPeek(input);
        break;
      case 'fall':
        this.tickFall(input);
        break;
    }

    const stateChanged = this.state !== prevState || this.pendingStateChange;
    this.pendingStateChange = false;

    const targetPosition = this.getTargetPosition(input);

    return this.makeOutput(stateChanged, targetPosition);
  }

  /** 暫停自主移動 */
  pause(): void {
    this.paused = true;
  }

  /** 恢復自主移動 */
  resume(): void {
    this.paused = false;
  }

  /** 強制切換狀態（由 DragHandler 等外部模組呼叫） */
  forceState(state: BehaviorState): void {
    this.enterState(state);
    this.pendingStateChange = true;
  }

  /** 取得當前狀態 */
  getState(): BehaviorState {
    return this.state;
  }

  /** 是否已暫停 */
  isPaused(): boolean {
    return this.paused;
  }

  /** 設定移動速率倍率 */
  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  /** 取得移動速率倍率 */
  getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  /** Debug: 取得計時器資訊 */
  getDebugTimers(): { timer: number; duration: number } {
    return { timer: this.stateTimer, duration: this.stateDuration };
  }

  /**
   * 設定吸附的視窗
   *
   * @param windowOffsetX 角色 bounding box 左邊相對於視窗左邊的偏移（邏輯像素）
   */
  setAttachedWindow(hwnd: number, windowOffsetX?: number): void {
    this.attachedWindowHwnd = hwnd;
    if (windowOffsetX !== undefined) {
      this.sitWindowOffsetX = windowOffsetX;
    }
  }

  /** 設定當前坐下的平面 ID（由拖曳吸附時呼叫） */
  setSitPlatform(id: string): void {
    this.sitPlatformId = id;
  }

  /** 清除吸附的視窗（坐在非視窗 platform 時呼叫） */
  clearAttachedWindow(): void {
    this.attachedWindowHwnd = null;
    this.sitWindowOffsetX = 0;
  }

  // ── 狀態更新邏輯 ──

  private tickIdle(input: BehaviorInput): void {
    if (this.stateTimer >= this.stateDuration) {
      this.transitionFromIdle(input);
    }
  }

  /** sit 冷卻時間（秒）— 防止站起來後立即又坐下 */
  private sitCooldown = 0;
  private static readonly SIT_COOLDOWN_DURATION = 5;
  /** 本次 walk 中已拒絕坐下的 platform ID（不重複判定） */
  private ignoredPlatforms = new Set<string>();

  private tickWalk(input: BehaviorInput): void {
    if (!this.walkTarget) {
      this.enterState('idle');
      return;
    }

    // 更新 sit 冷卻
    if (this.sitCooldown > 0) {
      this.sitCooldown -= input.deltaTime;
    }

    // 平面接觸偵測：臀部到達或超過平面時坐下
    // 整個角色離開螢幕範圍時才跳過（避免在完全不可見時坐下）
    const pos = input.currentPosition;
    const cw = input.characterBounds.width;
    const ch = input.characterBounds.height;
    const sb = input.screenBounds;
    const isOutsideScreen =
      pos.x + cw < sb.x ||
      pos.x > sb.x + sb.width ||
      pos.y + ch < sb.y ||
      pos.y > sb.y + sb.height;
    if (this.sitCooldown <= 0 && !isOutsideScreen) {
      const feetY = pos.y + ch;
      const triggerY = input.hipScreenY ?? feetY;
      for (const platform of input.platforms) {
        // 已忽略的 platform（本次 walk 已拒絕坐下）不再重複判定
        if (this.ignoredPlatforms.has(platform.id)) continue;
        if (triggerY >= platform.screenY &&
            input.currentPosition.x + input.characterBounds.width > platform.screenXMin &&
            input.currentPosition.x < platform.screenXMax) {
          // 視窗 platform：40% 機率坐下，不坐則加入忽略清單
          if (platform.id.startsWith('window:')) {
            if (Math.random() >= 0.4) {
              this.ignoredPlatforms.add(platform.id);
              continue;
            }
            const hwnd = parseInt(platform.id.substring(7), 10);
            if (!isNaN(hwnd)) {
              this.attachedWindowHwnd = hwnd;

              this.sitWindowOffsetX = input.currentPosition.x - platform.screenXMin;
            }
          }
          // ground platform：100% 坐下
          this.sitPlatformId = platform.id;
          this.enterState('sit');
          return;
        }
      }
    }

    // 移動
    const speed = this.config.moveSpeed * input.scale * this.speedMultiplier * input.deltaTime;
    const dx = this.walkTarget.x - input.currentPosition.x;
    const dy = this.walkTarget.y - input.currentPosition.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= speed || dist < 5) {
      this.enterState('idle');
      return;
    }

    // 更新面朝方向
    this.facingDirection = dx > 0 ? 1 : -1;

    // 超時也退出
    if (this.stateTimer >= this.stateDuration) {
      this.enterState('idle');
    }
  }

  private tickSit(input: BehaviorInput): void {
    // 視窗消失（關閉/最小化）→ 進入 fall
    if (this.attachedWindowHwnd !== null) {
      const windowExists = input.windowRects.some((w) => w.hwnd === this.attachedWindowHwnd);
      if (!windowExists) {
        this.sitPlatformId = null;
        this.attachedWindowHwnd = null;

        this.enterState('fall');
        return;
      }
    }

    // 平面坐下：停留指定時間後站起來
    if (this.stateTimer >= this.stateDuration) {
      this.sitPlatformId = null;
      this.attachedWindowHwnd = null;
      this.sitCooldown = StateMachine.SIT_COOLDOWN_DURATION;
      this.enterState('idle');
    }
  }

  private tickPeek(input: BehaviorInput): void {
    // 目標視窗消失 → 立即離開 peek
    if (this.peekTargetHwnd !== null) {
      const windowExists = input.windowRects.some((w) => w.hwnd === this.peekTargetHwnd);
      if (!windowExists) {
        this.peekTargetHwnd = null;
        this.enterState('idle');
        return;
      }
    }

    if (this.stateTimer >= this.stateDuration) {
      // peek 結束，隨機回到 walk 或 idle
      this.peekTargetHwnd = null;
      const nextState: BehaviorState = Math.random() < 0.5 ? 'walk' : 'idle';
      this.enterState(nextState);
    }
  }

  private tickFall(input: BehaviorInput): void {
    // 簡易重力下落
    this.fallSpeed += 500 * input.deltaTime; // 加速度 500px/s^2

    // 當到達螢幕底部或超過 1 秒時結束
    const screenBottom = input.screenBounds.y + input.screenBounds.height;
    if (
      input.currentPosition.y + input.characterBounds.height >= screenBottom ||
      this.stateTimer >= 1.0
    ) {
      this.fallSpeed = 0;
      this.enterState('idle');
    }
  }

  // ── 狀態轉移 ──

  private transitionFromIdle(input: BehaviorInput): void {
    const roll = Math.random();
    const probs = this.config.transitionProbabilities;

    // sit 不再由隨機觸發，而是走路碰到平面時自動觸發
    if (roll < probs.toWalk + probs.toSit) {
      this.pickWalkTarget(input);
      this.enterState('walk');
    } else if (roll < probs.toWalk + probs.toSit + probs.toPeek) {
      this.tryEnterPeek(input);
    } else {
      this.enterState('idle');
    }
  }

  private tryEnterPeek(input: BehaviorInput): void {
    // 找一個可以躲的視窗
    if (input.windowRects.length > 0) {
      const target = input.windowRects[Math.floor(Math.random() * input.windowRects.length)];
      this.peekTargetHwnd = target.hwnd;
      // 走到視窗邊緣
      const side = Math.random() < 0.5 ? 'left' : 'right';
      this.walkTarget = {
        x: side === 'left'
          ? target.x - input.characterBounds.width * 0.5
          : target.x + target.width - input.characterBounds.width * 0.5,
        y: target.y + target.height / 2 - input.characterBounds.height / 2,
      };
      this.enterState('peek');
    } else {
      this.enterState('idle');
    }
  }

  private pickWalkTarget(input: BehaviorInput): void {
    const charW = input.characterBounds.width;
    const charH = input.characterBounds.height;
    const sb = input.screenBounds;
    const pos = input.currentPosition;

    // 螢幕活動範圍
    const minX = sb.x;
    const maxX = sb.x + sb.width - charW;
    const minY = sb.y;
    const maxY = sb.y + sb.height - charH * 0.3;

    // ── 邊界外偵測：超出時強制走回螢幕中央安全區域 ──
    const outsideLeft = pos.x + charW < sb.x;                    // 整個身體超出左邊
    const outsideRight = pos.x > sb.x + sb.width;                // 整個身體超出右邊
    const outsideTop = pos.y + charH < sb.y;                     // 整個身體超出上邊
    const outsideBottom = pos.y + charH * 0.5 > sb.y + sb.height; // 身體超出 50% 下方

    if (outsideLeft || outsideRight || outsideTop || outsideBottom) {
      // 安全區域：螢幕中央 60%（上下左右各留 20% margin）
      const safeMinX = sb.x + sb.width * 0.2;
      const safeMaxX = sb.x + sb.width * 0.8 - charW;
      const safeMinY = sb.y + sb.height * 0.2;
      const safeMaxY = sb.y + sb.height * 0.8 - charH;
      this.walkTarget = {
        x: safeMinX + Math.random() * Math.max(0, safeMaxX - safeMinX),
        y: safeMinY + Math.random() * Math.max(0, safeMaxY - safeMinY),
      };
      return;
    }

    // ── 正常行走：隨機方向角 + 隨機距離 ──
    const angle = Math.random() * Math.PI * 2;         // 0-360° 均勻分佈
    const distance = 200 + Math.random() * 400;        // 200-600px
    const rawX = pos.x + Math.cos(angle) * distance;
    const rawY = pos.y + Math.sin(angle) * distance;

    // 超出螢幕 → clamp 到邊界
    const targetX = Math.max(minX, Math.min(maxX, rawX));
    let targetY = Math.max(minY, Math.min(maxY, rawY));

    // 目標落在視窗 platform 正下方時，70% 機率調到 platform 上方
    // （讓角色自然走到視窗頂部觸發 sit，而非穿越視窗內部）
    for (const platform of input.platforms) {
      if (!platform.id.startsWith('window:')) continue;
      if (targetY > platform.screenY &&
          targetX + charW > platform.screenXMin &&
          targetX < platform.screenXMax) {
        if (Math.random() < 0.7) {
          targetY = platform.screenY - charH;
        }
        break; // 只處理第一個匹配的 platform
      }
    }

    this.walkTarget = { x: targetX, y: targetY };
  }

  // ── 輔助 ──

  private enterState(state: BehaviorState): void {
    this.previousState = this.state;
    this.state = state;
    this.stateTimer = 0;

    switch (state) {
      case 'idle':
        this.stateDuration = this.randomRange(
          this.config.idleDurationMin,
          this.config.idleDurationMax,
        );
        break;
      case 'walk':
        this.stateDuration = 30; // walk 最長 30 秒
        this.ignoredPlatforms.clear();
        break;
      case 'sit':
        this.stateDuration = this.randomRange(
          this.config.sitDurationMin,
          this.config.sitDurationMax,
        );
        break;
      case 'peek':
        this.stateDuration = this.randomRange(
          this.config.peekDurationMin,
          this.config.peekDurationMax,
        );
        break;
      case 'fall':
        this.stateDuration = 2; // fall 最長 2 秒
        this.fallSpeed = 0;
        break;
      case 'drag':
        this.stateDuration = Infinity;
        break;
    }
  }

  private getTargetPosition(
    input: BehaviorInput,
  ): { x: number; y: number } | null {
    switch (this.state) {
      case 'walk': {
        if (!this.walkTarget) return null;
        const speed = this.config.moveSpeed * input.scale * this.speedMultiplier * input.deltaTime;
        const dx = this.walkTarget.x - input.currentPosition.x;
        const dy = this.walkTarget.y - input.currentPosition.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return null;
        const ratio = Math.min(speed / dist, 1);
        return {
          x: input.currentPosition.x + dx * ratio,
          y: input.currentPosition.y + dy * ratio,
        };
      }
      case 'sit': {
        if (this.sitPlatformId) {
          const platform = input.platforms.find((p) => p.id === this.sitPlatformId);
          if (platform) {
            const sitY = platform.sitTargetY ?? platform.screenY;
            // 視窗 platform：用 platform 左邊 + 相對偏移追蹤 X（視窗移動時自動跟隨）
            const sitX = this.attachedWindowHwnd !== null
              ? platform.screenXMin + this.sitWindowOffsetX
              : input.currentPosition.x;
            return {
              x: sitX,
              y: sitY - input.characterBounds.height,
            };
          }
        }
        return null;
      }
      case 'fall': {
        // 重力下落
        return {
          x: input.currentPosition.x,
          y: input.currentPosition.y + this.fallSpeed * input.deltaTime,
        };
      }
      default:
        return null;
    }
  }

  private makeOutput(
    stateChanged: boolean,
    targetPosition: { x: number; y: number } | null,
  ): BehaviorOutput {
    return {
      currentState: this.state,
      previousState: this.previousState,
      stateChanged,
      targetPosition,
      facingDirection: this.facingDirection,
      attachedWindowHwnd: this.attachedWindowHwnd,
      traversingWindowHwnd: null,
      peekTargetHwnd: this.peekTargetHwnd,
    };
  }

  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
