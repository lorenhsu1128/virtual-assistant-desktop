# my-agent × virtual-assistant-desktop 整合架構藍圖

## Context

現有兩個專案：

- **virtual-assistant-desktop**（C:\Users\LOREN\Documents\_projects\virtual-assistant-desktop）：Electron + Three.js + VRM 桌寵，v0.3 已完成（自主移動、表情、動畫、托盤、debug overlay）。架構嚴守三層：Electron main / IPC bridge / TS renderer。
- **my-agent**（C:\Users\LOREN\Documents\_projects\my-agent）：Bun + Ink + React 的 Claude Code 風格 CLI agent，內建 daemon mode（`Bun.serve` WebSocket server，多客戶端架構，已支援 `repl | discord | cron | slash | web` 等 source）、MCP loader、多 LLM provider、session FTS 索引、cost tracking。

**整合目標**：把 my-agent 改造為桌寵的 AI 大腦。使用者對桌寵說話／打字，由 my-agent 處理 LLM 對話與工具執行；agent 透過 MCP tool 反向控制桌寵的表情、動畫、對話氣泡，讓 VRM 角色成為 agent 的具體化表演者。

**關鍵限制**：

- my-agent daemon 用 `Bun.serve`，**Bun runtime 不可替代**，Electron 必須 spawn Bun 子進程
- 桌寵架構守則禁止 `process.platform` 散落、禁止繞過 ElectronIPC、StateMachine 不得依賴 Three.js（LESSONS.md / .claude/rules/）
- my-agent 的 MCP loader 在原始碼中可見但**daemon 端 wiring 不完整**（探索代理報告：`mcp.json` 註冊機制與 ProjectRuntime 啟動時的 MCP spawn 程式碼尚未完全找到），這是 P2 的最大風險點，需 fallback 策略

**使用者已決策**：

1. Daemon 生命週期：**兩者皆支援，預設自動 spawn**（config: `agentDaemonMode: 'auto' | 'external'`）
2. 表演控制協定：**桌寵內嵌 MCP server**（理想方案；若 my-agent MCP wiring 缺失，P2 暫退到文字標記過渡，並回 my-agent 補 MCP loader）
3. 對話氣泡 UI：**獨立 BrowserWindow，沿用 vrm-picker 模式**
4. TTS：**v1 不做**，留待 v0.4 與麥克風 lip-sync 一起設計

## 推薦架構

