/**
 * dsh-ssh-monitor — Host half.
 *
 * Mounts a read-only remote metrics collector behind the /ssh-monitor RPC.
 * Requires ctx.ssh (transport seam). No browser half in this package.
 * @module dsh-ssh-monitor
 */
import { createSshProcCollector } from './collectors.js'
import { registerSshMonitorRpc } from './rpc.js'

/** Stable cordis plugin name (matches cordis.patch.yml insert id). */
export const name = 'ssh-monitor'

/** Needs the SSH transport seam. */
export const inject = ['ssh']

/**
 * Plugin entry.
 * @param ctx - plugin context (must provide ctx.ssh).
 * @param config - optional overrides (processLimit, cache windows, dockerSocket).
 * @param {string} [config.dockerSocket='/var/run/docker.sock'] absolute path to
 *   the remote Docker Engine unix socket. Relative paths are ignored.
 */
export function apply(ctx, config = {}) {
  const collector = createSshProcCollector(ctx.ssh, config)
  registerSshMonitorRpc(ctx, collector)
}
