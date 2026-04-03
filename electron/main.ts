import {
  app,
  BrowserWindow,
  protocol,
  net,
  session,
} from 'electron';
import * as path from 'node:path';
import * as url from 'node:url';
import { registerIpcHandlers } from './ipcHandlers.js';
import { WindowMonitor } from './windowMonitor.js';
import { SystemTray } from './systemTray.js';
import { ensureConfigDir } from './fileManager.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

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
 * Register custom protocol for loading local files.
 *
 * Converts local-file://C:/path/to/file.vrm to actual file reads.
 * This replaces Tauri's asset:// protocol.
 */
function registerLocalFileProtocol(): void {
  protocol.handle('local-file', (request) => {
    // Strip protocol prefix and decode
    let filePath = decodeURIComponent(request.url.replace('local-file://', ''));
    // Handle Windows paths (e.g., /C:/path → C:/path)
    if (filePath.startsWith('/') && filePath[2] === ':') {
      filePath = filePath.substring(1);
    }
    return net.fetch(url.pathToFileURL(filePath).toString());
  });
}

/** Create the main transparent window */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 400,
    height: 600,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    center: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for koffi native modules
    },
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
  // Register custom protocol before creating window
  registerLocalFileProtocol();

  // Allow loading local files via the custom protocol
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' local-file: file:; " +
          "img-src 'self' local-file: file: data: blob:; " +
          "connect-src 'self' local-file: file: http://localhost:*",
        ],
      },
    });
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
