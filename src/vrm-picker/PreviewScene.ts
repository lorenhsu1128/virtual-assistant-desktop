/**
 * VRM 模型瀏覽對話框 — 輕量預覽場景
 *
 * 自有的 Three.js 場景與 render loop，與主視窗的 SceneManager 完全分離。
 *
 * 模組邊界例外說明：
 *   src/CLAUDE.md 規定「SceneManager 獨佔 render loop」，此規則指**主視窗**的 render loop。
 *   PreviewScene 跑在獨立的 BrowserWindow + 獨立 renderer process，與主視窗無共享狀態，
 *   不受主視窗 render loop 規則約束。
 *
 * 重用 VRMController 與 FallbackAnimation：
 *   - VRMController 構造子接受任意 THREE.Scene，可獨立實例化
 *   - FallbackAnimation 純靠 VRMController 驅動，無外部依賴
 *
 * 動畫策略：
 *   - 永遠播放系統內建的 SYS_IDLE_*.vrma（assets/system/vrma/）
 *   - 每段以 LoopOnce 播放，'finished' 事件觸發後 crossfade 到下一段
 *   - 若 SYS_IDLE 檔案不存在則 fallback 到呼吸/眨眼
 *
 * 互動：
 *   - 左鍵拖曳水平 → 旋轉角色 Y 軸
 *   - 左鍵拖曳垂直 → 推拉攝影機（沿 lookAt 方向）
 *   - 切換模型時旋轉與縮放歸零
 */

import * as THREE from 'three';
import { VRMController } from '../core/VRMController';
import { FallbackAnimation } from '../animation/FallbackAnimation';
import { ipc } from '../bridge/ElectronIPC';
import { clamp, isSysIdleFile } from './pickerLogic';

const TARGET_FPS = 30;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

/** 一段動畫播完後的等待時間（秒），之後 crossfade 到下一段 */
const NEXT_IDLE_DELAY_MS = 200;
/** crossfade 時長（秒） */
const CROSSFADE_DURATION = 0.5;

export class PreviewScene {
  // ── 攝影機 / 互動常數 ──
  private static readonly INITIAL_DISTANCE = 2.4;
  private static readonly MIN_DISTANCE = 1.0;
  private static readonly MAX_DISTANCE = 5.0;
  private static readonly ROTATE_SENSITIVITY = 0.01;
  private static readonly ZOOM_SENSITIVITY = 0.01;
  private static readonly LOOK_TARGET = new THREE.Vector3(0, 0.95, 0);
  /** 預設攝影機位置（從 LOOK_TARGET 出發的方向計算用） */
  private static readonly DEFAULT_CAMERA_POS = new THREE.Vector3(0, 1.0, 2.4);

  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private vrmController: VRMController | null = null;
  private fallback: FallbackAnimation | null = null;

  // ── SYS_IDLE 連續播放狀態 ──
  private sysIdleFiles: string[] = [];
  private currentSysAction: THREE.AnimationAction | null = null;
  private nextIdleTimer: number | null = null;
  private mixerListenerRegistered = false;

  // ── 互動狀態 ──
  private rotationY = 0;
  private cameraDistance = PreviewScene.INITIAL_DISTANCE;
  private isDragging = false;
  private lastDragX = 0;
  private lastDragY = 0;

  private rafHandle: number | null = null;
  private lastFrameTime = 0;
  private lastUpdateTime = 0;
  private disposed = false;

