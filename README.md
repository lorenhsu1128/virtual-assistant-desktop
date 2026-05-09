# virtual-assistant-desktop

桌面虛擬陪伴軟體（Desktop Mascot）— Electron + TypeScript + Three.js + @pixiv/three-vrm。

在桌面常駐顯示一個 VRM 3D 角色，支援自主移動、視窗互動、表情、動畫播放與系統托盤控制。

## 支援平台

| 平台 | 狀態 | 備註 |
|------|------|------|
| Windows 10 (1903+) / Windows 11 | ✅ 完整 | 含視窗碰撞 / 吸附 / 遮擋 / Peek（koffi FFI） |
| macOS 11 Big Sur 以上 | 🟡 部分 | 渲染、動畫、表情、自主移動可運作；視窗感知功能停用 |

## 快速啟動

```bash
bun install
bun run dev
```

開發模式同時啟動 Vite 與 Electron。

## 打包

```bash
# 自動偵測當前平台打包
bun run package

# 指定平台打包
bun run package:win    # Windows  → .exe (NSIS)
bun run package:mac    # macOS    → .dmg + .zip
```

## 文件索引

| 檔案 | 內容 |
|------|------|
| [SPEC.md](./SPEC.md) | 軟體規格書（功能定義、系統需求、平台適配） |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | 程式架構建議書（模組設計、依賴關係、跨平台原則） |
| [USAGE.md](./USAGE.md) | 使用者手冊（安裝、選單操作、平台差異） |
| [CLAUDE.md](./CLAUDE.md) | 給 AI 開發者的專案概述與守則 |
| [LESSONS.md](./LESSONS.md) | 已知錯誤與教訓（多平台陷阱、AI 常犯錯誤） |
