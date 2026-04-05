import * as THREE from 'three';
import { VRMController } from './VRMController';
import type { AnimationManager } from '../animation/AnimationManager';
import type { FallbackAnimation } from '../animation/FallbackAnimation';
import type { StateMachine } from '../behavior/StateMachine';
import type { BehaviorAnimationBridge } from '../behavior/BehaviorAnimationBridge';
import type { ExpressionManager } from '../expression/ExpressionManager';
import type { Rect, WindowRect } from '../types/window';
import type { BehaviorOutput, Platform } from '../types/behavior';
import type { DebugOverlay } from '../debug/DebugOverlay';
import type { WindowMeshManager } from '../occlusion/WindowMeshManager';

/** 幀率模式 */
type FpsMode = 'foreground' | 'background' | 'powerSave';

/** 幀率模式對應的目標 fps */
const FPS_MAP: Record<FpsMode, number> = {
  foreground: 30,
  background: 10,
  powerSave: 15,
};

// 3D 深度遮擋：透過 WindowMeshManager 管理視窗 depth-only mesh

/**
 * Three.js 場景的生命週期管理
 *
 * 擁有唯一的 requestAnimationFrame 主迴圈。
 * 每幀依序執行：StateMachine → CollisionSystem → AnimationManager → VRMController → render
 */
export class SceneManager {
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private renderer: THREE.WebGLRenderer;
  private clock: THREE.Clock;

  private vrmController: VRMController | null = null;
  private animationManager: AnimationManager | null = null;
  private fallbackAnimation: FallbackAnimation | null = null;
  private useFallback = false;

  // v0.2 模組
  private stateMachine: StateMachine | null = null;
  private behaviorBridge: BehaviorAnimationBridge | null = null;

  // v0.3 模組
  private expressionManager: ExpressionManager | null = null;
  private lastAppliedExpression: string | null = null;

  // Debug
  private debugOverlay: DebugOverlay | null = null;
  private frameCount = 0;
  private lastFpsTime = 0;
  private currentFps = 0;
  private windowListFetcher: (() => Promise<Array<{ title: string; width: number; height: number; zOrder: number }>>) | null = null;
  private lastWindowListUpdate = 0;
  private static readonly WINDOW_LIST_INTERVAL = 1000;
  /** 步伐分析結果（步伐長度，世界單位，scale=1 基準） */
  private analyzedStepLength = 0;
  /** 基礎移動速度（px/s，scale=1 基準，來自步伐分析） */
  private baseMoveSpeed = 60;

  // 角色位置管理（全螢幕模式：角色在 canvas 內移動，視窗不動）
  private currentPosition = { x: 0, y: 0 };
  private previousPosition = { x: 0, y: 0 };
  /** 角色 bounding box 尺寸（螢幕像素） */
  private characterSize = { width: 300, height: 500 };
  /** 螢幕原點（螢幕絕對座標，用於 screenToWorld，通常 = (0,0)） */
  private screenOrigin = { x: 0, y: 0 };
  /** workArea 原點（螢幕絕對座標，用於平面位置和活動範圍） */
  private workAreaOrigin = { x: 0, y: 0 };
  /** workArea 尺寸（邏輯像素） */
  private workAreaSize = { width: 1920, height: 1040 };
  /** 3D 平面清單（用於角色坐下） */
  private platforms: Platform[] = [];
  /** 工作列平面 3D Mesh（debug 可見） */
  private taskbarPlatformMesh: THREE.Mesh | null = null;
  /** 地面觸發平面 3D Mesh（debug 可見，canvas 最底部） */
  private groundPlatformMesh: THREE.Mesh | null = null;
  /** 像素到世界座標的轉換比例（正交攝影機下為固定常數） */
  private static readonly PIXEL_TO_WORLD = 0.003126;
  private pixelToWorld = SceneManager.PIXEL_TO_WORLD;
  // BASE_CAMERA_Y removed: camera Y is now computed from visibleHeight
  // 3D 深度遮擋系統
  private windowMeshManager: WindowMeshManager | null = null;
  private cachedWindowRects: WindowRect[] = [];
  /** 當前角色 Z 值（用於 debug 顯示） */
  private currentCharacterZ = 9.5;
  /** 最近一次 StateMachine 輸出（供 resolveCharacterZ 使用） */
  private lastBehaviorOutput: BehaviorOutput | null = null;

