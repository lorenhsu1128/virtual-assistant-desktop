---
name: state-machine
description: 開發或修改自主移動行為狀態機，包含狀態轉移、碰撞判定、吸附邏輯。純邏輯模組，不依賴 Three.js。
---

## 行為狀態機開發指南

### 使用時機

- 開發 StateMachine 狀態轉移邏輯
- 開發 CollisionSystem 碰撞判定
- 開發 BehaviorAnimationBridge 狀態→動畫映射
- 修改自主移動參數

### 狀態轉移圖

```
idle ──(60%)──→ walk
     ──(20%)──→ sit
     ──(10%)──→ peek
     ──(10%)──→ idle（繼續待機）

walk ──(碰撞)──→ idle / sit
     ──(到達目標)──→ idle

sit  ──(超時 / 視窗關閉)──→ fall → idle

peek ──(超時)──→ walk / idle
```

### 核心設計原則

**StateMachine 是純邏輯模組**

```typescript
// ✅ 正確：只輸出行為資料
export class StateMachine {
  tick(deltaTime: number): BehaviorOutput {
    return {
      targetPosition: { x, y },
      currentState: 'walk',
      stateChanged: true,
      facingDirection: 'left',
    };
  }
}

// ❌ 錯誤：不要在 StateMachine 中做這些
import * as THREE from 'three';  // 禁止
animationManager.play('walk');   // 禁止
window.setPosition(x, y);       // 禁止
```

**BehaviorAnimationBridge 負責映射**

```typescript
// 狀態 → 動畫分類對應
const STATE_TO_ANIMATION: Record<BehaviorState, AnimationCategory> = {
  idle: 'idle',
  walk: 'idle',     // 走路時播放 idle 動畫
  sit: 'sit',
  peek: 'peek',
  fall: 'fall',
  collide: 'collide',
};
```

### 參數定義（v0.2 先寫死常數）

```typescript
const BEHAVIOR_PARAMS = {
  moveSpeed: 60,              // px/s（100% 縮放基準）
  idleMinDuration: 5000,      // ms
  idleMaxDuration: 20000,     // ms
  sitDuration: 10000,         // ms
  peekDuration: 5000,         // ms
  snapThreshold: 20,          // px（吸附判定距離）
  screenEdgeMargin: 0.2,      // 至少 20% 在螢幕內
} as const;
```

### BehaviorOutput 介面

```typescript
interface BehaviorOutput {
  targetPosition: { x: number; y: number };
  currentState: BehaviorState;
  previousState: BehaviorState;
  stateChanged: boolean;
  facingDirection: 'left' | 'right';
}

type BehaviorState = 'idle' | 'walk' | 'sit' | 'peek' | 'fall' | 'collide';
```

### CollisionSystem

- 輸入：角色 bounding box + 視窗碰撞體清單 + 螢幕邊界
- 演算法：AABB 矩形碰撞檢測
- 輸出：碰撞事件（碰到哪個邊、可吸附視窗、被遮擋區域）

```typescript
interface CollisionResult {
  collided: boolean;
  collidedEdge: 'top' | 'bottom' | 'left' | 'right' | null;
  snappableWindows: WindowRect[];
  occlusionRegion: Region | null;
}
```

### 測試要求

StateMachine 和 CollisionSystem 是純邏輯，**必須**有完整單元測試：

```typescript
describe('StateMachine', () => {
  describe('tick', () => {
    it('should transition from idle to walk with 60% probability');
    it('should stop walking on collision');
    it('should enter fall state when sitting window closes');
    it('should respect screen edge boundaries');
    it('should pause/resume autonomous movement');
  });
});

describe('CollisionSystem', () => {
  describe('check', () => {
    it('should detect AABB collision with window');
    it('should identify snappable window tops within threshold');
    it('should calculate occlusion region');
    it('should handle screen edge collision');
  });
});
```

### 禁止事項

- ❌ 在 StateMachine 中 import 'three'
- ❌ 在 StateMachine 中直接呼叫 AnimationManager
- ❌ 在 StateMachine 中直接呼叫 TauriIPC
- ❌ 在 CollisionSystem 中操作 3D 物件
