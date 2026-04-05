import * as THREE from 'three';
import type { WindowRect } from '../types/window';

/** 遮擋 mesh 的 debug 資訊 */
export interface OcclusionMeshDebugEntry {
  title: string;
  width: number;
  height: number;
  meshZ: number;
}

/** mesh 內部記錄 */
interface MeshRecord {
  mesh: THREE.Mesh;
  meshZ: number;
  rect: WindowRect;
}

/**
 * ���窗深度 Mesh 管理器
 *
 * 為每個桌面視窗建立不可見的平面 mesh（colorWrite:false, depthWrite:true），
 * 利用 GPU depth test 自然遮擋 VRM 模型，取代 SetWindowRgn 裁切。
 */
export class WindowMeshManager {
  /** Z 軸常數 */
  private static readonly Z_TOP = 9.0;
  private static readonly Z_BOTTOM = 1.0;

  private readonly meshMap = new Map<number, MeshRecord>();
  private readonly scene: THREE.Scene;
  private readonly pixelToWorld: number;
  private readonly screenOriginX: number;
  private readonly screenOriginY: number;
  private readonly canvasW: number;
  private readonly canvasH: number;

  /** 共用 geometry 和 material（所有 mesh 共用，減少 GPU 資源） */
  private readonly sharedGeometry: THREE.PlaneGeometry;
  private readonly sharedMaterial: THREE.MeshBasicMaterial;

  constructor(
    scene: THREE.Scene,
    pixelToWorld: number,
    screenOrigin: { x: number; y: number },
    canvasWidth: number,
    canvasHeight: number,
  ) {
    this.scene = scene;
    this.pixelToWorld = pixelToWorld;
    this.screenOriginX = screenOrigin.x;
    this.screenOriginY = screenOrigin.y;
    this.canvasW = canvasWidth;
    this.canvasH = canvasHeight;

    this.sharedGeometry = new THREE.PlaneGeometry(1, 1);
    this.sharedMaterial = new THREE.MeshBasicMaterial({
      colorWrite: false,
      depthWrite: true,
      side: THREE.DoubleSide,
    });
  }

  /**
   * 同步視窗 mesh（由 window_layout_changed 事件觸發）
   *
   * 建立/移除/更新 mesh 的 position、scale、Z 值。
   */
  syncWindows(windowRects: WindowRect[]): void {
    const maxZOrder = windowRects.reduce((max, w) => Math.max(max, w.zOrder), 0);
    const dpr = window.devicePixelRatio;
    const currentHwnds = new Set<number>();

    for (const rect of windowRects) {
      currentHwnds.add(rect.hwnd);
      const meshZ = this.calcMeshZ(rect.zOrder, maxZOrder);
      const existing = this.meshMap.get(rect.hwnd);

      if (existing) {
        // 更新既有 mesh
        this.positionMesh(existing.mesh, rect, meshZ, dpr);
        existing.meshZ = meshZ;
        existing.rect = rect;
      } else {
        // 建立新 mesh
        const mesh = new THREE.Mesh(this.sharedGeometry, this.sharedMaterial);
        mesh.name = `occluder:${rect.hwnd}`;
        mesh.renderOrder = -1;
        this.positionMesh(mesh, rect, meshZ, dpr);
        this.scene.add(mesh);
        this.meshMap.set(rect.hwnd, { mesh, meshZ, rect });
      }
    }

    // 移除已消失的視窗 mesh
    for (const [hwnd, record] of this.meshMap) {
      if (!currentHwnds.has(hwnd)) {
        this.scene.remove(record.mesh);
        this.meshMap.delete(hwnd);
      }
    }
  }

  /** 取得指定視窗的 mesh Z 值 */
  getWindowZ(hwnd: number): number | null {
    return this.meshMap.get(hwnd)?.meshZ ?? null;
  }

  /** 取得 debug 資訊 */
  getDebugInfo(): OcclusionMeshDebugEntry[] {
    const entries: OcclusionMeshDebugEntry[] = [];
    const dpr = window.devicePixelRatio;
    for (const record of this.meshMap.values()) {
      entries.push({
        title: record.rect.title,
        width: Math.round(record.rect.width / dpr),
        height: Math.round(record.rect.height / dpr),
        meshZ: record.meshZ,
      });
    }
    // 依 Z 值降序排列（最上層在前）
    entries.sort((a, b) => b.meshZ - a.meshZ);
    return entries;
  }

  /** 清除所有 mesh 並釋放資源 */
  dispose(): void {
    for (const record of this.meshMap.values()) {
      this.scene.remove(record.mesh);
    }
    this.meshMap.clear();
    this.sharedGeometry.dispose();
    this.sharedMaterial.dispose();
  }

  /**
   * 計算正規化 Z 值
   *
   * zOrder=0（最上層）→ Z=9.0，zOrder=max（最下層）→ Z=1.0
   */
  private calcMeshZ(zOrder: number, maxZOrder: number): number {
    if (maxZOrder === 0) return WindowMeshManager.Z_TOP;
    const ratio = zOrder / maxZOrder;
    return WindowMeshManager.Z_BOTTOM + (1 - ratio) * (WindowMeshManager.Z_TOP - WindowMeshManager.Z_BOTTOM);
  }

  /** 設定 mesh 的 position 和 scale */
  private positionMesh(mesh: THREE.Mesh, rect: WindowRect, meshZ: number, dpr: number): void {
    // 物理像素 → 邏輯像素 → 相對於角色視窗 → 3D 世界座標
    const relX = rect.x / dpr - this.screenOriginX;
    const relY = rect.y / dpr - this.screenOriginY;
    const w = rect.width / dpr;
    const h = rect.height / dpr;

    const centerCanvasX = relX + w / 2;
    const centerCanvasY = relY + h / 2;
    const worldX = (centerCanvasX - this.canvasW / 2) * this.pixelToWorld;
    const worldY = (this.canvasH - centerCanvasY) * this.pixelToWorld;

    mesh.position.set(worldX, worldY, meshZ);
    mesh.scale.set(w * this.pixelToWorld, h * this.pixelToWorld, 1);
  }
}
