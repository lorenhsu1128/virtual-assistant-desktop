import * as THREE from 'three';
import type {
  AnimationCategory,
  AnimationEntry,
  SystemAnimationState,
} from '../types/animation';
import { SYSTEM_STATE_PLAY_CONFIG } from '../types/animation';

/** 動畫載入函式型別（由 VRMController 提供，避免直接依賴 @pixiv/three-vrm） */
export type AnimationLoader = (url: string) => Promise<THREE.AnimationClip | null>;

/** 載入後的動畫資料（使用者動畫分類） */
interface LoadedAnimation {
  entry: AnimationEntry;
  clip: THREE.AnimationClip;
}

/** 系統動畫池內的單一 clip（檔名 + Three.js clip） */
export interface LoadedPoolClip {
  fileName: string;
  clip: THREE.AnimationClip;
}

/**
 * 偽 inertialization transition 狀態（階段 C）
 *
 * 用 ease-out cubic 權重曲線取代 Three.js 預設的線性 crossfade。
 * 視覺上「舊動作的影響保留更久」，類似真正 inertialization 的效果。
 */
interface TransitionState {
  oldAction: THREE.AnimationAction;
  newAction: THREE.AnimationAction;
  elapsed: number;
  duration: number;
  /** 開始 transition 時舊動作的 weight（用於從中段繼續衰減） */
  initialOldWeight: number;
}

/** Crossfade 過渡時間預設值（秒），實際時長依 category 決定 */
const CROSSFADE_DURATION = 0.5;

/** action 結束後回到 idle 的 crossfade 時長（較長以掩蓋 pose 差異） */
const RETURN_TO_IDLE_FADE = 1.0;

/** idle 動畫之間的等待時間隨機範圍（秒）— fallback 模式使用 */
const IDLE_WAIT_MIN = 5;
const IDLE_WAIT_MAX = 12;

/**
 * 依分類取得 crossfade 過渡時長（秒）— 使用者動畫用
 *
 * 不同類別動作的姿態差異不同，使用差異化時長：
 *   idle：相對相似 → 0.7s
 *   action：通常從站姿觸發 → 1.0s
 *   sit：從站姿到坐姿差異最大 → 1.5s
 *   fall / collide：需要快速反應 → 0.3s
 *   peek：姿態接近 idle → 0.6s
 */
function getCrossfadeDurationFor(category: AnimationCategory): number {
  switch (category) {
    case 'idle': return 0.7;
    case 'action': return 1.0;
    case 'sit': return 1.5;
    case 'fall': return 0.3;
    case 'collide': return 0.3;
    case 'peek': return 0.6;
    default: return CROSSFADE_DURATION;
  }
}

/**
 * 動畫管理器
 *
 * 管理所有 .vrma 動畫的載入、索引、播放控制。
 * 不直接依賴 @pixiv/three-vrm —— 透過 AnimationLoader 函式載入動畫，
 * 由 VRMController 封裝 VRM-specific 的轉換邏輯。
 *
 * 兩種動畫來源：
 *   1. 使用者動畫分類（animations.json + AnimationEntry）
 *      — 透過 loadAnimations 載入，按 AnimationCategory 索引
 *      — 由右鍵選單觸發的 action 動畫屬於此來源
 *   2. 系統動畫池（assets/system/vrma/SYS_*.vrma）
 *      — 透過 setStatePool 注入，按 SystemAnimationState 索引
 *      — 每個狀態（idle/walk/sit/drag/peek/fall/hide）一個池
 *      — 由 BehaviorAnimationBridge 呼叫 playStateRandom 觸發
 */
export class AnimationManager {
  private mixer: THREE.AnimationMixer;
  private loadAnimation: AnimationLoader;

  /** 按分類索引的使用者動畫清單 */
  private animationsByCategory: Map<AnimationCategory, LoadedAnimation[]> = new Map();

  /** 所有已載入的使用者動畫 */
  private allAnimations: LoadedAnimation[] = [];

  /** 當前播放的 action */
  private currentAction: THREE.AnimationAction | null = null;

  /** 上一個 action（crossfade 用） */
  private previousAction: THREE.AnimationAction | null = null;

  /** 進行中的 cubic transition（階段 C）；null = 無 transition */
  private transitionState: TransitionState | null = null;

  /** idle 輪播計時器（僅在 fallback 模式使用，sys idle pool 由 finished 事件驅動） */
  private idleTimer = 0;
  private idleWaitTime = 0;
  private isPlayingAction = false;
  private loopEnabled = true;

