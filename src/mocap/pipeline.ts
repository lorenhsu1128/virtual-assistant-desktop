/**
 * 影片動捕 — 下游 pipeline 組裝
 *
 * 從 SmplTrack 輸入到 MocapFrame[] 輸出，涵蓋：
 *   1. clamp（SMPL 空間限制）
 *   2. SMPL → VRM 骨骼映射（含缺失 bone 降級）
 *   3. One Euro 平滑（每 bone 一個 filter instance）
 *   4. 組裝 MocapFrame 陣列
 *
 * 純函式，無 DOM / VRM runtime 依賴，可完整單元測試。
 * 呼叫端（MocapStudioApp）負責：
 *   - 提供 availableBones（從 VRMController 查詢）
 *   - 收到 MocapFrame[] 後 scrub / 播放
 */

import { clampSmplTrack } from './smpl/applyClamp';
import type { AxisLimits } from './smpl/jointLimits';
import {
  buildSmplToVrmMapping,
  smplFrameToVrmRotations,
} from './smpl/smplToVrm';
import { OneEuroQuaternionFilter, type OneEuroOptions } from './filters/OneEuroFilter';
import type { MocapFrame, SmplTrack, VrmHumanBoneName } from './types';

export interface BuildMocapFramesOptions {
  /** One Euro 濾波器參數；留空使用預設 */
  filter?: OneEuroOptions;
  /** 自訂 SMPL 空間限制；留空使用預設寬鬆限制 */
  clampLimits?: readonly AxisLimits[];
  /** 是否跳過 clamp 步驟（預設 false） */
  skipClamp?: boolean;
  /** 是否跳過 filter 步驟（預設 false） */
  skipFilter?: boolean;
}

/**
 * 將 SmplTrack 轉換為 MocapFrame[]
 *
 * 注意：此函式會 **修改輸入 track**（clamp 為 in-place 操作）。
 * 若要保留原 track，呼叫端應先 deep clone。
 *
 * @param track           SMPL 軌道（會被 in-place clamp）
 * @param availableBones  VRM 模型實際存在的 humanoid bone 集合
 * @param options         可選參數
 * @returns 長度等於 track.frameCount 的 MocapFrame 陣列
 */
export function buildMocapFrames(
  track: SmplTrack,
  availableBones: ReadonlySet<VrmHumanBoneName>,
  options: BuildMocapFramesOptions = {},
): MocapFrame[] {
  // 空軌道直接回傳空陣列
  if (track.frameCount === 0 || track.frames.length === 0) {
    return [];
  }

  // 1. Clamp（in-place）
  if (!options.skipClamp) {
    clampSmplTrack(track, options.clampLimits);
  }

  // 2. 解析 SMPL → VRM 映射（一次性，與 frame 無關）
  const mapping = buildSmplToVrmMapping(availableBones);

  // 3. 準備 per-bone filter（lazy 建立）
  const filters = new Map<VrmHumanBoneName, OneEuroQuaternionFilter>();
  const dtSec = 1 / track.fps;

  // 4. 逐幀轉換
  const result: MocapFrame[] = [];
  for (let i = 0; i < track.frames.length; i++) {
    const smplFrame = track.frames[i];
    const rawRotations = smplFrameToVrmRotations(smplFrame, mapping);

    // 5. Filter：每 bone 一個 instance
    const filteredRotations = options.skipFilter
      ? rawRotations
      : applyFilterToBoneRotations(rawRotations, filters, dtSec, options.filter);

    // 6. 組 MocapFrame
    const transEntry = track.trans[i];
    const hipsWorldPosition =
      transEntry && transEntry.length >= 3
        ? { x: transEntry[0], y: transEntry[1], z: transEntry[2] }
        : null;

    result.push({
      timestampMs: (i / track.fps) * 1000,
      boneRotations: filteredRotations,
      blendShapes: {},
      hipsWorldPosition,
    });
  }

  return result;
}

/**
 * 對單幀的 boneRotations 逐 bone 套用 OneEuroQuaternionFilter
 *
 * filter instance 透過外部 `filters` Map 跨幀維持狀態（lazy 建立）。
 */
function applyFilterToBoneRotations(
  rotations: MocapFrame['boneRotations'],
  filters: Map<VrmHumanBoneName, OneEuroQuaternionFilter>,
  dtSec: number,
  filterOptions: OneEuroOptions | undefined,
): MocapFrame['boneRotations'] {
  const result: MocapFrame['boneRotations'] = {};
  for (const [name, quat] of Object.entries(rotations)) {
    if (!quat) continue;
    const bone = name as VrmHumanBoneName;
    let filter = filters.get(bone);
    if (!filter) {
      filter = new OneEuroQuaternionFilter(filterOptions);
      filters.set(bone, filter);
    }
    result[bone] = filter.filter(quat, dtSec);
  }
  return result;
}
