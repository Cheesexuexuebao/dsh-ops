/**
 * dsh-ssh-monitor — remote /proc + ps collectors via ctx.ssh.
 *
 * Read-only: batched cat of /proc files, a fixed `ps` format, and Docker
 * Engine API via `curl --unix-socket` over SSH. No arbitrary path RPC.
 * @module dsh-ssh-monitor/collectors
 */

const DEFAULT_PROCESS_LIMIT = 50
const MAX_PROCESS_LIMIT = 200
const OVERVIEW_CACHE_MS = 2000
const PROCESS_CACHE_MS = 1500
const EXEC_TIMEOUT_MS = 15_000
const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'
const DOCKER_LIST_CACHE_MS = 5_000
const DOCKER_STATS_CACHE_MS = 3_000
const DOCKER_API_DEFAULT = 'v1.41'

const EMPTY_DOCKER_SUMMARY = {
  total: 0,
  running: 0,
  stopped: 0,
  crashed: 0,
  paused: 0,
  restarting: 0,
  dead: 0,
  healthy: 0,
  unhealthy: 0,
  starting: 0,
  issues: 0,
}

// ctx.ssh.exec stdout is capped at 64KiB. Only fetch fields the UI needs;
// put net early; never dump full cpuinfo / mounts / fib_trie.
const OVERVIEW_SCRIPT = [
  "echo '===HOSTNAME==='",
  '(hostname -f 2>/dev/null || hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || true)',
  "echo '===OSREL==='",
  'cat /proc/sys/kernel/osrelease 2>/dev/null || true',
  "echo '===ARCH==='",
  '(uname -m 2>/dev/null || true)',
  "echo '===OSRELEASE==='",
  "grep -E '^(PRETTY_NAME|NAME|VERSION)=' /etc/os-release 2>/dev/null || true",
  "echo '===STAT==='",
  "grep '^cpu ' /proc/stat | head -1",
  "echo '===LOADAVG==='",
  'cat /proc/loadavg',
  "echo '===UPTIME==='",
  'cat /proc/uptime',
  "echo '===MEMINFO==='",
  "grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo",
  // Network before bulky disk/cpu — .31-style hosts with many mounts/veth truncate otherwise.
  "echo '===NETDEV==='",
  '{ head -n 2 /proc/net/dev 2>/dev/null; grep -vE "^[[:space:]]*(veth|br-|docker)" /proc/net/dev 2>/dev/null; } || true',
  "echo '===ROUTE==='",
  'cat /proc/net/route 2>/dev/null || true',
  "echo '===IPADDR==='",
  '(ip -4 -o addr show 2>/dev/null | grep -vE " (docker|br-|veth)" || true)',
  "echo '===DF==='",
  '(df -T -kP -x tmpfs -x devtmpfs -x squashfs 2>/dev/null || df -kP 2>/dev/null || true) | head -n 40',
  "echo '===CPUMETA==='",
  'printf "logical %s\\n" "$(grep -c ^processor /proc/cpuinfo 2>/dev/null || echo 0)"',
  'printf "physical %s\\n" "$(grep \'physical id\' /proc/cpuinfo 2>/dev/null | sort -u | wc -l | tr -d \'[:space:]\')"',
  'printf "model %s\\n" "$(grep -m1 \'model name\' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed \'s/^ *//\')"',
  'printf "mhz %s\\n" "$(grep -m1 \'cpu MHz\' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed \'s/^ *//\')"',
].join('; ')

/** Fixed columns for parsePsText. */
const PS_SCRIPT = "ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,args= --sort=-pcpu 2>/dev/null || ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,args="

export class NoConnectionError extends Error {
  constructor(message = 'no active SSH connection') {
    super(message)
    this.name = 'NoConnectionError'
  }
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function clampInt(n, lo, hi) {
  const v = Number.isFinite(n) ? Math.floor(n) : lo
  return Math.max(lo, Math.min(hi, v))
}

/** Split marker-separated batch output into a map of section → text. */
export function splitMarkedSections(out) {
  const sections = {}
  let current = null
  const chunks = { __pre: [] }
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^===([A-Z0-9_]+)===\s*$/)
    if (m) {
      current = m[1]
      chunks[current] = []
      continue
    }
    const key = current || '__pre'
    if (!chunks[key]) chunks[key] = []
    chunks[key].push(line)
  }
  for (const [k, lines] of Object.entries(chunks)) {
    if (k === '__pre') continue
    sections[k] = lines.join('\n')
  }
  return sections
}

export function parseCpuInfo(text) {
  const info = { logical: 0, physical: null, model: '', clockMhz: null }
  if (!text) return info
  let phys = null
  let core = null
  let seenPhysical = false
  const pairs = new Set()
  function finalize() {
    if (phys != null || core != null) {
      pairs.add((phys == null ? '' : phys) + '|' + (core == null ? '' : core))
    }
  }
  for (const line of String(text).split('\n')) {
    const t = line.trim()
    const colon = t.indexOf(':')
    if (colon < 0) continue
    const key = t.slice(0, colon).trim()
    const val = t.slice(colon + 1).trim()
    if (key === 'processor') {
      finalize()
      info.logical += 1
      phys = null
      core = null
    } else if (key === 'physical id') {
      seenPhysical = true
      phys = val
    } else if (key === 'core id') {
      core = val
    } else if (key === 'model name' && !info.model) {
      info.model = val
    } else if (key === 'cpu MHz' && info.clockMhz == null && Number.isFinite(parseFloat(val))) {
      info.clockMhz = parseFloat(val)
    }
  }
  finalize()
  info.logical = info.logical || null
  info.physical = seenPhysical && pairs.size > 0 ? pairs.size : null
  return info
}

