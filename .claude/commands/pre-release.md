---
name: pre-release
description: 執行發布前的完整檢查流程，驗證測試、編譯、lint、版本號一致性。
argument-hint: "[version: e.g. 0.1.0]"
user-invocable: true
---

執行 virtual-assistant-desktop 發布前的完整檢查流程。
版本號從 $ARGUMENTS 取得（例如 `0.1.0`）。

## 依序執行以下 9 項檢查

### ① TypeScript 型別檢查
```bash
npx tsc --noEmit
```

### ② ESLint 檢查
```bash
pnpm lint
```

### ③ Prettier 格式檢查
```bash
pnpm format:check
```

### ④ Vitest 單元測試
```bash
pnpm test
```

### ⑤ Rust 編譯（Release）
```bash
cargo build --release
```

### ⑥ Rust Clippy
```bash
cargo clippy -- -D warnings
```

### ⑦ Rust 測試
```bash
cargo test
```

### ⑧ 版本號一致性
讀取以下三個檔案的版本號並比對：
- `package.json` → `version` 欄位
- `src-tauri/Cargo.toml` → `version` 欄位
- `src-tauri/tauri.conf.json` → `version` 欄位

如果指定了版本號參數，同時檢查是否與參數一致。
如不一致，詢問使用者是否自動更新。

### ⑨ CHANGELOG 檢查
確認 `CHANGELOG.md` 中有目標版本的條目。

## 輸出報告

```
═══════════════════════════════════════
  發布前檢查報告 — v{version}
═══════════════════════════════════════

  ① TypeScript 型別檢查    ✅ 通過
  ② ESLint                 ✅ 通過
  ③ Prettier               ✅ 通過
  ④ Vitest 單元測試         ✅ 通過 (24/24)
  ⑤ Rust Release 編譯      ✅ 通過
  ⑥ Rust Clippy            ✅ 通過 (0 warnings)
  ⑦ Rust 測試              ✅ 通過 (8/8)
  ⑧ 版本號一致性           ✅ 一致 (0.1.0)
  ⑨ CHANGELOG              ⚠️ 未找到 v0.1.0 條目

═══════════════════════════════════════
  結果：8/9 通過 — 需補充 CHANGELOG
═══════════════════════════════════════
```

如果全部通過，提示可以執行發布步驟。
如果有失敗項目，列出具體錯誤和修正建議。
