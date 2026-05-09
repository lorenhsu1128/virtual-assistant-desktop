/**
 * Agent 相關 IPC handler 註冊。
 *
 * 三層守則（LESSONS.md 2026-04-03）：
 * - 此處：ipcMain.handle()
 * - electron/preload.ts：contextBridge 暴露
 * - src/bridge/ElectronIPC.ts：renderer 端 typed wrapper + fallback
 */

import { BrowserWindow, ipcMain } from 'electron';
import type { AgentDaemonManager, AgentDaemonInfo } from './AgentDaemonManager.js';
import type { InboundFrame } from './AgentSessionClient.js';
import { toggleAgentBubbleWindow } from './agentBubbleWindow.js';

/** 註冊 agent 相關 ipcMain handler，並把 daemon 事件中繼到 renderer */
export function registerAgentIpcHandlers(
  mainWindow: BrowserWindow,
  daemon: AgentDaemonManager,
): void {
  // ── Commands（renderer → main） ──

  ipcMain.handle('agent_get_status', (): AgentDaemonInfo => {
    return daemon.getInfo();
  });

  ipcMain.handle('agent_send_input', (_event, text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false;
    return daemon.sendInput(text);
  });

  ipcMain.handle('agent_toggle_bubble', () => {
    toggleAgentBubbleWindow(mainWindow);
  });

  ipcMain.handle('agent_reconnect', async () => {
    await daemon.stop();
    await daemon.start();
  });

  // ── Events（main → renderer） ──

  daemon.on('status', (info: AgentDaemonInfo) => {
    broadcast(mainWindow, 'agent_status', info);
  });

  daemon.on('session_open', () => {
    broadcast(mainWindow, 'agent_session_open', null);
  });

  daemon.on('session_close', (info: { code: number; reason: string }) => {
    broadcast(mainWindow, 'agent_session_close', info);
  });

  daemon.on('session_frame', (frame: InboundFrame) => {
    broadcast(mainWindow, 'agent_session_frame', frame);
  });
}

function broadcast(mainWindow: BrowserWindow, channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
  // mainWindow 引數保留：若某情境需要只送主視窗，再另開 helper
  void mainWindow;
}
