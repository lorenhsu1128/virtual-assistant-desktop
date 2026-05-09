/**
 * MascotMcpServer — 桌寵 MCP server（HTTP transport）。
 *
 * 由 my-agent 透過 `cli mcp add --transport http mascot http://127.0.0.1:N/mcp`
 * 註冊；LLM 呼叫工具時透過 HTTP POST 進來，main process 再透過 IPC
 * 把指令推給主視窗 renderer 執行（ExpressionManager / AnimationManager）。
 *
 * 設計：
 * - 動態 port（127.0.0.1 + 0），啟動後從 `server.address()` 取得實際 port
 * - 4 個 tool：set_expression / play_animation / say / look_at_screen
 * - tool handler 廣播 `mascot_action` IPC 給所有 BrowserWindow
 * - 失敗一律降級不 throw（與 daemon manager 風格一致）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import { z } from 'zod';
import type { BrowserWindow } from 'electron';

/** 動作 payload 對應 src/agent/MascotActionDispatcher 的 union type */
export type MascotAction =
  | { kind: 'set_expression'; name: string; durationMs?: number }
  | { kind: 'play_animation'; category?: string; name?: string }
  | { kind: 'say'; text: string; autoDismissMs?: number }
  | { kind: 'look_at_screen'; x: number; y: number };

const SERVER_NAME = 'mascot';
const SERVER_VERSION = '0.1.0';

export class MascotMcpServer {
  private mcp: McpServer;
  private transport: StreamableHTTPServerTransport | null = null;
  private httpServer: http.Server | null = null;
  /** 啟動後的 URL（包含 port），未啟動則 null */
  private url: string | null = null;
  /** 取得目前所有可廣播的 BrowserWindow（main process 注入） */
  private getWindows: () => readonly BrowserWindow[];

  constructor(getWindows: () => readonly BrowserWindow[]) {
    this.getWindows = getWindows;
    this.mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
    this.registerTools();
  }

  /** 啟動 HTTP server 並回傳 URL（含 port），失敗回 null */
  async start(): Promise<string | null> {
    // Stateful mode：產生 sessionId，client 後續 request 帶 mcp-session-id 回來
    // 同一個 McpServer + transport instance 維持整個 session
    this.transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await this.mcp.connect(this.transport);

    return new Promise<string | null>((resolve) => {
      const server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400).end();
          return;
        }
        // 直接把 req/res 交給 transport — 它內部用 @hono/node-server 把
        // Node IncomingMessage 轉成 Web Standard Request，會自行讀 body。
        // 我們**不可**先 consume req body，否則 hono 讀不到（500）。
        void this.transport?.handleRequest(req, res).catch((e) => {
          console.warn('[MascotMcp] handleRequest error:', e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`MCP error: ${e instanceof Error ? e.message : String(e)}`);
          }
        });
      });

      server.once('error', (e) => {
        console.warn('[MascotMcp] http server error:', e);
        resolve(null);
      });

      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          resolve(null);
          return;
        }
        this.httpServer = server;
        this.url = `http://127.0.0.1:${addr.port}/mcp`;
        console.log(`[MascotMcp] HTTP MCP server listening on ${this.url}`);
        resolve(this.url);
      });
    });
  }

  async stop(): Promise<void> {
    try {
      await this.transport?.close();
    } catch (e) {
      console.warn('[MascotMcp] transport close error:', e);
    }
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = null;
    }
    this.transport = null;
    this.url = null;
  }

  getUrl(): string | null {
    return this.url;
  }

  // ── tool 定義 ──

  private registerTools(): void {
    this.mcp.registerTool(
      'set_expression',
      {
        title: '設定 VRM 表情',
        description:
          '把桌寵的 BlendShape 表情切換為指定名稱（如 joy / angry / sorrow / fun / surprised / hehe 等）。覆蓋自動表情輪播。',
        inputSchema: {
          name: z
            .string()
            .describe('VRM 表情名稱，常見：joy / angry / sorrow / fun / neutral / surprised / hehe'),
          durationMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('表情持續毫秒數，過後回到自動模式；不填表示永久維持手動表情'),
        },
      },
      (args) => {
        this.dispatch({
          kind: 'set_expression',
          name: args.name,
          durationMs: args.durationMs,
        });
        return {
          content: [
            { type: 'text', text: `set_expression(${args.name}) dispatched` },
          ],
        };
      },
    );

    this.mcp.registerTool(
      'play_animation',
      {
        title: '播放 VRM 動畫',
        description:
          '播放一段 .vrma 動畫。可指定 category（idle / action / sit / fall / collide / peek）讓系統挑選，或指定具體 name（檔名）。',
        inputSchema: {
          category: z
            .enum(['idle', 'action', 'sit', 'fall', 'collide', 'peek'])
            .optional()
            .describe('動畫分類；若不指定 name 則從該分類隨機挑'),
          name: z.string().optional().describe('動畫檔名（如 SYS_WAVE_01.vrma）'),
        },
      },
      (args) => {
        if (!args.category && !args.name) {
          return {
            content: [
              { type: 'text', text: 'error: must provide either category or name' },
            ],
            isError: true,
          };
        }
        this.dispatch({
          kind: 'play_animation',
          category: args.category,
          name: args.name,
        });
        return {
          content: [
            {
              type: 'text',
              text: `play_animation(category=${args.category ?? '-'}, name=${args.name ?? '-'}) dispatched`,
            },
          ],
        };
      },
    );

    this.mcp.registerTool(
      'say',
      {
        title: '在對話氣泡顯示文字',
        description:
          '把一段話即時推到桌寵對話氣泡（與 LLM 回應分開的獨立輔助訊息）。',
        inputSchema: {
          text: z.string().describe('要顯示的文字'),
          autoDismissMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('幾毫秒後自動消失；不填表示常駐'),
        },
      },
      (args) => {
        this.dispatch({
          kind: 'say',
          text: args.text,
          autoDismissMs: args.autoDismissMs,
        });
        return { content: [{ type: 'text', text: 'say dispatched' }] };
      },
    );

    this.mcp.registerTool(
      'look_at_screen',
      {
        title: '把桌寵視線指向螢幕座標',
        description:
          '將桌寵的視線（lookAt）指向螢幕邏輯座標（x, y）。v1 暫不實作實際 lookAt 控制，僅記錄事件供未來 v0.5 攝影機追蹤接收。',
        inputSchema: {
          x: z.number().describe('螢幕邏輯像素 X'),
          y: z.number().describe('螢幕邏輯像素 Y'),
        },
      },
      (args) => {
        this.dispatch({ kind: 'look_at_screen', x: args.x, y: args.y });
        return { content: [{ type: 'text', text: 'look_at_screen dispatched' }] };
      },
    );
  }

  /** 把 action 廣播到所有 BrowserWindow renderer */
  private dispatch(action: MascotAction): void {
    const id = randomUUID();
    for (const win of this.getWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send('mascot_action', { id, ...action });
    }
  }
}