/** Compact CPUMETA section: logical/physical/model/mhz one line each. */
export function parseCpuMeta(text) {
  const info = { logical: null, physical: null, model: '', clockMhz: null }
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(logical|physical|model|mhz)\s+(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'logical') {
      const n = Number(val)
      info.logical = Number.isFinite(n) && n > 0 ? n : null
    } else if (key === 'physical') {
      const n = Number(val)
      info.physical = Number.isFinite(n) && n > 0 ? n : null
    } else if (key === 'model') {
      info.model = val
    } else if (key === 'mhz') {
      const n = parseFloat(val)
      if (Number.isFinite(n)) info.clockMhz = n
    }
  }
  return info
}

export function parseCpuAggregate(statText) {
  const line = String(statText || '').split('\n').find((l) => l.startsWith('cpu '))
  if (!line) return null
  const nums = line.trim().split(/\s+/).slice(1).map(Number)
  const idle = (nums[3] || 0) + (nums[4] || 0)
  const total = (nums[0] || 0) + (nums[1] || 0) + (nums[2] || 0) + idle
    + (nums[5] || 0) + (nums[6] || 0) + (nums[7] || 0)
  return { idle, total }
}

export function parseMemInfoKb(text) {
  const out = {}
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Za-z_]+):\s+(\d+)\s*kB/)
    if (m) out[m[1]] = Number(m[2])
  }
  return out
}

export function parseLoadavg(text) {
  const parts = String(text || '').trim().split(/\s+/)
  if (parts.length < 3) return null
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])]
}

export function parseUptimeSeconds(text) {
  const first = String(text || '').trim().split(/\s+/)[0]
  const n = Number(first)
  return Number.isFinite(n) ? n : null
}

// Pseudo / transient fs — aligned with side-monitor. overlay is NOT blanket-skipped
// (many remotes use overlay as /); only skip docker-internal overlay mounts below.
const PSEUDO_DF_FS = /^(tmpfs|devtmpfs|squashfs|proc|sysfs|cgroup2?|devpts|mqueue|shm|hugetlbfs|ramfs|securityfs|debugfs|tracefs|pstore|configfs|fusectl|autofs|nsfs|binfmt_misc|bpf)$/i
const VIRTUAL_IFACE_RE = /^(lo|docker\d*|br-|veth|virbr\d*|tailscale\d*|tun\d*|tap\d*|wg\d*|flannel|cali|kube-|cni\d*|vxlan)/

/**
 * Parse `df -kP` / `df -T -kP` / `df -B1 -P` into disk KPI + mount list.
 * Side-monitor uses /proc/mounts + statfs; over SSH, df is the portable equivalent.
 */
export function parseDfText(text) {
  const empty = {
    available: false,
    primary: { mount: '/', used: 0, total: 0, usage: 0 },
    mounts: [],
  }
  const lines = String(text || '').trim().split('\n').filter(Boolean)
  if (lines.length < 2) return empty
  const header = lines[0].toLowerCase()
  const scale = /1024-blocks|1k-blocks|1k-blocks/.test(header) || /\b1k\b/.test(header)
    ? 1024
    : (/1b-blocks|1-blocks|bytes/.test(header) ? 1 : 1024)
  const hasType = /\btype\b/.test(header)
  const mounts = []
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/)
    // Filesystem [Type] blocks used avail capacity% mount…
    if (parts.length < (hasType ? 7 : 6)) continue
    const mount = parts[parts.length - 1]
    const used = Number(parts[parts.length - 4])
    const total = Number(parts[parts.length - 5])
    let filesystem
    let fstype = ''
    if (hasType) {
      fstype = parts[parts.length - 6] || ''
      filesystem = parts.slice(0, parts.length - 6).join(' ')
    } else {
      filesystem = parts.slice(0, parts.length - 5).join(' ')
    }
    if (!Number.isFinite(total) || total <= 0) continue
    const typeOrFs = fstype || filesystem
    if (PSEUDO_DF_FS.test(typeOrFs) || PSEUDO_DF_FS.test(filesystem)) continue
    // Match side-monitor: drop docker/containerd overlay junk, keep real root overlay.
    if (/^overlay$/i.test(typeOrFs) && /(overlay2|containers)/.test(mount)) continue
    if (!mount || mount.startsWith('/snap') || mount === '/dev' || mount.startsWith('/dev/')) continue
    if (mount.startsWith('/run/') || mount.startsWith('/sys/') || mount.startsWith('/proc/')) continue
    const totalB = total * scale
    const usedB = used * scale
    mounts.push({
      mount,
      filesystem: fstype || filesystem,
      used: usedB,
      total: totalB,
      usage: round1((usedB / totalB) * 100),
    })
  }
  return finalizeDiskMounts(mounts)
}

