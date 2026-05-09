import * as THREE from 'three';
import { ipc } from './bridge/ElectronIPC';
import { SceneManager } from './core/SceneManager';
import { VRMController } from './core/VRMController';
import { AnimationManager } from './animation/AnimationManager';
import { FallbackAnimation } from './animation/FallbackAnimation';
import { StateMachine } from './behavior/StateMachine';
import { BehaviorAnimationBridge } from './behavior/BehaviorAnimationBridge';
import { DragHandler } from './interaction/DragHandler';
import { HitTestManager } from './interaction/HitTestManager';
import { DEFAULT_CONFIG, type AppConfig } from './types/config';
import type { TrayMenuData } from './types/tray';
import type { DisplayInfo } from './types/window';
import { ExpressionManager } from './expression/ExpressionManager';
import { MascotActionDispatcher } from './agent/MascotActionDispatcher';
import { DebugOverlay } from './debug/DebugOverlay';
import { analyzeWalkAnimation } from './animation/StepAnalyzer';
import { mirrorAnimationClip } from './animation/AnimationMirror';
import { reverseAnimationClipForEnterdoor } from './animation/AnimationReverse';
import { CharacterContextMenu } from './interaction/CharacterContextMenu';
import { SYSTEM_ANIMATION_STATES } from './types/animation';
import {
  filterFilesByState,
  extractBasename,
} from './animation/systemAnimationMatcher';
import type { LoadedPoolClip } from './animation/AnimationManager';
import { WindowMeshManager } from './occlusion/WindowMeshManager';

/** IPC 事件 unlisten 函式集合（beforeunload 時統一清除） */
const cleanupFns: Array<(() => void) | undefined> = [];

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

  // 取得 app 根目錄，用於解析相對路徑
  const appPath = await ipc.getAppPath();
  debugLog(`appPath=${appPath}`);

  const configExists = await ipc.getConfigExists();
  debugLog(`configExists=${configExists}`);

  let config: AppConfig;

  if (!configExists) {
    // 首次啟動：使用系統預設資產，跳過引導精靈
    config = { ...DEFAULT_CONFIG };
    const defaults = await resolveSystemAssets(appPath, config.systemAssetsDir);
    if (defaults.vrmPath) {
      config.vrmModelPath = defaults.vrmPath;
    }
    if (defaults.vrmaDir) {
      config.animationFolderPath = defaults.vrmaDir;
      await ipc.scanAnimations(defaults.vrmaDir);
    }
    await ipc.writeConfig(config);

    // 若系統目錄沒有預設 VRM，才引導使用者手動選擇
    if (!config.vrmModelPath) {
      const result = await runFirstRunWizard();
      if (!result) return;
      config = result;
    }
  } else {
    debugLog('reading existing config...');
    const loaded = await ipc.readConfig();
    config = loaded ?? { ...DEFAULT_CONFIG };

    // 檢查 VRM 模型路徑是否仍有效
    if (!config.vrmModelPath) {
      // 先嘗試系統預設
      const defaults = await resolveSystemAssets(appPath, config.systemAssetsDir);
      if (defaults.vrmPath) {
        config.vrmModelPath = defaults.vrmPath;
        await ipc.writeConfig(config);
      } else {
        const modelPath = await promptForModel();
        if (!modelPath) return;
        config.vrmModelPath = modelPath;
        await ipc.writeConfig(config);
      }
    }
    // 若沒有動畫資料夾，嘗試系統預設
    if (!config.animationFolderPath) {
      const defaults = await resolveSystemAssets(appPath, config.systemAssetsDir);
      if (defaults.vrmaDir) {
        config.animationFolderPath = defaults.vrmaDir;
        await ipc.scanAnimations(defaults.vrmaDir);
        await ipc.writeConfig(config);
      }
    }
  }

  // 初始化渲染系統
  debugLog(`calling initializeApp, vrmPath=${config.vrmModelPath?.substring(0, 50)}`);
  await initializeApp(config, appPath);
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
async function initializeApp(config: AppConfig, appPath: string): Promise<void> {
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

  // 套用 MToon outline 開關（預設關閉，因正交相機下 MToon outline 會暴粗）
  vrmController.setMToonOutlineEnabled(config.mtoonOutlineEnabled);

  // 計算角色在 viewport 中的比例
  sceneManager.computeCharacterViewportRatio();

  // 設定縮放（全螢幕模式不需 setWindowSize）
  sceneManager.setScale(config.scale);

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

  // 載入系統動畫（統一「狀態→池」機制，詳見 /animation-guide.md）
  if (animationManager) {
    const sysVrmaDir = `${appPath}/${config.systemAssetsDir}/vrma`.replace(/\\/g, '/');
    await loadAllSystemAnimations(animationManager, vrmController, sysVrmaDir);
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
    await initializeBehaviorSystem(config, sceneManager, vrmController, animationManager, canvas);
  } catch (e) {
    console.warn('[main] v0.2 behavior system initialization failed, basic rendering continues:', e);
  }

  // ── 角色右鍵選單（測試用假資料） ──
  try {
    const characterMenu = new CharacterContextMenu();
    cleanupFns.push(() => characterMenu.dispose());
    debugLog('character context menu ready');
  } catch (e) {
    console.warn('[main] character context menu initialization failed:', e);
  }
}

