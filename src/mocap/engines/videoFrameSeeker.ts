/**
 * HTMLVideoElement 的 Promise-based seek 工具（Phase 5d）
 *
 * 用途：批次動捕時需要「seek 到時間點 → 等待解碼完成 → 抓 frame」的序列流程。
 * 瀏覽器的 `currentTime =` 是非同步且要等 `seeked` 事件才代表該幀準備好。
 *
 * 模組邊界：
 *   - DOM 依賴：HTMLVideoElement / Event / setTimeout
 *   - 不依賴 Three.js / VRM / MediaPipe，純 DOM 工具
 *   - 可注入 fake video element 進行單元測試
 */

/** HTMLVideoElement 能被 fake 測試用的最小介面 */
export interface SeekableVideo {
  currentTime: number;
  readonly readyState: number;
  addEventListener(type: 'seeked', listener: () => void): void;
  removeEventListener(type: 'seeked', listener: () => void): void;
}

/** 預設 seek timeout（毫秒） */
export const DEFAULT_SEEK_TIMEOUT_MS = 500;

/** seek 到目標時間點的最小差異（秒）— 小於此值視為「已在該位置」 */
const EPSILON_SEC = 0.001;

/**
 * 把 video 的 currentTime 設為 `timeSec` 並等待 'seeked' 事件
 *
 * @param video        目標 video 元素
 * @param timeSec      目標時間（秒）
 * @param timeoutMs    逾時上限（毫秒），預設 500ms；超過視為失敗
 * @throws Error       若逾時未收到 seeked 事件
 *
 * 特殊情況：
 *   - 若當前 currentTime 已在目標 ±EPSILON 內，直接 resolve，不等事件
 *     （避免「已在該位置 → seeked 永不觸發」的 hang）
 *   - timeSec < 0 會被 clamp 到 0
 */
export function seekVideoTo(
  video: SeekableVideo,
  timeSec: number,
  timeoutMs: number = DEFAULT_SEEK_TIMEOUT_MS,
): Promise<void> {
  const target = Math.max(0, timeSec);

  // Fast path：已在目標位置
  if (Math.abs(video.currentTime - target) < EPSILON_SEC) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    let finished = false;
    const onSeeked = (): void => {
      if (finished) return;
      finished = true;
      video.removeEventListener('seeked', onSeeked);
      clearTimeout(timeoutId);
      resolve();
    };
    const timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      video.removeEventListener('seeked', onSeeked);
      reject(new Error(`[videoFrameSeeker] seek timeout after ${timeoutMs}ms (target=${target})`));
    }, timeoutMs);

    video.addEventListener('seeked', onSeeked);
    // 設定後立即返回；'seeked' 在瀏覽器下一個 tick 觸發
    video.currentTime = target;
  });
}
