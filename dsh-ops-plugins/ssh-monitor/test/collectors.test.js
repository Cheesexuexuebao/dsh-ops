import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createSshProcCollector,
  NoConnectionError,
  parseCpuInfo,
  parsePsText,
  splitMarkedSections,
} from '../lib/collectors.js'

function fixture(name) {
  return readFileSync(new URL(name, import.meta.url), 'utf8')
}

function buildOverviewStdout() {
  return [
    '===STAT===',
    fixture('fixtures/stat'),
    '===MEMINFO===',
    fixture('fixtures/meminfo'),
    '===LOADAVG===',
    fixture('fixtures/loadavg'),
    '===UPTIME===',
    fixture('fixtures/uptime'),
    '===CPUINFO===',
    fixture('fixtures/cpuinfo'),
    '===HOSTNAME===',
    'remote-box',
    '===OSREL===',
    '6.1.0-test',
    '===ARCH===',
    'x86_64',
    '===UNAME===',
    'Linux 6.1.0-test x86_64',
    '===OSRELEASE===',
    'PRETTY_NAME="Test OS 1.0"',
    'NAME="Test OS"',
    'VERSION="1.0"',
    '===MOUNTS===',
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
    '===DF===',
    fixture('fixtures/df.txt'),
    '===NETDEV===',
    fixture('fixtures/netdev'),
    '===ROUTE===',
    fixture('fixtures/route'),
    '===IPADDR===',
    '2: eth0    inet 10.0.0.5/24 brd 10.0.0.255 scope global eth0',
    '===TRIE===',
    '',
  ].join('\n')
}

