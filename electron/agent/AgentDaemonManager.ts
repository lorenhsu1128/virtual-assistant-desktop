/**
 * AgentDaemonManager — my-agent daemon 生命週期管理。
 *
 * 兩種模式：
 * - `auto`：spawn `bun ./cli daemon start --port 0 --host 127.0.0.1`，
 *           輪詢 `~/.my-agent/daemon.pid.json` 取得 port，app 結束時 SIGTERM。
 * - `external`：使用者自行啟動 daemon，本管理員只讀 pid.json。
 *
 * 設計原則：
 * - 失敗一律降級為「離線」狀態，不 throw 也不 crash 桌寵
 * - 三秒 SIGTERM 後 SIGKILL（對齊 my-agent 自身 shutdown 預算）
 * - stale 偵測：lastHeartbeat 超過 30s 視為死掉
 *
 * 對應 LESSONS.md 鐵則：electron/ 改動需 `bun run build:electron` + 完全重啟
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  ensureAgentWorkspace,
  getAgentDaemonLogPath,
  getDaemonPidFilePath,
  getDaemonTokenFilePath,
  resolveBunBinary,
  resolveMyAgentCli,
} from '../platform/index.js';
import type { AgentConfig } from '../fileManager.js';

/** Daemon pid.json schema（my-agent v1） */
export interface DaemonPidFile {
  version: number;
  pid: number;
  port: number;
  startedAt: number;
  lastHeartbeat: number;
  agentVersion: string;
}

export type AgentDaemonStatus =
  | 'disabled'        // config.agent.enabled = false
  | 'starting'        // 正在 spawn 或等 pid.json
  | 'connecting'      // 已知 port，但還沒驗證 token
  | 'online'          // pid.json 存在且 heartbeat 新鮮
  | 'offline'         // 連線失敗 / heartbeat stale
  | 'error';          // spawn 失敗等致命錯誤

export interface AgentDaemonInfo {
  status: AgentDaemonStatus;
  port: number | null;
  token: string | null;
  pid: number | null;
  message?: string;
}

const PID_POLL_INTERVAL_MS = 250;
const PID_POLL_TIMEOUT_MS = 10_000;
const HEARTBEAT_STALE_THRESHOLD_MS = 30_000;
const HEALTH_PROBE_INTERVAL_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const GRACEFUL_STOP_TIMEOUT_MS = 3_000;

export class AgentDaemonManager extends EventEmitter {
  private config: AgentConfig;
  private child: ChildProcess | null = null;
  private logStream: fs.WriteStream | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private currentInfo: AgentDaemonInfo = {
    status: 'disabled',
    port: null,
    token: null,
    pid: null,
  };
  private stopping = false;

  constructor(config: AgentConfig) {
    super();
    this.config = config;
  }

  getInfo(): AgentDaemonInfo {
    return this.currentInfo;
  }

