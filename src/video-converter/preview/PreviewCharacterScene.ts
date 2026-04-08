/**
 * 影片動作轉換器 — Preview Character Scene
 *
 * 獨立的 Three.js 場景與 render loop，供右窗格顯示 VRM 模型。
 *
 * **架構備註**：
 *   src/CLAUDE.md 規定「SceneManager 獨佔 render loop」與「VRMController
 *   獨佔 VRM 操作」此規則指**主視窗 renderer**。本檔跑在獨立的
 *   BrowserWindow（同 vrm-picker 模式），有自己的 renderer process，
 *   與主視窗 SceneManager / VRMController 完全分離，不受主視窗 render
 *   loop 規則約束。內部仍重用 VRMController class 以共用 hip 平滑、
 *   bone 操作等 helper（Phase 10 套用 SolvedPose 時會用到）。
 *
 * 對應計畫：video-converter-plan.md 第 2.9 節 / Phase 9
 *
 * 職責：
 *   - 建立並擁有獨立的 WebGLRenderer / Scene / Camera / lights
 *   - 載入 VRM（透過內部 VRMController 實例）
 *   - 載入後自動 framing（按 bbox 調整 camera）
 *   - 提供 OrbitControls 讓使用者拖曳預覽角度
 *   - 自有 RAF render loop
 *   - WebGL context lost 監聽
 *   - applyPose() stub — Phase 10 才會接 PoseSolver SolvedPose
 *
 * 不負責：
 *   - 解析動作（PoseSolver / MediaPipe — 在 main.ts orchestrate）
 *   - .vrma 動畫播放（暫不需要）
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMController } from '../../core/VRMController';
import type { Quat } from '../math/Quat';
import type { Vec3 } from '../math/Vector';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';

/**
 * 對每根骨骼，列出其「主要 child」骨骼名。校正 REF_DIR 時讀取
 * child.position（在 bone 自身的 local frame）作為該 bone 的「rest 軸方向」。
 *
 * 對應 plan 第 8 節 Open Question 2 — 用實際 VRM rest pose 反推校正。
 */
const BONE_CHILD_FOR_CALIBRATION: ReadonlyArray<readonly [VRMHumanoidBoneName, VRMHumanoidBoneName]> = [
  ['spine', 'chest'],
  ['chest', 'upperChest'],
  ['upperChest', 'neck'],
  ['neck', 'head'],
  ['leftShoulder', 'leftUpperArm'],
  ['leftUpperArm', 'leftLowerArm'],
  ['leftLowerArm', 'leftHand'],
  ['rightShoulder', 'rightUpperArm'],
  ['rightUpperArm', 'rightLowerArm'],
  ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'],
  ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'],
  ['rightLowerLeg', 'rightFoot'],
];

/**
 * Phase 9 用佔位介面，Phase 10 會改為從 ../solver/PoseSolver 引入 SolvedPose。
 * 提早定義避免後續 phase 改動本檔的 public API。
 */
export interface SolvedPoseLike {
  hipsTranslation: Vec3 | null;
  boneRotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
}

const BG_COLOR = 0x11111b; // catppuccin mocha base
const FOV_DEG = 30;
const DEFAULT_CAMERA_POS = new THREE.Vector3(0, 1.0, 2.4);
const DEFAULT_LOOK_TARGET = new THREE.Vector3(0, 0.95, 0);

export class PreviewCharacterScene {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private vrmController: VRMController;
  private clock = new THREE.Clock();
  private rafHandle: number | null = null;
  private running = false;
  /** 記錄是否已成功載入過模型，影響 dispose / reload 行為 */
  private hasModel = false;
  private contextLostListener: ((ev: Event) => void) | null = null;
  private contextRestoredListener: ((ev: Event) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    // 兩盞燈：hemisphere（軟環境光）+ directional（主光源）
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444466, 0.7);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(1.5, 2.5, 2.5);
    this.scene.add(dir);

    // Camera
    this.camera = new THREE.PerspectiveCamera(FOV_DEG, 1, 0.1, 100);
    this.camera.position.copy(DEFAULT_CAMERA_POS);
    this.camera.lookAt(DEFAULT_LOOK_TARGET);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: false,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // OrbitControls 讓使用者拖曳預覽角度
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(DEFAULT_LOOK_TARGET);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 8;
    this.controls.update();

    // VRMController（共用 hip 平滑、bone 操作 helper）
    this.vrmController = new VRMController(this.scene);

