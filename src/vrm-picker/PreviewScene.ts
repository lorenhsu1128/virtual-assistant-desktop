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
 */

import * as THREE from 'three';
import { VRMController } from '../core/VRMController';
import { FallbackAnimation } from '../animation/FallbackAnimation';
import type { AnimationEntry } from '../types/animation';
import { ipc } from '../bridge/ElectronIPC';

const TARGET_FPS = 30;
const FRAME_INTERVAL = 1000 / TARGET_FPS;

export class PreviewScene {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;

  private vrmController: VRMController | null = null;
  private fallback: FallbackAnimation | null = null;
  private currentClipAction: THREE.AnimationAction | null = null;

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
    this.camera.position.set(0, 1.0, 2.4);
    this.camera.lookAt(0, 0.95, 0);

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

    this.startLoop();
  }

  /** 載入 VRM 模型，並嘗試啟動 idle 動畫 */
  async loadModel(
    vrmPath: string,
    animationFolder: string | null,
    idleEntries: AnimationEntry[],
  ): Promise<void> {
    if (this.disposed) return;
    const token = ++this.loadToken;

    // 釋放舊模型
    this.disposeModel();

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

    // 嘗試播放 idle 動畫
    await this.tryPlayIdle(animationFolder, idleEntries, token);
  }

  /** 嘗試播放隨機 idle 動畫，無 idle 時 fallback */
  private async tryPlayIdle(
    animationFolder: string | null,
    idleEntries: AnimationEntry[],
    token: number,
  ): Promise<void> {
    const controller = this.vrmController;
    if (!controller) return;

    if (animationFolder && idleEntries.length > 0) {
      // 隨機挑一個 idle .vrma
      const entry = idleEntries[Math.floor(Math.random() * idleEntries.length)];
      const fullPath = `${animationFolder}/${entry.fileName}`.replace(/\\/g, '/');
      const animUrl = ipc.convertToAssetUrl(fullPath);
      try {
        const clip = await controller.loadVRMAnimation(animUrl);
        if (token !== this.loadToken || this.disposed) return;
        if (clip) {
          const mixer = controller.getAnimationMixer();
          if (mixer) {
            const action = mixer.clipAction(clip);
            action.reset();
            action.setLoop(THREE.LoopRepeat, Infinity);
            action.play();
            this.currentClipAction = action;
            return;
          }
        }
      } catch (e) {
        console.warn('[PreviewScene] idle animation load failed, fallback:', e);
      }
    }

    // Fallback：呼吸 + 眨眼
    if (token !== this.loadToken || this.disposed) return;
    this.fallback = new FallbackAnimation(controller);
    this.fallback.start();
  }

  private disposeModel(): void {
    if (this.fallback) {
      this.fallback.stop();
      this.fallback = null;
    }
    if (this.currentClipAction) {
      this.currentClipAction.stop();
      this.currentClipAction = null;
    }
    if (this.vrmController) {
      this.vrmController.dispose();
      this.vrmController = null;
    }
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
    this.disposeModel();
    this.renderer.dispose();
  }
}
