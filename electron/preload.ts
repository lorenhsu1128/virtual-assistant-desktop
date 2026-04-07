import { contextBridge, ipcRenderer } from 'electron';

/**
 * Electron preload script.
 *
 * Exposes a typed API to the renderer process via contextBridge.
 * This is the Electron equivalent of Tauri's invoke/listen mechanism.
 */
contextBridge.exposeInMainWorld('electronAPI', {
  // ── Config ──
  getConfigExists: () => ipcRenderer.invoke('get_config_exists'),
  readConfig: () => ipcRenderer.invoke('read_config'),
  writeConfig: (config: unknown) => ipcRenderer.invoke('write_config', config),

  // ── Animation Meta ──
  readAnimationMeta: () => ipcRenderer.invoke('read_animation_meta'),
  writeAnimationMeta: (meta: unknown) => ipcRenderer.invoke('write_animation_meta', meta),
  scanAnimations: (folderPath: string) => ipcRenderer.invoke('scan_animations', folderPath),
  scanVrmFiles: (folderPath: string) => ipcRenderer.invoke('scan_vrm_files', folderPath),

  // ── File Pickers ──
  pickVrmFile: () => ipcRenderer.invoke('pick_vrm_file'),
  pickAnimationFolder: () => ipcRenderer.invoke('pick_animation_folder'),

  // ── Window Monitor ──
  getWindowList: () => ipcRenderer.invoke('get_window_list'),

  // (Window Region 已移除，未來重新開發)

  // ── Display Info ──
  getDisplayInfo: () => ipcRenderer.invoke('get_display_info'),

  // ── Window Position / Size ──
  setWindowPosition: (x: number, y: number) => ipcRenderer.invoke('set_window_position', x, y),
  getWindowPosition: () => ipcRenderer.invoke('get_window_position'),
  setWindowSize: (width: number, height: number) => ipcRenderer.invoke('set_window_size', width, height),
  getWindowSize: () => ipcRenderer.invoke('get_window_size'),

  // ── Multi-Display ──
  moveToDisplay: (displayIndex: number) =>
    ipcRenderer.invoke('move_to_display', displayIndex),

  // ── Mouse Passthrough ──
  setIgnoreCursorEvents: (ignore: boolean) => ipcRenderer.invoke('set_ignore_cursor_events', ignore),

  // ── App Path ──
  getAppPath: () => ipcRenderer.invoke('get_app_path'),

  // ── App Control ──
  closeWindow: () => ipcRenderer.invoke('close_window'),

  // ── Event Listeners ──
  onWindowLayoutChanged: (callback: (rects: unknown) => void) => {
    const handler = (_event: unknown, rects: unknown) => callback(rects);
    ipcRenderer.on('window_layout_changed', handler);
    return () => ipcRenderer.removeListener('window_layout_changed', handler);
  },

  onTrayAction: (callback: (actionId: string) => void) => {
    const handler = (_event: unknown, actionId: string) => callback(actionId);
    ipcRenderer.on('tray_action', handler);
    return () => ipcRenderer.removeListener('tray_action', handler);
  },

  onRequestMenuData: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('request_menu_data', handler);
    return () => ipcRenderer.removeListener('request_menu_data', handler);
  },

  sendMenuData: (data: unknown) => {
    ipcRenderer.send('menu_data_response', data);
  },

  onDebugMove: (callback: (direction: string) => void) => {
    const handler = (_event: unknown, direction: string) => callback(direction);
    ipcRenderer.on('debug_move', handler);
    return () => ipcRenderer.removeListener('debug_move', handler);
  },

  // ── Asset URL Conversion ──
  // In Electron, local files can be loaded via file:// protocol
  // or via a custom protocol registered in main.ts
  convertToAssetUrl: (filePath: string) => {
    // Normalize path separators and encode for URL
    // Triple slash (:///) means no host — avoids drive letter being parsed as hostname
    const normalized = filePath.replace(/\\/g, '/');
    return `local-file:///${normalized}`;
  },
});
