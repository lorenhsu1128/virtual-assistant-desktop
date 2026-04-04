import {
  app,
  BrowserWindow,
  protocol,
  net,
} from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerIpcHandlers } from './ipcHandlers.js';
import { WindowMonitor } from './windowMonitor.js';
import { SystemTray } from './systemTray.js';
import { ensureConfigDir } from './fileManager.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Suppress EPIPE errors from console.log when parent pipe is broken (dev mode)
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

/** Whether we're running in development mode */
const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let windowMonitor: WindowMonitor | null = null;
let systemTray: SystemTray | null = null;

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

/** Create the main transparent window */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 600,
    transparent: true,
    frame: false,
    thickFrame: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Allow loading local resources
      webSecurity: false,
    },
  });

  // DevTools: F12 to toggle (auto-open disabled — causes ghost title bar on Windows 11)
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

app.whenReady().then(() => {
  // Register protocol handler for local file access
  // Converts local-file://C:/path/to/file.vrm to actual file reads
  protocol.handle('local-file', (request) => {
    // URL format: local-file:///C:/path/to/file
    // new URL() parses this as pathname = /C:/path/to/file
    const parsed = new URL(request.url);
    let filePath = decodeURIComponent(parsed.pathname);
    // Remove leading slash before drive letter on Windows (e.g., /C:/path → C:/path)
    if (filePath.match(/^\/[A-Za-z]:\//)) {
      filePath = filePath.substring(1);
    }
    return net.fetch(url.pathToFileURL(filePath).toString());
  });

  // Ensure config directory exists
  ensureConfigDir();

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

  // Cleanup on window close
  mainWindow.on('closed', () => {
    windowMonitor?.stop();
    systemTray?.dispose();
    mainWindow = null;
  });
});

// Quit when all windows are closed (Windows behavior)
app.on('window-all-closed', () => {
  app.quit();
});
