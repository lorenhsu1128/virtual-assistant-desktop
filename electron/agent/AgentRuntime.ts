/**
 * AgentRuntime — 取代 AgentDaemonManager 的 in-process my-agent 整合
 * （M-MASCOT-EMBED Phase 5）。
 *
 * 變更：
 * - 不再 spawn `cli daemon` 子進程 / ws 連線 / HTTP MCP register
 * - 直接 `import { AgentEmbedded } from vendor/my-agent/dist-embedded/index.js`
 * - 在 Electron main process 內持有 AgentEmbedded + AgentSession 實例
 * - 把 session frame 透過 IPC `agent_session_frame` 廣播給 renderer（src-bubble）
 * - 4 個 mascot tool 在 AgentEmbedded.create 時注入為 extraTools，被 LLM 呼叫
 *   時直接 dispatch `mascot_action` IPC，不再經 HTTP MCP server
 *
 * 狀態機（disabled → preloading → standby → active → ...）：master toggle
 * ON 立即進入 preloading 載入 LLM，標準 5-30s 後進入 standby 待命。OFF 釋放
 * 所有 native handle（LlamaContext / LlamaModel / MCP / SQLite）。
 *
 * 失敗一律降級為 'error' 狀態，不 throw 也不 crash 桌寵主視窗渲染。
 *
 * @see vendor/my-agent/src/embedded/index.ts — AgentEmbedded library entry
 * @see src/agent/MascotActionDispatcher.ts — renderer 側 mascot_action 接收
 */
import { app, BrowserWindow } from 'electron';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  AgentEmbedded,
  type AgentSession,
  type Frame,
  type Tool,
  type PreloadProgress,
} from '../../vendor/my-agent/dist-embedded/index.js';

import type { AgentConfig } from '../fileManager.js';
import { buildMascotTools } from './mascotTools.js';
import type { MascotAction } from './MascotMcpServer.js';
import { ensureAgentWorkspace } from '../platform/index.js';

/**
 * AgentRuntime 狀態（給 renderer / 托盤顯示用）。
 *
 * 與舊 AgentDaemonStatus（'disabled' | 'starting' | 'connecting' | 'online' |
 * 'offline' | 'error'）不同，新增 preloading / standby / active / unloading 區分。
 */
export type AgentRuntimeStatus =
  | { state: 'disabled' }
  | {
      state: 'preloading';
      progress: number; // 0..1
      phase: PreloadProgress['phase'];
      message?: string;
    }
  | { state: 'standby' }
  | { state: 'active'; turnId: string }
  | { state: 'unloading' }
  | { state: 'error'; message: string };

const STATUS_DISABLED: AgentRuntimeStatus = { state: 'disabled' };

/**
 * AgentRuntime — 桌寵側對 AgentEmbedded 的 lifecycle wrapper。
 *
 * Events:
 * - `status`: AgentRuntimeStatus 變化
 * - `frame`: session 收到 frame（hello / state / turnStart / runnerEvent / turnEnd）
 * - `mascotAction`: LLM tool call 觸發的桌寵動作
 */
export class AgentRuntime extends EventEmitter {
  private agent: AgentEmbedded | null = null;
  private session: AgentSession | null = null;
  private status: AgentRuntimeStatus = STATUS_DISABLED;
  private inFlightTransition = false;
  private currentConfig: AgentConfig | null = null;

  getStatus(): AgentRuntimeStatus {
    return this.status;
  }

  /**
   * 向後相容的 daemon-style info（mapped from AgentRuntimeStatus）。
   * 給 src-settings/AgentPage.tsx 等 P3 既有 UI 用，逐步 P5b 之後改為直接讀
   * AgentRuntimeStatus。
   */
  getInfo(): {
    status: 'disabled' | 'starting' | 'connecting' | 'online' | 'offline' | 'error';
    port: number | null;
    token: string | null;
    pid: number | null;
    message?: string;
  } {
    const s = this.status;
    switch (s.state) {
      case 'disabled':
        return { status: 'disabled', port: null, token: null, pid: null };
      case 'preloading':
        return {
          status: 'starting',
          port: null,
          token: null,
          pid: null,
          message: `${s.phase} ${(s.progress * 100).toFixed(0)}%`,
        };
      case 'standby':
        return { status: 'online', port: null, token: null, pid: null };
      case 'active':
        return {
          status: 'online',
          port: null,
          token: null,
          pid: null,
          message: `turn ${s.turnId}`,
        };
      case 'unloading':
        return {
          status: 'connecting',
          port: null,
          token: null,
          pid: null,
          message: 'shutting down',
        };
      case 'error':
        return {
          status: 'error',
          port: null,
          token: null,
          pid: null,
          message: s.message,
        };
    }
  }

  getCurrentConfig(): AgentConfig | null {
    return this.currentConfig;
  }

