/**
 * 平台偵測與統一匯出
 *
 * 所有平台相關的判斷與設定集中在 electron/platform/ 資料夾中，
 * 主程式碼透過此模組取用，避免散落的 process.platform 判斷。
 */

/** 當前平台是否為 Windows */
export const isWindows = process.platform === 'win32';

/** 當前平台是否為 macOS */
export const isMac = process.platform === 'darwin';

export { getWindowOptions, applyPostCreateSetup, getPickerWindowOptions } from './windowConfig.js';
export { resolveLocalFilePath } from './protocolHelper.js';
export { enumerateWindowsMac } from './macWindowMonitor.js';
export {
  getAgentHome,
  getDaemonPidFilePath,
  getDaemonTokenFilePath,
  resolveBunBinary,
  resolveMyAgentCli,
  getDefaultAgentWorkspace,
  ensureAgentWorkspace,
  getAgentDaemonLogPath,
} from './agentPaths.js';
