import { ipc } from '../src/bridge/ElectronIPC';
import type { AgentDaemonInfo, AgentSessionFrame } from '../src/types/agent';

/**
 * Agent 對話氣泡視窗的 controller。
 *
 * 負責：
 * - 顯示 daemon 狀態（online/offline）
 * - 將使用者輸入透過 IPC 送給 daemon
 * - 解析 my-agent 推來的 runnerEvent，組合 streaming assistant text 顯示
 *
 * 不直接呼叫 ws，全部走 ElectronIPC bridge。
 */
export class BubbleApp {
  private logEl: HTMLElement;
  private statusEl: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private closeBtn: HTMLButtonElement;
  private currentAssistantEl: HTMLElement | null = null;
  private currentAssistantText = '';

  constructor(root: HTMLElement) {
    this.logEl = mustGet(root, '#bubble-log');
    this.statusEl = mustGet(root, '#bubble-status');
    this.inputEl = mustGet(root, '#bubble-input') as HTMLTextAreaElement;
    this.sendBtn = mustGet(root, '#bubble-send-btn') as HTMLButtonElement;
    this.closeBtn = mustGet(root, '#bubble-close-btn') as HTMLButtonElement;
  }

  async init(): Promise<void> {
    // 初始狀態
    const info = await ipc.agentGetStatus();
    this.applyStatus(info);

    // 監聽 daemon / session 事件
    ipc.onAgentStatus((info) => this.applyStatus(info));
    ipc.onAgentSessionOpen(() => this.appendSystem('已連線'));
    ipc.onAgentSessionClose((info) => this.appendSystem(`連線中斷 (${info.code})`));
    ipc.onAgentSessionFrame((frame) => this.handleFrame(frame));

    // UI events
    this.sendBtn.addEventListener('click', () => void this.send());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.closeBtn.addEventListener('click', () => {
      // 透過 closeWindow IPC 隱藏目前視窗（取得自己的視窗）
      window.close();
    });
  }

  private applyStatus(info: AgentDaemonInfo): void {
    this.statusEl.textContent = info.status;
    this.statusEl.dataset.status = info.status;
    const ready = info.status === 'online';
    this.inputEl.disabled = !ready;
    this.sendBtn.disabled = !ready;
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.appendUser(text);
    this.inputEl.value = '';
    this.startAssistantSlot();
    const ok = await ipc.agentSendInput(text);
    if (!ok) {
      this.appendError('送出失敗：daemon 離線或未連線');
      this.discardAssistantSlot();
    }
  }

  private handleFrame(frame: AgentSessionFrame): void {
    switch (frame.type) {
      case 'hello':
        // sessionId 等資訊可顯示但 P1 先略
        break;
      case 'turnStart':
        // 預留 inputId 處理，P1 先略
        break;
      case 'runnerEvent':
        this.handleRunnerEvent(frame.event as AgentSessionFrame | undefined);
        break;
      case 'turnEnd':
        this.finalizeAssistantSlot(frame);
        break;
      case 'state':
      case 'keep_alive':
      case 'projectLoading':
      case 'permissionPending':
      case 'permissionModeChanged':
        // P1 不處理
        break;
      default:
        // 未知 type 安靜略過（比 console.warn 友善）
        break;
    }
  }

  private handleRunnerEvent(ev?: AgentSessionFrame): void {
    if (!ev) return;
    // Anthropic-format streaming events
    if (ev.type === 'content_block_delta') {
      const delta = ev.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.appendAssistantDelta(delta.text);
      }
    } else if (ev.type === 'error') {
      const msg = (ev.error as string) ?? 'unknown error';
      this.appendError(msg);
    }
    // tool_use / thinking 等 P2 才處理
  }

  private startAssistantSlot(): void {
    this.currentAssistantText = '';
    const el = document.createElement('div');
    el.className = 'bubble-msg assistant';
    el.textContent = '…';
    this.logEl.appendChild(el);
    this.scrollToBottom();
    this.currentAssistantEl = el;
  }

  private appendAssistantDelta(text: string): void {
    if (!this.currentAssistantEl) this.startAssistantSlot();
    if (!this.currentAssistantEl) return;
    this.currentAssistantText += text;
    this.currentAssistantEl.textContent = this.currentAssistantText;
    this.scrollToBottom();
  }

  private finalizeAssistantSlot(frame: AgentSessionFrame): void {
    const reason = (frame.reason as string) ?? 'done';
    if (this.currentAssistantEl && this.currentAssistantText.length === 0) {
      // 沒有任何內容卻收到 turnEnd（可能 error）
      const errMsg = (frame.error as string) ?? `(no content, reason=${reason})`;
      this.currentAssistantEl.textContent = errMsg;
      this.currentAssistantEl.classList.remove('assistant');
      this.currentAssistantEl.classList.add('error');
    }
    if (reason === 'error' && frame.error) {
      this.appendError(String(frame.error));
    }
    this.currentAssistantEl = null;
    this.currentAssistantText = '';
  }

  private discardAssistantSlot(): void {
    if (this.currentAssistantEl) {
      this.currentAssistantEl.remove();
    }
    this.currentAssistantEl = null;
    this.currentAssistantText = '';
  }

  private appendUser(text: string): void {
    const el = document.createElement('div');
    el.className = 'bubble-msg user';
    el.textContent = text;
    this.logEl.appendChild(el);
    this.scrollToBottom();
  }

  private appendSystem(text: string): void {
    const el = document.createElement('div');
    el.className = 'bubble-msg system';
    el.textContent = text;
    this.logEl.appendChild(el);
    this.scrollToBottom();
  }

  private appendError(text: string): void {
    const el = document.createElement('div');
    el.className = 'bubble-msg error';
    el.textContent = text;
    this.logEl.appendChild(el);
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}

function mustGet(root: HTMLElement, selector: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`bubble: missing ${selector}`);
  return el;
}
