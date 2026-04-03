---
name: ts-frontend-module
description: 在 src/ 新增 TypeScript 前端模組。用於建立渲染核心、動畫系統、行為邏輯、互動處理等前端功能模組，確保遵循模組邊界規則。
---

## 新增前端模組流程

### 使用時機

- 新增前端功能模組（SceneManager、AnimationManager 等）
- 擴充現有模組分類下的新功能
- 任何 src/ 下的 TypeScript 模組開發

### 輸入需求

- 模組名稱（PascalCase）
- 所屬目錄（core / animation / expression / behavior / interaction / bridge）
- 對外介面定義（公開方法簽名）
- 依賴的其他模組

### 步驟

1. **確認模組分類**

   | 目錄 | 放什麼 |
   |------|--------|
   | core/ | 渲染核心（SceneManager, VRMController） |
   | animation/ | 動畫載入、播放、fallback |
   | expression/ | BlendShape 表情管理 |
   | behavior/ | 狀態機、碰撞、狀態→動畫橋接 |
   | interaction/ | 拖曳、右鍵選單 |
   | bridge/ | TauriIPC 封裝 |

2. **建立模組檔案** → `src/{category}/{ModuleName}.ts`

3. **定義 class 與公開介面**
   ```typescript
   /**
    * {模組功能描述}
    *
    * 職責：
    * - {職責 1}
    * - {職責 2}
    */
   export class {ModuleName} {
     /**
      * {方法描述}
      * @param {type} paramName - {參數描述}
      * @returns {回傳描述}
      */
     public methodName(params): ReturnType {
       // 實作
     }
   }
   ```

4. **使用建構子注入依賴**
   ```typescript
   constructor(
     private readonly vrmController: VRMController,
     private readonly animationManager: AnimationManager
   ) {}
   ```
   不在模組內部直接 new 其他模組。

5. **定義共用型別**（如需要）→ `src/types/{name}.ts`

6. **撰寫測試** → `tests/unit/{ModuleName}.test.ts`

7. **在 SceneManager 或 main.ts 中整合**

### 模組邊界檢查清單

在完成模組後，逐一確認：

- [ ] 不直接 import `@tauri-apps/api`（透過 TauriIPC）
- [ ] 不直接 import `@pixiv/three-vrm`（透過 VRMController，除非本身就是 VRMController）
- [ ] 若為 behavior/ 下的 StateMachine，不 import `three`
- [ ] 不自行建立 `requestAnimationFrame`（由 SceneManager 統一管理）
- [ ] 依賴透過建構子注入，不在內部直接 new

### 驗收標準

- [ ] TypeScript 嚴格模式編譯通過（`tsc --noEmit`）
- [ ] 不違反模組邊界規則
- [ ] 所有公開方法有 JSDoc 註解
- [ ] 有對應的 `tests/unit/{ModuleName}.test.ts`
- [ ] `pnpm lint` 通過
- [ ] `pnpm format:check` 通過
