/**
 * mascotTools — 4 個桌寵 mascot tool 的 my-agent Tool 定義。
 *
 * 取代 MascotMcpServer 走 HTTP MCP 反向控制的路徑（M-MASCOT-EMBED Phase 5）：
 * 直接以 my-agent ToolDef 形式注入 AgentEmbedded.create() 的 extraTools，
 * LLM tool call 時觸發 dispatch callback → 桌寵 main process IPC 廣播。
 *
 * 與 MascotMcpServer 行為完全相同（4 個 tool、schema 一致、dispatch payload
 * 相同 MascotAction shape），只是執行 transport 從 HTTP MCP 改為 in-process 函式呼叫。
 *
 * 注意：opt-in daemon WS server 啟用時，MascotMcpServer 仍會獨立提供同 4 個 tool
 * 給外部 my-agent CLI / web client 連入時用 — 兩條路徑共存（保留全功能原則）。
 *
 * @see AgentRuntime.ts — 注入 dispatchAction callback
 * @see MascotMcpServer.ts — HTTP MCP server 版本（給 opt-in daemon 模式用）
 * @see src/agent/MascotActionDispatcher.ts — renderer 端 mascot_action 接收
 */
import { z } from 'zod';
import type { Tool } from '../../vendor/my-agent/dist-embedded/index.js';
import type { MascotAction } from './MascotMcpServer.js';

/**
 * 注意：MascotMcpServer 內的 `MascotAction` 沒有 `id` 欄位；id 是
 * AgentRuntime.dispatchMascotAction broadcast 時補上（與舊 HTTP MCP
 * server 流程一致）。
 */
type DispatchActionFn = (action: MascotAction) => void;

/**
 * 建立 4 個 mascot tool。任何一個被 LLM 呼叫時，會用 `dispatchAction` callback
 * 把 `MascotAction` 傳出去（caller 應廣播為 IPC `mascot_action`）。
 */
export function buildMascotTools(dispatchAction: DispatchActionFn): Tool[] {
  return [
    buildSetExpressionTool(dispatchAction),
    buildPlayAnimationTool(dispatchAction),
    buildSayTool(dispatchAction),
    buildLookAtScreenTool(dispatchAction),
  ];
}

// ── 個別 tool 工廠 ───────────────────────────────────────────────────────

function buildSetExpressionTool(dispatchAction: DispatchActionFn): Tool {
  const inputSchema = z.object({
    name: z
      .string()
      .describe('VRM 表情名稱，常見：joy / angry / sorrow / fun / neutral / surprised / hehe'),
    durationMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('表情持續毫秒數，過後回到自動模式；不填表示永久維持手動表情'),
  });
  type Input = z.infer<typeof inputSchema>;

  return makeMinimalTool<Input>({
    name: 'set_expression',
    description: () =>
      '把桌寵的 BlendShape 表情切換為指定名稱（如 joy / angry / sorrow / fun / surprised / hehe 等）。覆蓋自動表情輪播。',
    inputSchema,
    call: async (input) => {
      dispatchAction({
        kind: 'set_expression',
        name: input.name,
        durationMs: input.durationMs,
      });
      return {
        data: { ok: true } as unknown,
        resultForAssistant: `set_expression(${input.name}) dispatched`,
      };
    },
  });
}

function buildPlayAnimationTool(dispatchAction: DispatchActionFn): Tool {
  const inputSchema = z.object({
    category: z
      .enum(['idle', 'action', 'sit', 'fall', 'collide', 'peek'])
      .optional()
      .describe('動畫分類；若不指定 name 則從該分類隨機挑'),
    name: z.string().optional().describe('動畫檔名（如 SYS_WAVE_01.vrma）'),
  });
  type Input = z.infer<typeof inputSchema>;

  return makeMinimalTool<Input>({
    name: 'play_animation',
    description: () =>
      '播放一段 .vrma 動畫。可指定 category（idle / action / sit / fall / collide / peek）讓系統挑選，或指定具體 name（檔名）。',
    inputSchema,
    call: async (input) => {
      if (!input.category && !input.name) {
        return {
          data: { ok: false } as unknown,
          resultForAssistant: 'error: must provide either category or name',
        };
      }
      dispatchAction({
        kind: 'play_animation',
        category: input.category,
        name: input.name,
      });
      return {
        data: { ok: true } as unknown,
        resultForAssistant: `play_animation(category=${input.category ?? '-'}, name=${input.name ?? '-'}) dispatched`,
      };
    },
  });
}

