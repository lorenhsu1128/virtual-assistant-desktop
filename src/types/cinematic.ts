/**
 * 演出系統型別定義（搞笑撞玻璃版）
 *
 * CinematicRunner 的輸入配置與每幀輸出資料結構。
 *
 * 重新設計後的時間軸：
 *   anticipate    — 蓄力後撤
 *   approach-top  — 衝向螢幕頂部正中央
 *   pause-top     — 在頂部短暫定格、轉身朝下
 *   dash-down     — 從頂部暴衝向下、scale 暴漲、鏡頭推進
 *   impact        — 撞擊瞬間 squash + 鏡頭震動
 *   settle        — squash 彈性還原
 *   hold          — 大臉停留 + 表情輪換
 *   recoil        — 從玻璃彈回
 *   retreat       — 轉身跑回原位
 *   done          — 演出結束
 */

/** 演出階段 */
export type CinematicPhase =
  | 'anticipate'
  | 'approach-top'
  | 'pause-top'
  | 'dash-down'
  | 'impact'
  | 'settle'
  | 'hold'
  | 'recoil'
  | 'retreat'
  | 'done';

/** CinematicRunner 每幀輸出 */
export interface CinematicframeBase {
  /** 當前階段 */
  phase: CinematicPhase;
}

/** CinematicRunner 每幀輸出（完整） */
export interface CinematicFrame {
  /** 模型 X 軸 scale 倍率（相對於使用者設定的 scale；squash 用） */
  scaleX: number;
  /** 模型 Y 軸 scale 倍率 */
  scaleY: number;
  /** 模型 Z 軸 scale 倍率 */
  scaleZ: number;
  /** 螢幕 X 座標（像素） */
  positionX: number;
  /** 螢幕 Y 座標（像素，腳底基準） */
  positionY: number;
  /** 模型 Y 軸旋轉（弧度）。0 = 面向鏡頭，π = 背對鏡頭，允許連續插值用於轉身 */
  facingRotationY: number;
  /** walk 動畫速率倍率（1.0 = 正常，0 = 暫停） */
  walkSpeed: number;
  /** 攝影機 zoom 倍率：1.0 = 預設可見區域；> 1.0 = 縮小可見區域（推進感） */
  cameraZoom: number;
  /** 攝影機震動 X 偏移（像素） */
  cameraShakeX: number;
  /** 攝影機震動 Y 偏移（像素） */
  cameraShakeY: number;
  /** 當前階段 */
  phase: CinematicPhase;
  /** 要套用的表情名稱（null = 清除表情） */
  expression: string | null;
  /** 是否需要呼叫 SpringBone reset（避免大幅 scale 變化造成彈跳） */
  springBoneReset: boolean;
}

/** CinematicRunner 建構配置 */
export interface CinematicConfig {
  /** 螢幕寬度（像素） */
  screenWidth: number;
  /** 螢幕高度（像素） */
  screenHeight: number;
  /** 角色 bounding box 寬度（像素，base scale 下） */
  characterWidth: number;
  /** 角色 bounding box 高度（像素，base scale 下） */
  characterHeight: number;
  /** 演出前角色位置（腳底） */
  originalPosition: { x: number; y: number };
  /** 演出前使用者 scale 值 */
  originalScale: number;
  /** 可用表情名稱清單（hold 階段隨機選取） */
  availableExpressions: string[];
  /** 期望的最大 scale（會被安全邊界 clamp） */
  desiredMaxScale?: number;
  /** 角色頭部高度佔 bbox 的比例（預設 0.22） */
  headHeightRatio?: number;
  /** 頭頂安全邊距（像素，預設 24） */
  topPadding?: number;
  /** 面部底安全邊距（像素，預設 16） */
  bottomPadding?: number;
  /** 最終定格時面部中心在螢幕高度的比例（預設 0.7） */
  targetFaceCenterRatio?: number;
}

/**
 * solveFinalPose 輸出
 *
 * 解出的最終定格 scale 與「視覺頭頂 Y」，保證頭部完全在螢幕下半部。
 *
 * 注意：finalVisualHeadY 是視覺上頭頂在螢幕的 Y 座標（像素，0 = 螢幕頂）。
 * 將其轉成 SceneManager 用的 currentPosition.y 必須透過
 *   positionForVisualHead(visualHeadY, scale, characterHeight, originalScale)
 * 因為 currentPosition.y 是 bbox 左上角，且 SceneManager 用的是「演出前快取的
 * characterSize」與當前 frame.scale 的比例做計算。
 */
export interface FinalPoseSolution {
  /** 實際使用的最大 scale（可能小於 desiredMaxScale 以避免超出螢幕） */
  maxScale: number;
  /** 最終視覺頭頂 Y 座標（像素） */
  finalVisualHeadY: number;
  /** 最終 X 座標（螢幕水平置中） */
  finalPosX: number;
}