  /**
   * 系統動畫池（按狀態索引）
   *
   * 每個狀態對應一個 SYS_{PREFIX}_NN.vrma 檔案清單（已解析為 clip）。
   * 由 main.ts 啟動時掃描並注入，不在此類別內載入檔案。
   */
  private statePools: Map<SystemAnimationState, LoadedPoolClip[]> = new Map();

  /**
   * peek 狀態的左側鏡像池（runtime mirror）
   *
   * 由 main.ts 透過 mirrorAnimationClip 從 peek pool 產生，
   * 當 playStateRandom('peek', 'left') 時使用此池。
   */
  private peekLeftClips: LoadedPoolClip[] = [];

  /**
   * 當前播放的狀態池 key（null = 正在播使用者動畫或無動畫）
   *
   * 用於 onAnimationFinished 判斷：
   *   - 'idle' → 接力下一支 idle
   *   - 其他或 null → 不接力
   */
  private currentPoolState: SystemAnimationState | null = null;

  /** 當前動畫的顯示名稱（.vrma 檔名或系統動畫名） */
  private currentDisplayName: string | null = null;

  constructor(mixer: THREE.AnimationMixer, loadAnimation: AnimationLoader) {
    this.mixer = mixer;
    this.loadAnimation = loadAnimation;

    // 動畫播放結束時的回呼
    this.mixer.addEventListener('finished', this.onAnimationFinished);
  }

  /**
   * 載入使用者動畫清單
   *
   * @param entries 動畫條目（來自 animations.json）
   * @param folderPath 動畫資料夾路徑
   */
  async loadAnimations(entries: AnimationEntry[], folderPath: string): Promise<void> {
    this.animationsByCategory.clear();
    this.allAnimations = [];

    const loadPromises = entries.map(async (entry) => {
      try {
        const url = `${folderPath}/${entry.fileName}`;
        const clip = await this.loadAnimation(url);
        if (!clip) {
          console.warn(`[AnimationManager] No animation clip produced for ${entry.fileName}`);
          return;
        }

        const loaded: LoadedAnimation = { entry, clip };
        this.allAnimations.push(loaded);

        const list = this.animationsByCategory.get(entry.category) ?? [];
        list.push(loaded);
        this.animationsByCategory.set(entry.category, list);
      } catch (e) {
        // .vrma 載入失敗：跳過該檔案，記錄警告，不影響其他動畫
        console.warn(`[AnimationManager] Failed to load ${entry.fileName}:`, e);
      }
    });

    await Promise.all(loadPromises);

    // 載入完成後開始 idle 輪播
    this.startIdleLoop();
  }

  /**
   * 依分類播放動畫（使用者動畫）
   *
   * 從該分類中隨機選取一個動畫播放。
   * idle 分類特別：若系統 idle 池非空，委派到 playNextIdle（系統池）。
   */
  playByCategory(category: AnimationCategory): boolean {
    // idle 分類：若有系統 idle 池則一律由 playNextIdle 處理
    if (category === 'idle' && this.hasStatePool('idle')) {
      this.playNextIdle();
      return true;
    }

    const animations = this.animationsByCategory.get(category);
    if (!animations || animations.length === 0) return false;

    const selected = this.selectByWeight(animations);
    if (!selected) return false;

    const fade = getCrossfadeDurationFor(category);
    this.playClip(selected.clip, selected.entry.loop, category === 'action', fade);
    this.currentDisplayName = selected.entry.displayName || selected.entry.fileName;
    return true;
  }

