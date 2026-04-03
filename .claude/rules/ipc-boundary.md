Rule: IPC 封裝規則

When editing any TypeScript file outside of src/bridge/:
- NEVER import from '@tauri-apps/api/core' or '@tauri-apps/api/event'
- NEVER call invoke() or listen() directly
- All IPC operations must go through the TauriIPC class in src/bridge/TauriIPC.ts
- If you need a new IPC call, add a method to TauriIPC first, then use it
- Check LESSONS.md for past IPC-related mistakes
