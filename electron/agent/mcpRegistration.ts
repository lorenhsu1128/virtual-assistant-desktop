/**
 * 透過 `my-agent mcp add/remove` CLI 把桌寵 MCP server 註冊到 my-agent。
 *
 * - 寫入 mcp.json（scope 由 cwd 決定，預設 user scope）
 * - daemon 在 ProjectRuntime 載入時會發現這個 server entry 並把工具加進
 *   QueryEngine 的工具清單
 * - idempotent：先 remove 再 add，避免重複/殘留舊 URL
 *
 * 失敗一律降級不 throw（與 AgentDaemonManager 風格一致）。
 */

import { spawn } from 'node:child_process';
import { resolveMyAgentCli } from '../platform/index.js';

const REGISTER_TIMEOUT_MS = 5_000;

/**
 * 把指定名稱的 MCP server URL 註冊到 my-agent。
 *
 * @param mcpName 名稱（在 my-agent 端顯示為 tools 前綴；通常 'mascot'）
 * @param url HTTP 端點（含 path），例：`http://127.0.0.1:54321/mcp`
 * @param cwd 註冊執行目錄（影響 scope）
 * @param myAgentCliPath 使用者 config 指定的 CLI 路徑（null = 自動偵測）
 * @returns true = add 成功
 */
export async function registerMascotMcp(
  mcpName: string,
  url: string,
  cwd: string,
  myAgentCliPath: string | null,
): Promise<boolean> {
  const cli = resolveMyAgentCli(myAgentCliPath);
  if (!cli) {
    console.warn('[McpReg] my-agent CLI not found, skipping mcp registration');
    return false;
  }

  // 先 remove（忽略失敗），再 add，達到 idempotent
  // --scope user：寫到 ~/.my-agent/.my-agent.jsonc 的全域 mcpServers，
  // 不需要 .mcp.json trust dialog 也能跨專案使用。
  // 桌寵 MCP server 是本機 loopback 端點、自家進程，視為信任來源。
  await runCli(cli, ['mcp', 'remove', mcpName, '--scope', 'user'], cwd);
  const ok = await runCli(
    cli,
    ['mcp', 'add', '--scope', 'user', '--transport', 'http', mcpName, url],
    cwd,
  );
  if (ok) {
    console.log(`[McpReg] registered mcp '${mcpName}' → ${url}`);
  } else {
    console.warn(`[McpReg] failed to register mcp '${mcpName}'`);
  }
  return ok;
}

/** 取消註冊（app quit 時清理，避免下次啟動時 daemon 看到死掉的 URL） */
export async function unregisterMascotMcp(
  mcpName: string,
  cwd: string,
  myAgentCliPath: string | null,
): Promise<void> {
  const cli = resolveMyAgentCli(myAgentCliPath);
  if (!cli) return;
  await runCli(cli, ['mcp', 'remove', mcpName, '--scope', 'user'], cwd);
}

function runCli(cli: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const proc = spawn(cli, args, {
      cwd,
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
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(false);
    }, REGISTER_TIMEOUT_MS);

    proc.once('exit', (code) => finish(code === 0));
    proc.once('error', () => finish(false));
  });
}