  /**
   * 依名稱播放動畫（使用者動畫）
   */
  playByName(name: string): boolean {
    const anim = this.allAnimations.find((a) => a.entry.fileName === name);
    if (!anim) return false;

    const fade = getCrossfadeDurationFor(anim.entry.category);
    this.playClip(anim.clip, anim.entry.loop, anim.entry.category === 'action', fade);
    this.currentDisplayName = anim.entry.displayName || anim.entry.fileName;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  // 系統動畫池（SYS_*.vrma）
  // ═══════════════════════════════════════════════════════════════

  /**
   * 設定指定狀態的系統動畫池
   *
   * 由 main.ts 在啟動時掃描 assets/system/vrma/ 並呼叫。
   * 傳入空陣列等同於清除該狀態的池。
   */
  setStatePool(state: SystemAnimationState, clips: LoadedPoolClip[]): void {
    if (clips.length === 0) {
      this.statePools.delete(state);
      return;
    }
    this.statePools.set(state, clips.slice());
    console.log(`[AnimationManager] state pool '${state}' set: ${clips.length} clips`);

    // idle 池剛設定完畢且目前無動作在播，立刻啟動 idle 輪播
    if (state === 'idle' && !this.isPlayingAction && this.currentAction === null) {
      this.startIdleLoop();
    }
  }

  /**
   * 設定 peek 狀態的左側鏡像池
   *
   * 由 main.ts 在載入 peek 池後，透過 mirrorAnimationClip 產生並呼叫。
   */
  setPeekLeftClips(clips: LoadedPoolClip[]): void {
    this.peekLeftClips = clips.slice();
  }

  /** 取得指定狀態的池（不存在時回傳 null） */
  getStatePool(state: SystemAnimationState): LoadedPoolClip[] | null {
    return this.statePools.get(state) ?? null;
  }

  /** 檢查指定狀態是否有可用的動畫池 */
  hasStatePool(state: SystemAnimationState): boolean {
    const pool = this.statePools.get(state);
    return !!pool && pool.length > 0;
  }

  /**
   * 從指定狀態池隨機選取並播放一支動畫
   *
   * @param state 要播放的狀態
   * @param side peek 狀態專用：'left' 會從 peekLeftClips 選取，
   *             'right' 或未指定則從 statePools.get('peek') 選取
   * @returns 成功時回傳被選中的 entry（供 caller 做後續分析如 step length），
   *          池為空或失敗時回傳 null
   */
  playStateRandom(
    state: SystemAnimationState,
    side?: 'left' | 'right',
  ): LoadedPoolClip | null {
    // peek + left 走鏡像池
    const pool =
      state === 'peek' && side === 'left'
        ? this.peekLeftClips
        : this.statePools.get(state) ?? [];

    if (pool.length === 0) return null;

    const picked = pool[Math.floor(Math.random() * pool.length)];
    const config = SYSTEM_STATE_PLAY_CONFIG[state];

    this.currentPoolState = state;
    this.isPlayingAction = false;
    this.playClip(picked.clip, config.loop, false, config.fadeDuration, config.clampWhenFinished);
    this.currentDisplayName = `SYS:${state}:${picked.fileName}`;
    return picked;
  }

  /**
   * 停止當前的狀態池動畫並回到 idle 池
   *
   * 由 BehaviorAnimationBridge 在離開非 idle 狀態時呼叫（例如 walk → idle）。
   */
  stopStateAnimation(): void {
    if (this.currentPoolState === null) return;
    this.currentPoolState = null;
    // 回到 idle 池，由 playNextIdle 挑一支新的
    this.playNextIdle();
    this.resetIdleTimer();
  }

  /** 停止當前動畫 */
  stopCurrent(): void {
    // 清除進行中的 transition，避免下一幀又被覆蓋 weight
    if (this.transitionState) {
      this.transitionState.oldAction.stop();
      this.transitionState = null;
    }
    if (this.currentAction) {
      // 沒有 newAction 可以 transition，直接線性 fadeOut
      this.currentAction.fadeOut(CROSSFADE_DURATION);
      this.currentAction = null;
    }
    this.currentDisplayName = null;
    this.currentPoolState = null;
  }

  /** 取得當前播放的 clip */
  getCurrentClip(): THREE.AnimationClip | null {
    return this.currentAction?.getClip() ?? null;
  }

  /** 取得當前播放的動畫顯示名稱（.vrma 檔名或系統動畫名） */
  getCurrentAnimationName(): string | null {
    return this.currentDisplayName;
  }

  /** 取得當前所屬的狀態池 key */
  getCurrentPoolState(): SystemAnimationState | null {
    return this.currentPoolState;
  }

  /** 檢查是否有該分類的動畫（使用者動畫） */
  hasCategory(category: AnimationCategory): boolean {
    const list = this.animationsByCategory.get(category);
    return !!list && list.length > 0;
  }

  /** 取得指定分類的動畫列表（使用者動畫） */
  getAnimationsByCategory(category: AnimationCategory): AnimationEntry[] {
    return (this.animationsByCategory.get(category) ?? []).map((a) => a.entry);
  }

  /** 檢查是否有任何已載入的使用者動畫 */
  hasAnimations(): boolean {
    return this.allAnimations.length > 0;
  }

  /** 檢查是否正在播放 action 動畫（表情優先級用） */
  isActionPlaying(): boolean {
    return this.isPlayingAction;
  }

  /** 設定動畫循環開關 */
  setLoopEnabled(enabled: boolean): void {
    this.loopEnabled = enabled;
  }

  /** 取得動畫循環狀態 */
  isLoopEnabled(): boolean {
    return this.loopEnabled;
  }

  /**
   * 更新動畫系統
   *
   * 由 SceneManager render loop 呼叫。
   * 注意：mixer.update 由 VRMController.update 負責，
   * 這裡處理 transition 推進與 idle 輪播邏輯。
   */
  update(deltaTime: number): void {
    // Phase C: cubic transition 推進（每幀執行，不受 idle 早走影響）
    this.updateTransition(deltaTime);

    // 非 idle 狀態的系統動畫播放中 → 暫停 idle 輪播
    if (this.currentPoolState !== null && this.currentPoolState !== 'idle') return;
    if (this.isPlayingAction) return;
    if (!this.loopEnabled) return;

    // 系統 idle 池非空時由 mixer 'finished' 事件驅動接力，不使用計時器
    if (this.hasStatePool('idle')) return;

    // idle 輪播計時（fallback 模式：使用者分類動畫）
    this.idleTimer += deltaTime;
    if (this.idleTimer >= this.idleWaitTime) {
      this.playNextIdle();
      this.resetIdleTimer();
    }
  }

  /**
   * 啟動一個 cubic transition（階段 C）
   *
   * 取代 Three.js 預設的線性 crossFadeTo。
   * 用 ease-out cubic 衰減 oldAction.weight，讓舊動作的影響在前期保留較久，
   * 後期快速釋放，視覺效果類似 inertialization。
   */
  private startTransition(
    oldAction: THREE.AnimationAction | null,
    newAction: THREE.AnimationAction,
    duration: number,
  ): void {
    // 終止任何進行中的舊 transition（清除被覆蓋的舊動作）
    //
    // 關鍵：不可 stop 等同於本次 newAction 的 lingering。
    // three.js 的 `mixer.clipAction(clip)` 對同一個 clip 永遠回傳
    // 同一個 instance。若 A→B→A→B 交替切換，第二次 B 啟動時
    // 上一個 transition 的 oldAction 正好 === 新 newAction，
    // 若不排除會把剛 play() 過的 newAction 又 stop 掉，導致
    // isRunning=false 但 setEffectiveWeight 持續爬升 → T-pose。
    if (this.transitionState) {
      const lingering = this.transitionState.oldAction;
      if (lingering !== oldAction && lingering !== newAction) {
        lingering.setEffectiveWeight(0);
        lingering.stop();
      }
    }
    this.transitionState = null;

    // 沒有 oldAction 或同一個 action：直接全權重，無 transition
    if (!oldAction || oldAction === newAction) {
      newAction.setEffectiveWeight(1);
      return;
    }

    newAction.setEffectiveWeight(0);

    this.transitionState = {
      oldAction,
      newAction,
      elapsed: 0,
      duration: Math.max(0.0001, duration),
      initialOldWeight: oldAction.getEffectiveWeight() || 1,
    };
  }

  /** 推進 cubic transition（每幀呼叫一次） */
  private updateTransition(deltaTime: number): void {
    if (!this.transitionState) return;

    this.transitionState.elapsed += deltaTime;
    const t = Math.min(1, this.transitionState.elapsed / this.transitionState.duration);

    // ease-out cubic decay：(1-t)^3
    const decay = (1 - t) ** 3;
    const oldWeight = this.transitionState.initialOldWeight * decay;
    const newWeight = 1 - decay;

    this.transitionState.oldAction.setEffectiveWeight(oldWeight);
    this.transitionState.newAction.setEffectiveWeight(newWeight);

    if (t >= 1) {
      this.transitionState.oldAction.setEffectiveWeight(0);
      this.transitionState.oldAction.stop();
      this.transitionState = null;
    }
  }

  /** 設定動畫播放速率倍率 */
  setTimeScale(rate: number): void {
    this.mixer.timeScale = rate;
  }

  /** 取得動畫播放速率倍率 */
  getTimeScale(): number {
    return this.mixer.timeScale;
  }

  /** 銷毀 */
  dispose(): void {
    this.mixer.removeEventListener('finished', this.onAnimationFinished);
    this.transitionState = null;
    this.stopCurrent();
    this.allAnimations = [];
    this.animationsByCategory.clear();
    this.statePools.clear();
    this.peekLeftClips = [];
  }

  /**
   * 播放 clip
   *
   * @param clip 動畫 clip
   * @param loop 是否循環
   * @param isAction 是否為 action（觸發 onAnimationFinished 回 idle 邏輯）
   * @param fadeDuration 自訂 crossfade 時長（秒）
   * @param clampWhenFinished loop=false 時是否在結尾姿勢 clamp（預設 true）
   */
  private playClip(
    clip: THREE.AnimationClip,
    loop: boolean,
    isAction: boolean,
    fadeDuration: number = CROSSFADE_DURATION,
    clampWhenFinished = true,
  ): void {
    this.previousAction = this.currentAction;
    this.isPlayingAction = isAction;
    // 任何 action 取代狀態池時，清除 pool 標記
    if (isAction) this.currentPoolState = null;

    const action = this.mixer.clipAction(clip);
    action.reset();

    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = clampWhenFinished;
    }

    // 階段 C：用 cubic transition 取代 Three.js 線性 crossFadeTo
    action.play();
    this.startTransition(this.previousAction, action, fadeDuration);
    this.currentAction = action;
  }