  private targetFps: number;
  private fpsMode: FpsMode = 'foreground';
  private lastFrameTime = 0;
  private animationFrameId = 0;
  private running = false;

  private scale = 1.0;

  // Debug 鍵盤移動（透過 IPC global shortcut）
  private debugMoveDir: string | null = null;

  // Orbit camera（右鍵拖曳旋轉）
  private orbitTheta = 0; // 水平角（弧度）
  private orbitPhi = Math.PI / 2; // 垂直角（弧度），π/2 = 正面
  private orbitRadius = 3.5;
  // orbitTarget removed: orbit center now follows model position
  private isOrbiting = false;
  private orbitStartX = 0;
  private orbitStartY = 0;
  private orbitMoved = false;

  // (移動方向追蹤已改為模型旋轉，見 updateModelFacingDirection)

  constructor(canvas: HTMLCanvasElement, targetFps = 30) {
    this.targetFps = targetFps;

    // Scene
    this.scene = new THREE.Scene();

    // Camera — 正交攝影機，無透視變形
    const ch = canvas.clientHeight || canvas.height;
    const cw = canvas.clientWidth || canvas.width;
    const halfH = (ch * SceneManager.PIXEL_TO_WORLD) / 2;
    const halfW = (cw * SceneManager.PIXEL_TO_WORLD) / 2;
    this.camera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 100);
    this.setupCameraForCanvas(ch);

    // Renderer — 透明背景
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
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

  /** 取得 WebGLRenderer（供 HitTestManager 讀取像素用） */
  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
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

  /** 設定 Debug Overlay */
  setDebugOverlay(overlay: DebugOverlay): void {
    this.debugOverlay = overlay;
    // 同步平面 mesh 可見性
    this.updatePlatformMeshVisibility();
  }

  /** 切換 debug 平面 mesh 可見性 */
  updatePlatformMeshVisibility(): void {
    const visible = this.debugOverlay?.isEnabled() ?? false;
    if (this.taskbarPlatformMesh) {
      this.taskbarPlatformMesh.visible = visible;
    }
    if (this.groundPlatformMesh) {
      this.groundPlatformMesh.visible = visible;
    }
  }

  /** 設定 WindowMeshManager（3D 深度遮擋） */
  setWindowMeshManager(manager: WindowMeshManager): void {
    this.windowMeshManager = manager;
  }

  /** 更新快取的視窗清單（由 IPC 事件觸發） */
  updateCachedWindowRects(rects: WindowRect[]): void {
    this.cachedWindowRects = rects;
  }

  /** 設定視窗清單取得函式（供 debug overlay 使用） */
  setWindowListFetcher(fetcher: () => Promise<Array<{ title: string; width: number; height: number; zOrder: number }>>): void {
    this.windowListFetcher = fetcher;
  }

  /** 設定步伐分析結果（供 debug overlay 顯示） */
  setStepAnalysis(stepLength: number, baseMoveSpeed: number): void {
    this.analyzedStepLength = stepLength;
    this.baseMoveSpeed = baseMoveSpeed;
  }

  /** 設定 BehaviorAnimationBridge (v0.2) */
  setBehaviorAnimationBridge(bridge: BehaviorAnimationBridge): void {
    this.behaviorBridge = bridge;
  }

  /** 設定 ExpressionManager (v0.3) */
  setExpressionManager(em: ExpressionManager): void {
    this.expressionManager = em;
  }

  /** 設定 workArea 資訊（螢幕絕對座標，邏輯像素）— 用於平面位置和角色活動範圍 */
  setWorkArea(x: number, y: number, width: number, height: number): void {
    this.workAreaOrigin = { x, y };
    this.workAreaSize = { width, height };
    this.createTaskbarPlatform();
  }

  /** 設定螢幕原點（用於 screenToWorld 座標轉換） */
  setScreenOrigin(x: number, y: number): void {
    this.screenOrigin = { x, y };
  }

  /** 更新當前角色位置（螢幕座標） */
  setCurrentPosition(pos: { x: number; y: number }): void {
    this.previousPosition = { ...this.currentPosition };
    this.currentPosition = pos;
  }

  /** 設定角色 bounding box 尺寸（螢幕像素） */
  setCharacterSize(size: { width: number; height: number }): void {
    this.characterSize = size;
  }

