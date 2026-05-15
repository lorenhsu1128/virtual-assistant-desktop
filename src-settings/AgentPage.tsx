/**
 * AgentPage — my-agent 整合設定（M-MASCOT-EMBED Phase 5b 改版）。
 *
 * 主要區塊：
 * - **Master toggle**：啟用 AI 助理（撥動立即 enable/disable，自動觸發 LLM preload/釋放）
 * - **LLM section**：GGUF 模型路徑 / context size / GPU layers / external URL
 * - **Opt-in daemon**：啟動 WS server 給外部 my-agent CLI 連入（Phase 5c 補完）
 * - **Opt-in web UI**：啟動 HTTP server 給瀏覽器存取（Phase 4b 補完 Node http parity 後啟用）
 * - **Workspace cwd 覆寫**（dev / 進階使用者）
 *
 * 狀態徽章使用新的 AgentRuntimeStatus（state machine：
 * disabled / preloading / standby / active / unloading / error）。
 * 透過 `ipc.onLlmStatusChanged` 接收即時更新。
 */
import { useEffect, useMemo, useState } from 'react';
import { ipc } from '../src/bridge/ElectronIPC';
import type { AgentConfig } from '../src/types/config';
import { Switch } from './ui/switch';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from './lib/utils';

// 與 electron/agent/AgentRuntime.ts 的 AgentRuntimeStatus 對齊
type RuntimeState =
  | 'disabled'
  | 'preloading'
  | 'standby'
  | 'active'
  | 'unloading'
  | 'error';

interface RuntimeStatus {
  state: RuntimeState;
  progress?: number; // 0..1 preloading 時
  phase?: string; // preloading 時的 phase
  turnId?: string; // active 時
  message?: string; // error / phase message
}

const stateBadge: Record<RuntimeState, { text: string; cls: string }> = {
  disabled: { text: 'DISABLED', cls: 'bg-muted text-muted-foreground' },
  preloading: { text: 'LOADING', cls: 'bg-amber-500/20 text-amber-400' },
  standby: { text: 'READY', cls: 'bg-emerald-500/20 text-emerald-400' },
  active: { text: 'THINKING', cls: 'bg-sky-500/20 text-sky-400 animate-pulse' },
  unloading: { text: 'STOPPING', cls: 'bg-amber-500/20 text-amber-400' },
  error: { text: 'ERROR', cls: 'bg-rose-500/20 text-rose-400' },
};

const DEFAULT_AGENT: AgentConfig = {
  enabled: false,
  workspaceCwd: null,
  llm: {
    modelPath: null,
    contextSize: 4096,
    gpuLayers: 'auto',
    externalUrl: null,
  },
  daemon: {
    enabled: false,
    port: 0,
  },
  webUi: {
    enabled: false,
    port: 0,
    bindHost: '127.0.0.1',
    devProxyUrl: null,
  },
  discord: {
    enabled: false,
  },
  daemonMode: 'auto',
  bunBinaryPath: null,
  myAgentCliPath: null,
};

const INITIAL_STATUS: RuntimeStatus = { state: 'disabled' };