/**
 * 初始化行為與互動系統
 *
 * 獨立函式，失敗時不影響基本渲染。
 */
async function initializeBehaviorSystem(
  config: AppConfig,
  sceneManager: SceneManager,
  vrmController: VRMController,
  animationManager: AnimationManager | null,
  canvas: HTMLCanvasElement,
): Promise<void> {
  // 螢幕資訊（多螢幕支援）
  let cachedDisplays: DisplayInfo[] = await ipc.getDisplayInfo();
  if (cachedDisplays.length > 0) {
    const initialIndex = Math.max(
      0,
      Math.min(config.currentDisplayIndex ?? 0, cachedDisplays.length - 1),
    );

    if (initialIndex !== 0) {
      await ipc.moveToDisplay(initialIndex);
    }

    // 告知 SceneManager 多螢幕資訊（會自動套用對應 display 的 workArea）
    sceneManager.setDisplays(cachedDisplays, initialIndex);

    // 角色初始位置：當前 display 的 workArea 中央
    const initialDisplay = cachedDisplays[initialIndex];
    const wa = initialDisplay.workArea ?? initialDisplay;
    const charBounds = sceneManager.getCharacterBounds();
    sceneManager.setCurrentPosition({
      x: wa.x + (wa.width - charBounds.width) / 2,
      y: wa.y + (wa.height - charBounds.height) / 2,
    });

    // ── 3D 深度遮擋系統 ──
    const windowMeshManager = new WindowMeshManager(
      sceneManager.getScene(),
      sceneManager.getPixelToWorld(),
      sceneManager.getScreenOrigin(),
      canvas.clientWidth || canvas.width,
      canvas.clientHeight || canvas.height,
    );
    sceneManager.setWindowMeshManager(windowMeshManager);

    // IPC 事件驅動：視窗佈局變化時同步 mesh
    cleanupFns.push(await ipc.onWindowLayoutChanged((rects) => {
      sceneManager.updateCachedWindowRects(rects);
      windowMeshManager.syncWindows(rects);
    }));

    // 啟動時取得初始視窗清單
    ipc.getWindowList().then((rects) => {
      sceneManager.updateCachedWindowRects(rects);
      windowMeshManager.syncWindows(rects);
    });
  }

  // StateMachine（moveSpeed 由 SceneManager 依 baseScale 動態推入）
  const stateMachine = new StateMachine();
  if (config.autonomousMovementPaused) {
    stateMachine.pause();
  }
  if (config.moveSpeedMultiplier && config.moveSpeedMultiplier !== 1.0) {
    stateMachine.setSpeedMultiplier(config.moveSpeedMultiplier);
  }
  sceneManager.setStateMachine(stateMachine);

  // BehaviorAnimationBridge
  // 注入 walk clip picked callback：每次切換 walk/hide 動畫時重新分析步伐，
  // 讓 StateMachine 的移動速度與該 clip 的實際步長同步。
  if (animationManager) {
    const onWalkClipPicked = (clip: THREE.AnimationClip): void => {
      const analysis = analyzeWalkAnimation(clip, vrmController);
      if (analysis) {
        sceneManager.setStepAnalysis(analysis.stepLength, analysis.worldSpeed);
      }
    };
    const bridge = new BehaviorAnimationBridge(
      animationManager,
      stateMachine,
      onWalkClipPicked,
    );
    sceneManager.setBehaviorAnimationBridge(bridge);
  }

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

  // ── P2 Agent 表演控制（LLM tool call → ExpressionManager / AnimationManager） ──
  if (animationManager) {
    const mascotDispatcher = new MascotActionDispatcher({
      expressionManager,
      animationManager,
    });
    mascotDispatcher.start();
  }

  // ── Debug Overlay ──
  const debugOverlay = new DebugOverlay();
  debugOverlay.setEnabled(true); // 預設開啟 debug mode
  sceneManager.setDebugOverlay(debugOverlay);
  sceneManager.setWindowListFetcher(() => ipc.getWindowList());

  // ── Hit-Test 滑鼠穿透 ──
  const hitTestManager = new HitTestManager(canvas, sceneManager.getRenderer(), {
    setIgnoreCursorEvents: (ignore) => ipc.setIgnoreCursorEvents(ignore),
  });
  // Debug panel 白名單：游標位於面板矩形內時強制不穿透，
  // 矩形外維持原本的 canvas alpha 判定（不影響下層視窗點擊）
  hitTestManager.setInteractiveRectProvider(() =>
    debugOverlay.isEnabled() ? debugOverlay.getPanelRect() : null,
  );

  // ── 互動系統 ──
  const dragHandler = new DragHandler(canvas, {
    getCharacterPosition: () => {
      const bounds = sceneManager.getCharacterBounds();
      return { x: bounds.x, y: bounds.y };
    },
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
    onDragEnd: (position, mouseScreen) => {
      sceneManager.setCurrentPosition(position);

      // 拖曳吸附：滑鼠指標 Y 在 platform ± 30px 內且 X 重疊 → sit
      const mouseY = mouseScreen.y;
      const mouseX = mouseScreen.x;
      const SNAP_DISTANCE = 30;
      let snapped = false;

      for (const platform of sceneManager.getPlatforms()) {
        if (Math.abs(mouseY - platform.screenY) <= SNAP_DISTANCE &&
            mouseX > platform.screenXMin &&
            mouseX < platform.screenXMax) {
          stateMachine.setSitPlatform(platform.id);
          if (platform.id.startsWith('window:')) {
            const hwnd = parseInt(platform.id.substring(7), 10);
            if (!isNaN(hwnd)) {
              const windowOffsetX = position.x - platform.screenXMin;
              stateMachine.setAttachedWindow(hwnd, windowOffsetX);
            }
          } else {
            stateMachine.clearAttachedWindow();
          }
          stateMachine.forceState('sit');
          snapped = true;
          break;
        }
      }

      if (!snapped) {
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
      currentMoveSpeed: stateMachine.getSpeedMultiplier(),
      isPaused: stateMachine.isPaused(),
      isAutoExpressionEnabled: expressionManager.isAutoEnabled(),
      isLoopEnabled: animationManager?.isLoopEnabled() ?? true,
      isDebugEnabled: debugOverlay.isEnabled(),
      currentExpression: expressionManager.getManualExpression(),
      displays: cachedDisplays.map((d, i) => ({
        index: i,
        label: `Display ${i + 1} (${d.width}x${d.height})`,
      })),
      isMToonOutlineEnabled: config.mtoonOutlineEnabled,
    };
    ipc.sendMenuData(menuData);
  };

  // 初始推送（讓托盤有動態選單資料）
  pushTrayMenuData();

  // ── Debug 移動（Ctrl+方向鍵） ──
  cleanupFns.push(await ipc.onDebugMove((direction) => {
    sceneManager.debugMove(direction);
  }));

  // ── 鍵盤打字偵測 ──
  cleanupFns.push(await ipc.onKeyboardTypingChanged((isTyping) => {
    sceneManager.setUserTyping(isTyping);
  }));

  // ── 系統托盤事件 ──
  cleanupFns.push(await ipc.onTrayAction((actionId) => {
    switch (actionId) {
      case 'toggle_debug':
        debugOverlay.setEnabled(!debugOverlay.isEnabled());
        sceneManager.updatePlatformMeshVisibility();
        break;
      case 'test_opendoor': {
        // 找第一個可見視窗，強制觸發 opendoor
        const bounds = sceneManager.getCharacterBounds();
        const dpr = window.devicePixelRatio || 1;
        const windows = sceneManager.getCachedWindowRects();
        const target = windows.find((w) => w.width / dpr > bounds.width);
        if (target) {
          stateMachine.enterOpendoor(target.hwnd);
        }
        break;
      }
      case 'test_enterdoor': {
        // 找第一個可見視窗，強制觸發 enterdoor
        const bounds = sceneManager.getCharacterBounds();
        const dpr = window.devicePixelRatio || 1;
        const windows = sceneManager.getCachedWindowRects();
        const target = windows.find((w) => w.width / dpr > bounds.width);
        if (target) {
          stateMachine.enterEnterdoor(target.hwnd);
        }
        break;
      }
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
      case 'toggle_mtoon_outline': {
        const v = !config.mtoonOutlineEnabled;
        vrmController.setMToonOutlineEnabled(v);
        config.mtoonOutlineEnabled = v;
        ipc.writeConfig(config);
        pushTrayMenuData();
        break;
      }
      case 'reset_camera':
        sceneManager.resetCamera();
        break;
      case 'reset_position':
        ipc.getDisplayInfo().then((displays) => {
          cachedDisplays = displays;
          const idx = sceneManager.getCurrentDisplayIndex();
          const d = displays[idx] ?? displays[0] ?? { x: 0, y: 0, width: screen.width, height: screen.height };
          const wb = d.workArea ?? d;
          const cb = sceneManager.getCharacterBounds();
          const cx = wb.x + (wb.width - cb.width) / 2;
          const cy = wb.y + (wb.height - cb.height) / 2;
          sceneManager.setCurrentPosition({ x: cx, y: cy });
        });
        break;
      case 'browse_models':
        ipc.openVrmPicker();
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
      case 'agent_toggle_bubble':
        void ipc.agentToggleBubble();
        break;
      case 'agent_reconnect':
        void ipc.agentReconnect();
        break;
      default:
        // Dynamic action: move speed
        if (actionId.startsWith('move_speed_')) {
          const val = parseInt(actionId.slice('move_speed_'.length), 10) / 100;
          stateMachine.setSpeedMultiplier(val);
          config.moveSpeedMultiplier = val;
          ipc.writeConfig(config);
        }
        // Dynamic action: play animation
        else if (actionId.startsWith('play_anim::')) {
          const fileName = actionId.slice('play_anim::'.length);
          animationManager?.playByName(fileName);
        }
        // Dynamic action: set expression
        // 注意：只透過 ExpressionManager 設定，由 render loop 套用過渡（0.5s 線性 fade）
        // 不可直接呼叫 vrmController.setBlendShape，否則會繞過過渡並違反模組邊界
        else if (actionId.startsWith('set_expr::')) {
          const name = actionId.slice('set_expr::'.length);
          expressionManager.setManualExpression(name);
        }
        // Dynamic action: switch display
        else if (actionId.startsWith('switch_display_')) {
          const idx = parseInt(actionId.slice('switch_display_'.length), 10);
          (async () => {
            await ipc.moveToDisplay(idx);
            cachedDisplays = await ipc.getDisplayInfo();
            sceneManager.setDisplays(cachedDisplays, idx);
            // 重置角色到目標螢幕 workArea 中央
            const d = cachedDisplays[idx];
            if (d) {
              const wa = d.workArea ?? d;
              const cb = sceneManager.getCharacterBounds();
              sceneManager.setCurrentPosition({
                x: wa.x + (wa.width - cb.width) / 2,
                y: wa.y + (wa.height - cb.height) / 2,
              });
            }
            config.currentDisplayIndex = idx;
            ipc.writeConfig(config);
            pushTrayMenuData();
          })();
        }
        break;
    }
    // 每次動作後更新托盤選單狀態
    pushTrayMenuData();
  }));

  // 清理函式
  window.addEventListener('beforeunload', () => {
    hitTestManager.dispose();
    dragHandler.dispose();
    cleanupFns.forEach((fn) => fn?.());
    debugOverlay.dispose();
    sceneManager.dispose();
  });
}

// ── System Assets ──

/**
 * 解析系統預設資產目錄，回傳第一個 VRM 路徑和 VRMA 資料夾路徑
 */
async function resolveSystemAssets(
  appPath: string,
  systemAssetsDir: string,
): Promise<{ vrmPath: string | null; vrmaDir: string | null }> {
  const base = `${appPath}/${systemAssetsDir}`.replace(/\\/g, '/');
  const vrmDir = `${base}/vrm`;
  const vrmaDir = `${base}/vrma`;

  // 掃描 VRM 目錄，取第一個 .vrm 作為預設模型
  const vrmFiles = await ipc.scanVrmFiles(vrmDir);
  const vrmPath = vrmFiles.length > 0 ? vrmFiles[0] : null;
  debugLog(`System VRM: ${vrmPath ?? 'none'}`);

  // VRMA 目錄直接回傳路徑（由 scanAnimations 掃描 .vrma）
  debugLog(`System VRMA dir: ${vrmaDir}`);

  return { vrmPath, vrmaDir };
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

/**
 * 統一掃描並載入 `assets/system/vrma/` 所有系統動畫
 *
 * 流程：
 *   1. 一次性掃描資料夾取得所有 .vrma 檔案清單
 *   2. 對每個 SystemAnimationState（idle/sit/walk/drag/peek/fall/hide）：
 *      - 用 regex 過濾符合 `SYS_{PREFIX}_NN.vrma` 的檔案
 *      - 逐一載入為 Three.js AnimationClip
 *      - 透過 `animationManager.setStatePool(state, clips)` 注入
 *   3. peek 池載入後做 runtime mirror 產生左側池（setPeekLeftClips）
 *
 * 檔名規範與加入新動畫的方法詳見 `/animation-guide.md`。
 */
async function loadAllSystemAnimations(
  animationManager: AnimationManager,
  vrmController: VRMController,
  sysVrmaDir: string,
): Promise<void> {
  let allVrma: string[];
  try {
    allVrma = await ipc.scanVrmaFiles(sysVrmaDir);
  } catch (e) {
    console.warn('[main] scanVrmaFiles failed, system animations disabled:', e);
    return;
  }

  // 每個狀態各自載入成池
  for (const state of SYSTEM_ANIMATION_STATES) {
    // enterdoor 不從檔案載入，由 opendoor pool 運行時反向生成（見下方）
    if (state === 'enterdoor') continue;

    const files = filterFilesByState(allVrma, state);
    if (files.length === 0) {
      console.warn(`[main] no SYS_${state.toUpperCase()}_*.vrma found; '${state}' state has no animation`);
      continue;
    }

    const clips: LoadedPoolClip[] = [];
    for (const filePath of files) {
      const url = ipc.convertToAssetUrl(filePath);
      try {
        // opendoor 動畫需要保留 hip Z（角色穿門移動）
        const clip = await vrmController.loadVRMAnimation(url, state === 'opendoor' ? { keepHipZ: true } : undefined);
        if (clip) {
          clips.push({ fileName: extractBasename(filePath), clip });
        }
      } catch (e) {
        console.warn(`[main] failed to load ${filePath}:`, e);
      }
    }

    if (clips.length > 0) {
      animationManager.setStatePool(state, clips);
    }
  }

  // peek 池的 runtime mirror（special case）
  const peekPool = animationManager.getStatePool('peek');
  if (peekPool && peekPool.length > 0) {
    const boneMapping = vrmController.getHumanoidBoneMapping();
    if (boneMapping) {
      const peekLeftClips: LoadedPoolClip[] = peekPool.map(({ fileName, clip }) => ({
        fileName: fileName.replace(/\.vrma$/i, '_mirrored.vrma'),
        clip: mirrorAnimationClip(clip, boneMapping),
      }));
      animationManager.setPeekLeftClips(peekLeftClips);
    } else {
      console.warn('[main] peek mirror skipped: humanoid bone mapping unavailable');
    }
  }

  // enterdoor 池由 opendoor 池運行時 Y 軸 180° 旋轉生成（不需獨立 .vrma 檔）
  const opendoorPool = animationManager.getStatePool('opendoor');
  if (opendoorPool && opendoorPool.length > 0) {
    const boneMapping = vrmController.getHumanoidBoneMapping();
    if (boneMapping) {
      const enterdoorClips: LoadedPoolClip[] = opendoorPool.map(({ fileName, clip }) => ({
        fileName: fileName.replace(/\.vrma$/i, '_reversed.vrma'),
        clip: reverseAnimationClipForEnterdoor(clip, boneMapping),
      }));
      animationManager.setStatePool('enterdoor', enterdoorClips);
    } else {
      console.warn('[main] enterdoor reverse skipped: humanoid bone mapping unavailable');
    }
  } else {
    console.warn('[main] enterdoor pool empty: no opendoor clips to reverse');
  }
}

// 啟動
main().catch((e) => {
  debugLog(`FATAL: ${e}`);
  console.error('[main] Unhandled error:', e);
});
