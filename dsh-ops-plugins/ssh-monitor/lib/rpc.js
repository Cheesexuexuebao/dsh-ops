/**
 * dsh-ssh-monitor — Host RPC contract + registration.
 *
 * Registers /ssh-monitor so callers read remote metrics through the Host only.
 * Version metadata lives inside the `meta` endpoint value (DSH rpcResultSchema
 * strips unknown top-level fields).
 * @module dsh-ssh-monitor/rpc
 */

import { createRequire } from 'node:module'
import crypto from 'node:crypto'
import { NoConnectionError } from './collectors.js'

/** Logical RPC channel owned by this plugin. */
export const RPC_CHANNEL = '/ssh-monitor'

/** Bump on any breaking change to the response/payload contract. */
export const PROTOCOL_VERSION = 1

const require = createRequire(import.meta.url)
export const PLUGIN_VERSION = require('../package.json').version

export const ENDPOINTS = Object.freeze({
  meta: 'meta',
  overview: 'overview',
  processes: 'processes',
  containers: 'containers',
})

const HOST_STARTED_AT = Date.now()
const RUNTIME_ID = crypto.randomUUID()

export function ok(value) {
  return { ok: true, value }
}

/**
 * Error branch — must use a code allowed by DSH connection rpcErrorSchema
 * (bad-request | cancelled | server-unavailable | internal | …).
 * Plugin-private codes like `no-connection` fail wire validation and surface
 * as opaque Zod invalid_union in the browser.
 * @param {string} message
 * @param {string} [code='internal']
 */
export function err(message, code = 'internal') {
  return { ok: false, error: { code, message, details: {} } }
}

/**
 * Pure RPC handler. Exported for unit tests.
 * @param collector - from createSshProcCollector
 */
export function createRpcHandler(collector) {
  return async (endpoint, payload) => {
    try {
      switch (endpoint) {
        case ENDPOINTS.meta:
          return ok({
            protocolVersion: PROTOCOL_VERSION,
            pluginVersion: PLUGIN_VERSION,
            runtimeId: RUNTIME_ID,
            startedAt: HOST_STARTED_AT,
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            ...(collector.metaInfo ? await collector.metaInfo(payload || {}) : {}),
          })
        case ENDPOINTS.overview:
          return ok(await collector.overview(payload || {}))
        case ENDPOINTS.processes:
          return ok(await collector.processes(payload || {}))
        case ENDPOINTS.containers:
          return ok(await collector.containers(payload || {}))
        default:
          return err('unknown endpoint: ' + String(endpoint))
      }
    } catch (error) {
      if (error instanceof NoConnectionError) {
        // Wire-legal DSH code; client detects SSH-not-connected via message.
        return err(error.message, 'server-unavailable')
      }
      return err(error instanceof Error ? error.message : String(error))
    }
  }
}

/**
 * Register /ssh-monitor when `connection` is available.
 * @param ctx - host plugin context
 * @param collector - from createSshProcCollector
 */
export function registerSshMonitorRpc(ctx, collector) {
  ctx.inject(['connection'], (sctx) => {
    const handler = createRpcHandler(collector)

    sctx.effect(() => {
      const dispose = sctx.connection.rpc.handle(RPC_CHANNEL, handler, { authority: 'trusted-host' })
      return () => { void dispose() }
    }, 'ssh-monitor: rpc channel')
  })
}
