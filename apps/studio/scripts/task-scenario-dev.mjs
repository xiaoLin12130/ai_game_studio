#!/usr/bin/env node
/** Run one task smoke scenario against the development build (fast diagnosis). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const mode = process.argv[2] ?? 'task-run'
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-dev-' + mode + '-'))
const outDir = path.join(userData, 'out')

fs.mkdirSync(userData, { recursive: true })
fs.writeFileSync(
  path.join(userData, 'config.json'),
  JSON.stringify({ version: 1, dsh: { profile: 'sdk', provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', probeTimeoutMs: 60000 }, ui: { autoProbeOnStart: false } }, null, 2) + '\n',
)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
env.STUDIO_SMOKE = mode
env.STUDIO_SMOKE_OUT = outDir
env.STUDIO_USER_DATA = userData

const credential = (() => {
  const file = path.join(os.homedir(), '.dsh', '.credentials.yaml')
  if (!fs.existsSync(file)) return null
  const m = /COMMANDCODE_API_KEY\s*:\s*"((?:[^"\\]|\\[\s\S])*)"/.exec(fs.readFileSync(file, 'utf8'))
  return m ? m[1].replace(/\\\r?\n\s*/g, '') : null
})()
if (credential) env.COMMANDCODE_API_KEY = credential

const child = spawn(electron, [ROOT], { env, stdio: 'ignore' })
const exit = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ timedOut: true, code: null }), 420000)
  child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code }) })
})
const smokePath = path.join(outDir, 'smoke.json')
const smoke = fs.existsSync(smokePath) ? JSON.parse(fs.readFileSync(smokePath, 'utf8')) : null
console.log(JSON.stringify({ mode, exitCode: exit.code, timedOut: exit.timedOut, smoke }, null, 2).slice(0, 4000))
