---
name: svelte-settings
description: 開發 Svelte 設定視窗頁面。用於建立模型管理、動畫管理、表情管理、效能調整等設定介面，獨立 WebView 運行。
---

## 設定視窗開發指南

### 使用時機

- 新增設定視窗頁面
- 修改現有設定頁面的 UI 或邏輯
- 新增設定項目

### 技術環境

- 框架：Svelte
- 視窗：獨立 WebView，透過 Tauri 多視窗 API 開啟
- 特性：有標題列、邊框、可縮放（正常視窗行為）

### 頁面結構

```
src-settings/
├── App.svelte                    # 主應用（含導航列）
├── pages/
│   ├── ModelPage.svelte          # 模型管理
│   ├── AnimationPage.svelte      # 動畫管理
│   ├── ExpressionPage.svelte     # 表情管理
│   ├── DisplayPage.svelte        # 視窗行為
│   ├── PerformancePage.svelte    # 效能調整
│   ├── DevicePage.svelte         # 裝置權限
│   └── AboutPage.svelte          # 關於
└── main.ts                       # 進入點
```

### 新增頁面流程

1. **建立 Svelte 元件** → `src-settings/pages/{Name}Page.svelte`

2. **頁面模板**
   ```svelte
   <script lang="ts">
     import { onMount } from 'svelte';
     // 透過 TauriIPC 讀取設定
     // 所有設定操作都透過 IPC，不直接讀寫檔案

     let settings = {};

     onMount(async () => {
       settings = await invoke('read_config');
     });

     async function handleChange(key: string, value: any) {
       await invoke('write_config', { key, value });
       // 變更即時生效，Rust 側會 emit event 通知主視窗
     }
   </script>

   <div class="page">
     <h2>頁面標題</h2>
     <!-- 設定項目 -->
   </div>

   <style>
     .page {
       padding: 1rem;
     }
   </style>
   ```

3. **在 App.svelte 中加入導航項目**

4. **確保 IPC 通訊**
   - 讀取設定：`invoke('read_config')`
   - 寫入設定：`invoke('write_config', { ... })`
   - 設定變更後，Rust 側透過 event 通知主視窗即時生效

### 各頁面需求摘要

**ModelPage（v0.1）**
- 顯示當前 VRM 模型路徑
- 「選擇模型」按鈕 → `invoke('pick_file')`
- 模型檔案大小 / 頂點數資訊
- 超過建議值時顯示警告

**AnimationPage（v0.1）**
- 顯示動畫資料夾路徑
- 「選擇資料夾」按鈕
- 已掃描的 .vrma 清單，每個項目可編輯：
  - 分類（idle / action / sit / fall / collide / peek）
  - 顯示名稱
  - 循環播放（toggle）
  - 權重（滑桿，用於 idle 隨機播放）
- 「重新掃描」按鈕
- 新掃描到的檔案預設為 action 分類

**ExpressionPage（v0.3）**
- 列出模型所有 BlendShapes
- 每個表情可設定是否允許自動播放

**PerformancePage（v0.3）**
- 幀率上限滑桿
- 省電模式開關

### 設計原則

- 關閉設定視窗不影響桌寵主視窗
- 所有變更即時生效（不需「儲存」按鈕）
- 錯誤時顯示友善提示（不 crash）
- UI 使用系統原生風格，簡潔實用

### 驗收標準

- [ ] 頁面正確顯示，導航可切換
- [ ] 設定變更透過 IPC 正確傳遞
- [ ] 關閉設定視窗不影響主視窗
- [ ] 錯誤時顯示友善提示
