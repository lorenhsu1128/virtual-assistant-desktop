import { useEffect, useState } from 'react';
import { ipc } from '../src/bridge/ElectronIPC';
import type { AgentConfig } from '../src/types/config';
import type { AgentDaemonInfo, AgentDaemonStatus } from '../src/types/agent';
import { Switch } from './ui/switch';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { cn } from './lib/utils';

const statusBadge: Record<AgentDaemonStatus, { text: string; cls: string }> = {
  online: { text: 'ONLINE', cls: 'bg-emerald-500/20 text-emerald-400' },
  starting: { text: 'STARTING', cls: 'bg-amber-500/20 text-amber-400' },
  connecting: { text: 'CONNECTING', cls: 'bg-amber-500/20 text-amber-400' },
  offline: { text: 'OFFLINE', cls: 'bg-rose-500/20 text-rose-400' },
  disabled: { text: 'DISABLED', cls: 'bg-muted text-muted-foreground' },
  error: { text: 'ERROR', cls: 'bg-rose-500/20 text-rose-400' },
};

const DEFAULT_AGENT: AgentConfig = {
  enabled: false,
  daemonMode: 'auto',
  bunBinaryPath: null,
  myAgentCliPath: null,
  workspaceCwd: null,
};

export function AgentPage(): React.ReactElement {
  const [agent, setAgent] = useState<AgentConfig>(DEFAULT_AGENT);
  const [info, setInfo] = useState<AgentDaemonInfo>({
    status: 'offline',
    port: null,
    token: null,
    pid: null,
  });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const cfg = await ipc.readConfig();
      if (cfg && mounted) setAgent(cfg.agent ?? DEFAULT_AGENT);
      const status = await ipc.agentGetStatus();
      if (mounted) setInfo(status);
      if (mounted) setLoaded(true);
    })();
    const off = ipc.onAgentStatus((next) => {
      if (mounted) setInfo(next);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const updateField = <K extends keyof AgentConfig>(
    key: K,
    value: AgentConfig[K],
  ): void => {
    setAgent((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const apply = async (): Promise<void> => {
    setSaving(true);
    try {
      const next = await ipc.agentApplyConfig(agent);
      if (next) setInfo(next);
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const reconnect = async (): Promise<void> => {
    await ipc.agentReconnect();
  };

  if (!loaded) {
    return (
      <div className="p-6 text-sm text-muted-foreground">載入設定中…</div>
    );
  }

  const badge = statusBadge[info.status];

  return (
    <div className="flex flex-col gap-5 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">my-agent 整合</h2>
          <p className="text-xs text-muted-foreground">
            桌寵會 spawn my-agent daemon 並透過 ws 對話、透過 MCP 控制表演。
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

      {info.message && (
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {info.message}
        </div>
      )}

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Label htmlFor="agent-enabled" className="text-sm">
              啟用 my-agent 整合
            </Label>
            <p className="text-xs text-muted-foreground">
              關閉後桌寵以「無 AI 模式」運作，所有渲染功能不受影響。
            </p>
          </div>
          <Switch
            id="agent-enabled"
            checked={agent.enabled}
            onCheckedChange={(v) => updateField('enabled', v)}
          />
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold">Daemon 模式</h3>
        <p className="mb-3 text-xs text-muted-foreground">
          auto：桌寵自動 spawn / 監看 / 關閉 daemon。external：使用者自己 `cli daemon
          start`，桌寵僅連線。
        </p>
        <div className="flex gap-2">
          <Button
            variant={agent.daemonMode === 'auto' ? 'default' : 'outline'}
            size="sm"
            onClick={() => updateField('daemonMode', 'auto')}
          >
            auto
          </Button>
          <Button
            variant={agent.daemonMode === 'external' ? 'default' : 'outline'}
            size="sm"
            onClick={() => updateField('daemonMode', 'external')}
          >
            external
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-3 text-sm font-semibold">路徑覆寫（留空 = 自動偵測）</h3>
        <div className="flex flex-col gap-3">
          <PathField
            label="bun runtime（auto 模式且 CLI 不是獨立 binary 才需要）"
            placeholder="如 C:\Users\xxx\.bun\bin\bun.exe（留空自動偵測）"
            value={agent.bunBinaryPath ?? ''}
            onChange={(v) => updateField('bunBinaryPath', v || null)}
          />
          <PathField
            label="my-agent CLI"
            placeholder="如 C:\Users\xxx\Documents\_projects\my-agent\cli.exe"
            value={agent.myAgentCliPath ?? ''}
            onChange={(v) => updateField('myAgentCliPath', v || null)}
          />
          <PathField
            label="Agent workspace cwd（隔離 session 用）"
            placeholder="留空 = ~/.virtual-assistant-desktop/agent-workspace"
            value={agent.workspaceCwd ?? ''}
            onChange={(v) => updateField('workspaceCwd', v || null)}
          />
        </div>
      </section>

      <footer className="flex items-center justify-between gap-3">
        <Button variant="outline" size="sm" onClick={reconnect}>
          重新連線
        </Button>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {info.pid && <span>pid {info.pid}</span>}
          {info.port && <span>port {info.port}</span>}
        </div>
        <Button onClick={apply} disabled={!dirty || saving}>
          {saving ? '套用中…' : '套用'}
        </Button>
      </footer>
    </div>
  );
}

interface PathFieldProps {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}

function PathField({ label, placeholder, value, onChange }: PathFieldProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
