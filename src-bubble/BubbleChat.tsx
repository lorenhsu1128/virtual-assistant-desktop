import { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { InputBar } from './components/InputBar';
import { MessageList } from './components/MessageList';
import { applyDaemonFrame, pushLocalUserMessage } from './adapter/daemonFrameAdapter';
import { ipc } from '../src/bridge/ElectronIPC';
import type { AgentDaemonInfo, AgentSessionFrame } from '../src/types/agent';

/** 對話氣泡的 React 入口 — 訂閱 IPC events、轉送輸入給 daemon */
export function BubbleChat(): React.ReactElement {
  const [info, setInfo] = useState<AgentDaemonInfo>({
    status: 'offline',
    port: null,
    token: null,
    pid: null,
  });

  useEffect(() => {
    let mounted = true;

    void (async () => {
      const initial = await ipc.agentGetStatus();
      if (mounted) setInfo(initial);
    })();

    const offStatus = ipc.onAgentStatus((next) => {
      if (mounted) setInfo(next);
    });

    const offFrame = ipc.onAgentSessionFrame((frame: AgentSessionFrame) => {
      applyDaemonFrame(frame);
    });

    return () => {
      mounted = false;
      offStatus();
      offFrame();
    };
  }, []);

  const ready = info.status === 'online';
  const isDisabled = info.status === 'disabled';
  const isLoading = info.status === 'starting' || info.status === 'connecting';

  const handleSend = async (text: string): Promise<void> => {
    // 預先 push user message（即時 UI 反應）；inputId 由 daemon 在 turnStart 回，
    // 但本機 user 訊息只需要唯一 key，用 timestamp 即可
    const localId = `local-${Date.now()}`;
    pushLocalUserMessage(localId, text);
    await ipc.agentSendInput(text);
  };

  const handleClose = (): void => {
    window.close();
  };

  const handleEnable = async (): Promise<void> => {
    // M-MASCOT-EMBED Phase 5b：disabled 狀態下提供「直接啟用」按鈕
    await ipc.agentEnable();
  };

  return (
    <div className="bubble-shell">
      <Header status={info.status} onClose={handleClose} />
      {isDisabled ? (
        <DisabledOverlay onEnable={handleEnable} />
      ) : isLoading ? (
        <LoadingOverlay message={info.message ?? 'AI 啟動中…'} />
      ) : (
        <MessageList />
      )}
      <InputBar disabled={!ready} onSend={handleSend} />
    </div>
  );
}

interface DisabledOverlayProps {
  onEnable: () => void;
}
function DisabledOverlay({ onEnable }: DisabledOverlayProps): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        AI 助理尚未啟用
      </p>
      <button
        type="button"
        onClick={onEnable}
        className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        立即啟用（載入 LLM）
      </button>
      <p className="text-[10px] text-muted-foreground">
        需先在 設定 → Agent 指定 GGUF 模型路徑
      </p>
    </div>
  );
}

interface LoadingOverlayProps {
  message: string;
}
function LoadingOverlay({ message }: LoadingOverlayProps): React.ReactElement {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <div className="h-6 w-6 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
      <p className="text-sm text-amber-300">{message}</p>
    </div>
  );
}
