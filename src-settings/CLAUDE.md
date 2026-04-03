# 設定視窗開發規則

## 技術選型

- 框架：Svelte
- 視窗類型：獨立 WebView（Tauri 多視窗 API），有標題列、邊框、可縮放
- 與主視窗 / Rust 後端透過 TauriIPC 溝通

## 頁面結構

| 頁面 | 功能 | 對應版本 |
|------|------|----------|
| ModelPage | VRM 模型瀏覽、選擇、預覽 | v0.1 |
| AnimationPage | 動畫資料夾、分類、權重、重新掃描 | v0.1 |
| ExpressionPage | BlendShapes 管理、自動播放設定 | v0.3 |
| DisplayPage | Win+D 行為、多虛擬桌面 | v0.3 |
| PerformancePage | 幀率上限、省電模式 | v0.3 |
| DevicePage | 麥克風、攝影機權限 | v0.4 |
| AboutPage | 版本資訊、授權、檢查更新 | v0.5 |

## 設計原則

- 關閉設定視窗不影響主視窗桌寵運行
- 所有設定變更即時生效，透過 IPC event 通知主視窗
- 讀寫設定一律透過 TauriIPC → Rust file_manager
- 不在設定視窗中直接操作檔案系統

## 動畫管理頁面需求

- 列出所有掃描到的 .vrma 檔案
- 每個動畫可設定：分類(idle/action/sit/fall/collide/peek)、顯示名稱、loop、權重
- 手動重新掃描按鈕
- 新掃描到的 .vrma 預設歸類為 action
