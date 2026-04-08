/**
 * 影片動作轉換器 — Skeleton Overlay
 *
 * 在覆蓋於 <video> 之上的 2D canvas 繪製 MediaPipe HolisticResult：
 *   - pose landmarks（33 點，含連線）
 *   - 左右手 landmarks（每手 21 點，含連線）
 *   - face landmarks（478 點，僅小點，避開過度繁雜）
 *
 * 對應計畫：video-converter-plan.md 第 2.2 節
 *
 * 設計重點：
 *   - 自動 resize 以對齊 video 顯示矩形（呼叫 resize() 或 ResizeObserver）
 *   - 使用 normalized coords（[0,1]）乘上 canvas 尺寸；不依賴 worldLandmarks
 *   - 連線資料寫死在本檔，不依賴 MediaPipe drawing_utils 以降低耦合
 */

import type { HolisticResult, Landmark } from '../tracking/landmarkTypes';
import { POSE } from '../tracking/landmarkTypes';

/** Pose 連線（依 MediaPipe POSE_CONNECTIONS 子集） */
const POSE_CONNECTIONS: Array<[number, number]> = [
  // 軀幹
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
  [POSE.LEFT_SHOULDER, POSE.LEFT_HIP],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP],
  [POSE.LEFT_HIP, POSE.RIGHT_HIP],
  // 左手臂
  [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW],
  [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
  [POSE.LEFT_WRIST, POSE.LEFT_PINKY],
  [POSE.LEFT_WRIST, POSE.LEFT_INDEX],
  [POSE.LEFT_WRIST, POSE.LEFT_THUMB],
  [POSE.LEFT_PINKY, POSE.LEFT_INDEX],
  // 右手臂
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW],
  [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST],
  [POSE.RIGHT_WRIST, POSE.RIGHT_PINKY],
  [POSE.RIGHT_WRIST, POSE.RIGHT_INDEX],
  [POSE.RIGHT_WRIST, POSE.RIGHT_THUMB],
  [POSE.RIGHT_PINKY, POSE.RIGHT_INDEX],
  // 左腿
  [POSE.LEFT_HIP, POSE.LEFT_KNEE],
  [POSE.LEFT_KNEE, POSE.LEFT_ANKLE],
  [POSE.LEFT_ANKLE, POSE.LEFT_HEEL],
  [POSE.LEFT_HEEL, POSE.LEFT_FOOT_INDEX],
  [POSE.LEFT_ANKLE, POSE.LEFT_FOOT_INDEX],
  // 右腿
  [POSE.RIGHT_HIP, POSE.RIGHT_KNEE],
  [POSE.RIGHT_KNEE, POSE.RIGHT_ANKLE],
  [POSE.RIGHT_ANKLE, POSE.RIGHT_HEEL],
  [POSE.RIGHT_HEEL, POSE.RIGHT_FOOT_INDEX],
  [POSE.RIGHT_ANKLE, POSE.RIGHT_FOOT_INDEX],
  // 臉部小連線
  [POSE.NOSE, POSE.LEFT_EYE_INNER],
  [POSE.LEFT_EYE_INNER, POSE.LEFT_EYE],
  [POSE.LEFT_EYE, POSE.LEFT_EYE_OUTER],
  [POSE.LEFT_EYE_OUTER, POSE.LEFT_EAR],
  [POSE.NOSE, POSE.RIGHT_EYE_INNER],
  [POSE.RIGHT_EYE_INNER, POSE.RIGHT_EYE],
  [POSE.RIGHT_EYE, POSE.RIGHT_EYE_OUTER],
  [POSE.RIGHT_EYE_OUTER, POSE.RIGHT_EAR],
  [POSE.MOUTH_LEFT, POSE.MOUTH_RIGHT],
];