```
┌─────────────────────────────────────────────────────────────┐
│  Electron main process                                      │
│                                                             │
│  ┌───────────────────────┐   ┌───────────────────────────┐ │
│  │ AgentDaemonManager    │   │ MascotMcpServer (stdio)   │ │
│  │ - spawn bun daemon    │   │ - tool: set_expression    │ │
│  │ - read pid.json/token │   │ - tool: play_animation    │ │
│  │ - health probe        │   │ - tool: say (bubble)      │ │
│  │ - graceful shutdown   │   │ - tool: look_at           │ │
│  └────────┬──────────────┘   └────────┬──────────────────┘ │
│           │                           │                     │
│           │ ws://127.0.0.1:N          │ stdio              │
│           ▼                           ▼                     │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ my-agent daemon (bun ./cli daemon start)             │  │
│  │ source=mascot, cwd=<workspace>                       │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│           ▲                           ▲                     │
│           │ IPC: agent_*              │ IPC: bubble_*       │
│           │                           │                     │
│  ┌────────┴───────────────────────────┴──────────────────┐ │
│  │ Renderer (主視窗 - VRM)                               │ │
│  │ src/agent/AgentClient.ts (WS proxy)                  │ │
│  │ src/agent/MascotActionDispatcher.ts (Express/Anim)   │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Renderer (對話氣泡 BrowserWindow)                     │  │
│  │ src-bubble/ (沿用 vrm-picker 模式)                    │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**資料流**：

1. **上行**（使用者 → agent）：使用者在氣泡 BrowserWindow 輸入 → IPC 送到 main → AgentDaemonManager 透過 ws frame `{type:'input',text,...}` 寫入 daemon
2. **下行 streaming**（agent → 桌寵文字）：daemon → ws `runnerEvent` → AgentClient 解析 assistant text delta → IPC `bubble_text_delta` → 氣泡視窗即時顯示
3. **下行表演**（agent → VRM 表情/動畫）：daemon LLM 呼叫 MCP tool → my-agent 透過 stdio 呼叫 MascotMcpServer → MascotMcpServer 透過 IPC `agent_action` 推到主視窗 → MascotActionDispatcher 呼叫 ExpressionManager / AnimationManager

**為什麼這樣設計**：

- **不分叉 my-agent**：只在 my-agent 那邊改 source enum 加 `'mascot'`（5 檔小改）、加註冊 mascot MCP（透過 `./cli mcp server add`，不改原始碼）
- **重用既有抽象**：表演端對接 ExpressionManager / AnimationManager 既有 API，不發明新模組
- **獨立 BrowserWindow 氣泡**：與 VRM 主視窗解耦，可自由排版（HTML/CSS），不爭搶主視窗 transparent canvas，沿用既有 vrm-picker 生命週期模板
- **MCP 而非 NLP heuristic**：LLM 直接 tool call，比解析 text 中的 emoji/關鍵字穩定百倍

## 分階段交付

### **P0 — Daemon spawn 與 health probe**（基礎建設，commit 1）

**目標**：Electron 啟動後能可靠地拉起 / 連上 my-agent daemon，失敗時優雅降級為「無 AI 模式」。

**新增檔案**：

- `electron/agent/AgentDaemonManager.ts` — 模仿 `electron/windowMonitor.ts` / `keyboardMonitor.ts` 的 lifecycle pattern（`start()` / `stop()`、main.ts 集中管理）
  - `mode === 'auto'`：用 `child_process.spawn` 跑 `bun ./cli daemon start --port 0 --host 127.0.0.1`，stdout/stderr pipe 到 `~/.virtual-assistant-desktop/logs/agent-daemon-YYYY-MM-DD.log`
  - `mode === 'external'`：跳過 spawn，僅讀 pid.json
  - 輪詢 `~/.my-agent/daemon.pid.json`（最長 10s）拿到 `port`，stale 偵測沿用 my-agent 的 `lastHeartbeat > 30s` 規則
  - 讀 `~/.my-agent/daemon.token`
  - app `before-quit` 發 SIGTERM，3s timeout 後 SIGKILL（對齊 my-agent 自身 shutdown 預算）
  - 失敗事件：`emit('error', AgentDaemonError)` 讓上層降級
- `electron/platform/agentPaths.ts` — 沿用 `electron/platform/index.ts` export 慣例
  - `getBunBinary(): string`：Windows 走 `%LOCALAPPDATA%\\Programs\\bun\\bun.exe`，macOS 走 `~/.bun/bin/bun` 或 PATH `which bun`
  - `getMyAgentCli(): string`：預設 `${USERPROFILE}/Documents/_projects/my-agent/cli`，可被 config override
  - `getAgentHome(): string`：`~/.my-agent/`
- `electron/platform/index.ts` 加 export

**修改檔案**：

- `electron/main.ts:111` `app.whenReady()` 中、windowMonitor 之後新增 `agentDaemonManager.start()`
- `electron/main.ts:148–154` `mainWindow.on('closed')` cleanup 加上 `agentDaemonManager?.stop()`
- `src/types/config.ts` AppConfig 擴充：
  ```ts
  agent?: {
    enabled: boolean;             // 預設 false（首次安裝），引導後才開
    daemonMode: 'auto' | 'external';
    bunBinaryPath: string | null; // null = 自動偵測
    myAgentCliPath: string | null;
    workspaceCwd: string | null;  // 預設 = userData 下的 agent-workspace
  }
  ```
- `electron/fileManager.ts:43–60` `DEFAULT_CONFIG` 同步
- `package.json` 加 `ws` 與 `@types/ws`（先準備好，P1 用）

**沿用既有資源**：

- 程序生命週期模式：`electron/windowMonitor.ts:1–80` / `electron/keyboardMonitor.ts`
- IPC 三層守則：`.claude/rules/ipc-boundary.md`
- 跨平台守則：`.claude/rules/rust-safety.md`
- Log 目錄慣例：`~/.virtual-assistant-desktop/logs/`（SPEC §8）

**驗收**：

- 首次啟動 `agent.enabled=false`：桌寵正常運作，daemon 不啟動，不影響 v0.3 功能
- 設 `agent.enabled=true`：3 秒內 daemon 啟動，pid.json 出現 port 與 token；`./cli daemon logs -f` 看得到 `client connected`（之後 P1 連線時驗）
- 殺掉 daemon 進程：桌寵記錄 warning，不 crash，UI 標示「AI 離線」
- 桌寵 quit：daemon SIGTERM 後 5 秒內結束，pid.json 被刪
- macOS：bun 不存在時走降級，不 throw

---

### **P1 — WebSocket client + 對話氣泡 BrowserWindow**（commit 2）

**目標**：使用者能在獨立氣泡視窗打字 → daemon → LLM 串流回應。純文字往返，無表情控制。

**新增檔案**：

- `electron/agent/agentBubbleWindow.ts`（沿用 `electron/vrmPickerWindow.ts` 模板）
  - `createAgentBubbleWindow(parentBounds)`、`destroyAgentBubbleWindow()`
  - 視窗參數透過 `electron/platform/windowConfig.ts` 新增 `getAgentBubbleOptions()`
  - 預設位置：主視窗右側、追隨主視窗移動（監聽 `mainWindow.on('move')`）
- `electron/agent/agentIpcHandlers.ts`（在 `electron/ipcHandlers.ts` 註冊）
  - `agent_send_input(text)` — 寫入 daemon
  - `agent_get_status()` — `'offline' | 'connecting' | 'idle' | 'running'`
  - `agent_create_session()` / `agent_resume_session(id)` — 透過 ws 控制
- `src/agent/AgentClient.ts`（renderer 主視窗載入；用 `ws` 透過 main 中繼，**不直連** — 嚴守 ipc-boundary.md）
  - 實際 ws 連線在 main process（`electron/agent/AgentDaemonManager.ts` 內擴充）
  - renderer 透過 IPC events 收 streaming：
    - `agent_state` — `{state, sessionId}`
    - `agent_turn_start` / `agent_turn_end`
    - `agent_text_delta` — `{inputId, text}`
    - `agent_tool_use_start` / `agent_tool_use_input_delta` / `agent_tool_use_end`
    - `agent_thinking_delta`（Phase 1 只 log，不顯示）
    - `agent_error`
- `src-bubble/`（新目錄，平行於 `src/`、`src-settings/`、`src/vrm-picker/`）
  - `index.html` / `main.ts` / `BubbleApp.ts` / `style.css`
  - 簡 vanilla TS（與 `src/vrm-picker/` 一致），渲染：
    - 上半：streaming assistant text（自動捲動）
    - 下半：使用者輸入 textarea + 送出按鈕
    - status bar：daemon 狀態 / sessionId / 中斷按鈕
  - 透過 contextBridge 拿 `ipc.agentSendInput()` 等 API
- `vite.config.ts` 新增 bubble entry（仿 vrm-picker 配置）

**修改檔案**：

- `electron/preload.ts` 加 `agentSendInput` / `agentGetStatus` / `onAgentStateChange` 等
- `src/bridge/ElectronIPC.ts` 加對應 typed wrapper（fallback 都回 'offline' 狀態）
- `electron/systemTray.ts:240` 區段加：
  - `對話 ▶`（toggle 氣泡視窗顯示）
  - `Agent 狀態 ▶`（顯示 online/offline、目前 model、cost）
  - `重新連線`、`新對話`
- `src/main.ts:280` `initializeBehaviorSystem` 內部加 `AgentClient` 初始化（try/catch 包住，失敗不影響桌寵）

**my-agent 端要改的**（提交回 my-agent repo，不在桌寵 commit 內）：

- `src/server/clientRegistry.ts` `ClientSource` union 加 `'mascot'`
- `src/server/directConnectServer.ts:85–101` `parseSourceFromRequest` 允許 mascot
- `src/daemon/daemonCli.ts:266` `defaultIntentForSource` 加 mascot → `'interactive'`（或自訂 intent）
- 一個 commit：`feat(daemon): support mascot source`

**沿用既有資源**：

- vrm-picker BrowserWindow 模板：`electron/vrmPickerWindow.ts`、`vrm-picker.html`、`src/vrm-picker/`
- IPC 三層 pattern：`electron/ipcHandlers.ts:55–57` `scan_animations` 範例
- 系統托盤動態選單：`electron/systemTray.ts:111–286` template + `tray_action` IPC pattern
- daemon 訊息格式參考：my-agent `src/server/sessionBroker.ts:109–136`（`state` / `turnStart` / `turnEnd` / `runnerEvent`）

**驗收**：

- 氣泡視窗開啟，daemon `client connected source=mascot`
- 使用者送出 "你好"，氣泡上半即時 streaming 顯示助理回應
- 中斷按鈕能停掉進行中的 turn（送 ws control 訊息）
- 主視窗拖到不同螢幕，氣泡跟隨
- daemon 停掉，氣泡狀態變 offline，重啟 daemon 自動重連
- `bun run test` 既有 184/184 通過；新增 `tests/unit/AgentClient.test.ts` mock daemon ws

---

### **P2 — 桌寵 MCP server（表演控制）**（commit 3，含風險預案）

**目標**：LLM 透過 MCP tool 控制 VRM 表情、動畫、對話氣泡時序。

**前置調查**（P2 動工前必做，避免做白工）：

1. 在 my-agent 確認 MCP loader 完整度：搜 `mcp.json` / `MCPLoader` / ProjectRuntime 啟動序列，看 `./cli mcp server add` 後是否真的會 spawn 並把 tools 注入 QueryEngine
2. 若 wiring 不完整，先回 my-agent 補 MCP loader（獨立 PR），或改用文字標記過渡：
   - **過渡方案**：system prompt 教 LLM 在回應中插 `<<expr:joy>>` `<<anim:wave>>` `<<say-end>>` 標記，AgentClient 解析後從 text stream 移除再進氣泡
   - 過渡方案完工 → 仍進 v1，標記為「P2-fallback，P2.5 升級為 MCP」
3. 文字標記只是兜底，**仍以 MCP 為正解**

**新增檔案（MCP 路線）**：

- `electron/agent/MascotMcpServer.ts` — 用 `@modelcontextprotocol/sdk` 建 stdio MCP server
  - 在 Electron main process 內 in-process 跑（不 spawn 子進程；MCP SDK 支援自訂 transport）
  - Tools：
    - `set_expression({ name: string, durationMs?: number })` — 對應 `ExpressionManager.setManualExpression`
    - `play_animation({ category: 'action'|'idle'|..., name?: string })` — 對應 `AnimationManager.playByCategory` / `playByName`
    - `say({ text: string, autoDismissMs?: number })` — 推到氣泡視窗
    - `look_at_screen({ x: number, y: number })` — 預留 v0.5 攝影機追蹤接口，v1 可空實作
    - `get_mascot_state()` — 回傳目前表情 / 動畫 / 視窗位置（讓 LLM 上下文感知）
  - 透過 IPC `agent_action` 推到主視窗 renderer
- `src/agent/MascotActionDispatcher.ts`（renderer 主視窗）
  - 訂閱 `agent_action` IPC events
  - 注入 `expressionManager` / `animationManager` 引用（建構子注入，遵守 IPC bridge 守則）
  - 呼叫對應方法
- `electron/agent/mcpRegistration.ts` — Daemon 啟動後自動執行：
  - 寫入或檢查 `~/.my-agent/mcp.json` 是否已有 `mascot` server entry（若 my-agent 用此格式）
  - 或透過 daemon ws control 訊息註冊（若 my-agent 提供）

**修改檔案**：

- `src/types/config.ts` AppConfig.agent 加 `mcpEnabled: boolean`、`expressionWhitelist?: string[]`（避免 LLM 亂叫不存在的表情）
- `src/main.ts` 把 `expressionManager` 與 `animationManager` 引用透過 IPC 暴露給 main process MCP server（用單向訊息，不是直接函式呼叫，遵守模組邊界）
- `src/expression/ExpressionManager.ts` **不需改**，既有 `setManualExpression` 已足夠
- `src/animation/AnimationManager.ts` **不需改**，既有 `playByCategory` / `playByName` 已足夠

**system prompt 增補**（寫在 my-agent workspace 的 `<workspaceCwd>/.my-agent/system-prompt/mascot.md`，由 my-agent 自動載入）：

> 你是桌面 VRM 角色。可用工具：set_expression、play_animation、say、look_at_screen。每次回應通常先呼叫 say 把回應投到氣泡，再用 set_expression 配合語氣，必要時 play_animation 做動作。可用表情清單：{{whitelist}}。

**沿用既有資源**：

- `ExpressionManager.setManualExpression`：`src/expression/ExpressionManager.ts:107`
- `AnimationManager.playByCategory`：`src/animation/AnimationManager.ts:191`
- `AnimationManager.playByName`：`src/animation/AnimationManager.ts`（同檔內）
- `setExpression` 經 `vrmController.setBlendShape` 走 `resolve()` 雙 slot fade，已自動處理優先級（SPEC §2.3.3）
- VRM 表情清單可由 `bun run scan:expressions` 工具取得（docs/vrm-expression-guide.md）

**驗收**：

- 對 agent 說「對我笑一下」→ LLM 呼叫 `set_expression({name:'joy'})` → 桌寵切換表情，氣泡同時顯示文字回應
- 動畫呼叫不破壞 idle 接力機制（action 完播後正確回 idle，遵守 LESSONS.md 2026-04-09 條目）
- 不存在的表情被 whitelist 擋住，回 LLM 錯誤訊息，LLM 應自我修正
- MCP loader 缺失時走文字標記 fallback，並在 release notes 標明
- 既有 v0.3 行為（自動表情輪播、自主移動）不受影響：`agent_action` 進來只覆蓋手動 slot，自動仲裁邏輯不動

---

### **P3 — 首次啟動引導 + 設定面板**（commit 4，輕量）

**目標**：把 agent 整合納入 SPEC §4 既有的首次啟動流程，並提供 GUI 設定。

**修改檔案**：

- `src/main.ts` 首次啟動流程加第 5 步：「（可選）連接 my-agent」
  - 偵測 `~/.my-agent/daemon.pid.json` / bun binary：存在 → 詢問是否啟用
  - 不存在 → 顯示說明連結，跳過
- 系統托盤「設定」入口（目前 TODO）→ 簡易設定視窗（沿用 `src-settings/` 規劃但只先做 agent 頁）
  - bun binary 路徑、my-agent CLI 路徑、workspace cwd、enable toggle、表情 whitelist 編輯

**驗收**：

- 全新使用者首次啟動 → 引導完成 → 桌寵能對話
- 老使用者升級：config 自動 merge `agent.enabled=false` 預設值，行為不變

---

## 跨 commit 共通原則

1. **每個 P 階段一次 commit + push**，commit 訊息走 Conventional Commits：
   - `feat(agent): P0 daemon spawn 與 health probe`
   - `feat(agent): P1 WebSocket client + 對話氣泡視窗`
   - `feat(agent): P2 桌寵 MCP server 表演控制`
   - `feat(agent): P3 首次啟動引導與設定`
2. **每個 P 完成後同步 CLAUDE.md**：目錄結構章節加入 `electron/agent/`、`src/agent/`、`src-bubble/`；版本規劃表加列「v0.3.x agent 整合」
3. **LESSONS.md 新分類「Agent 整合」**：daemon spawn race、ws 重連、MCP whitelist 等踩雷必記
4. **跨平台**：所有 spawn / 路徑解析走 `electron/platform/agentPaths.ts`；macOS 沒裝 bun → 降級為「無 AI 模式」與既有 koffi 降級邏輯一致
5. **測試策略**：
   - `tests/unit/AgentClient.test.ts` — mock ws server 模擬 streaming events
   - `tests/unit/MascotActionDispatcher.test.ts` — 注入 mock ExpressionManager / AnimationManager 驗證 dispatch 正確
   - **不要**在 CI 起真 my-agent daemon
6. **Bun runtime 偵測**：執行檔打包時不 bundle bun，依賴使用者本機安裝；首次啟動引導若偵測不到 bun，給安裝連結並降級
7. **electron/ 改動後重啟流程**：遵守 LESSONS.md 2026-04-07 條目，每次改 `electron/agent/*` 都要 `bun run build:electron` + 結束 electron 進程 + 重啟

## 關鍵檔案清單（將被觸碰）

**新增**：

- `electron/agent/AgentDaemonManager.ts`
- `electron/agent/agentBubbleWindow.ts`
- `electron/agent/agentIpcHandlers.ts`
- `electron/agent/MascotMcpServer.ts`
- `electron/agent/mcpRegistration.ts`
- `electron/platform/agentPaths.ts`
- `src/agent/AgentClient.ts`
- `src/agent/MascotActionDispatcher.ts`
- `src-bubble/index.html`
- `src-bubble/main.ts`
- `src-bubble/BubbleApp.ts`
- `src-bubble/style.css`
- `tests/unit/AgentClient.test.ts`
- `tests/unit/MascotActionDispatcher.test.ts`

**修改**：

- `electron/main.ts`（lifecycle hook）
- `electron/ipcHandlers.ts`（agent_* commands）
- `electron/preload.ts`（contextBridge）
- `electron/systemTray.ts`（對話 / Agent 狀態項）
- `electron/platform/index.ts`（export agentPaths）
- `electron/platform/windowConfig.ts`（getAgentBubbleOptions）
- `electron/fileManager.ts`（DEFAULT_CONFIG.agent）
- `src/main.ts`（AgentClient + MascotActionDispatcher 接線、首次啟動引導）
- `src/types/config.ts`（agent 欄位）
- `src/bridge/ElectronIPC.ts`（typed wrappers + fallback）
- `vite.config.ts`（bubble entry）
- `package.json`（ws, @modelcontextprotocol/sdk, @types/ws）
- `CLAUDE.md`（目錄結構、版本表）
- `LESSONS.md`（Agent 整合分類）

**my-agent 端**（獨立 PR，不在桌寵 repo）：

- `src/server/clientRegistry.ts`
- `src/server/directConnectServer.ts`
- `src/daemon/daemonCli.ts`
- （視 P2 調查結果）`src/services/mcp/*` 補完 loader

## 風險與緩解

| 風險 | 緩解 |
|------|------|
| my-agent MCP loader wiring 不完整 | P2 動工前先驗證；缺失則先做 PR 補 loader 或走文字標記過渡，仍可釋出 v1 |
| Bun runtime 部署問題 | 不 bundle bun；首次啟動偵測缺失給連結；降級無 AI 模式 |
| daemon spawn race（pid.json 還沒寫就連線） | 輪詢 pid.json 最長 10s + 連線重試 3 次 |
| LLM 幻想出不存在的表情/動畫名 | MCP tool 內部 whitelist 過濾，錯誤訊息回 LLM 自我修正 |
| 動畫切換破壞 SpringBone（LESSONS 2026-04-07） | 復用既有 hip 平滑與 SpringBone reset；MCP 不繞過 AnimationManager |
| 氣泡視窗 z-order / 跟隨主視窗效能 | 沿用 vrm-picker 模式，僅 main `move` 事件節流更新 |
| 同一 daemon 被多個 client（discord + 桌寵）連 | 用不同 cwd 隔離 session，或同 cwd 共享（依使用者意願）；P0 預設不同 cwd |

## 驗證（end-to-end）

P0 驗證：

```bash
# 桌寵端
bun install
bun run build:electron
bun run dev

# 觀察 ~/.virtual-assistant-desktop/logs/agent-daemon-*.log
# 觀察 ~/.my-agent/daemon.pid.json 出現 port

# my-agent 端
tail -f ~/.my-agent/daemon.log
# 應看到 client connected source=mascot
```

P1 驗證：在氣泡視窗輸入 "hello"，30 秒內看到 streaming 回應；中斷按鈕測試。

P2 驗證：

- 對 agent 說「做出開心的表情然後揮手」→ 桌寵 joy 表情 + wave 動畫
- 對 agent 說「假裝你不認識的表情 xyz」→ MCP 回錯誤、LLM 自我修正
- 連續對話 10 輪後桌寵記憶體無洩漏（Electron Task Manager）

P3 驗證：刪除 config.json 後重啟，引導流程含 agent 步驟；跳過後桌寵正常運作。

最終驗收：完整對話 demo 影片 + `bun run test` 全綠 + `npx tsc --noEmit` 乾淨 + `bun run lint` 乾淨 + 兩平台至少一台手動測試。
