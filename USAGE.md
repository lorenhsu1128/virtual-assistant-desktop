# Virtual Assistant Desktop — 操作手冊

> **版本：** v0.3.x agent  
> **更新日期：** 2026-05-09

---

## 1. 環境需求

| 項目 | 最低版本 | 說明 |
|------|---------|------|
| Node.js | 18+ | 建議使用 LTS 版本（Electron 主程序執行） |
| bun | 1.3+ | 套件管理員與 script runner（取代舊的 pnpm + Corepack）|
| 作業系統 | Windows 10 (1903+) / macOS | macOS 僅限開發預覽 |
| 顯示卡 | 支援 WebGL 2.0 | Three.js 渲染需求 |

### Windows 額外需求

- **Visual Studio Build Tools**（或完整 Visual Studio）— koffi FFI 編譯原生模組需要
- 安裝時需勾選 **「C++ 桌面開發」** 工作負載

### macOS 注意事項

- koffi 視窗列舉功能（`GetWindow` 等 Windows API）**僅在 Windows 上運作**
- macOS 下可正常開發與預覽 3D 渲染、動畫系統、表情系統
- 視窗碰撞、吸附、遮擋等功能在 macOS 上不會啟用

---

## 2. 安裝與建置

### 2.1 首次安裝

```bash
# 安裝 bun（Windows，PowerShell）
powershell -c "irm bun.sh/install.ps1 | iex"
# 或 macOS / Linux：
# curl -fsSL https://bun.sh/install | bash

# 安裝依賴
bun install
```

### 2.2 開發模式

```bash
bun run dev
```

此指令會同時啟動：
1. **Vite 開發伺服器**（`http://localhost:1420`）— 前端熱更新
2. **Electron 主程序** — 等待 Vite 就緒後啟動

開發模式下按 **F12** 可開啟 DevTools。

### 2.3 編譯

```bash
bun run build
```

執行順序：
1. `tsc` — 前端 TypeScript 型別檢查
2. `vite build` — 打包前端至 `dist/`
3. `tsc -p tsconfig.electron.json` — 編譯 Electron 主程序至 `dist-electron/`

### 2.4 打包安裝程式

```bash
# 自動偵測當前平台打包
bun run package

# 指定平台打包
bun run package:win    # Windows — 產出 .exe (NSIS)
bun run package:mac    # macOS   — 產出 .dmg + .zip
```

產出目錄：`release/`。

