/**
 * Agent 整合型別（renderer 端）。
 *
 * 與 electron/agent/AgentDaemonManager.ts 的 AgentDaemonInfo / AgentDaemonStatus
 * 保持同步。daemon 推送的訊息透過 IPC `agent_session_frame` 傳遞。
 */

/** Agent daemon 生命週期狀態 */
export type AgentDaemonStatus =
  | 'disabled'
  | 'starting'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'error';

/** Agent daemon 當前資訊 */
export interface AgentDaemonInfo {
  status: AgentDaemonStatus;
  port: number | null;
  token: string | null;
  pid: number | null;
  message?: string;
}

/**
 * 從 my-agent daemon 收到的 NDJSON frame。
 *
 * 已知 type（非完整列表，僅列出本專案有處理的）：
 * - `hello`：握手回應 `{sessionId, state, currentInputId?}`
 * - `state`：佇列狀態變化 `{state: 'IDLE'|'RUNNING'|'INTERRUPTING'}`
 * - `turnStart` / `turnEnd`：對話 turn 開始/結束
 * - `runnerEvent`：包裝 Anthropic streaming 事件 `{inputId, event}`
 * - `keep_alive`：心跳，無需處理
 *
 * 完整協定見 my-agent src/server/sessionBroker.ts。
 */
export interface AgentSessionFrame {
  type: string;
  [key: string]: unknown;
}

/** Anthropic-format streaming 事件（從 runnerEvent.event 取出） */
export interface RunnerStreamEvent {
  type: string;
  [key: string]: unknown;
}