  /** 啟動管理流程（依模式 spawn 或僅探測） */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      this.setInfo({ status: 'disabled', port: null, token: null, pid: null });
      return;
    }

    this.stopping = false;
    this.setInfo({ ...this.currentInfo, status: 'starting' });

    try {
      if (this.config.daemonMode === 'auto') {
        await this.spawnDaemon();
      }
      // external 模式：直接進入探測階段
      const probed = await this.probeUntilReady();
      if (probed) {
        this.startHealthLoop();
      }
    } catch (e) {
      console.warn('[AgentDaemon] start failed:', e);
      this.setInfo({
        status: 'error',
        port: null,
        token: null,
        pid: null,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /**
   * 優雅關閉 daemon（auto 模式）或斷線（external 模式）。
   *
   * Windows 上 Node.js 的 `child.kill('SIGTERM')` 實際是 TerminateProcess（硬殺），
   * daemon 來不及刪 pid.json。改用 my-agent 自己的 `daemon stop` 子命令：
   *   1. 先 spawn `cli daemon stop` 通知 daemon 自我清理
   *   2. 等子進程自然 exit（最多 SHUTDOWN_TIMEOUT_MS）
   *   3. 仍未退出才 fallback 硬殺
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    if (this.child && !this.child.killed) {
      const child = this.child;
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });

      // Step 1：嘗試 graceful — `cli daemon stop` 透過內部 IPC 通知 daemon
      const gracefulOk = await this.tryGracefulStop();
      this.logStream?.write(
        `[${new Date().toISOString()}] graceful stop ${gracefulOk ? 'sent' : 'failed'}\n`,
      );

      // Step 2：等 child 自然退出
      const exitedInTime = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), SHUTDOWN_TIMEOUT_MS),
        ),
      ]);

      if (!exitedInTime) {
        // Step 3：fallback 硬殺
        console.warn('[AgentDaemon] graceful stop timeout, force killing');
        try {
          child.kill('SIGKILL');
        } catch (e) {
          console.warn('[AgentDaemon] SIGKILL failed:', e);
        }
      }
    }

    this.child = null;
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }

    this.setInfo({ status: 'offline', port: null, token: null, pid: null });
  }

  /**
   * 透過 `cli.exe daemon stop` 子命令通知 daemon 自我清理。
   * 該命令會在 daemon 結束（或 2s timeout）後自然返回。
   *
   * @returns true = stop 命令成功送達 daemon
   */
  private async tryGracefulStop(): Promise<boolean> {
    const cli = resolveMyAgentCli(this.config.myAgentCliPath);
    if (!cli) return false;

    return new Promise<boolean>((resolve) => {
      const stopProc = spawn(cli, ['daemon', 'stop'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let resolved = false;
      const finish = (ok: boolean): void => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(ok);
      };

      const timer = setTimeout(() => {
        try {
          stopProc.kill('SIGKILL');
        } catch {
          // ignore
        }
        finish(false);
      }, GRACEFUL_STOP_TIMEOUT_MS);

      stopProc.once('exit', (code) => finish(code === 0));
      stopProc.once('error', () => finish(false));
    });
  }

  // ── 內部 ──

  private async spawnDaemon(): Promise<void> {
    const cli = resolveMyAgentCli(this.config.myAgentCliPath);
    if (!cli) {
      throw new Error('my-agent CLI not found — set agent.myAgentCliPath');
    }

    // 判定是 bun-compiled 獨立執行檔（.exe / 無副檔名 binary）還是 source script
    const isCompiledBinary = isExecutable(cli);
    let command: string;
    let args: string[];
    if (isCompiledBinary) {
      command = cli;
      args = ['daemon', 'start', '--port', '0', '--host', '127.0.0.1'];
    } else {
      const bunBinary = resolveBunBinary(this.config.bunBinaryPath);
      if (!bunBinary) {
        throw new Error('Bun runtime not found — install bun or set agent.bunBinaryPath');
      }
      command = bunBinary;
      args = [cli, 'daemon', 'start', '--port', '0', '--host', '127.0.0.1'];
    }

    const cwd = await ensureAgentWorkspace(this.config.workspaceCwd);

    // 預先寫入日誌檔
    const logPath = getAgentDaemonLogPath();
    await fsp.mkdir(path.dirname(logPath), { recursive: true });
    this.logStream = fs.createWriteStream(logPath, { flags: 'a' });
    this.logStream.write(
      `\n[${new Date().toISOString()}] === Spawning my-agent daemon ===\n` +
        `  command: ${command}\n  args: ${JSON.stringify(args)}\n  cwd: ${cwd}\n`,
    );

    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: false,
    });

    this.child = child;

    child.stdout?.on('data', (chunk) => this.logStream?.write(chunk));
    child.stderr?.on('data', (chunk) => this.logStream?.write(chunk));

    child.once('error', (e) => {
      console.warn('[AgentDaemon] child error:', e);
      this.setInfo({
        status: 'error',
        port: null,
        token: null,
        pid: null,
        message: e.message,
      });
    });

    child.once('exit', (code, signal) => {
      this.logStream?.write(
        `\n[${new Date().toISOString()}] daemon exited code=${code} signal=${signal}\n`,
      );
      if (this.stopping) return;
      console.warn(`[AgentDaemon] unexpected exit code=${code} signal=${signal}`);
      this.setInfo({
        status: 'offline',
        port: null,
        token: null,
        pid: null,
        message: `daemon exited code=${code}`,
      });
    });
  }

  /** 輪詢 pid.json 直到 ready 或 timeout */
  private async probeUntilReady(): Promise<boolean> {
    const deadline = Date.now() + PID_POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (this.stopping) return false;
      const info = await this.readDaemonState();
      if (info && info.status === 'online') {
        this.setInfo(info);
        return true;
      }
      await sleep(PID_POLL_INTERVAL_MS);
    }

    this.setInfo({
      status: 'offline',
      port: null,
      token: null,
      pid: null,
      message: 'pid.json probe timeout',
    });
    return false;
  }

  /** 讀 pid.json + token，判定是否新鮮 */
  private async readDaemonState(): Promise<AgentDaemonInfo | null> {
    const pidPath = getDaemonPidFilePath();
    const tokenPath = getDaemonTokenFilePath();

    let pidJson: DaemonPidFile;
    try {
      const raw = await fsp.readFile(pidPath, 'utf-8');
      pidJson = JSON.parse(raw) as DaemonPidFile;
    } catch {
      return null;
    }

    if (!pidJson.port || pidJson.port <= 0) return null;

    const stale = Date.now() - pidJson.lastHeartbeat > HEARTBEAT_STALE_THRESHOLD_MS;
    if (stale) {
      return {
        status: 'offline',
        port: null,
        token: null,
        pid: pidJson.pid,
        message: 'heartbeat stale',
      };
    }

    let token: string | null = null;
    try {
      token = (await fsp.readFile(tokenPath, 'utf-8')).trim();
    } catch {
      // token 缺失視為未就緒
      return null;
    }

    return {
      status: 'online',
      port: pidJson.port,
      token,
      pid: pidJson.pid,
    };
  }

  /** 持續探測 daemon 狀態 */
  private startHealthLoop(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => {
      void this.healthTick();
    }, HEALTH_PROBE_INTERVAL_MS);
  }

  private async healthTick(): Promise<void> {
    if (this.stopping) return;
    const info = await this.readDaemonState();
    if (!info) {
      this.setInfo({
        status: 'offline',
        port: null,
        token: null,
        pid: null,
        message: 'pid.json missing',
      });
      return;
    }
    this.setInfo(info);
  }

  private setInfo(next: AgentDaemonInfo): void {
    const prev = this.currentInfo;
    this.currentInfo = next;
    if (
      prev.status !== next.status ||
      prev.port !== next.port ||
      prev.message !== next.message
    ) {
      this.emit('status', next);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 判定路徑是否為可獨立執行的二進位檔（Windows .exe / Unix 無副檔名 binary） */
function isExecutable(filePath: string): boolean {
  if (filePath.toLowerCase().endsWith('.exe')) return true;
  // Unix-style：無副檔名 + 有執行權限視為 binary
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '' || ext === '.bin') {
    try {
      const stat = fs.statSync(filePath);
      // Mode bit check（owner/group/other 任一 x）
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  }
  // .ts / .js / .tsx / .mjs 等視為 source script
  return false;
}
