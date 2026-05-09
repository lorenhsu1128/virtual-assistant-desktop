# virtual-assistant-desktop — Claude Code 開發工作規範使用指南

> **版本：** v1.0  
> **最後更新：** 2026-04-03  
> **適用對象：** 所有使用 Claude Code 參與本專案開發的成員

---

## 📦 快速開始（5 分鐘上手）

### 前置需求

| 工具 | 版本 | 安裝方式 |
|------|------|----------|
| Node.js | 20+ | [nodejs.org](https://nodejs.org) |
| Claude Code | 最新版 | `npm install -g @anthropic-ai/claude-code` |
| Rust | stable | [rustup.rs](https://rustup.rs) |
| bun | 1.3+ | `powershell -c "irm bun.sh/install.ps1 | iex"`（Windows）/ `curl -fsSL https://bun.sh/install \| bash`（mac/Linux）|

### 安裝步驟

```bash
# 1. 將本包解壓縮到你的專案根目錄
#    確保 .claude/ 目錄和 CLAUDE.md 在專案根目錄

# 2. 確認目錄結構正確
ls -la .claude/
#  應該看到 skills/ agents/ commands/ hooks/ settings.json

# 3. 設定 MCP（如果需要 GitHub 整合）
export GITHUB_TOKEN="your-github-token"

# 4. 進入專案目錄，啟動 Claude Code
cd virtual-assistant-desktop
claude
```

就這樣，Claude Code 會自動讀取 `CLAUDE.md` 和 `.claude/` 中的所有設定。

---

## 🗂️ 檔案總覽

```
virtual-assistant-desktop/
│
├── CLAUDE.md                          ← 🧠 專案大腦（每次對話自動載入）
├── LESSONS.md                         ← 📕 錯誤記憶（被 CLAUDE.md 引用，每次載入）
├── .mcp.json                          ← 🔌 MCP 伺服器設定
│
├── .claude/
│   ├── settings.json                  ← 🔒 權限控制（允許/禁止的操作）
│   │
│   ├── rules/                         ← 🛡️ 路徑觸發規則（編輯特定檔案時自動載入）
│   │   ├── state-machine.md              StateMachine 純邏輯防護
│   │   ├── ipc-boundary.md               IPC 封裝防護
│   │   └── rust-safety.md                Rust 安全規則
│   │
│   ├── skills/                        ← 📚 開發技能（8 個）
│   │   ├── tauri-rust-module/SKILL.md    Rust 模組開發 SOP
│   │   ├── ts-frontend-module/SKILL.md   TypeScript 模組開發 SOP
│   │   ├── ipc-bridge/SKILL.md           IPC 介面開發 SOP
│   │   ├── vrm-threejs/SKILL.md          VRM/Three.js 開發指南
│   │   ├── state-machine/SKILL.md        行為狀態機開發指南
│   │   ├── vitest-unit/SKILL.md          單元測試撰寫指南
│   │   ├── svelte-settings/SKILL.md      設定視窗開發指南
│   │   └── version-release/SKILL.md      版本發布流程
│   │
│   ├── agents/                        ← 🤖 子代理（3 個）
│   │   ├── code-reviewer/AGENT.md        程式碼審查員
│   │   ├── rust-specialist/AGENT.md      Rust 後端專家
│   │   └── threejs-specialist/AGENT.md   Three.js 渲染專家
│   │
│   ├── commands/                      ← ⚡ 快捷命令（9 個）
│   │   ├── dev-auto.md                  /dev-auto — 一鍵自動流水線（核心）
│   │   ├── new-module.md                 /new-module — 建立模組腳手架
│   │   ├── add-ipc.md                    /add-ipc — 新增 IPC 介面
│   │   ├── check-perf.md                /check-perf — 效能檢查
│   │   ├── pre-release.md               /pre-release — 發布前檢查
│   │   ├── sync-types.md                /sync-types — 型別同步檢查
│   │   ├── doc-sync.md                  /doc-sync — 文件與程式碼同步
│   │   ├── log-mistake.md               /log-mistake — 記錄 AI 錯誤
│   │   └── dev-start.md                 /dev-start — 開發前準備
│   │
│   └── hooks/                         ← 🪝 自動化鉤子（3 個）
│       ├── pre-commit.sh                 提交前自動檢查
│       ├── post-edit-rust.sh             編輯 Rust 後自動 cargo check
│       └── lint-on-save.sh               編輯 TS 後自動格式檢查
│
├── src/CLAUDE.md                      ← 前端開發規則（進入 src/ 時載入）
├── src-tauri/CLAUDE.md                ← Rust 後端規則（進入 src-tauri/ 時載入）
└── src-settings/CLAUDE.md             ← 設定視窗規則（進入 src-settings/ 時載入）
```

---

## 🧠 CLAUDE.md — 專案記憶系統

### 它是什麼？

`CLAUDE.md` 是 Claude Code 的「專案記憶」。每次啟動 Claude Code 時，它會自動讀取根目錄的 `CLAUDE.md`，了解專案的架構規範、命名慣例、效能預算等。

### 多層 CLAUDE.md

本專案使用**分層 CLAUDE.md** 策略：

| 檔案 | 載入時機 | 內容 |
|------|----------|------|
| `CLAUDE.md`（根目錄）| 每次對話都載入 | 全域規則、架構原則、技術棧 |
| `src/CLAUDE.md` | 編輯 src/ 下檔案時載入 | render loop 順序、模組邊界、禁止清單 |
| `src-tauri/CLAUDE.md` | 編輯 src-tauri/ 下檔案時載入 | Rust 規範、Windows API 規則 |
| `src-settings/CLAUDE.md` | 編輯 src-settings/ 下檔案時載入 | Svelte 設定視窗規則 |

### 為什麼要分層？

- 根目錄 CLAUDE.md 控制在 **~100 行**，避免每次對話都消耗太多 context
- 子目錄 CLAUDE.md 只在需要時載入，提供**更細緻的規則**
- Claude Code 會依據你正在編輯的檔案位置，自動載入對應層的規則

### 如何修改？

直接編輯 markdown 檔案即可。建議將 CLAUDE.md 加入版本控制，讓團隊共享規範。

---

## 📚 Skills — 開發技能

### 它是什麼？

Skills 是「標準作業流程（SOP）」的 markdown 版本。Claude Code 會根據你的需求，自動判斷是否需要載入某個 Skill。每個 Skill 定義了：

- **使用時機**：什麼情況下觸發
- **輸入需求**：需要提供什麼資訊
- **步驟**：具體怎麼做
- **驗收標準**：怎樣算完成

### 8 個 Skills 總覽

| Skill | 觸發場景 | 簡述 |
|-------|----------|------|
| `tauri-rust-module` | 「新增一個 Rust 模組」「建立新的 Tauri command」 | Rust 側模組建立全流程 |
| `ts-frontend-module` | 「新增一個前端模組」「建立 AnimationManager」 | TS 側模組建立全流程 |
| `ipc-bridge` | 「新增 IPC command」「前後端通訊」 | Rust↔TS 雙側 IPC 開發 |
| `vrm-threejs` | 「VRM 模型」「Three.js 場景」「動畫播放」 | 3D 渲染相關開發指南 |
| `state-machine` | 「狀態機」「自主移動」「碰撞判定」 | 行為邏輯開發指南 |
| `vitest-unit` | 「寫測試」「單元測試」「測試覆蓋率」 | 測試撰寫規範 |
| `svelte-settings` | 「設定視窗」「設定頁面」 | Svelte 設定 UI 開發 |
| `version-release` | 「發布」「版本」「release」 | 版本發布流程 |

### 使用方式

你不需要手動指定要用哪個 Skill。只要自然描述你的需求，Claude Code 會自動選擇：

```
你：幫我建立一個新的 Rust 模組叫 audio_capture，負責麥克風擷取

Claude Code：（自動載入 tauri-rust-module Skill）
  → 建立 src-tauri/src/audio_capture.rs
  → 建立 src-tauri/src/commands/audio_capture_commands.rs
  → 更新 mod.rs 和 main.rs
  → 執行 cargo check
```

---

## 🤖 Agents — 子代理

### 它是什麼？

Agents 是「專業角色」。Claude Code 可以將特定領域的工作委派給專門的子代理，每個 Agent 有自己的專業知識和限制的工具集。

### 3 個 Agents

| Agent | 專長 | 使用情境 |
|-------|------|----------|
| `code-reviewer` | 架構合規性 + 程式碼品質審查 | 提交前審查、PR review |
| `rust-specialist` | Tauri/Rust/Windows API | 複雜的 Rust 後端開發 |
| `threejs-specialist` | Three.js/VRM/WebGL | 複雜的 3D 渲染開發 |

### 使用方式

```
你：請 code-reviewer 審查我最近的變更

Claude Code：（委派給 code-reviewer agent）
  → 掃描所有變更的檔案
  → 檢查架構合規性、模組邊界、程式碼品質
  → 輸出報告（🔴 BLOCK / 🟡 WARN / 🔵 INFO）
```

```
你：這個 WebGL context lost 的處理邏輯有問題，請 threejs-specialist 看一下

Claude Code：（委派給 threejs-specialist agent）
  → 專注分析 WebGL 相關程式碼
  → 提供 Three.js 領域的專業建議
```

---

## ⚡ Commands — 快捷命令

### 它是什麼？

Commands 是你可以直接在 Claude Code 中輸入的斜線命令，用於觸發常用工作流。

### 5 個 Commands

#### `/new-module` — 建立模組腳手架

```
/new-module rust audio_capture
→ 自動建立 Rust 模組的完整檔案結構

/new-module ts AnimationManager
→ 自動建立 TypeScript 模組 + 型別 + 測試

/new-module svelte Expression
→ 自動建立 ExpressionPage.svelte
```

#### `/add-ipc` — 新增 IPC 介面

```
/add-ipc command get_microphone_level
→ 同時在 Rust 和 TypeScript 兩側建立 typed command

/add-ipc event power_mode_changed
→ 同時在 Rust 和 TypeScript 兩側建立 typed event listener
```

#### `/check-perf` — 效能與安全檢查

```
/check-perf
→ 掃描整個專案，檢查：
  - setInterval 濫用
  - Rust unwrap()
  - 主執行緒阻塞
  - render loop 物件分配
  - WebGL context lost 處理
  - 模組邊界違規
  - TypeScript any 型別
```

#### `/pre-release` — 發布前檢查

```
/pre-release 0.1.0
→ 依序執行 9 項檢查：
  TypeScript → ESLint → Prettier → Vitest →
  Rust build → Clippy → Rust test →
  版本號一致性 → CHANGELOG
```

#### `/sync-types` — 型別同步

```
/sync-types
→ 比對 Rust struct 和 TypeScript interface
→ 找出不一致的欄位
→ 提供自動修正建議
```

#### `/doc-sync` — 文件與程式碼同步（🆕 防過時）

```
/doc-sync
→ 掃描 src/ 和 src-tauri/src/ 的實際檔案結構
→ 比對 CLAUDE.md 的目錄描述
→ 比對 IPC command 兩側是否一致
→ 找出新增但未記錄、已刪除但未清理的模組
→ 詢問是否自動修正
```

#### `/log-mistake` — 記錄 AI 錯誤（🆕 防再犯）

```
/log-mistake
→ 回顧這次對話中被修正的錯誤
→ 自動分類（架構違規/IPC/Rust/效能/型別）
→ 寫入 LESSONS.md
→ 建議是否需要加強 CLAUDE.md 或 Skills 的規則
```

#### `/dev-auto` — 一鍵自動開發流水線（🆕 核心命令）

```
/dev-auto 實作 CollisionSystem 碰撞判定系統

Claude：
  ═══════════════════════════════════
  Phase 1: 規劃
  ═══════════════════════════════════
  ⚠️ 相關教訓：
    [2026-04-05] StateMachine 不可 import three

  📋 開發步驟（6 步）：
    Step 1 — src/types/collision.ts
    Step 2 — get_window_list command
    Step 3 — TauriIPC.ts wrapper
    Step 4 — CollisionSystem.ts
    Step 5 — CollisionSystem.test.ts
    Step 6 — 整合到 SceneManager

  確認此計劃後，將自動執行所有步驟。

你：ok

Claude：（全程自動，不再中斷）
  ✅ Step 1/6 — 型別定義已建立
  ✅ Step 2/6 — Rust command 已新增
  ✅ Step 3/6 — TauriIPC 已更新
  ✅ Step 4/6 — CollisionSystem 已建立
  ✅ Step 5/6 — 測試已建立（12 tests）
  ✅ Step 6/6 — SceneManager 已整合
  🧪 測試：24/24 通過
  📝 Lint：✅  Clippy：✅
  ⚡ 效能：無違規
  📄 文件：CLAUDE.md 已更新
  📦 Commit：feat(collision): 實作碰撞判定系統
```

#### `/dev-start` — 開發前準備（🆕 防踩坑）

```
/dev-start 實作碰撞判定系統
→ 讀取 LESSONS.md 中相關教訓
→ 檢查文件是否過時
→ 列出預計涉及的模組和注意事項
→ 建議使用的 Skills
```

---

## 🪝 Hooks — 自動化鉤子

### 它是什麼？

Hooks 是在 Claude Code 的特定事件發生時自動執行的 shell 腳本。你不需要手動觸發。

### 3 個 Hooks

| Hook | 觸發時機 | 做什麼 |
|------|----------|--------|
| `pre-commit.sh` | 執行 `git commit` 前 | 阻止敏感檔案提交、ESLint、Clippy、偵測 unwrap/any |
| `post-edit-rust.sh` | 編輯 `.rs` 檔案後 | 自動執行 `cargo check` |
| `lint-on-save.sh` | 編輯 `.ts`/`.svelte` 後 | 自動執行 Prettier 格式檢查 |

### 啟用方式

Hooks 在 `.claude/hooks/` 目錄中，Claude Code 會自動識別。確保檔案有執行權限：

```bash
chmod +x .claude/hooks/*.sh
```

---

## 🔌 MCP — 外部工具整合

### 它是什麼？

MCP（Model Context Protocol）讓 Claude Code 可以連接外部工具和服務。

### 預設設定

本專案的 `.mcp.json` 預設包含：

| MCP 伺服器 | 用途 |
|-----------|------|
| **GitHub** | Issue 追蹤、PR 管理 |

### 設定 GitHub MCP

```bash
# 設定 GitHub Token（需要 repo 權限）
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"

# 或寫入 shell profile
echo 'export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"' >> ~/.bashrc
```

### 新增更多 MCP 伺服器

```bash
# 例如新增 Playwright（用於設定視窗 UI 測試）
claude mcp add --transport stdio playwright -- npx @anthropic-ai/mcp-server-playwright
```

⚠️ **注意**：每個 MCP 伺服器都會消耗 context token。只安裝真正需要的。

---

## 🔒 settings.json — 權限控制

### 它是什麼？

`settings.json` 控制 Claude Code 可以執行哪些操作。這是一層安全防護。

### 目前設定

**允許的操作：**
- 讀取所有檔案
- 編輯 `src/`、`src-tauri/src/`、`src-settings/`、`tests/` 下的檔案
- 執行 bun、cargo、git 的常用命令

**禁止的操作：**
- 修改 `tauri.conf.json`（避免意外更改 Tauri 設定）
- 修改 `.env` 檔案（避免洩漏密鑰）
- 執行 `rm -rf`（避免誤刪）
- 執行 `bun run tauri build`（避免意外建置）
- 執行 `git push/merge/rebase`（避免意外推送）

### 修改權限

編輯 `.claude/settings.json`，在 `allow` 或 `deny` 陣列中新增規則。

---

## 🔄 開發工作流程

### 日常開發流程（推薦）

用 `/dev-auto` 一鍵完成，只需確認計劃：

```
 ┌─────────────────────────────────────────────┐
 │  你：/dev-auto 實作碰撞判定系統               │
 └─────────────┬───────────────────────────────┘
               │
 ┌─────────────▼───────────────────────────────┐
 │  Claude 自動：讀取教訓 → 產出開發計劃         │
 │  （列出步驟、涉及模組、注意事項）              │
 └─────────────┬───────────────────────────────┘
               │
 ┌─────────────▼───────────────────────────────┐
 │  👤 你：確認計劃（唯一人工介入點）             │
 │  輸入 "ok" 或提出修改意見                     │
 └─────────────┬───────────────────────────────┘
               │
 ┌─────────────▼───────────────────────────────┐
 │  Claude 全程自動：                            │
 │  建立檔案 → 寫程式碼 → 跑測試 →              │
 │  lint/clippy → 效能檢查 → 程式碼審查 →        │
 │  文件同步 → git commit                       │
 └─────────────┬───────────────────────────────┘
               │
 ┌─────────────▼───────────────────────────────┐
 │  完成報告（列出所有結果和需注意事項）          │
 └─────────────────────────────────────────────┘
```

### 進階：手動逐步開發

如果你想要更精細的控制，仍可使用獨立命令：

**範例 1：新增一個 Rust IPC Command**

```
你：新增一個 IPC command 叫 get_microphone_level，回傳 f32 的音量值

Claude Code：
  1. （自動載入 ipc-bridge Skill）
  2. 建立 Rust command handler
  3. 在 main.rs 中註冊
  4. 建立 TypeScript typed wrapper
  5. 更新型別定義
  6. 執行 cargo check + tsc --noEmit
```

**範例 2：新增一個前端模組**

```
你：/new-module ts ExpressionManager

Claude Code：
  1. 詢問所屬目錄 → expression/
  2. 建立 src/expression/ExpressionManager.ts
  3. 建立 tests/unit/ExpressionManager.test.ts
  4. 包含 JSDoc 和基礎結構
```

**範例 3：發布前完整檢查**

```
你：/pre-release 0.2.0

Claude Code：
  ① TypeScript 型別檢查    ✅
  ② ESLint                 ✅
  ③ Prettier               ✅
  ④ Vitest                 ✅ (24/24)
  ⑤ Rust Release 編譯      ✅
  ⑥ Clippy                 ✅ (0 warnings)
  ⑦ Rust 測試              ✅ (8/8)
  ⑧ 版本號一致性           ❌ package.json 是 0.1.0
  ⑨ CHANGELOG              ⚠️ 未找到 v0.2.0 條目
```

### 版本里程碑開發流程

```
你：開始開發 v0.2 的所有功能

Claude Code：
  1. 閱讀 SPEC.md 中 v0.2 的範圍
  2. 拆解為開發任務：
     - window_monitor.rs（視窗輪詢）
     - CollisionSystem（碰撞判定）
     - StateMachine（行為狀態機）
     - BehaviorAnimationBridge（狀態→動畫）
     - DragHandler（拖曳與吸附）
     - SetWindowRgn 遮擋實作
     - ContextMenu（右鍵選單）
  3. 按順序逐模組開發
  4. /check-perf 效能檢查
  5. /sync-types 型別同步
  6. /pre-release 0.2.0
```

---

## 💡 最佳實踐

### Do ✅

- **使用 Plan Mode**：複雜任務先讓 Claude 規劃，你審核後再執行
- **善用 Commands**：重複性工作用 `/new-module`、`/add-ipc` 等快捷命令
- **定期 /check-perf**：開發過程中定期跑效能檢查，及早發現問題
- **提交前 code-review**：重要變更讓 code-reviewer agent 審查
- **保持 CLAUDE.md 精簡**：全域規則 < 200 行，細節放 Skills
- **版本控制 .claude/**：將整個 `.claude/` 目錄加入 Git，團隊共享

### Don't ❌

- **不要跳過 Plan Mode**：直接寫複雜功能容易出現架構問題
- **不要手動繞過模組邊界**：即使看似方便，也要遵守 CLAUDE.md 中的禁止清單
- **不要安裝太多 MCP**：每個 MCP 消耗 context，只裝必要的
- **不要把密鑰寫入 .mcp.json**：使用環境變數 `${VAR_NAME}`
- **不要忽略 Hook 警告**：`unwrap()` 和 `any` 警告雖不阻止提交，但應盡快修正

---

## 🛠️ 自訂與擴充

### 新增自訂 Skill

```bash
mkdir -p .claude/skills/my-skill
cat > .claude/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: 簡短描述，Claude Code 據此判斷何時載入
---

## 步驟

1. ...
2. ...

## 驗收標準

- [ ] ...
EOF
```

### 新增自訂 Command

```bash
cat > .claude/commands/my-command.md << 'EOF'
---
name: my-command
description: 命令描述
argument-hint: "[arg1] [arg2]"
user-invocable: true
---

當使用者輸入 /my-command 時，執行以下操作...
EOF
```

### 新增自訂 Agent

```bash
mkdir -p .claude/agents/my-agent
cat > .claude/agents/my-agent/AGENT.md << 'EOF'
---
name: my-agent
description: Agent 描述
tools: [Read, Write, Edit, Bash]
---

你是...（角色定義和指令）
EOF
```

### 新增 MCP 伺服器

```bash
# CLI 方式
claude mcp add --transport stdio my-server -- npx my-mcp-server

# 或直接編輯 .mcp.json
```

---

## 🧠 文件自動同步與錯誤記憶

### 核心問題

Claude Code **沒有跨對話記憶**，也**不會自動更新文件**。這意味著：

1. 你新增了模組，但 CLAUDE.md 還是舊的 → 下次對話基於過時資訊開發
2. Claude Code 犯了架構錯誤，你修正了，但沒記錄 → 新對話再犯同樣的錯

### 解決方案：3 個機制

#### 機制 1：LESSONS.md — 錯誤記憶

`LESSONS.md` 是 AI 的「錯誤記憶」檔案。已被 `CLAUDE.md` 引用（`@LESSONS.md`），所以**每次對話都會載入**。

**何時使用**：每當你修正了 Claude Code 的錯誤之後

```
你：你剛才在 StateMachine 裡用了 Three.js 的 Vector3，這違反了純邏輯模組的規則
Claude：（修正錯誤）
你：/log-mistake

Claude：
  已記錄到 LESSONS.md → 架構違規分類
  - 錯誤：在 StateMachine 中 import Three.js
  - 正確：使用 { x: number, y: number } 純資料型別
  - 根因：Vector3 看似方便但破壞可測試性
```

下次新對話，Claude Code 讀取 LESSONS.md 後就知道不能在 StateMachine 中用 Three.js。

#### 機制 2：/doc-sync — 文件同步掃描

開發告一段落後執行，掃描程式碼與文件的差異：

```
你：/doc-sync

Claude：
  📁 目錄結構：新增模組未記錄 — src/behavior/WanderStrategy.ts
  🔌 IPC 介面：Rust 側新增 get_display_list 但前端缺少
  📐 型別：DisplayInfo 兩側不一致
  🧪 測試：WanderStrategy 缺少測試
  
  是否自動修正？
```

**建議頻率**：每完成一個功能模組後執行一次。

#### 機制 3：/dev-start — 開發前準備

開始新任務前執行，自動讀取相關教訓和檢查文件新鮮度：

```
你：/dev-start 實作 CollisionSystem 碰撞判定

Claude：
  ⚠️ 相關教訓：
    [2026-04-05] StateMachine 中不可 import Three.js
    [2026-04-08] 碰撞結果必須用純資料傳遞

  📁 預計涉及模組：
    src/behavior/CollisionSystem.ts（新增）
    tests/unit/CollisionSystem.test.ts（新增）

  🚧 注意：CollisionSystem 不可直接操作 3D 物件
  
  準備完成，可以開始開發
```

### 建議的開發節奏

```
/dev-start 任務描述      ← 開始前：讀取教訓、檢查文件
  ↓
  （開發中...）
  ↓
如果 AI 犯錯 → 修正後 /log-mistake   ← 即時記錄
  ↓
/doc-sync                ← 開發完成：同步文件
  ↓
/check-perf              ← 效能檢查
```

### .claude/rules/ — 路徑觸發規則

`rules/` 目錄中的規則會在 Claude Code **編輯對應檔案時自動載入**（不需手動觸發）：

| 規則檔案 | 觸發時機 | 內容 |
|----------|----------|------|
| `state-machine.md` | 編輯 StateMachine.ts 時 | 禁止 import three |
| `ipc-boundary.md` | 編輯 bridge/ 以外的 TS 時 | 禁止直接 invoke() |
| `rust-safety.md` | 編輯任何 .rs 時 | 禁止 unwrap() |

這些是「最後一道防線」— 即使 Claude Code 忘了 CLAUDE.md 的規則，編輯特定檔案時 rules 會再次提醒。

---

## ❓ 常見問題

### Q: Claude Code 沒有讀取 CLAUDE.md？

確認 `CLAUDE.md` 在專案根目錄（你執行 `claude` 的目錄）。

### Q: Skill 沒有自動觸發？

檢查 SKILL.md 的 `description` 欄位，確保描述足夠明確，讓 Claude Code 能匹配到你的需求。

### Q: Hook 沒有執行？

```bash
# 確認檔案有執行權限
chmod +x .claude/hooks/*.sh

# 確認檔案路徑正確
ls -la .claude/hooks/
```

### Q: MCP 連線失敗？

```bash
# 檢查已設定的 MCP
claude mcp list

# 確認環境變數已設定
echo $GITHUB_TOKEN
```

### Q: 如何在團隊中共享這些設定？

將以下檔案加入 Git：

```bash
git add CLAUDE.md
git add src/CLAUDE.md src-tauri/CLAUDE.md src-settings/CLAUDE.md
git add .claude/skills/ .claude/agents/ .claude/commands/ .claude/hooks/
git add .claude/settings.json
git add .mcp.json
git commit -m "chore: add Claude Code development workflow"
```

⚠️ 不要提交包含密鑰的檔案。`.mcp.json` 中使用 `${ENV_VAR}` 引用環境變數。

### Q: 各版本應該啟用哪些 Skills？

| 版本 | 主要使用的 Skills |
|------|------------------|
| v0.1 | tauri-rust-module, ts-frontend-module, vrm-threejs, ipc-bridge, vitest-unit |
| v0.2 | 上述 + state-machine |
| v0.3 | 上述 + svelte-settings |
| v0.5 | 上述 + version-release |

所有 Skills 都可以同時存在，Claude Code 只會在需要時載入相關的 Skill。

---

## 📊 配置元件關係圖

```
                    ┌──────────────────┐
                    │    CLAUDE.md     │  ← 每次對話都載入
                    │  （全域規則）      │     架構原則、命名、效能
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────▼─────┐ ┌─────▼──────┐ ┌─────▼──────────┐
     │src/CLAUDE.md │ │src-tauri/  │ │src-settings/   │  ← 按目錄載入
     │（前端規則）   │ │CLAUDE.md   │ │CLAUDE.md       │     細部規範
     └──────────────┘ │（Rust規則）│ │（Svelte規則）  │
                      └────────────┘ └────────────────┘

     ┌──────────────────────────────────────────────┐
     │              .claude/skills/                  │  ← 按需載入
     │  tauri-rust-module │ ts-frontend-module │ ... │     開發 SOP
     └──────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────┐
     │              .claude/agents/                  │  ← 委派時載入
     │  code-reviewer │ rust-specialist │ threejs-.. │     專業角色
     └──────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────┐
     │             .claude/commands/                  │  ← /命令 觸發
     │  /new-module │ /add-ipc │ /check-perf │ ...  │     快捷工作流
     └──────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────┐
     │              .claude/hooks/                   │  ← 自動觸發
     │  pre-commit │ post-edit-rust │ lint-on-save  │     品質防護
     └──────────────────────────────────────────────┘

     ┌──────────────────────────────────────────────┐
     │  .mcp.json  │  .claude/settings.json         │  ← 環境設定
     │  外部工具    │  權限控制                       │
     └──────────────────────────────────────────────┘
```

---

*本文件隨專案演進持續更新。如有問題，歡迎提出 Issue 或在團隊 channel 中討論。*