function fakeSsh(opts = {}) {
  const activeId = opts.activeId === undefined ? 'c1' : opts.activeId
  const connections = opts.connections || [
    { id: 'c1', host: '10.0.0.1', port: 22, username: 'alice' },
  ]
  let overviewCalls = 0
  return {
    list: async () => ({ connections, activeId }),
    exec: async (id, command) => {
      if (opts.execFail) throw new Error('exec fail')
      if (String(command).includes('/proc/stat') || String(command).includes('===STAT===')) {
        overviewCalls += 1
        let stat = fixture('fixtures/stat')
        if (overviewCalls > 1) {
          // bump idle/total so second sample yields a usage number
          stat = 'cpu  130000 800 13000 680000 2500 700 950 0 0 0\n'
        }
        const body = buildOverviewStdout().replace(fixture('fixtures/stat'), stat)
        return { exitCode: 0, stdout: body, stderr: '' }
      }
      if (String(command).includes('ps ')) {
        return { exitCode: 0, stdout: fixture('fixtures/ps.txt'), stderr: '' }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected' }
    },
    _overviewCalls: () => overviewCalls,
  }
}

test('parseCpuInfo: Intel HT = 2 physical / 4 logical', () => {
  const info = parseCpuInfo(fixture('fixtures/cpuinfo'))
  assert.equal(info.logical, 4)
  assert.equal(info.physical, 2)
  assert.ok(info.model.includes('i5-6200U'))
})

test('splitMarkedSections + parsePsText', () => {
  const sec = splitMarkedSections('===STAT===\ncpu  1 2 3 4\n===HOSTNAME===\nhost\n')
  assert.ok(sec.STAT.includes('cpu'))
  assert.equal(sec.HOSTNAME.trim(), 'host')
  const rows = parsePsText(fixture('fixtures/ps.txt'))
  assert.equal(rows.length, 4)
  assert.equal(rows[1].pid, 100)
  assert.equal(rows[1].user, 'alice')
  assert.ok(rows[1].command.includes('node'))
})

test('no active connection → NoConnectionError', async () => {
  const c = createSshProcCollector(fakeSsh({ activeId: null, connections: [] }))
  await assert.rejects(() => c.overview({}), (e) => e instanceof NoConnectionError)
})

test('unknown connectionId → NoConnectionError', async () => {
  const c = createSshProcCollector(fakeSsh())
  await assert.rejects(() => c.overview({ connectionId: 'missing' }), (e) => e instanceof NoConnectionError)
})

test('overview: first sample cpuUsage null, second sample number', async () => {
  const ssh = fakeSsh()
  const c = createSshProcCollector(ssh, { overviewCacheMs: 0 })
  const o1 = await c.overview({})
  assert.equal(o1.cpuUsage, null)
  assert.equal(o1.hostname, 'remote-box')
  assert.equal(o1.cpuCores, 4)
  assert.equal(o1.source, 'ssh')
  assert.ok(o1.memoryTotal > 0)
  assert.equal(o1.load1, 0.61)
  assert.equal(o1.uptimeSeconds, 86400)

  const o2 = await c.overview({})
  assert.equal(typeof o2.cpuUsage, 'number')
})

test('processes: search + pagination', async () => {
  const c = createSshProcCollector(fakeSsh(), { processCacheMs: 0 })
  const all = await c.processes({ limit: 50 })
  assert.equal(all.total, 4)
  assert.equal(all.matched, 4)
  assert.equal(all.source, 'ssh')
  assert.equal(all.processes.length, 4)

  const nginx = await c.processes({ search: 'nginx', limit: 10 })
  assert.equal(nginx.matched, 2)
  assert.equal(nginx.processes.every((p) => p.command.includes('nginx')), true)

  const page = await c.processes({ limit: 2, offset: 0, sort: 'cpu', order: 'desc' })
  assert.equal(page.processes.length, 2)
  assert.ok(page.processes[0].cpu >= page.processes[1].cpu)
})

test('overview includes disk + network from remote df / proc', async () => {
  const c = createSshProcCollector(fakeSsh(), { overviewCacheMs: 0 })
  const o = await c.overview({})
  assert.equal(o.environment.systemSource, 'ssh')
  assert.equal(o.environment.mode, 'ssh')
  assert.equal(o.environment.sources.mounts, 'df -T -kP')
  assert.equal(o.diskAvailable, true)
  assert.equal(o.diskUsage, 50)
  assert.ok(o.disks.some((d) => d.mount === '/'))
  assert.ok(Array.isArray(o.network.interfaces))
  assert.ok(o.network.interfaces.some((i) => i.name === 'eth0' && i.ip === '10.0.0.5'))
  assert.ok(o.network.primary === 'eth0' || o.network.interfaces.some((i) => i.primary))
  assert.equal(o.kernelVersion, '6.1.0-test')
  assert.equal(o.arch, 'x86_64')
})

test('parseCpuInfo accepts compact grep cpuinfo', async () => {
  const { parseCpuInfo } = await import('../lib/collectors.js')
  const compact = [
    'processor\t: 0',
    'physical id\t: 0',
    'model name\t: Test CPU',
    'cpu MHz\t\t: 2000.000',
    'processor\t: 1',
    'physical id\t: 0',
    'model name\t: Test CPU',
    'cpu MHz\t\t: 2000.000',
  ].join('\n')
  const info = parseCpuInfo(compact)
  assert.equal(info.logical, 2)
  assert.equal(info.physical, 1)
  assert.equal(info.model, 'Test CPU')
})


test('parseCpuMeta reads compact section', async () => {
  const { parseCpuMeta } = await import('../lib/collectors.js')
  const info = parseCpuMeta('logical 33\nphysical 2\nmodel Xeon\nmhz 2000.5\n')
  assert.equal(info.logical, 33)
  assert.equal(info.physical, 2)
  assert.equal(info.model, 'Xeon')
  assert.equal(info.clockMhz, 2000.5)
})

test('parseDfText skips tmpfs', async () => {
  const { parseDfText } = await import('../lib/collectors.js')
  const d = parseDfText(fixture('fixtures/df.txt'))
  assert.equal(d.available, true)
  assert.ok(!d.mounts.some((m) => m.mount === '/run'))
})

test('parseDiskFromMountsAndDf mirrors host mounts+size join', async () => {
  const { parseDiskFromMountsAndDf } = await import('../lib/collectors.js')
  const mounts = [
    '/dev/sda1 / ext4 rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid 0 0',
    'overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0',
  ].join('\n')
  const df = [
    'Filesystem     Type 1024-blocks      Used Available Capacity Mounted on',
    '/dev/sda1      ext4    20971520  10485760  10485760      50% /',
    'tmpfs          tmpfs      65536         0     65536       0% /run',
  ].join('\n')
  const d = parseDiskFromMountsAndDf(mounts, df)
  assert.equal(d.available, true)
  assert.equal(d.primary.mount, '/')
  assert.equal(d.mounts.length, 1)
  assert.equal(d.primary.total, 20971520 * 1024)
})

test('containers stub unavailable', async () => {
  const c = createSshProcCollector(fakeSsh())
  const d = await c.containers()
  assert.equal(d.available, false)
})

test('metaInfo carries connectionId', async () => {
  const c = createSshProcCollector(fakeSsh())
  const m = await c.metaInfo({})
  assert.equal(m.connectionId, 'c1')
  assert.equal(m.hostname, '10.0.0.1')
  assert.equal(m.capabilities.docker, false)
  assert.equal(m.status.systemSource, 'ssh')
})

test('containers: unavailable when sock missing', async () => {
  const ssh = {
    list: async () => ({ activeId: 'c1', connections: [{ id: 'c1' }] }),
    exec: async (_id, command) => {
      if (String(command).includes('docker.sock') && String(command).includes('test -S')) {
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const c = createSshProcCollector(ssh, { dockerListCacheMs: 0, dockerStatsCacheMs: 0 })
  const r = await c.containers({})
  assert.equal(r.available, false)
  assert.ok(r.error)
  assert.equal(r.containers.length, 0)
})

test('containers: honors config.dockerSocket path in probe/curl', async () => {
  const custom = '/run/custom-docker.sock'
  const seen = []
  const ssh = {
    list: async () => ({ activeId: 'c1', connections: [{ id: 'c1' }] }),
    exec: async (_id, command) => {
      seen.push(String(command))
      if (String(command).includes('test -S')) {
        assert.ok(String(command).includes(custom))
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false }
      }
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false }
    },
  }
  const c = createSshProcCollector(ssh, { dockerSocket: custom, dockerListCacheMs: 0 })
  await c.containers({})
  assert.ok(seen.some((c) => c.includes(custom)))
})

test('containers: list + stats over Engine API script', async () => {
  const listJson = JSON.stringify([{
    Id: 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899',
    Names: ['/nginx'],
    Image: 'nginx:latest',
    State: 'running',
    Status: 'Up 2 hours (healthy)',
    Ports: [{ IP: '0.0.0.0', PublicPort: 80, PrivatePort: 80, Type: 'tcp' }],
  }])
  const statsJson = JSON.stringify({
    cpu_stats: {
      cpu_usage: { total_usage: 200 },
      system_cpu_usage: 1000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 100 },
      system_cpu_usage: 500,
    },
    memory_stats: { usage: 50 * 1024 * 1024, limit: 200 * 1024 * 1024 },
  })
  const ssh = {
    list: async () => ({ activeId: 'c1', connections: [{ id: 'c1' }] }),
    exec: async (_id, command) => {
      const cmd = String(command)
      if (cmd.includes('test -S')) {
        return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false }
      }
      if (cmd.includes('/version')) {
        return { exitCode: 0, stdout: JSON.stringify({ ApiVersion: '1.41' }) + '\n', stderr: '', timedOut: false }
      }
      if (cmd.includes('/containers/json')) {
        assert.ok(cmd.includes('python3') || cmd.includes('jq'))
        assert.ok(cmd.includes('Names') && cmd.includes('Ports'))
        return { exitCode: 0, stdout: listJson + '\n', stderr: '', timedOut: false }
      }
      if (cmd.includes('/stats')) {
        return { exitCode: 0, stdout: statsJson + '\n', stderr: '', timedOut: false }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected: ' + cmd.slice(0, 80), timedOut: false }
    },
  }
  const c = createSshProcCollector(ssh, { dockerListCacheMs: 0, dockerStatsCacheMs: 0 })
  const r = await c.containers({ stats: true })
  assert.equal(r.available, true)
  assert.equal(r.summary.total, 1)
  assert.equal(r.summary.running, 1)
  assert.equal(r.containers[0].name, 'nginx')
  assert.equal(r.containers[0].health, 'healthy')
  assert.equal(r.containers[0].ports[0].hostPort, 80)
  assert.ok(typeof r.containers[0].cpuUsage === 'number')
  assert.ok(typeof r.containers[0].memoryUsagePct === 'number')
})

test('containers: truncated list stdout is an error, not parsed', async () => {
  const ssh = {
    list: async () => ({ activeId: 'c1', connections: [{ id: 'c1' }] }),
    exec: async (_id, command) => {
      const cmd = String(command)
      if (cmd.includes('test -S')) {
        return { exitCode: 0, stdout: 'ok\n', stderr: '', timedOut: false }
      }
      if (cmd.includes('/version')) {
        return { exitCode: 0, stdout: JSON.stringify({ ApiVersion: '1.41' }) + '\n', stderr: '', timedOut: false }
      }
      if (cmd.includes('/containers/json')) {
        return {
          exitCode: 0,
          stdout: '[{"Id":"aa","Names":["/nginx"],"bogus"',
          stderr: '',
          timedOut: false,
          truncated: true,
        }
      }
      return { exitCode: 1, stdout: '', stderr: 'unexpected: ' + cmd.slice(0, 80), timedOut: false }
    },
  }
  const c = createSshProcCollector(ssh, { dockerListCacheMs: 0, dockerStatsCacheMs: 0 })
  const r = await c.containers({ stats: false })
  assert.equal(r.available, false)
  assert.match(String(r.error), /truncated/i)
  assert.equal(r.containers.length, 0)
})
