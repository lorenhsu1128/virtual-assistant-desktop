import * as THREE from 'three';
import { ipc } from '../bridge/ElectronIPC';

/**
 * 滑鼠游標追蹤器
 *
 * 訂閱 main process 推送的全螢幕游標位置（~60Hz），維護
 * 平滑後的目標世界座標（3D Vector3，z=0 平面），供
 * HeadTrackingController 使用。
 *
 * 使用指數平滑（exp(-rate * dt) lerp），不會在 hover 不動時抖動。
 * 取消訂閱請呼叫 dispose()。
 */
export class MouseCursorTracker {
  /** 最新一次收到的游標螢幕座標（邏輯像素） */
  private rawScreen = { x: 0, y: 0 };
  /** 是否曾收到至少一次游標事件 */
  private hasRawData = false;
  /** 平滑後的目標世界座標（每幀供 HeadTrackingController 讀取） */
  private smoothedTarget = new THREE.Vector3();
  private smoothedValid = false;
  /** 平滑速率（per second） */
  private smoothingRate: number;
  private unlisten: (() => void) | null = null;

  constructor(smoothingRate = 4) {
    this.smoothingRate = smoothingRate;
    this.unlisten = ipc.onCursorPosition((pos) => {
      this.rawScreen.x = pos.x;
      this.rawScreen.y = pos.y;
      this.hasRawData = true;
    });
  }

  /** 設定平滑速率（per second），可動態調整 */
  setSmoothingRate(rate: number): void {
    this.smoothingRate = rate;
  }

  /** 是否已有游標資料可用 */
  isReady(): boolean {
    return this.hasRawData;
  }

  /** 取得最新的游標螢幕座標（邏輯像素） */
  getRawScreen(): { x: number; y: number } {
    return { x: this.rawScreen.x, y: this.rawScreen.y };
  }

  /**
   * 每幀更新平滑目標位置。
   *
   * @param desiredWorld 由呼叫端計算的「滑鼠對應世界座標」目標點（單位：Three.js world）
   * @param deltaTime 幀間隔（秒）
   * @returns 平滑後的目標位置（內部 Vector3 reference，呼叫端不應修改）
   */
  update(desiredWorld: THREE.Vector3, deltaTime: number): THREE.Vector3 {
    if (!this.smoothedValid) {
      this.smoothedTarget.copy(desiredWorld);
      this.smoothedValid = true;
      return this.smoothedTarget;
    }
    const factor = 1 - Math.exp(-this.smoothingRate * deltaTime);
    this.smoothedTarget.lerp(desiredWorld, factor);
    return this.smoothedTarget;
  }

  /** 直接強制設定平滑目標位置（停用追蹤時用來重置） */
  forceTarget(world: THREE.Vector3): void {
    this.smoothedTarget.copy(world);
    this.smoothedValid = true;
  }

  /** 取得當前平滑目標（reference） */
  getSmoothedTarget(): THREE.Vector3 {
    return this.smoothedTarget;
  }

  /** 取消 IPC 訂閱 */
  dispose(): void {
    if (this.unlisten) {
      this.unlisten();
      this.unlisten = null;
    }
  }
}
