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
    return true;
  }

  /**
   * 依名稱播放動畫
   */
  playByName(name: string): boolean {
    const anim = this.allAnimations.find((a) => a.entry.fileName === name);
    if (!anim) return false;

    this.playClip(anim.clip, anim.entry.loop, anim.entry.category === 'action');
    return true;
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

  /**
   * 更新動畫系統
   *
   * 由 SceneManager render loop 呼叫。
   * 注意：mixer.update 由 VRMController.update 負責，
   * 這裡只處理 idle 輪播邏輯。
   */
  update(deltaTime: number): void {
    if (this.isPlayingAction) return;

    // idle 輪播計時
    this.idleTimer += deltaTime;
    if (this.idleTimer >= this.idleWaitTime) {
      this.playNextIdle();
      this.resetIdleTimer();
    }
  }

  /** 銷毀 */
  dispose(): void {
    this.mixer.removeEventListener('finished', this.onAnimationFinished);
    this.stopCurrent();
    this.allAnimations = [];
    this.animationsByCategory.clear();
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
