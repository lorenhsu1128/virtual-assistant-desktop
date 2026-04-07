import * as THREE from 'three';
import type { AnimationCategory, AnimationEntry } from '../types/animation';

/** 動畫載入函式型別（由 VRMController 提供，避免直接依賴 @pixiv/three-vrm） */
export type AnimationLoader = (url: string) => Promise<THREE.AnimationClip | null>;

/** 載入後的動畫資料 */
interface LoadedAnimation {
  entry: AnimationEntry;
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

/** idle 動畫之間的等待時間隨機範圍（秒）— 從 0.5-2 拉長到 5-12 避免神經抽搐 */
const IDLE_WAIT_MIN = 5;
const IDLE_WAIT_MAX = 12;

/**
 * 依分類取得 crossfade 過渡時長（秒）
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
 */
export class AnimationManager {
  private mixer: THREE.AnimationMixer;
  private loadAnimation: AnimationLoader;

  /** 按分類索引的動畫清單 */
  private animationsByCategory: Map<AnimationCategory, LoadedAnimation[]> = new Map();

  /** 所有已載入的動畫 */
  private allAnimations: LoadedAnimation[] = [];

  /** 當前播放的 action */
  private currentAction: THREE.AnimationAction | null = null;

  /** 上一個 action（crossfade 用） */
  private previousAction: THREE.AnimationAction | null = null;

  /** 進行中的 cubic transition（階段 C）；null = 無 transition */
  private transitionState: TransitionState | null = null;

  /** idle 輪播計時器 */
  private idleTimer = 0;
  private idleWaitTime = 0;
  private isPlayingAction = false;
  private loopEnabled = true;

  /** 系統動畫（獨立於使用者動畫，優先級最高） */
  private systemAnimations: Map<string, THREE.AnimationClip> = new Map();

  /** 當前播放中的系統動畫 action */
  private systemAction: THREE.AnimationAction | null = null;

  /** 當前動畫的顯示名稱（.vrma 檔名或系統動畫名） */
  private currentDisplayName: string | null = null;

  /** 系統動畫播放前保存的狀態（用於恢復） */
  private savedState: { clip: THREE.AnimationClip; loop: boolean; isAction: boolean; displayName: string | null } | null = null;

  constructor(mixer: THREE.AnimationMixer, loadAnimation: AnimationLoader) {
    this.mixer = mixer;
    this.loadAnimation = loadAnimation;

    // 動畫播放結束時的回呼
    this.mixer.addEventListener('finished', this.onAnimationFinished);
  }

