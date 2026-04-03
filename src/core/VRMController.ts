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
