/**
 * Application entry: lifecycle, window, IPC, configuration, logging, and the first
 * DSH probe.
 *
 * The quit path is the part review asked for: Electron must not exit while a probe still
 * owns a runtime. `before-quit` is intercepted, shutdown is awaited, and only then does
 * the process exit. The wait is bounded, because a quit that hangs is its own defect.
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { configFilePath, loadConfig, saveConfig, type StudioConfig } from './config'
import { createLogger } from './logger'
import { DshConnectionService, SHUTDOWN_BOUND_MS } from './dsh/service'
import { TaskService } from './tasks/service'
import { CHANNELS, registerIpc } from './ipc'
import { createMainWindow } from './window'

const SMOKE = process.env.STUDIO_SMOKE ?? ''
const SMOKE_OUT = process.env.STUDIO_SMOKE_OUT ? path.resolve(process.env.STUDIO_SMOKE_OUT) : null
const SMOKE_QUIT_DELAY_MS = Number(process.env.STUDIO_SMOKE_QUIT_DELAY_MS ?? 300)

// An isolated profile for smoke runs and tests, so a check never touches the real one.
if (process.env.STUDIO_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.STUDIO_USER_DATA))
}

let mainWindow: BrowserWindow | null = null
let service: DshConnectionService | null = null
let tasks: TaskService | null = null
let shutdownState: 'idle' | 'running' | 'done' = 'idle'

function pushState(): void {
  if (!service || !mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(CHANNELS.stateChanged, service.getState())
}

/**
 * Co-operative quit: stop accepting probes, wait for the runtime to be reaped, exit.
 *
 * Repeated quit requests join the same shutdown instead of issuing a second close.
 */
async function gracefulQuit(code: number): Promise<void> {
  if (shutdownState !== 'idle') return
  shutdownState = 'running'
  const guard = setTimeout(() => {
    // Never let cleanup block the process forever; the log records that we gave up.
    console.error('[studio] shutdown exceeded its bound, exiting anyway')
    app.exit(1)
  }, SHUTDOWN_BOUND_MS + 5000)
  guard.unref()

  let exitCode = code
  try {
    // Tasks first: a running task holds a runtime, and the supervisor is the thing that
    // knows how to reclaim it. The health probe then finds nothing left to reap.
    await tasks?.dispose('app-quit').catch((error) => {
      console.error('[studio] task shutdown failed:', error)
      exitCode = 1
    })
    const result = await service?.shutdown('app-quit')
    // The exit code follows the safety property, not the clean path: if a process from
    // this probe could still be alive, the process must not exit 0.
    if (result && !result.confirmedGone) exitCode = 1
  } catch (error) {
    console.error('[studio] shutdown failed:', error)
    exitCode = 1
  } finally {
    clearTimeout(guard)
    shutdownState = 'done'
    app.exit(exitCode)
  }
}

/** Read what the renderer actually shows, so the smoke run can compare it to the state. */
async function readDom(window: BrowserWindow): Promise<Record<string, unknown> | null> {
  try {
    return await window.webContents.executeJavaScript(
      `({
        pill: (document.getElementById('status-pill') || {}).textContent || null,
        headline: (document.getElementById('headline') || {}).textContent || null,
        recheckDisabled: Boolean((document.getElementById('recheck') || {}).disabled),
        factServer: (document.getElementById('fact-server') || {}).textContent || null,
        factExit: (document.getElementById('fact-exit') || {}).textContent || null
      })`,
      true,
    )
  } catch {
    return null
  }
}

