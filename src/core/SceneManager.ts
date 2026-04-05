import * as THREE from 'three';
import { VRMController } from './VRMController';
import type { AnimationManager } from '../animation/AnimationManager';
import type { FallbackAnimation } from '../animation/FallbackAnimation';
import type { StateMachine } from '../behavior/StateMachine';
import type { CollisionSystem } from '../behavior/CollisionSystem';
import type { BehaviorAnimationBridge } from '../behavior/BehaviorAnimationBridge';
import type { ExpressionManager } from '../expression/ExpressionManager';
import type { DebugOverlay, BoneDebugData, ContactDebugData } from '../debug/DebugOverlay';
import type { Rect } from '../types/window';
import type { Point } from '../types/occlusion';
import { SilhouetteExtractor } from '../occlusion/SilhouetteExtractor';
import { clipPolygonToRect } from '../occlusion/PolygonClip';

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
  private static readonly DEBUG_BONES = ['head', 'leftHand', 'rightHand', 'hips', 'leftUpperLeg', 'rightUpperLeg', 'leftFoot', 'rightFoot'];
  private windowListFetcher: (() => Promise<Array<{ title: string; x: number; y: number; width: number; height: number; zOrder: number }>>) | null = null;
  private lastWindowListUpdate = 0;
  private static readonly WINDOW_LIST_INTERVAL = 1000; // 1 秒更新一次
  private static readonly CONTACT_THRESHOLD = 10; // 骨骼與視窗邊緣接觸判定閾值（像素）

  // 角色位置管理（全螢幕模式：角色在 canvas 內移動，視窗不動）
  private currentPosition = { x: 0, y: 0 };
  private previousPosition = { x: 0, y: 0 };
  /** 角色 bounding box 尺寸（螢幕像素） */
  private characterSize = { width: 300, height: 500 };
  /** workArea 原點（螢幕絕對座標，邏輯像素） */
  private workAreaOrigin = { x: 0, y: 0 };
  /** 像素到世界座標的轉換比例 */
  private pixelToWorld = 0.003126;
  /** 原始 canvas 高度基準（用於攝影機距離縮放） */
  private static readonly BASE_CANVAS_HEIGHT = 600;
  /** 原始攝影機距離 */
  private static readonly BASE_CAMERA_DIST = 3.5;
  // BASE_CAMERA_Y removed: camera Y is now computed from visibleHeight
  private occlusionSetter: ((rects: Rect[]) => void) | null = null;
  private occlusionPolygonSetter: ((points: Point[]) => void) | null = null;
  private silhouetteExtractor: SilhouetteExtractor | null = null;
  private silhouetteEnabled = true;
  private lastOcclusionUpdate = 0;
  private lastOcclusionHash = '';

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

    // Camera — 全螢幕覆蓋，距離按 canvas 高度等比縮放
    this.camera = new THREE.PerspectiveCamera(30, canvas.width / canvas.height, 0.1, 100);
    this.setupCameraForCanvas(canvas.clientHeight || canvas.height);

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

  /** 設定視窗清單取得函式（供 debug overlay 使用） */
  setWindowListFetcher(fetcher: () => Promise<Array<{ title: string; x: number; y: number; width: number; height: number; zOrder: number }>>): void {
    this.windowListFetcher = fetcher;
  }

  /** 設定 workArea 原點（螢幕絕對座標，邏輯像素） */
  setWorkAreaOrigin(x: number, y: number): void {
    this.workAreaOrigin = { x, y };
  }

  /** 設定遮擋更新 callback（矩形，fallback 用） */
  setOcclusionSetter(setter: (rects: Rect[]) => void): void {
    this.occlusionSetter = setter;
  }

  /** 設定多邊形遮擋更新 callback（精確輪廓） */
  setOcclusionPolygonSetter(setter: (points: Point[]) => void): void {
    this.occlusionPolygonSetter = setter;
    // 有 polygon setter 時建立 silhouette extractor
    if (!this.silhouetteExtractor) {
      this.silhouetteExtractor = new SilhouetteExtractor(this.renderer);
    }
  }

  /** 更新當前視窗位置（由外部同步） */
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

    const vFov = this.camera.fov * (Math.PI / 180);
    const camDist = this.camera.position.length();
    const visibleHeight = 2 * Math.tan(vFov / 2) * camDist;

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

    // Debug 移動（Ctrl+方向鍵 global shortcut，debug mode 時有效）
    if (this.debugMoveDir && this.debugOverlay?.isEnabled()) {
      const step = 30;
      switch (this.debugMoveDir) {
        case 'left': this.currentPosition.x -= step; break;
        case 'right': this.currentPosition.x += step; break;
        case 'up': this.currentPosition.y -= step; break;
        case 'down': this.currentPosition.y += step; break;
      }
      this.debugMoveDir = null;
    }

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
          this.characterSize.width,
          this.characterSize.height,
        );

        this.currentPosition = clamped;
      }

      // BehaviorAnimationBridge 更新
      if (this.behaviorBridge) {
        this.behaviorBridge.update(output);
      }
    }

    // 移動方向追蹤 → 模型 Y 軸旋轉（全螢幕模式不旋轉攝影機）
    const moveDx = this.currentPosition.x - this.previousPosition.x;
    const moveDy = this.currentPosition.y - this.previousPosition.y;
    this.updateModelFacingDirection(moveDx, moveDy);

    // 遮擋判定（Phase 1: 判定需要遮擋的視窗，render 後再提取輪廓）
    let pendingOcclusionRects: Rect[] | null = null;
    let pendingOcclusionWindowRect: Rect | null = null;

    if (this.collisionSystem && (this.occlusionSetter || this.occlusionPolygonSetter) && now - this.lastOcclusionUpdate > OCCLUSION_UPDATE_INTERVAL) {
      const isDragging = this.stateMachine?.getState() === 'drag';
      const traversingHwnd = this.stateMachine?.getTraversingWindowHwnd() ?? null;
      const isDebug = this.debugOverlay?.isEnabled() ?? false;

      if (isDragging) {
        pendingOcclusionRects = [];
      } else if (traversingHwnd !== null) {
        pendingOcclusionRects = this.collisionSystem.getOcclusionRectsForWindow(this.getCharacterBounds(), traversingHwnd);
        // 取得穿越視窗的螢幕座標（供多邊形裁切用）
        const wr = this.collisionSystem.getWindowRects().find(w => w.hwnd === traversingHwnd);
        if (wr) {
          pendingOcclusionWindowRect = { x: wr.x, y: wr.y, width: wr.width, height: wr.height };
        }
      } else if (isDebug) {
        const fgWindow = this.collisionSystem.getWindowRects().find(w => w.isForeground);
        if (fgWindow && !fgWindow.isMaximized) {
          pendingOcclusionRects = this.collisionSystem.getOcclusionRectsForWindow(this.getCharacterBounds(), fgWindow.hwnd);
          pendingOcclusionWindowRect = { x: fgWindow.x, y: fgWindow.y, width: fgWindow.width, height: fgWindow.height };
        } else {
          pendingOcclusionRects = [];
        }
      } else {
        pendingOcclusionRects = [];
      }
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

    // Step 5: VRM update (SpringBone etc.) + 模型世界座標定位
    if (this.vrmController) {
      // 將角色螢幕座標轉換為 3D 世界座標並定位模型
      this.updateModelWorldPosition();

      this.vrmController.update(deltaTime);

      this.previousPosition.x = this.currentPosition.x;
      this.previousPosition.y = this.currentPosition.y;
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

      // 攝影機角度面板
      this.debugOverlay.updateCamera(
        this.orbitTheta,
        this.orbitPhi,
        this.modelTargetTheta,
        this.stateMachine?.getSpeedMultiplier() ?? 1.0,
      );

      // 骨骼與視窗邊緣的接觸檢測（Z-order 遮擋感知）
      if (this.collisionSystem) {
        const contacts: ContactDebugData[] = [];
        const windowRects = this.collisionSystem.getWindowRects();
        const threshold = SceneManager.CONTACT_THRESHOLD;
        const dpr = window.devicePixelRatio || 1;

        // 預先計算所有視窗的邏輯座標（避免重複計算）
        const logicalWindows = windowRects.map((wr) => ({
          left: wr.x / dpr,
          right: (wr.x + wr.width) / dpr,
          top: wr.y / dpr,
          bottom: (wr.y + wr.height) / dpr,
          zOrder: wr.zOrder,
        }));

        /** 檢查螢幕座標點是否被更高 Z-order 的視窗遮擋 */
        const isOccludedByHigherZ = (sx: number, sy: number, currentZ: number): boolean => {
          for (const hw of logicalWindows) {
            if (hw.zOrder >= currentZ) continue; // 只看更高層（zOrder 越小越上層）
            if (sx >= hw.left && sx <= hw.right && sy >= hw.top && sy <= hw.bottom) {
              return true;
            }
          }
          return false;
        };

        for (const bone of boneData) {
          if (!bone.screen) continue;
          // 全螢幕模式：bone.screen 已是 canvas 座標 = workArea 相對座標
          const boneScreenX = this.workAreaOrigin.x + bone.screen.x;
          const boneScreenY = this.workAreaOrigin.y + bone.screen.y;

          for (const lw of logicalWindows) {
            const inVertRange = boneScreenY >= lw.top - threshold && boneScreenY <= lw.bottom + threshold;
            const inHorzRange = boneScreenX >= lw.left - threshold && boneScreenX <= lw.right + threshold;

            // 左邊緣
            if (inVertRange && Math.abs(boneScreenX - lw.left) <= threshold) {
              if (!isOccludedByHigherZ(boneScreenX, boneScreenY, lw.zOrder)) {
                contacts.push({ x: bone.screen.x, y: bone.screen.y, direction: 'vertical' });
              }
            }
            // 右邊緣
            if (inVertRange && Math.abs(boneScreenX - lw.right) <= threshold) {
              if (!isOccludedByHigherZ(boneScreenX, boneScreenY, lw.zOrder)) {
                contacts.push({ x: bone.screen.x, y: bone.screen.y, direction: 'vertical' });
              }
            }
            // 上邊緣
            if (inHorzRange && Math.abs(boneScreenY - lw.top) <= threshold) {
              if (!isOccludedByHigherZ(boneScreenX, boneScreenY, lw.zOrder)) {
                contacts.push({ x: bone.screen.x, y: bone.screen.y, direction: 'horizontal' });
              }
            }
            // 下邊緣
            if (inHorzRange && Math.abs(boneScreenY - lw.bottom) <= threshold) {
              if (!isOccludedByHigherZ(boneScreenX, boneScreenY, lw.zOrder)) {
                contacts.push({ x: bone.screen.x, y: bone.screen.y, direction: 'horizontal' });
              }
            }
          }
        }

        this.debugOverlay.updateContacts(contacts);
      }

      // 視窗清單（每秒更新一次）
      const now = performance.now();
      if (this.windowListFetcher && now - this.lastWindowListUpdate > SceneManager.WINDOW_LIST_INTERVAL) {
        this.lastWindowListUpdate = now;
        const pos = this.currentPosition;
        this.windowListFetcher().then((windows) => {
          this.debugOverlay?.updateWindowList(windows, pos);
        }).catch(() => { /* 忽略錯誤 */ });
      }
    }

    // Step 6: Render
    this.renderer.render(this.scene, this.camera);

    // 遮擋套用（Phase 2: render 後提取輪廓或 fallback 到矩形）
    if (pendingOcclusionRects !== null) {
      this.applyOcclusion(pendingOcclusionRects, pendingOcclusionWindowRect);
      this.lastOcclusionUpdate = now;
    }
  };

  /**
   * 套用遮擋效果（render 後呼叫）
   *
   * 優先使用多邊形輪廓，失敗則 fallback 到矩形。
   */
  private applyOcclusion(fallbackRects: Rect[], windowRect: Rect | null): void {
    // 無遮擋需求（空矩形 = 清除遮擋）
    if (fallbackRects.length === 0) {
      const hash = '0';
      if (hash !== this.lastOcclusionHash) {
        this.lastOcclusionHash = hash;
        if (this.occlusionPolygonSetter) {
          this.occlusionPolygonSetter([]);
        } else {
          this.occlusionSetter?.(fallbackRects);
        }
      }
      return;
    }

    // 嘗試多邊形輪廓（僅在實際穿越時使用，debug mode 用矩形即可）
    const isTraversing = this.stateMachine?.getTraversingWindowHwnd() !== null;
    if (isTraversing && this.silhouetteEnabled && this.silhouetteExtractor && this.occlusionPolygonSetter && windowRect) {
      try {
        // 全螢幕模式：只讀取角色所在的子區域（canvas CSS 座標）
        const charBounds = this.getCharacterBounds();
        const extractRegion = {
          x: charBounds.x - this.workAreaOrigin.x,
          y: charBounds.y - this.workAreaOrigin.y,
          width: charBounds.width,
          height: charBounds.height,
        };
        const silhouette = this.silhouetteExtractor.extract(128, 2.0, 200, 4, extractRegion);
        if (silhouette && silhouette.length >= 3) {
          // 視窗螢幕座標轉為 canvas 本地座標（用於裁切）
          const localClipRect: Rect = {
            x: windowRect.x - this.workAreaOrigin.x,
            y: windowRect.y - this.workAreaOrigin.y,
            width: windowRect.width,
            height: windowRect.height,
          };

          // 裁切輪廓與視窗的交集
          const clipped = clipPolygonToRect(silhouette, localClipRect);
          if (clipped.length >= 3) {
            const hash = this.hashPoints(clipped);
            if (hash !== this.lastOcclusionHash) {
              this.lastOcclusionHash = hash;
              this.occlusionPolygonSetter(clipped);
            }
            return;
          }
        }
      } catch (e) {
        // 輪廓提取失敗，永久降級到矩形
        console.warn('[SceneManager] Silhouette extraction failed, falling back to rects:', e);
        this.silhouetteEnabled = false;
      }
    }

    // Fallback: 矩形遮擋
    const hash = this.hashOcclusionData(fallbackRects);
    if (hash !== this.lastOcclusionHash) {
      this.lastOcclusionHash = hash;
      this.occlusionSetter?.(fallbackRects);
    }
  }

  /** 遮擋矩形的簡易 hash（避免 JSON.stringify 的 GC 壓力） */
  private hashOcclusionData(rects: Rect[]): string {
    if (rects.length === 0) return '0';
    let hash = rects.length;
    for (const r of rects) {
      hash = ((hash << 5) - hash + r.x) | 0;
      hash = ((hash << 5) - hash + r.y) | 0;
      hash = ((hash << 5) - hash + r.width) | 0;
      hash = ((hash << 5) - hash + r.height) | 0;
    }
    return 'r' + String(hash);
  }

  /** 多邊形頂點的簡易 hash */
  private hashPoints(points: Point[]): string {
    let hash = points.length;
    for (const p of points) {
      hash = ((hash << 5) - hash + Math.round(p.x)) | 0;
      hash = ((hash << 5) - hash + Math.round(p.y)) | 0;
    }
    return 'p' + String(hash);
  }

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
      // 模型直接旋轉（非攝影機觀察），方向與攝影機方式相反
      this.modelTargetTheta = Math.atan2(dx, -dy);
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
   * 設定攝影機覆蓋全螢幕
   *
   * 距離按 canvas 高度等比縮放，維持模型在任何解析度下的螢幕像素大小一致。
   */
  private setupCameraForCanvas(canvasHeight: number): void {
    const scaleFactor = canvasHeight / SceneManager.BASE_CANVAS_HEIGHT;
    const cameraDist = SceneManager.BASE_CAMERA_DIST * scaleFactor;
    const vFov = this.camera.fov * (Math.PI / 180);
    const visibleHeight = 2 * cameraDist * Math.tan(vFov / 2);
    const centerY = visibleHeight / 2;

    this.camera.position.set(0, centerY, cameraDist);
    this.camera.lookAt(0, centerY, 0);
    this.camera.aspect = window.innerWidth / canvasHeight;
    this.camera.updateProjectionMatrix();

    this.orbitRadius = cameraDist;
    this.pixelToWorld = visibleHeight / canvasHeight;
  }

  /**
   * 螢幕座標 → 3D 世界座標
   *
   * 輸入：螢幕絕對座標（邏輯像素）
   * 輸出：Three.js 世界座標（模型深度 z=0 平面上）
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    const canvas = this.renderer.domElement;
    const canvasX = screenX - this.workAreaOrigin.x;
    const canvasY = screenY - this.workAreaOrigin.y;
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
    const feetScreenY = this.currentPosition.y + this.characterSize.height;

    // 腳底不超過 canvas 底部（workArea 下緣）
    const canvas = this.renderer.domElement;
    const canvasH = canvas.clientHeight || canvas.height;
    const feetCanvasY = feetScreenY - this.workAreaOrigin.y;

    if (feetCanvasY > canvasH) {
      this.currentPosition.y -= (feetCanvasY - canvasH);
    }

    const centerX = this.currentPosition.x + this.characterSize.width / 2;
    const bottomY = this.currentPosition.y + this.characterSize.height;
    const world = this.screenToWorld(centerX, bottomY);

    this.vrmController.setWorldPosition(world.x, world.y);
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
}
