/**
 * VRM 模型瀏覽對話框 — 入口邏輯
 *
 * 啟動流程：
 *   1. 讀取 config.json 取得當前 vrmPickerFolder（或從 vrmModelPath 推導）
 *   2. 取得 appPath 並構造系統 vrma 資料夾路徑
 *   3. 掃描資料夾的 .vrm 檔案
 *   4. 初始化 PreviewScene
 *   5. 綁定 UI 事件（檔案點擊、選資料夾、套用、取消）
 */

import { ipc } from '../bridge/ElectronIPC';
import type { AppConfig } from '../types/config';
import type { VrmFileEntry, ModelInfo, FeatureSupport } from '../types/vrmPicker';
import { PreviewScene } from './PreviewScene';
import { deriveDefaultPickerFolder, buildVrmFileEntries } from './pickerLogic';

interface PickerState {
  config: AppConfig | null;
  currentFolder: string | null;
  files: VrmFileEntry[];
  selectedPath: string | null;
  /** 系統內建 vrma 資料夾完整路徑（appPath + systemAssetsDir + '/vrma'） */
  sysVrmaDir: string;
}

const state: PickerState = {
  config: null,
  currentFolder: null,
  files: [],
  selectedPath: null,
  sysVrmaDir: '',
};

let previewScene: PreviewScene | null = null;

// ── DOM 元素 ──
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

