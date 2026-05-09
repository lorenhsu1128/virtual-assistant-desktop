import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyDaemonFrame,
  pushLocalUserMessage,
} from '../../src-bubble/adapter/daemonFrameAdapter';
import { useMessageStore } from '../../src-bubble/store/messageStore';

/**
 * 測試 daemon 直連 ws frame → messageStore 的翻譯邏輯。
 *
 * 對應 P1.5-C — 確保 RunnerEvent wrapper 解析、SDK assistant message
 * 的 text/thinking/tool_use 拆解、stream_event 增量等同 my-agent web
 * useTurnEvents.ts 的行為。
 */
describe('daemonFrameAdapter.applyDaemonFrame', () => {
  beforeEach(() => {
    useMessageStore.setState({ sessionId: null, messages: [] });
  });

  describe('hello', () => {
    it('sets sessionId and resets messages', () => {
      // 預先有訊息與 session
      useMessageStore.getState().setSessionId('old');
      useMessageStore.getState().startUserTurn('i0', 'stale');
      applyDaemonFrame({ type: 'hello', sessionId: 'new', state: 'IDLE' });
      expect(useMessageStore.getState().sessionId).toBe('new');
      expect(useMessageStore.getState().messages).toEqual([]);
    });
  });

  describe('turnStart', () => {
    it('opens an inflight assistant message', () => {
      applyDaemonFrame({
        type: 'turnStart',
        inputId: 'i1',
        startedAt: 100,
        source: 'mascot',
      });
      const m = useMessageStore.getState().messages;
      expect(m).toHaveLength(1);
      expect(m[0]?.role).toBe('assistant');
      expect(m[0]?.inFlight).toBe(true);
      expect(m[0]?.startedAt).toBe(100);
    });
  });

  describe('runnerEvent — output / assistant', () => {
    function setupTurn(): void {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
    }

    it('extracts text block from final assistant SDK message', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'hello world' }],
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      expect(blocks).toEqual([{ kind: 'text', text: 'hello world' }]);
    });

    it('extracts thinking block', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'pondering...' }],
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      expect(blocks[0]).toMatchObject({ kind: 'thinking', text: 'pondering...' });
    });

    it('extracts tool_use block', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_use',
                  id: 't1',
                  name: 'CronList',
                  input: { foo: 'bar' },
                },
              ],
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      expect(blocks[0]).toMatchObject({
        kind: 'tool_use',
        toolUseID: 't1',
        toolName: 'CronList',
        input: { foo: 'bar' },
      });
    });

    it('handles content as plain string', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: 'plain string content',
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      expect(blocks).toEqual([{ kind: 'text', text: 'plain string content' }]);
    });

    it('parses tool_result inside assistant message and updates earlier tool_use', () => {
      setupTurn();
      // 先有 tool_use
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 't1', name: 'X', input: {} },
              ],
            },
          },
        },
      });
      // 後續 assistant 帶 tool_result（以 SDK 的 user role 也可能但這裡測 assistant 攜帶）
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'assistant',
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 't1',
                  content: 'success',
                  is_error: false,
                },
              ],
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      const toolBlock = blocks.find(
        (b) => b.kind === 'tool_use' && b.toolUseID === 't1',
      ) as { result: unknown; resultIsError: boolean } | undefined;
      expect(toolBlock?.result).toBe('success');
      expect(toolBlock?.resultIsError).toBe(false);
    });
  });

  describe('runnerEvent — output / stream_event', () => {
    function setupTurn(): void {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
    }

    it('content_block_start text creates an empty text block', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text' },
            },
          },
        },
      });
      const blocks = useMessageStore.getState().messages[0]!.blocks;
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({ kind: 'text', text: '' });
    });

    it('content_block_delta text_delta accumulates text', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text' },
            },
          },
        },
      });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'hi' },
            },
          },
        },
      });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: ' there' },
            },
          },
        },
      });
      const block = useMessageStore.getState().messages[0]!.blocks[0] as {
        text: string;
      };
      expect(block.text).toBe('hi there');
    });

    it('content_block_delta thinking_delta accumulates thinking', () => {
      setupTurn();
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking' },
            },
          },
        },
      });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'step1' },
            },
          },
        },
      });
      const block = useMessageStore.getState().messages[0]!.blocks[0] as {
        text: string;
      };
      expect(block.text).toBe('step1');
    });
  });

  describe('runnerEvent — payload to skip', () => {
    it('ignores output / system payload', () => {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: { type: 'system', subtype: 'init', tools: [] },
        },
      });
      // 不應 crash 也不應改變 blocks
      expect(useMessageStore.getState().messages[0]!.blocks).toHaveLength(0);
    });

    it('ignores output / result payload', () => {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: {
          type: 'output',
          payload: { type: 'result', subtype: 'success', is_error: false },
        },
      });
      expect(useMessageStore.getState().messages[0]!.blocks).toHaveLength(0);
    });

    it('ignores non-output runner event wrapper (done / error)', () => {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: { type: 'done' },
      });
      applyDaemonFrame({
        type: 'runnerEvent',
        inputId: 'i1',
        event: { type: 'error', error: 'boom' },
      });
      // P1.5 不在 adapter 處理 done/error；turnEnd 才收尾
      expect(useMessageStore.getState().messages[0]!.blocks).toHaveLength(0);
    });
  });

  describe('turnEnd', () => {
    it('finalizes assistant turn', () => {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
      applyDaemonFrame({
        type: 'turnEnd',
        inputId: 'i1',
        endedAt: 999,
        reason: 'done',
      });
      const m = useMessageStore.getState().messages[0]!;
      expect(m.inFlight).toBe(false);
      expect(m.endedAt).toBe(999);
    });
  });

  describe('robustness', () => {
    it('does not throw on unknown frame type', () => {
      expect(() => applyDaemonFrame({ type: 'mystery' })).not.toThrow();
    });

    it('does not throw on malformed runnerEvent', () => {
      applyDaemonFrame({ type: 'turnStart', inputId: 'i1', startedAt: 0 });
      expect(() =>
        applyDaemonFrame({
          type: 'runnerEvent',
          inputId: 'i1',
          event: 'not an object',
        }),
      ).not.toThrow();
    });

    it('does not throw on runnerEvent without inputId', () => {
      expect(() =>
        applyDaemonFrame({
          type: 'runnerEvent',
          event: { type: 'output', payload: { type: 'assistant' } },
        }),
      ).not.toThrow();
    });
  });
});

describe('pushLocalUserMessage', () => {
  beforeEach(() => {
    useMessageStore.setState({ sessionId: null, messages: [] });
  });

  it('appends a local user message with mascot source', () => {
    pushLocalUserMessage('local-1', 'hi');
    const m = useMessageStore.getState().messages;
    expect(m).toHaveLength(1);
    expect(m[0]?.role).toBe('user');
    expect(m[0]?.source).toBe('mascot');
    expect(m[0]?.blocks).toEqual([{ kind: 'text', text: 'hi' }]);
  });
});
