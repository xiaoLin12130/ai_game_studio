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
import { ProjectService } from './projects/service'
import { wireServices } from './app-wiring'
import { ProjectStore } from './projects/store'
import { TaskStore } from './tasks/store'
import { RulesService } from './projects/rules'
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
let projects: ProjectService | null = null
let rules: RulesService | null = null
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
    const taskShutdown = await tasks?.dispose('app-quit').catch((error) => {
      console.error('[studio] task shutdown failed:', error)
      return null
    })
    if (!taskShutdown || !taskShutdown.ok) {
      // A runtime we could not close is a leaked process; the exit code says so.
      console.error('[studio] task runtimes were not all closed:', JSON.stringify(taskShutdown ?? {}))
      exitCode = 1
    }
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

  // ---- project scenarios (PHASE 01-D) --------------------------------------------
  if (SMOKE.startsWith('project-') && projects) {
    const write = (payload: Record<string, unknown>) => {
      fs.mkdirSync(SMOKE_OUT as string, { recursive: true })
      fs.writeFileSync(path.join(SMOKE_OUT as string, 'smoke.json'), JSON.stringify({ generatedAt: new Date().toISOString(), mode: SMOKE, ...payload }, null, 2) + '\n')
    }
    try {
      if (SMOKE === 'project-create') {
        const rootDir = process.env.STUDIO_SMOKE_PROJECT_ROOT
        if (!rootDir) throw new Error('STUDIO_SMOKE_PROJECT_ROOT is required')
        const created = projects.create({ name: '冒烟项目', rootPath: rootDir, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })
        projects.open(created.id)
        write({ phase: 'created', project: projects.view(created.id), openProject: projects.openProject })
        app.quit()
        return
      }
      if (SMOKE === 'project-reopen') {
        const list = projects.list()
        if (list.length === 0) {
          write({ phase: 'no-projects', count: 0 })
          app.quit()
          return
        }
        const target = list[0]
        projects.open(target.id)
        const view = projects.view(target.id)
        write({ phase: 'reopened', count: list.length, project: view, openProject: projects.openProject })
        app.quit()
        return
      }
    } catch (error) {
      write({ phase: 'error', error: String((error as Error)?.message ?? error) })
      app.exit(1)
      return
    }
  }

  // ---- task lifecycle scenarios (PHASE 01-C) -------------------------------------
  if (SMOKE.startsWith('task-') && tasks) {
    const write = (payload: Record<string, unknown>) => {
      fs.mkdirSync(SMOKE_OUT as string, { recursive: true })
      fs.writeFileSync(path.join(SMOKE_OUT as string, 'smoke.json'), JSON.stringify({ generatedAt: new Date().toISOString(), mode: SMOKE, ...payload }, null, 2) + '\n')
    }
    const waitForTask = async (id: string, wanted: string[], timeoutMs: number) => {
      const end = Date.now() + timeoutMs
      while (Date.now() < end) {
        const current = tasks!.store.getTask(id)
        if (current && wanted.includes(current.status)) return current
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      return tasks!.store.getTask(id)
    }
    const snapshot = (id: string) => {
      const view = tasks!.store.getTaskView(id)
      return view
        ? {
            id: view.id,
            status: view.status,
            attempts: view.attempts.length,
            sessions: view.sessions.length,
            transitions: view.transitions.map((x) => x.to),
            verifications: view.verifications.map((v) => v.ok),
            error: view.lastErrorMessage,
            events: tasks!.store.listEvents(view.id, 8),
          }
        : null
    }
    const goal = 'Reply with exactly one word: hello. Do not use any tools.'
    try {
      if (SMOKE === 'task-run') {
        const created = tasks.create({ title: 'packaged task run', goal, type: 'analysis', isolation: 'writable' })
        await tasks.act(created.id, 'start')
        const final = await waitForTask(created.id, ['SUCCEEDED', 'FAILED'], 240000)
        write({ task: snapshot(created.id), finalStatus: final?.status ?? null, runtimes: tasks.runtimes() })
        app.quit()
        return
      }
      if (SMOKE === 'task-interrupt-resume') {
        const created = tasks.create({ title: 'packaged interrupt and resume', goal: 'Count slowly from 1 to 50, one number per line.', type: 'analysis', isolation: 'writable' })
        await tasks.act(created.id, 'start')
        const running = await waitForTask(created.id, ['RUNNING'], 180000)
        if (running?.status !== 'RUNNING') {
          write({ phase: 'start-failed', task: snapshot(created.id) })
          app.quit()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
        await tasks.act(created.id, 'stop')
        const interrupted = await waitForTask(created.id, ['INTERRUPTED'], 180000)
        const atInterrupt = snapshot(created.id)
        if (interrupted?.status !== 'INTERRUPTED') {
          write({ phase: 'interrupt-failed', task: atInterrupt })
          app.quit()
          return
        }
        await tasks.act(created.id, 'resume')
        const final = await waitForTask(created.id, ['SUCCEEDED', 'FAILED'], 240000)
        write({ phase: 'done', atInterrupt, task: snapshot(created.id), finalStatus: final?.status ?? null, runtimes: tasks.runtimes() })
        app.quit()
        return
      }
      if (SMOKE === 'task-start-and-crash') {
        const created = tasks.create({ title: 'packaged crash recovery', goal: 'Count slowly from 1 to 50, one number per line.', type: 'analysis', isolation: 'writable' })
        await tasks.act(created.id, 'start')
        const running = await waitForTask(created.id, ['RUNNING'], 180000)
        write({ phase: 'crashing', task: snapshot(created.id), isRunning: running?.status === 'RUNNING' })
        // Deliberately skip the graceful path: this is what a crash looks like to the next
        // launch — no shutdown, no runtime close, no final transition.
        app.exit(9)
        return
      }
      if (SMOKE === 'task-recover') {
        const interrupted = tasks.store.listTasks().filter((x) => x.status === 'INTERRUPTED')
        if (interrupted.length === 0) {
          write({ phase: 'nothing-to-recover', tasks: tasks.store.listTasks().map((x) => ({ id: x.id, status: x.status })) })
          app.quit()
          return
        }
        const target = interrupted[0]
        const before = snapshot(target.id)
        await tasks.act(target.id, 'resume')
        const final = await waitForTask(target.id, ['SUCCEEDED', 'FAILED'], 240000)
        write({ phase: 'done', before, task: snapshot(target.id), finalStatus: final?.status ?? null, recovered: true })
        app.quit()
        return
      }
    } catch (error) {
      write({ phase: 'error', error: String((error as Error)?.message ?? error) })
      app.exit(1)
      return
    }
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

  // Task and project services are assembled by wireServices so the production wiring is
  // the same code the tests exercise: one database, one lock table, one connection owner.
  const wired = wireServices({
    logger,
    userDataDir,
    dbPath: path.join(userDataDir, 'studio.db'),
    dshHome: path.join(userDataDir, 'dsh-home'),
    profile: config.dsh.profile,
    provider: config.dsh.provider,
    model: config.dsh.model,
    cwd: app.getPath('documents') || userDataDir,
    entryPath: config.dsh.entryPath ?? null,
  })
  tasks = wired.tasks
  projects = wired.projects
  tasks.on('changed', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.tasksChanged)
  })
  void tasks
    .recoverOnStartup()
    .then((result) => {
      if (result.recovered.length > 0) logger.warn('task.recovered.interrupted', { tasks: result.recovered })
    })
    .catch((error) => logger.error('task.recovery.failed', { error: String(error) }))

  rules = new RulesService({ repoRoot: app.getAppPath(), projectRoot: null })

  mainWindow = createMainWindow()

  registerIpc({
    service,
    tasks,
    projects,
    rules,
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
    // A task scenario must not race the startup probe for the same parent process: both
    // runtimes are children of this process, and the probe refuses an ambiguous identity.
    if ((config.ui.autoProbeOnStart && !SMOKE.startsWith('task-')) || (SMOKE && !SMOKE.startsWith('task-'))) {
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
