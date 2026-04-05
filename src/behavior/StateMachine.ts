import type {
  BehaviorState,
  BehaviorOutput,
  BehaviorInput,
  BehaviorConfig,
} from '../types/behavior';
import { DEFAULT_BEHAVIOR_CONFIG } from '../types/behavior';
import type { CollisionResult } from '../types/collision';

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
  private walkStartCollidingWindows: Set<number> = new Set();
  private traversingWindowHwnd: number | null = null;
  private facingDirection = 1;

  // 速率倍率
  private speedMultiplier = 1.0;

  // forceState 觸發的狀態變化（tick early return 時回報）
  private pendingStateChange = false;

  // sit 狀態
  private attachedWindowHwnd: number | null = null;
  private attachedWindowLastPos: { x: number; y: number } | null = null;

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
  tick(input: BehaviorInput, collision: CollisionResult): BehaviorOutput {
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
        this.tickWalk(input, collision);
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

    // 進入 walk 時記錄已重疊的視窗（避免立即取消移動）
    if (stateChanged && this.state === 'walk') {
      this.walkStartCollidingWindows.clear();
      if (collision.collidingWithWindow && collision.collidedWindowHwnd !== null) {
        this.walkStartCollidingWindows.add(collision.collidedWindowHwnd);
      }
      // 也記錄所有與角色重疊的視窗
      for (const wr of input.windowRects) {
        const cb = input.characterBounds;
        if (cb.x < wr.x + wr.width && cb.x + cb.width > wr.x &&
            cb.y < wr.y + wr.height && cb.y + cb.height > wr.y) {
          this.walkStartCollidingWindows.add(wr.hwnd);
        }
      }
    }

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

  /** 取得正在穿越的視窗 handle */
  getTraversingWindowHwnd(): number | null {
    return this.traversingWindowHwnd;
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

  private tickWalk(input: BehaviorInput, collision: CollisionResult): void {
    if (!this.walkTarget) {
      this.enterState('idle');
      return;
    }

    // 螢幕邊緣到達：停止行走，進入 idle
    if (collision.atScreenEdge) {
      this.enterState('idle');
      return;
    }

    // 視窗邊緣穿越偵測：檢查角色是否正在接近某個視窗的左/右邊緣
    // （不使用 AABB 碰撞，因為 always-on-top 視窗永遠與下方視窗重疊）
    const charCenterX = input.currentPosition.x + input.characterBounds.width / 2;
    const charTop = input.currentPosition.y;
    const charBottom = input.currentPosition.y + input.characterBounds.height;
    const edgeThreshold = 30; // 接近邊緣的判定距離

    for (const wr of input.windowRects) {
      if (this.walkStartCollidingWindows.has(wr.hwnd)) continue;
      // 最大化視窗不穿越（角色顯示在最大化視窗上）
      if (wr.isMaximized) continue;

      // 檢查 Y 軸是否重疊（角色與視窗有垂直交集）
      if (charBottom <= wr.y || charTop >= wr.y + wr.height) continue;

      // 檢查角色是否接近視窗的左或右邊緣
      const distToLeft = Math.abs(charCenterX - wr.x);
      const distToRight = Math.abs(charCenterX - (wr.x + wr.width));
      const approachingLeft = distToLeft < edgeThreshold && this.facingDirection > 0;
      const approachingRight = distToRight < edgeThreshold && this.facingDirection < 0;

      if (approachingLeft || approachingRight) {
        // 永遠穿越：walkTarget 設為視窗另一側
        const charWidth = input.characterBounds.width;
        if (approachingLeft) {
          this.walkTarget = { x: wr.x + wr.width + charWidth * 0.5, y: input.currentPosition.y };
        } else {
          this.walkTarget = { x: wr.x - charWidth * 1.5, y: input.currentPosition.y };
        }
        this.walkStartCollidingWindows.add(wr.hwnd);
        this.traversingWindowHwnd = wr.hwnd;
        return;
      }
    }

    // 移動
    const speed = this.config.moveSpeed * input.scale * this.speedMultiplier * input.deltaTime;
    const dx = this.walkTarget.x - input.currentPosition.x;
    const dy = this.walkTarget.y - input.currentPosition.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist <= speed || dist < 5) {
      // 到達目標
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
    if (this.attachedWindowHwnd === null) {
      this.enterState('fall');
      return;
    }

    // 檢查吸附的視窗是否仍存在
    const attachedWindow = input.windowRects.find(
      (w) => w.hwnd === this.attachedWindowHwnd,
    );

    if (!attachedWindow) {
      // 視窗被關閉或最小化
      this.attachedWindowHwnd = null;
      this.attachedWindowLastPos = null;
      this.enterState('fall');
      return;
    }

    // 更新上次視窗位置（用於跟隨移動）
    this.attachedWindowLastPos = { x: attachedWindow.x, y: attachedWindow.y };

    // 超時離開
    if (this.stateTimer >= this.stateDuration) {
      this.attachedWindowHwnd = null;
      this.attachedWindowLastPos = null;
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

    if (roll < probs.toWalk) {
      this.pickWalkTarget(input);
      this.enterState('walk');
    } else if (roll < probs.toWalk + probs.toSit) {
      this.tryEnterSit(input);
    } else if (roll < probs.toWalk + probs.toSit + probs.toPeek) {
      this.tryEnterPeek(input);
    } else {
      // 繼續 idle
      this.enterState('idle');
    }
  }

  private tryEnterSit(input: BehaviorInput): void {
    // 找一個可以坐的視窗
    const sittableWindows = input.windowRects.filter((w) => {
      // 視窗頂部在螢幕範圍內，且有足夠寬度
      return (
        w.y > input.screenBounds.y + 50 &&
        w.width > input.characterBounds.width * 0.5
      );
    });

    if (sittableWindows.length > 0) {
      const target = sittableWindows[Math.floor(Math.random() * sittableWindows.length)];
      // 先走到視窗頂部，然後坐下
      this.walkTarget = {
        x: target.x + target.width / 2 - input.characterBounds.width / 2,
        y: target.y - input.characterBounds.height,
      };
      this.attachedWindowHwnd = target.hwnd;
      this.attachedWindowLastPos = { x: target.x, y: target.y };
      this.enterState('walk'); // 先走過去，到達後由 walk 邏輯切到 sit
    } else {
      // 沒有可坐的視窗，改為 idle
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
    // 離開 walk 時清除穿越狀態
    if (state !== 'walk') {
      this.traversingWindowHwnd = null;
    }

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
      traversingWindowHwnd: this.traversingWindowHwnd,
    };
  }

  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
