#!/usr/bin/env node
/**
 * Make sure the Electron binary actually exists.
 *
 * Electron 45 dropped `scripts.postinstall`: `npm i electron` succeeds in about a second
 * and leaves no `dist/electron.exe`, downloading lazily on the first `require('electron')`.
 * On a fresh machine or in CI that looks exactly like a failed install, so the check is
 * explicit here instead of being discovered later as "the window never opens".
 *
 * Exits non-zero when the binary is missing so `npm install` fails loudly.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
let electronDir
try {
  electronDir = path.dirname(require.resolve('electron/package.json'))
} catch (error) {
  console.error('[ensure-electron] the electron package is not installed:', String(error?.message ?? error))
  process.exit(1)
}

const binary = path.join(electronDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const MIN_BYTES = 100 * 1024 * 1024

const isUsable = () => {
  try {
    return fs.statSync(binary).size > MIN_BYTES
  } catch {
    return false
  }
}

if (!isUsable()) {
  const installer = path.join(electronDir, 'install.js')
  if (!fs.existsSync(installer)) {
    console.error('[ensure-electron] no dist and no install.js; reinstall the electron package')
    process.exit(1)
  }
  console.log('[ensure-electron] binary missing (electron 45 installs lazily); downloading ...')
  const started = Date.now()
  const run = spawnSync(process.execPath, [installer], { stdio: 'inherit', env: process.env })
  if (run.status !== 0) {
    console.error('[ensure-electron] download failed with exit', run.status)
    console.error('[ensure-electron] if GitHub is unreachable, set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/')
    process.exit(1)
  }
  console.log('[ensure-electron] downloaded in', Date.now() - started, 'ms')
}

if (!isUsable()) {
  console.error('[ensure-electron] binary still missing after install:', binary)
  process.exit(1)
}

const size = fs.statSync(binary).size
console.log('[ensure-electron] ok', JSON.stringify({ version: require('electron/package.json').version, size, binary }))
