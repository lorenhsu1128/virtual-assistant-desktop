/**
 * AgentSessionClient — my-agent daemon WebSocket 客戶端。
 *
 * 連線到 `ws://127.0.0.1:<port>/sessions?source=mascot&cwd=<workspace>&token=<token>`，
 * 解析 NDJSON 訊息，re-emit 為 typed events 給上層中繼到 renderer。
 *
 * 協定參考：my-agent src/server/sessionBroker.ts、directConnectServer.ts。
 *
 * 注意：
 * - my-agent v1 source enum 不含 'mascot'，目前會被視為 'unknown'。
 *   待 my-agent 補上 enum 值後不需改本檔。
 * - 失敗一律 emit 'closed' 不 throw，由上層決定是否重連。
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** 連線參數 */
export interface AgentSessionClientOptions {
  host: string;
  port: number;
  token: string;
  cwd: string;
  source?: string;
}

/** Daemon 推給客戶端的訊息（簡化版，僅列出目前用到的欄位） */
export interface InboundFrame {
  type: string;
  // 動態欄位視 type 而定
  [key: string]: unknown;
}

/** 客戶端送給 daemon 的訊息 */
export type OutboundFrame =
  | { type: 'input'; text: string; intent?: 'interactive' | 'background' | 'slash' }
  | { type: 'queryDaemonStatus'; requestId?: string };

const RECONNECT_BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000];

export class AgentSessionClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: AgentSessionClientOptions | null = null;
  private connected = false;
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** 連線（idempotent — 已連會 no-op） */
  connect(opts: AgentSessionClientOptions): void {
    this.opts = opts;
    this.closing = false;
    this.reconnectAttempt = 0;
    this.openSocket();
  }

  /** 主動斷線並停止重連 */
  disconnect(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close(1000, 'client disconnect');
      } catch (e) {
        console.warn('[AgentSession] close error:', e);
      }
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** 送一條輸入給 daemon，回傳是否真的送出 */
  sendInput(text: string): boolean {
    return this.send({ type: 'input', text, intent: 'interactive' });
  }

  /** 通用送出（caller 自行確保 frame 合法） */
  send(frame: OutboundFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      // Daemon 用 NDJSON，需要尾端換行才會觸發 frame 解析
      this.ws.send(JSON.stringify(frame) + '\n');
      return true;
    } catch (e) {
      console.warn('[AgentSession] send error:', e);
      return false;
    }
  }

  // ── 內部 ──

  private openSocket(): void {
    if (!this.opts) return;
    const { host, port, token, cwd, source = 'mascot' } = this.opts;

    const params = new URLSearchParams({
      source,
      cwd,
      token,
    });
    const url = `ws://${host}:${port}/sessions?${params.toString()}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        perMessageDeflate: false,
      });
    } catch (e) {
      console.warn('[AgentSession] WebSocket constructor failed:', e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.emit('open');
    });

    ws.on('message', (raw: WebSocket.RawData) => {
      const text = raw.toString('utf-8');
      // NDJSON：每行一個 frame
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let frame: InboundFrame;
        try {
          frame = JSON.parse(trimmed) as InboundFrame;
        } catch (e) {
          console.warn('[AgentSession] frame parse error:', e, trimmed.slice(0, 200));
          continue;
        }
        this.emit('frame', frame);
      }
    });

    ws.on('error', (e: Error) => {
      console.warn('[AgentSession] ws error:', e.message);
      this.emit('error', e);
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.connected = false;
      this.ws = null;
      this.emit('close', { code, reason: reason.toString('utf-8') });
      if (!this.closing) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.closing) return;
    const backoff =
      RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, backoff);
  }
}
