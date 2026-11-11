#!/usr/bin/env node
/**
 * Studio MCP tool server — production entry, built on the official MCP SDK.
 *
 * PHASE 00 used a hand-written JSON-RPC loop to prove the bridge worked. This is the
 * replacement: the protocol is handled by @modelcontextprotocol/sdk, so framing,
 * capability negotiation and schema validation are the official implementation's job.
 *
 * Scope is deliberately one read-only tool. Studio exposes no write capability to a model
 * in this phase.
 *
 * stdout belongs to the transport; every diagnostic goes to stderr or the audit log.
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')

const SERVER_NAME = 'ai-game-studio-tools'
const SERVER_VERSION = process.env.STUDIO_MCP_VERSION ?? '0.1.0-phase01b'
const LOG_PATH = process.env.STUDIO_MCP_AUDIT_LOG ?? null
const STARTED_AT = Date.now()

/** Append one audit line; mirrors to stderr so the DSH log shows tool traffic too. */
function audit(kind, payload) {
  const record = { ts: new Date().toISOString(), pid: process.pid, kind, ...payload }
  const line = JSON.stringify(record)
  process.stderr.write('[studio-mcp] ' + line + '\n')
  if (!LOG_PATH) return
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
    fs.appendFileSync(LOG_PATH, line + '\n')
  } catch (error) {
    process.stderr.write('[studio-mcp] audit write failed: ' + String(error?.message ?? error) + '\n')
  }
}

/** The read-only business fact this phase exposes. Deterministic, not model-generated. */
function getStudioHealth() {
  return {
    status: 'ok',
    studio: {
      name: 'AI Game Studio',
      component: 'studio-mcp-tools',
      version: SERVER_VERSION,
      phase: 'PHASE_01-B',
      serverPid: process.pid,
    },
    runtime: { node: process.version, platform: process.platform, uptimeMs: Date.now() - STARTED_AT },
    checks: [
      { id: 'mcp-transport', status: 'PASS', detail: 'official MCP SDK stdio session' },
      { id: 'tool-policy', status: 'PASS', detail: 'read-only tool, no write capability registered' },
    ],
    generatedAt: new Date().toISOString(),
  }
}

const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })

server.registerTool(
  'get_studio_health',
  {
    title: 'Get Studio health',
    description:
      'Read-only health snapshot of the AI Game Studio process: component version, current phase, runtime facts and self-check results. Takes no arguments and changes nothing.',
    inputSchema: {},
  },
  async () => {
    audit('tools/call', { name: 'get_studio_health' })
    const payload = getStudioHealth()
    audit('tools/call.served', { name: 'get_studio_health', status: payload.status })
    return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
  },
)

server.server.oninitialized = () => {
  const client = server.server.getClientVersion?.() ?? null
  const capabilities = server.server.getClientCapabilities?.() ?? null
  audit('initialize.completed', { client, capabilities })
}

audit('server.start', { server: SERVER_NAME, version: SERVER_VERSION, node: process.version })

const transport = new StdioServerTransport()
await server.connect(transport)
audit('transport.connected', {})

const shutdown = (reason) => {
  audit('server.stop', { reason })
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.stdin.on('end', () => shutdown('stdin-eof'))
