import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMAnimation, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import type { BoneMapping } from '../animation/AnimationMirror';

/**
 * VRM 模型控制器
 *
 * 封裝 @pixiv/three-vrm 的所有操作。
 * 其他模組不得直接存取 VRM 內部結構（vrm.scene, vrm.humanoid, vrm.expressionManager）。
 */
export class VRMController {
  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private scene: THREE.Scene;
  private loader: GLTFLoader;

  // ── MToon outline 開關狀態 ──
  /** 是否啟用 MToon outline（由 setMToonOutlineEnabled 控制，跨模型保留） */
  private mtoonOutlineEnabled = true;
  /**
   * 快取每個 MToon material 的原始 outlineWidthFactor
   * WeakMap 鍵為 material，material 被 dispose 後自動 GC
   */
  private originalOutlineFactors = new WeakMap<THREE.Material, number>();

  // ── Hip 跨幀平滑（階段 B）+ SpringBone 過渡保護（Layer 6）──
  /** 平滑後的 hip 世界座標（用於吸收動畫切換造成的瞬間跳變） */
  private smoothedHipsWorld = new THREE.Vector3();
  /** 平滑狀態是否已初始化（首次或載入新模型後重置） */
  private smoothedHipsValid = false;
  /**
   * 平滑速率（per second）：
   * 距離 < HIP_NEAR_THRESHOLD 時用 RATE_NEAR（緊密追蹤，正常動作）
   * 距離 ≥ HIP_NEAR_THRESHOLD 時用 RATE_FAR（緩慢追上，吸收跳變）
   */
  private static readonly HIP_NEAR_THRESHOLD = 0.05; // 5 cm
  private static readonly HIP_RATE_NEAR = 18;
  private static readonly HIP_RATE_FAR = 4;
  /**
   * 大幅跳變閾值（公尺）：超過此距離時呼叫 vrm.springBoneManager.reset()
   * 把頭髮 / 衣物等 SpringBone 快照到當前 bind pose 並清零速度，
   * 避免動畫切換的瞬間位移被當成物理外力造成「彈跳」。
   */
  private static readonly HIP_LARGE_JUMP = 0.3; // 30 cm

  /** 取得 VRM 實例（供 SceneManager 計算 bounding box） */
  getVRM(): VRM | null {
    return this.vrm;
  }

  /**
   * 取得 VRM meta（VRM0Meta 或 VRM1Meta）
   *
   * 封裝 vrm.meta 存取，避免外部模組直接碰 VRM 內部結構。
   * 回傳的物件可透過 metaVersion 欄位判斷規格版本（'0' / '1'）。
   */
  getMeta(): VRM['meta'] | null {
    return this.vrm?.meta ?? null;
  }

