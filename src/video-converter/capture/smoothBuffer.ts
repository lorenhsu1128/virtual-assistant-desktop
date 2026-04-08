/**
 * 影片動作轉換器 — CaptureBufferData 的離線 Gaussian 平滑 helper
 *
 * 對整份 buffer 做 quaternion-safe Gaussian 平滑：對每根曾出現過的
 * 骨骼抽出完整時序 track、套用 GaussianQuatSmoother、回寫到新的
 * CaptureBufferData。
 *
 * 對應計畫：video-converter-plan.md 第 2.6 / 第 7 節 Phase 11
 *
 * 用途：Stage 2 批次重抽完所有幀後，在寫入 .vad.json / AnimationClip
 * 之前先做一輪全域平滑，消除 MediaPipe 的幀間抖動。
 *
 * **注意**：不對 hipsTranslation 做平滑（目前視覺上不套用，留給未來
 * 需要時擴充）。
 */

import type { Quat } from '../math/Quat';
import { quatIdentity } from '../math/Quat';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';
import type { GaussianQuatSmoother } from '../filters/GaussianQuatSmoother';
import type { CaptureBufferData, CaptureFrame } from './types';

/**
 * 對 CaptureBufferData 做 per-bone Gaussian 平滑，回傳新的 CaptureBufferData。
 *
 * 演算法：
 *   1. 收集所有 frame 中出現過的骨骼名稱
 *   2. 對每根骨骼抽出完整時序 Quat[]（缺幀以前值補上；完全未曾出現
 *      則用 identity 補，但這種情況通常不會發生）
 *   3. 呼叫 smoother.smoothTrack() 取得平滑後序列
 *   4. 用平滑後的 Quat 重組每幀，保留 timestampMs 與 hipsTranslation
 */
export function smoothCaptureBufferData(
  data: CaptureBufferData,
  smoother: GaussianQuatSmoother
): CaptureBufferData {
  if (data.frames.length === 0) {
    return { ...data, frames: [] };
  }

  // 收集所有出現過的 bone
  const boneNames = new Set<VRMHumanoidBoneName>();
  for (const f of data.frames) {
    for (const k of Object.keys(f.boneRotations)) {
      boneNames.add(k as VRMHumanoidBoneName);
    }
  }

  // 每根骨骼抽出時序 track（缺值 carry forward；開頭缺則 identity）
  const smoothedTracks = new Map<VRMHumanoidBoneName, Quat[]>();
  const identity = quatIdentity();
  for (const bone of boneNames) {
    const raw: Quat[] = [];
    let last: Quat | null = null;
    for (const f of data.frames) {
      const q: Quat | null = f.boneRotations[bone] ?? last;
      if (q) {
        raw.push(q);
        last = q;
      } else {
        raw.push(identity);
      }
    }
    smoothedTracks.set(bone, smoother.smoothTrack(raw));
  }

  // 回寫成新 frames
  const newFrames: CaptureFrame[] = data.frames.map((f, i) => {
    const rotations: Partial<Record<VRMHumanoidBoneName, Quat>> = {};
    for (const [bone, track] of smoothedTracks) {
      rotations[bone] = track[i];
    }
    return {
      timestampMs: f.timestampMs,
      hipsTranslation: f.hipsTranslation
        ? { ...f.hipsTranslation }
        : null,
      boneRotations: rotations,
    };
  });

  return {
    fps: data.fps,
    duration: data.duration,
    frames: newFrames,
  };
}