  /** Debug: 觸發方向移動（由 global shortcut 呼叫） */
  debugMove(direction: string): void {
    this.debugMoveDir = direction;
  }

  /** 取得角色的螢幕 bounding box */
  getCharacterBounds(): Rect {
    return {
      x: this.currentPosition.x,
      y: this.currentPosition.y,
      width: this.characterSize.width,
      height: this.characterSize.height,
    };
  }

  /** 角色在 viewport 中佔的比例（高度） */
  private charViewportRatioH = 0.5;
  /** 角色寬高比（3D 模型） */
  private charAspectRatio = 0.4;
  // screenLogicalHeight removed: fullscreen mode uses canvas dimensions directly

  /** 計算角色在 viewport 中的比例和寬高比（模型載入後呼叫一次） */
  computeCharacterViewportRatio(): void {
    if (!this.vrmController) return;
    const vrm = this.vrmController.getVRM();
    if (!vrm) return;

    const box = new THREE.Box3().setFromObject(vrm.scene);
    const modelHeight = box.max.y - box.min.y;
    const modelWidth = box.max.x - box.min.x;

    const visibleHeight = this.camera.top - this.camera.bottom;

    this.charViewportRatioH = modelHeight / visibleHeight;
    this.charAspectRatio = modelWidth / modelHeight;
    console.log(`[SceneManager] modelH=${modelHeight.toFixed(2)} modelW=${modelWidth.toFixed(2)} aspect=${this.charAspectRatio.toFixed(3)} vpRatio=${this.charViewportRatioH.toFixed(3)}`);
  }

  // setScreenHeight / HEIGHT_PADDING removed: fullscreen mode handles sizing differently

  /** 設定角色縮放（0.5–2.0） */
  setScale(scale: number): void {
    this.scale = Math.max(0.5, Math.min(2.0, scale));

    // 全螢幕模式：只調整模型 scale，不改視窗大小
    if (this.vrmController) {
      this.vrmController.setModelScale(this.scale);
    }

    // 更新 characterSize（基於模型世界尺寸和 pixelToWorld）
    this.updateCharacterSize();
  }

  /** 取得角色縮放 */
  getScale(): number {
    return this.scale;
  }

  /** 取得像素到世界座標的轉換比例 */
  getPixelToWorld(): number {
    return this.pixelToWorld;
  }

  /** 取得螢幕原點 */
  getScreenOrigin(): { x: number; y: number } {
    return { ...this.screenOrigin };
  }

