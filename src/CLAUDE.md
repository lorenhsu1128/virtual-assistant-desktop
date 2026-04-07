# TypeScript 前端開發規則

## 渲染主迴圈順序（不可更改）

SceneManager 擁有唯一的 render loop，每幀依以下順序執行：

```
1. StateMachine.tick(deltaTime)       → 計算行為狀態與目標位置（僅未暫停時）
   ※ 輸出 peekTargetHwnd / attachedWindowHwnd 供深度遮擋計算
2. AnimationManager.update(deltaTime) → cubic transition 推進 + idle 輪播
   ※ 階段 C：用 ease-out cubic (1-t)^3 取代線性 crossfade，舊動作前期保留更久
   ※ idle 輪播間隔 5-12 秒（從 0.5-2 拉長避免神經抽搐）
3. ExpressionManager.update + resolve → 表情過渡推進（0.5s 線性 fade）+ 仲裁
   ※ 回傳 { current, previous } 兩個 slot，SceneManager 兩者都套用以呈現交叉淡化
4. VRMController.update(deltaTime)    → SpringBone + mixer + hip 平滑（順序固定）
   a. vrm.update(dt)                  → SpringBone 物理（沿用既有順序）
   b. mixer.update(dt)                → 套用本幀動畫到骨骼 local
   c. applyHipSmoothing(dt)           → hip 跨幀平滑（階段 B）+ SpringBone 過渡保護（Layer 6）
   ※ updateModelWorldPosition 含 resolveCharacterZ（根據行為狀態設定角色 Z 深度）
   ※ sit 狀態下 finalZ 套用 hip 三軸補償（避免 SYS_SIT_01/02 的 Z 位移把模型推出 near plane）
   ※ Debug overlay：骨骼座標 + 遮擋系統資訊 + 視窗清單
5. renderer.render(scene, camera)     → 渲染輸出（GPU depth test 自動處理視窗遮擋）
```

※ WindowMeshManager.syncWindows() 由 IPC 事件驅動（~300ms），不在 render loop 中

此順序至關重要：後面的步驟依賴前面的結果。新增模組時，必須確認插入位置。

### 重要初始化順序
`sceneManager.start()` 必須在行為系統初始化之前呼叫。行為系統初始化用 try/catch 包裝，失敗不影響基本渲染。

## 模組邊界（嚴格執行）

| 規則 | 說明 |
|------|------|
| SceneManager 獨佔 render loop | 其他模組不得自行建立 requestAnimationFrame |
| VRMController 獨佔 VRM 操作 | 其他模組不得 import @pixiv/three-vrm 或存取 vrm.scene |
| AnimationManager 透過注入取得 mixer | 使用 VRMController.getAnimationMixer() |
| StateMachine 是純邏輯 | 不得 import 'three' 的任何模組 |
| BehaviorAnimationBridge 做狀態→動畫映射 | StateMachine 不直接呼叫 AnimationManager |
| WindowMeshManager 管理遮擋 mesh | 由 IPC 事件驅動 syncWindows，不在 render loop 中更新 |
| ElectronIPC 獨佔 IPC | 其他模組不得直接使用 window.electronAPI |

## 錯誤處理策略

| 場景 | 處理方式 |
|------|----------|
| IPC 取得視窗列表失敗 | 使用上一次快取資料，不中斷 render loop |
| IPC 讀取設定失敗 | 使用預設值，記錄 WARN 日誌 |
| IPC 寫入設定失敗 | 記憶體保留變更，下次 tick 重試，最多 3 次 |
| .vrma 載入失敗 | 跳過該檔案，記錄 WARN，不影響其他動畫 |
| VRM 載入失敗 | 顯示友善提示，彈出檔案選擇器 |
| WebGL context lost | 自動重建 renderer + 重新載入場景 |
| 檔案選擇器取消 | 視為正常操作，不報錯 |

## 禁止清單

- ❌ 直接使用 `window.electronAPI` — 必須透過 ElectronIPC
- ❌ 在 StateMachine 中 `import * from 'three'` — 純邏輯模組
- ❌ 在非 VRMController 中存取 `vrm.scene` / `vrm.humanoid` / `vrm.expressionManager`
- ❌ 使用 `setInterval` 做幀率控制
- ❌ 使用 TypeScript `any` 型別
- ❌ 在 canvas 內移動 3D 模型位置（應移動 Electron 視窗）