  /** 載入序號，避免快速切換時舊的 loadModel 完成後覆蓋新的 */
  private loadToken = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x222233);

    // 燈光
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);

    // 攝影機（角色身高約 1.5m，鏡頭擺在腰部往前 2m）
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    this.applyRotationAndZoom();

    // 渲染器
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.handleResize();

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    // 滑鼠拖曳互動：mousedown 在 canvas 上，move/up 在 window 上
    // （拖曳中游標可能滑出 canvas 範圍，要繼續追蹤）
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);

    this.startLoop();
  }

  /**
   * 載入 VRM 模型並啟動 SYS_IDLE 連續播放
   *
   * @param vrmPath VRM 模型完整路徑
   * @param sysVrmaDir 系統 vrma 資料夾完整路徑（appPath + systemAssetsDir + '/vrma'）
   */
  async loadModel(vrmPath: string, sysVrmaDir: string): Promise<void> {
    if (this.disposed) return;
    const token = ++this.loadToken;

    // 釋放舊模型與動畫狀態
    this.disposeModel();

    // 重置旋轉與縮放並立即套用
    this.rotationY = 0;
    this.cameraDistance = PreviewScene.INITIAL_DISTANCE;
    this.applyRotationAndZoom();

    const url = ipc.convertToAssetUrl(vrmPath);
    const controller = new VRMController(this.scene);
    try {
      await controller.loadModel(url);
    } catch (e) {
      console.warn('[PreviewScene] loadModel failed:', e);
      controller.dispose();
      return;
    }

    // 若已被新的請求覆蓋則放棄
    if (token !== this.loadToken || this.disposed) {
      controller.dispose();
      return;
    }

    this.vrmController = controller;
    // 立即套用初始旋轉（確保新模型出現時就在零旋轉狀態）
    controller.setFacingRotationY(this.rotationY);

    // 啟動 SYS_IDLE 連續播放
    await this.startSysIdleLoop(sysVrmaDir, token);
  }

  // ── SYS_IDLE 連續播放 ──

  private async startSysIdleLoop(sysVrmaDir: string, token: number): Promise<void> {
    const controller = this.vrmController;
    if (!controller) return;

    // 1. 掃描資料夾並過濾 SYS_IDLE_*.vrma
    console.log('[PreviewScene] Scanning sysVrmaDir:', sysVrmaDir);
    const all = await ipc.scanVrmaFiles(sysVrmaDir);
    if (token !== this.loadToken || this.disposed) return;
    this.sysIdleFiles = all.filter(isSysIdleFile);
    console.log(
      `[PreviewScene] Found ${all.length} .vrma files, ${this.sysIdleFiles.length} are SYS_IDLE`,
    );

    if (this.sysIdleFiles.length === 0) {
      console.warn(
        '[PreviewScene] No SYS_IDLE_*.vrma found, falling back to breathing/blinking',
      );
      this.fallback = new FallbackAnimation(controller);
      this.fallback.start();
      return;
    }

    // 2. 註冊 mixer finished handler（每個 controller 一次）
    const mixer = controller.getAnimationMixer();
    if (mixer && !this.mixerListenerRegistered) {
      mixer.addEventListener('finished', this.onSysIdleFinished);
      this.mixerListenerRegistered = true;
    }

    // 3. 播第一個（無 crossfade）
    await this.playRandomSysIdle(token, false);
  }

  private playRandomSysIdle = async (
    token: number,
    crossfadeFromPrev: boolean,
  ): Promise<void> => {
    if (token !== this.loadToken || this.disposed) return;
    const controller = this.vrmController;
    if (!controller || this.sysIdleFiles.length === 0) return;

    const idx = Math.floor(Math.random() * this.sysIdleFiles.length);
    const url = ipc.convertToAssetUrl(this.sysIdleFiles[idx]);

    let clip: THREE.AnimationClip | null = null;
    try {
      clip = await controller.loadVRMAnimation(url);
    } catch (e) {
      console.warn('[PreviewScene] SYS_IDLE load failed:', url, e);
      return;
    }
    if (token !== this.loadToken || this.disposed) return;
    if (!clip) {
      console.warn('[PreviewScene] SYS_IDLE clip is null:', url);
      return;
    }
    console.log('[PreviewScene] Playing SYS_IDLE:', this.sysIdleFiles[idx]);

    const mixer = controller.getAnimationMixer();
    if (!mixer) return;

    const action = mixer.clipAction(clip);
    action.reset();
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;

    if (crossfadeFromPrev && this.currentSysAction) {
      this.currentSysAction.crossFadeTo(action, CROSSFADE_DURATION, true);
    }
    action.play();
    this.currentSysAction = action;
  };

  private onSysIdleFinished = (): void => {
    // 'finished' event 觸發於 LoopOnce 結束時。等一下下立刻接下一段（crossfade）。
    if (this.disposed) return;
    this.nextIdleTimer = window.setTimeout(() => {
      this.nextIdleTimer = null;
      void this.playRandomSysIdle(this.loadToken, true);
    }, NEXT_IDLE_DELAY_MS);
  };

  // ── 滑鼠拖曳互動 ──

  private onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return; // 只接受左鍵
    this.isDragging = true;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
    this.canvas.classList.add('dragging');
    e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isDragging) return;
    const dx = e.clientX - this.lastDragX;
    const dy = e.clientY - this.lastDragY;
    this.lastDragX = e.clientX;
    this.lastDragY = e.clientY;
    this.rotationY += dx * PreviewScene.ROTATE_SENSITIVITY;
    this.cameraDistance = clamp(
      this.cameraDistance + dy * PreviewScene.ZOOM_SENSITIVITY,
      PreviewScene.MIN_DISTANCE,
      PreviewScene.MAX_DISTANCE,
    );
    this.applyRotationAndZoom();
  };

  private onMouseUp = (): void => {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.canvas.classList.remove('dragging');
  };

  /** 套用當前旋轉與相機距離到 VRMController 與 camera */
  private applyRotationAndZoom(): void {
    if (this.vrmController) {
      this.vrmController.setFacingRotationY(this.rotationY);
    }
    // 沿 lookAt 方向縮放：方向 = normalize(DEFAULT_CAMERA_POS - LOOK_TARGET)
    // 新位置 = LOOK_TARGET + dir * cameraDistance
    const target = PreviewScene.LOOK_TARGET;
    const def = PreviewScene.DEFAULT_CAMERA_POS;
    const dirX = def.x - target.x;
    const dirY = def.y - target.y;
    const dirZ = def.z - target.z;
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    this.camera.position.set(
      target.x + (dirX / len) * this.cameraDistance,
      target.y + (dirY / len) * this.cameraDistance,
      target.z + (dirZ / len) * this.cameraDistance,
    );
    this.camera.lookAt(target);
  }

  // ── 釋放 ──

  private disposeModel(): void {
    if (this.nextIdleTimer !== null) {
      clearTimeout(this.nextIdleTimer);
      this.nextIdleTimer = null;
    }
    if (this.fallback) {
      this.fallback.stop();
      this.fallback = null;
    }
    if (this.currentSysAction) {
      this.currentSysAction.stop();
      this.currentSysAction = null;
    }
    if (this.vrmController) {
      const mixer = this.vrmController.getAnimationMixer();
      if (mixer && this.mixerListenerRegistered) {
        mixer.removeEventListener('finished', this.onSysIdleFinished);
      }
      this.mixerListenerRegistered = false;
      this.vrmController.dispose();
      this.vrmController = null;
    }
    this.sysIdleFiles = [];
  }

  private startLoop(): void {
    this.lastFrameTime = performance.now();
    this.lastUpdateTime = this.lastFrameTime;
    const tick = (now: number) => {
      if (this.disposed) return;
      this.rafHandle = requestAnimationFrame(tick);

      const delta = now - this.lastFrameTime;
      if (delta < FRAME_INTERVAL) return;
      this.lastFrameTime = now - (delta % FRAME_INTERVAL);

      const dt = Math.min(0.1, (now - this.lastUpdateTime) / 1000);
      this.lastUpdateTime = now;

      if (this.fallback) this.fallback.update(dt);
      if (this.vrmController) this.vrmController.update(dt);

      this.renderer.render(this.scene, this.camera);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private handleResize = (): void => {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      if (this.rafHandle !== null) {
        cancelAnimationFrame(this.rafHandle);
        this.rafHandle = null;
      }
    } else if (!this.disposed && this.rafHandle === null) {
      this.startLoop();
    }
  };

  /** 釋放所有資源 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.disposeModel();
    this.renderer.dispose();
  }
}
