import { describe, it, expect, beforeEach } from 'vitest';
import { useMessageStore } from '../../src-bubble/store/messageStore';

/**
 * 測試 src-bubble 的 zustand message store。
 *
 * 對應 P1.5-C — 為從 my-agent web 移植進來的 UiMessage 模型 + state 操作做迴歸保護。
 *
 * 每個 test 開頭都 reset，避免 zustand 全域 state 跨 test 殘留。
 */
describe('bubble messageStore', () => {
  beforeEach(() => {
    useMessageStore.setState({ sessionId: null, messages: [] });
  });

  it('starts with empty state', () => {
    expect(useMessageStore.getState().sessionId).toBeNull();
    expect(useMessageStore.getState().messages).toEqual([]);
  });

  describe('setSessionId / reset', () => {
    it('setSessionId updates id without touching messages', () => {
      useMessageStore.getState().setSessionId('s1');
      expect(useMessageStore.getState().sessionId).toBe('s1');
    });

    it('reset clears messages but keeps sessionId', () => {
      const s = useMessageStore.getState();
      s.setSessionId('s1');
      s.startUserTurn('i1', 'hi');
      s.reset();
      expect(useMessageStore.getState().messages).toEqual([]);
      expect(useMessageStore.getState().sessionId).toBe('s1');
    });
  });

  describe('startUserTurn', () => {
    it('appends a user message with text block', () => {
      useMessageStore.getState().startUserTurn('i1', 'hello', 'mascot');
      const m = useMessageStore.getState().messages;
      expect(m).toHaveLength(1);
      expect(m[0]?.role).toBe('user');
      expect(m[0]?.source).toBe('mascot');
      expect(m[0]?.blocks).toEqual([{ kind: 'text', text: 'hello' }]);
      expect(m[0]?.inputId).toBe('i1');
    });

    it('multiple user turns accumulate in order', () => {
      const s = useMessageStore.getState();
      s.startUserTurn('i1', 'first');
      s.startUserTurn('i2', 'second');
      const m = useMessageStore.getState().messages;
      expect(m).toHaveLength(2);
      expect((m[0]!.blocks[0] as { text: string }).text).toBe('first');
      expect((m[1]!.blocks[0] as { text: string }).text).toBe('second');
    });
  });

  describe('startAssistantTurn', () => {
    it('appends inflight assistant message with empty blocks', () => {
      useMessageStore.getState().startAssistantTurn('i1', 100);
      const m = useMessageStore.getState().messages;
      expect(m).toHaveLength(1);
      expect(m[0]?.role).toBe('assistant');
      expect(m[0]?.inFlight).toBe(true);
      expect(m[0]?.blocks).toEqual([]);
      expect(m[0]?.startedAt).toBe(100);
    });

    it('dedupes when same inputId arrives again', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 100);
      s.startAssistantTurn('i1', 200); // 重複 inputId
      expect(useMessageStore.getState().messages).toHaveLength(1);
    });
  });

  describe('appendBlock', () => {
    it('appends a text block to the matching assistant turn', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'text', text: 'hi' });
      const m = useMessageStore.getState().messages[0]!;
      expect(m.blocks).toEqual([{ kind: 'text', text: 'hi' }]);
    });

    it('does nothing for unknown inputId', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('unknown', { kind: 'text', text: 'lost' });
      expect(useMessageStore.getState().messages[0]!.blocks).toHaveLength(0);
    });
  });

  describe('appendTextDelta', () => {
    it('accumulates text into existing text block', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'text', text: '' });
      s.appendTextDelta('i1', 0, 'hel');
      s.appendTextDelta('i1', 0, 'lo');
      const m = useMessageStore.getState().messages[0]!;
      expect((m.blocks[0] as { text: string }).text).toBe('hello');
    });

    it('does not touch non-text block', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'thinking', text: 'pondering' });
      s.appendTextDelta('i1', 0, 'should-not-stick');
      const m = useMessageStore.getState().messages[0]!;
      expect((m.blocks[0] as { kind: string }).kind).toBe('thinking');
      expect((m.blocks[0] as { text: string }).text).toBe('pondering');
    });
  });

  describe('appendThinkingDelta', () => {
    it('accumulates thinking text', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'thinking', text: '' });
      s.appendThinkingDelta('i1', 0, 'step ');
      s.appendThinkingDelta('i1', 0, 'one');
      const m = useMessageStore.getState().messages[0]!;
      expect((m.blocks[0] as { text: string }).text).toBe('step one');
    });
  });

  describe('setToolResult', () => {
    it('updates the matching tool_use block result', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', {
        kind: 'tool_use',
        toolUseID: 't1',
        toolName: 'CronList',
        input: { foo: 'bar' },
      });
      s.setToolResult('t1', { output: 'ok' }, false);
      const block = useMessageStore.getState().messages[0]!.blocks[0] as {
        result: unknown;
        resultIsError: boolean;
      };
      expect(block.result).toEqual({ output: 'ok' });
      expect(block.resultIsError).toBe(false);
    });

    it('marks isError=true correctly', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', {
        kind: 'tool_use',
        toolUseID: 't1',
        toolName: 'X',
        input: {},
      });
      s.setToolResult('t1', 'oops', true);
      const block = useMessageStore.getState().messages[0]!.blocks[0] as {
        resultIsError: boolean;
      };
      expect(block.resultIsError).toBe(true);
    });

    it('does nothing if toolUseID not found', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'text', text: 'x' });
      s.setToolResult('nonexistent', null, false);
      // 沒有 throw、blocks 沒變化
      expect(useMessageStore.getState().messages[0]!.blocks).toHaveLength(1);
    });
  });

  describe('replaceAssistantBlocks', () => {
    it('overwrites blocks of matching assistant turn', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 0);
      s.appendBlock('i1', { kind: 'text', text: 'partial' });
      s.replaceAssistantBlocks('i1', [
        { kind: 'text', text: 'final' },
        { kind: 'thinking', text: 'reasoning' },
      ]);
      const m = useMessageStore.getState().messages[0]!;
      expect(m.blocks).toHaveLength(2);
      expect((m.blocks[0] as { text: string }).text).toBe('final');
    });
  });

  describe('endTurn', () => {
    it('marks inFlight=false and sets endedAt', () => {
      const s = useMessageStore.getState();
      s.startAssistantTurn('i1', 100);
      s.endTurn('i1', 500);
      const m = useMessageStore.getState().messages[0]!;
      expect(m.inFlight).toBe(false);
      expect(m.endedAt).toBe(500);
    });
  });
});