export function AgentPage(): React.ReactElement {
  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [status, setStatus] = useState<RuntimeStatus>(INITIAL_STATUS);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 初次載入 + 訂閱 runtime status 更新
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const cfg = await ipc.readConfig();
      if (cfg && mounted) setAgent(cfg.agent ?? DEFAULT_AGENT);
      const rs = (await ipc.agentGetRuntimeStatus()) as RuntimeStatus | null;
      if (mounted && rs) setStatus(rs);
      if (mounted) setLoaded(true);
    })();
    const off = ipc.onLlmStatusChanged((next) => {
      if (mounted) setStatus(next as RuntimeStatus);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  // 在 transition 期間（preloading / unloading）UI 部分鎖定
  const inTransition =
    status.state === 'preloading' || status.state === 'unloading' || busy;

  // 沒指定 LLM 來源 → master toggle 禁用
  const hasLlmSource = !!agent.llm.modelPath || !!agent.llm.externalUrl;

  const updateLlm = <K extends keyof AgentConfig['llm']>(
    key: K,
    value: AgentConfig['llm'][K],
  ): void => {
    setAgent((prev) => ({ ...prev, llm: { ...prev.llm, [key]: value } }));
    setDirty(true);
  };

  const updateDaemon = <K extends keyof AgentConfig['daemon']>(
    key: K,
    value: AgentConfig['daemon'][K],
  ): void => {
    setAgent((prev) => ({ ...prev, daemon: { ...prev.daemon, [key]: value } }));
    setDirty(true);
  };

  const updateWebUi = <K extends keyof AgentConfig['webUi']>(
    key: K,
    value: AgentConfig['webUi'][K],
  ): void => {
    setAgent((prev) => ({ ...prev, webUi: { ...prev.webUi, [key]: value } }));
    setDirty(true);
  };

  const updateField = <K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void => {
    setAgent((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  /** Master toggle handler — 直接觸發 enable/disable IPC，不需另外按套用 */
  const onMasterToggle = async (next: boolean): Promise<void> => {
    if (inTransition) return;
    if (next && !hasLlmSource) {
      // 沒指定模型 → 視覺提示但不嘗試 enable
      setStatus({ state: 'error', message: '請先選擇 GGUF 模型或外部 LLM endpoint' });
      return;
    }
    setBusy(true);
    setAgent((prev) => ({ ...prev, enabled: next }));
    try {
      if (next) {
        const rs = (await ipc.agentEnable()) as RuntimeStatus | null;
        if (rs) setStatus(rs);
        // reviewer M8：enable 失敗 → 回滾 enabled checkbox 與 main 端 config（IPC handler 已回滾）
        if (rs?.state === 'error') {
          setAgent((prev) => ({ ...prev, enabled: false }));
        }
      } else {
        const rs = (await ipc.agentDisable()) as RuntimeStatus | null;
        if (rs) setStatus(rs);
      }
    } catch (e) {
      console.warn('[AgentPage] toggle failed:', e);
      // 例外時也回滾 toggle
      setAgent((prev) => ({ ...prev, enabled: !next }));
    } finally {
      setBusy(false);
    }
  };

  /** 套用 config 變更（會自動 reload LLM 若 enabled） */
  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      const rs = (await ipc.agentApplyConfig(agent)) as unknown;
      // agentApplyConfig 回傳新的 RuntimeStatus（或 disabled state mapping）
      if (rs && typeof rs === 'object' && 'state' in rs) {
        setStatus(rs as RuntimeStatus);
      }
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  /** 重新載入 LLM — 設定模型路徑 / contextSize 等變更後使用 */
  const reloadLlm = async (): Promise<void> => {
    setBusy(true);
    try {
      const rs = (await ipc.agentReloadLlm()) as RuntimeStatus | null;
      if (rs) setStatus(rs);
    } finally {
      setBusy(false);
    }
  };

  const pickModelFile = async (): Promise<void> => {
    const path = await ipc.llmPickModelFile();
    if (path) updateLlm('modelPath', path);
  };

  if (!loaded) {
    return (
      <div className="p-6 text-sm text-muted-foreground">載入設定中…</div>
    );
  }

  const badge = stateBadge[status.state];

  return (
    <div className="flex flex-col gap-5 p-6">
      <Header status={status} badge={badge} />

      {status.state === 'error' && status.message && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
          {status.message}
        </div>
      )}

      {status.state === 'preloading' && (
        <PreloadProgress
          progress={status.progress ?? 0}
          phase={status.phase ?? 'loading'}
        />
      )}

      <MasterToggleSection
        enabled={agent.enabled}
        inTransition={inTransition}
        hasLlmSource={hasLlmSource}
        onToggle={onMasterToggle}
      />

      <LlmSection
        llm={agent.llm}
        updateLlm={updateLlm}
        pickModelFile={pickModelFile}
        canReload={status.state === 'standby' || status.state === 'error'}
        onReload={reloadLlm}
        inTransition={inTransition}
      />

      <DaemonOptInSection
        daemon={agent.daemon}
        updateDaemon={updateDaemon}
      />

      <WebUiOptInSection
        webUi={agent.webUi}
        updateWebUi={updateWebUi}
      />

      <WorkspaceSection
        workspaceCwd={agent.workspaceCwd}
        onChange={(v) => updateField('workspaceCwd', v || null)}
      />

      <footer className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">
          {status.state === 'active' && status.turnId && (
            <>進行中 turn {status.turnId.slice(0, 8)}</>
          )}
          {status.state === 'standby' && '待命中，可開對話氣泡互動'}
          {status.state === 'disabled' && '未啟用，撥動上方 toggle 載入 LLM'}
        </span>
        <Button onClick={apply} disabled={!dirty || busy || inTransition}>
          {busy ? '套用中…' : '套用設定'}
        </Button>
      </footer>
    </div>
  );
}

// ── 子元件 ──────────────────────────────────────────────────────────────

interface HeaderProps {
  status: RuntimeStatus;
  badge: { text: string; cls: string };
}
function Header({ status, badge }: HeaderProps): React.ReactElement {
  return (
    <header className="flex items-center justify-between">
      <div>
        <h2 className="text-lg font-semibold">my-agent 整合</h2>
        <p className="text-xs text-muted-foreground">
          {status.state === 'standby' || status.state === 'active'
            ? '本地 LLM 已載入，桌寵會透過 my-agent 對話 + 觸發表演動作'
            : 'in-process AgentEmbedded — 撥動下方 toggle 載入 LLM 進入待命'}
        </p>
      </div>
      <span
        className={cn(
          'rounded px-2 py-1 text-[10px] font-medium uppercase tracking-wide',
          badge.cls,
        )}
      >
        {badge.text}
      </span>
    </header>
  );
}

interface PreloadProgressProps {
  progress: number;
  phase: string;
}
function PreloadProgress({ progress, phase }: PreloadProgressProps): React.ReactElement {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="text-amber-300">AI 載入中：{phase}</span>
        <span className="font-mono text-amber-300">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full bg-amber-400 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface MasterToggleProps {
  enabled: boolean;
  inTransition: boolean;
  hasLlmSource: boolean;
  onToggle: (next: boolean) => Promise<void>;
}
function MasterToggleSection({
  enabled,
  inTransition,
  hasLlmSource,
  onToggle,
}: MasterToggleProps): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="agent-enabled" className="text-sm">
            啟用 AI 助理功能
          </Label>
          <p className="text-xs text-muted-foreground">
            撥動 ON 立即載入 LLM 進記憶體待命（5-30 秒）。OFF 完整釋放 LLM、MCP、DB
            資源。桌寵啟動時若上次是 ON 會自動 preload。
          </p>
          {!hasLlmSource && (
            <p className="mt-1 text-xs text-amber-400">
              需先在下方「本地 LLM」區塊指定 GGUF 模型路徑或外部 endpoint
            </p>
          )}
        </div>
        <Switch
          id="agent-enabled"
          checked={enabled}
          disabled={inTransition || !hasLlmSource}
          onCheckedChange={(v) => void onToggle(v)}
        />
      </div>
    </section>
  );
}

interface LlmSectionProps {
  llm: AgentConfig['llm'];
  updateLlm: <K extends keyof AgentConfig['llm']>(
    key: K,
    value: AgentConfig['llm'][K],
  ) => void;
  pickModelFile: () => Promise<void>;
  canReload: boolean;
  onReload: () => Promise<void>;
  inTransition: boolean;
}
function LlmSection({
  llm,
  updateLlm,
  pickModelFile,
  canReload,
  onReload,
  inTransition,
}: LlmSectionProps): React.ReactElement {
  const gpuLayersStr = useMemo(
    () => (llm.gpuLayers === 'auto' ? 'auto' : String(llm.gpuLayers)),
    [llm.gpuLayers],
  );
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">本地 LLM（GGUF）</h3>

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">GGUF 模型路徑</Label>
          <div className="flex gap-2">
            <Input
              type="text"
              placeholder="例如 D:\models\Phi-3-mini-4k-instruct-q4.gguf"
              value={llm.modelPath ?? ''}
              onChange={(e) => updateLlm('modelPath', e.target.value || null)}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => void pickModelFile()}>
              瀏覽…
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">
              Context size（2048-32768）
            </Label>
            <Input
              type="number"
              min={2048}
              max={32768}
              step={1024}
              value={llm.contextSize}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 2048) updateLlm('contextSize', v);
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">
              GPU layers（auto / 數字 / 0=CPU）
            </Label>
            <Input
              type="text"
              value={gpuLayersStr}
              placeholder="auto"
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === '' || v === 'auto') {
                  updateLlm('gpuLayers', 'auto');
                } else {
                  const n = parseInt(v, 10);
                  if (!isNaN(n) && n >= 0) updateLlm('gpuLayers', n);
                }
              }}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            外部 llama.cpp HTTP endpoint（替代方案，留空使用 GGUF）
          </Label>
          <Input
            type="text"
            placeholder="例如 http://127.0.0.1:8080"
            value={llm.externalUrl ?? ''}
            onChange={(e) => updateLlm('externalUrl', e.target.value || null)}
          />
        </div>

        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            disabled={!canReload || inTransition}
            onClick={() => void onReload()}
          >
            重新載入 LLM
          </Button>
        </div>
      </div>
    </section>
  );
}

