/**
 * 影片動捕工作站 — renderer 入口
 *
 * 由 vite multi-page 建置，對應 mocap-studio.html。
 * 透過 electron/mocapStudioWindow.ts 建立的獨立 BrowserWindow 載入。
 */

import { MocapStudioApp } from './MocapStudioApp';

let app: MocapStudioApp | null = null;

function bootstrap(): void {
  app = new MocapStudioApp();
  app.init().catch((e) => {
    console.error('[MocapStudio] init failed:', e);
  });
}

window.addEventListener('beforeunload', () => {
  if (app) {
    app.dispose();
    app = null;
  }
});

bootstrap();
