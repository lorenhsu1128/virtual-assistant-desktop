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
import { DebugOverlay } from './debug/DebugOverlay';
import { analyzeWalkAnimation } from './animation/StepAnalyzer';
import { mirrorAnimationClip } from './animation/AnimationMirror';
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

  // 載入系統動畫
  if (animationManager) {
    const sysVrmaDir = `${appPath}/${config.systemAssetsDir}/vrma`.replace(/\\/g, '/');
    await animationManager.loadSystemAnimation(
      'drag',
      `${sysVrmaDir}/SYS_DRAGGING.vrma`,
    );
    await animationManager.loadSystemAnimation(
      'walk',
      `${sysVrmaDir}/SYS_WALK.vrma`,
    );

    // 載入多個 sit 動畫（SYS_SIT_01 ~ SYS_SIT_07）
    for (let i = 1; i <= 7; i++) {
      const sitName = `sit_${String(i).padStart(2, '0')}`;
      const sitFile = `SYS_SIT_${String(i).padStart(2, '0')}.vrma`;
      await animationManager.loadSystemAnimation(sitName, `${sysVrmaDir}/${sitFile}`);
    }
    // 載入 peek 動畫（右探頭讀檔）+ runtime mirror 產生左探頭
    await animationManager.loadSystemAnimation(
      'hide_show_loop_right',
      `${sysVrmaDir}/SYS_HIDE_SHOW_LOOP_RIGHT.vrma`,
    );
    const rightPeekClip = animationManager.getSystemAnimationClip('hide_show_loop_right');
    const boneMapping = vrmController.getHumanoidBoneMapping();
    if (rightPeekClip && boneMapping) {
      const leftPeekClip = mirrorAnimationClip(rightPeekClip, boneMapping);
      animationManager.registerSystemAnimationClip('hide_show_loop_left', leftPeekClip);
      debugLog('System animations loaded (drag, walk, sit_01~07, hide_show_loop_right + mirrored left)');
    } else {
      // Fallback：mirror 失敗時載入預製檔案
      await animationManager.loadSystemAnimation(
        'hide_show_loop_left',
        `${sysVrmaDir}/SYS_HIDE_SHOW_LOOP_LEFT.vrma`,
      );
      debugLog('System animations loaded (drag, walk, sit_01~07, hide_show_loop_left/right from files)');
    }

    // 步伐分析：從行走動畫計算擬真移動速度
    const walkClip = animationManager.getSystemAnimationClip('walk');
    if (walkClip) {
      const analysis = analyzeWalkAnimation(walkClip, vrmController);
      if (analysis) {
        // 傳 worldSpeed（世界單位/秒）給 SceneManager，
        // 由它根據當前 baseScale 動態計算 px/sec 並推入 StateMachine
        sceneManager.setStepAnalysis(analysis.stepLength, analysis.worldSpeed);
        debugLog(`Walk step analysis: stepLen=${analysis.stepLength.toFixed(3)} cycle=${analysis.cycleDuration.toFixed(2)}s steps=${analysis.stepsPerCycle} worldSpeed=${analysis.worldSpeed.toFixed(3)}`);
      }
    }
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
  if (animationManager) {
    const bridge = new BehaviorAnimationBridge(animationManager, stateMachine);
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
    };
    ipc.sendMenuData(menuData);
  };

  // 初始推送（讓托盤有動態選單資料）
  pushTrayMenuData();

  // ── Debug 移動（Ctrl+方向鍵） ──
  cleanupFns.push(await ipc.onDebugMove((direction) => {
    sceneManager.debugMove(direction);
  }));

  // ── 系統托盤事件 ──
  cleanupFns.push(await ipc.onTrayAction((actionId) => {
    switch (actionId) {
      case 'toggle_debug':
        debugOverlay.setEnabled(!debugOverlay.isEnabled());
        sceneManager.updatePlatformMeshVisibility();
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
      case 'change_model':
        ipc.pickVrmFile().then(async (p) => {
          if (!p) return;
          config.vrmModelPath = p;
          await ipc.writeConfig(config);
          window.location.reload();
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
      case 'cinematic_run':
        sceneManager.startCinematic();
        break;
      case 'settings':
        // TODO: 開啟設定視窗
        console.log('[main] Settings window not yet implemented');
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

// 啟動
main().catch((e) => {
  debugLog(`FATAL: ${e}`);
  console.error('[main] Unhandled error:', e);
});
