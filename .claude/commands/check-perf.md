---
name: check-perf
description: 掃描專案程式碼，檢查是否符合效能預算與安全規範。輸出違規報告與修正建議。
user-invocable: true
---

掃描整個專案，依以下類別檢查效能與安全問題，輸出完整報告：

## 檢查項目

### 1. 幀率控制（Critical）

搜尋所有 `setInterval` 用法，判斷是否用於幀率控制。
合法用途（如計時器、輪詢）不算違規，但用於動畫或渲染迴圈則是違規。

```bash
grep -rn "setInterval" src/ --include="*.ts"
```

### 2. Rust unwrap 使用（Critical）

搜尋所有 `.unwrap()` 用法。在 command handler 中使用 unwrap 可能導致 panic。

```bash
grep -rn "\.unwrap()" src-tauri/src/ --include="*.rs"
```

### 3. 主執行緒阻塞（High）

搜尋可能阻塞主執行緒的 Windows API 呼叫或同步 I/O。

```bash
grep -rn "std::thread::sleep\|std::fs::read\|std::fs::write" src-tauri/src/ --include="*.rs"
```

### 4. Render Loop 物件分配（Medium）

搜尋 render loop 相關函式中的 `new THREE.Vector3`、`new THREE.Quaternion` 等。
這些應該被重用而非每幀建立。

```bash
grep -rn "new THREE\." src/core/ src/animation/ --include="*.ts"
```

### 5. WebGL Context Lost 處理（High）

確認 SceneManager 中有監聽 `webglcontextlost` 和 `webglcontextrestored` 事件。

```bash
grep -rn "webglcontextlost\|webglcontextrestored" src/ --include="*.ts"
```

### 6. 模組邊界違規（Critical）

```bash
# 直接 invoke 呼叫（應透過 TauriIPC）
grep -rn "from '@tauri-apps/api'" src/ --include="*.ts" | grep -v "bridge/"

# StateMachine 導入 three（應為純邏輯）
grep -rn "from 'three'" src/behavior/StateMachine.ts

# 非 VRMController 直接存取 VRM
grep -rn "from '@pixiv/three-vrm'" src/ --include="*.ts" | grep -v "VRMController"
```

### 7. TypeScript any 型別（Medium）

```bash
grep -rn ": any\|as any\|<any>" src/ --include="*.ts"
```

### 8. 建置產物大小（Release 時）

如果有建置產物，檢查大小是否 < 30MB。

## 輸出格式

```
═══════════════════════════════════
  效能與安全檢查報告
═══════════════════════════════════

🔴 Critical (必須修正)
  [1] src/core/SceneManager.ts:42 — 使用 setInterval 做幀率控制
      修正：改用 requestAnimationFrame + deltaTime

🟡 High (建議修正)
  [2] src-tauri/src/file_manager.rs:18 — 使用 .unwrap()
      修正：改用 .map_err(|e| e.to_string())?

🔵 Medium (可選改進)
  [3] src/core/SceneManager.ts:85 — render loop 中 new THREE.Vector3()
      修正：將 Vector3 提升為 class 成員，每幀重用

═══════════════════════════════════
  總結：3 個問題（1 Critical, 1 High, 1 Medium）
═══════════════════════════════════
```
