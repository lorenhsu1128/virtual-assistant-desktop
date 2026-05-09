# 設定視窗開發規則

## 技術選型

- 框架：**React 19 + Tailwind CSS + shadcn/ui primitives**（沿用 src-bubble/ 的 React 環境）
- 視窗類型：獨立 BrowserWindow（Electron），有標題列、邊框、可縮放、不透明
- 與主程序透過 ElectronIPC 溝通；renderer 端永遠透過 `src/bridge/ElectronIPC.ts`
- 建置：vite multi-entry（`settings.html` → `src-settings/main.tsx`）

> **設定視窗為什麼用 React 不是 Svelte？** ARCHITECTURE.md 原本規劃 Svelte，
> 但 P1.5 移植 my-agent web chat 元件時已經把 React + Tailwind + shadcn 引入到
> `src-bubble/`。設定視窗複用同一份基礎設施，避免維護兩套 framework。

## 目錄結構

```
src-settings/
├── main.tsx          # React createRoot 入口
├── App.tsx           # 設定 root（未來補多頁時改 left-nav 兩欄式）
├── AgentPage.tsx     # P3 v1：my-agent 整合設定頁
├── globals.css       # Tailwind base + 暗色主題變數（不透明背景）
├── lib/
│   └── utils.ts      # cn() helper（clsx + tailwind-merge）
└── ui/               # shadcn primitives 子集
    ├── button.tsx    # cva variants：default / secondary / ghost / outline / destructive
    ├── input.tsx     # 文字輸入
    ├── label.tsx     # @radix-ui/react-label
    └── switch.tsx    # @radix-ui/react-switch
```

## 頁面規劃

| 頁面 | 功能 | 對應版本 | 狀態 |
|------|------|----------|------|
| AgentPage | my-agent 整合：enable / mode / 路徑 / 狀態 / 套用 / 重新連線 | v0.3.x | ✅ 已實作 |
| ModelPage | VRM 模型瀏覽、選擇、預覽 | v0.4 | ⏸ 待開（目前由托盤 vrm-picker.html 處理） |
| AnimationPage | 動畫資料夾、分類、權重、重新掃描 | v0.4 | ⏸ 待開 |
| ExpressionPage | BlendShapes 管理、自動播放白名單 | v0.4 | ⏸ 待開 |
| DisplayPage | Win+D 行為、多虛擬桌面、MToon outline | v0.4 | ⏸ 待開 |
| PerformancePage | 幀率上限、省電模式 | v0.4 | ⏸ 待開 |
| DevicePage | 麥克風、攝影機權限 | v0.4 | ⏸ 待開（依賴 v0.4 lip-sync / camera） |
| AboutPage | 版本資訊、授權、檢查更新 | v0.5 | ⏸ 待開 |

## 設計原則

- **獨立生命週期**：關閉設定視窗不影響主視窗桌寵運行；單實例（重複呼叫 `openSettingsWindow` 只 focus 既有視窗）
- **即時生效**：設定變更透過 IPC `agent_apply_config`（或未來 `apply_*_config`）→ main process 寫 config + restart 對應子系統，不需 electron 整體重啟
- **讀寫設定一律走 ElectronIPC**：`ipc.readConfig()` / `ipc.writeConfig()` / `ipc.agentApplyConfig(next)`
- **不在設定視窗中直接操作檔案系統**：所有 fs 行為在主程序 `electron/fileManager.ts`
- **狀態即時更新**：訂閱 `ipc.onAgentStatus` 等 event 讓 UI 反映 daemon 狀態變化

## 共用 IPC 介面（v0.3.x agent 已有）

```ts
// 讀寫
ipc.readConfig(): Promise<AppConfig | null>
ipc.writeConfig(config: AppConfig): Promise<boolean>

// Agent 子系統
ipc.agentGetStatus(): Promise<AgentDaemonInfo>
ipc.agentApplyConfig(next: AgentConfig): Promise<AgentDaemonInfo | null>
ipc.agentReconnect(): Promise<void>
ipc.onAgentStatus(cb): () => void
```

未來新增「動畫頁」「表情頁」時對應 IPC 應走相同模式（`apply_<page>_config`）。

## React 元件守則

- 函式式元件 + hooks，不用 class component
- shadcn primitives 統一從 `./ui/*` 匯入，不直接用 `@radix-ui/*`（封裝樣式 + cn）
- 公開元件使用 `React.forwardRef` + `displayName`（與 shadcn 慣例一致）
- 表單欄位：`<Label htmlFor="x" />` + 對應元件 `id="x"`
- 不在元件內呼叫 `console.warn` 以外的 console — IPC 失敗由 ElectronIPC wrapper 集中 log

## 樣式規則

- Tailwind utility-first；複雜共用樣式才抽 `cn()` 組合
- 顏色用 CSS 變數（`bg-primary` / `text-foreground` / `border-border` 等）
- 不直接寫顏色字串（避免暗/亮 theme 切換時失準）— 顏色定義集中於 `globals.css`
- 暗色預設啟用：`<html class="dark">` 在 `settings.html`

## 禁止清單

- ❌ 直接使用 `window.electronAPI` — 必須透過 `ipc.*`（src/bridge/ElectronIPC）
- ❌ 直接 import 任何 `electron/*.ts`（renderer 不可碰主程序）
- ❌ 在元件內保留全域 mutable state（用 `useState` 或 zustand store；目前設定頁簡單，未用 zustand）
- ❌ 從 src-settings 引入 src-bubble 的 components / store（兩個 app 各自獨立；要共用元件時複製或抽到 shared）
- ❌ 使用 TypeScript `any`
- ❌ 在 component 內直接觸發 `daemon.start()` 等主程序行為 — 一律透過 IPC
