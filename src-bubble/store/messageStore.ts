/**
 * Bubble message store（zustand）。
 *
 * 與 my-agent web/src/store/messageStore.ts 同型別，差別：
 * - 桌寵氣泡只顯示一個對話 → 不需要 `bySession[sessionId]`，直接維護
 *   單一 `messages: UiMessage[]`
 * - daemon 直連協定的 sessionId 我們仍記錄，方便重連時 reset
 */
import { create } from 'zustand';

export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; collapsed?: boolean }
  | {
      kind: 'tool_use';
      toolUseID: string;
      toolName: string;
      input: unknown;
      result?: unknown;
      resultIsError?: boolean;
    };

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  source?: string;
  blocks: ContentBlock[];
  inFlight?: boolean;
  startedAt: number;
  endedAt?: number;
  inputId?: string;
}

interface MessageState {
  sessionId: string | null;
  messages: UiMessage[];
  setSessionId(id: string | null): void;
  reset(): void;
  startUserTurn(inputId: string, text: string, source?: string): void;
  startAssistantTurn(inputId: string, startedAt: number): void;
  appendBlock(inputId: string, block: ContentBlock): void;
  appendTextDelta(inputId: string, blockIndex: number, delta: string): void;
  appendThinkingDelta(inputId: string, blockIndex: number, delta: string): void;
  setToolResult(toolUseID: string, result: unknown, isError: boolean): void;
  replaceAssistantBlocks(inputId: string, blocks: ContentBlock[]): void;
  endTurn(inputId: string, endedAt: number): void;
}

export const useMessageStore = create<MessageState>((set) => ({
  sessionId: null,
  messages: [],
  setSessionId: (id) => set({ sessionId: id }),
  reset: () => set({ messages: [] }),

  startUserTurn: (inputId, text, source) =>
    set((s) => ({
      messages: [
        ...s.messages,
        {
          id: `user-${inputId}`,
          role: 'user',
          source,
          inputId,
          blocks: [{ kind: 'text', text }],
          startedAt: Date.now(),
        },
      ],
    })),

  startAssistantTurn: (inputId, startedAt) =>
    set((s) => {
      // 防重：相同 inputId 已有 assistant 訊息就跳過
      if (s.messages.some((m) => m.role === 'assistant' && m.inputId === inputId)) {
        return s;
      }
      return {
        messages: [
          ...s.messages,
          {
            id: `asst-${inputId}`,
            role: 'assistant',
            inputId,
            blocks: [],
            inFlight: true,
            startedAt,
          },
        ],
      };
    }),

  appendBlock: (inputId, block) =>
    set((s) => {
      const arr = [...s.messages];
      const idx = arr.findIndex((m) => m.role === 'assistant' && m.inputId === inputId);
      if (idx < 0) return s;
      arr[idx] = { ...arr[idx]!, blocks: [...arr[idx]!.blocks, block] };
      return { messages: arr };
    }),

  appendTextDelta: (inputId, blockIndex, delta) =>
    set((s) => {
      const arr = [...s.messages];
      const idx = arr.findIndex((m) => m.role === 'assistant' && m.inputId === inputId);
      if (idx < 0) return s;
      const blocks = [...arr[idx]!.blocks];
      const b = blocks[blockIndex];
      if (!b || b.kind !== 'text') return s;
      blocks[blockIndex] = { kind: 'text', text: b.text + delta };
      arr[idx] = { ...arr[idx]!, blocks };
      return { messages: arr };
    }),

  appendThinkingDelta: (inputId, blockIndex, delta) =>
    set((s) => {
      const arr = [...s.messages];
      const idx = arr.findIndex((m) => m.role === 'assistant' && m.inputId === inputId);
      if (idx < 0) return s;
      const blocks = [...arr[idx]!.blocks];
      const b = blocks[blockIndex];
      if (!b || b.kind !== 'thinking') return s;
      blocks[blockIndex] = {
        kind: 'thinking',
        text: b.text + delta,
        collapsed: b.collapsed,
      };
      arr[idx] = { ...arr[idx]!, blocks };
      return { messages: arr };
    }),

  setToolResult: (toolUseID, result, isError) =>
    set((s) => {
      const arr = [...s.messages];
      let changed = false;
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i]!;
        if (m.role !== 'assistant') continue;
        const blocks = m.blocks.map((b) => {
          if (b.kind === 'tool_use' && b.toolUseID === toolUseID) {
            changed = true;
            return { ...b, result, resultIsError: isError };
          }
          return b;
        });
        if (changed) {
          arr[i] = { ...m, blocks };
          break;
        }
      }
      if (!changed) return s;
      return { messages: arr };
    }),

  replaceAssistantBlocks: (inputId, blocks) =>
    set((s) => {
      const arr = [...s.messages];
      const idx = arr.findIndex((m) => m.role === 'assistant' && m.inputId === inputId);
      if (idx < 0) return s;
      arr[idx] = { ...arr[idx]!, blocks };
      return { messages: arr };
    }),

  endTurn: (inputId, endedAt) =>
    set((s) => {
      const arr = [...s.messages];
      const idx = arr.findIndex((m) => m.role === 'assistant' && m.inputId === inputId);
      if (idx < 0) return s;
      arr[idx] = { ...arr[idx]!, inFlight: false, endedAt };
      return { messages: arr };
    }),
}));