interface DaemonOptInProps {
  daemon: AgentConfig['daemon'];
  updateDaemon: <K extends keyof AgentConfig['daemon']>(
    key: K,
    value: AgentConfig['daemon'][K],
  ) => void;
}
function DaemonOptInSection({
  daemon,
  updateDaemon,
}: DaemonOptInProps): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="daemon-opt-in" className="text-sm">
            啟動 daemon WS server（opt-in）
          </Label>
          <p className="text-xs text-muted-foreground">
            開啟後其他工具（my-agent CLI、第二個 Electron 視窗、未來 Discord bot
            等）可透過 ws 連入共用同個 in-process daemon。Phase 5c 完整串接。
          </p>
        </div>
        <Switch
          id="daemon-opt-in"
          checked={daemon.enabled}
          onCheckedChange={(v) => updateDaemon('enabled', v)}
        />
      </div>
      {daemon.enabled && (
        <div className="mt-3 flex flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            Port（0 = OS 自動指派）
          </Label>
          <Input
            type="number"
            min={0}
            max={65535}
            value={daemon.port}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 0) updateDaemon('port', v);
            }}
            className="w-32"
          />
        </div>
      )}
    </section>
  );
}

interface WebUiOptInProps {
  webUi: AgentConfig['webUi'];
  updateWebUi: <K extends keyof AgentConfig['webUi']>(
    key: K,
    value: AgentConfig['webUi'][K],
  ) => void;
}
function WebUiOptInSection({
  webUi,
  updateWebUi,
}: WebUiOptInProps): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-card p-4 opacity-60">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="webui-opt-in" className="text-sm">
            啟動 Web UI（瀏覽器存取，Phase 4b 補完）
          </Label>
          <p className="text-xs text-muted-foreground">
            未來可在瀏覽器開 chat UI 與桌寵共用同個 daemon。embedded 模式下
            Node http 對等實作尚未完成（Phase 4b TODO）。
          </p>
        </div>
        <Switch
          id="webui-opt-in"
          checked={webUi.enabled}
          disabled
          onCheckedChange={(v) => updateWebUi('enabled', v)}
        />
      </div>
    </section>
  );
}

interface WorkspaceSectionProps {
  workspaceCwd: string | null;
  onChange: (value: string) => void;
}
function WorkspaceSection({
  workspaceCwd,
  onChange,
}: WorkspaceSectionProps): React.ReactElement {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">
          Agent workspace cwd（dev / 進階：覆寫預設隔離目錄）
        </Label>
        <Input
          type="text"
          placeholder="留空 = ~/.virtual-assistant-desktop/agent-workspace"
          value={workspaceCwd ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </section>
  );
}
