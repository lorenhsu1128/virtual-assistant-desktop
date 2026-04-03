---
name: sync-types
description: 比對 Rust 和 TypeScript 兩側的共用型別定義，找出不一致的欄位並提供修正建議。
user-invocable: true
---

比對 Rust 結構體和 TypeScript interface 之間的型別定義是否一致。

## 比對範圍

以下型別必須在兩側保持同步：

### IPC 資料結構

| TypeScript (src/types/) | Rust (src-tauri/src/) | 用途 |
|-------------------------|----------------------|------|
| `WindowRect` | `WindowRect` | 視窗位置與大小 |
| `AnimationEntry` | `AnimationEntry` | 動畫 metadata |
| `AnimationCategory` | `AnimationCategory` | 動畫分類列舉 |
| `AppConfig` | `Config` | 使用者設定 |
| `DisplayInfo` | `DisplayInfo` | 螢幕資訊 |
| `PowerMode` | `PowerMode` | 電源模式 |

### 比對規則

1. **欄位名稱對應**：Rust snake_case ↔ TypeScript camelCase
   - Rust `z_order` ↔ TS `zOrder`
   - Rust `file_name` ↔ TS `fileName`
   
2. **型別對應**：
   - `String` ↔ `string`
   - `i32` / `u32` / `f32` / `f64` ↔ `number`
   - `bool` ↔ `boolean`
   - `Vec<T>` ↔ `T[]`
   - `Option<T>` ↔ `T | null`

3. **列舉對應**：Rust enum variants ↔ TypeScript union type
   - `AnimationCategory::Idle` ↔ `'idle'`

## 執行步驟

1. 讀取 `src/types/` 下所有 TypeScript interface 定義
2. 讀取 `src-tauri/src/` 中對應的 Rust struct 定義
3. 逐欄位比對名稱和型別
4. 檢查 IPC command 的參數型別和回傳型別
5. 檢查 IPC event 的 payload 型別

## 輸出報告

```
═══════════════════════════════════
  型別同步檢查報告
═══════════════════════════════════

WindowRect
  ✅ hwnd: u32 ↔ number
  ✅ title: String ↔ string
  ✅ x: i32 ↔ number
  ✅ y: i32 ↔ number
  ✅ width: u32 ↔ number
  ✅ height: u32 ↔ number
  ✅ z_order ↔ zOrder: i32 ↔ number

AnimationEntry
  ✅ file_name ↔ fileName: String ↔ string
  ❌ display_name ↔ 缺少: Rust 有 display_name: String，TS 未定義
  ✅ category: AnimationCategory ↔ AnimationCategory

═══════════════════════════════════
  結果：1 個不一致
  建議：在 src/types/animation.ts 的 AnimationEntry 中
        新增 displayName: string
═══════════════════════════════════
```

如果發現不一致，詢問使用者是否要自動修正（更新 TypeScript 側以匹配 Rust 側，因為 Rust 側是 IPC 的資料來源）。
