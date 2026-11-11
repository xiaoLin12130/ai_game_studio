#!/usr/bin/env node
/** Copy the static renderer assets next to their compiled script. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const from = path.join(root, 'src', 'renderer')
const to = path.join(root, 'dist', 'renderer')
fs.mkdirSync(to, { recursive: true })
for (const name of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(from, name), path.join(to, name))
  console.log('[copy-assets]', name)
}
