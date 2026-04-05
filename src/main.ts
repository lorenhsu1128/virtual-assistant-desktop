import { ipc } from './bridge/ElectronIPC';
import { SceneManager } from './core/SceneManager';
import { VRMController } from './core/VRMController';
import { AnimationManager } from './animation/AnimationManager';
import { FallbackAnimation } from './animation/FallbackAnimation';
import { StateMachine } from './behavior/StateMachine';
import { CollisionSystem } from './behavior/CollisionSystem';
import { BehaviorAnimationBridge } from './behavior/BehaviorAnimationBridge';
import { DragHandler } from './interaction/DragHandler';
import { HitTestManager } from './interaction/HitTestManager';
import { DEFAULT_CONFIG, type AppConfig } from './types/config';
import type { TrayMenuData } from './types/tray';
import { ExpressionManager } from './expression/ExpressionManager';
import { DebugOverlay } from './debug/DebugOverlay';
import type { WindowRect } from './types/window';

/**
 * 應用程式進入點
 *
 * 流程：
 * 1. 檢測是否首次啟動
 * 2. 首次啟動 → 引導使用者選擇 VRM + 動畫資料夾
 * 3. 非首次啟動 → 直接讀取設定
 * 4. 載入模型 → 初始化動畫系統 → 初始化行為系統 → 啟動 render loop
 */
function debugLog(msg: string): void {
  console.log('[main]', msg);
}

async function main(): Promise<void> {
  debugLog('main() started');
  const configExists = await ipc.getConfigExists();
  debugLog(`configExists=${configExists}`);

  let config: AppConfig;

  if (!configExists) {
    // 首次啟動流程
    const result = await runFirstRunWizard();
    if (!result) return; // 使用者中途放棄
    config = result;
  } else {
    debugLog('reading existing config...');
    // 讀取既有設定
    const loaded = await ipc.readConfig();
    config = loaded ?? { ...DEFAULT_CONFIG };

    // 檢查 VRM 模型路徑是否仍有效
    if (!config.vrmModelPath) {
      const modelPath = await promptForModel();
      if (!modelPath) return;
      config.vrmModelPath = modelPath;
      await ipc.writeConfig(config);
    }
  }

  // 初始化渲染系統
  debugLog(`calling initializeApp, vrmPath=${config.vrmModelPath?.substring(0, 50)}`);
  await initializeApp(config);
  debugLog('initializeApp completed');
}

/**
 * 首次啟動引導精靈
 */
async function runFirstRunWizard(): Promise<AppConfig | null> {
  const overlay = document.getElementById('first-run-overlay');
  if (!overlay) return null;

  overlay.classList.add('visible');

  const config: AppConfig = { ...DEFAULT_CONFIG };

  // Step 1: 歡迎
  await waitForClick('btn-start');
  showStep('step-model');

  // Step 2: 選擇 VRM 模型（必要）
  let modelPath: string | null = null;
  while (!modelPath) {
    await waitForClick('btn-pick-model');
    modelPath = await ipc.pickVrmFile();
    // 使用者取消時繼續等待（此步驟不可跳過）
  }
  config.vrmModelPath = modelPath;
  showStep('step-animation');

  // Step 3: 選擇動畫資料夾（可選）
  const animResult = await Promise.race([
    waitForClick('btn-pick-animation').then(() => 'pick' as const),
    waitForClick('btn-skip-animation').then(() => 'skip' as const),
  ]);

  if (animResult === 'pick') {
    const folderPath = await ipc.pickAnimationFolder();
    if (folderPath) {
      config.animationFolderPath = folderPath;
      // 掃描動畫
      await ipc.scanAnimations(folderPath);
    }
  }

  showStep('step-done');

  // 儲存設定
  await ipc.writeConfig(config);

  // 短暫顯示完成畫面後關閉
  await delay(1000);
  overlay.classList.remove('visible');

  return config;
}

/**
 * 提示使用者重新選擇 VRM 模型（非首次啟動但模型遺失時）
 */
async function promptForModel(): Promise<string | null> {
  return await ipc.pickVrmFile();
}

/**
 * 初始化應用程式
 *
 * 建立 SceneManager → VRMController → AnimationManager → 行為系統 → 互動系統 → 啟動 render loop
 */
