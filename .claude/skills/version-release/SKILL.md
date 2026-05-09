---
name: version-release
description: 執行版本發布流程，包含版本號同步、changelog 生成、建置前完整檢查、產物驗證。
---

## 版本發布流程

### 使用時機

- 準備發布新版本
- 執行發布前檢查
- 更新版本號

### 版本號同步位置

以下三個檔案的版本號必須保持一致：

1. `package.json` → `"version": "x.y.z"`
2. `src-tauri/Cargo.toml` → `version = "x.y.z"`
3. `src-tauri/tauri.conf.json` → `"version": "x.y.z"`

### 發布前檢查清單

```bash
# 1. TypeScript 編譯檢查
bun run build
# 或 npx tsc --noEmit

# 2. ESLint 檢查
bun run lint

# 3. Prettier 格式檢查
bun run format:check

# 4. 單元測試
bun run test

# 5. Rust 編譯
cargo build --release

# 6. Rust clippy
cargo clippy -- -D warnings

# 7. Rust 測試
cargo test

# 8. 版本號一致性
# 比對 package.json, Cargo.toml, tauri.conf.json 的版本號

# 9. 建置產物大小檢查
# 確認 < 30 MB
```

### Changelog 格式

```markdown
# Changelog

## [x.y.z] - YYYY-MM-DD

### 新增 (feat)
- 動畫系統：新增 crossfade 過渡 (#issue)

### 修復 (fix)
- 碰撞系統：修正多螢幕 DPI 偏移 (#issue)

### 變更 (refactor)
- IPC：統一錯誤處理策略

### 已知問題
- 部分顯示卡透明視窗渲染異常
```

### 發布步驟

1. 確認所有檢查通過
2. 更新三處版本號
3. 更新 CHANGELOG.md
4. 建立 release 分支：`git checkout -b release/vx.y.z`
5. Commit：`chore(release): vx.y.z`
6. 建立 Git tag：`git tag vx.y.z`
7. 執行完整建置：`bun run package:win` 或 `bun run package:mac`
8. 驗證安裝包正常運作
9. 合併回 main 分支

### 版本規劃對應

| 版本 | 核心功能 |
|------|----------|
| v0.1.0 | 透明視窗 + VRM + 動畫系統 |
| v0.2.0 | 視窗互動 + 自主移動 + 拖曳 |
| v0.3.0 | 表情 + 系統托盤 |
| v0.4.0 | Lip-sync + SpringBone |
| v0.5.0 | 攝影機 + 進階設定 + 自動更新 |

### 驗收標準

- [ ] 所有 9 項檢查通過
- [ ] 三處版本號一致
- [ ] CHANGELOG.md 已更新
- [ ] 建置產物 < 30 MB
- [ ] 安裝包可正常運作
