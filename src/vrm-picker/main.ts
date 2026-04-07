/**
 * VRM 模型瀏覽對話框 — 入口邏輯
 *
 * 啟動流程：
 *   1. 讀取 config.json 取得當前 vrmPickerFolder（或從 vrmModelPath 推導）
 *   2. 掃描資料夾的 .vrm 檔案
 *   3. 讀取 animations.json 篩出 idle 條目
 *   4. 初始化 PreviewScene
 *   5. 綁定 UI 事件（檔案點擊、選資料夾、套用、取消）
 */

import { ipc } from '../bridge/ElectronIPC';
import type { AppConfig } from '../types/config';
import type { AnimationEntry, AnimationMeta } from '../types/animation';
import type { VrmFileEntry } from '../types/vrmPicker';
import { PreviewScene } from './PreviewScene';
import { deriveDefaultPickerFolder, buildVrmFileEntries } from './pickerLogic';

interface PickerState {
  config: AppConfig | null;
  currentFolder: string | null;
  files: VrmFileEntry[];
  selectedPath: string | null;
  idleEntries: AnimationEntry[];
}

const state: PickerState = {
  config: null,
  currentFolder: null,
  files: [],
  selectedPath: null,
  idleEntries: [],
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

  // 1. 讀取 config
  const config = await ipc.readConfig();
  state.config = config;

  // 2. 推導預設資料夾
  state.currentFolder = deriveDefaultPickerFolder(config);

  // 3. 讀取 animations.json，篩出 idle 條目
  if (config?.animationFolderPath) {
    const meta = await ipc.readAnimationMeta();
    state.idleEntries = filterIdleEntries(meta);
  }

  // 4. 初始化 PreviewScene
  previewScene = new PreviewScene(canvas);

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
      await previewScene.loadModel(
        entry.fullPath,
        state.config?.animationFolderPath ?? null,
        state.idleEntries,
      );
    }
  }
}

function filterIdleEntries(meta: AnimationMeta | null): AnimationEntry[] {
  if (!meta) return [];
  return meta.entries.filter((e) => e.category === 'idle');
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
