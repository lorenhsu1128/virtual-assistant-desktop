import {
  app,
  BrowserWindow,
  globalShortcut,
  protocol,
  net,
  screen,
} from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerIpcHandlers } from './ipcHandlers.js';
import { WindowMonitor } from './windowMonitor.js';
import { SystemTray } from './systemTray.js';
import { ensureConfigDir, readConfig } from './fileManager.js';
import { closePickerWindow } from './vrmPickerWindow.js';
import { AgentDaemonManager } from './agent/AgentDaemonManager.js';
import { registerAgentIpcHandlers } from './agent/agentIpcHandlers.js';
import { closeAgentBubbleWindow } from './agent/agentBubbleWindow.js';
import { closeSettingsWindow } from './settingsWindow.js';
import { MascotMcpServer } from './agent/MascotMcpServer.js';
import {
  registerMascotMcp,
  unregisterMascotMcp,
} from './agent/mcpRegistration.js';
import { ensureAgentWorkspace } from './platform/index.js';
import { BrowserWindow as ElectronBrowserWindow } from 'electron';
import { startCursorTracker, stopCursorTracker } from './cursorTracker.js';
import {
  getWindowOptions,
  applyPostCreateSetup,
  resolveLocalFilePath,
} from './platform/index.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Suppress EPIPE errors from console.log when parent pipe is broken (dev mode)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

/** Whether we're running in development mode */
const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let windowMonitor: WindowMonitor | null = null;
let systemTray: SystemTray | null = null;
let agentDaemon: AgentDaemonManager | null = null;
let mascotMcp: MascotMcpServer | null = null;
let mascotMcpWorkspace: string | null = null;

/**
 * Single instance lock.
 * If another instance is already running, focus its window and quit.
 */
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

/**
 * Register custom protocol scheme BEFORE app is ready.
 * This is required for the protocol to work properly with fetch/XHR.
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** Create the main transparent window（平台參數由 electron/platform/ 提供） */
function createMainWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay();
  const bounds = primaryDisplay.bounds;

  const win = new BrowserWindow({
    ...getWindowOptions(bounds),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
    },
  });

  applyPostCreateSetup(win, bounds);

  // 將 renderer 的 console.log 轉到 main process stdout，方便在 dev shell 看到
  // 渲染端模組的訊息（例：MascotActionDispatcher）
  if (isDev) {
    win.webContents.on('console-message', (event) => {
      const tag = `[renderer:${event.level}]`;
      if (
        event.message.startsWith('[MascotAction]') ||
        event.message.startsWith('[headtracking]')
      ) {
        console.log(`${tag} ${event.message}`);
      }
    });
  }

  // DevTools: F12 toggle（不再 dev 啟動時自動開，避免 detached 視窗的原生標題列）
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  });

  // Load the frontend
  if (isDev) {
    win.loadURL('http://localhost:1420');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  return win;
}

app.whenReady().then(async () => {
  // Register protocol handler for local file access
  // Converts local-file://C:/path/to/file.vrm to actual file reads
  protocol.handle('local-file', (request) => {
    const parsed = new URL(request.url);
    const filePath = resolveLocalFilePath(decodeURIComponent(parsed.pathname));
    return net.fetch(url.pathToFileURL(filePath).toString());
  });

  // Ensure config directory exists
  await ensureConfigDir();

  // Create main window
  mainWindow = createMainWindow();

  // Start window monitor
  windowMonitor = new WindowMonitor();
  windowMonitor.start(mainWindow);

  // Setup system tray
  systemTray = new SystemTray(mainWindow);
  systemTray.setup();

  // Register IPC handlers
  registerIpcHandlers(mainWindow, windowMonitor);

  // 啟動全螢幕游標輪詢（給 HeadTrackingController 使用）
  startCursorTracker(() => ElectronBrowserWindow.getAllWindows());

  // Start my-agent daemon manager（依 config.agent.enabled 決定是否實際啟動）
  try {
    const cfg = await readConfig();
    const agentCfg = cfg.agent ?? {
      enabled: false,
      daemonMode: 'auto' as const,
      bunBinaryPath: null,
      myAgentCliPath: null,
      workspaceCwd: null,
    };

    // P2：先起 MCP server + 註冊到 my-agent，daemon spawn 時就會看到工具
    if (agentCfg.enabled) {
      try {
        mascotMcpWorkspace = await ensureAgentWorkspace(agentCfg.workspaceCwd);
        mascotMcp = new MascotMcpServer(() => ElectronBrowserWindow.getAllWindows());
        const mcpUrl = await mascotMcp.start();
        if (mcpUrl) {
          await registerMascotMcp(
            'mascot',
            mcpUrl,
            mascotMcpWorkspace,
            agentCfg.myAgentCliPath,
          );
        }
      } catch (e) {
        console.warn('[Main] MascotMcpServer setup failed:', e);
      }
    }

    agentDaemon = new AgentDaemonManager(agentCfg);
    registerAgentIpcHandlers(mainWindow, agentDaemon);
    void agentDaemon.start();
  } catch (e) {
    console.warn('[Main] AgentDaemonManager init failed:', e);
  }

  // Debug: Ctrl+Arrow keys for manual character movement (global shortcuts)
  const arrows = ['Up', 'Down', 'Left', 'Right'] as const;
  for (const dir of arrows) {
    globalShortcut.register(`Ctrl+${dir}`, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('debug_move', dir.toLowerCase());
      }
    });
  }

  // Cleanup on window close（agentDaemon 由 before-quit 集中處理，避免雙重呼叫競態）
  mainWindow.on('closed', () => {
    globalShortcut.unregisterAll();
    stopCursorTracker();
    windowMonitor?.stop();
    systemTray?.dispose();
    closePickerWindow();
    closeAgentBubbleWindow();
    closeSettingsWindow();
    mainWindow = null;
  });
});

// 多平台 graceful shutdown：app quit 前確保 daemon 收到 SIGTERM
app.on('before-quit', async (event) => {
  if (agentDaemon) {
    const local = agentDaemon;
    const localMcp = mascotMcp;
    const cwd = mascotMcpWorkspace;
    agentDaemon = null;
    mascotMcp = null;
    event.preventDefault();
    try {
      // 順序：先停 daemon（停止 LLM 呼叫工具）→ 取消 mcp 註冊 → 關 http server
      await local.stop();
    } catch (e) {
      console.warn('[Main] agentDaemon.stop() error:', e);
    }
    if (localMcp && cwd) {
      try {
        const cfg = await readConfig();
        await unregisterMascotMcp('mascot', cwd, cfg.agent?.myAgentCliPath ?? null);
        await localMcp.stop();
      } catch (e) {
        console.warn('[Main] mascotMcp cleanup error:', e);
      }
    }
    app.quit();
  }
});

// Quit when all windows are closed (Windows behavior)
app.on('window-all-closed', () => {
  app.quit();
});
