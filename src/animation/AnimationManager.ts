import * as THREE from 'three';
import type { AnimationCategory, AnimationEntry } from '../types/animation';

/** 動畫載入函式型別（由 VRMController 提供，避免直接依賴 @pixiv/three-vrm） */
export type AnimationLoader = (url: string) => Promise<THREE.AnimationClip | null>;

/** 載入後的動畫資料 */
interface LoadedAnimation {
  entry: AnimationEntry;
  clip: THREE.AnimationClip;
}

/** Crossfade 過渡時間（秒） */
const CROSSFADE_DURATION = 0.5;

/** idle 動畫之間的等待時間隨機範圍（秒） */
const IDLE_WAIT_MIN = 0.5;
const IDLE_WAIT_MAX = 2.0;

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
  private savedState: { clip: THREE.AnimationClip; loop: boolean; isAction: boolean } | null = null;

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

    this.playClip(selected.clip, selected.entry.loop, category === 'action');
    this.currentDisplayName = selected.entry.displayName || selected.entry.fileName;
    return true;
  }

  /**
   * 依名稱播放動畫
   */
  playByName(name: string): boolean {
    const anim = this.allAnimations.find((a) => a.entry.fileName === name);
    if (!anim) return false;

    this.playClip(anim.clip, anim.entry.loop, anim.entry.category === 'action');
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
      };
    }

    // 淡出當前動畫
    if (this.currentAction) {
      this.currentAction.fadeOut(fadeDuration);
    }

    // 播放系統動畫
    const action = this.mixer.clipAction(clip);
    action.reset();
    if (loop) {
      action.setLoop(THREE.LoopRepeat, Infinity);
    } else {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    }
    action.fadeIn(fadeDuration);
    action.play();

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

    // 淡出系統動畫
    this.systemAction.fadeOut(CROSSFADE_DURATION);
    this.systemAction = null;

    // 恢復先前動畫
    if (this.savedState) {
      this.playClip(this.savedState.clip, this.savedState.loop, this.savedState.isAction);
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
    if (this.currentAction) {
      this.currentAction.fadeOut(CROSSFADE_DURATION);
      this.currentAction = null;
    }
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
   * 這裡只處理 idle 輪播邏輯。
   */
  update(deltaTime: number): void {
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
    this.stopCurrent();
    this.systemAction = null;
    this.savedState = null;
    this.allAnimations = [];
    this.animationsByCategory.clear();
    this.systemAnimations.clear();
  }

  /** 播放 clip */
  private playClip(clip: THREE.AnimationClip, loop: boolean, isAction: boolean): void {
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

    if (this.previousAction) {
      this.previousAction.fadeOut(CROSSFADE_DURATION);
    }

    action.fadeIn(CROSSFADE_DURATION);
    action.play();
    this.currentAction = action;
  }

  /** 動畫播放結束回呼 */
  private onAnimationFinished = (): void => {
    if (this.isPlayingAction) {
      // action 播完後回到 idle 輪播
      this.isPlayingAction = false;
      this.playNextIdle();
      this.resetIdleTimer();
    }
  };

  /** 開始 idle 輪播 */
  private startIdleLoop(): void {
    this.isPlayingAction = false;
    this.playNextIdle();
    this.resetIdleTimer();
  }

  /** 播放下一個 idle 動畫（無 idle 分類時從所有動畫中選取） */
  private playNextIdle(): void {
    let pool = this.animationsByCategory.get('idle');
    if (!pool || pool.length === 0) {
      // fallback：沒有 idle 動畫時，從全部動畫中輪播
      pool = this.allAnimations;
    }
    if (pool.length === 0) return;

    const selected = this.selectByWeight(pool);
    if (selected) {
      // idle 輪播一律循環播放，避免 T-pose
      this.playClip(selected.clip, true, false);
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
