import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRpcHandler,
  ok,
  err,
  PROTOCOL_VERSION,
  PLUGIN_VERSION,
  ENDPOINTS,
} from '../lib/rpc.js'
import { NoConnectionError } from '../lib/collectors.js'

const collector = {
  overview: async () => ({ fake: 'overview' }),
  processes: async () => ({ fake: 'processes' }),
  containers: async () => ({ available: false }),
  metaInfo: async () => ({
    connectionId: 'c1',
    hostname: 'example.com',
    source: 'ssh',
    capabilities: { overview: true, processes: true, docker: false },
  }),
}

test('RPC meta exposes version inside the value payload (never top-level)', async () => {
  const handler = createRpcHandler(collector)
  const result = await handler(ENDPOINTS.meta, {})
  assert.equal(result.ok, true)
  assert.equal(result.value.protocolVersion, PROTOCOL_VERSION)
  assert.equal(result.value.pluginVersion, PLUGIN_VERSION)
  assert.equal('protocolVersion' in result, false)
  assert.equal(result.value.connectionId, 'c1')
  assert.equal(result.value.capabilities.docker, false)
})

test('ok/err return standard RpcResult shapes', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, value: { a: 1 } })
  const e = err('boom')
  assert.equal(e.ok, false)
  assert.equal(e.error.code, 'internal')
  const n = err('gone', 'server-unavailable')
  assert.equal(n.error.code, 'server-unavailable')
})

test('unknown endpoint returns error', async () => {
  const handler = createRpcHandler(collector)
  const r = await handler('nope', {})
  assert.equal(r.ok, false)
  assert.ok(r.error.message.includes('unknown endpoint'))
})

test('endpoints route through the collector', async () => {
  const handler = createRpcHandler(collector)
  assert.deepEqual(await handler(ENDPOINTS.overview, {}), { ok: true, value: { fake: 'overview' } })
  assert.deepEqual(await handler(ENDPOINTS.processes, {}), { ok: true, value: { fake: 'processes' } })
  assert.deepEqual(await handler(ENDPOINTS.containers, {}), { ok: true, value: { available: false } })
})

test('NoConnectionError maps to wire-legal server-unavailable', async () => {
  const handler = createRpcHandler({
    overview: async () => { throw new NoConnectionError('no active SSH connection') },
    processes: async () => ({}),
    metaInfo: async () => { throw new NoConnectionError('no active SSH connection') },
  })
  const r = await handler(ENDPOINTS.overview, {})
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'server-unavailable')
  assert.match(r.error.message, /no active SSH connection/)
  const m = await handler(ENDPOINTS.meta, {})
  assert.equal(m.ok, false)
  assert.equal(m.error.code, 'server-unavailable')
})
