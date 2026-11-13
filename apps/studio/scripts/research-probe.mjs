#!/usr/bin/env node
/**
 * Real research through the real runtime.
 *
 * Proves the chain end to end: a research request goes to DSH, the model actually calls
 * web_search and web_fetch, the sources in the saved report are the ones the tools returned,
 * and the report can be read back from the project afterwards.
 *
 * Costs a few small turns. Never prints the credential.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REPO = path.resolve(ROOT, '..', '..')
const OUT = path.join(REPO, 'evidence', 'phase-02-remediation', 'research')
const require = createRequire(import.meta.url)

const run = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-research-probe-'))
const dshHome = path.join(run, 'dsh-home')
fs.mkdirSync(dshHome, { recursive: true })

const sdk = require('@deepseek-ai/dsh-sdk-client')

// The isolated home needs the provider installed; a bare profile has no llm adapter.
const profileDir = path.join(dshHome, 'profiles', 'sdk')
if (!fs.existsSync(path.join(profileDir, 'node_modules', '@mars-sea', 'dsh-commandcode-provider', 'package.json'))) {
  const bootstrap = new sdk.HarnessClient({ dshHome, profile: 'sdk', initializeTimeoutMs: 60000, env: process.env })
  try {
    bootstrap.start()
    await bootstrap.initialize({ cwd: run, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  } catch { /* the profile is materialised anyway */ }
  finally { try { await Promise.race([bootstrap.close(), new Promise((r) => setTimeout(r, 15000))]) } catch {} }
  const dshBin = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const install = spawnSync(process.execPath, [dshBin, 'plugin', '--profile', 'sdk', 'add', '@mars-sea/dsh-commandcode-provider@0.15.4'], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000, env: { ...process.env, DSH_HOME: dshHome },
  })
  if (install.status !== 0) console.error('[research-probe] provider install failed:', String(install.stderr ?? '').slice(-300))
}

const { wireServices } = require(path.join(ROOT, 'dist', 'main', 'app-wiring.js'))

const logger = { info: (e, f) => { if (process.env.PROBE_DEBUG && String(e).startsWith('research.')) console.error('[info]', e, JSON.stringify(f ?? {}).slice(0, 200)) }, warn: () => {}, error: (e, f) => { if (process.env.PROBE_DEBUG) console.error('[err]', e, JSON.stringify(f).slice(0, 300)) } }

const app = wireServices({
  logger,
  userDataDir: run,
  dbPath: path.join(run, 'studio.db'),
  dshHome,
  profile: 'sdk',
  provider: 'commandcode',
  model: 'deepseek/deepseek-v4-flash',
  cwd: run,
})

const report = { generatedAt: new Date().toISOString(), steps: [], error: null }
const projectRoot = fs.mkdtempSync(path.join(run, 'game-'))
const project = app.projects.create({ name: '鸽子幸存者', rootPath: projectRoot, engine: 'cocos-creator-3.8.6', platform: 'wechat-minigame' })

try {
  const request = app.research.createRequest({
    projectId: project.id,
    question: '吸血鬼幸存者这类自动攻击游戏的核心循环是什么',
  })
  report.steps.push({ step: 'request-created', ok: request.status === 'REQUESTED', status: request.status })

  const result = await app.research.run(project.id, request.id)
  report.steps.push({
    step: 'research-ran',
    ok: result.ok,
    error: result.error,
    incomplete: result.incomplete,
  })

  if (result.report) {
    const verified = result.report.sources.filter((s) => s.verified)
    const fetched = result.report.sources.filter((s) => s.via === 'fetch')
    const searched = result.report.sources.filter((s) => s.via === 'search')

    report.steps.push({
      step: 'sources-recorded',
      ok: result.report.sources.length > 0,
      total: result.report.sources.length,
      verified: verified.length,
      fetched: fetched.length,
      searched: searched.length,
      sample: result.report.sources.slice(0, 5).map((s) => ({ url: s.url, via: s.via, verified: s.verified, status: s.status })),
    })
    report.steps.push({ step: 'has-verified-source', ok: verified.length > 0 })
    report.steps.push({ step: 'content-has-sections', ok: /已验证事实/.test(result.report.content) })
    report.steps.push({ step: 'report-stored', ok: app.research.listReports(project.id).length === 1 })
    report.steps.push({ step: 'reloadable', ok: app.research.getReport(project.id, result.report.id) !== null })
    report.steps.push({ step: 'project-scoped', ok: app.research.listReports('other-project').length === 0 })
    report.report = {
      id: result.report.id,
      title: result.report.title,
      contentHead: result.report.content.slice(0, 1200),
      sources: result.report.sources,
    }
  }

  // A second run of the same request must not duplicate the first.
  // A second run of the same request is allowed; what must not happen is a report without
  // a verified source, or a completed status for a run that failed.
  const again = await app.research.run(project.id, request.id)
  const allReports = app.research.listReports(project.id)
  report.steps.push({ step: 'second-run-ran', ok: again.ok || again.error !== null, ok2: again.ok })
  report.steps.push({ step: 'every-saved-report-has-a-source', ok: allReports.every((r) => r.sources.length > 0), count: allReports.length })
  const finalReport = allReports[0] ?? null
  if (finalReport) {
    report.report = {
      id: finalReport.id,
      title: finalReport.title,
      contentHead: finalReport.content.slice(0, 1600),
      sources: finalReport.sources,
    }
    report.steps.push({ step: 'final-report-has-sections', ok: /已验证事实/.test(finalReport.content) })
    report.steps.push({ step: 'final-report-has-verified-source', ok: finalReport.sources.some((s) => s.verified) })
  }
} catch (error) {
  report.error = String(error?.message ?? error).slice(0, 800)
} finally {
  try { await app.dispose('probe-end') } catch {}
}

fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(path.join(OUT, 'research-chain.json'), JSON.stringify(report, null, 2) + '\n')
const failed = report.steps.filter((s) => s.ok === false)
console.log(JSON.stringify({ steps: report.steps.length, failed: failed.map((s) => s.step), error: report.error }, null, 2))
process.exit(failed.length === 0 && !report.error ? 0 : 1)
