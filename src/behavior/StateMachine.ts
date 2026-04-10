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

  // hide / peek 狀態
  private peekTargetHwnd: number | null = null;
  private peekSide: 'left' | 'right' | null = null;
  /** walk 結束後自動進入 hide 的暫存（walk 途中偵測到隱藏條件時觸發） */
  private pendingHide: { hwnd: number | null; side: 'left' | 'right' } | null = null;
  /** hide 狀態移動目標 X（邊緣位置，邏輯像素） */
  private hideEdgeTargetX: number | null = null;
  /** peek 結束後正在走出遮擋區域（暫停被動隱藏偵測） */
  private exitingPeek = false;

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

    // drag 狀態：DragHandler 完全控制位置，StateMachine 不干預
    if (this.state === 'drag') {
      const changed = this.pendingStateChange;
      this.pendingStateChange = false;
      return this.makeOutput(changed, null);
    }

    // paused 時跳過自主狀態轉移與計時器推進，但仍計算 getTargetPosition
    // 讓 forceState 觸發的 sit/hide/peek 等能正確貼齊 platform、跟隨視窗
    if (!this.paused) {
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
        case 'hide':
          this.tickHide(input);
          break;
        case 'peek':
          this.tickPeek(input);
          break;
        case 'fall':
          this.tickFall(input);
          break;
      }
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

  /**
   * 覆蓋當前狀態的持續時間
   *
   * 供 BehaviorAnimationBridge 在播放動畫後設定為實際 clip duration，
   * 確保動畫完整播放。
   */
  setStateDuration(duration: number): void {
    this.stateDuration = duration;
  }

  /** 設定移動速率倍率 */
  setSpeedMultiplier(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  /**
   * 設定基礎移動速度（螢幕像素 / 秒，scale=1 基準）
   *
   * 由 SceneManager 根據 walkWorldSpeed × baseScale 動態計算後推入，
   * 切換螢幕導致 baseScale 改變時會重新套用。
   */
  setMoveSpeed(speed: number): void {
    this.config.moveSpeed = speed;
  }

  /** 取得移動速率倍率 */
  getSpeedMultiplier(): number {
    return this.speedMultiplier;
  }

  /** Debug: 取得計時器資訊 */
  getDebugTimers(): { timer: number; duration: number } {
    return { timer: this.stateTimer, duration: this.stateDuration };
  }

  /** Debug: 取得 hide/peek 狀態詳細資訊 */
  getDebugHideInfo(): { hideEdgeTargetX: number | null; peekSide: 'left' | 'right' | null; peekTargetHwnd: number | null } {
    return {
      hideEdgeTargetX: this.hideEdgeTargetX,
      peekSide: this.peekSide,
      peekTargetHwnd: this.peekTargetHwnd,
    };
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
    // 被動隱藏偵測：被視窗完全遮住或在螢幕左/右外側
    if (this.checkPassiveHide(input)) return;

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

    // walk 第一幀：把已接觸的 platform 加入忽略清單（避免從 idle 立即 sit）
    if (this.stateTimer <= input.deltaTime * 1.5) {
      const feetY0 = pos.y + ch;
      const triggerY0 = input.hipScreenY ?? feetY0;
      for (const platform of input.platforms) {
        if (triggerY0 >= platform.screenY &&
            pos.x + cw > platform.screenXMin &&
            pos.x < platform.screenXMax) {
          this.ignoredPlatforms.add(platform.id);
        }
      }
    }

    if (this.sitCooldown <= 0 && !isOutsideScreen && !this.pendingHide && !this.exitingPeek) {
      const feetY = pos.y + ch;
      const triggerY = input.hipScreenY ?? feetY;
      for (const platform of input.platforms) {
        // 已忽略的 platform（本次 walk 已拒絕坐下或進入時已接觸）不再重複判定
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

    // pendingHide 路徑：walk 途中偵測到隱藏條件即進入 hide（不等到達 walkTarget）
    if (this.pendingHide) {
      if (input.isFullyOccluded || input.isOffScreenLeft || input.isOffScreenRight) {
        this.enterHideFromPending(input);
        return;
      }
    } else if (this.exitingPeek) {
      // peek 離開中：角色脫離遮擋後清除 flag，恢復正常偵測
      if (!input.isFullyOccluded && !input.isOffScreenLeft && !input.isOffScreenRight) {
        this.exitingPeek = false;
      }
    } else {
      // 被動隱藏偵測（非主動 hide 的 walk）
      if (this.checkPassiveHide(input)) return;
    }

    if (dist <= speed || dist < 5) {
      if (this.pendingHide) {
        // 到達 walk 目標但條件未滿足（罕見情況），直接進入 hide
        this.enterHideFromPending(input);
      } else {
        this.enterState('idle');
      }
      return;
    }

    // 更新面朝方向
    this.facingDirection = dx > 0 ? 1 : -1;

    // 超時也退出
    if (this.stateTimer >= this.stateDuration) {
      this.pendingHide = null;
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

  private tickHide(input: BehaviorInput): void {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;

    // 目標視窗消失 → 立即離開 hide
    if (this.peekTargetHwnd !== null) {
      const windowExists = input.windowRects.some((w) => w.hwnd === this.peekTargetHwnd);
      if (!windowExists) {
        this.clearHidePeekState();
        this.enterState('idle');
        return;
      }
    }

    // 安全超時
    if (this.stateTimer >= this.stateDuration) {
      this.clearHidePeekState();
      this.enterState('idle');
      return;
    }

    // 碰柱子偵測：角色 bounding box 邊緣是否碰到視窗/螢幕邊緣
    const charLeft = input.currentPosition.x;
    const charRight = input.currentPosition.x + input.characterBounds.width;

    if (this.peekTargetHwnd !== null) {
      // 視窗邊緣 peek
      const targetWin = input.windowRects.find((w) => w.hwnd === this.peekTargetHwnd);
      if (targetWin) {
        const winLeft = targetWin.x / dpr;
        const winRight = (targetWin.x + targetWin.width) / dpr;
        // peekSide='left'（身體在左）→ 往右邊移動 → charRight 碰到視窗右邊緣
        // peekSide='right'（身體在右）→ 往左邊移動 → charLeft 碰到視窗左邊緣
        const touching = this.peekSide === 'left'
          ? charRight >= winRight
          : charLeft <= winLeft;
        if (touching) {
          this.enterState('peek');
          return;
        }
      }
    } else {
      // 螢幕邊緣 peek
      // peekSide='left'（從螢幕左外側回來）→ charRight 碰到螢幕左邊
      // peekSide='right'（從螢幕右外側回來）→ charLeft 碰到螢幕右邊
      const touching = this.peekSide === 'left'
        ? charRight >= input.screenBounds.x
        : charLeft <= input.screenBounds.x + input.screenBounds.width;
      if (touching) {
        this.enterState('peek');
        return;
      }
    }
  }

  private tickPeek(input: BehaviorInput): void {
    // 目標視窗消失 → 立即離開 peek
    if (this.peekTargetHwnd !== null) {
      const windowExists = input.windowRects.some((w) => w.hwnd === this.peekTargetHwnd);
      if (!windowExists) {
        this.clearHidePeekState();
        this.enterState('idle');
        return;
      }
    }

    if (this.stateTimer >= this.stateDuration) {
      // 計算走出遮擋區域的目標位置，避免 walk/idle 立刻被 checkPassiveHide 抓回 hide
      const charW = input.characterBounds.width;
      const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
      const savedSide = this.peekSide;
      const savedHwnd = this.peekTargetHwnd;

      this.clearHidePeekState();

      // 計算走出方向的目標 X
      const sb = input.screenBounds;
      const minX = sb.x;
      const maxX = sb.x + sb.width - charW;
      let exitTargetX = input.currentPosition.x;

      if (savedHwnd !== null) {
        // 視窗 peek：往視窗外側走
        const targetWin = input.windowRects.find((w) => w.hwnd === savedHwnd);
        if (targetWin) {
          const winLeft = targetWin.x / dpr;
          const winRight = (targetWin.x + targetWin.width) / dpr;
          if (savedSide === 'left') {
            exitTargetX = winLeft - charW * 1.5;
          } else {
            exitTargetX = winRight + charW * 0.5;
          }
        }
      } else {
        // 螢幕邊緣 peek：往螢幕內側走
        if (savedSide === 'left') {
          exitTargetX = sb.x + charW * 0.5;
        } else {
          exitTargetX = sb.x + sb.width - charW * 1.5;
        }
      }

      // Clamp 到螢幕範圍內
      exitTargetX = Math.max(minX, Math.min(maxX, exitTargetX));

      // 設定 walk 目標並標記正在離開 peek
      this.walkTarget = { x: exitTargetX, y: input.currentPosition.y };
      this.facingDirection = exitTargetX > input.currentPosition.x ? 1 : -1;
      this.exitingPeek = true;
      this.enterState('walk');
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

    // sit 不再由隨機觸發，而是走��碰到平面時自動觸發
    if (roll < probs.toWalk + probs.toSit) {
      this.pickWalkTarget(input);
      this.enterState('walk');
    } else if (roll < probs.toWalk + probs.toSit + probs.toPeek) {
      this.tryEnterHide(input);
    } else {
      this.enterState('idle');
    }
  }

  /**
   * 主動 hide：隨機選視窗/螢幕邊緣，走到完全隱藏的位置
   *
   * Walk 目標設在視窗中央（確保被完全遮住）或螢幕外。
   * walk 途中偵測到 isFullyOccluded / isOffScreen 時進�� hide。
   */
  private tryEnterHide(input: BehaviorInput): void {
    const charW = input.characterBounds.width;
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const sb = input.screenBounds;

    if (input.windowRects.length > 0) {
      // 過濾寬度足以完全遮住角色的視窗
      const wideEnough = input.windowRects.filter((w) => w.width / dpr >= charW);
      const candidates = wideEnough.length > 0 ? wideEnough : input.windowRects;
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      const side: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
      const winLeft = target.x / dpr;
      const winRight = (target.x + target.width) / dpr;
      const winCenterX = (winLeft + winRight) / 2;

      // walk 目標 = 視窗中央（確保完全被遮住）
      this.walkTarget = {
        x: winCenterX - charW / 2,
        y: input.currentPosition.y,
      };
      this.pendingHide = { hwnd: target.hwnd, side };
    } else {
      // 螢幕邊緣：走到完全出畫面
      const side: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
      this.walkTarget = {
        x: side === 'left'
          ? sb.x - charW - 10       // 完全超出螢幕左邊
          : sb.x + sb.width + 10,   // 完全超出螢幕右邊
        y: input.currentPosition.y,
      };
      this.pendingHide = { hwnd: null, side };
    }

    this.enterState('walk');
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

    // ── 邊界外偵測：超出 clamp 範圍時強制走回螢幕中央安全區域 ──
    const outsideLeft = pos.x < sb.x - charW * 1.5;              // 超出左側 1.5 倍寬度
    const outsideRight = pos.x > sb.x + sb.width + charW * 0.5;  // 超出右側 1.5 倍寬度
    const outsideTop = pos.y < sb.y - charH * 1.0;               // 超出上側 1 倍高度
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

    // peek 離開中的 walk 到達目標後切換狀態時清除 flag
    if (state !== 'walk') {
      this.exitingPeek = false;
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
        this.ignoredPlatforms.clear();
        break;
      case 'sit':
        this.stateDuration = this.randomRange(
          this.config.sitDurationMin,
          this.config.sitDurationMax,
        );
        break;
      case 'hide':
        this.stateDuration = 10; // 安全超時
        break;
      case 'peek':
        // 預設用 config 值，BehaviorAnimationBridge 會覆蓋為實際動畫長度
        this.stateDuration = this.config.peekDurationMax;
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
      case 'hide': {
        if (this.hideEdgeTargetX === null) return null;
        const hideSpeed = this.config.moveSpeed * this.config.hideSpeedMultiplier * input.scale * this.speedMultiplier * input.deltaTime;
        const hdx = this.hideEdgeTargetX - input.currentPosition.x;
        if (Math.abs(hdx) < 1) return null;
        const hRatio = Math.min(hideSpeed / Math.abs(hdx), 1);
        return {
          x: input.currentPosition.x + hdx * hRatio,
          y: input.currentPosition.y,
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
          // Platform 被暫時移除（例如前景視窗遮擋導致 rebuild 時過濾），
          // 維持當前位置不動，避免 null 導致坐姿跳動
          if (this.attachedWindowHwnd !== null) {
            const windowExists = input.windowRects.some((w) => w.hwnd === this.attachedWindowHwnd);
            if (windowExists) {
              return { x: input.currentPosition.x, y: input.currentPosition.y };
            }
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
      peekSide: this.peekSide,
    };
  }

  /**
   * 被動隱藏偵測：角色被視窗完全遮住或在螢幕左/右外側時自動進入 hide
   *
   * @returns true 如果進入了 hide 狀態
   */
  private checkPassiveHide(input: BehaviorInput): boolean {
    if (input.isFullyOccluded) {
      this.enterHidePassive(input, 'occluded');
      return true;
    }
    if (input.isOffScreenLeft) {
      this.enterHidePassive(input, 'screen-left');
      return true;
    }
    if (input.isOffScreenRight) {
      this.enterHidePassive(input, 'screen-right');
      return true;
    }
    return false;
  }

  /**
   * 被動進入 hide：根據隱藏原因決定 peekSide、peekTargetHwnd、hideEdgeTargetX
   */
  private enterHidePassive(input: BehaviorInput, reason: 'occluded' | 'screen-left' | 'screen-right'): void {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const charW = input.characterBounds.width;
    const charCenterX = input.currentPosition.x + charW / 2;

    if (reason === 'occluded') {
      // 找出遮住角色的視窗（重疊面積最大者）
      const occluder = this.findOccludingWindow(input, dpr);
      if (occluder) {
        const winLeft = occluder.x / dpr;
        const winRight = (occluder.x + occluder.width) / dpr;
        const winCenterX = (winLeft + winRight) / 2;
        // 角色在視窗左半 → 移向左邊緣（最近）→ peekSide='right'（身體留右側）
        // 角色在視窗右半 → 移向右邊緣（最近）→ peekSide='left'（身體留左側）
        if (charCenterX <= winCenterX) {
          this.peekSide = 'right';
          this.hideEdgeTargetX = winLeft + charW * 0.3 - charW;
        } else {
          this.peekSide = 'left';
          this.hideEdgeTargetX = winRight - charW * 0.3;
        }
        this.peekTargetHwnd = occluder.hwnd;
      } else {
        // 找不到遮擋視窗（理論上不應發生），fallback 到 idle
        this.enterState('idle');
        return;
      }
    } else if (reason === 'screen-left') {
      this.peekSide = 'left';
      this.peekTargetHwnd = null;
      this.hideEdgeTargetX = input.screenBounds.x;
    } else {
      this.peekSide = 'right';
      this.peekTargetHwnd = null;
      this.hideEdgeTargetX = input.screenBounds.x + input.screenBounds.width - charW;
    }

    this.pendingHide = null;
    this.enterState('hide');
    this.computeHideDuration(input);
  }

  /**
   * 主動 hide 路徑：pendingHide walk 途中偵測到隱藏條件，進入 hide
   */
  private enterHideFromPending(input: BehaviorInput): void {
    const dpr = (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1;
    const charW = input.characterBounds.width;

    if (this.pendingHide) {
      this.peekTargetHwnd = this.pendingHide.hwnd;
      this.peekSide = this.pendingHide.side;

      if (this.pendingHide.hwnd !== null) {
        const targetWin = input.windowRects.find((w) => w.hwnd === this.pendingHide!.hwnd);
        if (targetWin) {
          const winLeft = targetWin.x / dpr;
          const winRight = (targetWin.x + targetWin.width) / dpr;
          // peekSide='left'（身體在左）→ charRight 碰視窗右邊緣 → 移向右邊緣
          // peekSide='right'（身體在右）→ charLeft 碰視窗左邊緣 → 移向左邊緣
          this.hideEdgeTargetX = this.peekSide === 'left'
            ? winRight - charW * 0.3
            : winLeft + charW * 0.3 - charW;
        } else {
          this.hideEdgeTargetX = input.currentPosition.x;
        }
      } else {
        // 螢幕邊緣
        this.hideEdgeTargetX = this.peekSide === 'left'
          ? input.screenBounds.x
          : input.screenBounds.x + input.screenBounds.width - charW;
      }
      this.pendingHide = null;
    }

    this.enterState('hide');
    this.computeHideDuration(input);
  }

  /**
   * 根據距離和速度動態計算 hide 超時
   *
   * 距離 ÷ 預估速度 × 1.5 安全餘量，夾在 5–60 秒之間。
   * 確保角色一定有足夠時間到達 peek 邊緣。
   */
  private computeHideDuration(input: BehaviorInput): void {
    if (this.hideEdgeTargetX === null) return;
    const distance = Math.abs(this.hideEdgeTargetX - input.currentPosition.x);
    // 預估速度：moveSpeed × hideSpeedMultiplier × scale（不含 speedMultiplier，保守估計）
    const estSpeed = this.config.moveSpeed * this.config.hideSpeedMultiplier * input.scale;
    if (estSpeed <= 0) return;
    const estTime = distance / estSpeed;
    this.stateDuration = Math.max(5, Math.min(60, estTime * 1.5));
  }

  /** 找出遮住角色最多面積的視窗 */
  private findOccludingWindow(input: BehaviorInput, dpr: number): { hwnd: number; x: number; y: number; width: number; height: number } | null {
    const charLeft = input.currentPosition.x;
    const charTop = input.currentPosition.y;
    const charRight = charLeft + input.characterBounds.width;
    const charBottom = charTop + input.characterBounds.height;

    let bestOverlap = 0;
    let bestWin: typeof input.windowRects[0] | null = null;

    for (const win of input.windowRects) {
      const wx = win.x / dpr;
      const wy = win.y / dpr;
      const wr = wx + win.width / dpr;
      const wb = wy + win.height / dpr;
      const overlapX = Math.max(0, Math.min(charRight, wr) - Math.max(charLeft, wx));
      const overlapY = Math.max(0, Math.min(charBottom, wb) - Math.max(charTop, wy));
      const area = overlapX * overlapY;
      if (area > bestOverlap) {
        bestOverlap = area;
        bestWin = win;
      }
    }

    return bestWin;
  }

  /** 清除 hide/peek 相關狀態 */
  private clearHidePeekState(): void {
    this.peekTargetHwnd = null;
    this.peekSide = null;
    this.hideEdgeTargetX = null;
  }

  private randomRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }
}
