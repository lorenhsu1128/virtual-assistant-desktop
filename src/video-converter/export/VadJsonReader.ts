/**
 * 影片動作轉換器 — .vad.json 讀取器
 *
 * 解析 .vad.json 字串為 CaptureBufferData，供主視窗 AnimationManager
 * 透過 BufferToClip 轉為 THREE.AnimationClip 播放。
 *
 * 對應計畫：video-converter-plan.md 第 2.8 / 7 節 Phase 12
 */

import type { CaptureBufferData, CaptureFrame } from '../capture/types';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';
import type { Quat } from '../math/Quat';
import type { Vec3 } from '../math/Vector';
import { VAD_JSON_VERSION, type VadJsonV1, type VadJsonFrame } from './VadJsonWriter';

export class VadJsonParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VadJsonParseError';
  }
}

/** 解析 .vad.json 字串為 CaptureBufferData */
export function parseVadJson(text: string): CaptureBufferData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new VadJsonParseError(`JSON parse failed: ${(e as Error).message}`);
  }
  return fromVadJsonObject(raw);
}

/** 從 JS 物件轉為 CaptureBufferData（不解析 JSON，便於測試） */
export function fromVadJsonObject(raw: unknown): CaptureBufferData {
  if (!raw || typeof raw !== 'object') {
    throw new VadJsonParseError('Not an object');
  }
  const obj = raw as Partial<VadJsonV1>;
  if (obj.version !== VAD_JSON_VERSION) {
    throw new VadJsonParseError(
      `Unsupported version: ${obj.version} (expected ${VAD_JSON_VERSION})`
    );
  }
  if (!obj.metadata || typeof obj.metadata !== 'object') {
    throw new VadJsonParseError('Missing metadata');
  }
  if (!Array.isArray(obj.frames)) {
    throw new VadJsonParseError('frames must be array');
  }

  const frames: CaptureFrame[] = obj.frames.map((f, i) => frameFromJson(f, i));

  return {
    fps: obj.metadata.fps ?? 30,
    duration: obj.metadata.duration ?? 0,
    frames,
  };
}

function frameFromJson(f: VadJsonFrame, index: number): CaptureFrame {
  if (typeof f.t !== 'number') {
    throw new VadJsonParseError(`frame[${index}]: missing t`);
  }
  let hips: Vec3 | null = null;
  if (Array.isArray(f.h) && f.h.length === 3) {
    hips = { x: f.h[0], y: f.h[1], z: f.h[2] };
  }

  const bones: Partial<Record<VRMHumanoidBoneName, Quat>> = {};
  if (f.b && typeof f.b === 'object') {
    for (const [name, arr] of Object.entries(f.b)) {
      if (!Array.isArray(arr) || arr.length !== 4) continue;
      bones[name as VRMHumanoidBoneName] = {
        x: arr[0],
        y: arr[1],
        z: arr[2],
        w: arr[3],
      };
    }
  }

  return {
    timestampMs: f.t,
    hipsTranslation: hips,
    boneRotations: bones,
  };
}
