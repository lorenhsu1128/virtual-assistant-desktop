import * as THREE from 'three';
import { VRMController } from './VRMController';
import type { AnimationManager } from '../animation/AnimationManager';
import type { FallbackAnimation } from '../animation/FallbackAnimation';
import type { StateMachine } from '../behavior/StateMachine';
import type { CollisionSystem } from '../behavior/CollisionSystem';
import type { BehaviorAnimationBridge } from '../behavior/BehaviorAnimationBridge';
import type { ExpressionManager } from '../expression/ExpressionManager';
import type { DebugOverlay, BoneDebugData } from '../debug/DebugOverlay';
import type { Rect } from '../types/window';

/** 幀率模式 */
type FpsMode = 'foreground' | 'background' | 'powerSave';

/** 幀率模式對應的目標 fps */
const FPS_MAP: Record<FpsMode, number> = {
  foreground: 30,
  background: 10,
  powerSave: 15,
};

/** 遮擋更新最小間隔（ms） */
const OCCLUSION_UPDATE_INTERVAL = 100;

/**
 * Three.js 場景的生命週期管理
 *
 * 擁有唯一的 requestAnimationFrame 主迴圈。
 * 每幀依序執行：StateMachine → CollisionSystem → AnimationManager → VRMController → render
 */
export class SceneManager {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;

  private vrmController: VRMController | null = null;
  private animationManager: AnimationManager | null = null;
  private fallbackAnimation: FallbackAnimation | null = null;
  private useFallback = false;

  // v0.2 模組
  private stateMachine: StateMachine | null = null;
  private collisionSystem: CollisionSystem | null = null;
  private behaviorBridge: BehaviorAnimationBridge | null = null;

  // v0.3 模組
  private expressionManager: ExpressionManager | null = null;
  private lastAppliedExpression: string | null = null;

  // Debug
  private debugOverlay: DebugOverlay | null = null;
  private static readonly DEBUG_BONES = ['head', 'leftHand', 'rightHand', 'hips', 'leftFoot', 'rightFoot'];

  // 視窗位置管理
  private currentPosition = { x: 0, y: 0 };
  private windowSize = { width: 400, height: 600 };
  private positionSetter: ((x: number, y: number) => void) | null = null;
  private occlusionSetter: ((rects: Rect[]) => void) | null = null;
  private lastOcclusionUpdate = 0;
  private lastOcclusionHash = '';

  private targetFps: number;
  private fpsMode: FpsMode = 'foreground';
  private lastFrameTime = 0;
  private animationFrameId = 0;
  private running = false;

  private scale = 1.0;

  // Orbit camera（右鍵拖曳旋轉）
  private orbitTheta = 0; // 水平角（弧度）
  private orbitPhi = Math.PI / 2; // 垂直角（弧度），π/2 = 正面
  private orbitRadius = 3.5;
  private orbitTarget = { x: 0, y: 0.8, z: 0 };
  private isOrbiting = false;
  private orbitStartX = 0;
  private orbitStartY = 0;
  private orbitMoved = false;

  constructor(canvas: HTMLCanvasElement, targetFps = 30) {
    this.targetFps = targetFps;

    // Scene
    this.scene = new THREE.Scene();

    // Camera
    this.camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 0.1, 20);
    this.camera.position.set(0, 0.8, 3.5);
    this.camera.lookAt(0, 0.8, 0);

