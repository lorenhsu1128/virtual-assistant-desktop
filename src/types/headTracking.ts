/**
 * 滑鼠頭部追蹤 — 共用型別
 *
 * 設計目標：眼睛 → 頭 → 上身的人體工學連動。
 * 三層各自限幅與平滑速率，避免單一骨骼大角度旋轉造成「折斷」視感。
 */

/** 全螢幕游標座標（邏輯像素，由 main process 推送） */
export interface CursorScreenPosition {
  x: number;
  y: number;
}

/** 各骨骼的人體工學旋轉範圍（弧度） */
export interface BoneClampRange {
  /** Yaw（左右轉，繞 Y 軸）最大角度 */
  yawMax: number;
  /** Pitch（俯仰，繞 X 軸）最大角度 */
  pitchMax: number;
  /** Roll（側傾，繞 Z 軸）最大角度 */
  rollMax: number;
}

/** Head tracking 設定 */
export interface HeadTrackingConfig {
  /** 主開關 */
  enabled: boolean;
  /**
   * 與動畫 quaternion 的混合權重（0..1）
   * 0 = 完全跟動畫；1 = 完全跟追蹤
   * 預設 0.7：保留動畫風味又確保看向滑鼠
   */
  weight: number;
  /**
   * 目標座標平滑速率（per second）
   * 越大越快收斂；建議 6–18
   */
  smoothingRate: number;
}

/**
 * 預設限幅範圍（弧度）
 *
 * 三層加總的「總可達角度」≈ 8 + 22 + 35 = 65°（落在 45–70° 範圍）
 * 確保滑鼠移到角色背後時，臉仍部分可見、不會把後腦杓對著鏡頭。
 */
export const DEFAULT_CLAMP_RANGES: Record<'upperChest' | 'neck' | 'head', BoneClampRange> = {
  upperChest: { yawMax: degToRad(12), pitchMax: degToRad(8), rollMax: degToRad(6) },
  neck: { yawMax: degToRad(28), pitchMax: degToRad(18), rollMax: degToRad(12) },
  head: { yawMax: degToRad(42), pitchMax: degToRad(26), rollMax: degToRad(16) },
};

/** 預設 HeadTrackingConfig */
export const DEFAULT_HEAD_TRACKING_CONFIG: HeadTrackingConfig = {
  enabled: true,
  weight: 0.7,
  smoothingRate: 12,
};

function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}
