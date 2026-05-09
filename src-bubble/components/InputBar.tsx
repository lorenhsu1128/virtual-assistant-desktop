import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { cn } from '../lib/utils';

export interface InputBarProps {
  disabled?: boolean;
  onSend: (text: string) => void;
}

/** 簡化版 InputBar — 桌寵不需要 slash autocomplete / @file picker */
export function InputBar({ disabled, onSend }: InputBarProps): React.ReactElement {
  const [text, setText] = useState('');

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handleSubmit = (e: FormEvent): void => {
    e.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="bubble-no-drag flex flex-col gap-2 border-t border-border bg-background/30 p-2"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={2}
        placeholder="輸入訊息，Enter 送出（Shift+Enter 換行）"
        className={cn(
          'resize-none rounded-md border border-border px-3 py-2 text-sm outline-none transition-colors',
          'bg-black/40 text-foreground placeholder:text-muted-foreground',
          'focus:border-primary disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={disabled || text.trim().length === 0}
          className={cn(
            'rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-opacity',
            'hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40',
          )}
        >
          送出
        </button>
      </div>
    </form>
  );
}