function unescapeMount(s) {
  return String(s || '')
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\')
}

function finalizeDiskMounts(mounts) {
  const empty = {
    available: false,
    primary: { mount: '/', used: 0, total: 0, usage: 0 },
    mounts: [],
  }
  if (!mounts.length) return empty
  // Same filesystem often appears at several paths — dedup by size, prefer /.
  const bySize = new Map()
  for (const m of mounts) {
    const key = m.total + '|' + m.used
    const prev = bySize.get(key)
    if (!prev || m.mount === '/' || m.mount.length < prev.mount.length) bySize.set(key, m)
  }
  const uniq = Array.from(bySize.values())
  uniq.sort((a, b) =>
    (a.mount === '/' ? -1 : b.mount === '/' ? 1 : 0) || (b.usage - a.usage)
  )
  const primary = uniq.find((d) => d.mount === '/') || uniq[0]
  return {
    available: true,
    primary: { mount: primary.mount, used: primary.used, total: primary.total, usage: primary.usage },
    mounts: uniq,
  }
}

/**
 * Mirror side-monitor disk(): /proc/mounts decides which mounts matter;
 * df supplies sizes (SSH stand-in for local statfs).
 */
export function parseDiskFromMountsAndDf(mountsText, dfText) {
  const fromDf = parseDfText(dfText)
  const byMount = new Map(fromDf.mounts.map((m) => [m.mount, m]))
  const mounts = []
  for (const line of String(mountsText || '').split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const mount = unescapeMount(parts[1])
    const fstype = parts[2]
    if (PSEUDO_DF_FS.test(fstype)) continue
    if (fstype === 'overlay' && /(overlay2|containers)/.test(mount)) continue
    if (!mount || mount.startsWith('/snap') || mount === '/dev' || mount.startsWith('/dev/')) continue
    if (mount.startsWith('/run/') || mount.startsWith('/sys/') || mount.startsWith('/proc/')) continue
    const sized = byMount.get(mount)
    if (!sized || !sized.total) continue
    mounts.push({
      mount,
      filesystem: fstype,
      used: sized.used,
      total: sized.total,
      usage: sized.usage,
    })
  }
  const merged = finalizeDiskMounts(mounts)
  // If /proc/mounts is empty/unusable but df worked, keep df-only result.
  return merged.available ? merged : fromDf
}

/** Snapshot /proc/net/dev → { iface: { rx, tx } } bytes. */
export function parseNetDev(text) {
  const out = {}
  for (const line of String(text || '').split('\n').slice(2)) {
    const m = line.trim().match(/^([^:]+):\s+(.+)$/)
    if (!m) continue
    const nums = m[2].trim().split(/\s+/).map(Number)
    if (nums.length >= 9) out[m[1].trim()] = { rx: nums[0] || 0, tx: nums[8] || 0 }
  }
  return out
}

/** `ip -4 -o addr show` → iface → IPv4 (compact; avoids huge fib_trie). */
export function parseIpDashOAddr(text) {
  const map = new Map()
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\//)
    if (m && !map.has(m[1])) map.set(m[1], m[2])
  }
  return map
}

export function parseDefaultRouteIface(text) {
  let best = null
  for (const line of String(text || '').split('\n').slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 11) continue
    if (parts[1] !== '00000000') continue
    const metric = Number(parts[6]) || 0
    if (best === null || metric < best.metric) best = { iface: parts[0], metric }
  }
  return best ? best.iface : null
}

function routeHexToInt(hex) {
  const v = parseInt(hex, 16) >>> 0
  return ((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >> 8) & 0xff00) | ((v >> 24) & 0xff)
}

function ipv4ToInt(s) {
  const p = s.split('.').map(Number)
  return (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0)
}

/** iface → IPv4 from fib_trie + route (same idea as side-monitor). */
export function parseInterfaceIpv4Map(trieText, routeText) {
  const map = new Map()
  const trie = String(trieText || '')
  if (!trie) return map
  const addrs = new Set()
  const trieLines = trie.split('\n')
  for (let i = 0; i < trieLines.length - 1; i++) {
    const m = trieLines[i].match(/^\s*\|--\s+(\d+\.\d+\.\d+\.\d+)\s*$/)
    if (!m) continue
    if (/^\s*\/32\s+host\s+LOCAL\b/.test(trieLines[i + 1])) addrs.add(m[1])
  }
  const subnets = []
  for (const line of String(routeText || '').split('\n').slice(1)) {
    const p = line.trim().split(/\s+/)
    if (p.length < 11) continue
    if (parseInt(p[2], 16) !== 0) continue
    const dest = parseInt(p[1], 16)
    if (dest === 0) continue
    subnets.push({ iface: p[0], net: routeHexToInt(p[1]), mask: routeHexToInt(p[7]) })
  }
  for (const addr of addrs) {
    let iface = null
    if (addr.startsWith('127.')) iface = 'lo'
    else {
      const n = ipv4ToInt(addr)
      const hit = subnets.find((s) => ((n & s.mask) >>> 0) === ((s.net & s.mask) >>> 0))
      iface = hit ? hit.iface : null
    }
    if (iface && !map.has(iface)) map.set(iface, addr)
  }
  return map
}

