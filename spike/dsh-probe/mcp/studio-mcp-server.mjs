#!/usr/bin/env node
/**
 * Studio MCP tool server — PROTOTYPE for PHASE 00 only.
 *
 * Purpose: prove that DSH can call a Studio-owned read-only tool through the
 * official MCP bridge (`@deepseek-ai/dsh-mcp-client`), which is the only
 * sanctioned tool-registration path in DSH 0.1.5 (the SDK wire protocol has no
 * tool-registration method).
 *
 * Scope discipline: this exposes exactly one read-only tool, `get_studio_health`.
 * It performs no file writes and no privileged action, per docs/04 "先只读".
 *
 * Implementation note: the MCP handshake is implemented directly against the
 * public MCP stdio JSON-RPC contract to keep this spike dependency-free. The
 * production Studio gateway should use the official @modelcontextprotocol/sdk
 * server instead (see ADR-0002).
 *
 * Stdout is reserved for JSON-RPC frames; all diagnostics go to stderr or the
 * audit log. A stray stdout write would corrupt the transport.
 */
import fs from 'node:fs'
import path from 'node:path'

const SERVER_NAME = 'ai-game-studio-tools'
const SERVER_VERSION = '0.0.1-phase00'
const LOG_PATH = process.env.STUDIO_MCP_AUDIT_LOG ?? null
const STARTED_AT = Date.now()

/** Append one audit line; also mirrors to stderr so DSH logs show tool traffic. */
function audit(kind, payload) {
  const record = { ts: new Date().toISOString(), kind, ...payload }
  const line = JSON.stringify(record)
  process.stderr.write(`[studio-mcp] ${line}\n`)
  if (LOG_PATH) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true })
      fs.appendFileSync(LOG_PATH, `${line}\n`)
    } catch (error) {
      process.stderr.write(`[studio-mcp] audit write failed: ${error?.message ?? error}\n`)
    }
  }
}

/**
 * The single read-only business fact this phase exposes.
 * Deliberately returns deterministic Studio state, not model-generated content.
 */
function getStudioHealth() {
  return {
    status: 'ok',
    studio: {
      name: 'AI Game Studio',
      component: 'studio-mcp-tools',
      version: SERVER_VERSION,
      phase: 'PHASE_00',
      mode: 'feasibility-probe',
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      pid: process.pid,
      uptimeMs: Date.now() - STARTED_AT,
    },
    checks: [
      { id: 'mcp-transport', status: 'PASS', detail: 'stdio JSON-RPC session established' },
      { id: 'tool-policy', status: 'PASS', detail: 'read-only tool, no write capability registered' },
    ],
    generatedAt: new Date().toISOString(),
  }
}

const TOOLS = [
  {
    name: 'get_studio_health',
    description:
      'Read-only health snapshot of the AI Game Studio process: component version, current phase, runtime facts and self-check results. Takes no arguments and changes nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function handleToolCall(id, params) {
  const name = params?.name
  audit('tools/call', { name, arguments: params?.arguments ?? null })
  if (name !== 'get_studio_health') {
    replyError(id, -32602, `Unknown tool: ${String(name)}`)
    return
  }
  const payload = getStudioHealth()
  reply(id, {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: false,
  })
  audit('tools/call.served', { name, status: payload.status })
}

function handleRequest(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion ?? '2024-11-05'
      audit('initialize', { clientProtocolVersion: requested, clientInfo: params?.clientInfo ?? null })
      // Echo the client's requested version: this server uses no version-specific
      // features, so agreeing keeps the session valid across MCP revisions.
      reply(id, {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      })
      return
    }
    case 'tools/list':
      audit('tools/list', { count: TOOLS.length })
      reply(id, { tools: TOOLS })
      return
    case 'tools/call':
      handleToolCall(id, params)
      return
    case 'ping':
      reply(id, {})
      return
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      audit('unsupported.method', { method })
      replyError(id, -32601, `Method not found: ${String(method)}`)
  }
}

/** Line-delimited JSON-RPC reader. */
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      audit('parse.error', { line: line.slice(0, 200) })
      continue
    }
    // Notifications carry no id and expect no response.
    if (message.id === undefined) {
      audit('notification', { method: message.method })
      continue
    }
    try {
      handleRequest(message)
    } catch (error) {
      audit('handler.error', { method: message.method, message: String(error?.message ?? error) })
      replyError(message.id, -32603, 'Internal error')
    }
  }
})

process.stdin.on('end', () => {
  audit('stdin.end', {})
  process.exit(0)
})

audit('server.started', { serverName: SERVER_NAME, version: SERVER_VERSION, auditLog: LOG_PATH })
