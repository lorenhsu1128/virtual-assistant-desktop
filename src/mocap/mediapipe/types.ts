/**
 * MediaPipe Pose Landmarker 型別定義
 *
 * 封裝 @mediapipe/tasks-vision 的 PoseLandmarkerResult，
 * 讓下游模組不必直接 import @mediapipe/tasks-vision 的型別。
 *
 * 33 個 landmark 索引定義參考 MediaPipe 官方：
 * https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker#models
 */

/** 單一關鍵點（2D normalized 或 3D world 座標） */
export interface PoseLandmark {
  /** 正規化座標（image landmarks：[0,1]，world landmarks：世界座標公尺） */
  x: number;
  y: number;
  z: number;
  /** 可見度 [0,1]；< 0.5 通常代表被遮擋或在畫面外 */
  visibility: number;
}

/**
 * MediaPipe Pose Landmarker 單一幀的偵測結果
 */
export interface PoseLandmarks {
  /** 影像空間正規化 2D 座標（供 2D 骨架 overlay 使用） */
  image: PoseLandmark[];
  /** 世界空間 3D 座標（以 hip 中心為原點的公尺單位，供 IK 使用） */
  world: PoseLandmark[];
}

/** MediaPipe 33 點的骨架連線定義（POSE_CONNECTIONS） */
export const POSE_CONNECTIONS: readonly (readonly [number, number])[] = [
  // Face
  [0, 1], [1, 2], [2, 3], [3, 7],
  [0, 4], [4, 5], [5, 6], [6, 8],
  [9, 10],
  // Upper body
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  // Hands
  [15, 17], [17, 19], [19, 15], [15, 21],
  [16, 18], [18, 20], [20, 16], [16, 22],
  // Torso
  [11, 23], [12, 24], [23, 24],
  // Legs
  [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
  [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
];

/** 33 個 MediaPipe pose landmark 的語意名稱（供 debug / log 使用） */
export const POSE_LANDMARK_NAMES = [
  'nose',            // 0
  'leftEyeInner',    // 1
  'leftEye',         // 2
  'leftEyeOuter',    // 3
  'rightEyeInner',   // 4
  'rightEye',        // 5
  'rightEyeOuter',   // 6
  'leftEar',         // 7
  'rightEar',        // 8
  'mouthLeft',       // 9
  'mouthRight',      // 10
  'leftShoulder',    // 11
  'rightShoulder',   // 12
  'leftElbow',       // 13
  'rightElbow',      // 14
  'leftWrist',       // 15
  'rightWrist',      // 16
  'leftPinky',       // 17
  'rightPinky',      // 18
  'leftIndex',       // 19
  'rightIndex',      // 20
  'leftThumb',       // 21
  'rightThumb',      // 22
  'leftHip',         // 23
  'rightHip',        // 24
  'leftKnee',        // 25
  'rightKnee',       // 26
  'leftAnkle',       // 27
  'rightAnkle',      // 28
  'leftHeel',        // 29
  'rightHeel',       // 30
  'leftFootIndex',   // 31
  'rightFootIndex',  // 32
] as const;

export const POSE_LANDMARK_COUNT = 33;
