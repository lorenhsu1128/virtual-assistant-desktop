/**
 * 影片動作轉換器 — CaptureBuffer
 *
 * Stage 1 即時擷取的緩衝區。push 接收 SolverPose 結果，clear 重置，
 * sampleAt 提供時間軸 scrub 用的線性插值，finalize 凍結成可序列化的
 * CaptureBufferData。
 *
 * 對應計畫：video-converter-plan.md 第 2.7 節
 */

import type { Quat } from '../math/Quat';
import { quatSlerp, quatEnsureShortestPath } from '../math/Quat';
import { lerpV } from '../math/Vector';
import type { Vec3 } from '../math/Vector';
import type { VRMHumanoidBoneName } from '../tracking/boneMapping';
import type { CaptureFrame, CaptureBufferData } from './types';

export class CaptureBuffer {
  private _frames: CaptureFrame[] = [];

  /** 加入一幀（時間戳必須遞增；不檢查以保留呼叫端彈性） */
  push(frame: CaptureFrame): void {
    this._frames.push(frame);
  }

  /** 清空緩衝區 */
  clear(): void {
    this._frames = [];
  }

  /** 唯讀的目前幀陣列 */
  get frames(): readonly CaptureFrame[] {
    return this._frames;
  }

  get length(): number {
    return this._frames.length;
  }

  /**
   * 在時間戳 t（毫秒）處取樣。在兩個相鄰幀之間做：
   *   - hipsTranslation：線性內插
   *   - boneRotations：quaternion-safe slerp
   *
   * - t 早於第一幀 → 回傳第一幀的拷貝
   * - t 晚於最後一幀 → 回傳最後一幀的拷貝
   * - 緩衝為空 → null
   */
  sampleAt(t: number): CaptureFrame | null {
    const n = this._frames.length;
    if (n === 0) return null;
    if (n === 1 || t <= this._frames[0].timestampMs) {
      return cloneFrame(this._frames[0]);
    }
    if (t >= this._frames[n - 1].timestampMs) {
      return cloneFrame(this._frames[n - 1]);
    }

    // 二分搜：找到 frames[i].timestampMs <= t < frames[i+1].timestampMs
    let lo = 0;
    let hi = n - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (this._frames[mid].timestampMs <= t) lo = mid;
      else hi = mid;
    }
    const a = this._frames[lo];
    const b = this._frames[hi];
    const span = b.timestampMs - a.timestampMs;
    const u = span > 0 ? (t - a.timestampMs) / span : 0;

    // hipsTranslation 線性
    let hips: Vec3 | null = null;
    if (a.hipsTranslation && b.hipsTranslation) {
      hips = lerpV(a.hipsTranslation, b.hipsTranslation, u);
    } else {
      hips = a.hipsTranslation ?? b.hipsTranslation ?? null;
    }

    // boneRotations slerp（取兩幀皆有的骨骼）
    const rotations: Partial<Record<VRMHumanoidBoneName, Quat>> = {};
    const allBones = new Set<string>([
      ...Object.keys(a.boneRotations),
      ...Object.keys(b.boneRotations),
    ]);
    for (const bone of allBones) {
      const qa = a.boneRotations[bone as VRMHumanoidBoneName];
      const qb = b.boneRotations[bone as VRMHumanoidBoneName];
      if (qa && qb) {
        const qbAligned = quatEnsureShortestPath(qa, qb);
        rotations[bone as VRMHumanoidBoneName] = quatSlerp(qa, qbAligned, u);
      } else if (qa) {
        rotations[bone as VRMHumanoidBoneName] = { ...qa };
      } else if (qb) {
        rotations[bone as VRMHumanoidBoneName] = { ...qb };
      }
    }

    return { timestampMs: t, hipsTranslation: hips, boneRotations: rotations };
  }

  /**
   * 凍結為 CaptureBufferData（供 .vad.json 序列化或 BufferToClip 轉換）。
   *
   * @param fps 標稱幀率（純資訊欄位，不影響 frames 內容）
   */
  finalize(fps: number): CaptureBufferData {
    const n = this._frames.length;
    const duration =
      n === 0
        ? 0
        : (this._frames[n - 1].timestampMs - this._frames[0].timestampMs) / 1000;
    return {
      fps,
      duration,
      frames: this._frames.map(cloneFrame),
    };
  }
}

function cloneFrame(f: CaptureFrame): CaptureFrame {
  return {
    timestampMs: f.timestampMs,
    hipsTranslation: f.hipsTranslation ? { ...f.hipsTranslation } : null,
    boneRotations: { ...f.boneRotations },
  };
}
