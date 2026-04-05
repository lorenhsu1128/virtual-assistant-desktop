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
  private attachedWindowLastPos: { x: number; y: number } | null = null;
  /** 當前坐在的平面 ID（未來用於多平面識別） */
  sitPlatformId: string | null = null;

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

  /** 設定吸附的視窗（由 DragHandler 在吸附時呼叫） */
  setAttachedWindow(hwnd: number, position: { x: number; y: number }): void {
    this.attachedWindowHwnd = hwnd;
    this.attachedWindowLastPos = { ...position };
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

  private tickWalk(input: BehaviorInput): void {
    if (!this.walkTarget) {
      this.enterState('idle');
      return;
    }

    // 更新 sit 冷卻
    if (this.sitCooldown > 0) {
      this.sitCooldown -= input.deltaTime;
    }

    // 平面接觸偵測：膝蓋到達或超過平面時坐下（冷卻中不觸發）
    if (this.sitCooldown <= 0) {
      const triggerY = input.kneeScreenY ?? (input.currentPosition.y + input.characterBounds.height);
      for (const platform of input.platforms) {
        if (triggerY >= platform.screenY &&
            input.currentPosition.x + input.characterBounds.width > platform.screenXMin &&
            input.currentPosition.x < platform.screenXMax) {
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

  private tickSit(_input: BehaviorInput): void {
    // 平面坐下：停留指定時間後站起來
    if (this.stateTimer >= this.stateDuration) {
      this.sitPlatformId = null;
      this.attachedWindowHwnd = null;
      this.attachedWindowLastPos = null;
      this.sitCooldown = StateMachine.SIT_COOLDOWN_DURATION;
      this.enterState('idle');
    }
  }

  private tickPeek(_input: BehaviorInput): void {
    if (this.stateTimer >= this.stateDuration) {
      // peek 結束，隨機回到 walk 或 idle
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
    // 在螢幕範圍內隨機選擇一個目標
    const margin = input.characterBounds.width;
    const minX = input.screenBounds.x + margin;
    const maxX = input.screenBounds.x + input.screenBounds.width - margin;
    const minY = input.screenBounds.y + input.screenBounds.height * 0.3;
    const maxY = input.screenBounds.y + input.screenBounds.height - margin;

    this.walkTarget = {
      x: minX + Math.random() * (maxX - minX),
      y: minY + Math.random() * (maxY - minY),
    };
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
        // 跟隨視窗移動
        if (this.attachedWindowHwnd !== null && this.attachedWindowLastPos) {
          const win = input.windowRects.find(
            (w) => w.hwnd === this.attachedWindowHwnd,
          );
          if (win) {
            return {
              x: win.x + win.width / 2 - input.characterBounds.width / 2,
              y: win.y - input.characterBounds.height,
            };
          }
        }
        // 平面坐下：定位到 sitTargetY（如工作列上緣）
        if (this.sitPlatformId) {
          const platform = input.platforms.find((p) => p.id === this.sitPlatformId);
          if (platform) {
            const sitY = platform.sitTargetY ?? platform.screenY;
            return {
              x: input.currentPosition.x,
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
    };
  }

  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
