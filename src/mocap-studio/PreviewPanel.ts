/**
 * 影片動捕工作站 — VRM 預覽面板
 *
 * 獨立的 Three.js 場景，與主視窗的 SceneManager 完全分離。
 * 跑在 mocap-studio BrowserWindow 的 renderer process 內。
 *
 * 模組邊界例外說明：
 *   src/CLAUDE.md 規定「SceneManager 獨佔 render loop」，此規則指**主視窗**的
 *   render loop。PreviewPanel 跑在獨立 BrowserWindow + 獨立 renderer process，
 *   與主視窗無共享狀態，不受主視窗 render loop 規則約束
 *   （參考 vrm-picker/PreviewScene.ts 的相同設計）。
 *
 * Phase 0：只負責載入主視窗當前的 VRM 並靜態渲染。
 *   - PerspectiveCamera（LESSONS.md 2026-04-09：MToon outline 不能用正交）
 *   - 無動畫、無互動、無表情（保持在 rest pose）
 *   - SpringBone 物理每幀推進（讓頭髮/衣物有輕微重力下垂感）
 *
 * Phase 2c 會擴充：
 *   - 時間軸 scrub 時套用 MocapFrame[] 到 VRM
 *   - 不使用 AnimationMixer（避免 LESSONS.md 2026-04-09 的 clipAction reuse 陷阱）
 *   - 直接呼叫 VRMController.setBoneRotation()
 */

import * as THREE from 'three';
import { VRMController } from '../core/VRMController';
import type { MocapFrame, VrmHumanBoneName } from '../mocap/types';

/** 目標幀率（省電：30 fps） */
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

export class PreviewPanel {
  private static readonly FOV_DEG = 35;
  private static readonly LOOK_TARGET = new THREE.Vector3(0, 0.95, 0);
  private static readonly CAMERA_POSITION = new THREE.Vector3(0, 1.0, 2.4);

  private readonly canvas: HTMLCanvasElement;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;

  private vrmController: VRMController | null = null;

  private rafHandle: number | null = null;
  private lastFrameTime = 0;
  private lastUpdateTime = 0;
  private disposed = false;

  /** 載入序號，避免快速切換時舊的 loadModel 完成後覆蓋新的 */
  private loadToken = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14141c);

    // 燈光（參考 PreviewScene：環境 + 方向光）
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    this.scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 2, 1);
    this.scene.add(dir);

    // PerspectiveCamera — MToon outline 需要透視投影
    this.camera = new THREE.PerspectiveCamera(PreviewPanel.FOV_DEG, 1, 0.1, 100);
    this.camera.position.copy(PreviewPanel.CAMERA_POSITION);
    this.camera.lookAt(PreviewPanel.LOOK_TARGET);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.handleResize();

    window.addEventListener('resize', this.handleResize);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);

    this.startLoop();
  }

  /**
   * 載入 VRM 模型（取代既有模型）
   *
   * @param vrmPath VRM 檔案完整路徑（會自動轉為 local-file:// URL）
   * @returns 載入成功 true；失敗或已被新請求覆蓋 false
   */
  async loadModel(vrmUrl: string): Promise<boolean> {
    if (this.disposed) return false;
    const token = ++this.loadToken;

    this.disposeModel();

    const controller = new VRMController(this.scene);
    try {
      await controller.loadModel(vrmUrl);
    } catch (e) {
      console.warn('[PreviewPanel] loadModel failed:', e);
      controller.dispose();
      return false;
    }

    if (token !== this.loadToken || this.disposed) {
      controller.dispose();
      return false;
    }

    this.vrmController = controller;
    return true;
  }

  /**
   * 取得當前 VRM 模型實際存在的 humanoid bone 集合
   *
   * 供 MocapStudioApp 計算 SMPL → VRM 映射時使用。
   * 若尚未載入 VRM 則回傳空 Set。
   */
  getAvailableHumanoidBones(): Set<VrmHumanBoneName> {
    if (!this.vrmController) return new Set();
    return this.vrmController.getAvailableHumanoidBones() as Set<VrmHumanBoneName>;
  }

  /**
   * 套用單一 MocapFrame 到 VRM 預覽
   *
   * **不使用 AnimationMixer**（LESSONS.md 2026-04-09 clipAction reuse 陷阱）。
   * 直接透過 VRMController.setBoneRotations 寫入 bone quaternion，
   * 下一次 render loop 會渲染更新後的 pose。
   *
   * @param frame 已經過 smplToVrm + clamp + filter 的幀資料
   */
  applyMocapFrame(frame: MocapFrame): void {
    if (!this.vrmController) return;
    this.vrmController.setBoneRotations(frame.boneRotations);
  }

  /**
   * 將所有 humanoid bone 重置為 identity pose（rest pose）
   *
   * 離開 mocap 模式或載入新 fixture 時呼叫。
   */
  resetMocapPose(): void {
    if (!this.vrmController) return;
    this.vrmController.resetHumanoidPose();
  }

  /** 釋放當前模型（保留 renderer 與場景） */
  private disposeModel(): void {
    if (this.vrmController) {
      this.vrmController.dispose();
      this.vrmController = null;
    }
  }

  private startLoop(): void {
    this.lastFrameTime = performance.now();
    this.lastUpdateTime = this.lastFrameTime;
    const tick = (now: number): void => {
      if (this.disposed) return;
      this.rafHandle = requestAnimationFrame(tick);

      const delta = now - this.lastFrameTime;
      if (delta < FRAME_INTERVAL_MS) return;
      this.lastFrameTime = now - (delta % FRAME_INTERVAL_MS);

      const dt = Math.min(0.1, (now - this.lastUpdateTime) / 1000);
      this.lastUpdateTime = now;

      // 推進 VRM（SpringBone 物理 + mixer，但 Phase 0 無 mixer 資料，純 SpringBone）
      if (this.vrmController) {
        this.vrmController.update(dt);
      }

      this.renderer.render(this.scene, this.camera);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private readonly handleResize = (): void => {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  };

  private readonly handleVisibilityChange = (): void => {
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
    this.disposeModel();
    this.renderer.dispose();
  }
}
