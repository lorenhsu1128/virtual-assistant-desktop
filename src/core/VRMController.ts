import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMAnimation, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

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

  /** 取得 VRM 實例（供 SceneManager 計算 bounding box） */
  getVRM(): VRM | null {
    return this.vrm;
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

    this.vrm = vrm;
    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.scene.add(vrm.scene);

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
  setWorldPosition(x: number, y: number): void {
    if (this.vrm) {
      this.vrm.scene.position.x = x;
      this.vrm.scene.position.y = y;
    }
  }

  /** 取得模型的世界空間包圍盒尺寸 */
  getModelWorldSize(): { width: number; height: number } | null {
    if (!this.vrm) return null;
    const box = new THREE.Box3().setFromObject(this.vrm.scene);
    return {
      width: box.max.x - box.min.x,
      height: box.max.y - box.min.y,
    };
  }

  /**
   * 更新 VRM 內部邏輯（SpringBone 等）
   *
   * 由 SceneManager 的 render loop 呼叫。
   */
  update(deltaTime: number): void {
    if (this.vrm) {
      this.vrm.update(deltaTime);
    }
    if (this.mixer) {
      this.mixer.update(deltaTime);
    }
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
      this.scene.remove(this.vrm.scene);
      this.vrm = null;
    }
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer = null;
    }
  }
}