    // Renderer — 透明背景
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
    });
    this.renderer.setSize(canvas.width, canvas.height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    // 燈光
    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
    directionalLight.position.set(1.0, 1.0, 1.0).normalize();
    this.scene.add(directionalLight);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    this.clock = new THREE.Clock();

    // WebGL context lost/restored 監聽
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    // 視窗 resize
    window.addEventListener('resize', this.onResize);

    // 視窗可見性變化 → 切換幀率模式
    document.addEventListener('visibilitychange', this.onVisibilityChange);

    // Orbit camera 事件
    canvas.addEventListener('mousedown', this.onOrbitMouseDown);
    window.addEventListener('mousemove', this.onOrbitMouseMove);
    window.addEventListener('mouseup', this.onOrbitMouseUp);
  }

  /** 取得 Three.js scene（僅供 VRMController 使用） */
  getScene(): THREE.Scene {
    return this.scene;
  }

  /** 取得 canvas 元素 */
  getCanvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  /** 設定 VRMController */
  setVRMController(controller: VRMController): void {
    this.vrmController = controller;
  }

  /** 設定 AnimationManager */
  setAnimationManager(manager: AnimationManager): void {
    this.animationManager = manager;
  }

  /** 設定 FallbackAnimation */
  setFallbackAnimation(fallback: FallbackAnimation): void {
    this.fallbackAnimation = fallback;
  }

  /** 設定是否使用 fallback 動畫 */
  setUseFallback(useFallback: boolean): void {
    this.useFallback = useFallback;
    if (useFallback) {
      this.fallbackAnimation?.start();
    } else {
      this.fallbackAnimation?.stop();
    }
  }

  /** 設定 StateMachine (v0.2) */
  setStateMachine(sm: StateMachine): void {
    this.stateMachine = sm;
  }

  /** 設定 CollisionSystem (v0.2) */
  setCollisionSystem(cs: CollisionSystem): void {
    this.collisionSystem = cs;
  }

  /** 設定 BehaviorAnimationBridge (v0.2) */
  setBehaviorAnimationBridge(bridge: BehaviorAnimationBridge): void {
    this.behaviorBridge = bridge;
  }

  /** 設定 ExpressionManager (v0.3) */
  setExpressionManager(em: ExpressionManager): void {
    this.expressionManager = em;
  }

  /** 設定 Debug Overlay */
  setDebugOverlay(overlay: DebugOverlay): void {
    this.debugOverlay = overlay;
  }

  /** 設定位置更新 callback（fire-and-forget） */
  setPositionSetter(setter: (x: number, y: number) => void): void {
    this.positionSetter = setter;
  }

  /** 設定遮擋更新 callback */
  setOcclusionSetter(setter: (rects: Rect[]) => void): void {
    this.occlusionSetter = setter;
  }

  /** 更新當前視窗位置（由外部同步） */
  setCurrentPosition(pos: { x: number; y: number }): void {
    this.currentPosition = pos;
  }

  /** 設定視窗大小 */
  setWindowSize(size: { width: number; height: number }): void {
    this.windowSize = size;
  }

  /** 取得角色的螢幕 bounding box */
  getCharacterBounds(): Rect {
    return {
      x: this.currentPosition.x,
      y: this.currentPosition.y,
      width: this.windowSize.width,
      height: this.windowSize.height,
    };
  }

  /** 設定角色縮放（0.5–2.0） */
  setScale(scale: number): void {
    this.scale = Math.max(0.5, Math.min(2.0, scale));
    if (this.vrmController) {
      this.vrmController.setModelScale(this.scale);
    }
  }

  /** 取得角色縮放 */
  getScale(): number {
    return this.scale;
  }

  /** 設定目標幀率 */
  setTargetFps(fps: number): void {
    this.targetFps = Math.max(1, Math.min(60, fps));
  }

  /** 啟動 render loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.lastFrameTime = performance.now();
    this.animationFrameId = requestAnimationFrame(this.loop);
  }

  /** 停止 render loop */
  stop(): void {
    this.running = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
  }

  /** 銷毀場景並釋放資源 */
  dispose(): void {
    this.stop();
    this.renderer.dispose();
    this.scene.clear();
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('mousemove', this.onOrbitMouseMove);
    window.removeEventListener('mouseup', this.onOrbitMouseUp);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    canvas.removeEventListener('mousedown', this.onOrbitMouseDown);
  }

  /**
   * 主渲染迴圈
   *
   * 使用 rAF + deltaTime 跳幀控制幀率。
   * 每幀執行順序（ARCHITECTURE.md §2.2）：
   * 1. StateMachine.tick
   * 2. CollisionSystem.check
   * 3. AnimationManager.update / FallbackAnimation.update
   * 4. (v0.3) ExpressionManager.resolve
   * 5. VRMController.update
   * 6. renderer.render
   */
  private loop = (now: number): void => {
    if (!this.running) return;
    this.animationFrameId = requestAnimationFrame(this.loop);

    const currentTargetFps = FPS_MAP[this.fpsMode] ?? this.targetFps;
    const targetInterval = 1000 / currentTargetFps;
    const delta = now - this.lastFrameTime;

    if (delta < targetInterval) return; // 跳幀

    this.lastFrameTime = now - (delta % targetInterval);
    const deltaTime = Math.min(delta / 1000, 0.1); // cap at 100ms to avoid spiral

    // Step 1 & 2: StateMachine + CollisionSystem
    if (this.stateMachine && this.collisionSystem && !this.stateMachine.isPaused()) {
      const characterBounds = this.getCharacterBounds();

      // CollisionSystem 檢測
      const collision = this.collisionSystem.check(characterBounds);

      // StateMachine 更新
      const output = this.stateMachine.tick(
        {
          currentPosition: this.currentPosition,
          characterBounds,
          screenBounds: this.collisionSystem.getScreenBounds(),
          windowRects: this.collisionSystem.getWindowRects(),
          scale: this.scale,
          deltaTime,
        },
        collision,
      );

      // 套用目標位置
      if (output.targetPosition) {
        const clamped = this.collisionSystem.clampToScreen(
          output.targetPosition,
          this.windowSize.width,
          this.windowSize.height,
        );
        this.currentPosition = clamped;
        this.positionSetter?.(clamped.x, clamped.y);
      }

      // BehaviorAnimationBridge 更新
      if (this.behaviorBridge) {
        this.behaviorBridge.update(output);
      }
    }

    // 遮擋更新（獨立於 StateMachine 暫停狀態，拖曳時也需要更新）
    if (this.collisionSystem && this.occlusionSetter && now - this.lastOcclusionUpdate > OCCLUSION_UPDATE_INTERVAL) {
      const occlusionRects = this.collisionSystem.getOcclusionRects(this.getCharacterBounds());
      const hash = this.hashOcclusionRects(occlusionRects);
      if (hash !== this.lastOcclusionHash) {
        this.lastOcclusionHash = hash;
        this.occlusionSetter(occlusionRects);
      }
      this.lastOcclusionUpdate = now;
    }

    // Step 3: Animation update
    if (this.useFallback && this.fallbackAnimation) {
      this.fallbackAnimation.update(deltaTime);
    } else if (this.animationManager) {
      this.animationManager.update(deltaTime);
    }

    // Step 4: ExpressionManager
    if (this.expressionManager && this.vrmController) {
      this.expressionManager.update(deltaTime);

      // 動畫播放中（含表情軌道）時跳過表情仲裁
      const actionPlaying = this.animationManager?.isActionPlaying() ?? false;
      if (!actionPlaying) {
        const expr = this.expressionManager.resolve();
        const newName = expr?.name ?? null;

        // 清除舊表情（如果換了不同的）
        if (this.lastAppliedExpression && this.lastAppliedExpression !== newName) {
          this.vrmController.setBlendShape(this.lastAppliedExpression, 0);
        }

        // 套用新表情
        if (expr) {
          this.vrmController.setBlendShape(expr.name, expr.value);
        }
        this.lastAppliedExpression = newName;
      }
    }

    // Step 5: VRM update (SpringBone etc.)
    if (this.vrmController) {
      this.vrmController.update(deltaTime);
    }

    // Debug overlay: 骨骼座標視覺化
    if (this.debugOverlay?.isEnabled() && this.vrmController) {
      const canvas = this.renderer.domElement;
      const screenPositions = this.vrmController.getBoneScreenPositions(
        SceneManager.DEBUG_BONES,
        this.camera,
        canvas.clientWidth,
        canvas.clientHeight,
      );

      const boneData: BoneDebugData[] = SceneManager.DEBUG_BONES.map((name) => ({
        boneName: name,
        world: this.vrmController!.getBoneExtremityWorldPosition(name),
        screen: screenPositions.get(name) ?? null,
      }));

      this.debugOverlay.updateBones(boneData);
    }

    // Step 6: Render
    this.renderer.render(this.scene, this.camera);
  };

  /** 遮擋矩形的簡易 hash（避免 JSON.stringify 的 GC 壓力） */
  private hashOcclusionRects(rects: Rect[]): string {
    if (rects.length === 0) return '0';
    let hash = rects.length;
    for (const r of rects) {
      hash = ((hash << 5) - hash + r.x) | 0;
      hash = ((hash << 5) - hash + r.y) | 0;
      hash = ((hash << 5) - hash + r.width) | 0;
      hash = ((hash << 5) - hash + r.height) | 0;
    }
    return String(hash);
  }

  /** 重置攝影機到預設視角 */
  resetCamera(): void {
    this.orbitTheta = 0;
    this.orbitPhi = Math.PI / 2;
    this.updateCameraFromOrbit();
  }

  /** 是否正在 orbit 旋轉（供 ContextMenu 判斷） */
  isOrbitDragging(): boolean {
    return this.orbitMoved;
  }

  /** 從球座標更新攝影機位置 */
  private updateCameraFromOrbit(): void {
    const t = this.orbitTarget;
    const x = t.x + this.orbitRadius * Math.sin(this.orbitPhi) * Math.sin(this.orbitTheta);
    const y = t.y + this.orbitRadius * Math.cos(this.orbitPhi);
    const z = t.z + this.orbitRadius * Math.sin(this.orbitPhi) * Math.cos(this.orbitTheta);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(t.x, t.y, t.z);
  }

  private onOrbitMouseDown = (e: MouseEvent): void => {
    if (e.button !== 2) return; // 僅右鍵
    this.isOrbiting = true;
    this.orbitMoved = false;
    this.orbitStartX = e.clientX;
    this.orbitStartY = e.clientY;
  };

  private onOrbitMouseMove = (e: MouseEvent): void => {
    if (!this.isOrbiting) return;

    const dx = e.clientX - this.orbitStartX;
    const dy = e.clientY - this.orbitStartY;

    // 超過 5px 判定為拖曳
    if (!this.orbitMoved && Math.abs(dx) + Math.abs(dy) > 5) {
      this.orbitMoved = true;
    }

    if (!this.orbitMoved) return;

    const sensitivity = 0.005;
    this.orbitTheta -= dx * sensitivity;
    this.orbitPhi -= dy * sensitivity;

    // 垂直角限制（避免翻轉）：10° ~ 170°
    const minPhi = Math.PI * (10 / 180);
    const maxPhi = Math.PI * (170 / 180);
    this.orbitPhi = Math.max(minPhi, Math.min(maxPhi, this.orbitPhi));

    this.orbitStartX = e.clientX;
    this.orbitStartY = e.clientY;

    this.updateCameraFromOrbit();
  };

  private onOrbitMouseUp = (e: MouseEvent): void => {
    if (e.button !== 2) return;
    this.isOrbiting = false;
  };

  /** WebGL context lost 處理 */
  private onContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn('[SceneManager] WebGL context lost. Stopping render loop.');
    this.stop();
  };

  /** WebGL context restored 處理 — 重建渲染器 */
  private onContextRestored = (): void => {
    console.warn('[SceneManager] WebGL context restored. Restarting render loop.');
    this.renderer.setSize(
      this.renderer.domElement.width,
      this.renderer.domElement.height,
    );
    this.renderer.setClearColor(0x000000, 0);
    this.start();
  };

  /** 視窗 resize */
  private onResize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  };

  /** 視窗可見性變化 → 切換幀率模式 */
  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.fpsMode = 'background';
    } else {
      this.fpsMode = 'foreground';
    }
  };
}
