---
name: vitest-unit
description: 撰寫 Vitest 單元測試與整合測試。用於為狀態機、碰撞系統、表情管理、動畫管理等模組建立測試，以及 IPC 整合測試。
---

## 測試開發指南

### 使用時機

- 為新模組撰寫單元測試
- 為 IPC 介面撰寫整合測試
- 補充既有模組的測試覆蓋率
- 修 bug 後補充回歸測試

### 測試結構

```
tests/
├── unit/                          # 單元測試（純邏輯）
│   ├── StateMachine.test.ts
│   ├── CollisionSystem.test.ts
│   ├── ExpressionManager.test.ts
│   └── AnimationManager.test.ts
└── integration/                   # 整合測試（涉及 IPC / 多模組）
    └── TauriIPC.test.ts
```

### 命名規範

```typescript
describe('ModuleName', () => {
  describe('methodName', () => {
    it('should {預期行為} when {條件}', () => {
      // Arrange → Act → Assert
    });
  });
});
```

### 單元測試模板

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateMachine } from '../../src/behavior/StateMachine';

describe('StateMachine', () => {
  let sm: StateMachine;

  beforeEach(() => {
    sm = new StateMachine();
  });

  describe('tick', () => {
    it('should start in idle state', () => {
      const output = sm.tick(16);
      expect(output.currentState).toBe('idle');
    });

    it('should transition to walk after idle timeout', () => {
      // 模擬時間經過
      vi.spyOn(Math, 'random').mockReturnValue(0.3); // 60% 範圍內 → walk
      // ... 模擬 idle 超時
      const output = sm.tick(16);
      expect(output.currentState).toBe('walk');
      expect(output.stateChanged).toBe(true);
    });
  });

  describe('pause / resume', () => {
    it('should not transition states while paused', () => {
      sm.pause();
      // ... 即使超時也不轉移
    });
  });
});
```

### 優先測試的模組（必須有測試）

| 模組 | 測試重點 |
|------|----------|
| StateMachine | 所有狀態轉移路徑、機率分布、暫停/恢復 |
| CollisionSystem | AABB 碰撞、邊界判定、吸附判定 |
| ExpressionManager | 優先級仲裁、自動輪播計時 |
| AnimationManager | 分類索引、crossfade 邏輯、fallback |
| BehaviorAnimationBridge | 狀態→動畫映射完整性 |

### 不需自動測試的功能（手動驗證）

- 透明視窗渲染效果
- 滑鼠穿透行為
- 多螢幕 DPI 切換
- 拖曳手感
- 視覺動畫效果

### Mock 指南

```typescript
// Mock TauriIPC
const mockIPC = {
  getWindowList: vi.fn().mockResolvedValue([]),
  onWindowLayoutChanged: vi.fn(),
} as unknown as TauriIPC;

// Mock VRMController（用於 AnimationManager 測試）
const mockVRM = {
  getAnimationMixer: vi.fn().mockReturnValue(new AnimationMixer()),
  setBlendShape: vi.fn(),
} as unknown as VRMController;

// 不需要 mock Three.js（StateMachine 不依賴它）
```

### 執行測試

```bash
# 執行所有測試
bun run test

# 執行特定測試
npx vitest run tests/unit/StateMachine.test.ts

# 監聽模式
npx vitest watch

# 覆蓋率報告
npx vitest run --coverage
```

### 驗收標準

- [ ] 所有純邏輯模組（behavior/、expression/）有 > 80% 行覆蓋率
- [ ] 所有狀態轉移路徑有對應測試
- [ ] 邊界條件（螢幕邊緣、空陣列、null 值）有測試
- [ ] `bun run test` 全部通過
