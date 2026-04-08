/**
 * 影片動作轉換器 — .vad.json (Video Animation Data) 寫入器
 *
 * 把 CaptureBufferData 序列化為 JSON 字串，供 electron IPC 寫入到
 * ~/.virtual-assistant-desktop/user-vrma/<name>.vad.json
 *
 * 對應計畫：video-converter-plan.md 第 2.8 / 7 節 Phase 12
 *
 * 格式 v1（緊湊版）：
 *   {
 *     "version": 1,
 *     "metadata": { fps, duration, createdAt, frameCount },
 *     "frames": [
 *       { "t": <timestampMs>, "h": [x,y,z]|null, "b": { "bone": [x,y,z,w], ... } }
 *     ]
 *   }
 */

import type { CaptureBufferData, CaptureFrame } from '../capture/types';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';

export const VAD_JSON_VERSION = 1 as const;

export interface VadJsonMetadata {
  fps: number;
  duration: number;
  createdAt: string;
  frameCount: number;
}

export interface VadJsonFrame {
  t: number;
  h: [number, number, number] | null;
  b: Record<string, [number, number, number, number]>;
}

export interface VadJsonV1 {
  version: typeof VAD_JSON_VERSION;
  metadata: VadJsonMetadata;
  frames: VadJsonFrame[];
}

/** 把 CaptureBufferData 序列化為 .vad.json 字串 */
export function serializeToVadJson(
  data: CaptureBufferData,
  opts: { createdAt?: string } = {}
): string {
  const obj = toVadJsonObject(data, opts);
  return JSON.stringify(obj);
}

/** 建構 VadJsonV1 物件（便於測試） */
export function toVadJsonObject(
  data: CaptureBufferData,
  opts: { createdAt?: string } = {}
): VadJsonV1 {
  return {
    version: VAD_JSON_VERSION,
    metadata: {
      fps: data.fps,
      duration: data.duration,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      frameCount: data.frames.length,
    },
    frames: data.frames.map(frameToJson),
  };
}

function frameToJson(f: CaptureFrame): VadJsonFrame {
  const bones: Record<string, [number, number, number, number]> = {};
  for (const [name, q] of Object.entries(f.boneRotations)) {
    if (!q) continue;
    bones[name] = [q.x, q.y, q.z, q.w];
  }
  return {
    t: f.timestampMs,
    h: f.hipsTranslation
      ? [f.hipsTranslation.x, f.hipsTranslation.y, f.hipsTranslation.z]
      : null,
    b: bones,
  };
}

export type { VRMHumanoidBoneName };