  /**
   * 載入動畫清單
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
   * 依分類播放動畫
   *
   * 從該分類中隨機選取一個動畫播放。
   */
  playByCategory(category: AnimationCategory): boolean {
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
   * 依名稱播放動畫
   */
  playByName(name: string): boolean {
    const anim = this.allAnimations.find((a) => a.entry.fileName === name);
    if (!anim) return false;

    const fade = getCrossfadeDurationFor(anim.entry.category);
    this.playClip(anim.clip, anim.entry.loop, anim.entry.category === 'action', fade);
    this.currentDisplayName = anim.entry.displayName || anim.entry.fileName;
    return true;
  }

  // ── 系統動畫 ──

  /**
   * 載入系統動畫
   *
   * 系統動畫獨立於使用者動畫，不進入分類索引、不出現在選單中。
   * @param name 系統動畫識別名稱（如 'drag'）
   * @param url 動畫檔案 URL
   */
  async loadSystemAnimation(name: string, url: string): Promise<boolean> {
    try {
      const clip = await this.loadAnimation(url);
      if (!clip) {
        console.warn(`[AnimationManager] System animation '${name}' produced no clip`);
        return false;
      }
      this.systemAnimations.set(name, clip);
      return true;
    } catch (e) {
      console.warn(`[AnimationManager] Failed to load system animation '${name}':`, e);
      return false;
    }
  }

  /** 取得系統動畫 clip（供 StepAnalyzer 等外部分析用） */
  getSystemAnimationClip(name: string): THREE.AnimationClip | null {
    return this.systemAnimations.get(name) ?? null;
  }

  /**
   * 註冊預建的系統動畫 clip
   *
   * 用於 runtime 產生的動畫（如鏡像版本），不需要從檔案載入。
   * @param name 系統動畫識別名稱
   * @param clip 預建的 AnimationClip
   */
  registerSystemAnimationClip(name: string, clip: THREE.AnimationClip): void {
    this.systemAnimations.set(name, clip);
  }

  /**
   * 播放系統動畫
   *
   * 自動保存當前動畫狀態，結束後可恢復。
   * 優先級高於所有一般動畫。
   */
  playSystemAnimation(name: string, loop = true, fadeDuration = CROSSFADE_DURATION): boolean {
    const clip = this.systemAnimations.get(name);
    if (!clip) return false;

    // 保存當前狀態（用於 stopSystemAnimation 恢復）
    if (this.currentAction && !this.systemAction) {
      this.savedState = {
        clip: this.currentAction.getClip(),
        loop: this.currentAction.loop === THREE.LoopRepeat,
        isAction: this.isPlayingAction,
        displayName: this.currentDisplayName,
      };
    }

    // 播放系統動畫（透過 cubic transition 銜接）
    const action = this.mixer.clipAction(clip);
    action.reset();
    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    action.play();

    // 階段 C：用 cubic transition 取代線性 fadeIn/fadeOut
    this.startTransition(this.currentAction, action, fadeDuration);

    this.systemAction = action;
    this.currentAction = action;
    this.currentDisplayName = `SYS:${name}`;
    return true;
  }

  /**
   * 停止系統動畫並恢復先前動畫
   */
  stopSystemAnimation(): void {
    if (!this.systemAction) return;

    // 不需要顯式 fadeOut：playClip / playNextIdle 內部會 startTransition
    // 把當前 systemAction 作為 oldAction 進行 cubic 衰減
    this.systemAction = null;

    // 恢復先前動畫
    if (this.savedState) {
      this.playClip(this.savedState.clip, this.savedState.loop, this.savedState.isAction);
      this.currentDisplayName = this.savedState.displayName;
      this.savedState = null;
    } else {
      // 無保存狀態，回到 idle 輪播
      this.playNextIdle();
      this.resetIdleTimer();
    }
  }

  /** 是否正在播放系統動畫 */
  isSystemAnimationPlaying(): boolean {
    return this.systemAction !== null;
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
  }

  /** 取得當前播放的 clip */
  getCurrentClip(): THREE.AnimationClip | null {
    return this.currentAction?.getClip() ?? null;
  }

  /** 取得當前播放的動畫顯示名稱（.vrma 檔名或系統動畫名） */
  getCurrentAnimationName(): string | null {
    return this.currentDisplayName;
  }

  /** 檢查是否有該分類的動畫 */
  hasCategory(category: AnimationCategory): boolean {
    const list = this.animationsByCategory.get(category);
    return !!list && list.length > 0;
  }

  /** 取得指定分類的動畫列表 */
  getAnimationsByCategory(category: AnimationCategory): AnimationEntry[] {
    return (this.animationsByCategory.get(category) ?? []).map((a) => a.entry);
  }

  /** 檢查是否有任何已載入的動畫 */
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

    if (this.systemAction) return; // 系統動畫播放中，暫停 idle 輪播
    if (this.isPlayingAction) return;
    if (!this.loopEnabled) return;

    // idle 輪播計時
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
   *
   * 若有正在進行的 transition：先停止舊的，再啟動新的。
   * oldAction 的初始 weight 取自當前 effective weight（若被中斷則從中段繼續）。
   */
  private startTransition(
    oldAction: THREE.AnimationAction | null,
    newAction: THREE.AnimationAction,
    duration: number,
  ): void {
    // 終止任何進行中的舊 transition（清除被覆蓋的舊動作）
    if (this.transitionState && this.transitionState.oldAction !== oldAction) {
      this.transitionState.oldAction.setEffectiveWeight(0);
      this.transitionState.oldAction.stop();
    }
    this.transitionState = null;

    // 沒有 oldAction 或同一個 action：直接全權重，無 transition
    if (!oldAction || oldAction === newAction) {
      newAction.setEffectiveWeight(1);
      return;
    }

    newAction.setEffectiveWeight(0);
    // 不強制設定 oldAction.weight，沿用當前 weight（可能正在 fading）

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
    // t=0:    decay=1.000  → oldWeight=initialOldWeight, newWeight=0
    // t=0.1:  decay=0.729  → 舊動作仍保留 73% 影響（inertia 感）
    // t=0.3:  decay=0.343
    // t=0.5:  decay=0.125  → 半時舊動作只剩 12.5%
    // t=0.7:  decay=0.027
    // t=1.0:  decay=0      → newWeight=1
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
    this.systemAction = null;
    this.savedState = null;
    this.allAnimations = [];
    this.animationsByCategory.clear();
    this.systemAnimations.clear();
  }

  /**
   * 播放 clip
   *
   * @param clip 動畫 clip
   * @param loop 是否循環
   * @param isAction 是否為 action（觸發 onAnimationFinished 回 idle 邏輯）
   * @param fadeDuration 自訂 crossfade 時長（秒），不指定時用 CROSSFADE_DURATION
   */
  private playClip(
    clip: THREE.AnimationClip,
    loop: boolean,
    isAction: boolean,
    fadeDuration: number = CROSSFADE_DURATION,
  ): void {
    this.previousAction = this.currentAction;
    this.isPlayingAction = isAction;

    const action = this.mixer.clipAction(clip);
    action.reset();

    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }

    // 階段 C：用 cubic transition 取代 Three.js 線性 crossFadeTo
    // ease-out cubic 衰減讓舊動作的影響保留更久，視覺效果類似 inertialization
    action.play();
    this.startTransition(this.previousAction, action, fadeDuration);
    this.currentAction = action;
  }

