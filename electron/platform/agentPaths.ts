/**
 * my-agent 整合相關路徑解析
 *
 * 集中所有跨平台 agent 相關路徑，主程式碼透過此模組取用，
 * 禁止散落 process.platform 判斷。失敗一律回傳 null，
 * 由上層決定降級策略（不可 throw，遵守跨平台守則）。
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isWindows, isMac } from './index.js';

/** my-agent 設定根目錄 */
export function getAgentHome(): string {
  return path.join(os.homedir(), '.my-agent');
}

/** my-agent daemon pid file */
export function getDaemonPidFilePath(): string {
  return path.join(getAgentHome(), 'daemon.pid.json');
}

/** my-agent daemon auth token */
export function getDaemonTokenFilePath(): string {
  return path.join(getAgentHome(), 'daemon.token');
}

/**
 * 解析 bun runtime 執行檔路徑。
 *
 * @param override 使用者於 config 指定的絕對路徑（優先）
 * @returns 可執行檔絕對路徑，或 null（找不到時）
 */
export function resolveBunBinary(override: string | null = null): string | null {
  if (override && fs.existsSync(override)) return override;

  if (isWindows) {
    const candidates = [
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Programs', 'bun', 'bun.exe')
        : null,
      process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, '.bun', 'bin', 'bun.exe')
        : null,
    ].filter((p): p is string => Boolean(p));
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  if (isMac) {
    const candidates = [
      path.join(os.homedir(), '.bun', 'bin', 'bun'),
      '/opt/homebrew/bin/bun',
      '/usr/local/bin/bun',
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  return null;
}

/**
 * 解析 my-agent CLI 入口路徑（cli 或 cli.exe）。
 *
 * @param override 使用者於 config 指定的絕對路徑（優先）
 * @returns CLI 入口絕對路徑，或 null
 */
export function resolveMyAgentCli(override: string | null = null): string | null {
  if (override && fs.existsSync(override)) return override;

  // 預設假設 my-agent 與本專案同層放在 _projects/ 下
  const projectsDir = process.env.USERPROFILE
    ? path.join(process.env.USERPROFILE, 'Documents', '_projects')
    : path.join(os.homedir(), 'Documents', '_projects');

  const candidates = isWindows
    ? [
        path.join(projectsDir, 'my-agent', 'cli.exe'),
        path.join(projectsDir, 'my-agent', 'cli'),
      ]
    : [path.join(projectsDir, 'my-agent', 'cli')];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * 預設 agent workspace cwd。
 *
 * my-agent daemon 用 cwd 路由 ProjectRuntime，
 * 桌寵預設用 ~/.virtual-assistant-desktop/agent-workspace 隔離 session。
 */
export function getDefaultAgentWorkspace(): string {
  return path.join(os.homedir(), '.virtual-assistant-desktop', 'agent-workspace');
}

/** 確保 workspace 目錄存在，回傳實際路徑 */
export async function ensureAgentWorkspace(override: string | null = null): Promise<string> {
  const dir = override && override.length > 0 ? override : getDefaultAgentWorkspace();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Agent daemon 日誌路徑（依日期分檔） */
export function getAgentDaemonLogPath(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return path.join(
    os.homedir(),
    '.virtual-assistant-desktop',
    'logs',
    `agent-daemon-${yyyy}-${mm}-${dd}.log`,
  );
}