function buildSayTool(dispatchAction: DispatchActionFn): Tool {
  const inputSchema = z.object({
    text: z.string().describe('要顯示的文字'),
    autoDismissMs: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('幾毫秒後自動消失；不填表示常駐'),
  });
  type Input = z.infer<typeof inputSchema>;

  return makeMinimalTool<Input>({
    name: 'say',
    description: () =>
      '把一段話即時推到桌寵對話氣泡（與 LLM 回應分開的獨立輔助訊息）。',
    inputSchema,
    call: async (input) => {
      dispatchAction({
        kind: 'say',
        text: input.text,
        autoDismissMs: input.autoDismissMs,
      });
      return {
        data: { ok: true } as unknown,
        resultForAssistant: 'say dispatched',
      };
    },
  });
}

function buildLookAtScreenTool(dispatchAction: DispatchActionFn): Tool {
  const inputSchema = z.object({
    x: z.number().describe('螢幕邏輯像素 X'),
    y: z.number().describe('螢幕邏輯像素 Y'),
  });
  type Input = z.infer<typeof inputSchema>;

  return makeMinimalTool<Input>({
    name: 'look_at_screen',
    description: () =>
      '將桌寵的視線（lookAt）指向螢幕邏輯座標（x, y）。v1 暫不實作實際 lookAt 控制，僅記錄事件供未來 v0.5 攝影機追蹤接收。',
    inputSchema,
    call: async (input) => {
      dispatchAction({
        kind: 'look_at_screen',
        x: input.x,
        y: input.y,
      });
      return {
        data: { ok: true } as unknown,
        resultForAssistant: 'look_at_screen dispatched',
      };
    },
  });
}

// ── 共用 tool builder（避免每個 tool 重複填 Tool 介面的全部欄位） ─────────

interface MinimalToolDef<Input> {
  name: string;
  description: () => string;
  inputSchema: z.ZodType<Input>;
  call: (input: Input) => Promise<{
    data: unknown;
    resultForAssistant: string;
  }>;
}

/**
 * 用最小化定義建立 my-agent Tool；填上桌寵側不關心的 defaults。
 *
 * 不直接 `import { buildTool } from '...vendor/my-agent...'` 是因為 buildTool
 * 在 dist-embedded 不一定 export；我們手動填上需要的 default 即可。
 */
function makeMinimalTool<Input>(def: MinimalToolDef<Input>): Tool {
  const tool = {
    name: def.name,
    inputSchema: def.inputSchema,
    description: async () => def.description(),
    // my-agent Tool 介面要求 prompt() 回傳給 LLM 的 system prompt 內 tool 描述
    // （見 vendor/my-agent/src/Tool.ts:518）。description 與 prompt 內容相同即可。
    prompt: async () => def.description(),
    isEnabled: () => true,
    isConcurrencySafe: () => false,
    isReadOnly: () => true,
    isDestructive: () => false,
    userFacingName: () => def.name,
    checkPermissions: async (input: Input) => ({
      behavior: 'allow' as const,
      updatedInput: input as unknown as Record<string, unknown>,
    }),
    toAutoClassifierInput: () => '',
    async call(args: Input) {
      const result = await def.call(args);
      return {
        // ToolResult 的標準欄位（my-agent 內部）
        data: result.data,
        resultForAssistant: result.resultForAssistant,
      };
    },
  } as unknown as Tool;
  return tool;
}
