/**
 * 影片動作轉換器 — 入口邏輯（Phase 1 骨架）
 *
 * 本檔在 Phase 1 只負責：
 *   - DOM bootstrap
 *   - 顯示「視窗已開啟」狀態
 *   - 預留 ConverterApp 初始化點（後續 Phase 接上）
 *
 * 後續 Phase：
 *   - Phase 7：MediaPipe Runner
 *   - Phase 8：左窗格 video + skeleton overlay
 *   - Phase 9：右窗格 VRM 預覽
 *   - Phase 10：Stage 1 即時擷取 pipeline
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element: #${id}`);
  return el as T;
};

function bootstrap(): void {
  const status = $<HTMLDivElement>('vc-status');
  status.textContent = 'Phase 1 — 視窗骨架已就緒';

  // Phase 1 階段所有按鈕保持 disabled（後續 Phase 解鎖）
  // 預覽容器顯示佔位文字
  const videoPlaceholder = $<HTMLDivElement>('vc-video-placeholder');
  const previewPlaceholder = $<HTMLDivElement>('vc-preview-placeholder');

  videoPlaceholder.style.display = 'flex';
  previewPlaceholder.style.display = 'flex';

  console.log('[VC] video-converter window bootstrapped (Phase 1 scaffold)');
}

window.addEventListener('DOMContentLoaded', bootstrap);
