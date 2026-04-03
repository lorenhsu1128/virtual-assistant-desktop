Rule: IPC 封裝規則

When editing any TypeScript file outside of src/bridge/:
- NEVER import from 'electron' or use window.electronAPI directly
- NEVER call ipcRenderer.invoke() or ipcRenderer.on() directly
- All IPC operations must go through the ElectronIPC class in src/bridge/ElectronIPC.ts
- If you need a new IPC call, add a method to ElectronIPC first, then use it
- Check LESSONS.md for past IPC-related mistakes
