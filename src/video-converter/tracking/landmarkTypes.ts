/**
 * 影片動作轉換器 — MediaPipe Landmark 型別與索引常數
 *
 * 對應 MediaPipe Tasks Vision 的 HolisticLandmarker 輸出格式。
 * 索引常數依官方規格定義，用於 PoseSolver / HandSolver / EyeGazeSolver
 * 取用特定 landmark。
 *
 * 對應計畫：video-converter-plan.md 第 2.3 節
 */

/**
 * 單一 landmark 點。
 *
 * - x, y：normalized to [0, 1] image coordinates（worldLandmarks 為公尺）
 * - z：相對深度（pose）或公尺（worldLandmarks）
 * - visibility：偵測信心 [0, 1]（pose only，hand / face 沒有此欄位）
 */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/**
 * MediaPipe Pose Landmarker 33 個身體 landmark 索引。
 *
 * https://developers.google.com/mediapipe/solutions/vision/pose_landmarker
 */
export const POSE = {
  NOSE: 0,
  LEFT_EYE_INNER: 1,
  LEFT_EYE: 2,
  LEFT_EYE_OUTER: 3,
  RIGHT_EYE_INNER: 4,
  RIGHT_EYE: 5,
  RIGHT_EYE_OUTER: 6,
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  MOUTH_LEFT: 9,
  MOUTH_RIGHT: 10,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
  LEFT_THUMB: 21,
  RIGHT_THUMB: 22,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;

/** Pose landmark 總點數 */
export const POSE_LANDMARK_COUNT = 33;

/**
 * MediaPipe Hand Landmarker 21 個手部 landmark 索引（單手）。
 *
 * 從手腕（0）到拇指尖端（4），到小指尖端（20）。
 * 每根手指由 4 個點組成（含尖端），共 5 指 × 4 + wrist = 21。
 *
 * https://developers.google.com/mediapipe/solutions/vision/hand_landmarker
 */
export const HAND = {
  WRIST: 0,
  // Thumb（拇指）
  THUMB_CMC: 1, // 腕掌關節
  THUMB_MCP: 2, // 掌指關節
  THUMB_IP: 3, // 指間關節
  THUMB_TIP: 4,
  // Index（食指）
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  // Middle（中指）
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  // Ring（無名指）
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  // Pinky（小指）
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

/** Hand landmark 總點數（單手） */
export const HAND_LANDMARK_COUNT = 21;

/**
 * MediaPipe Face Landmarker 478 個臉部 landmark 索引（含 iris）。
 *
 * 0–467：face mesh
 * 468–472：left iris (5 點)
 * 473–477：right iris (5 點)
 *
 * 此處只列出 EyeGazeSolver 需要的關鍵點，其他在 solver 內就近 hard-code。
 */
export const FACE = {
  // 眼角（用於計算眼眶寬度）
  LEFT_EYE_INNER_CORNER: 133,
  LEFT_EYE_OUTER_CORNER: 33,
  RIGHT_EYE_INNER_CORNER: 362,
  RIGHT_EYE_OUTER_CORNER: 263,
  // 眼瞼（用於計算眼眶高度）
  LEFT_EYE_TOP: 159,
  LEFT_EYE_BOTTOM: 145,
  RIGHT_EYE_TOP: 386,
  RIGHT_EYE_BOTTOM: 374,
  // 虹膜中心
  LEFT_IRIS_CENTER: 468,
  RIGHT_IRIS_CENTER: 473,
} as const;

/** Face landmark 總點數（含 iris） */
export const FACE_LANDMARK_COUNT = 478;

/**
 * HolisticLandmarker 的完整單幀偵測結果。
 *
 * 對應 MediaPipeRunner.detect() 的回傳型別（Phase 7 實作）。
 * 任一群組可能為空（偵測失敗或視野外）— 呼叫端必須檢查長度。
 */
export interface HolisticResult {
  /** 螢幕座標 pose（normalized [0,1]）*/
  poseLandmarks: Landmark[];
  /** 公尺座標 pose（用於 BodySolver） */
  poseWorldLandmarks: Landmark[];
  leftHandLandmarks: Landmark[];
  rightHandLandmarks: Landmark[];
  faceLandmarks: Landmark[];
  /** 偵測時間戳（毫秒）*/
  timestampMs: number;
}