  /**
   * 取得模型內所有 mesh 的名稱清單
   *
   * 用於 picker 預覽的「能否換裝/脫衣」啟發式判斷。
   * 封裝 vrm.scene.traverse，避免外部模組直接遍歷 vrm.scene。
   */
  getMeshNames(): string[] {
    if (!this.vrm) return [];
    const names: string[] = [];
    this.vrm.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh && obj.name) {
        names.push(obj.name);
      }
    });
    return names;
  }

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  }

  /**
   * 載入 VRM 模型
   *
   * 載入前會先移除舊模型。載入後模型會被加入場景。
   */
  async loadModel(url: string): Promise<void> {
    // 移除舊模型
    this.dispose();

    const gltf = await this.loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      throw new Error('Failed to load VRM from file');
    }

    // VRM 模型預設面向 +Z，但 Three.js 攝影機面向 -Z
    // 需要旋轉模型使其面向攝影機
    vrm.scene.rotation.y = Math.PI;

    // 關閉所有子 mesh 的 frustum culling，避免角色在螢幕邊緣時部分 mesh 消失
    vrm.scene.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        child.frustumCulled = false;
      }
    });

    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.scene.add(vrm.scene);
    // 重置 hip 平滑狀態（新模型的 hip 位置可能完全不同）
    this.smoothedHipsValid = false;
    // 套用當前 MToon outline 狀態到新模型
    this.applyMToonOutline();
  }

  /**
   * 設定是否啟用 MToon 描邊
   *
   * 主視窗使用 OrthographicCamera，MToon 的 screenCoordinates outline
   * 在正交投影下數學失真會產生粗黑邊。此方法遍歷當前模型所有 MToon
   * material，將 outlineWidthFactor 設為 0（關閉）或還原（開啟）。
   *
   * 狀態會保留到下次載入模型時自動套用。
   */
  setMToonOutlineEnabled(enabled: boolean): void {
    this.mtoonOutlineEnabled = enabled;
    this.applyMToonOutline();
  }

  /** 當前 MToon outline 是否啟用 */
  isMToonOutlineEnabled(): boolean {
    return this.mtoonOutlineEnabled;
  }

  /**
   * 遍歷當前模型所有 mesh material，套用 MToon outline 狀態
   *
   * 用 duck-typing 偵測 MToon material（檢查 outlineWidthFactor 屬性），
   * 避免 import @pixiv/three-vrm 的 MToonMaterial 型別造成強相依。
   */
  private applyMToonOutline(): void {
    if (!this.vrm) return;

    const applyToMaterial = (mat: THREE.Material): void => {
      // duck-typing 偵測：MToon material 才有 outlineWidthFactor
      const mtoon = mat as THREE.Material & { outlineWidthFactor?: number };
      if (typeof mtoon.outlineWidthFactor !== 'number') return;

      // 首次遇到此 material：cache 原始值
      if (!this.originalOutlineFactors.has(mat)) {
        this.originalOutlineFactors.set(mat, mtoon.outlineWidthFactor);
      }

      if (this.mtoonOutlineEnabled) {
        // 還原原值
        const original = this.originalOutlineFactors.get(mat);
        if (original !== undefined) {
          mtoon.outlineWidthFactor = original;
        }
      } else {
        // 關閉
        mtoon.outlineWidthFactor = 0;
      }
      mat.needsUpdate = true;
    };

    this.vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(applyToMaterial);
      } else if (mesh.material) {
        applyToMaterial(mesh.material);
      }
    });
  }

  /**
   * 取得模型支援的 BlendShape（表情）清單
   */
  getBlendShapes(): string[] {
    if (!this.vrm?.expressionManager) return [];

    const manager = this.vrm.expressionManager;
    return Object.keys(manager.expressionMap);
  }

  /**
   * 設定 BlendShape 表情權重
   *
   * @param name 表情名稱
   * @param value 權重 0.0–1.0
   */
  setBlendShape(name: string, value: number): void {
    if (!this.vrm?.expressionManager) return;
    this.vrm.expressionManager.setValue(name, Math.max(0, Math.min(1, value)));
  }

  /**
   * 將指定 mesh 名稱清單的 visible 屬性切換
   *
   * 用於 VRM picker 預覽的「脫衣」開關，可隨時切回。
   * SpringBone 仍會計算（避免切回穿著時彈跳），僅停止渲染。
   *
   * @param names 要切換的 mesh 名稱清單
   * @param visible 是否可見
   */
  setMeshesVisible(names: string[], visible: boolean): void {
    if (!this.vrm) return;
    if (names.length === 0) return;
    const target = new Set(names);
    this.vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && target.has(obj.name)) {
        mesh.visible = visible;
      }
    });
  }

  /**
   * 預覽單一表情：清空所有 BlendShape 權重後，將指定 expression 設為 1.0
   *
   * 用於 VRM picker 預覽的 expression 切換下拉選單。
   * 與 ExpressionManager 的優先級系統無關，是直接寫入 vrm.expressionManager 的
   * 立即套用模式。傳 null 代表全部歸零。
   *
   * @param name 要套用的 expression 名稱；null 代表清空
   */
  setExpressionPreview(name: string | null): void {
    if (!this.vrm?.expressionManager) return;
    const manager = this.vrm.expressionManager;
    for (const key of Object.keys(manager.expressionMap)) {
      manager.setValue(key, 0);
    }
    if (name && name in manager.expressionMap) {
      manager.setValue(name, 1);
    }
  }

  /**
   * 設定骨骼旋轉
   *
   * @param boneName VRM 骨骼名稱
   * @param rotation 四元數旋轉
   */
  setBoneRotation(boneName: string, rotation: THREE.Quaternion): void {
    if (!this.vrm?.humanoid) return;
    const bone = this.vrm.humanoid.getNormalizedBoneNode(boneName as never);
    if (bone) {
      bone.quaternion.copy(rotation);
    }
  }

  /**
   * 取得骨骼節點
   *
   * @param boneName VRM 骨骼名稱
   */
  getBoneNode(boneName: string): THREE.Object3D | null {
    if (!this.vrm?.humanoid) return null;
    return this.vrm.humanoid.getNormalizedBoneNode(boneName as never);
  }

  /** 可重用的 Vector3，避免每幀 GC */
  private static readonly _tempWorldPos = new THREE.Vector3();
  private static readonly _tempScreenPos = new THREE.Vector3();

  /** 可重用的 Map，避免每次呼叫重新分配 */
  private readonly _boneScreenCache = new Map<string, { x: number; y: number }>();

  /**
   * 取得骨骼的 3D 世界座標
   *
   * @param boneName VRM 骨骼名稱
   */
  getBoneWorldPosition(boneName: string): { x: number; y: number; z: number } | null {
    const bone = this.getBoneNode(boneName);
    if (!bone) return null;
    bone.getWorldPosition(VRMController._tempWorldPos);
    return {
      x: VRMController._tempWorldPos.x,
      y: VRMController._tempWorldPos.y,
      z: VRMController._tempWorldPos.z,
    };
  }

  /** 末端骨骼對應：優先使用末端骨骼，不存在則 fallback + Y 偏移 */
  private static readonly EXTREMITY_MAP: Record<string, { bones: string[]; offsetY: number }> = {
    head: { bones: ['head'], offsetY: 0.15 },
    leftHand: { bones: ['leftMiddleDistal', 'leftIndexDistal', 'leftHand'], offsetY: 0 },
    rightHand: { bones: ['rightMiddleDistal', 'rightIndexDistal', 'rightHand'], offsetY: 0 },
    hips: { bones: ['hips'], offsetY: 0 },
    leftUpperLeg: { bones: ['leftUpperLeg'], offsetY: 0 },
    rightUpperLeg: { bones: ['rightUpperLeg'], offsetY: 0 },
    leftFoot: { bones: ['leftToes', 'leftFoot'], offsetY: -0.02 },
    rightFoot: { bones: ['rightToes', 'rightFoot'], offsetY: -0.02 },
  };

  /**
   * 取得骨骼末端頂點的 3D 世界座標
   *
   * 對頭/手/腳使用更接近末端的骨骼（指尖、腳趾、頭頂），
   * 若模型不支援則 fallback 到主骨骼 + Y 偏移。
   */
  getBoneExtremityWorldPosition(extremityName: string): { x: number; y: number; z: number } | null {
    const mapping = VRMController.EXTREMITY_MAP[extremityName];
    if (!mapping) return this.getBoneWorldPosition(extremityName);

    for (const boneName of mapping.bones) {
      const bone = this.getBoneNode(boneName);
      if (bone) {
        bone.getWorldPosition(VRMController._tempWorldPos);
        return {
          x: VRMController._tempWorldPos.x,
          y: VRMController._tempWorldPos.y + mapping.offsetY,
          z: VRMController._tempWorldPos.z,
        };
      }
    }
    return null;
  }

  /**
   * 取得多個骨骼的 canvas CSS 像素座標
   *
   * 將 3D 骨骼世界座標投影到 2D canvas 空間。
   * 回傳的 Map 是內部快取，下次呼叫時會被清空覆寫。
   *
   * @param boneNames 要查詢的骨骼名稱陣列
   * @param camera 用於投影的攝影機
   * @param cssWidth canvas 的 CSS 寬度（clientWidth）
   * @param cssHeight canvas 的 CSS 高度（clientHeight）
   */
  getBoneScreenPositions(
    boneNames: string[],
    camera: THREE.Camera,
    cssWidth: number,
    cssHeight: number,
  ): Map<string, { x: number; y: number }> {
    this._boneScreenCache.clear();

    for (const name of boneNames) {
      const worldPos = this.getBoneExtremityWorldPosition(name);
      if (!worldPos) continue;

      VRMController._tempScreenPos.set(worldPos.x, worldPos.y, worldPos.z).project(camera);

      const x = (VRMController._tempScreenPos.x + 1) / 2 * cssWidth;
      const y = (1 - VRMController._tempScreenPos.y) / 2 * cssHeight;

      this._boneScreenCache.set(name, { x, y });
    }

    return this._boneScreenCache;
  }

  /**
   * 取得 VRM humanoid bone name ↔ node name 雙向映射
   *
   * 供 AnimationMirror 等外部模組使用，避免直接依賴 @pixiv/three-vrm。
   * 回傳 null 表示模型尚未載入。
   */
  getHumanoidBoneMapping(): BoneMapping | null {
    if (!this.vrm?.humanoid) return null;

    const nodeNameToBone = new Map<string, string>();
    const boneToNodeName = new Map<string, string>();

    // 遍歷所有 VRM humanoid bone names
    const boneNames = [
      'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'jaw',
      'leftEye', 'rightEye',
      'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
      'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
      'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
      'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
      'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
      'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
      'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
      'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
      'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
      'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal',
      'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
      'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
      'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
      'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
    ] as const;

    for (const boneName of boneNames) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(boneName);
      if (node) {
        nodeNameToBone.set(node.name, boneName);
        boneToNodeName.set(boneName, node.name);
      }
    }

    return { nodeNameToBone, boneToNodeName };
  }

  /**
   * 取得 AnimationMixer（供 AnimationManager 使用）
   */
  getAnimationMixer(): THREE.AnimationMixer | null {
    return this.mixer;
  }

  /**
   * 載入 .vrma 動畫並轉換為 AnimationClip
   *
   * 封裝 VRM-specific 的動畫轉換邏輯。
   * 其他模組只需使用回傳的 Three.js AnimationClip。
   */
  async loadVRMAnimation(url: string): Promise<THREE.AnimationClip | null> {
    if (!this.vrm) return null;

    const gltf = await this.loader.loadAsync(url);
    // userData.vrmAnimations 由 VRMAnimationLoaderPlugin 產生
    const vrmAnimation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!vrmAnimation) return null;

    return createVRMAnimationClip(vrmAnimation, this.vrm);
  }

  /**
   * 設定模型縮放（僅供 SceneManager 使用）
   */
  setModelScale(scale: number): void {
    if (this.vrm) {
      this.vrm.scene.scale.setScalar(scale);
    }
  }

  /**
   * 設定模型在世界空間中的位置（全螢幕模式用）
   *
   * 將 VRM 模型平移到指定的世界座標，模型原點在腳底。
   * 基礎旋轉 (Math.PI) 保留，只改變 position。
   */
  setWorldPosition(x: number, y: number, z?: number): void {
    if (this.vrm) {
      this.vrm.scene.position.x = x;
      this.vrm.scene.position.y = y;
      if (z !== undefined) this.vrm.scene.position.z = z;
    }
  }

  /**
   * 設定模型 Y 軸旋轉（移動方向追蹤用）
   *
   * 基礎旋轉 Math.PI（面向攝影機）+ 額外的方向旋轉。
   */
  setFacingRotationY(theta: number): void {
    if (this.vrm) {
      this.vrm.scene.rotation.y = Math.PI + theta;
    }
  }

  /**
   * 偏移模型世界 X 座標（用於 peek 骨骼錨定）
   *
   * 在 setWorldPosition 之後呼叫，微調模型位置讓手對齊邊緣。
   */
  offsetWorldPositionX(dx: number): void {
    if (this.vrm) {
      this.vrm.scene.position.x += dx;
    }
  }

  /**
   * 暫時偏移 VRM scene Y 位置（sit 狀態 hip 錨定用）
   *
   * 在 setWorldPosition 之後呼叫，微調模型位置讓臀部對齊平面。
   */
  offsetWorldPositionY(dy: number): void {
    if (this.vrm) {
      this.vrm.scene.position.y += dy;
    }
  }

  /**
   * 取得 hips 骨骼的世界 Y 座標（相對於模型原點）
   *
   * 用於 sit 狀態定位：讓臀部對齊平面。
   * 回傳值 = hips 骨骼世界 Y - 模型 scene.position.y
   */
  getHipOffsetY(): number | null {
    if (!this.vrm?.humanoid) return null;
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) return null;
    hips.getWorldPosition(VRMController._tempWorldPos);
    // 回傳相對於模型腳底的偏移量
    return VRMController._tempWorldPos.y - this.vrm.scene.position.y;
  }

  /**
   * 取得 hips 骨骼世界座標相對於模型 scene 原點的 3D 偏移量
   *
   * 與 getHipOffsetY 不同：包含 X/Y/Z 三軸。
   * 用於 sit 狀態下完整補償 hip 動畫位移（避免 hip translation 把模型推出 camera near plane）。
   *
   * 已包含 vrm.scene.rotation 的影響（getWorldPosition 是世界座標）。
   */
  getHipsRelativeOffset(): { x: number; y: number; z: number } | null {
    if (!this.vrm?.humanoid) return null;
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) return null;
    hips.getWorldPosition(VRMController._tempWorldPos);
    return {
      x: VRMController._tempWorldPos.x - this.vrm.scene.position.x,
      y: VRMController._tempWorldPos.y - this.vrm.scene.position.y,
      z: VRMController._tempWorldPos.z - this.vrm.scene.position.z,
    };
  }

  /** 重複使用的 Box3（避免每幀配置新物件） */
  private static readonly _tempBox3 = new THREE.Box3();

  /** 取得模型的世界空間包圍盒尺寸 */
  getModelWorldSize(): { width: number; height: number } | null {
    if (!this.vrm) return null;
    const box = VRMController._tempBox3.setFromObject(this.vrm.scene);
    return {
      width: box.max.x - box.min.x,
      height: box.max.y - box.min.y,
    };
  }

  /** 重複使用的 Box3（核心尺寸計算專用） */
  private static readonly _coreBox3 = new THREE.Box3();
  /** 重複使用的 Vector3（核心尺寸計算專用） */
  private static readonly _tempVec3 = new THREE.Vector3();

  /** humanoid 骨骼名稱（用於核心尺寸計算，自然排除 SpringBone） */
  private static readonly HUMANOID_BONE_NAMES = [
    'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
    'leftUpperArm', 'leftLowerArm', 'leftHand',
    'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot',
    'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  ];

  /** 重複使用的 Vector3（方向性擴展用） */
  private static readonly _tempVec3B = new THREE.Vector3();

  /**
   * 取得排除 SpringBone 的模型核心尺寸（方向性擴展）
   *
   * 1. 用 humanoid 骨骼世界座標建構基礎 Box3（排除 SpringBone）
   * 2. 頭頂外推：neck→head 向量延伸，補正頭蓋骨
   * 3. 腳底外推：foot 往下延伸 lowerLeg→foot 距離的 30%
   * 4. 兩側外推：左右肩寬的 25% 補正軀幹/衣物厚度
   */
  getCoreWorldSize(): { width: number; height: number } | null {
    if (!this.vrm) return null;

    const box = VRMController._coreBox3.makeEmpty();
    const v = VRMController._tempVec3;

    // 收集骨骼世界座標
    const bonePos = new Map<string, THREE.Vector3>();
    for (const boneName of VRMController.HUMANOID_BONE_NAMES) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(boneName as never);
      if (node) {
        const pos = new THREE.Vector3();
        node.getWorldPosition(pos);
        bonePos.set(boneName, pos);
        box.expandByPoint(pos);
      }
    }

    // 也檢查腳趾（如果模型有的話）
    for (const toeName of ['leftToes', 'rightToes']) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(toeName as never);
      if (node) {
        node.getWorldPosition(v);
        bonePos.set(toeName, v.clone());
        box.expandByPoint(v);
      }
    }

    if (box.isEmpty()) return this.getModelWorldSize();

    // ── 方向性擴展 ──

    const vA = VRMController._tempVec3;
    const vB = VRMController._tempVec3B;

    // 頭頂外推：neck→head 方向延伸同等距離
    const neck = bonePos.get('neck');
    const head = bonePos.get('head');
    if (neck && head) {
      vA.copy(head).sub(neck); // neck→head 向量
      vB.copy(head).add(vA);   // head + 同方向延伸
      box.expandByPoint(vB);
    }

    // 腳底外推：lowerLeg→foot 方向延伸 30%
    for (const side of ['left', 'right'] as const) {
      const lowerLeg = bonePos.get(`${side}LowerLeg`);
      const foot = bonePos.get(`${side}Foot`);
      if (lowerLeg && foot) {
        vA.copy(foot).sub(lowerLeg); // lowerLeg→foot 向量
        vB.copy(foot).addScaledVector(vA, 0.3);
        box.expandByPoint(vB);
      }
    }

    // 兩側外推：左右 upperArm 間距的 25% 向外擴展
    const leftArm = bonePos.get('leftUpperArm');
    const rightArm = bonePos.get('rightUpperArm');
    if (leftArm && rightArm) {
      const shoulderWidth = Math.abs(leftArm.x - rightArm.x);
      const padding = shoulderWidth * 0.25;
      box.min.x -= padding;
      box.max.x += padding;
    }

    return {
      width: box.max.x - box.min.x,
      height: box.max.y - box.min.y,
    };
  }

  /**
   * 更新 VRM 內部邏輯（SpringBone 等）
   *
   * 由 SceneManager 的 render loop 呼叫。
   *
   * 順序：
   *   1. vrm.update(dt)        — SpringBone 物理（讀上一幀的 mixer 結果，已知一幀 lag 但視覺 OK）
   *   2. mixer.update(dt)      — 套用本幀動畫到骨骼 local
   *   3. applyHipSmoothing(dt) — 修正 vrm.scene.position 吸收 hip 跨幀跳變
   *
   * applyHipSmoothing 在 mixer.update 之後執行，這樣讀到的 hip world position
   * 已反映本幀動畫。修正寫入 vrm.scene.position，下個 renderer.render()
   * 呼叫 updateMatrixWorld 時生效。
   */
  update(deltaTime: number): void {
    if (this.vrm) {
      this.vrm.update(deltaTime);
    }
    if (this.mixer) {
      this.mixer.update(deltaTime);
    }
    this.applyHipSmoothing(deltaTime);
  }

  /**
   * Hip 跨幀平滑：吸收動畫切換造成的 hip 瞬間跳變
   *
   * 演算法（指數平滑 + 距離自適應速率）：
   *   1. 讀取 mixer 套用後的 hip world position（actual）
   *   2. 維護一個 smoothedHipsWorld，每幀以 lerp 追上 actual
   *   3. 距離小（正常動作）→ 用較高速率（HIP_RATE_NEAR）緊密追蹤
   *      距離大（動畫切換造成的跳變）→ 用較低速率（HIP_RATE_FAR）緩慢追上
   *   4. 套用 (smoothed - actual) 到 vrm.scene.position 作為補償
   *      → 渲染時 hip 出現在 smoothed 位置，視覺上連續
   *
   * vrm.scene.position 每幀都被 SceneManager.updateModelWorldPosition 重置，
   * 所以本方法的修正不會跨幀累積。
   */
  private applyHipSmoothing(deltaTime: number): void {
    if (!this.vrm?.humanoid) return;
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hips) return;

    // 取得 mixer 套用後的 hip world position（透過 getWorldPosition 觸發 matrix 更新）
    hips.getWorldPosition(VRMController._tempWorldPos);

    if (!this.smoothedHipsValid) {
      // 首次或重置後：smoothed 直接設為 actual
      this.smoothedHipsWorld.copy(VRMController._tempWorldPos);
      this.smoothedHipsValid = true;
      return;
    }

    // 計算 smoothed 與 actual 的距離
    const dx = VRMController._tempWorldPos.x - this.smoothedHipsWorld.x;
    const dy = VRMController._tempWorldPos.y - this.smoothedHipsWorld.y;
    const dz = VRMController._tempWorldPos.z - this.smoothedHipsWorld.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // 距離自適應速率
    const rate = dist < VRMController.HIP_NEAR_THRESHOLD
      ? VRMController.HIP_RATE_NEAR
      : VRMController.HIP_RATE_FAR;
    const lerpFactor = 1 - Math.exp(-rate * deltaTime);

    // smoothed 朝 actual 追上
    this.smoothedHipsWorld.lerp(VRMController._tempWorldPos, lerpFactor);

    // Layer 6：大幅跳變時重置 SpringBone，避免頭髮/衣物彈跳
    // 即使 hip 平滑（階段 B）將視覺位移分散到多幀，SpringBone 仍會把每幀的
    // 位移當成物理外力造成擺動。重置會把所有 spring tail 快照到當前 bind pose
    // 並清零 verlet 速度，下幀 SpringBone 從穩定狀態繼續模擬。
    if (dist > VRMController.HIP_LARGE_JUMP) {
      this.vrm.springBoneManager?.reset();
    }

    // 套用補償：vrm.scene.position += (smoothed - actual)
    // 結果：渲染時 hip 位置 = actual + (smoothed - actual) = smoothed
    this.vrm.scene.position.x += this.smoothedHipsWorld.x - VRMController._tempWorldPos.x;
    this.vrm.scene.position.y += this.smoothedHipsWorld.y - VRMController._tempWorldPos.y;
    this.vrm.scene.position.z += this.smoothedHipsWorld.z - VRMController._tempWorldPos.z;
  }

  /** 暫時偏移 VRM scene 位置（供 SpringBone 偵測移動用） */
  applySceneOffset(dx: number, dy: number): void {
    if (this.vrm) {
      this.vrm.scene.position.x += dx;
      this.vrm.scene.position.y += dy;
    }
  }

  /** 恢復 VRM scene 位置偏移 */
  clearSceneOffset(dx: number, dy: number): void {
    if (this.vrm) {
      this.vrm.scene.position.x -= dx;
      this.vrm.scene.position.y -= dy;
    }
  }

  /**
   * 移除模型並釋放資源
   */
  dispose(): void {
    if (this.vrm) {
      // 遍歷所有子 mesh，釋放 geometry 和 material（防止 GPU 記憶體洩漏）
      this.vrm.scene.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          mesh.geometry?.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => m.dispose());
          } else {
            mesh.material?.dispose();
          }
        }
      });
      this.scene.remove(this.vrm.scene);
      this.vrm = null;
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
    // 重置 hip 平滑狀態
    this.smoothedHipsValid = false;
  }
}
