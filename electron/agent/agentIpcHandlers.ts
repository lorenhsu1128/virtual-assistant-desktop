/**
 * Agent 相關 IPC handler 註冊（M-MASCOT-EMBED Phase 5：接 AgentRuntime）。
 *
 * 三層守則（LESSONS.md 2026-04-03）：
 * - 此處：ipcMain.handle()
 * - electron/preload.ts：contextBridge 暴露
 * - src/bridge/ElectronIPC.ts：renderer 端 typed wrapper + fallback
 *
 * 新增 IPC（Phase 5）：
 * - `agent_enable` / `agent_disable` — master toggle
 * - `agent_reload_llm` — disable + enable（LLM 設定變更）
 * - `agent_abort` — 中斷當前 turn
 * - Event `llm_status_changed` — AgentRuntimeStatus 變化即時推送
 *
 * 沿用 IPC（行為映射改變但 channel name 不變，讓 renderer 端零改動）：
 * - `agent_get_status` — 回傳 AgentRuntimeStatus（不再是 AgentDaemonInfo）
 * - `agent_send_input` — 改 forward 到 AgentRuntime.send()
 * - `agent_toggle_bubble` — 完全不變
 * - `agent_apply_config` — 寫 config + reload LLM
 * - Event `agent_session_frame` — frame schema 完全相同（與 daemon WS NDJSON 一致）
 */

import { BrowserWindow, ipcMain } from 'electron';
import type { AgentRuntime, AgentRuntimeStatus } from './AgentRuntime.js';
import type { Frame } from '../../vendor/my-agent/dist-embedded/index.js';
import { toggleAgentBubbleWindow } from './agentBubbleWindow.js';
import { readConfig, writeConfig, type AgentConfig } from '../fileManager.js';

/** 註冊 agent 相關 ipcMain handler，並把 runtime 事件中繼到 renderer */
export function registerAgentIpcHandlers(
  mainWindow: BrowserWindow,
  runtime: AgentRuntime,
): void {
  // ── Commands（renderer → main） ──

  /**
   * 既有 IPC：回傳向後相容的 daemon-style info（renderer side P3 UI 仍依賴）。
   * 新 P5 + UI 應呼叫 `agent_get_runtime_status` 取得精確 state machine 資訊。
   */
  ipcMain.handle('agent_get_status', () => {
    return runtime.getInfo();
  });

  ipcMain.handle('agent_get_runtime_status', (): AgentRuntimeStatus => {
    return runtime.getStatus();
  });

  /**
   * 啟用 agent — 載入 LLM 並進入 standby（master toggle ON）。
   * 讀當前 config，並寫回 enabled = true。
   */
  ipcMain.handle('agent_enable', async (): Promise<AgentRuntimeStatus> => {
    const cfg = await readConfig();
    if (!cfg.agent) {
      return { state: 'error', message: 'agent config 不存在' };
    }
    if (!cfg.agent.enabled) {
      cfg.agent.enabled = true;
      await writeConfig(cfg);
    }
    return runtime.enable(cfg.agent);
  });

  /**
   * 停用 agent — 釋放 LLM 與所有資源（master toggle OFF）。
   */
  ipcMain.handle('agent_disable', async (): Promise<AgentRuntimeStatus> => {
    const cfg = await readConfig();
    if (cfg.agent?.enabled) {
      cfg.agent.enabled = false;
      await writeConfig(cfg);
    }
    return runtime.disable();
  });

  ipcMain.handle('agent_send_input', (_event, text: string): boolean => {
    if (typeof text !== 'string' || text.length === 0) return false;
    return runtime.send(text);
  });

  ipcMain.handle('agent_abort', (): void => {
    runtime.abort();
  });

  ipcMain.handle('agent_toggle_bubble', () => {
    toggleAgentBubbleWindow(mainWindow);
  });

  /**
   * 重新載入 LLM（disable + enable）— 設定變更後呼叫。
   */
  ipcMain.handle(
    'agent_reload_llm',
    async (): Promise<AgentRuntimeStatus> => {
      const cfg = await readConfig();
      if (!cfg.agent) {
        return { state: 'error', message: 'agent config 不存在' };
      }
      return runtime.reloadLlm(cfg.agent);
    },
  );

  /**
   * 套用新 agent config：寫 config.json 後 reload LLM。
   */
  ipcMain.handle(
    'agent_apply_config',
    async (_event, next: AgentConfig): Promise<AgentRuntimeStatus> => {
      const cfg = await readConfig();
      cfg.agent = next;
      await writeConfig(cfg);
      if (next.enabled) {
        return runtime.reloadLlm(next);
      }
      return runtime.disable();
    },
  );

  // ── Events（main → renderer） — frame 與 status 廣播 ──
  // AgentRuntime 內部已 `webContents.send(...)` 廣播到所有 BrowserWindow，
  // 這裡用 EventEmitter 訂閱主要用於除錯 / 將來監聽額外行為。

  runtime.on('status', (status: AgentRuntimeStatus) => {
    // AgentRuntime 已自行廣播 'llm_status_changed'，這邊只做 dev log
    void status;
  });

  runtime.on('frame', (frame: Frame) => {
    // AgentRuntime 已自行廣播 'agent_session_frame'
    void frame;
  });

  void mainWindow; // 預留：未來如需指定主視窗發送
}
