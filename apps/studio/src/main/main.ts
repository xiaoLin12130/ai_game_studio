/**
 * Application entry: lifecycle, window, IPC, configuration, logging, and the first
 * DSH probe. Everything asynchronous here is bounded — quitting the app cancels a probe
 * instead of waiting for it.
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configFilePath, loadConfig, type StudioConfig } from './config'
import { createLogger } from './logger'
import { DshConnectionService } from './dsh/service'
import { CHANNELS, registerIpc } from './ipc'
import { createMainWindow } from './window'

const SMOKE = process.env.STUDIO_SMOKE === '1'
const SMOKE_OUT = process.env.STUDIO_SMOKE_OUT ? path.resolve(process.env.STUDIO_SMOKE_OUT) : null

// An isolated profile for smoke runs and tests, so a check never touches the real one.
if (process.env.STUDIO_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STUDIO_USER_DATA))
}

let mainWindow: BrowserWindow | null = null
let service: DshConnectionService | null = null
let quitting = false

function pushState(): void {
  if (!service || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(CHANNELS.stateChanged, service.getState())
}

async function runSmoke(): Promise<void> {
  if (!SMOKE_OUT || !mainWindow || !service) return
  const started = Date.now()
  // Wait for the first probe to settle (or the app to be told to give up).
  const deadline = started + 120000
  while (service.isChecking() || service.getState().lastCheckedAt === null) {
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const state = service.getState()
  const window = mainWindow
  const shot = await window.webContents.capturePage()
  fs.mkdirSync(SMOKE_OUT, { recursive: true })
  const image = nativeImage.createFromBuffer(shot.toPNG())
  fs.writeFileSync(path.join(SMOKE_OUT, 'window.png'), shot.toPNG())
  const result = {
    generatedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    window: {
      count: BrowserWindow.getAllWindows().length,
      visible: window.isVisible(),
      title: window.getTitle(),
      bounds: window.getBounds(),
      imageSize: image.getSize(),
      url: window.webContents.getURL(),
    },
    state,
    totalMs: Date.now() - started,
  }
  fs.writeFileSync(path.join(SMOKE_OUT, 'smoke.json'), `${JSON.stringify(result, null, 2)}\n`)
  const ok = state.status === 'READY' && window.isVisible() && BrowserWindow.getAllWindows().length === 1
  console.log('[smoke]', JSON.stringify({ ok, status: state.status, totalMs: result.totalMs, image: result.window.imageSize }))
  quitting = true
  app.exit(ok ? 0 : 3)
}

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData')
  fs.mkdirSync(userDataDir, { recursive: true })
  const logDir = path.join(userDataDir, 'logs')
  const logger = createLogger(logDir)
  logger.info('app.start', { version: app.getVersion(), userDataDir, smoke: SMOKE })

  const loaded = loadConfig(userDataDir)
  if (loaded.recovered) logger.warn('config.recovered', { note: loaded.note })
  let config: StudioConfig = loaded.config

  service = new DshConnectionService({
    logger,
    userDataDir,
    readConfig: () => config,
    configRecovered: loaded.recovered,
    configRecoveryNote: loaded.note,
  })
  service.on('state', () => pushState())

  mainWindow = createMainWindow()

  registerIpc({
    service,
    logger,
    logDir,
    configPath: configFilePath(userDataDir),
    userDataDir,
    onRecheck: () => {
      void service?.check('manual').catch((error) => logger.error('dsh.probe.unhandled', { error: String(error) }))
    },
  })

  mainWindow.webContents.once('did-finish-load', () => {
    pushState()
    if (config.ui.autoProbeOnStart || SMOKE) {
      void service?.check('startup').catch((error) => logger.error('dsh.probe.unhandled', { error: String(error) }))
    }
    if (SMOKE) void runSmoke()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[studio] failed to start:', error)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('before-quit', () => {
    if (quitting) return
    quitting = true
    service?.cancel('app-quit')
  })

  if (SMOKE) {
    setTimeout(() => {
      console.error('[smoke] watchdog fired')
      app.exit(4)
    }, 180000).unref()
  }
}