  /** 動畫播放結束回呼 */
  private onAnimationFinished = (): void => {
    if (this.isPlayingAction) {
      // action 播完後回到 idle 輪播
      // 用 RETURN_TO_IDLE_FADE（1.0s）較長的 crossfade 掩蓋 action 結尾 pose 與 idle 起始 pose 的差異
      this.isPlayingAction = false;
      this.playNextIdle(true);
      this.resetIdleTimer();
    }
  };

  /** 開始 idle 輪播 */
  private startIdleLoop(): void {
    this.isPlayingAction = false;
    this.playNextIdle();
    this.resetIdleTimer();
  }

  /**
   * 播放下一個 idle 動畫（無 idle 分類時從所有動畫中選取）
   *
   * @param returnFromAction 若為 true，使用較長的 crossfade（1.0s 取代 0.7s）
   *                         以掩蓋 action 結尾 pose 差異
   */
  private playNextIdle(returnFromAction = false): void {
    let pool = this.animationsByCategory.get('idle');
    if (!pool || pool.length === 0) {
      // fallback：沒有 idle 動畫時，從全部動畫中輪播
      pool = this.allAnimations;
    }
    if (pool.length === 0) return;

    const selected = this.selectByWeight(pool);
    if (selected) {
      // idle 輪播一律循環播放，避免 T-pose
      const fade = returnFromAction
        ? RETURN_TO_IDLE_FADE
        : getCrossfadeDurationFor('idle');
      this.playClip(selected.clip, true, false, fade);
      this.currentDisplayName = selected.entry.displayName || selected.entry.fileName;
    }
  }

  /** 重置 idle 計時器 */
  private resetIdleTimer(): void {
    this.idleTimer = 0;
    this.idleWaitTime = IDLE_WAIT_MIN + Math.random() * (IDLE_WAIT_MAX - IDLE_WAIT_MIN);
  }

  /** 依權重隨機選取動畫 */
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