async function initializeApp(config: AppConfig): Promise<void> {
  // 建立 canvas
  const canvas = document.createElement('canvas');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  // 初始化 SceneManager
  const sceneManager = new SceneManager(canvas, config.targetFps);

  // 初始化 VRMController
  const vrmController = new VRMController(sceneManager.getScene());
  sceneManager.setVRMController(vrmController);

  // 載入 VRM 模型
  if (!config.vrmModelPath) {
    console.error('[main] No VRM model path configured');
    return;
  }

  try {
    const modelUrl = ipc.convertToAssetUrl(config.vrmModelPath);
    debugLog(`loading model: ${modelUrl.substring(0, 80)}`);
    await vrmController.loadModel(modelUrl);
    debugLog('model loaded OK');
  } catch (e) {
    debugLog(`model FAILED: ${e}`);
    console.error('[main] Failed to load VRM model:', e);
    // VRM 載入失敗：提示使用者重新選取
    const newPath = await promptForModel();
    if (!newPath) return;
    config.vrmModelPath = newPath;
    await ipc.writeConfig(config);
    try {
      const retryUrl = ipc.convertToAssetUrl(newPath);
      await vrmController.loadModel(retryUrl);
    } catch (e2) {
      console.error('[main] Failed to load VRM model on retry:', e2);
      return;
    }
  }

  // 計算角色在 viewport 中的比例
  sceneManager.computeCharacterViewportRatio();

  // 設定螢幕高度（邏輯像素，用於角色大小計算：100% = 螢幕高度 30%）
  sceneManager.setScreenHeight(screen.height);

  // 設定縮放並初始化視窗大小
  sceneManager.setScale(config.scale);
  const initBounds = sceneManager.getCharacterBounds();
  await ipc.setWindowSize(initBounds.width, initBounds.height);

  // 初始化 FallbackAnimation
  const fallbackAnimation = new FallbackAnimation(vrmController);
  sceneManager.setFallbackAnimation(fallbackAnimation);

  // 初始化動畫系統
  let animationManager: AnimationManager | null = null;
  const mixer = vrmController.getAnimationMixer();
  if (mixer) {
    const animationLoader = (filePath: string) => {
      const assetUrl = ipc.convertToAssetUrl(filePath);
      return vrmController.loadVRMAnimation(assetUrl);
    };
    animationManager = new AnimationManager(mixer, animationLoader);
    sceneManager.setAnimationManager(animationManager);

    // 載入動畫
    if (config.animationFolderPath) {
      const meta = await ipc.readAnimationMeta();
      if (meta && meta.entries.length > 0) {
        await animationManager.loadAnimations(meta.entries, config.animationFolderPath);
        sceneManager.setUseFallback(!animationManager.hasAnimations());
      } else {
        sceneManager.setUseFallback(true);
      }
    } else {
      sceneManager.setUseFallback(true);
    }
  } else {
    sceneManager.setUseFallback(true);
  }

  // 套用已儲存的動畫循環設定
  if (animationManager && config.animationLoopEnabled === false) {
    animationManager.setLoopEnabled(false);
  }

  // 套用已儲存的動畫速率
  if (animationManager && config.animationSpeed && config.animationSpeed !== 1.0) {
    animationManager.setTimeScale(config.animationSpeed);
  }

  // 先啟動 render loop（確保角色先渲染出來）
  debugLog('starting render loop');
  sceneManager.start();
  debugLog('render loop started, character should be visible');

  // ── v0.2: 行為系統（非阻塞，初始化失敗不影響基本渲染） ──
  try {
    await initializeBehaviorSystem(config, sceneManager, vrmController, animationManager, canvas, collisionSystemRef);
  } catch (e) {
    console.warn('[main] v0.2 behavior system initialization failed, basic rendering continues:', e);
  }
}

/** v0.2 行為系統參照（供 cleanup 使用） */
const collisionSystemRef = { current: new CollisionSystem() };

/**
 * 初始化 v0.2 行為與互動系統
 *
 * 獨立函式，失敗時不影響基本渲染。
 */