  /** 取得當前角色 Z 值（debug 用） */
  getCharacterZ(): number {
    return this.currentCharacterZ;
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
    this.windowMeshManager?.dispose();
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

    // Debug 移動（Ctrl+方向鍵 global shortcut，debug mode 時有效）
    if (this.debugMoveDir) {
      const step = 30;
      switch (this.debugMoveDir) {
        case 'left': this.currentPosition.x -= step; break;
        case 'right': this.currentPosition.x += step; break;
        case 'up': this.currentPosition.y -= step; break;
        case 'down': this.currentPosition.y += step; break;
      }
      this.debugMoveDir = null;
    }

    // Step 1: StateMachine（碰撞/穿越已移除，僅保留基本狀態機）
    if (this.stateMachine && !this.stateMachine.isPaused()) {
      const characterBounds = this.getCharacterBounds();
      const canvas = this.renderer.domElement;

      // 計算膝蓋螢幕 Y（取兩腳較低者 = 較大的螢幕 Y）
      let kneeScreenY: number | undefined;
      if (this.vrmController) {
        const leftKnee = this.vrmController.getBoneWorldPosition('leftLowerLeg');
        const rightKnee = this.vrmController.getBoneWorldPosition('rightLowerLeg');
        if (leftKnee || rightKnee) {
          const candidates: number[] = [];
          if (leftKnee) candidates.push(this.worldToScreen(leftKnee.x, leftKnee.y).y);
          if (rightKnee) candidates.push(this.worldToScreen(rightKnee.x, rightKnee.y).y);
          kneeScreenY = Math.max(...candidates); // 螢幕 Y 越大 = 位置越低
        }
      }

      // StateMachine 更新
      const output = this.stateMachine.tick({
        currentPosition: this.currentPosition,
        characterBounds,
        screenBounds: {
          x: this.workAreaOrigin.x,
          y: this.workAreaOrigin.y,
          width: canvas.clientWidth || canvas.width,
          height: canvas.clientHeight || canvas.height,
        },
        windowRects: this.cachedWindowRects,
        platforms: this.platforms,
        scale: this.scale,
        deltaTime,
        kneeScreenY,
      });

      this.lastBehaviorOutput = output;

      // 套用目標位置（簡單螢幕邊界 clamp）
      if (output.targetPosition) {
        this.currentPosition = this.clampToScreen(output.targetPosition);
      }

      // BehaviorAnimationBridge 更新
      if (this.behaviorBridge) {
        this.behaviorBridge.update(output);
      }
    }

    // 移動方向追蹤 → 模型 Y 軸旋轉
    const moveDx = this.currentPosition.x - this.previousPosition.x;
    const moveDy = this.currentPosition.y - this.previousPosition.y;
    this.updateModelFacingDirection(moveDx, moveDy);

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

    // Step 5: VRM update (SpringBone etc.) + 模型世界座標定位
    if (this.vrmController) {
      // 將角色螢幕座標轉換為 3D 世界座標並定位模型
      this.updateModelWorldPosition();

      this.vrmController.update(deltaTime);

      this.previousPosition.x = this.currentPosition.x;
      this.previousPosition.y = this.currentPosition.y;
    }

    // Debug overlay 更新
    if (this.debugOverlay?.isEnabled()) {
      this.frameCount++;
      if (now - this.lastFpsTime >= 1000) {
        this.currentFps = this.frameCount * 1000 / (now - this.lastFpsTime);
        this.frameCount = 0;
        this.lastFpsTime = now;
      }
      this.debugOverlay.update({
        state: this.stateMachine?.getState() ?? 'N/A',
        posX: this.currentPosition.x,
        posY: this.currentPosition.y,
        scale: this.scale,
        fps: this.currentFps,
        baseMoveSpeed: this.baseMoveSpeed,
        moveSpeedMultiplier: this.stateMachine?.getSpeedMultiplier() ?? 1.0,
        paused: this.stateMachine?.isPaused() ?? false,
        stepLength: this.analyzedStepLength,
        currentAnimation: this.animationManager?.getCurrentAnimationName() ?? undefined,
        characterZ: this.currentCharacterZ,
        occlusionMeshes: this.windowMeshManager?.getDebugInfo(),
      });

      // 視窗清單（每秒更新一次）
      if (this.windowListFetcher && now - this.lastWindowListUpdate > SceneManager.WINDOW_LIST_INTERVAL) {
        this.lastWindowListUpdate = now;
        this.windowListFetcher().then((windows) => {
          const dpr = window.devicePixelRatio || 1;
          this.debugOverlay?.updateWindowList(windows.map(w => ({
            title: w.title,
            zOrder: w.zOrder,
            width: Math.round(w.width / dpr),
            height: Math.round(w.height / dpr),
          })));
        }).catch(() => { /* 忽略錯誤 */ });
      }

      // Mesh 清單
      const meshList: Array<{ name: string; x: number; y: number; z: number; visible: boolean }> = [];
      this.scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh && obj.name.startsWith('platform:')) {
          meshList.push({
            name: obj.name,
            x: obj.position.x,
            y: obj.position.y,
            z: obj.position.z,
            visible: obj.visible,
          });
        }
      });
      this.debugOverlay.updateMeshList(meshList);
    }

    // Step 6: Render
    this.renderer.render(this.scene, this.camera);
  };

  /** 重置攝影機到預設視角 */
  resetCamera(): void {
    this.orbitTheta = 0;
    this.orbitPhi = Math.PI / 2;
    // 恢復到全螢幕基礎攝影機位置
    const canvas = this.renderer.domElement;
    this.setupCameraForCanvas(canvas.clientHeight || canvas.height);
  }

  /** 是否正在 orbit 旋轉（供 ContextMenu 判斷） */
  isOrbitDragging(): boolean {
    return this.orbitMoved;
  }

  /** 從球座標更新攝影機位置（軌道中心跟隨模型） */
  private updateCameraFromOrbit(): void {
    // 軌道中心 = 模型目前的世界座標（胸部高度）
    const modelWorld = this.screenToWorld(
      this.currentPosition.x + this.characterSize.width / 2,
      this.currentPosition.y + this.characterSize.height / 2,
    );
    const t = { x: modelWorld.x, y: modelWorld.y, z: 0 };

    const x = t.x + this.orbitRadius * Math.sin(this.orbitPhi) * Math.sin(this.orbitTheta);
    const y = t.y + this.orbitRadius * Math.cos(this.orbitPhi);
    const z = t.z + this.orbitRadius * Math.sin(this.orbitPhi) * Math.cos(this.orbitTheta);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(t.x, t.y, t.z);
  }

  /** 模型當前面朝角度 */
  private modelFacingTheta = 0;
  /** 模型目標面朝角度 */
  private modelTargetTheta: number | null = null;
  /** 是否正在追蹤移動方向 */
  private modelFacingActive = false;

  /**
   * 根據移動方向旋轉模型 Y 軸（取代舊的攝影機方向追蹤）
   *
   * 全螢幕模式下攝影機固定，改為旋轉模型本身。
   */
  private updateModelFacingDirection(dx: number, dy: number): void {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      if (this.modelFacingActive) {
        this.modelTargetTheta = 0;
        this.modelFacingActive = false;
      }
    } else {
      this.modelFacingActive = true;
      // 模型直接旋轉：左右=atan2(dx)，上=背面(π)，下=正面(0)
      this.modelTargetTheta = Math.atan2(dx, dy);
    }

    // 平滑插值
    if (this.modelTargetTheta !== null) {
      let diff = this.modelTargetTheta - this.modelFacingTheta;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;

      if (Math.abs(diff) < 0.001) {
        this.modelFacingTheta = this.modelTargetTheta;
        if (!this.modelFacingActive) {
          this.modelTargetTheta = null;
        }
      } else {
        this.modelFacingTheta += diff * 0.08;
      }

      this.vrmController?.setFacingRotationY(this.modelFacingTheta);
    }
  }

  /** 取得當前攝影機角度（供 Debug overlay 使用） */
  getCameraAngles(): { theta: number; phi: number; targetTheta: number | null } {
    return {
      theta: this.orbitTheta,
      phi: this.orbitPhi,
      targetTheta: this.modelTargetTheta,
    };
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

    // 全螢幕模式：軌道結束後恢復固定攝影機
    if (this.orbitMoved) {
      this.orbitTheta = 0;
      this.orbitPhi = Math.PI / 2;
      const canvas = this.renderer.domElement;
      this.setupCameraForCanvas(canvas.clientHeight || canvas.height);
    }
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
    this.renderer.setSize(width, height);
    this.setupCameraForCanvas(height);
    this.updateCharacterSize();
  };

  /** 視窗可見性變化 → 切換幀率模式 */
  private onVisibilityChange = (): void => {
    if (document.hidden) {
      this.fpsMode = 'background';
    } else {
      this.fpsMode = 'foreground';
    }
  };

  // ── 全螢幕座標系統 ──

  /**
   * 設定正交攝影機覆蓋全螢幕
   *
   * 使用固定 pixelToWorld 比例，模型在任何解析度下的螢幕像素大小一致。
   * 正交投影無近大遠小效果，坐下動畫不會造成角色視覺放大。
   */
  private setupCameraForCanvas(canvasHeight: number): void {
    const canvasWidth = window.innerWidth;
    const visibleHeight = canvasHeight * this.pixelToWorld;
    const visibleWidth = canvasWidth * this.pixelToWorld;
    const centerY = visibleHeight / 2;

    this.camera.left = -visibleWidth / 2;
    this.camera.right = visibleWidth / 2;
    this.camera.top = visibleHeight / 2;
    this.camera.bottom = -visibleHeight / 2;
    this.camera.updateProjectionMatrix();

    this.camera.position.set(0, centerY, 10);
    this.camera.lookAt(0, centerY, 0);

    this.orbitRadius = 10;
  }

  /**
   * 3D 世界座標 → 螢幕座標
   *
   * 輸入：Three.js 世界座標（z=0 平面）
   * 輸出：螢幕絕對座標（邏輯像素）
   */
  private worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    const canvas = this.renderer.domElement;
    const canvasW = canvas.clientWidth || canvas.width;
    const canvasH = canvas.clientHeight || canvas.height;

    return {
      x: worldX / this.pixelToWorld + canvasW / 2 + this.screenOrigin.x,
      y: canvasH - worldY / this.pixelToWorld + this.screenOrigin.y,
    };
  }

  /**
   * 螢幕座標 → 3D 世界座標
   *
   * 輸入：螢幕絕對座標（邏輯像素）
   * 輸出：Three.js 世界座標（模型深度 z=0 平面上）
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const canvas = this.renderer.domElement;
    const canvasX = screenX - this.screenOrigin.x;
    const canvasY = screenY - this.screenOrigin.y;
    const canvasW = canvas.clientWidth || canvas.width;
    const canvasH = canvas.clientHeight || canvas.height;

    return {
      x: (canvasX - canvasW / 2) * this.pixelToWorld,
      y: (canvasH - canvasY) * this.pixelToWorld,
    };
  }

  /** 更新模型在 3D 世界中的位置（基於 currentPosition） */
  private updateModelWorldPosition(): void {
    if (!this.vrmController) return;

    // currentPosition 是 bounding box 左上角的螢幕座標
    // 模型原點在腳底 → 用 bounding box 的中下位置
    const centerX = this.currentPosition.x + this.characterSize.width / 2;
    const bottomY = this.currentPosition.y + this.characterSize.height;
    const world = this.screenToWorld(centerX, bottomY);

    // sit 狀態：讓臀部（hips 骨骼）對齊平面，而非腳底
    if (this.stateMachine?.getState() === 'sit') {
      const hipOffset = this.vrmController.getHipOffsetY();
      if (hipOffset !== null) {
        world.y -= hipOffset;
      }
    }

    // 根據行為狀態決定角色 Z 深度
    this.currentCharacterZ = this.resolveCharacterZ(this.lastBehaviorOutput);
    this.vrmController.setWorldPosition(world.x, world.y, this.currentCharacterZ);
  }

  /**
   * 根據行為狀態計算角色 Z 深度
   *
   * peek → 目標視窗 Z - 0.25（在視窗後面）
   * sit → 吸附視窗 Z + 0.25（在視窗前面，但可被更上層視窗遮擋）
   * drag → 9.5（最上方，確保拖曳時角色不被遮擋）
   * walk/idle/fall → 前景視窗 Z - 0.25（自動退到使用者正在操作的視窗後面）
   *                  無前景視窗時 → 9.5（最前面）
   */
  private resolveCharacterZ(output: BehaviorOutput | null): number {
    const DEFAULT_Z = 9.5;
    if (!output || !this.windowMeshManager) return DEFAULT_Z;

    if (output.currentState === 'drag') return DEFAULT_Z;

    if (output.currentState === 'peek' && output.peekTargetHwnd !== null) {
      const windowZ = this.windowMeshManager.getWindowZ(output.peekTargetHwnd);
      return windowZ !== null ? windowZ - 0.25 : DEFAULT_Z;
    }
    if (output.currentState === 'sit' && output.attachedWindowHwnd !== null) {
      const windowZ = this.windowMeshManager.getWindowZ(output.attachedWindowHwnd);
      return windowZ !== null ? windowZ + 0.25 : DEFAULT_Z;
    }

    // 自動退到前景視窗後面：使用者點擊視窗時角色不遮擋
    const foreground = this.cachedWindowRects.find((w) => w.isForeground);
    if (foreground) {
      const fgZ = this.windowMeshManager.getWindowZ(foreground.hwnd);
      if (fgZ !== null) return fgZ - 0.25;
    }
    return DEFAULT_Z;
  }

  /** 簡單螢幕邊界 clamp（基於 workArea 範圍，允許超出到螢幕邊緣） */
  private clampToScreen(pos: { x: number; y: number }): { x: number; y: number } {
    const canvas = this.renderer.domElement;
    const screenH = canvas.clientHeight || canvas.height;
    const charW = this.characterSize.width;
    const charH = this.characterSize.height;

    // X 活動範圍：workArea 內（保留 20% 可見）
    const minX = this.workAreaOrigin.x - charW * 0.8;
    const maxX = this.workAreaOrigin.x + this.workAreaSize.width - charW * 0.2;
    // Y 活動範圍：上限 = workArea 頂部，下限 = 保留上半身可見（下半身可超出 canvas）
    const minY = this.workAreaOrigin.y - charH * 0.8;
    const maxY = this.screenOrigin.y + screenH - charH * 0.5;

    return {
      x: Math.max(minX, Math.min(maxX, pos.x)),
      y: Math.max(minY, Math.min(maxY, pos.y)),
    };
  }

  /** 更新角色 bounding box 尺寸（基於模型世界尺寸） */
  private updateCharacterSize(): void {
    if (!this.vrmController) return;
    const modelSize = this.vrmController.getModelWorldSize();
    if (!modelSize) return;

    // getModelWorldSize() 已包含 model scale，不需再乘 this.scale
    const charH = modelSize.height / this.pixelToWorld;
    const charW = modelSize.width / this.pixelToWorld;

    // 加邊距容納頭髮、配飾、手臂
    this.characterSize = {
      width: Math.round(charW * 2.5),
      height: Math.round(charH * 1.3),
    };
  }

  /**
   * 建立平面系統（ground 觸發 + taskbar 坐下目標）
   *
   * - ground：canvas 最底部，角色腳底碰到即觸發 sit
   * - taskbar：workArea 下緣（= 工作列上緣），sit 後角色定位於此
   * Debug mode 可見，一般模式隱藏。
   */
  private createTaskbarPlatform(): void {
    // 移除舊的 mesh
    if (this.taskbarPlatformMesh) {
      this.scene.remove(this.taskbarPlatformMesh);
      this.taskbarPlatformMesh.geometry.dispose();
      (this.taskbarPlatformMesh.material as THREE.Material).dispose();
      this.taskbarPlatformMesh = null;
    }
    if (this.groundPlatformMesh) {
      this.scene.remove(this.groundPlatformMesh);
      this.groundPlatformMesh.geometry.dispose();
      (this.groundPlatformMesh.material as THREE.Material).dispose();
      this.groundPlatformMesh = null;
    }

    const canvas = this.renderer.domElement;
    const canvasH = canvas.clientHeight || canvas.height;

    // 螢幕座標
    const taskbarScreenY = this.workAreaOrigin.y + this.workAreaSize.height;
    const groundScreenY = this.screenOrigin.y + canvasH; // canvas 最底部
    const xMin = this.workAreaOrigin.x;
    const xMax = this.workAreaOrigin.x + this.workAreaSize.width;

    // 邏輯 Platform：ground 為觸發平面，sitTargetY 指向 taskbar 位置
    this.platforms = [{
      id: 'ground',
      screenY: taskbarScreenY,
      screenXMin: xMin,
      screenXMax: xMax,
      sitTargetY: taskbarScreenY,
    }];

    const debugVisible = this.debugOverlay?.isEnabled() ?? false;
    const meshThickness = 4 * this.pixelToWorld;

    // Taskbar mesh（綠色，坐下目標位置）
    const tbLeft = this.screenToWorld(xMin, taskbarScreenY);
    const tbRight = this.screenToWorld(xMax, taskbarScreenY);
    const tbWidth = tbRight.x - tbLeft.x;
    const tbCenterX = (tbLeft.x + tbRight.x) / 2;

    const tbGeo = new THREE.BoxGeometry(tbWidth, meshThickness, 0.02);
    const tbMat = new THREE.MeshBasicMaterial({
      color: 0x00ff88, transparent: true, opacity: 0.3, depthTest: false,
    });
    this.taskbarPlatformMesh = new THREE.Mesh(tbGeo, tbMat);
    this.taskbarPlatformMesh.name = 'platform:taskbar';
    this.taskbarPlatformMesh.position.set(tbCenterX, tbLeft.y, 0);
    this.taskbarPlatformMesh.visible = debugVisible;
    this.scene.add(this.taskbarPlatformMesh);

    // Ground mesh（黃色，觸發平面 = canvas 最底部）
    const grLeft = this.screenToWorld(xMin, groundScreenY);
    const grRight = this.screenToWorld(xMax, groundScreenY);
    const grWidth = grRight.x - grLeft.x;
    const grCenterX = (grLeft.x + grRight.x) / 2;

    const grGeo = new THREE.BoxGeometry(grWidth, meshThickness, 0.02);
    const grMat = new THREE.MeshBasicMaterial({
      color: 0xffcc00, transparent: true, opacity: 0.3, depthTest: false,
    });
    this.groundPlatformMesh = new THREE.Mesh(grGeo, grMat);
    this.groundPlatformMesh.name = 'platform:ground';
    this.groundPlatformMesh.position.set(grCenterX, grLeft.y, 0);
    this.groundPlatformMesh.visible = debugVisible;
    this.scene.add(this.groundPlatformMesh);
  }
}