  /** 動畫播放結束回呼 */
  private onAnimationFinished = (): void => {
    if (this.isPlayingAction) {
      // action 播完後回到 idle 輪播
      this.isPlayingAction = false;
      this.playNextIdle(true);
      this.resetIdleTimer();
      return;
    }

    // 系統 idle 模式：一段 idle 播完 → 隨機接下一段
    if (this.currentPoolState === 'idle') {
      this.playNextIdle();
    }
  };

  /** 開始 idle 輪播 */
  private startIdleLoop(): void {
    this.isPlayingAction = false;
    this.playNextIdle();
    this.resetIdleTimer();
  }

  /**
   * 播放下一個 idle 動畫
   *
   * 優先順序：
   *   1. 系統 idle 池（SYS_IDLE_*.vrma）→ LoopOnce + finished 事件接力
   *   2. 使用者 idle 分類
   *   3. 所有使用者動畫（最終 fallback）
   *
   * @param returnFromAction 若為 true，使用較長的 crossfade（1.0s 取代 0.7s）
   *                         以掩蓋 action 結尾 pose 差異
   */
  private playNextIdle(returnFromAction = false): void {
    // 優先：系統 idle 池
    const sysIdlePool = this.statePools.get('idle');
    if (sysIdlePool && sysIdlePool.length > 0) {
      const picked = sysIdlePool[Math.floor(Math.random() * sysIdlePool.length)];
      const config = SYSTEM_STATE_PLAY_CONFIG.idle;
      const fade = returnFromAction ? RETURN_TO_IDLE_FADE : config.fadeDuration;
      this.currentPoolState = 'idle';
      this.playClip(picked.clip, config.loop, false, fade, config.clampWhenFinished);
      this.currentDisplayName = `SYS:idle:${picked.fileName}`;
      return;
    }

    // Fallback：使用者 idle 分類
    this.currentPoolState = null;
    let pool = this.animationsByCategory.get('idle');
    if (!pool || pool.length === 0) {
      pool = this.allAnimations;
    }
    if (pool.length === 0) return;

    const selected = this.selectByWeight(pool);
    if (selected) {
      const fade = returnFromAction
        ? RETURN_TO_IDLE_FADE
        : getCrossfadeDurationFor('idle');
      this.playClip(selected.clip, true, false, fade);
      this.currentDisplayName = selected.entry.displayName || selected.entry.fileName;
    }
  }

  /** 重置 idle 計時器（fallback 模式用） */
  private resetIdleTimer(): void {
    this.idleTimer = 0;
    this.idleWaitTime = IDLE_WAIT_MIN + Math.random() * (IDLE_WAIT_MAX - IDLE_WAIT_MIN);
  }

  /** 依權重隨機選取動畫（使用者動畫專用） */
  private selectByWeight(animations: LoadedAnimation[]): LoadedAnimation | null {
    if (animations.length === 0) return null;
    if (animations.length === 1) return animations[0];

    const totalWeight = animations.reduce((sum, a) => sum + a.entry.weight, 0);
    if (totalWeight <= 0) return animations[0];

    let random = Math.random() * totalWeight;
    for (const anim of animations) {
      random -= anim.entry.weight;
      if (random <= 0) return anim;
    }

    return animations[animations.length - 1];
  }
}
