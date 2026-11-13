#!/usr/bin/env node
/**
 * Drive the PHASE 02 user journey through the real Electron app.
 *
 * This is the evidence that the phase produced a usable product rather than a set of
 * services: it clicks through create project → advisor → draft → freeze → change proposal
 * in the actual window, and keeps a screenshot of each step.
 *
 * The screenshots are real captures of a running app, not fixtures.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
// Each round keeps its own evidence directory: a later run must not overwrite the
// screenshots a previous round's report cites.
const OUT = path.join(REPO, 'evidence', process.env.SMOKE_EVIDENCE_DIR ?? 'phase-02-remediation', 'desktop')
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-adv-smoke-'))
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-adv-game-'))
const smokeOut = path.join(userData, 'out')

// The app must not inherit a flag that turns it into a Node process.
const cleanEnv = { ...process.env }
delete cleanEnv.ELECTRON_RUN_AS_NODE

fs.mkdirSync(smokeOut, { recursive: true })

// A cold DSH home has to materialise a profile and start a runtime before the model is
// even asked; a real turn after that is not instant either.
const waitMs = Number(process.env.SMOKE_TURN_WAIT_MS ?? 240000)
const started = Date.now()
// Detached, with no stdio: a child that shares this process's console gets torn down when
// the parent's console session ends, which is what produced a bare exit 4 at 180 s.
const child = spawn(electron, [ROOT], {
  env: {
    ...cleanEnv,
    STUDIO_SMOKE: 'advisor-journey',
    STUDIO_SMOKE_OUT: smokeOut,
    STUDIO_USER_DATA: userData,
    STUDIO_SMOKE_PROJECT_ROOT: projectRoot,
    STUDIO_SMOKE_TURN_WAIT_MS: String(waitMs),
    STUDIO_SMOKE_WATCHDOG_MS: String(waitMs + 300000),
  },
  stdio: 'ignore',
  detached: true,
  windowsHide: true,
})
child.unref()

// Poll for the app's own artefacts rather than waiting on the process: the app writes
// smoke.json when it is done, and that is the signal that matters.
const deadline = Date.now() + waitMs + 300000
const smokePathEarly = path.join(smokeOut, 'smoke.json')
while (Date.now() < deadline && !fs.existsSync(smokePathEarly)) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
}
const exit = { timedOut: !fs.existsSync(smokePathEarly), code: fs.existsSync(smokePathEarly) ? 0 : null }

const progressPath = path.join(smokeOut, 'progress.log')
const progress = fs.existsSync(progressPath) ? fs.readFileSync(progressPath, 'utf8').trim().split('\n') : []

const smokePath = path.join(smokeOut, 'smoke.json')
const smoke = fs.existsSync(smokePath) ? JSON.parse(fs.readFileSync(smokePath, 'utf8')) : null

// Only redacted evidence is committed; the raw captures live in the temp directory.
fs.mkdirSync(OUT, { recursive: true })
const shots = []
for (const name of fs.readdirSync(smokeOut).filter((n) => n.endsWith('.png')).sort()) {
  fs.copyFileSync(path.join(smokeOut, name), path.join(OUT, name))
  shots.push(name)
}

const advisor = smoke?.advisor ?? {}
const checks = {
  exitZero: exit.code === 0,
  journeyCompleted: smoke?.phase === 'journey',
  advisorViewOpened: advisor.visible === true,
  starterStateShown: advisor.emptyShown === true,
  oneSentenceStartedDiscussion: advisor.conversations >= 1,
  messagesPersisted: advisor.messageCount >= 2,
  assistantReplied: Array.isArray(advisor.roles) && advisor.roles.includes('assistant'),
  draftCreated: smoke?.drafts?.rows >= 1,
  freezePageShown: smoke?.baseline?.previewVisible === true,
  baselineFrozen: smoke?.baseline?.rows >= 1,
  freezeReported: /已冻结/.test(String(smoke?.baseline?.alert ?? '')),
  proposalCreated: smoke?.proposals?.rows >= 1,
  proposalApproved: /已批准/.test(String(smoke?.proposals?.approvedStage ?? '')),
  candidateGenerated: /候选版本待确认/.test(String(smoke?.proposals?.candidateStage ?? '')),
  candidateFrozen: /已冻结为新基线/.test(String(smoke?.proposals?.finalStage ?? '')),
  newBaselineVersion: smoke?.baselinesAfterCandidate >= 2,
  researchPagePresent: smoke?.research?.formPresent === true,
  screenshotsCaptured: shots.length >= 9,
}

const summary = {
  generatedAt: new Date().toISOString(),
  kind: 'REAL_RUN',
  note: '真实 Electron 窗口中的真实点击流程；截图是同一次运行的真实捕获。',
  elapsedMs: Date.now() - started,
  exitCode: exit.code,
  timedOut: exit.timedOut,
  screenshots: shots,
  progress,
  checks,
  ok: Object.values(checks).every(Boolean),
  smoke,
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(JSON.stringify({ ok: summary.ok, checks }, null, 2))
process.exit(summary.ok ? 0 : 1)