async function runSmoke(): Promise<void> {
  if (!SMOKE_OUT || !mainWindow || !service) return
  const started = Date.now()
  const window = mainWindow

  if (SMOKE === 'quit-during-probe') {
    // Let the probe get into the middle of its handshake, then ask the app to quit the
    // normal way. Everything after this point is the real quit path.
    await new Promise((resolve) => setTimeout(resolve, SMOKE_QUIT_DELAY_MS))
    const stateAtQuit = service.getState()
    fs.mkdirSync(SMOKE_OUT, { recursive: true })
    fs.writeFileSync(
      path.join(SMOKE_OUT, 'smoke.json'),
      `${JSON.stringify({ generatedAt: new Date().toISOString(), mode: SMOKE, stateAtQuit, elapsedMs: Date.now() - started }, null, 2)}\n`,
    )
    console.log('[smoke] quitting during probe, state=' + stateAtQuit.status)
    app.quit()
    return
  }

  const deadline = started + 120000
  while (service.isChecking() || service.getState().lastCheckedAt === null) {
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const state = service.getState()
  const dom = await readDom(window)

  // The failure scenario must prove the app is still usable, not just visible: press the
  // re-check button and require a second probe to actually run and settle.
  let second = null
  if (SMOKE === 'failure') {
    const before = service.getState().lastCheckedAt
    try {
      await window.webContents.executeJavaScript("document.getElementById('recheck').click()", true)
    } catch {
      /* recorded as a failed check below */
    }
    const retryDeadline = Date.now() + 90000
    while (Date.now() < retryDeadline) {
      const current = service.getState()
      if (!service.isChecking() && current.lastCheckedAt !== before) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    second = { state: service.getState(), dom: await readDom(window) }
  }

  const shot = await window.webContents.capturePage()
  fs.mkdirSync(SMOKE_OUT, { recursive: true })
  const image = nativeImage.createFromBuffer(shot.toPNG())
  fs.writeFileSync(path.join(SMOKE_OUT, 'window.png'), shot.toPNG())
  const result = {
    generatedAt: new Date().toISOString(),
    mode: SMOKE || 'ready',
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
    dom,
    second,
    totalMs: Date.now() - started,
  }
  fs.writeFileSync(path.join(SMOKE_OUT, 'smoke.json'), `${JSON.stringify(result, null, 2)}\n`)

  // The failure scenario is a pass when the UI shows a failure, so the exit code follows
  // the expectation rather than "READY or bust".
  const expected = process.env.STUDIO_SMOKE_EXPECT ?? 'READY'
  const ok = state.status === expected && window.isVisible() && BrowserWindow.getAllWindows().length === 1
  console.log('[smoke]', JSON.stringify({ ok, expected, status: state.status, totalMs: result.totalMs }))
  await gracefulQuit(ok ? 0 : 3)
}

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData')
  fs.mkdirSync(userDataDir, { recursive: true })
  const logDir = path.join(userDataDir, 'logs')
  const logger = createLogger(logDir)
  logger.info('app.start', { version: app.getVersion(), userDataDir, smoke: SMOKE })

  const loaded = loadConfig(userDataDir)
  if (loaded.recovered) logger.warn('config.recovered', { note: loaded.note })
  const config: StudioConfig = loaded.config

  service = new DshConnectionService({
    logger,
    userDataDir,
    readConfig: () => config,
    configRecovered: loaded.recovered,
    configRecoveryNote: loaded.note,
  })
  service.on('state', () => pushState())

  // Task state outlives any single probe, so it is created here and disposed on quit.
  tasks = new TaskService({
    logger,
    userDataDir,
    dshHome: path.join(userDataDir, 'dsh-home'),
    profile: config.dsh.profile,
    provider: config.dsh.provider,
    model: config.dsh.model,
    cwd: app.getPath('documents') || userDataDir,
    entryPath: config.dsh.entryPath ?? null,
  })
  tasks.on('changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.tasksChanged)
  })
  void tasks
    .recoverOnStartup()
    .then((result) => {
      if (result.recovered.length > 0) logger.warn('task.recovered.interrupted', { tasks: result.recovered })
    })
    .catch((error) => logger.error('task.recovery.failed', { error: String(error) }))

  mainWindow = createMainWindow()

  registerIpc({
    service,
    tasks,
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

  // Intercept the quit, reap the runtime, and only then let the process end.
  app.on('before-quit', (event) => {
    if (shutdownState === 'done') return
    event.preventDefault()
    void gracefulQuit(0)
  })

  if (SMOKE) {
    setTimeout(() => {
      console.error('[smoke] watchdog fired')
      app.exit(4)
    }, 180000).unref()
  }
}