  /**
   * Master toggle ON：載入 LLM、建立 session、進入 standby。
   *
   * 行為合約：
   * - 從 disabled / error 進入；其他狀態時直接 return（caller 應先 disable）
   * - inFlightTransition guard 防止快速 toggle 競態
   * - modelPath/externalUrl 都 null → 直接進 'error' 狀態，不嘗試 preload
   * - 任何錯誤 → cleanup 已分配資源 + 進 'error' 狀態
   */
  async enable(config: AgentConfig): Promise<AgentRuntimeStatus> {
    if (this.inFlightTransition) {
      console.warn('[AgentRuntime] enable() called while transition in flight; ignoring');
      return this.status;
    }
    if (this.status.state !== 'disabled' && this.status.state !== 'error') {
      // 已 standby/active/preloading/unloading — 不重複啟用
      return this.status;
    }

    if (!config.llm.modelPath && !config.llm.externalUrl) {
      this.setStatus({
        state: 'error',
        message: '未指定 GGUF 模型路徑或外部 LLM endpoint',
      });
      return this.status;
    }

    this.inFlightTransition = true;
    this.currentConfig = config;
    try {
      this.setStatus({
        state: 'preloading',
        progress: 0,
        phase: 'configDir',
        message: '初始化中',
      });

      const workspaceCwd = await ensureAgentWorkspace(config.workspaceCwd);
      const configDir = path.join(app.getPath('userData'), 'agent-config');

      // mascot tools — call 時透過此 callback 廣播 mascot_action IPC
      const mascotTools = buildMascotTools((action: MascotAction) => {
        this.dispatchMascotAction(action);
      });

      this.agent = await AgentEmbedded.create({
        cwd: workspaceCwd,
        configDir,
        // P5a 暫只支援 fetch mode（外部 llama.cpp HTTP server）；
        // embedded mode 需 AgentEmbedded 內部支援 modelPath 注入，
        // 目前 my-agent llamacpp-embedded-adapter 走 env var / config，
        // 後續 P5b 串接
        ...(config.llm.modelPath
          ? { /* embedded 模式：P5b 補完 LLM provider 注入 */ }
          : {}),
        extraTools: mascotTools as unknown as Tool[],
        skipMcp: false,
        onPreloadProgress: (p: PreloadProgress) => {
          this.setStatus({
            state: 'preloading',
            progress: p.progress,
            phase: p.phase,
            message: p.message,
          });
        },
      });

      // 建立 session — frame 直接廣播給 src-bubble
      this.session = this.agent.createSession({ source: 'mascot' });
      this.session.on('frame', (frame: Frame) => {
        this.broadcastFrame(frame);

        // 簡化的 active/standby 追蹤（細節 P5b 再補）
        if (frame.type === 'turnStart') {
          this.setStatus({ state: 'active', turnId: frame.inputId });
        } else if (frame.type === 'turnEnd') {
          this.setStatus({ state: 'standby' });
        }
      });
      this.session.on('error', (err: Error) => {
        console.warn('[AgentRuntime] session error:', err);
      });

      this.setStatus({ state: 'standby' });
      return this.status;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[AgentRuntime] enable failed:', msg);
      await this.cleanupOnError();
      this.setStatus({ state: 'error', message: msg });
      return this.status;
    } finally {
      this.inFlightTransition = false;
    }
  }

  /**
   * Master toggle OFF：完整釋放 LLM / session / MCP / DB。
   */
  async disable(): Promise<AgentRuntimeStatus> {
    if (this.inFlightTransition) {
      console.warn('[AgentRuntime] disable() called while transition in flight; ignoring');
      return this.status;
    }
    if (this.status.state === 'disabled') {
      return this.status;
    }
    this.inFlightTransition = true;
    try {
      this.setStatus({ state: 'unloading' });
      if (this.status.state === 'active') {
        this.session?.abort();
      }
      try {
        await this.session?.close();
      } catch (e) {
        console.warn('[AgentRuntime] session close error:', e);
      }
      try {
        await this.agent?.shutdown();
      } catch (e) {
        console.warn('[AgentRuntime] agent shutdown error:', e);
      }
      this.session = null;
      this.agent = null;
      this.setStatus(STATUS_DISABLED);
      return this.status;
    } finally {
      this.inFlightTransition = false;
    }
  }

  /**
   * 發送 user input 到當前 session。
   * 在 standby / active 狀態才可呼叫；其他狀態回 false。
   */
  send(text: string): boolean {
    if (this.status.state !== 'standby' && this.status.state !== 'active') {
      console.warn(
        `[AgentRuntime] send() rejected: state=${this.status.state}`,
      );
      return false;
    }
    if (!this.session) return false;
    try {
      this.session.send(text);
      return true;
    } catch (e) {
      console.warn('[AgentRuntime] send error:', e);
      return false;
    }
  }

  abort(): void {
    try {
      this.session?.abort();
    } catch (e) {
      console.warn('[AgentRuntime] abort error:', e);
    }
  }

  /**
   * 重新載入 LLM（disable + enable）— 設定變更後呼叫。
   */
  async reloadLlm(config: AgentConfig): Promise<AgentRuntimeStatus> {
    await this.disable();
    return this.enable(config);
  }

  private setStatus(s: AgentRuntimeStatus): void {
    this.status = s;
    this.emit('status', s);
    const info = this.getInfo();
    // 廣播到所有 BrowserWindow（給設定頁 / 托盤 / 氣泡）
    // - `llm_status_changed`：新的精確 AgentRuntimeStatus（P5 新增）
    // - `agent_status`：向後相容的 daemon-style info（P3 既有 UI 用）
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('llm_status_changed', s);
      win.webContents.send('agent_status', info);
    }
  }

  private broadcastFrame(frame: Frame): void {
    this.emit('frame', frame);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('agent_session_frame', frame);
    }
  }

  /**
   * mascotTools callback → 補 id 後廣播為 mascot_action IPC（與既有
   * MascotMcpServer.dispatch 行為一致，renderer 端的 MascotActionDispatcher
   * 依賴 `action.id` 做 dedup）。
   */
  private dispatchMascotAction(action: MascotAction): void {
    const broadcast = { id: randomUUID(), ...action };
    this.emit('mascotAction', broadcast);
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('mascot_action', broadcast);
    }
  }

  private async cleanupOnError(): Promise<void> {
    try {
      await this.session?.close();
    } catch {
      /* ignore */
    }
    try {
      await this.agent?.shutdown();
    } catch {
      /* ignore */
    }
    this.session = null;
    this.agent = null;
  }
}
