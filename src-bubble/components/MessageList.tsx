import { useEffect, useRef } from 'react';
import { useMessageStore } from '../store/messageStore';
import { MessageItem } from './MessageItem';

/** 訊息列表 — 自動捲到底（沿用 my-agent web/MessageList 行為） */
export function MessageList(): React.ReactElement {
  const messages = useMessageStore((s) => s.messages);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto py-2">
      {messages.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          開始與 Agent 對話
        </div>
      ) : (
        messages.map((m) => <MessageItem key={m.id} message={m} />)
      )}
    </div>
  );
}