> **注意：** macOS 打包需要 `build/icon.icns` 圖示檔。可用 [Image2icon](https://img2icnsapp.com/) 或 `iconutil` 從 PNG 轉換。
> 若要發佈到 App Store 或通過 Gatekeeper 驗證，需使用 Apple Developer 憑證簽署。開發測試時可不簽署。

### 2.5 其他常用指令

| 指令 | 說明 |
|------|------|
| `bun run test` | 執行 Vitest 單元測試 |
| `bun run test:watch` | Vitest 監視模式 |
| `bun run lint` | ESLint 靜態檢查 |
| `bun run lint:fix` | ESLint 自動修正 |
| `bun run format` | Prettier 格式化 |
| `bun run typecheck` | TypeScript 型別檢查（前端 + Electron） |

---

## 3. 首次啟動流程

首次啟動時（`~/.virtual-assistant-desktop/config.json` 不存在），軟體會引導你完成初始設定：

1. **選擇 VRM 模型** — 彈出檔案選擇器，選取一個 `.vrm` 檔案（必要步驟）
2. **選擇動畫資料夾**（可選）— 指定存放 `.vrma` 動畫檔案的資料夾。跳過則使用內建 fallback 動畫
3. **完成** — 自動建立 `config.json`，啟動主程式

設定檔存放於：

```
~/.virtual-assistant-desktop/
├── config.json          # 使用者偏好設定
├── animations.json      # 動畫 metadata
└── config.json.bak      # 設定損毀時的自動備份
```

---

## 4. 擴充 VRM 模型

### 4.1 支援格式

- **VRM 0.x** 與 **VRM 1.0** 標準格式
- 建議檔案大小 **≤ 50 MB**
- 建議頂點數 **≤ 10 萬**

### 4.2 取得 VRM 模型

常見的 VRM 模型來源：

- [VRoid Hub](https://hub.vroid.com/) — 免費 VRM 模型共享平台
- [VRoid Studio](https://vroid.com/studio) — 自製 VRM 角色工具
- [BOOTH](https://booth.pm/) — VRM 模型商城（搜尋 `.vrm`）

### 4.3 更換模型

**方法一：系統托盤**

1. 左鍵點擊系統托盤圖示（右下角通知區域）
2. 選擇「**更換 VRM 模型**」
3. 在檔案選擇器中選取新的 `.vrm` 檔案

**方法二：手動修改設定**

編輯 `~/.virtual-assistant-desktop/config.json`，修改 `vrmModelPath`：

```json
{
  "vrmModelPath": "C:/Users/你的名稱/VRModels/MyCharacter.vrm"
}
```

重新啟動軟體即可載入新模型。

### 4.4 模型內建功能

VRM 模型自帶的以下功能會被自動使用：

- **BlendShape 表情** — 自動讀取模型支援的所有表情，可透過托盤選單手動切換
- **SpringBone 物理** — 頭髮、衣物擺動（v0.4 完整支援）
- **LookAt 視線** — 角色視線追蹤（v0.5 搭配攝影機）

---

## 5. 擴充動畫

### 5.1 支援格式

目前僅支援 **`.vrma`**（VRM Animation）格式。

`.vrma` 檔案可透過以下工具製作或轉換：
- [VRM Animation Editor](https://vrm-addon-for-blender.info/en/) — Blender 外掛
- 從 BVH / FBX 轉換為 .vrma 的第三方工具

### 5.2 新增動畫

1. 將 `.vrma` 檔案放入動畫資料夾（首次啟動時指定的資料夾）
2. 透過系統托盤選擇「**更換動畫資料夾**」重新掃描，或重新啟動軟體

軟體啟動時會自動掃描動畫資料夾內所有 `.vrma` 檔案。

### 5.3 動畫分類

每個動畫可被歸類為以下分類，決定其觸發方式：

| 分類 | 觸發方式 | 預設循環 | 說明 |
|------|---------|---------|------|
| `idle` | 自動輪播 | 是 | 待機時隨機播放，每段結束後 crossfade 到下一段 |
| `action` | 手動觸發 | 否 | 透過系統托盤「動畫」選單手動播放 |
| `sit` | 狀態機觸發 | 是 | 角色吸附到視窗頂部時自動播放 |
| `fall` | 狀態機觸發 | 否 | 吸附的視窗被關閉/最小化時播放 |
| `collide` | 碰撞觸發 | 否 | 角色碰到視窗邊緣時的反應動畫 |
| `peek` | 狀態機觸發 | 否 | 角色躲在視窗後面時的探頭動畫 |

> 新掃描到的 `.vrma` 預設歸類為 `action`。

### 5.4 設定動畫 metadata

編輯 `~/.virtual-assistant-desktop/animations.json` 可自訂每個動畫的分類、顯示名稱、循環與權重：

```json
{
  "folderPath": "C:/Users/你的名稱/MyAnimations",
  "entries": [
    {
      "fileName": "relax_idle.vrma",
      "displayName": "放鬆待機",
      "category": "idle",
      "loop": true,
      "weight": 2.0
    },
    {
      "fileName": "wave_hand.vrma",
      "displayName": "揮手",
      "category": "action",
      "loop": false,
      "weight": 1.0
    },
    {
      "fileName": "sit_on_window.vrma",
      "displayName": "坐下",
      "category": "sit",
      "loop": true,
      "weight": 1.0
    }
  ]
}
```

#### 欄位說明

| 欄位 | 型別 | 說明 |
|------|------|------|
| `fileName` | string | `.vrma` 檔案名稱（不含路徑） |
| `displayName` | string | 在托盤選單中顯示的名稱（預設使用檔名） |
| `category` | string | 分類：`idle` / `action` / `sit` / `fall` / `collide` / `peek` |
| `loop` | boolean | 是否循環播放 |
| `weight` | number | 隨機選取的權重（數值越大，被選到的機率越高） |

### 5.5 系統動畫

專案內建一組系統動畫，位於 `assets/system/vrma/`，以 `SYS_{STATE}_NN.vrma` 命名：

```
SYS_IDLE_01 ~ SYS_IDLE_20.vrma     — 待機輪播（20 支）
SYS_WALK_01 ~ SYS_WALK_06.vrma     — 行走變體（6 支，per-clip 步伐重分析）
SYS_SIT_01 ~ SYS_SIT_11.vrma       — 坐下變體（11 支）
SYS_DRAGGING_01 ~ SYS_DRAGGING_02.vrma — 拖曳中（2 支）
SYS_PEEK_01.vrma                   — 探頭（runtime mirror 左右）
SYS_HIDE_01.vrma                   — 躲藏移動
SYS_OPENDOOR_01.vrma               — 從視窗後開門走出
SYS_RUN_01.vrma                    — 跑步（保留供未來狀態擴充）
SYS_TYPING_01.vrma                 — 使用者打字時的伴隨動畫
```

系統動畫由程式於啟動時一次性掃描載入（`src/main.ts: loadAllSystemAnimations`），不需要手動設定也不會出現在 `animations.json` 中。詳細命名規則與載入流程見 [animation-guide.md](./animation-guide.md)。

### 5.6 Fallback 動畫

當沒有任何 `idle` 分類的動畫時，程式會自動啟用內建 fallback 動畫：
- **呼吸** — 胸部骨骼微幅上下擺動
- **眨眼** — BlendShape 週期性觸發

確保角色在沒有外部動畫的情況下不會完全靜止。

---

## 6. 設定檔參考

### config.json 完整欄位

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `vrmModelPath` | string \| null | null | VRM 模型檔案的完整路徑 |
| `animationFolderPath` | string \| null | null | 動畫資料夾路徑 |
| `windowPosition` | {x, y} | {0, 0} | 視窗位置 |
| `windowSize` | {width, height} | {400, 600} | 視窗大小 |
| `scale` | number | 1.0 | 角色縮放（0.5–2.0） |
| `targetFps` | number | 30 | 目標幀率 |
| `powerSaveMode` | boolean | false | 省電模式 |
| `autonomousMovementPaused` | boolean | false | 暫停自主移動 |
| `animationLoopEnabled` | boolean | true | 動畫循環播放 |
| `autoExpressionEnabled` | boolean | true | 自動表情切換 |
| `allowedAutoExpressions` | string[] | [] | 允許自動播放的表情清單 |
| `animationSpeed` | number | 1.0 | 動畫速率倍率 |
| `moveSpeedMultiplier` | number | 1.0 | 移動速率倍率 |
| `micEnabled` | boolean | false | 麥克風開關 |
| `cameraEnabled` | boolean | false | 攝影機開關 |
| `systemAssetsDir` | string | "assets/system" | 系統資產目錄 |
| `mtoonOutlineEnabled` | boolean | false | MToon 描邊（正交相機下會變粗黑邊，預設關） |
| `agent` | object | 見下表 | my-agent 整合設定（v0.3.x agent） |

#### config.json `agent` 子物件

| 欄位 | 型別 | 預設值 | 說明 |
|------|------|--------|------|
| `agent.enabled` | boolean | false | 是否啟用 my-agent 整合 |
| `agent.daemonMode` | "auto" \| "external" | "auto" | auto = 桌寵自動 spawn / 監看 / 關閉 daemon；external = 使用者自行 `cli daemon start`，桌寵僅連線 |
| `agent.bunBinaryPath` | string \| null | null | Bun runtime 路徑（null = 自動偵測 `~/.bun/bin/bun.exe` 等常見位置） |
| `agent.myAgentCliPath` | string \| null | null | my-agent CLI 路徑（null = 自動偵測 `~/Documents/_projects/my-agent/cli.exe` 等） |
| `agent.workspaceCwd` | string \| null | null | Agent workspace cwd（null = `~/.virtual-assistant-desktop/agent-workspace`） |

---

## 7. 系統托盤操作

左鍵點擊系統托盤圖示（Windows 右下角通知區域）開啟控制選單：

```
顯示桌寵
動畫 ▸              依分類列出所有可用動畫
表情 ▸              列出模型所有 BlendShape 表情
縮放 ▸              50% / 75% / 100% / 125% / 150% / 200%
動畫速率 ▸          0.5x / 0.75x / 1.0x / 1.25x / 1.5x / 2.0x
移動速率 ▸          50% / 60% / ... / 150%（每 10% 一檔）
─────────
暫停/恢復自主移動
暫停/恢復自動表情
暫停/恢復動畫循環
─────────
重置鏡頭角度
重置回桌面正中央
更換 VRM 模型
瀏覽 VRM 模型...     開啟自訂預覽對話框（VRM Picker）
更換動畫資料夾
切換 display ▸      多螢幕間切換桌寵所在螢幕
─────────
MToon 描邊           開啟/關閉（正交相機下預設關）
Debug 模式           開啟/關閉 debug overlay
設定                 開啟設定視窗（v0.3.x agent，目前含 Agent 整合頁）
─────────
Agent 對話           toggle Agent 對話氣泡視窗（需先在設定中啟用 my-agent 整合）
Agent 重新連線       手動重啟 daemon 連線
─────────
結束
```

### Debug 模式功能

啟用後會顯示以下除錯資訊：

- 骨骼座標面板（3D 世界座標 + 2D 螢幕座標）
- 骨骼末端彩色圓點（頭/手/臀/腳）
- 桌面視窗清單面板（title, x, y, w, h, zOrder）
- 視窗 Z-order 視覺化邊框
- 骨骼與視窗邊緣接觸偵測
- 工作列偵測

---

## 8. my-agent 整合（v0.3.x agent）

可選功能：把 [my-agent](https://github.com/lorenhsu1128/my-agent)（本機 Claude Code 風格 CLI agent）作為桌寵的 AI 大腦。透過對話氣泡與 LLM 對話，並讓 LLM 透過 MCP tool 直接控制桌寵的表情與動畫。

### 8.1 啟用前需要

- **Bun runtime**（v1.3+）— 若你用 my-agent 自帶的 standalone binary（`cli.exe`）則不需要
- **my-agent CLI** — 從 my-agent 專案 `bun run build` 取得 `cli.exe`，或 `bun run build:dev`
- **LLM 設定** — my-agent 端設好 `~/.my-agent/.my-agent.jsonc` 或 `~/.my-agent/llamacpp.jsonc`（Anthropic API key / llama.cpp local server / Bedrock 等）

### 8.2 啟用步驟

1. 在系統托盤點 **設定** → 切到「my-agent 整合」頁
2. 切換「啟用 my-agent 整合」開關
3. 視需要填路徑（留空 = 自動偵測常見位置）
4. 按「套用」— 桌寵會自動 spawn daemon 並註冊 MCP server，狀態 chip 變綠 `ONLINE` 即就緒
5. 點托盤「Agent 對話」開氣泡視窗，與 LLM 對話

### 8.3 對話氣泡視窗

- 沿用 my-agent web UI 的 React 對話元件，行為與 my-agent TUI / web 一致
- 支援 streaming text、thinking 段折疊、tool call 卡片
- 拖曳標題列移動、按 ✕ 隱藏（不退出 daemon）
- daemon 離線時輸入框 disable

### 8.4 LLM 反向控制桌寵

LLM 可透過 4 個 MCP tool 控制桌寵：

| Tool | 作用 |
|------|------|
| `set_expression` | 切換 VRM 表情（含 case-insensitive 匹配 + durationMs 自動回退） |
| `play_animation` | 依 category（idle/action/sit/...）或檔名播放 |
| `say` | 推送輔助訊息到對話氣泡（v1 暫只 log，v0.4 補實際渲染） |
| `look_at_screen` | 指定視線螢幕座標（v1 預留，v0.5 攝影機追蹤實作） |

對 LLM 說「對我笑一下」「揮個手」就會觸發。

### 8.5 限制

- 本地 llama.cpp 模型（如 qwen3.5-9b）會把 mcp tool 包進 my-agent `Skill` meta-tool，**Skill router 不認得 mcp 工具名**而失敗。Anthropic API 模型直接呼叫工具則正常。這是 my-agent 上游 issue
- macOS 上 my-agent 與 daemon 行為與 Windows 一致（無 koffi 依賴）

詳細整合架構與經驗教訓見 [AGENT_INTEGRATION_PLAN.md](./AGENT_INTEGRATION_PLAN.md) 與 [LESSONS.md](./LESSONS.md)。

---

## 9. 平台差異總結

| 功能 | Windows | macOS |
|------|---------|-------|
| 3D 渲染 / VRM 載入 | ✅ | ✅ |
| 動畫播放 / 表情系統 | ✅ | ✅ |
| 拖曳移動 | ✅ | ✅ |
| 角色縮放 | ✅ | ✅ |
| 系統托盤 | ✅ | ✅ |
| 視窗碰撞 / 吸附 | ✅ | ❌（需 Windows API） |
| 視窗遮擋 / 探頭 | ✅ | ❌（需 Windows API） |
| 自主移動（walk/sit/peek） | ✅ | ⚠️ 部分（無視窗互動） |
| 打包安裝程式 | ✅ (.exe) | ✅ (.dmg / .zip) |

---

## 10. 常見問題

### 啟動後看不到角色

- 確認已選擇有效的 `.vrm` 模型
- 檢查 `config.json` 中 `vrmModelPath` 指向的檔案是否存在
- 嘗試透過托盤選單「重置回桌面正中央」

### 動畫沒有出現在選單中

- 確認動畫檔案為 `.vrma` 格式
- 確認 `config.json` 中 `animationFolderPath` 指向正確的資料夾
- 透過托盤選單「更換動畫資料夾」重新掃描

### Windows 上 `bun install` 失敗

- 確認已安裝 **Visual Studio Build Tools**（含 C++ 桌面開發工作負載）
- koffi 需要原生模組編譯環境

### macOS 上出現 koffi 相關警告

- 這是正常現象，koffi 的 Windows API 呼叫在 macOS 上不會執行
- 不影響 3D 渲染和動畫功能

### Agent 對話氣泡顯示「offline」

- 確認設定視窗「啟用 my-agent 整合」已開
- 確認 my-agent CLI 路徑正確（看設定視窗下方的 daemon pid / port 是否顯示）
- 看 dev 視窗 stdout 或 `~/.virtual-assistant-desktop/logs/agent-daemon-YYYY-MM-DD.log` 找錯誤
- 常見：上次 dev session 留了 orphan daemon 進程 + `.daemon.lock`：見 LESSONS.md「daemon orphan 進程 + .daemon.lock 卡死重啟」清理流程

### LLM 回應「我沒有這種工具」

- 本地 llama.cpp 模型（qwen 等）目前會把 mcp tool 包進 my-agent `Skill` meta-tool 失敗，這是 my-agent 上游 issue
- 換 Anthropic API（在 my-agent 端設 `ANTHROPIC_API_KEY`）可正常觸發
