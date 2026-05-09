import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

/**
 * 測試 AgentDaemonManager 的 status emit 與 syncSession 邏輯。
 *
 * mock 範圍：
 * - `node:child_process` spawn — 不真的起進程
 * - `node:fs` / `node:fs/promises` — 不碰真檔案系統
 * - `../platform/index.js` — 注入受控的路徑解析
 * - `./AgentSessionClient.js` — 用 Fake 觀察 connect/disconnect/sendInput 呼叫
 *
 * 不測試：spawn flow 真正啟動 daemon（屬整合測試範圍）。
 */

import type { AgentConfig } from '../../electron/fileManager';

// ── Mocks ──

class FakeChildProcess extends EventEmitter {
  killed = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

const mockSpawnedProcs: FakeChildProcess[] = [];
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const proc = new FakeChildProcess();
    mockSpawnedProcs.push(proc);
    return proc;
  }),
}));

const mockFs = {
  createWriteStream: vi.fn(() => ({ write: vi.fn(), end: vi.fn() })),
  existsSync: vi.fn(() => true),
  statSync: vi.fn(() => ({ isFile: () => true, mode: 0o755 })),
};
vi.mock('node:fs', () => mockFs);

let pidJsonContent: string | null = null;
let tokenContent: string | null = null;
const mockFsp = {
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async (p: string) => {
    if (p.endsWith('daemon.pid.json')) {
      if (pidJsonContent === null) throw new Error('ENOENT');
      return pidJsonContent;
    }
    if (p.endsWith('daemon.token')) {
      if (tokenContent === null) throw new Error('ENOENT');
      return tokenContent;
    }
    throw new Error('ENOENT');
  }),
};
vi.mock('node:fs/promises', () => mockFsp);

vi.mock('../../electron/platform/index.js', () => ({
  ensureAgentWorkspace: vi.fn(async () => '/fake/workspace'),
  getAgentDaemonLogPath: () => '/fake/logs/agent-daemon.log',
  getDaemonPidFilePath: () => '/fake/.my-agent/daemon.pid.json',
  getDaemonTokenFilePath: () => '/fake/.my-agent/daemon.token',
  resolveBunBinary: () => '/fake/bun',
  resolveMyAgentCli: () => '/fake/cli',
}));

// AgentSessionClient mock 觀察整合
const sessionClientInstances: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  emit: (event: string, ...args: unknown[]) => void;
  emitter: EventEmitter;
}> = [];

vi.mock('../../electron/agent/AgentSessionClient.js', () => {
  return {
    AgentSessionClient: class {
      connect = vi.fn();
      disconnect = vi.fn();
      sendInput = vi.fn(() => true);
      removeAllListeners = vi.fn();
      private emitter = new EventEmitter();
      on = (event: string, cb: (...args: unknown[]) => void) => {
        this.emitter.on(event, cb);
      };
      emit = (event: string, ...args: unknown[]) => {
        this.emitter.emit(event, ...args);
      };
      isConnected() {
        return false;
      }
      constructor() {
        sessionClientInstances.push({
          connect: this.connect,
          disconnect: this.disconnect,
          sendInput: this.sendInput,
          removeAllListeners: this.removeAllListeners,
          on: this.on,
          emit: this.emit,
          emitter: this.emitter,
        });
      }
    },
  };
});

const { AgentDaemonManager } = await import('../../electron/agent/AgentDaemonManager');

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    enabled: true,
    daemonMode: 'auto',
    bunBinaryPath: null,
    myAgentCliPath: null,
    workspaceCwd: null,
    ...overrides,
  };
}

