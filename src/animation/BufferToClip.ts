/**
 * 影片動作轉換器 — CaptureBufferData → THREE.AnimationClip 轉換器
 *
 * 此模組刻意放在 src/animation/ 而非 src/video-converter/，避免
 * AnimationManager 反向依賴 video-converter/。video-converter 反過來
 * import 此檔（plan 第 0 節 Q1 決策）。
 *
 * 對應計畫：video-converter-plan.md 第 2.12 / 7 節 Phase 6
 */

import * as THREE from 'three';
import type { CaptureBufferData, CaptureFrame } from '../video-converter/capture/types';
import type { VRMHumanoidBoneName } from '../video-converter/tracking/boneMapping';
import type { Quat } from '../video-converter/math/Quat';
import type { Vec3 } from '../video-converter/math/Vector';

/**
 * 將 CaptureBufferData 轉為 THREE.AnimationClip。
 *
 * 行為：
 *   - 對每個出現過的骨骼建立一條 QuaternionKeyframeTrack
 *     (`<boneName>.quaternion`)，缺幀的時間點以前一幀的值補上
 *     （carry forward）
 *   - 若 hips translation 在任一幀有值，建立 `hips.position`
 *     VectorKeyframeTrack
 *   - 時間單位：秒（CaptureFrame.timestampMs / 1000）
 *
 * @param data 已 finalize 的 CaptureBufferData
 * @param clipName AnimationClip 名稱
 */
export function bufferToClip(data: CaptureBufferData, clipName: string): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = [];
  const frames = data.frames;

  if (frames.length === 0) {
    return new THREE.AnimationClip(clipName, Math.max(data.duration, 0), tracks);
  }

  // ── Quaternion tracks（每根曾出現過的骨骼一條） ──
  const allBones = new Set<VRMHumanoidBoneName>();
  for (const f of frames) {
    for (const k of Object.keys(f.boneRotations)) {
      allBones.add(k as VRMHumanoidBoneName);
    }
  }

  // 時間基準（最早的時間戳作為 0）
  const t0 = frames[0].timestampMs;
  const toSeconds = (ms: number): number => (ms - t0) / 1000;

  for (const bone of allBones) {
    const times: number[] = [];
    const values: number[] = []; // x,y,z,w 連續儲存
    let last: Quat | null = null;
    for (const f of frames) {
      const q: Quat | null = f.boneRotations[bone] ?? last;
      if (!q) continue; // 該幀之前完全沒值，跳過
      times.push(toSeconds(f.timestampMs));
      values.push(q.x, q.y, q.z, q.w);
      last = q;
    }
    if (times.length > 0) {
      tracks.push(
        new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values)
      );
    }
  }

  // ── Hips position track ──
  const hipsTimes: number[] = [];
  const hipsValues: number[] = [];
  let lastHips: Vec3 | null = null;
  for (const f of frames) {
    const h: Vec3 | null = f.hipsTranslation ?? lastHips;
    if (!h) continue;
    hipsTimes.push(toSeconds(f.timestampMs));
    hipsValues.push(h.x, h.y, h.z);
    lastHips = h;
  }
  if (hipsTimes.length > 0) {
    tracks.push(new THREE.VectorKeyframeTrack('hips.position', hipsTimes, hipsValues));
  }

  // 用 frames 的實際時間長度作為 clip duration（若 data.duration 為 0
  // 則改用 frames 推算的長度）
  const computedDuration = toSeconds(frames[frames.length - 1].timestampMs);
  const duration = data.duration > 0 ? data.duration : computedDuration;

  return new THREE.AnimationClip(clipName, duration, tracks);
}

/** 取得 clip 中所有 quaternion track 的骨骼名稱（測試用 helper） */
export function getQuaternionBoneNames(clip: THREE.AnimationClip): string[] {
  return clip.tracks
    .filter((t) => t.name.endsWith('.quaternion'))
    .map((t) => t.name.replace(/\.quaternion$/, ''));
}

/** 是否包含 hips.position track */
export function hasHipsPositionTrack(clip: THREE.AnimationClip): boolean {
  return clip.tracks.some((t) => t.name === 'hips.position');
}

/** 取出 hips.position track 的引用（若存在） */
export function getHipsPositionTrack(
  clip: THREE.AnimationClip
): THREE.VectorKeyframeTrack | undefined {
  return clip.tracks.find((t) => t.name === 'hips.position') as
    | THREE.VectorKeyframeTrack
    | undefined;
}

// 供測試與後續 Phase 6+ 引用 CaptureFrame 型別
export type { CaptureFrame };