    // WebGL context lost / restored
    this.contextLostListener = (ev: Event): void => {
      ev.preventDefault();
      console.warn('[PreviewCharacterScene] WebGL context lost');
      this.stop();
    };
    this.contextRestoredListener = (): void => {
      console.warn('[PreviewCharacterScene] WebGL context restored — restarting');
      this.start();
    };
    canvas.addEventListener('webglcontextlost', this.contextLostListener);
    canvas.addEventListener('webglcontextrestored', this.contextRestoredListener);
  }

  /** 已成功載入過 VRM 模型 */
  get isModelLoaded(): boolean {
    return this.hasModel;
  }

  /** 載入 VRM。url 可以是 local-file:// / blob: / 一般 URL */
  async loadVrm(url: string): Promise<void> {
    await this.vrmController.loadModel(url);
    this.hasModel = true;
    this.frameModel();
  }

  /**
   * 從當前載入的 VRM bind pose 計算每根骨骼的 REF_DIR。
   *
   * 流程：對 BONE_CHILD_FOR_CALIBRATION 中的每對 (parent, child)，
   * 讀取 child 骨骼節點的 position（已是 parent 的 local frame，
   * 因為 Three.js 子節點 position 即為相對父節點偏移），正規化後即為
   * 該 parent 骨骼的 rest 軸方向。
   *
   * 找不到的骨骼會略過（例如 VRM 模型沒有 upperChest / chest），呼叫端
   * 取得的 map 會缺對應 entry，BodySolver.setRefDirs 會用 plan 第 3 節
   * 的預設值補上。
   */
  calibrateRefDirs(): Partial<Record<VRMHumanoidBoneName, Vec3>> {
    const result: Partial<Record<VRMHumanoidBoneName, Vec3>> = {};
    if (!this.hasModel) return result;

    for (const [parentBone, childBone] of BONE_CHILD_FOR_CALIBRATION) {
      const childNode = this.vrmController.getBoneNode(childBone);
      if (!childNode) continue;
      const len = childNode.position.length();
      if (len < 1e-6) continue;
      result[parentBone] = {
        x: childNode.position.x / len,
        y: childNode.position.y / len,
        z: childNode.position.z / len,
      };
    }
    return result;
  }

  /** 可重用 THREE.Quaternion，避免每幀 GC */
  private readonly _tmpQuat = new THREE.Quaternion();
  /** Y 軸 180° 旋轉（VRMController.loadModel 在 vrm.scene 套的反轉） */
  private static readonly Y180 = new THREE.Quaternion(0, 1, 0, 0);

  /**
   * 暫時略過套用的骨骼。head 的 ear-nose 追蹤在側面視角會退化，
   * 目前也沒有穩定的 REF_DIR 校正來源（head 沒有 child bone 可計算），
   * 先不套用避免視覺畸形。Phase 14+ 會重做頭部追蹤。
   */
  private static readonly SKIP_BONES = new Set<string>(['head']);

  /**
   * 套用一幀 SolvedPose 到 VRM。
   *
   * Phase 10.5 行為：
   *   - 對每根非 hips 的 bone，把 SolvedPose 中的 Quat 直接轉為
   *     THREE.Quaternion 並呼叫 VRMController.setBoneRotation
   *   - hips bone 特殊處理：VRMController.loadModel 在 vrm.scene 套了
   *     180° Y 軸反轉讓模型面向相機。要讓 hips bone 的 LOCAL rotation
   *     在世界座標下等於 solver 算出的 hipsWorldQ，需用
   *         hips_local = Y180⁻¹ × hipsWorldQ = Y180 × hipsWorldQ
   *     （Y180 自我反向 = 自身）
   *   - head bone 暫時 skip（見上方 SKIP_BONES 註解）
   *   - 不套用 hipsTranslation（避免模型位置漂移到鏡頭外）
   *   - 套用後 VRMController.update() 會在下一個 tick 走 SpringBone +
   *     hip 平滑
   *
   * 缺骨骼時靜默跳過（VRM 模型可能沒有 leftEye / chest 等可選骨骼，
   * VRMController.setBoneRotation 內部已處理）。
   */
  applyPose(pose: SolvedPoseLike): void {
    if (!this.hasModel) return;
    for (const [boneName, q] of Object.entries(pose.boneRotations)) {
      if (!q) continue;
      if (PreviewCharacterScene.SKIP_BONES.has(boneName)) continue;
      this._tmpQuat.set(q.x, q.y, q.z, q.w);
      if (boneName === 'hips') {
        // 補償 vrm.scene.rotation.y = π：hips_local = Y180 × hipsWorldQ
        this._tmpQuat.premultiply(PreviewCharacterScene.Y180);
      }
      this.vrmController.setBoneRotation(boneName, this._tmpQuat);
    }
  }

  /** 啟動 render loop */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.tick();
  }

  /** 停止 render loop */
  stop(): void {
    this.running = false;
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = null;
    }
    this.clock.stop();
  }

  private tick = (): void => {
    if (!this.running) return;
    const dt = this.clock.getDelta();

    // 更新 VRM（含 SpringBone）
    this.vrmController.update(dt);

    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.rafHandle = requestAnimationFrame(this.tick);
  };

  /**
   * 對齊 canvas 大小到當前 client 矩形。
   *
   * 由呼叫端在 window resize / canvas 顯示後觸發。
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /**
   * 載入後依模型 bbox 自動 framing：camera 距離 ≈ bbox 高 × 1.6，
   * 對焦於 bbox 中心稍微偏上的位置。
   */
  private frameModel(): void {
    // VRMController.scene 是我們傳入的 scene；找其中最後加入的 vrm.scene 子節點
    // 簡化做法：直接用 scene 整體 bbox（去除 lights 不影響 box）
    const bbox = new THREE.Box3();
    let added = false;
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) {
        bbox.expandByObject(obj);
        added = true;
      }
    });
    if (!added) return;

    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());

    // 對焦稍微偏上（角色臉部高度）
    const target = new THREE.Vector3(center.x, center.y + size.y * 0.15, center.z);
    const distance = Math.max(size.y * 1.6, 1.2);

    this.camera.position.set(target.x, target.y, target.z + distance);
    this.camera.lookAt(target);
    this.controls.target.copy(target);
    this.controls.update();
  }

  dispose(): void {
    this.stop();
    if (this.contextLostListener) {
      this.canvas.removeEventListener('webglcontextlost', this.contextLostListener);
      this.contextLostListener = null;
    }
    if (this.contextRestoredListener) {
      this.canvas.removeEventListener('webglcontextrestored', this.contextRestoredListener);
      this.contextRestoredListener = null;
    }
    this.controls.dispose();
    this.vrmController.dispose();
    this.renderer.dispose();
  }
}
