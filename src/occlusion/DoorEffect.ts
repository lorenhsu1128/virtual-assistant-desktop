/**
 * 門洞效果模組
 *
 * 在視窗 depth mesh 前方放置純黑色不透明 mesh，模擬門洞。
 * 因為桌寵視窗背景是透明黑色，純黑 mesh 視覺上等於「遮住視窗內容」。
 * 角色在黑色 mesh 前面（Z 更大）時自然可見，形成「從門洞走出」的效果。
 *
 * 門洞形狀隨動畫進度變化：
 *   opening:  從鉸鏈側逐漸展開（矩形寬度 0 → doorWidth）
 *   fullOpen: 完整矩形
 *   closing:  從門口側逐漸縮小（矩形寬度 doorWidth → 0）
 */

import * as THREE from 'three';
import type { DoorPhase, DoorFrameConfig } from '../types/door';
import { DEFAULT_DOOR_FRAME_CONFIG } from '../types/door';

export class DoorEffect {
  private scene: THREE.Scene;
  private doorMesh: THREE.Mesh | null = null;
  private doorGeometry: THREE.BufferGeometry | null = null;
  private doorMaterial: THREE.MeshBasicMaterial | null = null;
  private active = false;
  private config: DoorFrameConfig = DEFAULT_DOOR_FRAME_CONFIG;

  /** 門洞在世界座標中的位置和大小 */
  private doorWorldX = 0;
  private doorWorldY = 0;
  private doorWorldZ = 0;
  private doorWorldWidth = 0;
  private doorWorldHeight = 0;
  /** 鉸鏈在左側（門從左向右開）= 'left'，反之 = 'right' */
  private hingeSide: 'left' | 'right' = 'left';

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * 啟動門洞效果
   *
   * @param worldCenter 視窗中心的世界座標
   * @param worldWidth 門洞最大寬度（世界單位）
   * @param worldHeight 門洞高度（世界單位）
   * @param worldZ 門洞的 Z 深度（= 視窗 depth mesh 的 Z）
   * @param hingeSide 鉸鏈側（'left' = 門從左向右開）
   * @param config 幀範圍配置
   */
  start(
    worldCenter: { x: number; y: number },
    worldWidth: number,
    worldHeight: number,
    worldZ: number,
    hingeSide: 'left' | 'right' = 'left',
    config?: DoorFrameConfig,
  ): void {
    this.stop();
    this.active = true;
    this.config = config ?? DEFAULT_DOOR_FRAME_CONFIG;
    this.hingeSide = hingeSide;

    this.doorWorldX = worldCenter.x;
    this.doorWorldY = worldCenter.y;
    this.doorWorldZ = worldZ + 0.05; // 稍微在視窗 depth mesh 前面
    this.doorWorldWidth = worldWidth;
    this.doorWorldHeight = worldHeight;

    // 純黑色不透明 mesh：視覺上等於桌寵透明背景，遮住視窗內容
    this.doorMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    // 初始 geometry（1x1 平面，每幀 scale 調整）
    this.doorGeometry = new THREE.PlaneGeometry(1, 1);
    this.doorMesh = new THREE.Mesh(this.doorGeometry, this.doorMaterial);
    this.doorMesh.name = 'door-effect-black';
    this.doorMesh.renderOrder = 0; // 與一般物件同級
    this.doorMesh.visible = false; // 初始隱藏，opening 階段才顯示
    this.scene.add(this.doorMesh);
  }

  /**
   * 根據動畫當前時間更新門洞形狀
   *
   * @param animTime 動畫已播放的秒數（mixer.time 或 action.time）
   * @returns 當前階段
   */
  update(animTime: number): DoorPhase {
    if (!this.active || !this.doorMesh) return 'done';

    const frame = animTime * this.config.fps;
    const phase = this.getPhase(frame);

    if (phase === 'preparing' || phase === 'done') {
      this.doorMesh.visible = false;
      return phase;
    }

    this.doorMesh.visible = true;

    // 計算門洞開度（0 = 全關，1 = 全開）
    let openRatio = 0;
    if (phase === 'opening') {
      const range = this.config.openEnd - this.config.openStart;
      openRatio = Math.max(0, Math.min(1, (frame - this.config.openStart) / range));
    } else if (phase === 'fullOpen') {
      openRatio = 1;
    } else if (phase === 'closing') {
      const range = this.config.closeEnd - this.config.passEnd;
      openRatio = Math.max(0, Math.min(1, 1 - (frame - this.config.passEnd) / range));
    }

    // 門洞矩形：從鉸鏈側展開
    const currentWidth = this.doorWorldWidth * openRatio;
    if (currentWidth <= 0.001) {
      this.doorMesh.visible = false;
      return phase;
    }

    const currentHeight = this.doorWorldHeight;

    // 鉸鏈在左 → 矩形左邊固定，右邊擴展
    // 鉸鏈在右 → 矩形右邊固定，左邊擴展
    let centerX: number;
    if (this.hingeSide === 'left') {
      const leftEdge = this.doorWorldX - this.doorWorldWidth / 2;
      centerX = leftEdge + currentWidth / 2;
    } else {
      const rightEdge = this.doorWorldX + this.doorWorldWidth / 2;
      centerX = rightEdge - currentWidth / 2;
    }

    this.doorMesh.position.set(centerX, this.doorWorldY, this.doorWorldZ);
    this.doorMesh.scale.set(currentWidth, currentHeight, 1);

    return phase;
  }

  /** 根據幀數判定當前階段 */
  private getPhase(frame: number): DoorPhase {
    if (frame < this.config.openStart) return 'preparing';
    if (frame < this.config.openEnd) return 'opening';
    if (frame < this.config.passEnd) return 'fullOpen';
    if (frame < this.config.closeEnd) return 'closing';
    return 'done';
  }

  /** 判定角色是否應在視窗前面（Z 深度切換） */
  isCharacterInFront(animTime: number): boolean {
    const frame = animTime * this.config.fps;
    return frame >= this.config.zSwitchFrame;
  }

  /** 判定是否已進入 done 階段（門關閉完成後） */
  isDone(animTime: number): boolean {
    const frame = animTime * this.config.fps;
    return frame >= this.config.closeEnd;
  }

  /** 是否正在運行 */
  isActive(): boolean {
    return this.active;
  }

  /** 停止門洞效果 */
  stop(): void {
    if (this.doorMesh) {
      this.scene.remove(this.doorMesh);
      this.doorMesh = null;
    }
    if (this.doorGeometry) {
      this.doorGeometry.dispose();
      this.doorGeometry = null;
    }
    if (this.doorMaterial) {
      this.doorMaterial.dispose();
      this.doorMaterial = null;
    }
    this.active = false;
  }

  /** 釋放資源 */
  dispose(): void {
    this.stop();
  }
}
