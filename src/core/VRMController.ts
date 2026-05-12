import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, VRMAnimation, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import type { BoneMapping } from '../animation/AnimationMirror';
import type { HeadTrackingController } from '../headtracking/HeadTrackingController';

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

  // ── 頭頂 / 腳底 mesh 頂點掃描結果（bind pose bone-local 座標）──
  /**
   * Head bone 本地座標下，最高頂點的位置。
   * 由 scanHeadFootExtents() 於 loadModel 後寫入。
   * runtime 呼叫 headBone.localToWorld(clone) 即可取得當前世界位置，
   * 自動處理 scale、旋轉、位置的複合變換。
   */
  private cachedHeadTopLocal: THREE.Vector3 | null = null;
  /** Foot bone（較低的一隻腳）本地座標下，最低頂點的位置 */
  private cachedFootBottomLocal: THREE.Vector3 | null = null;
  /** 對應 cachedFootBottomLocal 的骨骼 reference（左或右腳） */
  private cachedFootRefBone: THREE.Object3D | null = null;

  /** 滑鼠頭部追蹤控制器（在 mixer.update 後、applyHipSmoothing 前套用） */
  private headTrackingController: HeadTrackingController | null = null;

  /** 取得 VRM 實例（供 SceneManager 計算 bounding box） */
  getVRM(): VRM | null {
    return this.vrm;
  }

  /**
   * 取得 VRM scene 的根 Object3D（含 vrm.scene.rotation.y = π 的模型 root transform）
   *
   * 供 HeadTrackingController 將 world 座標轉成 model-local 座標，
   * 以靜態的 rest forward (+Z) 當追蹤參考軸，避免回授迴圈。
   */
  getModelRoot(): THREE.Object3D | null {
    return this.vrm?.scene ?? null;
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
    // 掃描頭頂/腳底實際 mesh 頂點範圍（bind pose，一次性）
    this.scanHeadFootExtents();

    // 接上滑鼠頭部追蹤
    if (this.headTrackingController) {
      const target = this.headTrackingController.getLookAtTarget();
      if (target.parent !== this.scene) {
        this.scene.add(target);
      }
      // VRM lookAt 對眼球做球面 clamp，把同一個 Object3D 當 target
      if (vrm.lookAt) {
        vrm.lookAt.target = target;
        // 許多 VRM 模型作者把 rangeMap.outputScale 設成很小（如 2-3°），
        // 導致眼球幾乎不動。覆寫成合理值（眼球最大 ±15° 是人類舒適範圍）。
        // 對 bone-based applier 才適用（outputScale 單位是角度），expression-based
        // 是 0..1 權重就保持原值。
        const applier = vrm.lookAt.applier as {
          constructor: { type?: string };
          rangeMapHorizontalInner?: { inputMaxValue: number; outputScale: number };
          rangeMapHorizontalOuter?: { inputMaxValue: number; outputScale: number };
          rangeMapVerticalDown?: { inputMaxValue: number; outputScale: number };
          rangeMapVerticalUp?: { inputMaxValue: number; outputScale: number };
        };
        if ((applier.constructor as { type?: string }).type === 'bone') {
          // 我們的 lookAt 輸入角度範圍約 ±30°（cursor 平常掃動範圍）。
          // 將 inputMaxValue 從預設 90° 降到 30°，讓「輸入 30° = 眼球 max」
          // outputScale 給人類舒適範圍：水平 25°、垂直 18°
          for (const rm of [applier.rangeMapHorizontalInner, applier.rangeMapHorizontalOuter]) {
            if (rm) {
              rm.inputMaxValue = 30;
              rm.outputScale = 12;
            }
          }
          for (const rm of [applier.rangeMapVerticalDown, applier.rangeMapVerticalUp]) {
            if (rm) {
              rm.inputMaxValue = 30;
              rm.outputScale = 9;
            }
          }
        }
        const lEye2 = vrm.humanoid?.getNormalizedBoneNode('leftEye');
        const rEye2 = vrm.humanoid?.getNormalizedBoneNode('rightEye');
        console.log(
          `[headtracking] vrm.lookAt OK — type=${(applier.constructor as { type?: string }).type ?? 'unknown'}, ` +
            `eyeBones=${lEye2 && rEye2 ? 'both' : lEye2 ? 'L only' : rEye2 ? 'R only' : 'none'}, ` +
            `rangeMap overridden to ±15°/±12°`,
        );
      } else {
        console.warn('[headtracking] vrm.lookAt is null — model has no lookAt setup');
      }
      this.headTrackingController.rebuildChain();
    }
  }

  /**
   * 注入 HeadTrackingController（由 SceneManager 在建構時呼叫一次）。
   *
   * 之後每次 loadModel 完成時 VRMController 會自動呼叫 rebuildChain。
   */
  setHeadTrackingController(ctrl: HeadTrackingController): void {
    this.headTrackingController = ctrl;
    if (ctrl.getLookAtTarget().parent !== this.scene) {
      this.scene.add(ctrl.getLookAtTarget());
    }
    if (this.vrm) {
      if (this.vrm.lookAt) {
        this.vrm.lookAt.target = ctrl.getLookAtTarget();
      }
      ctrl.rebuildChain();
    }
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
  async loadVRMAnimation(url: string, options?: { keepHipZ?: boolean }): Promise<THREE.AnimationClip | null> {
    if (!this.vrm) return null;

    const gltf = await this.loader.loadAsync(url);
    // userData.vrmAnimations 由 VRMAnimationLoaderPlugin 產生
    const vrmAnimation = gltf.userData.vrmAnimations?.[0] as VRMAnimation | undefined;
    if (!vrmAnimation) return null;

    const clip = createVRMAnimationClip(vrmAnimation, this.vrm);

    // 移除 hips position track 的 Z 分量（避免 near plane 裁切）
    // opendoor 動畫需要保留 hip Z（穿門移動）
    if (!options?.keepHipZ) {
      this.stripHipsPositionZ(clip);
    }

    return clip;
  }

  /**
   * 移除動畫 clip 中 hips bone position track 的 Z 分量
   *
   * VRM sit 動畫常含大幅 hip Z 位移（如 +1.25m），會把模型推向
   * camera near plane 導致前方部位被裁切。在載入時歸零 Z 分量，
   * 從源頭消除問題，不需 runtime 補償。
   */
  private stripHipsPositionZ(clip: THREE.AnimationClip): void {
    if (!this.vrm) return;

    const hipsNode = this.vrm.humanoid.getNormalizedBoneNode('hips');
    if (!hipsNode) return;

    const hipsTrackName = `${hipsNode.name}.position`;

    for (const track of clip.tracks) {
      if (track.name === hipsTrackName) {
        // VectorKeyframeTrack values: [x0,y0,z0, x1,y1,z1, ...]
        const values = track.values;
        let maxAbsZ = 0;
        for (let i = 2; i < values.length; i += 3) {
          maxAbsZ = Math.max(maxAbsZ, Math.abs(values[i]));
          values[i] = 0;
        }
        if (maxAbsZ > 0.01) {
          console.log(`[VRMController] stripped hips Z from "${clip.name}" (max |Z|=${maxAbsZ.toFixed(3)}m)`);
        }
        break;
      }
    }
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
   * 暫時偏移 VRM scene Z 位置（sit 狀態 near plane 保護用）
   *
   * 在 setWorldPosition 之後呼叫，抵消動畫 hip Z 偏移避免 near plane 裁切。
   */
  offsetWorldPositionZ(dz: number): void {
    if (this.vrm) {
      this.vrm.scene.position.z += dz;
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
   * 取得排除 SpringBone 的模型核心尺寸
   *
   * 1. 用 humanoid 骨骼世界座標建構基礎 Box3（排除 SpringBone）
   * 2. 頭頂：優先使用 scanHeadFootExtents() 掃描到的 mesh 頂點（精確），
   *    fallback 用 neck→head 向量延伸 1.5×
   * 3. 腳底：優先使用 mesh 頂點掃描，fallback 用 lowerLeg→foot 延伸 50%
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

    // 頭頂外推：優先用 mesh 頂點掃描的 head bone local offset
    const headBone = this.vrm.humanoid.getNormalizedBoneNode('head');
    if (this.cachedHeadTopLocal && headBone) {
      vA.copy(this.cachedHeadTopLocal);
      headBone.localToWorld(vA);
      box.expandByPoint(vA);
    } else {
      // Fallback：neck→head 方向延伸 1.5×
      const neck = bonePos.get('neck');
      const head = bonePos.get('head');
      if (neck && head) {
        vA.copy(head).sub(neck); // neck→head 向量
        vB.copy(head).addScaledVector(vA, 1.5);
        box.expandByPoint(vB);
      }
    }

    // 腳底外推：優先用 mesh 頂點掃描的 foot bone local offset
    if (this.cachedFootBottomLocal && this.cachedFootRefBone) {
      vA.copy(this.cachedFootBottomLocal);
      this.cachedFootRefBone.localToWorld(vA);
      box.expandByPoint(vA);
    } else {
      // Fallback：lowerLeg→foot 方向延伸 50%
      for (const side of ['left', 'right'] as const) {
        const lowerLeg = bonePos.get(`${side}LowerLeg`);
        const foot = bonePos.get(`${side}Foot`);
        if (lowerLeg && foot) {
          vA.copy(foot).sub(lowerLeg); // lowerLeg→foot 向量
          vB.copy(foot).addScaledVector(vA, 0.5);
          box.expandByPoint(vB);
        }
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
   * 掃描 SkinnedMesh 頂點，計算頭頂與腳底的精確 bind pose 位置
   *
   * 演算法（一次性，於 loadModel 結束時呼叫）：
   * 1. updateMatrixWorld(true) 確保 bind pose matrices
   * 2. 建立 role 分類表：每個骨骼若為 head（或其後裔）→ 'head'；
   *    若為 foot/toes（或其後裔）→ 'foot'；其餘 null
   *    ※ 註：VRM humanoid 骨骼的階層很淺，head 本身不會有後裔是其他 humanoid
   *       所以實務上就是「骨骼 === head bone」判斷
   * 3. 遍歷所有 SkinnedMesh 的每個頂點：
   *    - 找主要權重骨骼（skinWeight.x/y/z/w 的最大值對應的 skinIndex）
   *    - 查 role：非 head/foot 則 skip（自動排除 SpringBone）
   *    - 用 mesh.matrixWorld 轉成世界座標
   *    - 更新 headMaxY / footMinY 對應的世界座標點
   * 4. 將找到的頂點轉成 head/foot bone 的本地座標存入 cache
   *    runtime 用 bone.localToWorld 自動跟隨 scale / 旋轉 / 位置變換
   *
   * 若任一類別沒有找到有效頂點，對應的 cache 保持 null，
   * getCoreWorldSize() 會 fallback 到骨骼比例延伸法（Plan A）。
   */
  private scanHeadFootExtents(): void {
    if (!this.vrm) return;

    this.vrm.scene.updateMatrixWorld(true);

    const headBone = this.vrm.humanoid.getNormalizedBoneNode('head');
    const leftFoot = this.vrm.humanoid.getNormalizedBoneNode('leftFoot');
    const rightFoot = this.vrm.humanoid.getNormalizedBoneNode('rightFoot');
    const leftToes = this.vrm.humanoid.getNormalizedBoneNode('leftToes');
    const rightToes = this.vrm.humanoid.getNormalizedBoneNode('rightToes');

    if (!headBone && !leftFoot && !rightFoot) {
      console.warn('[VRMController] scanHeadFootExtents: no head/foot bones, using fallback');
      return;
    }

    const footBones = new Set<THREE.Object3D>();
    if (leftFoot) footBones.add(leftFoot);
    if (rightFoot) footBones.add(rightFoot);
    if (leftToes) footBones.add(leftToes);
    if (rightToes) footBones.add(rightToes);

    let headTopWorld: THREE.Vector3 | null = null;
    let footBottomWorld: THREE.Vector3 | null = null;
    let headMaxY = -Infinity;
    let footMinY = Infinity;

    const tempV = new THREE.Vector3();

    this.vrm.scene.traverse((child) => {
      const mesh = child as THREE.SkinnedMesh;
      if (!(mesh as THREE.SkinnedMesh).isSkinnedMesh) return;

      const posAttr = mesh.geometry.attributes.position as THREE.BufferAttribute | undefined;
      const skinIndexAttr = mesh.geometry.attributes.skinIndex as THREE.BufferAttribute | undefined;
      const skinWeightAttr = mesh.geometry.attributes.skinWeight as THREE.BufferAttribute | undefined;
      if (!posAttr || !skinIndexAttr || !skinWeightAttr) return;

      const skeleton = mesh.skeleton;
      if (!skeleton?.bones) return;

      // 建立該 mesh 的 bone index → role 分類表
      const boneRoles: (null | 'head' | 'foot')[] = skeleton.bones.map((bone) => {
        if (headBone && bone === headBone) return 'head';
        if (footBones.has(bone)) return 'foot';
        return null;
      });

      const hasAnyTarget = boneRoles.some((r) => r !== null);
      if (!hasAnyTarget) return;

      for (let i = 0; i < posAttr.count; i++) {
        // 找主要權重骨骼
        const wx = skinWeightAttr.getX(i);
        const wy = skinWeightAttr.getY(i);
        const wz = skinWeightAttr.getZ(i);
        const ww = skinWeightAttr.getW(i);
        let maxW = wx;
        let maxSlot = 0;
        if (wy > maxW) { maxW = wy; maxSlot = 1; }
        if (wz > maxW) { maxW = wz; maxSlot = 2; }
        if (ww > maxW) { maxW = ww; maxSlot = 3; }
        if (maxW <= 0) continue;

        let dominantBoneIdx: number;
        switch (maxSlot) {
          case 0: dominantBoneIdx = skinIndexAttr.getX(i); break;
          case 1: dominantBoneIdx = skinIndexAttr.getY(i); break;
          case 2: dominantBoneIdx = skinIndexAttr.getZ(i); break;
          default: dominantBoneIdx = skinIndexAttr.getW(i); break;
        }

        const role = boneRoles[dominantBoneIdx];
        if (!role) continue;

        tempV.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);

        if (role === 'head' && tempV.y > headMaxY) {
          headMaxY = tempV.y;
          headTopWorld = headTopWorld ?? new THREE.Vector3();
          headTopWorld.copy(tempV);
        } else if (role === 'foot' && tempV.y < footMinY) {
          footMinY = tempV.y;
          footBottomWorld = footBottomWorld ?? new THREE.Vector3();
          footBottomWorld.copy(tempV);
        }
      }
    });

    // 轉成 bone-local 並 cache
    if (headTopWorld && headBone) {
      this.cachedHeadTopLocal = headBone.worldToLocal((headTopWorld as THREE.Vector3).clone());
    }

    if (footBottomWorld) {
      // 選離頂點較近的腳骨作為參考（左/右較低者）
      const leftY = leftFoot ? leftFoot.getWorldPosition(new THREE.Vector3()).y : Infinity;
      const rightY = rightFoot ? rightFoot.getWorldPosition(new THREE.Vector3()).y : Infinity;
      const refFoot = leftY <= rightY ? leftFoot : rightFoot;
      if (refFoot) {
        this.cachedFootRefBone = refFoot;
        this.cachedFootBottomLocal = refFoot.worldToLocal((footBottomWorld as THREE.Vector3).clone());
      }
    }

    const headOk = this.cachedHeadTopLocal !== null;
    const footOk = this.cachedFootBottomLocal !== null;
    console.log(
      `[VRMController] scanHeadFootExtents: head=${headOk ? 'ok' : 'fallback'}, foot=${footOk ? 'ok' : 'fallback'}`,
    );
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
    // 滑鼠頭部追蹤：在 mixer 寫入骨骼後、hip 平滑前覆寫頭/頸/上身旋轉
    // 內部會與 mixer 寫入的 quaternion 做加權混合
    if (this.headTrackingController) {
      this.headTrackingController.applyPerFrame(deltaTime);
    }
    // 眼球 lookAt 需在 mixer 之後執行 — 否則動畫若含 eye 軌道會覆寫
    // vrm.lookAt 的結果。手動再跑一次 lookAt update。
    if (this.vrm?.lookAt) {
      this.vrm.lookAt.update(deltaTime);
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
    if (this.vrm?.lookAt && this.headTrackingController) {
      // 解除引用，避免 lookAt 持有 disposed Object3D
      this.vrm.lookAt.target = null;
    }
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
    // 重置頭頂/腳底掃描 cache
    this.cachedHeadTopLocal = null;
    this.cachedFootBottomLocal = null;
    this.cachedFootRefBone = null;
  }
}
