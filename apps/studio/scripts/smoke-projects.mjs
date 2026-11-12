#!/usr/bin/env node
/**
 * Desktop smoke for the project lifecycle.
 *
 * Creates a project in a real empty directory, quits, relaunches against the same user data,
 * and checks the project is still there and can be opened. A restart is the only way to
 * prove persistence is real rather than in-memory.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-01-d', 'desktop')
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-proj-smoke-'))
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-game-'))

const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

async function run(mode) {
  const outDir = path.join(userData, 'out-' + mode)
  fs.mkdirSync(outDir, { recursive: true })
  const child = spawn(electron, [ROOT], {
    env: {
      ...cleanEnv,
      STUDIO_SMOKE: mode,
      STUDIO_SMOKE_OUT: outDir,
      STUDIO_USER_DATA: userData,
      STUDIO_SMOKE_PROJECT_ROOT: projectRoot,
    },
    stdio: 'ignore',
  })
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true, code: null }), 120000)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code }) })
  })
  const smokePath = path.join(outDir, 'smoke.json')
  const smoke = fs.existsSync(smokePath) ? JSON.parse(fs.readFileSync(smokePath, 'utf8')) : null
  return { mode, exitCode: exit.code, timedOut: exit.timedOut, smoke }
}

const created = await run('project-create')
const reopened = await run('project-reopen')

const checks = {
  createExitZero: created.exitCode === 0,
  createdProject: created.smoke?.phase === 'created',
  projectHasId: typeof created.smoke?.project?.id === 'string',
  markerWritten: fs.existsSync(path.join(projectRoot, '.studio-project.json')),
  reopenExitZero: reopened.exitCode === 0,
  projectSurvivedRestart: reopened.smoke?.phase === 'reopened' && reopened.smoke?.count === 1,
  sameProjectId: reopened.smoke?.project?.id === created.smoke?.project?.id,
  reopenedSuccessfully: reopened.smoke?.openProject === created.smoke?.project?.id,
  eventsRecorded: (reopened.smoke?.project?.events ?? []).length >= 3,
}

fs.mkdirSync(OUT, { recursive: true })
// Evidence is committed: absolute paths become placeholders, the shape stays readable.
const redact = (value) =>
  typeof value === 'string'
    ? value.replace(/[A-Za-z]:\\[^"']*/g, '<abs-path>').replace(/[A-Za-z]:\/[^"']*/g, '<abs-path>')
    : Array.isArray(value)
      ? value.map(redact)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]))
        : value
const summary = { generatedAt: new Date().toISOString(), checks, ok: Object.values(checks).every(Boolean), created: redact(created), reopened: redact(reopened) }
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, checks }, null, 2))
process.exit(summary.ok ? 0 : 1)
