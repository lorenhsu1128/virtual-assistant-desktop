# virtual-assistant-desktop

桌面虛擬陪伴軟體（Desktop Mascot）— Electron + TypeScript + Three.js + @pixiv/three-vrm。

在桌面常駐顯示一個 VRM 3D 角色，支援自主移動、視窗互動、表情、動畫播放、系統托盤控制，並可選整合 [my-agent](https://github.com/lorenhsu1128/my-agent)（本地 Claude Code 風格 CLI agent）作為 AI 大腦：透過對話氣泡與 LLM 對話，並讓 LLM 透過 MCP tool 直接控制桌寵的表情與動畫。

## 支援平台

| 平台 | 狀態 | 備註 |
|------|------|------|
| Windows 10 (1903+) / Windows 11 | ✅ 完整 | 含視窗碰撞 / 吸附 / 遮擋 / Peek（koffi FFI） |
| macOS 11 Big Sur 以上 | 🟡 部分 | 渲染、動畫、表情、自主移動可運作；視窗感知功能停用 |

## 版本進度

| 版本 | 狀態 | 範圍 |
|------|------|------|
| v0.1 | ✅ | 透明視窗 + VRM 模型 + .vrma 動畫系統 |
| v0.2 | ✅ | 視窗碰撞 / 吸附 / 遮擋 + 自主移動狀態機 + 拖曳 |
| v0.3 | ✅ | 表情系統（自動+手動）+ 系統托盤 + Debug overlay |
| v0.3.x | ✅ | VRM Picker 預覽對話框 + 動作 / 表情過渡平順化 |
| v0.3.x agent | ✅ | my-agent 整合：daemon 生命週期、ws 對話氣泡（React + my-agent web chat 元件）、MCP server 表演控制、設定視窗 |
| v0.4 | ⏸ | 麥克風唇形同步 + SpringBone 物理 + 首次啟動引導 |
| v0.5 | ⏸ | 攝影機臉部追蹤 + 進階設定面板 + 自動更新 |

## 快速啟動

```bash
bun install
bun run dev
```

開發模式同時啟動 Vite 與 Electron（按 F12 開 DevTools）。

## 打包

```bash
# 自動偵測當前平台
bun run package

# 指定平台
bun run package:win    # Windows  → .exe (NSIS)
bun run package:mac    # macOS    → .dmg + .zip
```

## my-agent 整合（v0.3.x agent）

桌寵可選擇連接本機 my-agent daemon 作為 AI 大腦。在 [系統托盤 → 設定] 開啟設定視窗、勾選「啟用 my-agent 整合」、按「套用」即可。

需要：

- bun 1.3+（執行 my-agent 的 runtime；若使用者用 `cli build --compile` 產出的 standalone binary 則不需要）
- my-agent CLI（可由 [my-agent 專案](https://github.com/lorenhsu1128/my-agent) `bun run build` 取得 `cli.exe`）
- 設定視窗會自動偵測 `~/.bun/bin/bun.exe` 與 `~/Documents/_projects/my-agent/cli.exe`，不在預設位置時可手動填入路徑

詳見 [AGENT_INTEGRATION_PLAN.md](./AGENT_INTEGRATION_PLAN.md)。

## 文件索引

| 檔案 | 內容 |
|------|------|
| [SPEC.md](./SPEC.md) | 軟體規格書（功能定義、系統需求、平台適配） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 程式架構建議書（模組設計、依賴關係、跨平台原則） |
| [USAGE.md](./USAGE.md) | 使用者手冊（安裝、設定、選單操作、常見問題） |
| [AGENT_INTEGRATION_PLAN.md](./AGENT_INTEGRATION_PLAN.md) | my-agent 整合的完整藍圖與進度追蹤（P0–P3） |
| [CLAUDE.md](./CLAUDE.md) | AI 開發者專案概述與守則（包括目錄結構、效能預算、版本表） |
| [LESSONS.md](./LESSONS.md) | 已知錯誤與教訓（多平台陷阱、AI 常犯錯誤） |
| [animation-guide.md](./animation-guide.md) | 系統動畫命名與載入規範 |
| [docs/vrm-expression-guide.md](./docs/vrm-expression-guide.md) | VRM 表情跨模型策略（Tier 1/2/3 安全集） |
| [SCENE_PROPS_PLAN.md](./SCENE_PROPS_PLAN.md) | 可互動場景道具系統開發計劃（未來功能） |

## 子目錄專屬規則

- [electron/CLAUDE.md](./electron/CLAUDE.md) — Electron 主程序開發守則（含跨平台、IPC、koffi）
- [src/CLAUDE.md](./src/CLAUDE.md) — TypeScript 前端守則（render loop 順序、模組邊界）
- [src-settings/CLAUDE.md](./src-settings/CLAUDE.md) — 設定視窗 React 守則
