/**
 * 影片動捕工作站 — 應用狀態機
 *
 * Phase 0：
 *   - 建立 PreviewPanel 並載入主視窗當前的 VRM
 *   - 管理生命週期與 dispose
 *   - TopBar / VideoPanel / Timeline 於後續 phase 實作
 *
 * 後續 phase 將擴充：
 *   - Phase 1：VideoPanel + Timeline
 *   - Phase 2：static SMPL fixture → smplToVrm → scrub preview
 *   - Phase 3：VRMA exporter
 *   - Phase 4+：engines（EasyMocap sidecar / HybrIK-TS）
 */

import { ipc } from '../bridge/ElectronIPC';
import { PreviewPanel } from './PreviewPanel';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[MocapStudioApp] Missing element: #${id}`);
  return el as T;
};

export class MocapStudioApp {
  private previewPanel: PreviewPanel | null = null;
  private disposed = false;

  async init(): Promise<void> {
    const canvas = $<HTMLCanvasElement>('mocap-preview-canvas');
    const previewHint = $<HTMLDivElement>('mocap-preview-hint');
    const statusEl = $<HTMLSpanElement>('mocap-status');

    this.previewPanel = new PreviewPanel(canvas);

    // 取得主視窗當前的 VRM 模型路徑
    statusEl.textContent = '載入主視窗 VRM 模型中...';
    const vrmPath = await ipc.getCurrentVrmPath();

    if (!vrmPath) {
      previewHint.classList.remove('hidden');
      previewHint.textContent = '主視窗尚未選擇 VRM 模型';
      statusEl.textContent = '就緒（無 VRM）';
      return;
    }

    const url = ipc.convertToAssetUrl(vrmPath);
    const ok = await this.previewPanel.loadModel(url);
    if (this.disposed) return;

    if (ok) {
      previewHint.classList.add('hidden');
      statusEl.textContent = `已載入：${this.basename(vrmPath)}`;
    } else {
      previewHint.classList.remove('hidden');
      previewHint.textContent = 'VRM 載入失敗';
      statusEl.textContent = '載入失敗';
    }
  }

  private basename(p: string): string {
    const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return idx >= 0 ? p.slice(idx + 1) : p;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.previewPanel) {
      this.previewPanel.dispose();
      this.previewPanel = null;
    }
  }
}