async function init(): Promise<void> {
  const folderPathEl = $<HTMLSpanElement>('picker-folder-path');
  const folderBtn = $<HTMLButtonElement>('picker-folder-btn');
  const fileListEl = $<HTMLUListElement>('picker-file-list');
  const emptyHintEl = $<HTMLDivElement>('picker-empty-hint');
  const previewHintEl = $<HTMLDivElement>('picker-preview-hint');
  const applyBtn = $<HTMLButtonElement>('picker-apply-btn');
  const cancelBtn = $<HTMLButtonElement>('picker-cancel-btn');
  const statusEl = $<HTMLDivElement>('picker-status');
  const canvas = $<HTMLCanvasElement>('picker-preview-canvas');
  const infoOverlay = $<HTMLDivElement>('picker-model-info-overlay');
  const infoName = $<HTMLSpanElement>('info-name');
  const infoVersion = $<HTMLSpanElement>('info-version');
  const infoClothes = $<HTMLSpanElement>('info-clothes');
  const infoUndress = $<HTMLSpanElement>('info-undress');
  const infoExprCount = $<HTMLSpanElement>('info-expr-count');
  const infoExprList = $<HTMLUListElement>('info-expr-list');
  const animPane = $<HTMLDivElement>('picker-anim-pane');
  const animList = $<HTMLUListElement>('picker-anim-list');
  const animEmpty = $<HTMLDivElement>('picker-anim-empty');
  const controlsOverlay = $<HTMLDivElement>('picker-preview-controls-overlay');
  const undressRow = $<HTMLDivElement>('control-undress-row');
  const undressToggle = $<HTMLInputElement>('control-undress-toggle');
  const expressionRow = $<HTMLDivElement>('control-expression-row');
  const expressionSelect = $<HTMLSelectElement>('control-expression-select');

  // 1. 讀取 config
  const config = await ipc.readConfig();
  state.config = config;

  // 2. 推導預設資料夾
  state.currentFolder = deriveDefaultPickerFolder(config);

  // 3. 構造系統 vrma 資料夾路徑（用於 SYS_IDLE 連續播放）
  const appPath = await ipc.getAppPath();
  const systemAssetsDir = config?.systemAssetsDir ?? 'assets/system';
  state.sysVrmaDir = `${appPath}/${systemAssetsDir}/vrma`.replace(/\\/g, '/');

  // 4. 初始化 PreviewScene
  previewScene = new PreviewScene(canvas);
  previewScene.setModelInfoCallback(renderModelInfo);

  // 控制 overlay 事件綁定
  undressToggle.addEventListener('change', () => {
    previewScene?.setUndressed(undressToggle.checked);
  });
  expressionSelect.addEventListener('change', () => {
    const value = expressionSelect.value;
    previewScene?.setPreviewExpression(value === '' ? null : value);
  });

  // 5. 載入檔案清單
  await refreshFileList();

  // ── 事件綁定 ──
  folderBtn.addEventListener('click', async () => {
    const picked = await ipc.pickVrmFolder(state.currentFolder ?? undefined);
    if (!picked) return;
    state.currentFolder = picked;
    // 寫回 config
    if (state.config) {
      state.config.vrmPickerFolder = picked;
      await ipc.writeConfig(state.config);
    }
    await refreshFileList();
  });

  cancelBtn.addEventListener('click', () => {
    closeWindow();
  });

  applyBtn.addEventListener('click', async () => {
    if (!state.selectedPath) return;
    applyBtn.disabled = true;
    statusEl.textContent = '套用中...';
    await ipc.applyVrmModel(state.selectedPath);
    // applyVrmModel 內部會關閉 picker，這裡通常已經銷毀
  });

  /** 將 FeatureSupport 三態值轉為顯示文字 */
  function featureLabel(v: FeatureSupport): string {
    if (v === 'yes') return '是';
    if (v === 'no') return '否';
    return '不確定';
  }

  /** 將 VRM 規格版本轉為顯示文字 */
  function versionLabel(v: ModelInfo['vrmVersion']): string {
    if (v === '1.0') return 'VRM 1.0';
    if (v === '0.x') return 'VRM 0.x';
    return '未知';
  }

  /** 套用三態的色彩 class（value-yes / value-no / value-maybe） */
  function applyValueClass(el: HTMLElement, v: FeatureSupport): void {
    el.classList.remove('value-yes', 'value-no', 'value-maybe');
    el.classList.add(`value-${v}`);
  }

  /** 重置控制 overlay：隱藏並把 toggle / select 復位 */
  function resetControlsOverlay(): void {
    controlsOverlay.classList.add('hidden');
    undressRow.classList.add('hidden');
    expressionRow.classList.add('hidden');
    undressToggle.checked = false;
    // 重建 select 選項：保留唯一的「（無）」
    expressionSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '（無）';
    expressionSelect.appendChild(defaultOpt);
    expressionSelect.value = '';
  }

  /** PreviewScene 模型載入完成後呼叫，更新 overlay 顯示 */
  function renderModelInfo(info: ModelInfo | null): void {
    if (!info) {
      infoOverlay.classList.add('hidden');
      resetControlsOverlay();
      return;
    }
    infoOverlay.classList.remove('hidden');
    infoName.textContent = info.name || '（未命名）';
    infoVersion.textContent = versionLabel(info.vrmVersion);

    infoClothes.textContent = featureLabel(info.canChangeClothes);
    applyValueClass(infoClothes, info.canChangeClothes);

    infoUndress.textContent = featureLabel(info.canUndress);
    applyValueClass(infoUndress, info.canUndress);

    infoExprCount.textContent = String(info.expressions.length);
    infoExprList.innerHTML = '';
    for (const name of info.expressions) {
      const li = document.createElement('li');
      li.textContent = name;
      infoExprList.appendChild(li);
    }

    // 同步更新右上控制 overlay
    resetControlsOverlay();
    const showUndress = info.canUndress === 'yes' || info.canUndress === 'maybe';
    const showExpression = info.expressions.length > 0;

    if (showUndress) {
      undressRow.classList.remove('hidden');
    }
    if (showExpression) {
      expressionRow.classList.remove('hidden');
      for (const name of info.expressions) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        expressionSelect.appendChild(opt);
      }
    }
    if (showUndress || showExpression) {
      controlsOverlay.classList.remove('hidden');
    }
  }

  // 提供給 refreshFileList 使用的 UI 函式
  function renderFileList(): void {
    fileListEl.innerHTML = '';
    folderPathEl.textContent = state.currentFolder ?? '（尚未選擇）';

    if (state.files.length === 0) {
      emptyHintEl.classList.remove('hidden');
      previewHintEl.classList.remove('hidden');
      previewHintEl.textContent = state.currentFolder
        ? '資料夾中沒有 .vrm 檔案'
        : '請先選擇資料夾';
      return;
    }
    emptyHintEl.classList.add('hidden');

    for (const entry of state.files) {
      const li = document.createElement('li');
      li.className = 'picker-file-item';
      li.textContent = entry.displayName;
      li.dataset.path = entry.fullPath;
      li.addEventListener('click', () => selectFile(entry));
      fileListEl.appendChild(li);
    }
  }

  async function refreshFileList(): Promise<void> {
    if (!state.currentFolder) {
      state.files = [];
      state.selectedPath = null;
      applyBtn.disabled = true;
      renderFileList();
      return;
    }

    const paths = await ipc.scanVrmFiles(state.currentFolder);
    state.files = buildVrmFileEntries(paths);
    state.selectedPath = null;
    applyBtn.disabled = true;
    renderFileList();
  }

  async function selectFile(entry: VrmFileEntry): Promise<void> {
    state.selectedPath = entry.fullPath;
    applyBtn.disabled = false;
    statusEl.textContent = `已選擇：${entry.displayName}`;
    previewHintEl.classList.add('hidden');

    // 高亮選中項
    fileListEl.querySelectorAll('.picker-file-item').forEach((el) => {
      const isSelected = (el as HTMLElement).dataset.path === entry.fullPath;
      el.classList.toggle('selected', isSelected);
    });

    if (previewScene) {
      await previewScene.loadModel(entry.fullPath, state.sysVrmaDir);
      renderAnimList();
    }
  }

  /** 渲染 SYS 動畫清單（模型載入後呼叫） */
  function renderAnimList(): void {
    animList.innerHTML = '';
    const files = previewScene?.getAllSysFiles() ?? [];

    if (files.length === 0) {
      animPane.classList.add('hidden');
      return;
    }

    animPane.classList.remove('hidden');
    animEmpty.classList.add('hidden');

    for (const filePath of files) {
      const fileName = filePath.replace(/\\/g, '/').split('/').pop() ?? filePath;
      const displayName = fileName.replace(/\.vrma$/i, '');
      const li = document.createElement('li');
      li.className = 'picker-anim-item';
      li.textContent = displayName;
      li.dataset.path = filePath;
      li.addEventListener('click', () => selectAnim(li, filePath));
      animList.appendChild(li);
    }
  }

  /** 選取動畫項目 → 循環播放；再點同一個 → 取消選取恢復 idle */
  async function selectAnim(li: HTMLLIElement, filePath: string): Promise<void> {
    const wasSelected = li.classList.contains('selected');

    // 取消所有選取
    animList.querySelectorAll('.picker-anim-item').forEach((el) => {
      el.classList.remove('selected');
    });

    if (wasSelected) {
      // 再點同一個 → 恢復 idle
      await previewScene?.resumeIdleLoop();
    } else {
      li.classList.add('selected');
      await previewScene?.playSpecificAnimation(filePath);
    }
  }
}

function closeWindow(): void {
  if (previewScene) {
    previewScene.dispose();
    previewScene = null;
  }
  // picker 視窗自身的 close（透過 window.close）
  window.close();
}

// 釋放資源
window.addEventListener('beforeunload', () => {
  if (previewScene) {
    previewScene.dispose();
    previewScene = null;
  }
});

// 啟動
init().catch((e) => {
  console.error('[VRM Picker] init failed:', e);
});
