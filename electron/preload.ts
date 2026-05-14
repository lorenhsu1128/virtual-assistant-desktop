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
  scanVrmaFiles: (folderPath: string) => ipcRenderer.invoke('scan_vrma_files', folderPath),

  // ── File Pickers ──
  pickVrmFile: () => ipcRenderer.invoke('pick_vrm_file'),
  pickAnimationFolder: () => ipcRenderer.invoke('pick_animation_folder'),
  pickVrmFolder: (defaultPath?: string) => ipcRenderer.invoke('pick_vrm_folder', defaultPath),

  // ── VRM Picker Window ──
  openVrmPicker: () => ipcRenderer.invoke('open_vrm_picker'),
  applyVrmModel: (vrmPath: string) => ipcRenderer.invoke('apply_vrm_model', vrmPath),

  // ── Settings Window ──
  openSettingsWindow: () => ipcRenderer.invoke('open_settings_window'),

  // ── Window Monitor ──
  getWindowList: () => ipcRenderer.invoke('get_window_list'),

  // (Window Region 已移除，未來重新開發)

  // ── Display Info ──
  getDisplayInfo: () => ipcRenderer.invoke('get_display_info'),
  getDisplayForPoint: (x: number, y: number) =>
    ipcRenderer.invoke('get_display_for_point', x, y),

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

  // ── Agent (my-agent daemon bridge) ──
  agentGetStatus: () => ipcRenderer.invoke('agent_get_status'),
  agentSendInput: (text: string) => ipcRenderer.invoke('agent_send_input', text),
  agentToggleBubble: () => ipcRenderer.invoke('agent_toggle_bubble'),
  agentReconnect: () => ipcRenderer.invoke('agent_reconnect'),
  agentApplyConfig: (config: unknown) => ipcRenderer.invoke('agent_apply_config', config),
  // M-MASCOT-EMBED Phase 5 新增 — master toggle + 精確 state machine
  agentEnable: () => ipcRenderer.invoke('agent_enable'),
  agentDisable: () => ipcRenderer.invoke('agent_disable'),
  agentReloadLlm: () => ipcRenderer.invoke('agent_reload_llm'),
  agentAbort: () => ipcRenderer.invoke('agent_abort'),
  agentGetRuntimeStatus: () => ipcRenderer.invoke('agent_get_runtime_status'),
  onLlmStatusChanged: (callback: (status: unknown) => void) => {
    const handler = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('llm_status_changed', handler);
    return () => ipcRenderer.removeListener('llm_status_changed', handler);
  },
  onAgentStatus: (callback: (info: unknown) => void) => {
    const handler = (_event: unknown, info: unknown) => callback(info);
    ipcRenderer.on('agent_status', handler);
    return () => ipcRenderer.removeListener('agent_status', handler);
  },
  onAgentSessionOpen: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('agent_session_open', handler);
    return () => ipcRenderer.removeListener('agent_session_open', handler);
  },
  onAgentSessionClose: (callback: (info: unknown) => void) => {
    const handler = (_event: unknown, info: unknown) => callback(info);
    ipcRenderer.on('agent_session_close', handler);
    return () => ipcRenderer.removeListener('agent_session_close', handler);
  },
  onAgentSessionFrame: (callback: (frame: unknown) => void) => {
    const handler = (_event: unknown, frame: unknown) => callback(frame);
    ipcRenderer.on('agent_session_frame', handler);
    return () => ipcRenderer.removeListener('agent_session_frame', handler);
  },
  onMascotAction: (callback: (action: unknown) => void) => {
    const handler = (_event: unknown, action: unknown) => callback(action);
    ipcRenderer.on('mascot_action', handler);
    return () => ipcRenderer.removeListener('mascot_action', handler);
  },

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

  onKeyboardTypingChanged: (callback: (isTyping: boolean) => void) => {
    const handler = (_event: unknown, isTyping: boolean) => callback(isTyping);
    ipcRenderer.on('keyboard_typing_changed', handler);
    return () => ipcRenderer.removeListener('keyboard_typing_changed', handler);
  },

  onDebugMove: (callback: (direction: string) => void) => {
    const handler = (_event: unknown, direction: string) => callback(direction);
    ipcRenderer.on('debug_move', handler);
    return () => ipcRenderer.removeListener('debug_move', handler);
  },

  onCursorPosition: (callback: (pos: { x: number; y: number }) => void) => {
    const handler = (_event: unknown, pos: { x: number; y: number }) => callback(pos);
    ipcRenderer.on('cursor_position', handler);
    return () => ipcRenderer.removeListener('cursor_position', handler);
  },

  // ── Asset URL Conversion ──
  // 將本地檔案路徑轉為 local-file:// protocol URL
  // Windows: C:/path → local-file:///C:/path
  // macOS:   /Users/path → local-file://localhost/Users/path
  convertToAssetUrl: (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/');
    // macOS/Linux 路徑以 / 開頭，用 localhost 避免路徑首段被解析為 hostname
    if (normalized.startsWith('/')) {
      return `local-file://localhost${normalized}`;
    }
    // Windows 磁碟代號 C:/... — 三斜線表示空 host
    return `local-file:///${normalized}`;
  },
});
