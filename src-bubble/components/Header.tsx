import { X } from 'lucide-react';
import { cn } from '../lib/utils';
import type { AgentDaemonStatus } from '../../src/types/agent';

const statusColor: Record<AgentDaemonStatus, string> = {
  online: 'text-emerald-400 bg-emerald-400/15',
  starting: 'text-amber-400 bg-amber-400/15',
  connecting: 'text-amber-400 bg-amber-400/15',
  offline: 'text-rose-400 bg-rose-400/15',
  disabled: 'text-muted-foreground bg-muted/40',
  error: 'text-rose-400 bg-rose-400/15',
};

export interface HeaderProps {
  status: AgentDaemonStatus;
  onClose: () => void;
}

export function Header({ status, onClose }: HeaderProps): React.ReactElement {
  return (
    <header className="bubble-drag flex h-9 items-center gap-2 border-b border-border bg-background/40 px-3">
      <span className="flex-1 text-xs font-semibold text-muted-foreground">Agent</span>
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
          statusColor[status],
        )}
      >
        {status}
      </span>
      <button
        type="button"
        onClick={onClose}
        className="bubble-no-drag rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title="隱藏"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </header>
  );
}
