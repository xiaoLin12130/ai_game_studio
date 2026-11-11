/**
 * The single application window.
 *
 * Locked down on purpose: the page can render and call four IPC channels, nothing else.
 * `sandbox` and `contextIsolation` stay on, so a compromised renderer cannot reach Node.
 */
import { BrowserWindow, shell } from 'electron'
import path from 'node:path'

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 600,
    show: false,
    backgroundColor: '#12161c',
    title: 'AI Game Studio',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !process.env.STUDIO_SMOKE,
    },
  })

  window.once('ready-to-show', () => window.show())

  // Nothing in this window may open a second one; external links go to the real browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
  return window
}