/**
 * Parse `ps -eo pid=,ppid=,user=,pcpu=,pmem=,rss=,args=` output.
 * @returns {Array<{pid:number,ppid:number,user:string,cpu:number,mem:number,rssKb:number,command:string,name:string}>}
 */
export function parsePsText(text) {
  const rows = []
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/)
    if (!m) continue
    const command = m[7].trim()
    const name = command.split(/\s+/)[0].replace(/^.*\//, '') || command.slice(0, 32)
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      user: m[3],
      cpu: Number(m[4]),
      mem: Number(m[5]),
      rssKb: Number(m[6]),
      command,
      name,
    })
  }
  return rows
}

export function resolveDockerSocket(config = {}) {
  const raw = config.dockerSocket
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_DOCKER_SOCKET
  const path = raw.trim()
  if (!path.startsWith('/')) {
    console.warn('[ssh-monitor] dockerSocket must be absolute; using default', DEFAULT_DOCKER_SOCKET)
    return DEFAULT_DOCKER_SOCKET
  }
  return path
}

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, `'\"'\"'`) + "'"
}

function dockerCurlCmd(sockPath, apiPath) {
  // apiPath e.g. "/v1.41/containers/json?all=1"
  const sock = shellSingleQuote(sockPath)
  return (
    'command -v curl >/dev/null 2>&1 || { echo \'{"__error":"curl not found"}\'; exit 0; }; ' +
    'curl -sS --max-time 8 --unix-socket ' + sock +
    ' http://localhost' + apiPath + ' 2>/dev/null || echo \'{"__error":"curl failed"}\''
  )
}

const DOCKER_LIST_PY = [
  'import json,sys',
  'try:',
  ' d=json.load(sys.stdin)',
  'except Exception:',
  ' d={"__error":"docker: bad json"}',
  'print(json.dumps([{"Id":c.get("Id"),"Names":c.get("Names"),"Image":c.get("Image"),"State":c.get("State"),"Status":c.get("Status"),"Ports":c.get("Ports")} for c in d] if isinstance(d,list) else d,separators=(",",":")))',
].join('\n')

const DOCKER_LIST_JQ = 'if type=="array" then map({Id,Names,Image,State,Status,Ports}) else . end'

/** curl list, then project on the remote so SSH stdout stays under 64KiB. */
function dockerListCmd(sockPath, apiPath) {
  const sock = shellSingleQuote(sockPath)
  const curlGet = (
    'curl -sS --max-time 8 --unix-socket ' + sock +
    ' http://localhost' + apiPath + ' 2>/dev/null || echo \'{"__error":"curl failed"}\''
  )
  return (
    'command -v curl >/dev/null 2>&1 || { echo \'{"__error":"curl not found"}\'; exit 0; }; ' +
    'if command -v python3 >/dev/null 2>&1; then ' +
      '(' + curlGet + ') | python3 -c ' + shellSingleQuote(DOCKER_LIST_PY) + '; ' +
    'elif command -v jq >/dev/null 2>&1; then ' +
      '(' + curlGet + ') | jq -c ' + shellSingleQuote(DOCKER_LIST_JQ) + '; ' +
    'else echo \'{"__error":"python3 or jq required to project container list"}\'; fi'
  )
}

export function parseHealth(status) {
  if (!status) return 'none'
  if (/\(healthy\)/i.test(status)) return 'healthy'
  if (/\(unhealthy\)/i.test(status)) return 'unhealthy'
  if (/(health:\s*starting|\(starting\))/i.test(status)) return 'starting'
  return 'none'
}

export function parseExitCode(status) {
  if (!status) return null
  const m = String(status).match(/^Exited\s+\((\d+)\)/)
  return m ? parseInt(m[1], 10) : null
}

export function isIssueContainer(state, health, exitCode) {
  if (state === 'restarting' || state === 'dead') return true
  if (health === 'unhealthy' || health === 'starting') return true
  if (state === 'exited' && exitCode != null && exitCode !== 0) return true
  return false
}

export function isStoppedContainer(state, exitCode) {
  return state === 'exited' && (exitCode == null || exitCode === 0)
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      try {
        results[idx] = await fn(items[idx], idx)
      } catch (e) {
        results[idx] = { __error: e instanceof Error ? e.message : String(e) }
      }
    }
  }
  const workers = []
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker())
  await Promise.all(workers)
  return results
}

/**
 * @param ssh - ctx.ssh (SshTransport)
 * @param config - optional { processLimit, overviewCacheMs, processCacheMs, dockerSocket }
 */
