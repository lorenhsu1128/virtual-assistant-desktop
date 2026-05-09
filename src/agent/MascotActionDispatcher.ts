/**
 * MascotActionDispatcher — 把 LLM 透過 MCP 呼叫的工具動作派發到 VRM 系統。
 *
 * 訂閱 `mascot_action` IPC events（由 electron/agent/MascotMcpServer 廣播），
 * 路由到 ExpressionManager / AnimationManager 等既有模組。
 *
 * 模組邊界守則（src/CLAUDE.md）：
 * - 不直接呼叫 vrmController.setBlendShape，必須透過 ExpressionManager 走 fade
 * - 不直接呼叫 mixer，必須透過 AnimationManager
 * - 不引入 Three.js 型別，純粹做訊息分派
 */

import type { ExpressionManager } from '../expression/ExpressionManager';
import type { AnimationManager } from '../animation/AnimationManager';
import type { MascotAction } from '../types/agent';
import { ipc } from '../bridge/ElectronIPC';

export interface MascotActionDispatcherDeps {
  expressionManager: ExpressionManager;
  animationManager: AnimationManager;
}

export class MascotActionDispatcher {
  private deps: MascotActionDispatcherDeps;
  private offUnlisten: (() => void) | null = null;

  constructor(deps: MascotActionDispatcherDeps) {
    this.deps = deps;
  }

  /** 開始訂閱 IPC events（idempotent；重複呼叫無作用） */
  start(): void {
    if (this.offUnlisten) return;
    this.offUnlisten = ipc.onMascotAction((action) => this.handle(action));
  }

  /** 停止訂閱 */
  stop(): void {
    if (this.offUnlisten) {
      this.offUnlisten();
      this.offUnlisten = null;
    }
  }

  /** 純函式：把 action 路由到對應 manager（測試友善） */
  handle(action: MascotAction): void {
    switch (action.kind) {
      case 'set_expression':
        this.handleSetExpression(action.name, action.durationMs);
        break;
      case 'play_animation':
        this.handlePlayAnimation(action.category, action.name);
        break;
      case 'say':
        // P2 暫不實作（需要在氣泡視窗額外注入訊息）。先 log。
        console.log(`[MascotAction] say: ${action.text}`);
        break;
      case 'look_at_screen':
        // P2 留給 v0.5 攝影機追蹤；先 log。
        console.log(`[MascotAction] look_at_screen: ${action.x},${action.y}`);
        break;
      default:
        console.warn('[MascotAction] unknown kind:', action);
    }
  }

  private handleSetExpression(name: string, durationMs?: number): void {
    // 驗證表情名是否存在於模型
    const available = this.deps.expressionManager.getAvailableExpressions();
    const matched = matchExpression(name, available);
    if (!matched) {
      console.warn(
        `[MascotAction] set_expression: '${name}' not in model expressions ${JSON.stringify(available)}`,
      );
      return;
    }
    this.deps.expressionManager.setManualExpression(matched);

    if (durationMs && durationMs > 0) {
      // duration 過後清掉手動 → 回到自動輪播
      window.setTimeout(() => {
        this.deps.expressionManager.setManualExpression(null);
      }, durationMs);
    }
  }

  private handlePlayAnimation(category?: string, name?: string): void {
    if (name) {
      this.deps.animationManager.playByName(name);
      return;
    }
    if (category) {
      // AnimationManager.playByCategory 接受 idle/action/sit/fall/collide/peek
      this.deps.animationManager.playByCategory(
        category as 'idle' | 'action' | 'sit' | 'fall' | 'collide' | 'peek',
      );
    }
  }
}

/**
 * Case-insensitive 匹配表情名。LLM 可能傳入 'joy' 但模型實際命名為 'Joy'。
 * 找不到回 null。
 */
export function matchExpression(name: string, available: string[]): string | null {
  if (available.includes(name)) return name;
  const lower = name.toLowerCase();
  for (const candidate of available) {
    if (candidate.toLowerCase() === lower) return candidate;
  }
  return null;
}
