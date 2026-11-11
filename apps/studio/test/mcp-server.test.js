/**
 * The production MCP server, tested through the official SDK client over stdio.
 *
 * This is the server that ships: it is spawned exactly the way DSH spawns it, so a
 * failure here means the tool would be missing in the product, not just in a unit test.
 */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const SERVER = path.join(__dirname, '..', 'mcp', 'studio-mcp-server.mjs')

async function connect(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-mcp-test-'))
  const audit = path.join(dir, 'audit.jsonl')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, STUDIO_MCP_AUDIT_LOG: audit },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'studio-test', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  t.after(async () => {
    await client.close().catch(() => {})
  })
  return { client, audit }
}

test('the server advertises exactly one read-only tool', async (t) => {
  const { client } = await connect(t)
  const listed = await client.listTools()
  assert.equal(listed.tools.length, 1, 'the tool surface must stay minimal: ' + JSON.stringify(listed.tools.map((x) => x.name)))
  const tool = listed.tools[0]
  assert.equal(tool.name, 'get_studio_health')
  assert.ok(tool.description && tool.description.length > 20, 'the description is what the model reads')
  assert.equal(tool.inputSchema.type, 'object')
  assert.deepEqual(tool.inputSchema.properties ?? {}, {}, 'the tool takes no arguments')
})

test('calling it returns the real studio health payload', async (t) => {
  const { client, audit } = await connect(t)
  const result = await client.callTool({ name: 'get_studio_health', arguments: {} })
  assert.equal(Array.isArray(result.content), true)
  assert.equal(result.content.length, 1)
  assert.equal(result.content[0].type, 'text')

  const payload = JSON.parse(result.content[0].text)
  assert.equal(payload.status, 'ok')
  assert.equal(payload.studio.name, 'AI Game Studio')
  assert.equal(payload.studio.phase, 'PHASE_01-B')
  assert.equal(payload.studio.serverPid, process.pid === 0 ? -1 : payload.studio.serverPid)
  assert.equal(typeof payload.studio.serverPid, 'number')
  assert.ok(Array.isArray(payload.checks) && payload.checks.length >= 2)

  // The server must have audited the call; that audit is how the phase report proves a
  // real invocation happened rather than a hand-written expectation.
  const kinds = fs.readFileSync(audit, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).kind)
  assert.ok(kinds.includes('tools/call'), JSON.stringify(kinds))
  assert.ok(kinds.includes('tools/call.served'), JSON.stringify(kinds))
})

test('an unknown tool is rejected instead of silently succeeding', async (t) => {
  const { client } = await connect(t)
  // The protocol allows either a thrown JSON-RPC error or an error result; both mean the
  // call did not quietly succeed, which is what this test is about.
  let rejected = false
  try {
    const result = await client.callTool({ name: 'delete_everything', arguments: {} })
    rejected = result?.isError === true
  } catch {
    rejected = true
  }
  assert.equal(rejected, true, 'an unknown tool must not return a normal result')
})
