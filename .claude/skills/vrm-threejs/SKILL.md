---
name: vrm-threejs
description: 處理 VRM 模型載入、Three.js 場景管理、.vrma 動畫播放、BlendShape 表情、WebGL 除錯等 3D 渲染相關開發任務。
---

## VRM / Three.js 開發指南

### 使用時機

- 設定 Three.js 場景與渲染器
- 載入 / 操作 VRM 模型
- 開發動畫播放與 crossfade 機制
- 處理 BlendShape 表情
- 修復 WebGL 相關問題

### 核心依賴

```json
{
  "three": "^0.160.0",
  "@pixiv/three-vrm": "^3.0.0",
  "@pixiv/three-vrm-animation": "^3.0.0"
}
```

### 場景設定要點

```typescript
// WebGLRenderer 必須設定透明背景
const renderer = new THREE.WebGLRenderer({
  alpha: true,
  premultipliedAlpha: false,
  antialias: true,
});
renderer.setClearColor(0x000000, 0); // 完全透明

// Camera 設定
const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 20);
```

**核心概念：模型永遠在 canvas 中央。** 角色在螢幕上的移動是透過 Tauri `setPosition()` 移動整個透明視窗實現的，不是在 canvas 內移動 3D 模型。

### VRM 模型載入

```typescript
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
```

- 模型建議檔案大小 ≤ 50MB、頂點數 ≤ 10 萬
- 超過時顯示警告但不阻止載入

### 動畫系統

- `.vrma` 透過 `VRMAnimationLoaderPlugin` 載入
- 轉換為 Three.js `AnimationClip`
- `AnimationMixer` 控制播放和 crossfade
- 所有動畫切換使用 crossfade 混合過渡
- idle 動畫按 weight 加權隨機輪播
- 無 idle 動畫時 fallback 到程式碼驅動的呼吸 + 眨眼

### BlendShape 優先級

```
1. .vrma 動畫內的表情軌道（最高）
2. 手動指定的表情（右鍵選單）
3. 自動隨機表情（最低）
```

ExpressionManager.resolve() 負責仲裁，每幀執行一次。

### 角色縮放

- 範圍：50%–200%（相對預設大小）
- 透過調整 camera 或 model scale 實現
- 縮放值儲存於 config.json

### WebGL Context Lost 處理

```typescript
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  // 停止 render loop
});

renderer.domElement.addEventListener('webglcontextrestored', () => {
  // 重建 renderer、重新載入場景和模型
  // 自動復原，不需使用者介入
});
```

### FallbackAnimation（程式碼驅動）

當沒有可用的 idle .vrma 動畫時，使用內建動畫：

- **呼吸**：胸部骨骼微幅正弦波上下（bone rotation）
- **眨眼**：BlendShape 週期性觸發（3-7 秒間隔）

```typescript
// 呼吸概念
const breathAmount = Math.sin(elapsed * 1.5) * 0.02;
vrmController.setBoneRotation('chest', breathQuaternion);

// 眨眼概念
if (timeSinceLastBlink > nextBlinkInterval) {
  vrmController.setBlendShape('blink', 1.0);
  // 150ms 後恢復
}
```

### 禁止事項

- ❌ 在 canvas 內移動模型位置（只移動 Tauri 視窗）
- ❌ 在非 VRMController 模組中直接存取 VRM 內部結構
- ❌ 使用 setInterval 做動畫計時
- ❌ 忽略 WebGL context lost 事件
