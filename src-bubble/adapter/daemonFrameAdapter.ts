/**
 * 把 my-agent daemon 直連 ws frame（含 hello / turnStart / runnerEvent / turnEnd）
 * 翻譯成 messageStore actions。
 *
 * **與 my-agent web/src/hooks/useTurnEvents.ts 的對照**：
 * - web 那端的 frame 是 `turn.start` / `turn.event` / `turn.end`（命名空間化）
 * - 我們直連 daemon 拿到的是 `turnStart` / `runnerEvent` / `turnEnd`
 * - 兩種協定的 `event` 內容（RunnerEvent wrapper + SDK message）完全一致，
 *   所以 SDK 解析邏輯（extractBlocksFromAssistant / applyStreamEvent）
 *   可以直接照搬。
 *
 * ## RunnerEvent 解析策略（沿用 web/useTurnEvents.ts）
 *
 * 1. `e.event = { type: 'output' | 'error' | 'done', ... }` — 只處理 'output'
 * 2. `payload = e.event.payload` 是 SDK message：
 *    - `payload.type === 'assistant'` → final content；replace blocks（避免與
 *      stream delta 重複）
 *    - `payload.type === 'stream_event'` → 增量 delta；text_delta /
 *      thinking_delta 累加到對應 blockIndex
 *    - `payload.type === 'system' / 'result'` → 略過
 */

import { useMessageStore, type ContentBlock } from '../store/messageStore';

// ── SDK message 型別（鏡像 my-agent web/src/hooks/useTurnEvents.ts）──

interface SdkContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | string;
  text?: string;
  thinking?: string;
  id?: string; // tool_use
  name?: string; // tool_use
  input?: unknown; // tool_use
  tool_use_id?: string; // tool_result
  content?: unknown; // tool_result
  is_error?: boolean; // tool_result
}

interface SdkAssistantMessage {
  type: 'assistant';
  message?: {
    role: 'assistant';
    content: SdkContentBlock[] | string;
  };
}

interface SdkStreamEvent {
  type: 'stream_event';
  event?: {
    type: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
    content_block?: {
      type: 'text' | 'thinking' | 'tool_use';
      text?: string;
      thinking?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
  };
}

interface RunnerOutputEvent {
  type: 'output';
  payload?: unknown;
}

function isRunnerOutput(e: unknown): e is RunnerOutputEvent {
  if (!e || typeof e !== 'object') return false;
  return (e as { type?: unknown }).type === 'output';
}

function isAssistantSdk(p: unknown): p is SdkAssistantMessage {
  if (!p || typeof p !== 'object') return false;
  return (p as { type?: unknown }).type === 'assistant';
}

function isStreamSdk(p: unknown): p is SdkStreamEvent {
  if (!p || typeof p !== 'object') return false;
  return (p as { type?: unknown }).type === 'stream_event';
}

function extractBlocksFromAssistant(msg: SdkAssistantMessage): {
  blocks: ContentBlock[];
  toolResults: { toolUseID: string; result: unknown; isError: boolean }[];
} {
  const blocks: ContentBlock[] = [];
  const toolResults: { toolUseID: string; result: unknown; isError: boolean }[] = [];
  const content = msg.message?.content;
  if (typeof content === 'string') {
    blocks.push({ kind: 'text', text: content });
    return { blocks, toolResults };
  }
  if (!Array.isArray(content)) return { blocks, toolResults };
  for (const c of content) {
    if (c.type === 'text' && typeof c.text === 'string') {
      blocks.push({ kind: 'text', text: c.text });
    } else if (c.type === 'thinking' && typeof c.thinking === 'string') {
      blocks.push({ kind: 'thinking', text: c.thinking, collapsed: true });
    } else if (c.type === 'tool_use' && typeof c.id === 'string') {
      blocks.push({
        kind: 'tool_use',
        toolUseID: c.id,
        toolName: c.name ?? '(unknown tool)',
        input: c.input,
      });
    } else if (c.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      toolResults.push({
        toolUseID: c.tool_use_id,
        result: c.content,
        isError: c.is_error === true,
      });
    }
  }
  return { blocks, toolResults };
}

function applyStreamEvent(inputId: string, ev: SdkStreamEvent['event']): void {
  if (!ev) return;
  const store = useMessageStore.getState();
  if (ev.type === 'content_block_start' && ev.content_block) {
    const cb = ev.content_block;
    if (cb.type === 'text') {
      store.appendBlock(inputId, { kind: 'text', text: cb.text ?? '' });
    } else if (cb.type === 'thinking') {
      store.appendBlock(inputId, {
        kind: 'thinking',
        text: cb.thinking ?? '',
        collapsed: false,
      });
    } else if (cb.type === 'tool_use' && typeof cb.id === 'string') {
      store.appendBlock(inputId, {
        kind: 'tool_use',
        toolUseID: cb.id,
        toolName: cb.name ?? '(unknown tool)',
        input: cb.input,
      });
    }
    return;
  }
  if (ev.type === 'content_block_delta' && ev.delta && ev.index !== undefined) {
    const dt = ev.delta.type;
    if (dt === 'text_delta' && typeof ev.delta.text === 'string') {
      store.appendTextDelta(inputId, ev.index, ev.delta.text);
    } else if (dt === 'thinking_delta' && typeof ev.delta.thinking === 'string') {
      store.appendThinkingDelta(inputId, ev.index, ev.delta.thinking);
    }
    // input_json_delta 累積：等 final assistant 一次蓋過
  }
  // content_block_stop / message_start / message_stop 不需處理
}

/**
 * 處理一個從 daemon 直連 ws 收到的 frame。
 * 由 BubbleApp 在 `onAgentSessionFrame` callback 中呼叫。
 */
export function applyDaemonFrame(frame: { type?: string; [key: string]: unknown }): void {
  const store = useMessageStore.getState();

  switch (frame.type) {
    case 'hello':
      // 新 session — reset UI 重新開始
      store.setSessionId((frame.sessionId as string) ?? null);
      store.reset();
      break;

    case 'turnStart': {
      const inputId = frame.inputId as string | undefined;
      const startedAt = (frame.startedAt as number | undefined) ?? Date.now();
      if (inputId) store.startAssistantTurn(inputId, startedAt);
      break;
    }

    case 'runnerEvent': {
      const inputId = frame.inputId as string | undefined;
      const event = frame.event;
      if (!inputId || !isRunnerOutput(event)) return;
      const payload = (event as RunnerOutputEvent).payload;
      if (isStreamSdk(payload)) {
        applyStreamEvent(inputId, payload.event);
        return;
      }
      if (isAssistantSdk(payload)) {
        const { blocks, toolResults } = extractBlocksFromAssistant(payload);
        if (blocks.length > 0) {
          store.replaceAssistantBlocks(inputId, blocks);
        }
        for (const tr of toolResults) {
          store.setToolResult(tr.toolUseID, tr.result, tr.isError);
        }
        return;
      }
      // payload.type === 'system' | 'result' | 其他 → 略過
      break;
    }

    case 'turnEnd': {
      const inputId = frame.inputId as string | undefined;
      const endedAt = (frame.endedAt as number | undefined) ?? Date.now();
      if (inputId) store.endTurn(inputId, endedAt);
      break;
    }

    // hello / state / keep_alive / projectLoading / permission* 在 P1 不處理
    default:
      break;
  }
}

/** 使用者送 input 時本地預先 push 一筆 user message（不等 daemon echo） */
export function pushLocalUserMessage(inputId: string, text: string): void {
  const store = useMessageStore.getState();
  store.startUserTurn(inputId, text, 'mascot');
}
