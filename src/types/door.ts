/**
 * 門洞效果型別定義
 *
 * 用於 opendoor 狀態的 stencil buffer 門洞視覺效果。
 */

/** 門洞動畫階段 */
export type DoorPhase =
  | 'preparing'  // 角色準備中，門洞不顯示
  | 'opening'    // 門從鉸鏈側展開
  | 'fullOpen'   // 全開，角色穿過門
  | 'closing'    // 門關閉
  | 'done';      // 效果結束

/** 門洞效果的幀範圍配置 */
export interface DoorFrameConfig {
  /** 動畫總幀數（= keyframe 數） */
  totalFrames: number;
  /** 動畫 FPS（用於幀→秒轉換） */
  fps: number;
  /** 開門起始幀 */
  openStart: number;
  /** 開門結束幀（= 全開起始幀） */
  openEnd: number;
  /** 穿門結束幀（= 關門起始幀） */
  passEnd: number;
  /** 關門結束幀 */
  closeEnd: number;
  /** Z 深度切換幀（角色從視窗後→前） */
  zSwitchFrame: number;
}

/** SYS_OPENDOOR_01 的預設幀配置 */
export const DEFAULT_DOOR_FRAME_CONFIG: DoorFrameConfig = {
  totalFrames: 191,
  fps: 30,
  openStart: 60,
  openEnd: 94,
  passEnd: 123,
  closeEnd: 163,
  zSwitchFrame: 95,
};
