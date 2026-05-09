import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * Fake WebSocket — 取代 ws 套件做純單元測試。
 *
 * 模擬：
 * - readyState 0/1/2/3 對應 CONNECTING / OPEN / CLOSING / CLOSED
 * - send / close / on / once / removeAllListeners 透過 EventEmitter
 * - 透過 fakeOpen() / fakeMessage() / fakeClose() 等手動觸發事件
 */
class FakeWebSocket extends EventEmitter {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  options: { headers?: Record<string, string> };
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  shouldThrowOnSend = false;
  shouldThrowOnClose = false;

  constructor(url: string, options: { headers?: Record<string, string> } = {}) {
    super();
    this.url = url;
    this.options = options;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.shouldThrowOnSend) throw new Error('send error');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.shouldThrowOnClose) throw new Error('close error');
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  fakeOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  fakeMessage(text: string): void {
    this.emit('message', Buffer.from(text, 'utf-8'));
  }

  fakeError(err: Error): void {
    this.emit('error', err);
  }

  fakeClose(code = 1000, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason, 'utf-8'));
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }
}

vi.mock('ws', () => ({
  default: FakeWebSocket,
}));

// 動態 import 確保 mock 生效
const { AgentSessionClient } = await import('../../electron/agent/AgentSessionClient');

describe('AgentSessionClient', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('connect', () => {
    it('builds ws url with source / cwd / token query params', () => {
      const client = new AgentSessionClient();
      client.connect({
        host: '127.0.0.1',
        port: 12345,
        token: 'tok123',
        cwd: '/work/space',
        source: 'mascot',
      });
      expect(FakeWebSocket.instances).toHaveLength(1);
      const ws = FakeWebSocket.instances[0];
      expect(ws.url).toContain('ws://127.0.0.1:12345/sessions');
      expect(ws.url).toContain('source=mascot');
      expect(ws.url).toContain('token=tok123');
      // URL 編碼 cwd
      expect(ws.url).toMatch(/cwd=%2Fwork%2Fspace|cwd=\/work\/space/);
    });

    it('sets Authorization header with bearer token', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 'abc', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      expect(ws.options.headers?.Authorization).toBe('Bearer abc');
    });

    it('defaults source to mascot when not provided', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      expect(FakeWebSocket.instances[0].url).toContain('source=mascot');
    });

    it('emits open event when ws opens', () => {
      const client = new AgentSessionClient();
      const onOpen = vi.fn();
      client.on('open', onOpen);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      FakeWebSocket.instances[0].fakeOpen();
      expect(onOpen).toHaveBeenCalledOnce();
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('send', () => {
    it('returns false when not connected', () => {
      const client = new AgentSessionClient();
      expect(client.sendInput('hello')).toBe(false);
    });

    it('returns false when ws is still connecting', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      // readyState 0 (CONNECTING)
      expect(client.sendInput('hello')).toBe(false);
    });

    it('appends NDJSON newline (regression for missing \\n bug)', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      const ok = client.sendInput('hello world');
      expect(ok).toBe(true);
      expect(ws.sent).toHaveLength(1);
      expect(ws.sent[0].endsWith('\n')).toBe(true);
      const parsed = JSON.parse(ws.sent[0].trim());
      expect(parsed).toEqual({ type: 'input', text: 'hello world', intent: 'interactive' });
    });

    it('returns false when send throws', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      ws.shouldThrowOnSend = true;
      expect(client.sendInput('boom')).toBe(false);
    });
  });

  describe('frame parsing (NDJSON)', () => {
    it('emits frame for each newline-delimited JSON', () => {
      const client = new AgentSessionClient();
      const onFrame = vi.fn();
      client.on('frame', onFrame);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();

      ws.fakeMessage('{"type":"hello","sessionId":"abc"}\n{"type":"state","state":"IDLE"}\n');
      expect(onFrame).toHaveBeenCalledTimes(2);
      expect(onFrame.mock.calls[0][0]).toMatchObject({ type: 'hello', sessionId: 'abc' });
      expect(onFrame.mock.calls[1][0]).toMatchObject({ type: 'state', state: 'IDLE' });
    });

    it('ignores empty lines between frames', () => {
      const client = new AgentSessionClient();
      const onFrame = vi.fn();
      client.on('frame', onFrame);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      ws.fakeMessage('\n{"type":"a"}\n\n{"type":"b"}\n\n');
      expect(onFrame).toHaveBeenCalledTimes(2);
    });

    it('skips malformed JSON without throwing', () => {
      const client = new AgentSessionClient();
      const onFrame = vi.fn();
      client.on('frame', onFrame);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      // 第一行壞 JSON、第二行正常 — 預期只 emit 第二行
      ws.fakeMessage('{not valid\n{"type":"good"}\n');
      expect(onFrame).toHaveBeenCalledOnce();
      expect(onFrame.mock.calls[0][0]).toMatchObject({ type: 'good' });
    });

    it('handles single message without trailing newline', () => {
      const client = new AgentSessionClient();
      const onFrame = vi.fn();
      client.on('frame', onFrame);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      ws.fakeMessage('{"type":"keep_alive"}');
      expect(onFrame).toHaveBeenCalledOnce();
    });
  });

  describe('disconnect', () => {
    it('closes ws with code 1000', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      client.disconnect();
      expect(ws.closeCalls).toHaveLength(1);
      expect(ws.closeCalls[0].code).toBe(1000);
      expect(client.isConnected()).toBe(false);
    });

    it('prevents reconnect after explicit disconnect', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      client.disconnect();
      // 模擬 ws 端關閉事件（disconnect 已 removeAllListeners 所以不會有實際 emit；
      // 但即使有，scheduleReconnect 也應因 closing=true 而 no-op）
      vi.advanceTimersByTime(60_000);
      expect(FakeWebSocket.instances).toHaveLength(1); // 沒有新建
    });

    it('reconnects after unexpected close', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();

      // 模擬 daemon 那端突然關連線
      ws.fakeClose(1006, 'abnormal');

      // 第一次重連 backoff = 500ms
      vi.advanceTimersByTime(500);
      expect(FakeWebSocket.instances).toHaveLength(2);

      // 再次 fakeClose 觸發更長的 backoff
      const ws2 = FakeWebSocket.instances[1];
      ws2.fakeOpen();
      ws2.fakeClose(1006, 'abnormal');
      vi.advanceTimersByTime(1_000);
      expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it('does not throw when close itself errors', () => {
      const client = new AgentSessionClient();
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeOpen();
      ws.shouldThrowOnClose = true;
      expect(() => client.disconnect()).not.toThrow();
    });
  });

  describe('error handling', () => {
    it('emits error event when ws emits error', () => {
      const client = new AgentSessionClient();
      const onError = vi.fn();
      client.on('error', onError);
      client.connect({ host: '127.0.0.1', port: 1, token: 't', cwd: '/x' });
      const ws = FakeWebSocket.instances[0];
      ws.fakeError(new Error('boom'));
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    });
  });
});