export function createSshProcCollector(ssh, config = {}) {
  const defaultLimit = clampInt(config.processLimit ?? DEFAULT_PROCESS_LIMIT, 1, MAX_PROCESS_LIMIT)
  const overviewCacheMs = config.overviewCacheMs ?? OVERVIEW_CACHE_MS
  const processCacheMs = config.processCacheMs ?? PROCESS_CACHE_MS
  const dockerSocket = resolveDockerSocket(config)
  const dockerListCacheMs = config.dockerListCacheMs ?? DOCKER_LIST_CACHE_MS
  const dockerStatsCacheMs = config.dockerStatsCacheMs ?? DOCKER_STATS_CACHE_MS

  /** @type {Map<string, { idle: number, total: number }>} */
  const cpuPrev = new Map()
  /** @type {Map<string, { data: Record<string, { rx: number, tx: number }>, ts: number }>} */
  const netPrev = new Map()
  /** @type {Map<string, { ts: number, value: object }>} */
  const overviewCache = new Map()
  /** @type {Map<string, { ts: number, rows: object[] }>} */
  const processCache = new Map()
  /** @type {Map<string, { ts: number, value: object }>} */
  const dockerListCache = new Map()
  /** @type {Map<string, Map<string, { ts: number, value: object }>>} */
  const dockerStatsCache = new Map()
  /** @type {Map<string, string>} */
  const dockerApiVersionCache = new Map()
  /** @type {Map<string, { ts: number, ok: boolean }>} */
  const dockerSockProbeCache = new Map()

  async function resolveConnectionId(payload = {}) {
    const requested = payload.connectionId != null ? String(payload.connectionId) : null
    const { connections, activeId } = await ssh.list()
    const id = requested || activeId
    if (!id) throw new NoConnectionError('no active SSH connection')
    const known = connections.some((c) => c.id === id)
    if (!known) throw new NoConnectionError('unknown SSH connection: ' + id)
    return { id, info: connections.find((c) => c.id === id) }
  }

  async function execText(id, command) {
    const result = await ssh.exec(id, command, { timeoutMs: EXEC_TIMEOUT_MS })
    if (result.timedOut) throw new Error('ssh exec timed out')
    if (result.exitCode !== 0 && !String(result.stdout || '').trim()) {
      const msg = (result.stderr || '').trim() || ('ssh exec exit ' + result.exitCode)
      throw new Error(msg)
    }
    return String(result.stdout || '')
  }

  function unavailableDocker(error) {
    return {
      available: false,
      source: 'unavailable',
      error,
      summary: { ...EMPTY_DOCKER_SUMMARY },
      containers: [],
    }
  }

  async function probeDockerSock(id) {
    const cached = dockerSockProbeCache.get(id)
    if (cached && Date.now() - cached.ts < dockerListCacheMs) return cached.ok
    try {
      const result = await ssh.exec(
        id,
        'test -S ' + shellSingleQuote(dockerSocket) + ' && echo ok',
        { timeoutMs: EXEC_TIMEOUT_MS },
      )
      const ok = !result.timedOut && result.exitCode === 0 && /\bok\b/.test(String(result.stdout || ''))
      dockerSockProbeCache.set(id, { ts: Date.now(), ok })
      return ok
    } catch {
      dockerSockProbeCache.set(id, { ts: Date.now(), ok: false })
      return false
    }
  }

  async function dockerGetRemote(id, apiPath, opts = {}) {
    const command = opts.projectList
      ? dockerListCmd(dockerSocket, apiPath)
      : dockerCurlCmd(dockerSocket, apiPath)
    const result = await ssh.exec(id, command, { timeoutMs: EXEC_TIMEOUT_MS })
    if (result.timedOut) throw new Error('ssh exec timed out')
    if (result.truncated) {
      return { __error: 'docker: SSH stdout truncated (exceeded 64KiB cap)' }
    }
    if (result.exitCode !== 0 && !String(result.stdout || '').trim()) {
      const msg = (result.stderr || '').trim() || ('ssh exec exit ' + result.exitCode)
      throw new Error(msg)
    }
    const raw = String(result.stdout || '').trim()
    try {
      return JSON.parse(raw)
    } catch (e) {
      return { __error: 'docker: bad json: ' + (e instanceof Error ? e.message : String(e)) }
    }
  }

  async function dockerApiBase(id) {
    const cached = dockerApiVersionCache.get(id)
    if (cached) return cached
    try {
      const v = await dockerGetRemote(id, '/version')
      if (!v || v.__error) {
        dockerApiVersionCache.set(id, DOCKER_API_DEFAULT)
        return DOCKER_API_DEFAULT
      }
      const api = v.ApiVersion || v.MinAPIVersion || '1.41'
      const parts = String(api).split('.')
      const ver = 'v' + parts[0] + '.' + (parts[1] || '0')
      dockerApiVersionCache.set(id, ver)
      return ver
    } catch {
      dockerApiVersionCache.set(id, DOCKER_API_DEFAULT)
      return DOCKER_API_DEFAULT
    }
  }

  async function dockerContainerList(id) {
    const cached = dockerListCache.get(id)
    if (cached && Date.now() - cached.ts < dockerListCacheMs) return cached.value
    const base = await dockerApiBase(id)
    const data = await dockerGetRemote(id, '/' + base + '/containers/json?all=1', { projectList: true })
    if (data && data.__error) return { __error: String(data.__error) }
    if (!Array.isArray(data)) return { __error: 'docker: expected container list' }
    const annotated = data.map((c) => ({
      raw: c,
      state: c.State || 'unknown',
      health: parseHealth(c.Status),
      exitCode: parseExitCode(c.Status),
    }))
    const count = (fn) => annotated.filter(fn).length
    const summary = {
      total: data.length,
      running: count((a) => a.state === 'running'),
      stopped: count((a) => isStoppedContainer(a.state, a.exitCode)),
      crashed: count((a) => a.state === 'exited' && a.exitCode != null && a.exitCode !== 0),
      paused: count((a) => a.state === 'paused'),
      restarting: count((a) => a.state === 'restarting'),
      dead: count((a) => a.state === 'dead'),
      healthy: count((a) => a.health === 'healthy'),
      unhealthy: count((a) => a.health === 'unhealthy'),
      starting: count((a) => a.health === 'starting'),
      issues: count((a) => isIssueContainer(a.state, a.health, a.exitCode)),
    }
    const value = { summary, list: annotated.map((a) => a.raw) }
    dockerListCache.set(id, { value, ts: Date.now() })
    return value
  }

  async function containerStats(connectionId, containerId) {
    let perConn = dockerStatsCache.get(connectionId)
    if (!perConn) {
      perConn = new Map()
      dockerStatsCache.set(connectionId, perConn)
    }
    const cached = perConn.get(containerId)
    if (cached && Date.now() - cached.ts < dockerStatsCacheMs) return cached.value
    if (!/^[0-9a-fA-F]{6,64}$/.test(containerId)) throw new Error('docker: bad container id')
    const base = await dockerApiBase(connectionId)
    const stats = await dockerGetRemote(
      connectionId,
      '/' + base + '/containers/' + containerId + '/stats?stream=false',
    )
    if (stats && stats.__error) throw new Error(String(stats.__error))
    perConn.set(containerId, { value: stats, ts: Date.now() })
    return stats
  }

  function memoryFromKb(mi) {
    const totalKb = mi.MemTotal || 0
    const availableKb = mi.MemAvailable != null
      ? mi.MemAvailable
      : (mi.MemFree || 0) + (mi.Buffers || 0) + (mi.Cached || 0)
    const usedKb = Math.max(0, totalKb - availableKb)
    const total = totalKb * 1024
    const used = usedKb * 1024
    const usage = total > 0 ? (used / total) * 100 : 0
    return { used, total, usage }
  }

  function cpuUsagePercent(connectionId, agg) {
    if (!agg) return null
    const prev = cpuPrev.get(connectionId)
    cpuPrev.set(connectionId, agg)
    if (!prev) return null
    const dTotal = agg.total - prev.total
    const dIdle = agg.idle - prev.idle
    if (dTotal <= 0) return null
    return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100))
  }

  function parseOsReleasePretty(text) {
    const kv = {}
    for (const line of String(text || '').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/)
      if (!m) continue
      kv[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
    }
    return kv.PRETTY_NAME || (kv.NAME ? kv.NAME + (kv.VERSION ? ' ' + kv.VERSION : '') : null)
  }

  function buildEnvironment(hostname, sockOk = false) {
    return {
      mode: 'ssh',
      systemSource: 'ssh',
      processSource: 'ssh',
      dockerSource: sockOk ? 'host' : 'unavailable',
      hostname: hostname || null,
      // Paths match side-monitor shape; origin in UI is systemSource (SSH 远端).
      sources: {
        loadavg: '/proc/loadavg',
        uptime: '/proc/uptime',
        cpuinfo: '/proc/cpuinfo (meta)',
        osrelease: '/proc/sys/kernel/osrelease',
        osRelease: '/etc/os-release',
        netDev: '/proc/net/dev',
        fibTrie: 'ip -4 -o addr',
        mounts: 'df -T -kP',
        mountinfo: '',
        processes: 'ps -eo pid,ppid,user,pcpu,pmem,rss,args',
        dockerSocket: sockOk ? dockerSocket : null,
      },
      consistency: { ok: true, warnings: [] },
    }
  }

  function buildNetwork(connectionId, netDevText, routeText, trieText, ipAddrText) {
    const sample = parseNetDev(netDevText)
    const now = Date.now()
    const rates = {}
    const prev = netPrev.get(connectionId)
    if (prev) {
      const dt = (now - prev.ts) / 1000
      if (dt > 0) {
        for (const name of Object.keys(sample)) {
          const p = prev.data[name]
          if (p) {
            rates[name] = {
              rx: Math.max(0, (sample[name].rx - p.rx) / dt),
              tx: Math.max(0, (sample[name].tx - p.tx) / dt),
            }
          }
        }
      }
    }
    netPrev.set(connectionId, { data: sample, ts: now })

    let primary = parseDefaultRouteIface(routeText)
    const ipv4 = parseIpDashOAddr(ipAddrText)
    if (ipv4.size === 0) {
      for (const [k, v] of parseInterfaceIpv4Map(trieText, routeText)) ipv4.set(k, v)
    }
    const list = []
    for (const name of Object.keys(sample)) {
      if (/^(veth|br-|docker\d*)/.test(name)) continue
      const r = rates[name]
      const virtual = VIRTUAL_IFACE_RE.test(name)
      list.push({
        name,
        ip: ipv4.get(name) || null,
        rxBytesPerSec: r ? round1(r.rx) : null,
        txBytesPerSec: r ? round1(r.tx) : null,
        virtual,
        primary: name === primary,
      })
    }
    if (!list.some((i) => i.primary) && list.length) {
      const physical = list.find((i) => !i.virtual) || list[0]
      physical.primary = true
      primary = physical.name
    }
    list.sort((a, b) =>
      (Number(b.primary) - Number(a.primary))
      || (Number(a.virtual) - Number(b.virtual))
      || a.name.localeCompare(b.name)
    )
    return { primary, interfaces: list }
  }

  async function fetchOverviewRaw(connectionId) {
    const out = await execText(connectionId, OVERVIEW_SCRIPT)
    const sec = splitMarkedSections(out)
    const cpuInfo = sec.CPUMETA
      ? parseCpuMeta(sec.CPUMETA)
      : parseCpuInfo(sec.CPUINFO || '')
    const agg = parseCpuAggregate(sec.STAT || '')
    const mi = parseMemInfoKb(sec.MEMINFO || '')
    const mem = memoryFromKb(mi)
    const load = parseLoadavg(sec.LOADAVG || '') || [0, 0, 0]
    const uptime = parseUptimeSeconds(sec.UPTIME || '') ?? 0
    const hostname = String(sec.HOSTNAME || '').trim().split('\n')[0] || null
    const osrel = String(sec.OSREL || '').trim().split('\n')[0] || ''
    const archRaw = String(sec.ARCH || '').trim().split('\n')[0] || ''
    const kernelVersion = osrel || 'unknown'
    const arch = archRaw || 'unknown'
    const osName = parseOsReleasePretty(sec.OSRELEASE || '') || 'Linux'
    const usage = cpuUsagePercent(connectionId, agg)
    const cores = cpuInfo.logical || 1
    // df only — /proc/mounts omitted to stay under the 64KiB exec cap.
    const diskInfo = parseDfText(sec.DF || '')
    const network = buildNetwork(
      connectionId,
      sec.NETDEV || '',
      sec.ROUTE || '',
      '',
      sec.IPADDR || '',
    )
    const sockCached = dockerSockProbeCache.get(connectionId)
    const sockOk = sockCached ? sockCached.ok : false
    return {
      connectionId,
      hostname,
      source: 'ssh',
      environment: buildEnvironment(hostname, sockOk),
      cpuUsage: usage == null ? null : round1(usage),
      cpuCores: cores,
      physicalCores: cpuInfo.physical,
      cpuModel: cpuInfo.model || 'unknown',
      cpuClockMhz: cpuInfo.clockMhz,
      memoryUsed: mem.used,
      memoryTotal: mem.total,
      memoryUsage: round1(mem.usage),
      diskAvailable: diskInfo.available,
      diskUsed: diskInfo.primary.used,
      diskTotal: diskInfo.primary.total,
      diskUsage: diskInfo.primary.usage,
      disks: diskInfo.mounts,
      load1: load[0],
      load5: load[1],
      load15: load[2],
      uptimeSeconds: Math.round(uptime),
      osName,
      platform: 'linux',
      arch,
      kernelVersion,
      network,
      sampleNote: usage == null ? 'cpuUsage needs a second sample' : undefined,
    }
  }

  async function fetchProcessRows(connectionId) {
    const out = await execText(connectionId, PS_SCRIPT)
    return parsePsText(out)
  }

  async function metaInfo(payload = {}) {
    const { id, info } = await resolveConnectionId(payload)
    const sockOk = await probeDockerSock(id)
    return {
      connectionId: id,
      hostname: info?.host ?? null,
      username: info?.username ?? null,
      source: 'ssh',
      status: {
        mode: 'ssh',
        systemSource: 'ssh',
        processSource: 'ssh',
        dockerSource: sockOk ? 'host' : 'unavailable',
        hostMetrics: true,
        networkProbe: 'proc-net',
        consistency: { ok: true, warnings: [] },
      },
      capabilities: {
        overview: true,
        processes: true,
        docker: sockOk,
        hostMount: false,
        dockerSocket: sockOk,
        hostNetNsProbe: false,
        processAggregate: true,
        containerStats: sockOk,
      },
      environment: {
        sources: {
          dockerSocket: sockOk ? dockerSocket : null,
        },
      },
    }
  }

  async function overview(payload = {}) {
    const { id } = await resolveConnectionId(payload)
    const cached = overviewCache.get(id)
    if (cached && Date.now() - cached.ts < overviewCacheMs) {
      return { ...cached.value, connectionId: id }
    }
    const value = await fetchOverviewRaw(id)
    overviewCache.set(id, { ts: Date.now(), value })
    return value
  }

  async function processes(payload = {}) {
    const { id } = await resolveConnectionId(payload)
    let rows
    const cached = processCache.get(id)
    if (cached && Date.now() - cached.ts < processCacheMs) {
      rows = cached.rows
    } else {
      rows = await fetchProcessRows(id)
      processCache.set(id, { ts: Date.now(), rows })
    }

    const search = String(payload.search || payload.query || '').trim().toLowerCase()
    let filtered = rows
    if (search) {
      filtered = rows.filter((r) =>
        r.command.toLowerCase().includes(search)
        || r.name.toLowerCase().includes(search)
        || r.user.toLowerCase().includes(search)
        || String(r.pid).includes(search))
    }

    const sort = String(payload.sort || 'cpu')
    const order = String(payload.order || 'desc') === 'asc' ? 1 : -1
    const sorted = filtered.slice().sort((a, b) => {
      let av
      let bv
      if (sort === 'mem') { av = a.mem; bv = b.mem }
      else if (sort === 'pid') { av = a.pid; bv = b.pid }
      else if (sort === 'name') { av = a.name; bv = b.name; return String(av).localeCompare(String(bv)) * order }
      else { av = a.cpu; bv = b.cpu }
      return (av - bv) * order
    })

    const limit = clampInt(payload.limit ?? defaultLimit, 1, MAX_PROCESS_LIMIT)
    const offset = clampInt(payload.offset ?? 0, 0, 1_000_000)
    const mapped = sorted.map((r) => ({
      pid: r.pid,
      ppid: r.ppid,
      user: r.user,
      cpu: r.cpu,
      mem: r.mem,
      rssBytes: r.rssKb * 1024,
      name: r.name,
      command: r.command,
    }))

    if (payload.aggregate) {
      const map = new Map()
      for (const r of mapped) {
        const key = r.name + '\0' + r.command
        let g = map.get(key)
        if (!g) {
          g = {
            name: r.name,
            command: r.command,
            count: 0,
            cpu: 0,
            mem: 0,
            rssBytes: 0,
            pids: [],
            users: [],
          }
          map.set(key, g)
        }
        g.count += 1
        g.cpu += r.cpu
        g.mem += r.mem
        g.rssBytes += r.rssBytes
        g.pids.push(r.pid)
        if (r.user && !g.users.includes(r.user)) g.users.push(r.user)
      }
      const groupsAll = [...map.values()].sort((a, b) => b.cpu - a.cpu)
      const groups = groupsAll.slice(offset, offset + limit)
      return {
        connectionId: id,
        source: 'ssh',
        aggregate: true,
        total: filtered.length,
        matched: filtered.length,
        groupsTotal: groupsAll.length,
        offset,
        limit,
        processes: [],
        groups,
      }
    }

    const page = mapped.slice(offset, offset + limit)
    return {
      connectionId: id,
      source: 'ssh',
      total: rows.length,
      matched: filtered.length,
      offset,
      limit,
      processes: page,
    }
  }

  async function containers(payload = {}) {
    const { id } = await resolveConnectionId(payload)
    const sockOk = await probeDockerSock(id)
    if (!sockOk) return unavailableDocker('未检测到 ' + dockerSocket)

    let summary
    let list
    try {
      const r = await dockerContainerList(id)
      if (r.__error) return unavailableDocker(r.__error)
      summary = r.summary
      list = r.list
    } catch (e) {
      return unavailableDocker(e instanceof Error ? e.message : String(e))
    }

    const withStats = payload.stats !== false
    const statsById = {}
    const statsErrors = {}
    if (withStats) {
      const running = list.filter((c) => c.State === 'running')
      const results = await mapLimit(running, 4, (c) => containerStats(id, c.Id))
      for (let i = 0; i < running.length; i++) {
        const r = results[i]
        if (r && r.__error) statsErrors[running[i].Id] = r.__error
        else if (r) statsById[running[i].Id] = r
      }
    }

    const rows = list.map((c) => {
      const cid = c.Id || ''
      const name = (c.Names && c.Names[0]) ? c.Names[0].replace(/^\//, '') : cid.slice(0, 12)
      const ports = (c.Ports || []).map((p) => ({
        hostIp: p.IP || null,
        hostPort: p.PublicPort != null ? Number(p.PublicPort) : null,
        containerPort: p.PrivatePort != null ? Number(p.PrivatePort) : null,
        protocol: p.Type || 'tcp',
      }))
      const row = {
        id: cid.slice(0, 12),
        name,
        image: c.Image || '',
        state: c.State || 'unknown',
        status: c.Status || '',
        health: parseHealth(c.Status),
        exitCode: parseExitCode(c.Status),
        ports,
        cpuUsage: null,
        memoryUsage: null,
        memoryLimit: null,
        memoryUsagePct: null,
        statsError: statsErrors[cid] || null,
      }
      const stats = statsById[cid]
      if (stats) {
        const cpuStats = stats.cpu_stats || {}
        const prevCpu = stats.precpu_stats || {}
        const totalUsage = cpuStats.cpu_usage ? cpuStats.cpu_usage.total_usage : 0
        const prevTotalUsage = prevCpu.cpu_usage ? prevCpu.cpu_usage.total_usage : 0
        const systemUsage = cpuStats.system_cpu_usage || 0
        const prevSystemUsage = prevCpu.system_cpu_usage || 0
        const onlineCpus = cpuStats.online_cpus || 1
        const dCpu = totalUsage - prevTotalUsage
        const dSys = systemUsage - prevSystemUsage
        if (dSys > 0 && dCpu >= 0) row.cpuUsage = round2((dCpu / dSys) * onlineCpus * 100)
        const mem = stats.memory_stats || {}
        const usage = typeof mem.usage === 'number' ? mem.usage : null
        const limit = typeof mem.limit === 'number' ? mem.limit : null
        if (usage !== null) {
          row.memoryUsage = usage
          row.memoryLimit = limit
          row.memoryUsagePct = limit > 0 ? round2((usage / limit) * 100) : null
        }
      }
      return row
    })

    return { available: true, source: 'host', summary, containers: rows }
  }

  return { metaInfo, overview, processes, containers }
}
