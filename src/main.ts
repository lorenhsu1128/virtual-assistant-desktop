import { ipc } from './bridge/TauriIPC';
import { SceneManager } from './core/SceneManager';
import { VRMController } from './core/VRMController';
import { AnimationManager } from './animation/AnimationManager';
import { FallbackAnimation } from './animation/FallbackAnimation';
import { DEFAULT_CONFIG, type AppConfig } from './types/config';

/**
 * 應用程式進入點
 *
 * 流程：
 * 1. 檢測是否首次啟動
 * 2. 首次啟動 → 引導使用者選擇 VRM + 動畫資料夾
 * 3. 非首次啟動 → 直接讀取設定
 * 4. 載入模型 → 初始化動畫系統 → 啟動 render loop
 */
async function main(): Promise<void> {
  const configExists = await ipc.getConfigExists();

  let config: AppConfig;

  if (!configExists) {
    // 首次啟動流程
    const result = await runFirstRunWizard();
    if (!result) return; // 使用者中途放棄
    config = result;
  } else {
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
  await initializeApp(config);
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
 * 建立 SceneManager → VRMController → AnimationManager → 啟動 render loop
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
    await vrmController.loadModel(modelUrl);
  } catch (e) {
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

  // 設定縮放
  sceneManager.setScale(config.scale);

  // 初始化 FallbackAnimation
  const fallbackAnimation = new FallbackAnimation(vrmController);
  sceneManager.setFallbackAnimation(fallbackAnimation);

  // 初始化動畫系統
  const mixer = vrmController.getAnimationMixer();
  if (mixer) {
    const animationLoader = (filePath: string) => {
      const assetUrl = ipc.convertToAssetUrl(filePath);
      return vrmController.loadVRMAnimation(assetUrl);
    };
    const animationManager = new AnimationManager(mixer, animationLoader);
    sceneManager.setAnimationManager(animationManager);

    // 載入動畫
    if (config.animationFolderPath) {
      const meta = await ipc.readAnimationMeta();
      if (meta && meta.entries.length > 0) {
        await animationManager.loadAnimations(meta.entries, config.animationFolderPath);

        // 有任何動畫 → 用 AnimationManager（idle 輪播會自動 fallback 到全部動畫）
        // 完全無動畫 → 用 fallback 呼吸/眨眼
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

  // 啟動 render loop
  sceneManager.start();
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
main().catch((e) => console.error('[main] Unhandled error:', e));