async function initializeBehaviorSystem(
  config: AppConfig,
  sceneManager: SceneManager,
  vrmController: VRMController,
  animationManager: AnimationManager | null,
  canvas: HTMLCanvasElement,
  csRef: { current: CollisionSystem },
): Promise<void> {
  // 取得視窗位置與大小
  const initialPos = await ipc.getWindowPosition();
  const initialSize = await ipc.getWindowSize();
  sceneManager.setCurrentPosition(initialPos);
  sceneManager.setWindowSize(initialSize);

  // CollisionSystem
  const collisionSystem = csRef.current;

  // 螢幕邊界 + 工作列偵測
  const displays = await ipc.getDisplayInfo();
  let taskbarRect: WindowRect | null = null;
  if (displays.length > 0) {
    const primaryDisplay = displays[0];
    // 使用 workArea 作為螢幕邊界（扣除工作列）
    const effectiveBounds = primaryDisplay.workArea ?? primaryDisplay;
    collisionSystem.updateScreenBounds({
      x: effectiveBounds.x,
      y: effectiveBounds.y,
      width: effectiveBounds.width,
      height: effectiveBounds.height,
    });

    // 設定 groundY（workArea 下緣），腳底骨骼不可超過此值
    sceneManager.setGroundY(effectiveBounds.y + effectiveBounds.height);

    // 從 bounds vs workArea 推算工作列位置
    if (primaryDisplay.workArea) {
      const b = primaryDisplay;
      const w = primaryDisplay.workArea;
      // DPI: workArea 是邏輯像素，但 WindowRect 是物理像素
      const dpr = primaryDisplay.scaleFactor;
      if (w.y > b.y) {
        // 工作列在上方
        taskbarRect = { hwnd: -1, title: 'Taskbar', x: Math.round(b.x * dpr), y: Math.round(b.y * dpr), width: Math.round(b.width * dpr), height: Math.round((w.y - b.y) * dpr), zOrder: -1 };
      } else if (w.height < b.height) {
        // 工作列在下方
        const taskbarY = w.y + w.height;
        const taskbarH = b.height - w.height;
        taskbarRect = { hwnd: -1, title: 'Taskbar', x: Math.round(b.x * dpr), y: Math.round(taskbarY * dpr), width: Math.round(b.width * dpr), height: Math.round(taskbarH * dpr), zOrder: -1 };
      } else if (w.x > b.x) {
        // 工作列在左方
        taskbarRect = { hwnd: -1, title: 'Taskbar', x: Math.round(b.x * dpr), y: Math.round(b.y * dpr), width: Math.round((w.x - b.x) * dpr), height: Math.round(b.height * dpr), zOrder: -1 };
      } else if (w.width < b.width) {
        // 工作列在右方
        const taskbarX = w.x + w.width;
        const taskbarW = b.width - w.width;
        taskbarRect = { hwnd: -1, title: 'Taskbar', x: Math.round(taskbarX * dpr), y: Math.round(b.y * dpr), width: Math.round(taskbarW * dpr), height: Math.round(b.height * dpr), zOrder: -1 };
      }
    }
  } else {
    collisionSystem.updateScreenBounds({
      x: 0,
      y: 0,
      width: screen.width,
      height: screen.height,
    });
  }

  // 將視窗座標從物理像素轉為邏輯像素（GetWindowRect 回傳物理像素，Electron 使用邏輯像素）
  const dpr = window.devicePixelRatio || 1;
  const toLogicalRects = (rects: WindowRect[]): WindowRect[] =>
    rects.map(r => ({
      ...r,
      x: Math.round(r.x / dpr),
      y: Math.round(r.y / dpr),
      width: Math.round(r.width / dpr),
      height: Math.round(r.height / dpr),
    }));

  // 初始視窗清單（含工作列）
  const initialWindows = await ipc.getWindowList();
  const initialAllWindows = taskbarRect ? [...initialWindows, taskbarRect] : initialWindows;
  collisionSystem.updateWindowRects(toLogicalRects(initialAllWindows));

  sceneManager.setCollisionSystem(collisionSystem);

  // 監聯視窗佈局變化（加入工作列虛擬視窗）
  await ipc.onWindowLayoutChanged((rects) => {
    const allRects = taskbarRect ? [...rects, taskbarRect] : rects;
    collisionSystem.updateWindowRects(toLogicalRects(allRects));
  });

  // StateMachine
  const stateMachine = new StateMachine();
  if (config.autonomousMovementPaused) {
    stateMachine.pause();
  }
  sceneManager.setStateMachine(stateMachine);

  // BehaviorAnimationBridge
  if (animationManager) {
    const bridge = new BehaviorAnimationBridge(animationManager);
    sceneManager.setBehaviorAnimationBridge(bridge);
  }

  // 位置更新 callback（fire-and-forget）
  sceneManager.setPositionSetter((x, y) => {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      ipc.setWindowPosition(Math.round(x), Math.round(y));
    }
  });

  // 視窗大小更新 callback（縮放時同步調整）
  sceneManager.setWindowSizeSetter((w, h) => {
    ipc.setWindowSize(w, h);
  });

  // 遮擋更新 callback（邏輯像素 → 物理像素，SetWindowRgn 使用物理像素）
  sceneManager.setOcclusionSetter((rects) => {
    const mappedRects = rects.map((r) => ({
      x: Math.round(r.x * dpr),
      y: Math.round(r.y * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
    }));
    ipc.setWindowRegion(mappedRects);
  });

  // ── v0.3: 表情系統 ──
  const expressionManager = new ExpressionManager();
  const blendShapes = vrmController.getBlendShapes();
  expressionManager.setAvailableExpressions(blendShapes);
  if (config.autoExpressionEnabled === false) {
    expressionManager.setAutoEnabled(false);
  }
  if (config.allowedAutoExpressions && config.allowedAutoExpressions.length > 0) {
    expressionManager.setAllowedAutoExpressions(config.allowedAutoExpressions);
  }
  sceneManager.setExpressionManager(expressionManager);

  // ── Debug Overlay ──
  const debugOverlay = new DebugOverlay();
  debugOverlay.setEnabled(true); // 預設開啟 debug mode
  sceneManager.setDebugOverlay(debugOverlay);
  sceneManager.setWindowListFetcher(() => ipc.getWindowList());

  // ── Hit-Test 滑鼠穿透 ──
  const hitTestManager = new HitTestManager(canvas, sceneManager.getRenderer(), {
    setIgnoreCursorEvents: (ignore) => ipc.setIgnoreCursorEvents(ignore),
  });

  // ── 互動系統 ──

  const dragHandler = new DragHandler(canvas, {
    getWindowPosition: () => ipc.getWindowPosition(),
    setWindowPosition: (x, y) => ipc.setWindowPosition(x, y),
    getSnappableWindows: (bounds, threshold) =>
      collisionSystem.getSnappableWindows(bounds, threshold),
    clampToScreen: (pos, w, h) => collisionSystem.clampToScreen(pos, w, h),
    getCharacterSize: () => {
      const bounds = sceneManager.getCharacterBounds();
      return { width: bounds.width, height: bounds.height };
    },
    onDragMove: (x, y) => sceneManager.setCurrentPosition({ x, y }),
    onDragLock: () => hitTestManager.lockForDrag(),
    onDragUnlock: () => hitTestManager.unlockDrag(),
    onDragStart: () => {
      stateMachine.forceState('drag');
    },
    onDragEnd: (position, snappedWindow) => {
      sceneManager.setCurrentPosition(position);
      if (snappedWindow) {
        stateMachine.setAttachedWindow(snappedWindow.hwnd, {
          x: snappedWindow.x,
          y: snappedWindow.y,
        });
        stateMachine.forceState('sit');
      } else {
        stateMachine.forceState('idle');
      }
    },
  });

  // ── 系統托盤選單資料推送 ──
  /** 收集當前狀態並推送給 main process 更新托盤選單 */
  const pushTrayMenuData = (): void => {
    const menuData: TrayMenuData = {
      animations: animationManager?.getAnimationsByCategory('action').map((a) => ({
        fileName: a.fileName,
        displayName: a.displayName,
      })) ?? [],
      expressions: vrmController.getBlendShapes(),
      currentScale: sceneManager.getScale(),
      currentSpeed: animationManager?.getTimeScale() ?? 1.0,
      isPaused: stateMachine.isPaused(),
      isAutoExpressionEnabled: expressionManager.isAutoEnabled(),
      isLoopEnabled: animationManager?.isLoopEnabled() ?? true,
      isDebugEnabled: debugOverlay.isEnabled(),
      currentExpression: expressionManager.getManualExpression(),
    };
    ipc.sendMenuData(menuData);
  };

  // 初始推送（讓托盤有動態選單資料）
  pushTrayMenuData();

  // ── Debug 移動（Ctrl+方向鍵） ──
  await ipc.onDebugMove((direction) => {
    sceneManager.debugMove(direction);
  });

  // ── 系統托盤事件 ──
  await ipc.onTrayAction((actionId) => {
    switch (actionId) {
      case 'toggle_debug':
        debugOverlay.setEnabled(!debugOverlay.isEnabled());
        break;
      case 'toggle_pause':
        if (stateMachine.isPaused()) { stateMachine.resume(); } else { stateMachine.pause(); }
        config.autonomousMovementPaused = stateMachine.isPaused();
        ipc.writeConfig(config);
        break;
      case 'toggle_auto_expr': {
        const newVal = !expressionManager.isAutoEnabled();
        expressionManager.setAutoEnabled(newVal);
        config.autoExpressionEnabled = newVal;
        ipc.writeConfig(config);
        break;
      }
      case 'toggle_loop':
        if (animationManager) {
          const v = !animationManager.isLoopEnabled();
          animationManager.setLoopEnabled(v);
          config.animationLoopEnabled = v;
          ipc.writeConfig(config);
        }
        break;
      case 'reset_camera':
        sceneManager.resetCamera();
        break;
      case 'reset_position':
        ipc.getDisplayInfo().then((displays) => {
          const d = displays[0] ?? { x: 0, y: 0, width: screen.width, height: screen.height };
          const wb = d.workArea ?? d;
          const cx = wb.x + (wb.width - 400) / 2;
          const cy = wb.y + (wb.height - 600) / 2;
          sceneManager.setCurrentPosition({ x: cx, y: cy });
          ipc.setWindowPosition(cx, cy);
        });
        break;
      case 'change_model':
        ipc.pickVrmFile().then(async (p) => {
          if (!p) return;
          config.vrmModelPath = p;
          await ipc.writeConfig(config);
          window.location.reload();
        });
        break;
      case 'change_anim':
        ipc.pickAnimationFolder().then(async (p) => {
          if (!p) return;
          config.animationFolderPath = p;
          await ipc.scanAnimations(p);
          await ipc.writeConfig(config);
          window.location.reload();
        });
        break;
      case 'scale_50': sceneManager.setScale(0.5); config.scale = 0.5; ipc.writeConfig(config); break;
      case 'scale_75': sceneManager.setScale(0.75); config.scale = 0.75; ipc.writeConfig(config); break;
      case 'scale_100': sceneManager.setScale(1.0); config.scale = 1.0; ipc.writeConfig(config); break;
      case 'scale_125': sceneManager.setScale(1.25); config.scale = 1.25; ipc.writeConfig(config); break;
      case 'scale_150': sceneManager.setScale(1.5); config.scale = 1.5; ipc.writeConfig(config); break;
      case 'scale_200': sceneManager.setScale(2.0); config.scale = 2.0; ipc.writeConfig(config); break;
      case 'speed_050': if (animationManager) { animationManager.setTimeScale(0.5); config.animationSpeed = 0.5; ipc.writeConfig(config); } break;
      case 'speed_075': if (animationManager) { animationManager.setTimeScale(0.75); config.animationSpeed = 0.75; ipc.writeConfig(config); } break;
      case 'speed_100': if (animationManager) { animationManager.setTimeScale(1.0); config.animationSpeed = 1.0; ipc.writeConfig(config); } break;
      case 'speed_125': if (animationManager) { animationManager.setTimeScale(1.25); config.animationSpeed = 1.25; ipc.writeConfig(config); } break;
      case 'settings':
        // TODO: 開啟設定視窗
        console.log('[main] Settings window not yet implemented');
        break;
      default:
        // Dynamic action: play animation
        if (actionId.startsWith('play_anim::')) {
          const fileName = actionId.slice('play_anim::'.length);
          animationManager?.playByName(fileName);
        }
        // Dynamic action: set expression
        else if (actionId.startsWith('set_expr::')) {
          const name = actionId.slice('set_expr::'.length);
          expressionManager.setManualExpression(name);
          vrmController.setBlendShape(name, 1.0);
        }
        break;
    }
    // 每次動作後更新托盤選單狀態
    pushTrayMenuData();
  });

  // 清理函式
  window.addEventListener('beforeunload', () => {
    hitTestManager.dispose();
    dragHandler.dispose();
    debugOverlay.dispose();
    sceneManager.dispose();
  });
}

// ── Utility functions ──

function showStep(stepId: string): void {
  document.querySelectorAll('#first-run-overlay .step').forEach((el) => {
    el.classList.remove('active');
  });
  document.getElementById(stepId)?.classList.add('active');
}

function waitForClick(buttonId: string): Promise<void> {
  return new Promise((resolve) => {
    const btn = document.getElementById(buttonId);
    if (!btn) {
      resolve();
      return;
    }
    btn.addEventListener('click', () => resolve(), { once: true });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 啟動
main().catch((e) => {
  debugLog(`FATAL: ${e}`);
  console.error('[main] Unhandled error:', e);
});
