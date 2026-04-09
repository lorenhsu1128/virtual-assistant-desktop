import * as THREE from 'three';
import { VRMController } from './VRMController';
import type { AnimationManager } from '../animation/AnimationManager';
import type { FallbackAnimation } from '../animation/FallbackAnimation';
import type { StateMachine } from '../behavior/StateMachine';
import type { BehaviorAnimationBridge } from '../behavior/BehaviorAnimationBridge';
import type { ExpressionManager } from '../expression/ExpressionManager';
import type { Rect, WindowRect, DisplayInfo } from '../types/window';
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
  // lastAppliedExpression removed: ExpressionManager 現在自己追蹤 current/previous 過渡狀態

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
  /** 行走動畫的世界移動速度（世界單位/秒，scale=1 基準，來自步伐分析） */
  private walkWorldSpeed = 0;
  /** 基礎移動速度（px/s，已乘 baseScale，供 debug 顯示） */
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
  /** 多螢幕：當前所在的 display index */
  private currentDisplayIndex = 0;
  /** 3D 平面清單（用於角色坐下） */
  private platforms: Platform[] = [];
  /** 工作列平面 3D Mesh（debug 可見） */
  private taskbarPlatformMesh: THREE.Mesh | null = null;
  /** 地面觸發平面 3D Mesh（debug 可見，canvas 最底部） */
  private groundPlatformMesh: THREE.Mesh | null = null;
  /** 視窗頂部 platform debug mesh（hwnd → Mesh） */
  private windowPlatformMeshes = new Map<string, THREE.Mesh>();
  /** 視窗 platform 共用 geometry */
  private windowPlatformGeo: THREE.PlaneGeometry | null = null;
  /** 視窗 platform 共用 material */
  private windowPlatformMat: THREE.MeshBasicMaterial | null = null;
  /** 視窗/螢幕邊緣柱狀 mesh（key = `{hwnd}:left`/`{hwnd}:right`/`screen:left`/`screen:right`） */
  private edgePillarMeshes = new Map<string, THREE.Mesh>();
  /** 邊緣柱共用 geometry */
  private edgePillarGeo: THREE.PlaneGeometry | null = null;
  /** 邊緣柱共用 material（橙色） */
  private edgePillarMat: THREE.MeshBasicMaterial | null = null;
  /** peek 骨骼錨定 X 偏移量（lerp 平滑用） */
  private peekAnchorOffsetX = 0;
  /** 像素到世界座標的轉換比例（正交攝影機下為固定常數） */
  private static readonly PIXEL_TO_WORLD = 0.003126;
  private pixelToWorld = SceneManager.PIXEL_TO_WORLD;
  /** 角色在 100% 縮放時佔螢幕高度的比例 */
  private static readonly TARGET_VIEWPORT_RATIO = 0.4;
  /** 模型正規化基準縮放（使任何模型在 scale=1.0 時佔螢幕 40%） */
  private baseScale = 1.0;
  // BASE_CAMERA_Y removed: camera Y is now computed from visibleHeight
  // 3D 深度遮擋系統
  private windowMeshManager: WindowMeshManager | null = null;
  private cachedWindowRects: WindowRect[] = [];
  /** 當前角色 Z 值（用於 debug 顯示） */
  private currentCharacterZ = 8.5;
  /** 最近一次 StateMachine 輸出（供 resolveCharacterZ 使用） */
  private lastBehaviorOutput: BehaviorOutput | null = null;
  /** 拖曳後維持最上方，直到前景視窗改變時清除 */
  private forceTopAfterDrag = false;
  private lastForegroundHwnd: number | null = null;
  /** 每幀快取的模型尺寸（避免重複呼叫 getModelWorldSize） */
  private cachedModelSize: { width: number; height: number } | null = null;
  /** 每幀快取的遮擋/螢幕外比率（避免重複計算） */
  private cachedOcclusionRatio = 0;
  private cachedOffScreenRatio = 0;
  private ratiosCachedThisFrame = false;

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
      premultipliedAlpha: true,
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
    // 若步伐分析已完成，立即推入當前 baseScale 對應的 moveSpeed
    this.applyMoveSpeedToStateMachine();
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
    for (const mesh of this.windowPlatformMeshes.values()) {
      mesh.visible = visible;
    }
    for (const mesh of this.edgePillarMeshes.values()) {
      mesh.visible = visible;
    }
  }

  /**
   * 取得邊緣柱的世界 X 座標（供骨骼錨定用）
   *
   * key 格式：`{hwnd}:{side}` 或 `screen:{side}`
   * 會搜尋所有以該 key 為前綴的柱子（因為每個邊緣可能有多個露出區段），
   * 回傳第一個匹配的柱子 world X（所有區段的 X 座標相同）。
   */
  getEdgePillarWorldX(key: string): number | null {
    // 精確匹配（螢幕邊緣 key 沒有區段 index）
    const exact = this.edgePillarMeshes.get(key);
    if (exact) return exact.position.x;
    // 前綴匹配（視窗邊緣 key 帶區段 index）
    for (const [k, mesh] of this.edgePillarMeshes) {
      if (k.startsWith(key + ':')) return mesh.position.x;
    }
    return null;
  }

  /** 設定 WindowMeshManager（3D 深度遮擋） */
  setWindowMeshManager(manager: WindowMeshManager): void {
    this.windowMeshManager = manager;
  }

  /** 更新快取的視窗清單（由 IPC 事件觸發） */
  updateCachedWindowRects(rects: WindowRect[]): void {
    this.cachedWindowRects = rects;
    this.rebuildWindowPlatforms();
  }

  /** 設定視窗清單取得函式（供 debug overlay 使用） */
  setWindowListFetcher(fetcher: () => Promise<Array<{ title: string; width: number; height: number; zOrder: number }>>): void {
    this.windowListFetcher = fetcher;
  }

  /** 取得當前可站立平面清單（供拖曳吸附判定） */
  getPlatforms(): Platform[] {
    return this.platforms;
  }

  /**
   * 取得臀部的螢幕 Y 座標
   *
   * 供拖曳吸附判定使用。回傳 hips 骨骼的螢幕 Y，
   * 若無法取得則用 bounding box 估算。
   */
  getHipScreenY(): number {
    if (this.vrmController) {
      const hips = this.vrmController.getBoneWorldPosition('hips');
      if (hips) {
        return this.worldToScreen(hips.x, hips.y).y;
      }
    }
    // fallback：bounding box 中間偏下
    return this.currentPosition.y + this.characterSize.height * 0.6;
  }

  /**
   * 設定步伐分析結果
   *
   * @param stepLength 步伐長度（世界單位，scale=1 基準）
   * @param worldSpeed 行走動畫的世界移動速度（世界單位/秒，scale=1 基準）
   */
  setStepAnalysis(stepLength: number, worldSpeed: number): void {
    this.analyzedStepLength = stepLength;
    this.walkWorldSpeed = worldSpeed;
    this.applyMoveSpeedToStateMachine();
  }

  /**
   * 依當前 baseScale 與 pixelToWorld 重新計算 px/sec 並推入 StateMachine
   *
   * 呼叫時機：setStepAnalysis、computeCharacterViewportRatio、setStateMachine、
   * setDisplays（切換螢幕導致 baseScale 變化時）。
   */
  private applyMoveSpeedToStateMachine(): void {
    if (this.walkWorldSpeed <= 0) return;
    // 腳底視覺移動速度 = worldSpeed × baseScale × userScale
    // userScale 由 StateMachine 透過 input.scale 套用，這裡只乘 baseScale
    this.baseMoveSpeed = (this.walkWorldSpeed * this.baseScale) / this.pixelToWorld;
    if (this.stateMachine) {
      this.stateMachine.setMoveSpeed(this.baseMoveSpeed);
    }
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

  /**
   * 設定多螢幕清單與當前所在 display
   *
   * 單螢幕時 displays 長度為 1。切換螢幕時完整重建所有視窗幾何：
   * 1. 同步更新 renderer size + camera（讓 canvas.clientWidth/Height 立即生效）
   * 2. 更新 screenOrigin + workArea（觸發 createTaskbarPlatform）
   * 3. 更新 WindowMeshManager 的上下文並重定位所有既有遮擋 mesh
   * 4. 重建 window platform + edge pillar
   *
   * 這樣不必等 window.resize 事件就能正確呈現所有 mesh 位置。
   */
  setDisplays(displays: DisplayInfo[], initialIndex: number): void {
    this.currentDisplayIndex = Math.max(0, Math.min(initialIndex, displays.length - 1));
    const d = displays[this.currentDisplayIndex];
    if (!d) return;

    // 先同步 canvas 尺寸與 camera，讓後續的 screenToWorld / createTaskbarPlatform
    // 讀到正確的 canvas.clientWidth / clientHeight（Three.js setSize 預設會更新
    // canvas 的 CSS style，immediate 生效）
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(d.width, d.height);
    this.setupCameraForCanvas(d.height);

    // Camera 已更新，重算 baseScale 讓角色維持新螢幕的 40% 高度
    // （內部會 apply moveSpeed 給 StateMachine）
    if (this.vrmController?.getVRM()) {
      this.computeCharacterViewportRatio();
      // baseScale 變了，重新套用當前 userScale
      this.setScale(this.scale);
    }

    this.updateCharacterSize();

    // 套用新的座標原點與 workArea（setWorkArea 會重建 taskbar/ground platform）
    const wa = d.workArea ?? d;
    this.setScreenOrigin(d.x, d.y);
    this.setWorkArea(wa.x, wa.y, wa.width, wa.height);

    // 更新遮擋 mesh 管理器的上下文並重定位所有 mesh
    if (this.windowMeshManager) {
      this.windowMeshManager.updateContext({ x: d.x, y: d.y }, d.width, d.height);
    }

    // 重建視窗頂部 platform 與左右邊緣柱子
    this.rebuildWindowPlatforms();
  }

  /** 當前所在的 display index */
  getCurrentDisplayIndex(): number {
    return this.currentDisplayIndex;
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

  /** 角色寬高比（3D 模型） */
  private charAspectRatio = 0.4;
  // screenLogicalHeight removed: fullscreen mode uses canvas dimensions directly

  /**
   * 計算 baseScale 使模型在 scale=1.0 時佔螢幕高度 TARGET_VIEWPORT_RATIO (35%)。
   * 模型載入後呼叫一次，必須在 setScale() 之前。
   */
  computeCharacterViewportRatio(): void {
    if (!this.vrmController) return;
    const vrm = this.vrmController.getVRM();
    if (!vrm) return;

    // 先重置為 1.0 以取得模型原始尺寸
    this.vrmController.setModelScale(1.0);
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const nativeHeight = box.max.y - box.min.y;
    const nativeWidth = box.max.x - box.min.x;

    const visibleHeight = this.camera.top - this.camera.bottom;

    // 計算 baseScale：讓模型正好佔可見高度的 35%
    this.baseScale = (SceneManager.TARGET_VIEWPORT_RATIO * visibleHeight) / nativeHeight;

    // 套用 baseScale * 當前 userScale（安全處理重複呼叫的情況）
    this.vrmController.setModelScale(this.baseScale * this.scale);

    this.charAspectRatio = nativeWidth / nativeHeight;
    console.log(`[SceneManager] nativeH=${nativeHeight.toFixed(2)} baseScale=${this.baseScale.toFixed(3)} targetRatio=${SceneManager.TARGET_VIEWPORT_RATIO} aspect=${this.charAspectRatio.toFixed(3)}`);

    // baseScale 改變 → 重算移動速度（保持腳步視覺一致）
    this.applyMoveSpeedToStateMachine();
  }

  // setScreenHeight / HEIGHT_PADDING removed: fullscreen mode handles sizing differently

  /** 設定角色縮放（0.5–2.0），實際套用 baseScale * userScale */
  setScale(scale: number): void {
    this.scale = Math.max(0.5, Math.min(2.0, scale));

    // 全螢幕模式：只調整模型 scale，不改視窗大小
    if (this.vrmController) {
      this.vrmController.setModelScale(this.baseScale * this.scale);
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
    // 釋放共用 geometry/material
    this.windowPlatformGeo?.dispose();
    this.windowPlatformMat?.dispose();
    this.edgePillarGeo?.dispose();
    this.edgePillarMat?.dispose();
    // 遍歷場景釋放所有 mesh 資源
    this.scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else if (mesh.material) {
          mesh.material.dispose();
        }
      }
    });
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

    // 每幀快取模型尺寸（避免重複呼叫 getModelWorldSize 4 次）
    this.cachedModelSize = this.vrmController?.getModelWorldSize() ?? null;
    this.ratiosCachedThisFrame = false;

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
    // 注意：paused 語意交由 StateMachine 自己處理——仍需呼叫 tick() 讓
    // forceState 觸發的狀態變化能產出 targetPosition + 動畫事件
    if (this.stateMachine) {
      const characterBounds = this.getCharacterBounds();
      const canvas = this.renderer.domElement;

      // 計算臀部螢幕 Y（hips 骨骼）
      let hipScreenY: number | undefined;
      if (this.vrmController) {
        const hips = this.vrmController.getBoneWorldPosition('hips');
        if (hips) {
          hipScreenY = this.worldToScreen(hips.x, hips.y).y;
        }
      }

      // 計算 hide 偵測欄位
      const canvasW = canvas.clientWidth || canvas.width;
      const isFullyOccluded = this.getOcclusionRatio() >= 0.95;
      const isOffScreenLeft = this.currentPosition.x + this.characterSize.width <= this.workAreaOrigin.x;
      const isOffScreenRight = this.currentPosition.x >= this.workAreaOrigin.x + canvasW;

      // StateMachine 更新
      const output = this.stateMachine.tick({
        currentPosition: this.currentPosition,
        characterBounds,
        screenBounds: {
          x: this.workAreaOrigin.x,
          y: this.workAreaOrigin.y,
          width: canvasW,
          height: canvas.clientHeight || canvas.height,
        },
        windowRects: this.cachedWindowRects,
        platforms: this.platforms,
        scale: this.scale,
        deltaTime,
        hipScreenY,
        isFullyOccluded,
        isOffScreenLeft,
        isOffScreenRight,
      });

      this.lastBehaviorOutput = output;

      // 套用目標位置（hide 狀態不 clamp，允許完全超出螢幕）
      if (output.targetPosition) {
        const skipClamp = output.currentState === 'hide' || output.currentState === 'walk';
        this.currentPosition = skipClamp
          ? output.targetPosition
          : this.clampToScreen(output.targetPosition);
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
        // ExpressionManager 回傳 current（fading-in）與 previous（fading-out）兩個 slot，
        // 兩者都要套用以呈現平滑交叉淡化（0.5 秒線性過渡）
        const state = this.expressionManager.resolve();
        if (state.previous) {
          this.vrmController.setBlendShape(state.previous.name, state.previous.value);
        }
        if (state.current) {
          this.vrmController.setBlendShape(state.current.name, state.current.value);
        }
      }
    }

    // Step 5: VRM update (SpringBone etc.) + 模型世界座標定位
    if (this.vrmController) {
      // 將角色螢幕座標轉換為 3D 世界座標並定位模型
      this.updateModelWorldPosition();

      this.vrmController.update(deltaTime);

      // Peek 骨骼錨定（VRM update 之後，手的位置是當前幀）
      if (this.lastBehaviorOutput?.currentState === 'peek' && this.lastBehaviorOutput.peekSide) {
        this.applyPeekBoneAnchor(this.lastBehaviorOutput);
      } else if (this.peekAnchorOffsetX !== 0) {
        // peek 結束，歸零錨定偏移
        this.peekAnchorOffsetX = 0;
      }

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
        offScreenDir: this.getOffScreenDirection(),
        offScreenRatio: this.getOffScreenRatio(),
        occlusionRatio: this.getOcclusionRatio(),
        occlusionMeshes: this.windowMeshManager?.getDebugInfo(),
        platforms: this.platforms.map((p) => ({
          id: p.id,
          screenY: p.screenY,
          width: p.screenXMax - p.screenXMin,
        })),
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
    // 切換到不同 DPI 的螢幕時 devicePixelRatio 會變，必須重新套用
    // 否則 HitTest 的 readPixels 會讀錯位置，導致 alpha 一直為 0 → 拖曳失效
    this.renderer.setPixelRatio(window.devicePixelRatio);
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

    // 根據行為狀態決定角色 Z 深度
    this.currentCharacterZ = this.resolveCharacterZ(this.lastBehaviorOutput);
    let finalZ = this.currentCharacterZ;

    // sit 狀態：補償 hip 骨骼的 3D 偏移，讓 hips 對齊到 (world.x, world.y, currentCharacterZ)
    //
    // 為什麼要補償三軸：某些 sit .vrma 動畫（如 SYS_SIT_01/02）的 hip translation
    // 包含大幅 Z 位移（例如 +1.25m），且模型 rotation 為 0 時這個位移會直接套到世界 Z，
    // 把 hips 推到 z=9.75，靠近 camera near plane (9.9)，導致前方部位（胸/頭/手）被切掉。
    // 補償後 hips 永遠在 currentCharacterZ（預設 8.5），距 camera 1.5m，安全。
    if (this.stateMachine?.getState() === 'sit') {
      const hipOffset = this.vrmController.getHipsRelativeOffset();
      if (hipOffset) {
        world.x -= hipOffset.x;
        world.y -= hipOffset.y;
        finalZ -= hipOffset.z;
      }
      // 診斷：捕捉異常座標（NaN/Infinity 或超出 ±100 世界單位）
      if (
        !Number.isFinite(world.x) ||
        !Number.isFinite(world.y) ||
        !Number.isFinite(finalZ) ||
        Math.abs(world.y) > 100 ||
        Math.abs(world.x) > 100
      ) {
        console.warn('[SceneManager] sit state abnormal world pos:', {
          currentPosition: { ...this.currentPosition },
          characterSize: { ...this.characterSize },
          cachedModelSize: this.cachedModelSize,
          bottomY: this.currentPosition.y + this.characterSize.height,
          worldX: world.x,
          worldY: world.y,
          finalZ,
          hipOffset,
          pixelToWorld: this.pixelToWorld,
          attachedHwnd: this.lastBehaviorOutput?.attachedWindowHwnd ?? null,
          sitPlatformId: this.stateMachine.sitPlatformId,
        });
      }
    }

    this.vrmController.setWorldPosition(world.x, world.y, finalZ);
  }

  /**
   * 根據行為狀態計算角色 Z 深度
   *
   * drag → 8.5（最上方）+ 設定 forceTopAfterDrag
   * 放下後 → 維持 8.5，直到使用者點擊其他視窗（前景視窗改變）
   * peek → 目標視窗 Z - 0.5（在視窗後面）
   * sit → 8.5（最前面，坐在視窗上時角色永遠可見）
   * walk/idle/fall → 前景視窗 Z - 0.5（自動退到前景視窗後面）
   *                  無前景視窗時 → 8.5（最前面）
   */

  /**
   * Peek 骨骼錨定：讓手部骨骼對齊邊緣柱子
   *
   * 在 VRM update 之後呼叫（手的位置已是當前幀）。
   * 使用 lerp 平滑避免每幀微調導致的抖動。
   */
  private applyPeekBoneAnchor(output: BehaviorOutput): void {
    if (!this.vrmController || !output.peekSide) return;

    const side = output.peekSide;
    const hwnd = output.peekTargetHwnd;

    // 計算柱子 key：
    // side='right'（身體在右）→ 抓左邊緣 → 視窗 left edge
    // side='left'（身體在左）→ 抓右邊緣 → 視窗 right edge
    let pillarKey: string;
    if (hwnd !== null) {
      pillarKey = `${hwnd}:${side === 'right' ? 'left' : 'right'}`;
    } else {
      pillarKey = `screen:${side}`;
    }

    const edgeWorldX = this.getEdgePillarWorldX(pillarKey);
    if (edgeWorldX === null) return;

    // 錨定骨骼：side='left'→rightHand, side='right'→leftHand
    const anchorBone = side === 'left' ? 'rightHand' : 'leftHand';
    const handWorld = this.vrmController.getBoneWorldPosition(anchorBone);
    if (!handWorld) return;

    const targetOffsetX = edgeWorldX - handWorld.x;
    // lerp 平滑（0.7 保留 + 0.3 新值）
    this.peekAnchorOffsetX = this.peekAnchorOffsetX * 0.7 + targetOffsetX * 0.3;
    this.vrmController.offsetWorldPositionX(this.peekAnchorOffsetX);
  }

  private resolveCharacterZ(output: BehaviorOutput | null): number {
    const DEFAULT_Z = 8.5;
    if (!output || !this.windowMeshManager) return DEFAULT_Z;

    // 偵測前景視窗改變 → 清除拖曳後置頂
    const foreground = this.cachedWindowRects.find((w) => w.isForeground);
    const currentFgHwnd = foreground?.hwnd ?? null;
    if (this.forceTopAfterDrag && currentFgHwnd !== this.lastForegroundHwnd) {
      this.forceTopAfterDrag = false;
    }
    this.lastForegroundHwnd = currentFgHwnd;

    // 角色大部分超出螢幕時置頂，避免被邊緣附近的視窗 depth mesh 裁切
    if (this.getOffScreenRatio() > 0.5) return DEFAULT_Z;

    // drag 狀態：置頂 + 設定旗標
    if (output.currentState === 'drag') {
      this.forceTopAfterDrag = true;
      return DEFAULT_Z;
    }

    if (output.currentState === 'hide' || output.currentState === 'peek') {
      this.forceTopAfterDrag = false;
      if (output.peekTargetHwnd !== null) {
        // 視窗 hide/peek → 在視窗後面
        const windowZ = this.windowMeshManager.getWindowZ(output.peekTargetHwnd);
        return windowZ !== null ? windowZ - 0.5 : DEFAULT_Z;
      }
      // 螢幕邊緣 hide/peek → 最前面（角色在畫面外或邊緣）
      return DEFAULT_Z;
    }
    if (output.currentState === 'sit') {
      this.forceTopAfterDrag = false;
      return DEFAULT_Z;
    }

    // 拖曳後置頂：放下後維持最上方
    if (this.forceTopAfterDrag) return DEFAULT_Z;

    // 自動退到前景視窗後面：使用者點擊視窗時角色不遮擋
    // 前景視窗最大化時不退後（否則角色完全被遮蔽）
    if (foreground && !foreground.isMaximized) {
      const fgZ = this.windowMeshManager.getWindowZ(foreground.hwnd);
      if (fgZ !== null) return fgZ - 0.5;
    }
    return DEFAULT_Z;
  }

  /** 角色超出 workArea 的方向（可見部分 < 20% 時回傳方向，否則 null） */
  private getOffScreenDirection(): string | null {
    if (!this.vrmController) return null;
    const modelSize = this.cachedModelSize;
    if (!modelSize) return null;

    const actualW = modelSize.width / this.pixelToWorld;
    const actualH = modelSize.height / this.pixelToWorld;
    const charArea = actualW * actualH;
    if (charArea <= 0) return null;

    const cx = this.currentPosition.x + this.characterSize.width / 2;
    const cy = this.currentPosition.y + this.characterSize.height / 2;
    const modelLeft = cx - actualW / 2;
    const modelTop = cy - actualH / 2;

    const wa = this.workAreaOrigin;
    const ws = this.workAreaSize;
    const overlapX = Math.max(0, Math.min(modelLeft + actualW, wa.x + ws.width) - Math.max(modelLeft, wa.x));
    const overlapY = Math.max(0, Math.min(modelTop + actualH, wa.y + ws.height) - Math.max(modelTop, wa.y));
    if ((overlapX * overlapY) / charArea >= 0.2) return null;

    // 用模型中心判斷方向
    const dirs: string[] = [];
    if (cx < wa.x) dirs.push('LEFT');
    if (cx > wa.x + ws.width) dirs.push('RIGHT');
    if (cy < wa.y) dirs.push('TOP');
    if (cy > wa.y + ws.height) dirs.push('BOTTOM');
    return dirs.length > 0 ? dirs.join('+') : 'YES';
  }

  /** 確保遮擋/螢幕外比率在當幀已計算（懶計算，每幀最多一次） */
  private ensureRatiosCached(): void {
    if (this.ratiosCachedThisFrame) return;
    this.cachedOffScreenRatio = this.computeOffScreenRatio();
    this.cachedOcclusionRatio = this.computeOcclusionRatio();
    this.ratiosCachedThisFrame = true;
  }

  /** 取得每幀快取的螢幕外比率 */
  private getOffScreenRatio(): number {
    this.ensureRatiosCached();
    return this.cachedOffScreenRatio;
  }

  /** 取得每幀快取的遮擋比率 */
  private getOcclusionRatio(): number {
    this.ensureRatiosCached();
    return this.cachedOcclusionRatio;
  }

  /** 角色超出螢幕的面積比率（0~1），使用模型實際尺寸（不含邊距） */
  private computeOffScreenRatio(): number {
    if (!this.vrmController) return 0;
    const modelSize = this.cachedModelSize;
    if (!modelSize) return 0;

    const actualW = modelSize.width / this.pixelToWorld;
    const actualH = modelSize.height / this.pixelToWorld;
    const charArea = actualW * actualH;
    if (charArea <= 0) return 0;

    const cx = this.currentPosition.x + this.characterSize.width / 2;
    const cy = this.currentPosition.y + this.characterSize.height / 2;
    const modelLeft = cx - actualW / 2;
    const modelTop = cy - actualH / 2;

    const wa = this.workAreaOrigin;
    const ws = this.workAreaSize;
    const overlapX = Math.max(0, Math.min(modelLeft + actualW, wa.x + ws.width) - Math.max(modelLeft, wa.x));
    const overlapY = Math.max(0, Math.min(modelTop + actualH, wa.y + ws.height) - Math.max(modelTop, wa.y));
    const visibleArea = overlapX * overlapY;
    return 1 - visibleArea / charArea;
  }

  /** 角色螢幕位置被視窗覆蓋的最大比率（0~1），使用模型實際尺寸（不含邊距） */
  private computeOcclusionRatio(): number {
    if (!this.vrmController) return 0;
    const modelSize = this.cachedModelSize;
    if (!modelSize) return 0;

    // 使用模型實際尺寸（不含 characterSize 的 2.5x/1.3x 邊距）
    const actualW = modelSize.width / this.pixelToWorld;
    const actualH = modelSize.height / this.pixelToWorld;
    const charArea = actualW * actualH;
    if (charArea <= 0) return 0;

    // 模型中心 = characterSize bounding box 的中心
    const cx = this.currentPosition.x + this.characterSize.width / 2;
    const cy = this.currentPosition.y + this.characterSize.height / 2;
    const modelLeft = cx - actualW / 2;
    const modelTop = cy - actualH / 2;
    const dpr = window.devicePixelRatio || 1;

    let maxOverlapArea = 0;
    for (const win of this.cachedWindowRects) {
      // 只計算 Z 值高於角色的視窗（在角色前面的）
      if (this.windowMeshManager) {
        const winZ = this.windowMeshManager.getWindowZ(win.hwnd);
        if (winZ !== null && winZ <= this.currentCharacterZ) continue;
      }
      const wx = win.x / dpr;
      const wy = win.y / dpr;
      const overlapX = Math.max(0, Math.min(modelLeft + actualW, wx + win.width / dpr) - Math.max(modelLeft, wx));
      const overlapY = Math.max(0, Math.min(modelTop + actualH, wy + win.height / dpr) - Math.max(modelTop, wy));
      maxOverlapArea = Math.max(maxOverlapArea, overlapX * overlapY);
    }
    return maxOverlapArea / charArea;
  }

  /** 簡單螢幕邊界 clamp（基於 workArea 範圍，允許超出到螢幕邊緣） */
  private clampToScreen(pos: { x: number; y: number }): { x: number; y: number } {
    const canvas = this.renderer.domElement;
    const screenH = canvas.clientHeight || canvas.height;
    const charW = this.characterSize.width;
    const charH = this.characterSize.height;

    // X 活動範圍：左右各允許超出 1.5 倍角色寬度（考慮配件等額外空間）
    const minX = this.workAreaOrigin.x - charW * 1.5;
    const maxX = this.workAreaOrigin.x + this.workAreaSize.width + charW * 0.5;
    // Y 活動範圍：
    //   上限 = 工作區頂部往上 0.3 倍角色高度（讓上半身可略微超出，但下半身一定在工作區內）
    //   下限 = 保留上半身可見
    // 注意：原本是 -charH * 1.0，但這允許整個角色 bounding box 完全在工作區上方，
    // sit 在頂部視窗時導致整個角色在 camera 視野上方而消失。改為 -charH * 0.3。
    const minY = this.workAreaOrigin.y - charH * 0.3;
    const maxY = this.screenOrigin.y + screenH - charH * 0.5;

    return {
      x: Math.max(minX, Math.min(maxX, pos.x)),
      y: Math.max(minY, Math.min(maxY, pos.y)),
    };
  }

  /** 更新角色 bounding box 尺寸（基於模型實際可見大小） */
  private updateCharacterSize(): void {
    if (!this.vrmController) return;

    // 直接呼叫 getModelWorldSize() 取得最新尺寸，不依賴 cachedModelSize。
    // 原因：updateCharacterSize 通常從 setScale() 觸發（IPC 流入，render loop 之外），
    // 此時 cachedModelSize 還是上一幀（舊 scale）的值。
    // 直接讀取確保 setScale → updateCharacterSize 後 characterSize 立即反映新 scale。
    const modelSize = this.vrmController.getModelWorldSize();
    if (!modelSize) return;

    // 同步更新 cachedModelSize，避免下一幀 render loop 開頭重新讀取前的短暫不一致
    this.cachedModelSize = modelSize;

    // getModelWorldSize() 已包含 model scale，不需再乘 this.scale
    // 使用模型實際大小，不加邊距
    this.characterSize = {
      width: Math.round(modelSize.width / this.pixelToWorld),
      height: Math.round(modelSize.height / this.pixelToWorld),
    };
  }

  /**
   * 根據 cachedWindowRects 重建視窗頂部 Platform 和 debug mesh
   *
   * 由 updateCachedWindowRects() 呼叫（IPC 事件驅動，~300ms）。
   * 每個視窗頂部建立一個 Platform（角色走到時可坐下），
   * 並建立對應的 debug mesh（藍色半透明，僅 debug mode 顯示）。
   */
  private rebuildWindowPlatforms(): void {
    const dpr = window.devicePixelRatio || 1;
    const debugVisible = this.debugOverlay?.isEnabled() ?? false;

    // 共用 geometry/material（延遲建立）
    if (!this.windowPlatformGeo) {
      this.windowPlatformGeo = new THREE.PlaneGeometry(1, 1);
    }
    if (!this.windowPlatformMat) {
      this.windowPlatformMat = new THREE.MeshBasicMaterial({
        color: 0x4488ff,
        transparent: true,
        opacity: 0.4,
        depthTest: false,
        side: THREE.DoubleSide,
      });
    }

    const meshThickness = 4 * this.pixelToWorld;
    /** 最小視窗邏輯寬度（px），太小的視窗不建立 platform */
    const MIN_PLATFORM_WIDTH = 100;

    // 保留工作列 platform（index 0），清除舊的視窗 platform
    const taskbarPlatform = this.platforms.find((p) => p.id === 'ground');
    this.platforms = taskbarPlatform ? [taskbarPlatform] : [];

    // 預先轉換所有視窗座標為邏輯像素（供遮擋判定使用）
    const logicalRects = this.cachedWindowRects.map((r) => ({
      hwnd: r.hwnd,
      zOrder: r.zOrder,
      left: r.x / dpr,
      top: r.y / dpr,
      right: (r.x + r.width) / dpr,
      bottom: (r.y + r.height) / dpr,
      width: r.width / dpr,
    }));

    // 清除所有舊的視窗 platform mesh（因為露出區段數量每次都可能改變）
    const newMeshKeys = new Set<string>();

    // sittable 高度門檻：視窗上邊緣若太靠近工作區頂部，
    // 角色坐上去後身體會超出視野上方 → 不建立 platform
    const minSittableTop = this.workAreaOrigin.y + this.characterSize.height * 0.5;

    for (const lr of logicalRects) {
      // 過濾：視窗太小
      if (lr.width < MIN_PLATFORM_WIDTH) continue;
      // 過濾：視窗上邊緣太靠近工作區頂部，無法容納角色身體
      if (lr.top < minSittableTop) continue;

      // 計算露出區段：從完整頂部邊緣 [left, right] 扣除更上層視窗的覆蓋
      const occIntervals: Array<{ start: number; end: number }> = [];
      for (const other of logicalRects) {
        if (other.hwnd === lr.hwnd || other.zOrder >= lr.zOrder) continue;
        if (other.top <= lr.top && other.bottom > lr.top) {
          const overlapLeft = Math.max(other.left, lr.left);
          const overlapRight = Math.min(other.right, lr.right);
          if (overlapLeft < overlapRight) {
            occIntervals.push({ start: overlapLeft, end: overlapRight });
          }
        }
      }

      // 從 [lr.left, lr.right] 扣除被遮擋的區間，得到露出區段
      const exposed = this.subtractIntervals(lr.left, lr.right, occIntervals);

      // 每個露出區段建立獨立的 Platform + mesh
      for (let si = 0; si < exposed.length; si++) {
        const seg = exposed[si];
        if (seg.end - seg.start < MIN_PLATFORM_WIDTH) continue; // 露出太窄也跳過

        const segKey = `${lr.hwnd}:${si}`;
        newMeshKeys.add(segKey);

        // Platform
        this.platforms.push({
          id: `window:${lr.hwnd}`,
          screenY: lr.top,
          screenXMin: seg.start,
          screenXMax: seg.end,
          sitTargetY: lr.top,
        });

        // Debug mesh
        const worldLeft = this.screenToWorld(seg.start, lr.top);
        const worldRight = this.screenToWorld(seg.end, lr.top);
        const meshWidth = worldRight.x - worldLeft.x;
        const meshCenterX = (worldLeft.x + worldRight.x) / 2;

        const existing = this.windowPlatformMeshes.get(segKey);
        if (existing) {
          existing.position.set(meshCenterX, worldLeft.y, 0);
          existing.scale.set(meshWidth, meshThickness, 1);
        } else {
          const mesh = new THREE.Mesh(this.windowPlatformGeo, this.windowPlatformMat);
          mesh.name = `platform:window:${segKey}`;
          mesh.position.set(meshCenterX, worldLeft.y, 0);
          mesh.scale.set(meshWidth, meshThickness, 1);
          mesh.visible = debugVisible;
          this.scene.add(mesh);
          this.windowPlatformMeshes.set(segKey, mesh);
        }
      }
    }

    // 移除已不存在的區段 mesh
    for (const [key, mesh] of this.windowPlatformMeshes) {
      if (!newMeshKeys.has(key)) {
        this.scene.remove(mesh);
        this.windowPlatformMeshes.delete(key);
      }
    }

    // ── 邊緣柱狀 mesh（視窗左右邊緣 + 螢幕左右邊緣）──
    if (!this.edgePillarGeo) {
      this.edgePillarGeo = new THREE.PlaneGeometry(1, 1);
    }
    if (!this.edgePillarMat) {
      this.edgePillarMat = new THREE.MeshBasicMaterial({
        color: 0xff8800,
        transparent: true,
        opacity: 0.4,
        depthTest: false,
        side: THREE.DoubleSide,
      });
    }

    const pillarWidth = 4 * this.pixelToWorld;
    const newPillarKeys = new Set<string>();

    // 視窗邊緣柱子（被更上層視窗覆蓋的邊緣不生成）
    for (const lr of logicalRects) {
      if (lr.width < MIN_PLATFORM_WIDTH) continue;
      for (const edgeSide of ['left', 'right'] as const) {
        const edgeX = edgeSide === 'left' ? lr.left : lr.right;

        // 遮擋過濾：收集覆蓋此邊緣的更上層視窗垂直區間
        const edgeOccIntervals: Array<{ start: number; end: number }> = [];
        for (const other of logicalRects) {
          if (other.hwnd === lr.hwnd || other.zOrder >= lr.zOrder) continue;
          if (other.left <= edgeX && other.right >= edgeX) {
            const overlapTop = Math.max(other.top, lr.top);
            const overlapBot = Math.min(other.bottom, lr.bottom);
            if (overlapTop < overlapBot) {
              edgeOccIntervals.push({ start: overlapTop, end: overlapBot });
            }
          }
        }
        // 計算露出區段（扣除被遮擋的部分）
        const edgeExposed = this.subtractIntervals(lr.top, lr.bottom, edgeOccIntervals);
        if (edgeExposed.length === 0) continue;

        // 每個露出區段各一個柱子 mesh
        for (let si = 0; si < edgeExposed.length; si++) {
          const seg = edgeExposed[si];
          const pillarKey = `${lr.hwnd}:${edgeSide}:${si}`;
          newPillarKeys.add(pillarKey);

          const worldTop = this.screenToWorld(edgeX, seg.start);
          const worldBot = this.screenToWorld(edgeX, seg.end);
          const pillarHeight = Math.abs(worldTop.y - worldBot.y);
          const pillarCenterY = (worldTop.y + worldBot.y) / 2;

          const existing = this.edgePillarMeshes.get(pillarKey);
          if (existing) {
            existing.position.set(worldTop.x, pillarCenterY, 0);
            existing.scale.set(pillarWidth, pillarHeight, 1);
          } else {
            const mesh = new THREE.Mesh(this.edgePillarGeo, this.edgePillarMat);
            mesh.name = `edge:${pillarKey}`;
            mesh.position.set(worldTop.x, pillarCenterY, 0);
            mesh.scale.set(pillarWidth, pillarHeight, 1);
            mesh.visible = debugVisible;
            this.scene.add(mesh);
            this.edgePillarMeshes.set(pillarKey, mesh);
          }
        }
      }
    }

    // 螢幕邊緣柱子（固定 2 根）
    const screenH = this.workAreaSize.height;
    for (const edgeSide of ['left', 'right'] as const) {
      const edgeX = edgeSide === 'left'
        ? this.workAreaOrigin.x
        : this.workAreaOrigin.x + this.workAreaSize.width;
      const pillarKey = `screen:${edgeSide}`;
      newPillarKeys.add(pillarKey);

      const worldTop = this.screenToWorld(edgeX, this.workAreaOrigin.y);
      const worldBot = this.screenToWorld(edgeX, this.workAreaOrigin.y + screenH);
      const pillarHeight = Math.abs(worldTop.y - worldBot.y);
      const pillarCenterY = (worldTop.y + worldBot.y) / 2;

      const existing = this.edgePillarMeshes.get(pillarKey);
      if (existing) {
        existing.position.set(worldTop.x, pillarCenterY, 0);
        existing.scale.set(pillarWidth, pillarHeight, 1);
      } else {
        const mesh = new THREE.Mesh(this.edgePillarGeo, this.edgePillarMat);
        mesh.name = `edge:${pillarKey}`;
        mesh.position.set(worldTop.x, pillarCenterY, 0);
        mesh.scale.set(pillarWidth, pillarHeight, 1);
        mesh.visible = debugVisible;
        this.scene.add(mesh);
        this.edgePillarMeshes.set(pillarKey, mesh);
      }
    }

    // 移除消失的柱子
    for (const [key, mesh] of this.edgePillarMeshes) {
      if (!newPillarKeys.has(key)) {
        this.scene.remove(mesh);
        this.edgePillarMeshes.delete(key);
      }
    }
  }

  /**
   * 從區間 [left, right] 扣除一組遮擋區間，回傳剩餘的露出區段
   *
   * 用於計算視窗頂部邊緣的可見部分。
   */
  private subtractIntervals(
    left: number,
    right: number,
    occlusions: Array<{ start: number; end: number }>,
  ): Array<{ start: number; end: number }> {
    if (occlusions.length === 0) return [{ start: left, end: right }];

    // 合併遮擋區間
    const sorted = [...occlusions].sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const last = merged[merged.length - 1];
      if (sorted[i].start <= last.end) {
        last.end = Math.max(last.end, sorted[i].end);
      } else {
        merged.push({ ...sorted[i] });
      }
    }

    // 從 [left, right] 扣除合併後的遮擋區間
    const result: Array<{ start: number; end: number }> = [];
    let cursor = left;
    for (const occ of merged) {
      if (occ.start > cursor) {
        result.push({ start: cursor, end: Math.min(occ.start, right) });
      }
      cursor = Math.max(cursor, occ.end);
      if (cursor >= right) break;
    }
    if (cursor < right) {
      result.push({ start: cursor, end: right });
    }
    return result;
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
