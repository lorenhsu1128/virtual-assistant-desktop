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

  // 視窗位置管理
  private currentPosition = { x: 0, y: 0 };
  private previousPosition = { x: 0, y: 0 };
  private windowSize = { width: 400, height: 600 };
  /** workArea 下緣（邏輯像素），用於限制腳底不超出 */
  private groundY: number | null = null;
  private positionSetter: ((x: number, y: number) => void) | null = null;
  private windowSizeSetter: ((w: number, h: number) => void) | null = null;
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
  private orbitTarget = { x: 0, y: 0.8, z: 0 };
  private isOrbiting = false;
  private orbitStartX = 0;
  private orbitStartY = 0;
  private orbitMoved = false;

  // 移動方向攝影機追蹤
  private targetOrbitTheta: number | null = null;
  private isMovementCameraActive = false;

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

  /** 設定位置更新 callback（fire-and-forget） */
  setPositionSetter(setter: (x: number, y: number) => void): void {
    this.positionSetter = setter;
  }

  /** 設定視窗大小更新 callback */
  setWindowSizeSetter(setter: (w: number, h: number) => void): void {
    this.windowSizeSetter = setter;
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

  /** 設定視窗大小 */
  setWindowSize(size: { width: number; height: number }): void {
    this.windowSize = size;
  }

  /** 設定地面 Y 座標（workArea 下緣，邏輯像素） */
  setGroundY(y: number): void {
    this.groundY = y;
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
      width: this.windowSize.width,
      height: this.windowSize.height,
    };
  }

  /** 角色在 viewport 中佔的比例（高度） */
  private charViewportRatioH = 0.5;
  /** 角色寬高比（3D 模型） */
  private charAspectRatio = 0.4;
  /** 螢幕邏輯像素高度 */
  private screenLogicalHeight = 1080;

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

  /** 設定螢幕邏輯像素高度 */
  setScreenHeight(logicalHeight: number): void {
    this.screenLogicalHeight = logicalHeight;
  }

  /** 視窗高度邊距倍率（容納頭髮/配飾不被切掉） */
  private static readonly HEIGHT_PADDING = 1.3;

  /** 設定角色縮放（0.5–2.0） */
  setScale(scale: number): void {
    this.scale = Math.max(0.5, Math.min(2.0, scale));

    // 目標：角色螢幕高度 = 螢幕高度 × 40% × scale
    const targetCharH = this.screenLogicalHeight * 0.4 * this.scale;
    const targetCharW = targetCharH * this.charAspectRatio;

    // 視窗加邊距，model scale 補償以保持角色大小不變
    const padding = SceneManager.HEIGHT_PADDING;
    const newH = Math.round(targetCharH / this.charViewportRatioH * padding);
    const newW = Math.round(targetCharW * 3);

    // 補償 model scale = 1/padding，抵消視窗變大導致角色放大
    if (this.vrmController) {
      this.vrmController.setModelScale(1.0 / padding);
    }

    this.windowSize = { width: newW, height: newH };
    this.windowSizeSetter?.(newW, newH);
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
      const step = 30; // 每次按鍵移動 30px
      switch (this.debugMoveDir) {
        case 'left': this.currentPosition.x -= step; break;
        case 'right': this.currentPosition.x += step; break;
        case 'up': this.currentPosition.y -= step; break;
        case 'down': this.currentPosition.y += step; break;
      }
      this.positionSetter?.(Math.round(this.currentPosition.x), Math.round(this.currentPosition.y));
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
          this.windowSize.width,
          this.windowSize.height,
        );

        // 腳底不超過 groundY（workArea 下緣）
        if (this.groundY !== null && this.vrmController) {
          const canvas = this.renderer.domElement;
          const footPositions = this.vrmController.getBoneScreenPositions(
            ['leftFoot', 'rightFoot'], this.camera, canvas.clientWidth, canvas.clientHeight,
          );
          let maxFootY = 0;
          for (const [, pos] of footPositions) {
            if (pos.y > maxFootY) maxFootY = pos.y;
          }
          // 腳底螢幕 Y = 視窗 Y + 骨骼 canvas Y
          const footScreenY = clamped.y + maxFootY;
          if (footScreenY > this.groundY) {
            clamped.y -= footScreenY - this.groundY;
          }
        }

        this.currentPosition = clamped;
        this.positionSetter?.(clamped.x, clamped.y);
      }

      // BehaviorAnimationBridge 更新
      if (this.behaviorBridge) {
        this.behaviorBridge.update(output);
      }
    }

    // 攝影機方向追蹤（根據移動方向旋轉，停止時恢復正面）
    const moveDx = this.currentPosition.x - this.previousPosition.x;
    const moveDy = this.currentPosition.y - this.previousPosition.y;
    this.updateCameraDirection(moveDx, moveDy);
    this.applyOrbitInterpolation();

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

    // Step 5: VRM update (SpringBone etc.)
    // 反向微移：將視窗移動量轉為 3D 空間偏移，讓 SpringBone 偵測到移動
    if (this.vrmController) {
      const dxPx = this.currentPosition.x - this.previousPosition.x;
      const dyPx = this.currentPosition.y - this.previousPosition.y;

      if (dxPx !== 0 || dyPx !== 0) {
        // 像素 → 3D 世界座標：基於攝影機視野和 canvas 尺寸
        const canvas = this.renderer.domElement;
        const vFov = this.camera.fov * (Math.PI / 180);
        const camDist = this.camera.position.length(); // 使用距離而非 z（考慮 orbit）
        const worldHeight = 2 * Math.tan(vFov / 2) * camDist;
        const pxToWorld = worldHeight / canvas.clientHeight;

        // 反向偏移（視窗向右移 → 模型向左移，模擬慣性）
        const offsetX = -dxPx * pxToWorld;
        const offsetY = dyPx * pxToWorld; // Y 軸反轉（螢幕 Y 向下，3D Y 向上）

        this.vrmController.applySceneOffset(offsetX, offsetY);
        this.vrmController.update(deltaTime);
        this.vrmController.clearSceneOffset(offsetX, offsetY);
      } else {
        this.vrmController.update(deltaTime);
      }

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
        this.targetOrbitTheta,
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
          const boneScreenX = this.currentPosition.x + bone.screen.x;
          const boneScreenY = this.currentPosition.y + bone.screen.y;

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
        const silhouette = this.silhouetteExtractor.extract();
        if (silhouette && silhouette.length >= 3) {
          // 將視窗螢幕座標轉為角色視窗本地座標（canvas CSS 像素）
          const charBounds = this.getCharacterBounds();
          const localClipRect: Rect = {
            x: windowRect.x - charBounds.x,
            y: windowRect.y - charBounds.y,
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

  /**
   * 根據移動方向更新攝影機目標角度
   *
   * 用 atan2 計算連續角度（支援斜向移動）。
   * 停止移動時平滑恢復到正面角度。
   */
  private updateCameraDirection(dx: number, dy: number): void {
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      // 停止移動 → 恢復正面
      if (this.isMovementCameraActive) {
        this.targetOrbitTheta = 0;
        this.isMovementCameraActive = false;
      }
      return;
    }

    this.isMovementCameraActive = true;
    // 螢幕座標：dx>0=右, dy<0=上（螢幕Y軸向下）
    // 目標：左=π/2, 右=-π/2, 上（dy<0）=π（背面）, 下（dy>0）=0（正面）
    this.targetOrbitTheta = Math.atan2(-dx, dy);
  }

  /** 平滑插值攝影機角度到目標 */
  private applyOrbitInterpolation(): void {
    if (this.targetOrbitTheta === null) return;

    let diff = this.targetOrbitTheta - this.orbitTheta;
    // 處理角度跨 -π/π 邊界的最短路徑
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;

    if (Math.abs(diff) < 0.001) {
      this.orbitTheta = this.targetOrbitTheta;
      // 恢復正面完成後清除目標
      if (!this.isMovementCameraActive) {
        this.targetOrbitTheta = null;
      }
    } else {
      this.orbitTheta += diff * 0.08;
    }
    this.updateCameraFromOrbit();
  }

  /** 取得當前攝影機角度（供 Debug overlay 使用） */
  getCameraAngles(): { theta: number; phi: number; targetTheta: number | null } {
    return {
      theta: this.orbitTheta,
      phi: this.orbitPhi,
      targetTheta: this.targetOrbitTheta,
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
