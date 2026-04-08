/**
 * 影片動作轉換器 — CaptureBuffer 共用型別
 *
 * 對應計畫：video-converter-plan.md 第 2.7 節
 */

import type { Quat } from '../math/Quat';
import type { Vec3 } from '../math/Vector';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';

/**
 * 單一幀的擷取結果（Stage 1 即時擷取或 Stage 2 重抽後的單筆）。
 *
 * - timestampMs：相對影片開始的時間（毫秒）
 * - hipsTranslation：髖部世界座標位置（公尺，可為 null 表示該幀未解出）
 * - boneRotations：各骨骼相對父骨骼的 local rotation（partial — 缺席
 *   的骨骼由 BufferToClip 用前一幀的值補上）
 */
export interface CaptureFrame {
  timestampMs: number;
  hipsTranslation: Vec3 | null;
  boneRotations: Partial<Record<VRMHumanoidBoneName, Quat>>;
}

/**
 * 完成擷取後的整段資料。
 *
 * - fps：標稱幀率（用於序列化與 .vad.json metadata）
 * - duration：總時長（秒）
 * - frames：依時間戳遞增排序的幀陣列
 */
export interface CaptureBufferData {
  fps: number;
  duration: number;
  frames: CaptureFrame[];
}
