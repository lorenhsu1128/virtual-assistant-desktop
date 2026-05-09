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

  return (
    <div className="bubble-shell">
      <Header status={info.status} onClose={handleClose} />
      <MessageList />
      <InputBar disabled={!ready} onSend={handleSend} />
    </div>
  );
}
