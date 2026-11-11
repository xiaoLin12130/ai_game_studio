/**
 * The bridge between the sandboxed page and the main process.
 *
 * Exactly the four calls the UI needs, each one an allow-listed IPC channel string. No
 * `require`, no `fs`, no `ipcRenderer` handed to the page.
 */
import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = {
  getState: 'studio:get-state',
  recheck: 'studio:recheck',
  openLogs: 'studio:open-logs',
  getDiagnostics: 'studio:get-diagnostics',
  stateChanged: 'studio:state-changed',
} as const

const api = {
  getState: () => ipcRenderer.invoke(CHANNELS.getState),
  recheck: () => ipcRenderer.invoke(CHANNELS.recheck),
  openLogs: () => ipcRenderer.invoke(CHANNELS.openLogs),
  getDiagnostics: () => ipcRenderer.invoke(CHANNELS.getDiagnostics),
  onState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.stateChanged, listener)
    return () => ipcRenderer.removeListener(CHANNELS.stateChanged, listener)
  },
}

contextBridge.exposeInMainWorld('studio', api)