/** Hand 連線（單手，索引在 [0,20]） */
const HAND_CONNECTIONS: Array<[number, number]> = [
  // 拇指
  [0, 1], [1, 2], [2, 3], [3, 4],
  // 食指
  [0, 5], [5, 6], [6, 7], [7, 8],
  // 中指
  [0, 9], [9, 10], [10, 11], [11, 12],
  // 無名指
  [0, 13], [13, 14], [14, 15], [15, 16],
  // 小指
  [0, 17], [17, 18], [18, 19], [19, 20],
  // 掌部橫向
  [5, 9], [9, 13], [13, 17],
];

const COLOR_POSE_LINE = 'rgba(163, 190, 140, 0.85)'; // 綠
const COLOR_POSE_POINT = 'rgba(235, 203, 139, 0.95)'; // 黃
const COLOR_LEFT_HAND = 'rgba(136, 192, 208, 0.9)'; // 青藍
const COLOR_RIGHT_HAND = 'rgba(191, 97, 106, 0.9)'; // 紅
const COLOR_FACE = 'rgba(180, 142, 173, 0.55)'; // 紫

export class SkeletonOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;

  constructor(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
    this.canvas = canvas;
    this.video = video;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('SkeletonOverlay: 2D context unavailable');
    this.ctx = ctx;
  }

  /** 對齊 canvas 大小到 video 顯示矩形（由呼叫端在 resize / loadedmetadata 觸發） */
  resize(): void {
    const rect = this.video.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // 物理像素 = 邏輯尺寸 × dpr，CSS 尺寸用邏輯尺寸
    this.canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  clear(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    this.ctx.clearRect(0, 0, w, h);
  }

  /** 繪製單幀 HolisticResult */
  draw(result: HolisticResult): void {
    this.clear();
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    // ── Pose（連線 + 點） ──
    if (result.poseLandmarks.length >= 33) {
      this.drawConnections(result.poseLandmarks, POSE_CONNECTIONS, w, h, COLOR_POSE_LINE, 2);
      this.drawPoints(result.poseLandmarks, w, h, COLOR_POSE_POINT, 3, 0.3);
    }

    // ── 雙手 ──
    if (result.leftHandLandmarks.length >= 21) {
      this.drawConnections(result.leftHandLandmarks, HAND_CONNECTIONS, w, h, COLOR_LEFT_HAND, 1.5);
      this.drawPoints(result.leftHandLandmarks, w, h, COLOR_LEFT_HAND, 2);
    }
    if (result.rightHandLandmarks.length >= 21) {
      this.drawConnections(result.rightHandLandmarks, HAND_CONNECTIONS, w, h, COLOR_RIGHT_HAND, 1.5);
      this.drawPoints(result.rightHandLandmarks, w, h, COLOR_RIGHT_HAND, 2);
    }

    // ── Face（小點，避免擁擠） ──
    if (result.faceLandmarks.length > 0) {
      this.drawPoints(result.faceLandmarks, w, h, COLOR_FACE, 1);
    }
  }

  private drawConnections(
    landmarks: Landmark[],
    connections: Array<[number, number]>,
    w: number,
    h: number,
    color: string,
    lineWidth: number
  ): void {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = lineWidth;
    for (const [a, b] of connections) {
      const la = landmarks[a];
      const lb = landmarks[b];
      if (!la || !lb) continue;
      // 兩端 visibility 都 < 0.3 才跳過
      if ((la.visibility ?? 1) < 0.3 && (lb.visibility ?? 1) < 0.3) continue;
      this.ctx.beginPath();
      this.ctx.moveTo(la.x * w, la.y * h);
      this.ctx.lineTo(lb.x * w, lb.y * h);
      this.ctx.stroke();
    }
  }

  private drawPoints(
    landmarks: Landmark[],
    w: number,
    h: number,
    color: string,
    radius: number,
    visibilityThreshold = 0
  ): void {
    this.ctx.fillStyle = color;
    for (const lm of landmarks) {
      if ((lm.visibility ?? 1) < visibilityThreshold) continue;
      this.ctx.beginPath();
      this.ctx.arc(lm.x * w, lm.y * h, radius, 0, Math.PI * 2);
      this.ctx.fill();
    }
  }
}