describe('AgentDaemonManager', () => {
  beforeEach(() => {
    mockSpawnedProcs.length = 0;
    sessionClientInstances.length = 0;
    pidJsonContent = null;
    tokenContent = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('disabled config', () => {
    it('emits disabled status without spawning', async () => {
      const cfg = makeConfig({ enabled: false });
      const m = new AgentDaemonManager(cfg);
      await m.start();
      expect(m.getInfo().status).toBe('disabled');
      expect(mockSpawnedProcs).toHaveLength(0);
      expect(sessionClientInstances).toHaveLength(0);
    });
  });

  describe('sendInput', () => {
    it('returns false before any session is connected', () => {
      const m = new AgentDaemonManager(makeConfig());
      expect(m.sendInput('hi')).toBe(false);
    });
  });

  describe('syncSession lifecycle', () => {
    it('creates session client when status becomes online', async () => {
      const m = new AgentDaemonManager(makeConfig());
      // Force private state by directly emitting (production path uses internal probe)
      (m as unknown as { workspaceCwd: string }).workspaceCwd = '/fake/workspace';
      m.emit('status', {
        status: 'online',
        port: 1234,
        token: 'tok',
        pid: 99,
      });
      expect(sessionClientInstances).toHaveLength(1);
      expect(sessionClientInstances[0].connect).toHaveBeenCalledOnce();
      const args = sessionClientInstances[0].connect.mock.calls[0][0];
      expect(args).toMatchObject({
        host: '127.0.0.1',
        port: 1234,
        token: 'tok',
        cwd: '/fake/workspace',
        source: 'mascot',
      });
    });

    it('disconnects session when status leaves online', () => {
      const m = new AgentDaemonManager(makeConfig());
      (m as unknown as { workspaceCwd: string }).workspaceCwd = '/fake/workspace';
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      const sess = sessionClientInstances[0];
      m.emit('status', { status: 'offline', port: null, token: null, pid: null });
      expect(sess.disconnect).toHaveBeenCalled();
    });

    it('reuses session when port/token unchanged', () => {
      const m = new AgentDaemonManager(makeConfig());
      (m as unknown as { workspaceCwd: string }).workspaceCwd = '/fake/workspace';
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      expect(sessionClientInstances).toHaveLength(1);
    });

    it('replaces session when port changes', () => {
      const m = new AgentDaemonManager(makeConfig());
      (m as unknown as { workspaceCwd: string }).workspaceCwd = '/fake/workspace';
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      const first = sessionClientInstances[0];
      m.emit('status', { status: 'online', port: 2, token: 't', pid: 1 });
      expect(first.disconnect).toHaveBeenCalled();
      expect(sessionClientInstances).toHaveLength(2);
      expect(sessionClientInstances[1].connect).toHaveBeenCalled();
    });

    it('does not connect when workspace cwd is missing', () => {
      const m = new AgentDaemonManager(makeConfig());
      // workspaceCwd 預設 null
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      expect(sessionClientInstances).toHaveLength(0);
    });

    it('routes session_frame events through manager', () => {
      const m = new AgentDaemonManager(makeConfig());
      (m as unknown as { workspaceCwd: string }).workspaceCwd = '/fake/workspace';
      m.emit('status', { status: 'online', port: 1, token: 't', pid: 1 });
      const onFrame = vi.fn();
      m.on('session_frame', onFrame);
      const sess = sessionClientInstances[0];
      sess.emit('frame', { type: 'hello', sessionId: 'abc' });
      expect(onFrame).toHaveBeenCalledOnce();
      expect(onFrame.mock.calls[0][0]).toMatchObject({ type: 'hello' });
    });
  });

  describe('status change suppression', () => {
    it('does not re-emit when status identical', () => {
      const m = new AgentDaemonManager(makeConfig());
      const onStatus = vi.fn();
      m.on('status', onStatus);
      m.emit('status', { status: 'starting', port: null, token: null, pid: null });
      m.emit('status', { status: 'starting', port: null, token: null, pid: null });
      // EventEmitter 不去重，所以 emit 兩次就到兩次。這裡驗證的是
      // 我們的 manager 「不會」自己手動再多 emit 一次（透過 setInfo 才會去重）。
      expect(onStatus).toHaveBeenCalledTimes(2);
    });
  });
});
