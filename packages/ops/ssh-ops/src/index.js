/**
 * dsh-ssh-ops host half: a Typert Remote service named `sshOps` that manages
 * ssh2 connections and PTY shell sessions, streaming output to the browser
 * through long-poll reads. Also registers agent tools (ssh_connect, ssh_exec,
 * ...) so the main conversation can drive the same sessions the panel shows.
 */
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { z } from "zod";
import { assessShellCommand } from "./safety.js";
import { redactForModel } from "./redact.js";
import { DbOpsManager, pickSshConnectionId } from "./db-ops.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
const MAX_CAPTURE_BYTES = 128 * 1024;
const READ_TIMEOUT_MS = 300;
const MAX_SESSIONS = 64;

const profileRecordSchema = z.object({
  name: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  authKind: z.enum(["password", "key"]),
  groupId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const groupRecordSchema = z.object({
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const profileDomainSpec = defineDomain({
  name: "ssh_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(profileRecordSchema),
    groups: domainTable(groupRecordSchema)
  }
});

const dbProfileRecordSchema = z.object({
  name: z.string(),
  type: z.enum(["mysql", "postgresql", "redis", "mongodb"]),
  host: z.string(),
  port: z.number().int(),
  database: z.string().nullable(),
  username: z.string().nullable(),
  ssl: z.string(),
  sshProfileId: z.string().uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const dbProfileDomainSpec = defineDomain({
  name: "db_ops_profiles",
  version: 1,
  tables: {
    profiles: domainTable(dbProfileRecordSchema)
  }
});

function fail(code, message) {
  return { code, message };
}

/** Normalize in-process calls to sshConnection (may be wrapped or bare value). */
function asSshResult(raw) {
  if (raw && typeof raw === "object" && typeof raw.ok === "boolean") return raw;
  if (raw && typeof raw === "object") return { ok: true, value: raw };
  return { ok: false, error: fail("invalid-result", "unexpected sshConnection result") };
}


function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  };
}

function dbProfileCredentialRefs(dbProfileId) {
  const stem = dbProfileId.replaceAll("-", "").toUpperCase();
  return { password: `DSH_DB_OPS_${stem}_PASSWORD` };
}

/** Base64-decode a wire payload to a UTF-8 string. */
function decodeData(data) {
  return Buffer.from(data, "base64").toString("utf8");
}

/** Base64-encode a UTF-8 string for the wire. */
function encodeData(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function tailCapped(text, maxBytes) {
  const bytes = Buffer.from(text, "utf8");
  return bytes.length <= maxBytes ? text : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function promptFromTerminalData(text) {
  const visible = String(text)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const match = visible.match(/(?:^|[\r\n])([^\r\n]*[#$] )$/);
  return match?.[1] ?? null;
}

/**
 * ssh2 exec channels return LF-delimited text. xterm keeps the current column
 * on a bare LF, which makes multi-line agent output drift diagonally. Agent
 * output is synthetic terminal data, so normalize it to the terminal CRLF.
 */
export function normalizeTerminalEol(text) {
  return String(text ?? "").replace(/\r\n|\r|\n/g, "\r\n");
}

/**
 * SshOpsService: one cordis service (and Typert Remote) that owns all SSH
 * connections and their PTY shell sessions for the web profile.
 */
export default class SshOpsService extends TypertRemoteService {
  /** Host-owned profiles and secrets never cross the agent tool boundary. */
  static inject = ["tools", "storageDomain", "credentials", "ssh", "sshConnection"];

  /**
   * Ops-side metadata for live transports owned by ctx.ssh.
   * connectionId -> { host, port, username, name?, profileId? }
   */
  connectionMeta = new Map();
  /** sessionId -> live PTY shell session record */
  sessions = new Map();
  /** sessionId -> tombstoned exit records for late reads */
  exitedSessions = new Map();
  /** The connection currently represented by the right-side terminal panel. */
  activeConnectionId = null;
  profileTable = null;
  groupTable = null;

  constructor(ctx, config = {}) {
    super(ctx, "sshOps");
    this.config = {
      defaultReadTimeoutMs: READ_TIMEOUT_MS,
      maxBufferBytes: MAX_BUFFER_BYTES,
      maxCommandOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
      ...config
    };
    // Tear down local sessions when the plugin fiber unloads; transport cleanup
    // is owned by the ctx.ssh provider.
    ctx.effect(() => () => {
      for (const session of this.sessions.values()) {
        try { session.handle?.close(); } catch {}
      }
      this.sessions.clear();
      this.exitedSessions.clear();
      this.connectionMeta.clear();
      this.activeConnectionId = null;
      try { this.dbOps?.closeAll().catch(() => {}); } catch {}
    }, "ssh-ops: cleanup");
    this.dbOps = new DbOpsManager(this);
    this.registerTools(ctx);
  }

  async [Service.init]() {
    // SSH profiles/groups live in dsh-ssh-connection (domain ssh_ops_profiles).
    const dbDomain = await this.ctx.storageDomain.open(dbProfileDomainSpec);
    this.dbProfileTable = dbDomain.table("profiles");
    this.ctx.effect(() => () => dbDomain.close(), "ssh-ops: db profile domain close");
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const { connections: live, activeId } = await this.ctx.ssh.list();
    this.activeConnectionId = activeId;
    const sharedMeta = this.ctx.sshConnection?.connectionMeta;
    const connections = [];
    for (const c of live) {
      const shared = sharedMeta instanceof Map ? sharedMeta.get(c.id) : undefined;
      const meta = this.connectionMeta.get(c.id) ?? shared ?? {};
      if (!this.connectionMeta.has(c.id) && shared) {
        this.connectionMeta.set(c.id, { ...shared });
      }
      const sessions = [...this.sessions.values()]
        .filter((session) => session.connectionId === c.id && session.exited === null)
        .map((session) => session.id);
      const connection = {
        connectionId: c.id,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: true,
        sessions
      };
      const name = c.name ?? meta.name;
      if (name !== undefined) connection.name = name;
      connections.push(connection);
      if (!this.connectionMeta.has(c.id)) {
        this.connectionMeta.set(c.id, {
          host: c.host,
          port: c.port,
          username: c.username,
          ...(name !== undefined ? { name } : {})
        });
      }
    }
    return { ok: true, value: { connections, activeConnectionId: activeId } };
  }

  async connect(request) {
    return this.connectInternal(request);
  }

  async connectInternal(request, profileId = undefined) {
    const result = asSshResult(await this.ctx.sshConnection.connect(request));
    if (result.ok) {
      const v = result.value;
      this.connectionMeta.set(v.connectionId, {
        host: v.host,
        port: v.port,
        username: v.username,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(profileId !== undefined ? { profileId } : {})
      });
      this.activeConnectionId = v.connectionId;
    }
    return result;
  }

  /** Wait for ctx.ssh to expose a usable connection id (provider self-heals). */
  async ensureSshAlive(connectionId) {
    const { connections } = await this.ctx.ssh.list();
    if (!connections.some((c) => c.id === connectionId)) {
      throw new Error(`SSH connection ${connectionId} not found`);
    }
    return true;
  }

  /**
   * Direct-tcpip channel through the ssh2 provider (used by db-ops tunnels).
   */
  async sshForwardOut(connectionId, srcIP, srcPort, dstIP, dstPort) {
    const ssh = this.ctx.ssh;
    if (typeof ssh.forwardOut !== "function") {
      throw new Error("SSH provider does not support forwardOut");
    }
    return ssh.forwardOut(connectionId, srcIP, srcPort, dstIP, dstPort);
  }

  requireProfileTable() {
    throw new Error("SSH resources moved to dsh-ssh-connection; use ctx.sshConnection");
  }

  requireGroupTable() {
    throw new Error("SSH resources moved to dsh-ssh-connection; use ctx.sshConnection");
  }

  async profileList(request = {}) {
    return asSshResult(await this.ctx.sshConnection.profileList(request));
  }

  async profileSave(request) {
    return asSshResult(await this.ctx.sshConnection.profileSave(request));
  }

  async profileDelete(request) {
    return asSshResult(await this.ctx.sshConnection.profileDelete(request));
  }

  async profileConnect(request) {
    const result = asSshResult(await this.ctx.sshConnection.profileConnect(request));
    if (result.ok) {
      const v = result.value;
      this.connectionMeta.set(v.connectionId, {
        host: v.host,
        port: v.port,
        username: v.username,
        ...(v.name !== undefined ? { name: v.name } : {}),
        profileId: request.profileId
      });
      this.activeConnectionId = v.connectionId;
    }
    return result;
  }

  async groupList(request = {}) {
    return asSshResult(await this.ctx.sshConnection.groupList(request));
  }

  async groupSave(request) {
    return asSshResult(await this.ctx.sshConnection.groupSave(request));
  }

  async groupDelete(request) {
    return asSshResult(await this.ctx.sshConnection.groupDelete(request));
  }

  async openSession(request) {
    if (!this.connectionMeta.has(request.connectionId)) {
      try {
        const { connections } = await this.ctx.ssh.list();
        if (!connections.some((c) => c.id === request.connectionId)) {
          return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
        }
      } catch {
        return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
      }
    }
    if (this.sessions.size >= MAX_SESSIONS) return { ok: false, error: fail("session-limit", `too many live sessions (${MAX_SESSIONS})`) };
    const sessionId = randomUUID();
    const cols = request.cols ?? 80;
    const rows = request.rows ?? 24;
    const session = {
      id: sessionId,
      connectionId: request.connectionId,
      cols,
      rows,
      buffer: "",
      captureBuffer: "",
      lastPrompt: null,
      waiters: [],
      exited: null,
      handle: null,
      inputLine: "",
      inputKnown: true
    };
    this.sessions.set(sessionId, session);
    this.exitedSessions.delete(sessionId);
    try {
      const handle = await this.ctx.ssh.openShell(request.connectionId, { cols, rows });
      session.handle = handle;
      handle.onData((chunk) => {
        this.appendSessionOutput(session, chunk);
      });
      handle.onClose(() => {
        this.recordExit(session, { code: 0 });
      });
      this.ctx.ssh.setActive(request.connectionId);
      this.activeConnectionId = request.connectionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      return { ok: false, error: fail("shell-failed", `could not open shell on connection "${request.connectionId}": ${error.message}`) };
    }
    return {
      ok: true,
      value: {
        sessionId,
        connectionId: request.connectionId,
        cols,
        rows,
        alive: true
      }
    };
  }

  async write(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.exited !== null || session.handle === null) return { ok: false, error: fail("exited", `session "${request.sessionId}" has already exited`) };
    let text;
    try {
      text = decodeData(request.data);
    } catch {
      return { ok: false, error: fail("bad-data", "input is not valid base64") };
    }
    try {
      if (text) session.handle.write(text);
    } catch (error) {
      return { ok: false, error: fail("write-failed", error.message) };
    }
    return { ok: true, value: { written: text.length } };
  }

  async read(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) {
      const exit = this.exitedSessions.get(request.sessionId);
      if (exit !== void 0) return { ok: true, value: { data: "", exit } };
      return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    }
    if (session.exited !== null) {
      return { ok: true, value: { data: this.drain(session), exit: session.exited } };
    }
    const pending = this.drain(session);
    if (pending !== "") {
      return { ok: true, value: { data: pending, exit: null } };
    }
    const timeoutMs = request.timeoutMs ?? this.config.defaultReadTimeoutMs;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const index = session.waiters.indexOf(waiter);
        if (index >= 0) session.waiters.splice(index, 1);
        resolve(value);
      };
      const timer = setTimeout(() => {
        finish({ ok: true, value: { data: this.drain(session), exit: null } });
      }, timeoutMs);
      const waiter = { resolve: finish, timer };
      session.waiters.push(waiter);
    });
  }

  async resize(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    if (session.handle === null || session.exited !== null) return { ok: false, error: fail("exited", `session "${request.sessionId}" is not alive`) };
    try {
      session.handle.resize(request.cols, request.rows);
    } catch (error) {
      return { ok: false, error: fail("resize-failed", error.message) };
    }
    session.cols = request.cols;
    session.rows = request.rows;
    return { ok: true, value: { cols: request.cols, rows: request.rows } };
  }

  async closeSession(request) {
    const session = this.sessions.get(request.sessionId);
    if (session === void 0) return { ok: false, error: fail("no-session", `session "${request.sessionId}" does not exist`) };
    this.sessions.delete(request.sessionId);
    if (session.exited === null && session.handle !== null) {
      try { session.handle.close(); } catch {}
      session.exited = { code: 0 };
    }
    this.rememberExit(request.sessionId, session.exited ?? { code: 0 });
    return { ok: true, value: { closed: true } };
  }

  async disconnect(request) {
    if (!this.connectionMeta.has(request.connectionId)) {
      try {
        const { connections } = await this.ctx.ssh.list();
        if (!connections.some((c) => c.id === request.connectionId)) {
          return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
        }
      } catch {
        return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
      }
    }
    for (const session of [...this.sessions.values()]) {
      if (session.connectionId !== request.connectionId) continue;
      this.sessions.delete(session.id);
      if (session.exited === null && session.handle !== null) {
        try { session.handle.close(); } catch {}
        session.exited = { code: 0 };
      }
      this.rememberExit(session.id, session.exited ?? { code: 0 });
    }
    this.connectionMeta.delete(request.connectionId);
    if (this.activeConnectionId === request.connectionId) {
      this.activeConnectionId = null;
    }
    try {
      await this.ctx.ssh.disconnect(request.connectionId);
    } catch (error) {
      return { ok: false, error: fail("disconnect-failed", error.message) };
    }
    return { ok: true, value: { disconnected: true } };
  }

  // ── Database ops (proxied to DbOpsManager) ─────────────────────────────────

  async dbConnect(request) {
    return this.dbOps.connect(request);
  }

  async dbListConnections(request) {
    return this.dbOps.list(request);
  }

  async dbQuery(request) {
    return this.dbOps.query(request);
  }

  async dbExecute(request) {
    return this.dbOps.execute(request);
  }

  async dbListTables(request) {
    return this.dbOps.listTables(request);
  }

  async dbDescribeTable(request) {
    return this.dbOps.describeTable(request);
  }

  async dbRun(request) {
    return this.dbOps.run(request);
  }

  async dbDisconnect(request) {
    return this.dbOps.disconnect(request);
  }

  // ── Database profile CRUD (durable connections) ────────────────────────────

  requireDbProfileTable() {
    if (this.dbProfileTable === null) throw new Error("DB profile storage is not ready");
    return this.dbProfileTable;
  }

  async dbProfilePublic(dbProfileId, record) {
    const refs = dbProfileCredentialRefs(dbProfileId);
    const cred = await this.ctx.credentials.describe(credentialRef(refs.password));
    const connected = [...this.dbOps.dbConnections.values()].some((c) => c.config.name === record.name);
    return {
      dbProfileId,
      name: record.name,
      type: record.type,
      host: record.host,
      port: record.port,
      database: record.database,
      username: record.username,
      ssl: record.ssl,
      sshProfileId: record.sshProfileId,
      credentialConfigured: cred.configured,
      connected
    };
  }

  async dbProfileList() {
    try {
      const profiles = await Promise.all(
        [...this.requireDbProfileTable().entries()].map(async ([id, rec]) => await this.dbProfilePublic(id, rec))
      );
      profiles.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-list-failed", error.message) };
    }
  }

  async dbProfileSave(request) {
    try {
      const table = this.requireDbProfileTable();
      const dbProfileId = request.dbProfileId ?? randomUUID();
      const previous = table.get(dbProfileId);
      if (request.dbProfileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-db-profile", `DB profile "${dbProfileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const record = {
        name: request.name.trim(),
        type: request.type,
        host: request.host.trim(),
        port: request.port,
        database: request.database?.trim() || null,
        username: request.username?.trim() || null,
        ssl: request.ssl ?? "disabled",
        sshProfileId: request.sshProfileId || null,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(dbProfileId, record);
      // If a password was provided, store it as an encrypted credential.
      if (request.password !== undefined && request.password.length > 0) {
        const refs = dbProfileCredentialRefs(dbProfileId);
        await this.ctx.credentials.set(credentialRef(refs.password), request.password);
      }
      return {
        ok: true,
        value: {
          profile: await this.dbProfilePublic(dbProfileId, record),
          credentialRefs: dbProfileCredentialRefs(dbProfileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("db-profile-save-failed", error.message) };
    }
  }

  async dbProfileDelete(request) {
    try {
      const table = this.requireDbProfileTable();
      const record = table.get(request.dbProfileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.dbProfileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("db-profile-delete-failed", error.message) };
    }
  }

  async dbProfileConnect(request) {
    try {
      const record = this.requireDbProfileTable().get(request.dbProfileId);
      if (record === undefined) return { ok: false, error: fail("no-db-profile", `DB profile "${request.dbProfileId}" does not exist`) };
      const refs = dbProfileCredentialRefs(request.dbProfileId);
      const cred = await this.ctx.credentials.resolve(credentialRef(refs.password));
      // Resolve SSH tunnel: if sshProfileId is set, find a live SSH connection
      // for that profile, or connect it first.
      let sshConnectionId = undefined;
      if (record.sshProfileId) {
        const sshConnId = [...this.connectionMeta.entries()]
          .find(([, meta]) => meta.profileId === record.sshProfileId)?.[0];
        if (sshConnId) {
          sshConnectionId = sshConnId;
        } else {
          // Auto-connect the SSH profile to establish the tunnel.
          const sshResult = await this.profileConnect({ profileId: record.sshProfileId });
          if (!sshResult.ok) return sshResult;
          sshConnectionId = sshResult.value.connectionId;
        }
      }
      const result = await this.dbOps.connect({
        type: record.type,
        host: record.host,
        port: record.port,
        database: record.database ?? undefined,
        username: record.username ?? undefined,
        password: cred?.value,
        ssl: record.ssl,
        sshConnectionId,
        name: record.name
      });
      if (!result.ok) return result;
      // Tag the db connection with the profile name for connected-status lookup.
      const dbRecord = this.dbOps.dbConnections.get(result.value.dbConnectionId);
      if (dbRecord) dbRecord.config.name = record.name;
      return result;
    } catch (error) {
      return { ok: false, error: fail("db-profile-connect-failed", error.message) };
    }
  }

  // ── Agent-facing helpers (called directly by tools, not over the wire) ────

  /**
   * Run one command over a dedicated exec channel on a connection. The
   * command line and its output are ALSO appended to the connection's shell
   * session buffers (if any), so the panel shows what the agent did.
   */
  async execOnConnection(connectionId, command, timeoutMs = 30000, retried = false) {
    const decision = assessShellCommand(command);
    if (!decision.ok) return { ok: false, error: fail("unsafe-command", decision.reason) };
    const meta = this.connectionMeta.get(connectionId);
    if (meta === void 0) {
      try {
        const { connections } = await this.ctx.ssh.list();
        if (!connections.some((c) => c.id === connectionId)) {
          return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
        }
      } catch {
        return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
      }
    }
    const commandId = randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let result;
    try {
      result = await this.ctx.ssh.exec(connectionId, command, { timeoutMs });
    } catch (error) {
      if (!retried) {
        try {
          await this.ensureSshAlive(connectionId);
          return this.execOnConnection(connectionId, command, timeoutMs, true);
        } catch {}
      }
      return { ok: false, error: fail("exec-failed", error.message) };
    }
    const { exitCode, stdout, stderr, truncated = false, timedOut = false } = result;
    const hostMeta = meta ?? { username: "user", host: "host" };
    const display = normalizeTerminalEol(`$ ${command}\n${stdout}${stderr.length > 0 ? stderr : ""}`)
      .replace(/(?:\r\n)+$/, "");
    for (const session of this.sessions.values()) {
      if (session.connectionId !== connectionId || session.exited !== null) continue;
      const prompt = session.lastPrompt ?? this.fallbackPrompt(hostMeta);
      this.appendSessionOutput(session, `${display}\r\n${prompt}`, { capture: false, observePrompt: false });
    }
    return {
      ok: true,
      value: {
        exitCode,
        stdout,
        stderr,
        display,
        commandId,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAtMs,
        truncated,
        timedOut
      }
    };
  }

  /** Send raw input into every live shell session of a connection. */
  writeToConnection(connectionId, input) {
    if (!this.connectionMeta.has(connectionId) && this.activeConnectionId !== connectionId) {
      // Still allow writes when meta is briefly out of sync but sessions exist.
      const hasSession = [...this.sessions.values()].some((s) => s.connectionId === connectionId);
      if (!hasSession) return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    }
    let written = 0;
    let blockedReason = null;
    for (const session of this.sessions.values()) {
      if (session.connectionId !== connectionId || session.exited !== null || session.handle === null) continue;
      try {
        const guarded = this.prepareTerminalInput(session, input);
        if (guarded.forwarded) session.handle.write(guarded.forwarded);
        written += guarded.forwarded.length;
        blockedReason ??= guarded.blockedReason;
      } catch {}
    }
    if (blockedReason) return { ok: false, error: fail("unsafe-command", blockedReason) };
    return { ok: true, value: { written } };
  }

  /** Add a local policy notice to the same buffer rendered by the terminal. */
  appendTerminalNotice(session, message) {
    this.appendSessionOutput(session, `\r\n\x1b[33m[DSH SSH 安全策略] ${message}\x1b[0m\r\n`);
  }

  /**
   * Preserve normal terminal editing, but submit a line only after host-side
   * policy approval. A denied line is cleared with Ctrl-U before the shell can
   * execute it. History navigation and tab completion fail closed as well.
   */
  prepareTerminalInput(session, text) {
    let forwarded = "";
    let blockedReason = null;
    for (const char of text) {
      if (char === "\r" || char === "\n") {
        const decision = session.inputKnown
          ? assessShellCommand(session.inputLine)
          : { ok: false, reason: "安全策略已阻止：无法验证历史命令或自动补全后的内容。请手动输入只读诊断命令。" };
        if (decision.ok) {
          forwarded += char;
        } else {
          // The already-echoed command remains in the remote line editor until
          // Ctrl-U clears it; crucially, Enter itself never reaches the shell.
          forwarded += "\x15";
          blockedReason ??= decision.reason;
          this.appendTerminalNotice(session, decision.reason);
        }
        session.inputLine = "";
        session.inputKnown = true;
        continue;
      }
      if (char === "\x03") {
        session.inputLine = "";
        session.inputKnown = true;
        forwarded += char;
        continue;
      }
      if (char === "\b" || char === "\x7f") {
        if (session.inputKnown) session.inputLine = session.inputLine.slice(0, -1);
        forwarded += char;
        continue;
      }
      if (char === "\x1b" || char === "\t") {
        // Escape sequences (history/navigation) and completion can change the
        // remote line without a trustworthy local representation.
        session.inputKnown = false;
        forwarded += char;
        continue;
      }
      if (char.codePointAt(0) < 32) {
        forwarded += char;
        continue;
      }
      if (session.inputKnown) {
        session.inputLine += char;
        if (session.inputLine.length > 8192) session.inputKnown = false;
      }
      forwarded += char;
    }
    return { forwarded, blockedReason };
  }

  /** Current buffered text of a connection's first live shell session. */
  readConnectionOutput(connectionId) {
    const hasMeta = this.connectionMeta.has(connectionId);
    const first = [...this.sessions.values()].find((s) => s.connectionId === connectionId && s.exited === null);
    if (!hasMeta && first === undefined) {
      return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    }
    if (first === undefined) {
      return { ok: true, value: { data: "", hasSession: false, truncated: false, redacted: false } };
    }
    const redaction = redactForModel(first.captureBuffer);
    return {
      ok: true,
      value: {
        data: redaction.text,
        hasSession: true,
        truncated: Buffer.byteLength(first.captureBuffer, "utf8") >= this.config.maxCaptureBytes,
        redacted: redaction.redacted
      }
    };
  }

  /**
   * Select the connection represented by the right-side terminal. For a
   * single connection, fall back to it so a normal conversational request
   * never has to expose an implementation-only UUID to the user.
   */
  resolveConnection(connectionId) {
    if (connectionId !== undefined) {
      const meta = this.connectionMeta.get(connectionId);
      if (meta !== undefined) {
        return {
          ok: true,
          connectionId,
          connection: { id: connectionId, ...meta }
        };
      }
      return { ok: false, error: fail("no-connection", `connection "${connectionId}" does not exist`) };
    }
    if (this.activeConnectionId !== null) {
      const meta = this.connectionMeta.get(this.activeConnectionId);
      if (meta !== undefined) {
        return {
          ok: true,
          connectionId: this.activeConnectionId,
          connection: { id: this.activeConnectionId, ...meta }
        };
      }
      this.activeConnectionId = null;
    }
    if (this.connectionMeta.size === 1) {
      const [resolvedId, meta] = this.connectionMeta.entries().next().value;
      return { ok: true, connectionId: resolvedId, connection: { id: resolvedId, ...meta } };
    }
    if (this.connectionMeta.size === 0) {
      return { ok: false, error: fail("no-connection", "no active SSH connection; connect a server in the SSH panel first") };
    }
    return { ok: false, error: fail("connection-selection-required", "multiple SSH connections are open; select a server in the SSH panel or provide connection_id") };
  }

  // ── SFTP (file management) ─────────────────────────────────────────────────

  /** List one remote directory: entries with type, size, mtime, and mode. */
  async sftpList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const remotePath = request.path || ".";
    try {
      const entries = await this.ctx.ssh.listDir(selected.connectionId, remotePath);
      const items = entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory,
        size: entry.size ?? 0,
        mtime: entry.mtimeMs ?? 0,
        mode: entry.isDirectory ? 0o040000 : 0o100000
      }));
      return { ok: true, value: { path: remotePath, entries: items } };
    } catch (error) {
      return { ok: false, error: fail("sftp-list-failed", `${remotePath}: ${error.message}`) };
    }
  }

  /** Stat one remote path. */
  async sftpStat(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    try {
      const attrs = await this.ctx.ssh.stat(selected.connectionId, request.path);
      return {
        ok: true,
        value: {
          path: attrs.path,
          isDirectory: attrs.isDirectory,
          size: attrs.size ?? 0,
          mtime: attrs.mtimeMs ?? 0,
          mode: attrs.isDirectory ? 0o040000 : 0o100000
        }
      };
    } catch (error) {
      return { ok: false, error: fail("sftp-stat-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Read a remote file as base64 (bounded; large files spill a hint). */
  async sftpReadFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const maxBytes = request.maxBytes ?? 4 * 1024 * 1024;
    try {
      const bytes = await this.ctx.ssh.readFile(selected.connectionId, request.path);
      const truncated = bytes.byteLength > maxBytes;
      const slice = truncated ? bytes.subarray(0, maxBytes) : bytes;
      const data = Buffer.from(slice).toString("base64");
      return { ok: true, value: { path: request.path, data, truncated, bytes: bytes.byteLength } };
    } catch (error) {
      return { ok: false, error: fail("sftp-read-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Write base64 content to a remote file. */
  async sftpWriteFile(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    try {
      const buf = Buffer.from(request.data, "base64");
      await this.ctx.ssh.writeFile(selected.connectionId, request.path, new Uint8Array(buf));
      return { ok: true, value: { path: request.path, bytes: buf.length } };
    } catch (error) {
      return { ok: false, error: fail("sftp-write-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Create a remote directory (mkdir -p semantics via mkdir + stat). */
  async sftpMkdir(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    try {
      await this.ctx.ssh.mkdir(selected.connectionId, request.path);
      return { ok: true, value: { path: request.path } };
    } catch (error) {
      return { ok: false, error: fail("sftp-mkdir-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Delete a remote file (or empty directory). */
  async sftpDelete(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    try {
      const attrs = await this.ctx.ssh.stat(selected.connectionId, request.path);
      await this.ctx.ssh.remove(selected.connectionId, request.path);
      return { ok: true, value: { path: request.path, isDirectory: attrs.isDirectory } };
    } catch (error) {
      return { ok: false, error: fail("sftp-delete-failed", `${request.path}: ${error.message}`) };
    }
  }

  /** Rename a remote file or directory. */
  async sftpRename(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    try {
      await this.ctx.ssh.rename(selected.connectionId, request.from, request.to);
      return { ok: true, value: { from: request.from, to: request.to } };
    } catch (error) {
      return { ok: false, error: fail("sftp-rename-failed", `${request.from} -> ${request.to}: ${error.message}`) };
    }
  }

  // ── Port forwarding (tunnels) ──────────────────────────────────────────────

  /**
   * Start a local port forward via the ssh2 provider when available.
   */
  async tunnelStartLocal(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const ssh = this.ctx.ssh;
    if (typeof ssh.tunnelStartLocal !== "function") {
      return { ok: false, error: fail("tunnel-unsupported", "SSH provider does not support local tunnels") };
    }
    try {
      const value = await ssh.tunnelStartLocal({
        connectionId: selected.connectionId,
        bindAddr: request.bindAddr,
        bindPort: request.bindPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `local ${request.bindAddr ?? "127.0.0.1"}:${request.bindPort ?? 0} -> ${request.remoteHost}:${request.remotePort}: ${error.message}`) };
    }
  }

  /**
   * Start a remote port forward via the ssh2 provider when available.
   */
  async tunnelStartRemote(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const ssh = this.ctx.ssh;
    if (typeof ssh.tunnelStartRemote !== "function") {
      return { ok: false, error: fail("tunnel-unsupported", "SSH provider does not support remote tunnels") };
    }
    try {
      const value = await ssh.tunnelStartRemote({
        connectionId: selected.connectionId,
        bindAddr: request.bindAddr,
        bindPort: request.bindPort,
        remoteHost: request.remoteHost,
        remotePort: request.remotePort,
        targetHost: request.targetHost,
        targetPort: request.targetPort
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("tunnel-start-failed", `remote ${request.bindAddr ?? "127.0.0.1"}:${request.bindPort ?? 0}: ${error.message}`) };
    }
  }

  /** Stop a tunnel by id. */
  async tunnelStop(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const ssh = this.ctx.ssh;
    if (typeof ssh.tunnelStop !== "function") {
      return { ok: false, error: fail("tunnel-unsupported", "SSH provider does not support tunnels") };
    }
    try {
      const value = await ssh.tunnelStop({
        connectionId: selected.connectionId,
        tunnelId: request.tunnelId
      });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("tunnel-stop-failed", error.message) };
    }
  }

  /** List tunnels on a connection. */
  async tunnelList(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const ssh = this.ctx.ssh;
    if (typeof ssh.tunnelList !== "function") {
      return { ok: false, error: fail("tunnel-unsupported", "SSH provider does not support tunnels") };
    }
    try {
      const value = await ssh.tunnelList({ connectionId: selected.connectionId });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("tunnel-list-failed", error.message) };
    }
  }

  // ── SSH config import ──────────────────────────────────────────────────────

  /**
   * Parse the user's ~/.ssh/config and return host entries suitable for
   * saving as profiles. Each Host block becomes one entry with host, port,
   * user, and auth kind (key path is detected but the key content is NOT
   * read — the caller saves the path and the profile connect flow reads it
   * at connect time).
   */
  async sshConfigImport() {
    const { readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const os = await import("node:os");
    const configPath = join(os.default.homedir(), ".ssh", "config");
    if (!existsSync(configPath)) {
      return { ok: false, error: fail("no-ssh-config", `~/.ssh/config not found at ${configPath}`) };
    }
    let content;
    try {
      content = readFileSync(configPath, "utf8");
    } catch (error) {
      return { ok: false, error: fail("ssh-config-read-failed", error.message) };
    }
    const hosts = [];
    let current = null;
    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;
      const spaceIdx = line.search(/\s/);
      if (spaceIdx === -1) continue;
      const key = line.slice(0, spaceIdx).toLowerCase();
      const value = line.slice(spaceIdx + 1).trim();
      if (key === "host") {
        // Skip wildcards like Host *
        if (value.includes("*")) { current = null; continue; }
        if (current !== null) hosts.push(current);
        current = { name: value, host: value, port: 22, username: "", authKind: "key", identityFile: "", proxyJump: "" };
      } else if (current !== null) {
        if (key === "hostname") current.host = value;
        else if (key === "port") current.port = parseInt(value, 10) || 22;
        else if (key === "user") current.username = value;
        else if (key === "identityfile") current.identityFile = value.replace(/^~/, os.default.homedir());
        else if (key === "proxyjump") current.proxyJump = value;
      }
    }
    if (current !== null) hosts.push(current);
    return { ok: true, value: { hosts } };
  }

  /** Execute a command on the explicit or current SSH connection. */
  async executeCommand(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = await this.execOnConnection(selected.connectionId, request.command, request.timeoutMs);
    if (!result.ok) return result;
    const { exitCode, stdout, stderr, commandId, startedAt, finishedAt, durationMs, truncated, timedOut } = result.value;
    const safeStdout = redactForModel(stdout);
    const safeStderr = redactForModel(stderr);
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        exitCode,
        stdout: safeStdout.text,
        stderr: safeStderr.text,
        commandId,
        startedAt,
        finishedAt,
        durationMs,
        truncated,
        timedOut,
        redacted: safeStdout.redacted || safeStderr.redacted
      }
    };
  }

  /** Read terminal output from the explicit or current SSH connection. */
  readCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    const result = this.readConnectionOutput(selected.connectionId);
    if (!result.ok) return result;
    return {
      ok: true,
      value: {
        connectionId: selected.connectionId,
        host: selected.connection.host,
        ...result.value
      }
    };
  }

  /** Send tool input to the explicit or current SSH connection. */
  writeCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.writeToConnection(selected.connectionId, request.input);
  }

  /** Disconnect the explicit or current SSH connection. */
  async disconnectCurrentConnection(request) {
    const selected = this.resolveConnection(request.connectionId);
    if (!selected.ok) return selected;
    return this.disconnect({ connectionId: selected.connectionId });
  }

  /** Append transport data and retain a bounded, explicit-read capture. */
  appendSessionOutput(session, text, { capture = true, observePrompt = true } = {}) {
    session.buffer = tailCapped((session.buffer ?? "") + text, this.config.maxBufferBytes);
    if (capture) {
      session.captureBuffer = tailCapped((session.captureBuffer ?? "") + text, this.config.maxCaptureBytes);
    }
    if (observePrompt) {
      const prompt = promptFromTerminalData(text);
      if (prompt !== null) session.lastPrompt = prompt;
    }
    this.wakeWaiters(session, null);
  }

  fallbackPrompt(connection) {
    return `${connection.username}@${connection.host}:~${connection.username === "root" ? "#" : "$"} `;
  }

  // ── Agent tools ────────────────────────────────────────────────────────────

  registerTools(ctx) {
    // defineTool invokes execute as a bare function; bind the service via closure.
    const service = this;
    ctx.tools.register(defineTool({
      name: "ssh_list",
      description: "List currently open SSH connections and identify the active server. This reports only live connection metadata (name, host, port, username and active state); it never lists saved SSH resources or credentials. Use it only when the user asks which server is connected. For normal server work, ssh_exec/ssh_read/ssh_write already target the active connection automatically.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            activeConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
            connections: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  connectionId: { type: "string", required: true },
                  name: { type: "string" },
                  host: { type: "string", required: true },
                  port: { type: "integer", required: true },
                  username: { type: "string", required: true },
                  connected: { type: "boolean", required: true },
                  sessions: { type: "array", required: true, items: { type: "string" } }
                }
              }
            }
          }
        },
        render(_args, value) {
          if (value.connections.length === 0) return [{ type: "text", text: "No SSH connection is currently open." }];
          const lines = value.connections.map((connection) => `${connection.connectionId === value.activeConnectionId ? "* " : "- "}${connection.name ?? connection.host}: ${connection.username}@${connection.host}:${connection.port}${connection.sessions.length ? " (terminal open)" : ""}`);
          return [{ type: "text", text: lines.join("\n") }];
        }
      },
      async execute() {
        const result = await service.list();
        if (!result.ok) throw new Error(`ssh_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_connect",
      description: "Connect to a remote server over SSH, open it in the right-side terminal, and make it the current connection for later SSH tools. Subsequent ssh_exec, ssh_read, ssh_write, and ssh_disconnect calls automatically use this connection unless a connection_id is explicitly supplied.",
      parameters: {
        host: { type: "string", required: true, description: "Remote hostname or IP address." },
        port: { type: "integer", description: "SSH port, defaults to 22." },
        username: { type: "string", required: true, description: "SSH username." },
        auth: {
          type: "object",
          required: true,
          additionalProperties: false,
          description: "Authentication. Either {kind: 'password', password} or {kind: 'key', privateKey, passphrase?}.",
          properties: {
            kind: { type: "string", enum: ["password", "key"], required: true },
            password: { type: "string" },
            privateKey: { type: "string" },
            passphrase: { type: "string" }
          }
        },
        name: { type: "string", description: "Optional display name for this connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            name: { type: "string" },
            host: { type: "string", required: true },
            port: { type: "integer", required: true },
            username: { type: "string", required: true }
          }
        },
        render(args, value) {
          const conn = value ?? {};
          return [{ type: "text", text: `Connected ${args.username}@${args.host} (id: ${conn.connectionId ?? "?"})` }];
        }
      },
      async execute(args) {
        const result = await service.connect({
          host: args.host,
          port: args.port,
          username: args.username,
          auth: args.auth,
          name: args.name
        });
        if (!result.ok) throw new Error(`ssh_connect failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_exec",
      description: "Run a normal SSH command on the server currently open in the right-side SSH terminal and return its output. Omit connection_id when the user means the current server; do not call ssh_list first. SSL configuration, package changes, service reloads, and config edits are allowed and remain subject to DSH permissions. Explicitly destructive or irreversible operations are blocked from agent execution and must be typed manually by the user in the SSH terminal. The command and output are also shown in the terminal panel.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
        command: { type: "string", required: true, description: "The shell command to execute." },
        timeout_ms: { type: "integer", description: "Timeout in milliseconds, defaults to 30000." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            host: { type: "string", required: true },
            exitCode: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
            stdout: { type: "string", required: true },
            stderr: { type: "string", required: true },
            commandId: { type: "string", required: true },
            startedAt: { type: "string", required: true },
            finishedAt: { type: "string", required: true },
            durationMs: { type: "integer", required: true },
            truncated: { type: "boolean", required: true },
            timedOut: { type: "boolean", required: true },
            redacted: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const out = value.stdout ?? "";
          const err = value.stderr ?? "";
          let body = out;
          if (err.length > 0) {
            if (body.length > 0 && !body.endsWith("\n")) body += "\n";
            body += `[stderr]\n${err}`;
          }
          if (body.length === 0) body = "(no output)";
          if (value.exitCode !== null && value.exitCode !== 0) body += `\n[exit code: ${value.exitCode}]`;
          if (value.timedOut) body += "\n[command timed out]";
          if (value.truncated) body += "\n[output truncated for safe model context]";
          if (value.redacted) body += "\n[sensitive values redacted]";
          return [{ type: "text", text: body }];
        }
      },
      async execute(args) {
        const result = await service.executeCommand({
          connectionId: args.connection_id,
          command: args.command,
          timeoutMs: args.timeout_ms ?? 30000
        });
        if (!result.ok) throw new Error(`ssh_exec failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_read",
      description: "Read buffered output from the current right-side SSH terminal. Omit connection_id for the current server; do not call ssh_list first. Useful after ssh_write or when the user typed something in the panel.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            connectionId: { type: "string", required: true },
            host: { type: "string", required: true },
            data: { type: "string", required: true },
            hasSession: { type: "boolean", required: true },
            truncated: { type: "boolean", required: true },
            redacted: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const body = !value.hasSession
            ? "(no open shell session on this connection)"
            : value.data || "(no output yet)";
          const notes = [
            value.truncated ? "[terminal capture truncated]" : "",
            value.redacted ? "[sensitive values redacted]" : ""
          ].filter(Boolean);
          return [{ type: "text", text: notes.length > 0 ? `${body}\n${notes.join("\n")}` : body }];
        }
      },
      async execute(args) {
        const result = service.readCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`ssh_read failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_write",
      description: "Send input into the current right-side SSH terminal. Omit connection_id for the current server. Normal operations are permitted through DSH permissions; explicitly destructive or irreversible commands are stopped before agent execution. Ctrl-C remains available to cancel an in-progress command.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." },
        input: { type: "string", required: true, description: "The input to send, e.g. 'y\\n' to answer a prompt." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            written: { type: "integer", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Sent ${value.written} bytes to the terminal session.` }];
        }
      },
      async execute(args) {
        const result = service.writeCurrentConnection({ connectionId: args.connection_id, input: args.input });
        if (!result.ok) throw new Error(`ssh_write failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_disconnect",
      description: "Close the current SSH connection and any open shell sessions on it. Omit connection_id for the current right-side SSH server.",
      parameters: {
        connection_id: { type: "string", description: "Optional. Omit to target the current right-side SSH connection." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            disconnected: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: value.disconnected ? "Disconnected." : "Connection not found." }];
        }
      },
      async execute(args) {
        const result = await service.disconnectCurrentConnection({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`ssh_disconnect failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_list",
      description: "List the entries of a remote directory over SFTP on a connected server (the one open in the right-side SSH terminal unless connection_id is given). Returns file/directory entries with sizes and mtimes.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote directory path, e.g. /etc or /var/log." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            entries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
              name: { type: "string", required: true },
              isDirectory: { type: "boolean", required: true },
              size: { type: "number", required: true },
              mtime: { type: "number", required: true },
              mode: { type: "number", required: true }
            } } }
          }
        },
        render(args, value) {
          if (!value.entries.length) return [{ type: "text", text: `(empty directory ${value.path})` }];
          const lines = value.entries.map((e) => `${e.isDirectory ? "d" : "-"} ${e.isDirectory ? "" : String(e.size).padStart(10)}  ${new Date(e.mtime).toISOString().slice(0, 16).replace("T", " ")}  ${e.name}`);
          return [{ type: "text", text: `Directory ${value.path} (${value.entries.length} entries):\n` + lines.join("\n") }];
        }
      },
      async execute(args) {
        const result = await service.sftpList({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`sftp_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_read",
      description: "Read a remote file's contents over SFTP (base64-decoded to text). Useful for inspecting config files, logs, or small artifacts on a connected server. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote file path." },
        max_bytes: { type: "integer", description: "Maximum bytes to read, defaults to 4 MiB." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            data: { type: "string", required: true },
            truncated: { type: "boolean", required: true },
            bytes: { type: "number", required: true }
          }
        },
        render(args, value) {
          const body = value.data || "(empty file)";
          return [{ type: "text", text: value.truncated ? `${body}\n[output truncated at ${value.bytes} bytes]` : body }];
        }
      },
      async execute(args) {
        const result = await service.sftpReadFile({ connectionId: args.connection_id, path: args.path, maxBytes: args.max_bytes });
        if (!result.ok) throw new Error(`sftp_read failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_write",
      description: "Write text content to a remote file over SFTP (creates or overwrites). Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote file path to write." },
        content: { type: "string", required: true, description: "File content to write." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", required: true },
            bytes: { type: "number", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Wrote ${value.bytes} bytes to ${value.path}` }];
        }
      },
      async execute(args) {
        const result = await service.sftpWriteFile({ connectionId: args.connection_id, path: args.path, data: Buffer.from(args.content, "utf8").toString("base64") });
        if (!result.ok) throw new Error(`sftp_write failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_mkdir",
      description: "Create a remote directory over SFTP. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote directory path to create." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true } } },
        render(args, value) { return [{ type: "text", text: `Created directory ${value.path}` }]; }
      },
      async execute(args) {
        const result = await service.sftpMkdir({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`sftp_mkdir failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_delete",
      description: "Delete a remote file or empty directory over SFTP. Omit connection_id for the current server. Deleting is irreversible; only proceed when the user explicitly asked.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        path: { type: "string", required: true, description: "Remote path to delete." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { path: { type: "string", required: true }, isDirectory: { type: "boolean", required: true } } },
        render(args, value) { return [{ type: "text", text: `Deleted ${value.path}` }]; }
      },
      async execute(args) {
        const result = await service.sftpDelete({ connectionId: args.connection_id, path: args.path });
        if (!result.ok) throw new Error(`sftp_delete failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "sftp_rename",
      description: "Rename or move a remote file/directory over SFTP. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        from: { type: "string", required: true, description: "Current remote path." },
        to: { type: "string", required: true, description: "New remote path." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { from: { type: "string", required: true }, to: { type: "string", required: true } } },
        render(args, value) { return [{ type: "text", text: `Renamed ${value.from} -> ${value.to}` }]; }
      },
      async execute(args) {
        const result = await service.sftpRename({ connectionId: args.connection_id, from: args.from, to: args.to });
        if (!result.ok) throw new Error(`sftp_rename failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_start",
      description: "Start a port forward through a connected server. kind='local' (default): the DSH host listens on bind_addr:bind_port and forwards to remote_host:remote_port on the server — use to reach services only the server can see. kind='remote': the server listens on remote_host:remote_port and forwards back to target_host:target_port on this machine. Returns a tunnel_id for tunnel_stop.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        kind: { type: "string", enum: ["local", "remote"], description: "Forward direction: 'local' (default) or 'remote'." },
        bind_addr: { type: "string", description: "Local bind address (local kind), defaults to 127.0.0.1." },
        bind_port: { type: "integer", description: "Local bind port (local kind); 0 picks a free port." },
        remote_host: { type: "string", required: true, description: "The remote host to reach (local kind) or to listen on (remote kind)." },
        remote_port: { type: "integer", required: true, description: "The remote port to reach (local kind) or to listen on (remote kind)." },
        target_host: { type: "string", description: "Local target host for remote kind, defaults to 127.0.0.1." },
        target_port: { type: "integer", description: "Local target port for remote kind (required when kind='remote')." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tunnelId: { type: "string", required: true },
            kind: { type: "string", required: true },
            bindAddr: { type: "string", required: true },
            bindPort: { type: "number", required: true },
            remoteHost: { type: "string", required: true },
            remotePort: { type: "number", required: true },
            targetHost: { type: "string" },
            targetPort: { type: "number" }
          }
        },
        render(args, value) {
          return [{ type: "text", text: value.kind === "local"
            ? `Tunnel started: ${value.bindAddr}:${value.bindPort} -> ${value.remoteHost}:${value.remotePort} (id: ${value.tunnelId})`
            : `Remote forward started: ${value.remoteHost}:${value.remotePort} -> ${value.bindAddr}:${value.bindPort} (id: ${value.tunnelId})` }];
        }
      },
      async execute(args) {
        const result = args.kind === "remote"
          ? await service.tunnelStartRemote({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port, targetHost: args.target_host ?? "127.0.0.1", targetPort: args.target_port })
          : await service.tunnelStartLocal({ connectionId: args.connection_id, bindAddr: args.bind_addr, bindPort: args.bind_port, remoteHost: args.remote_host, remotePort: args.remote_port });
        if (!result.ok) throw new Error(`tunnel_start failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_list",
      description: "List active port forwards on a connected server. Omit connection_id for the current server.",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            tunnels: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
              tunnelId: { type: "string", required: true },
              kind: { type: "string", required: true },
              bindAddr: { type: "string", required: true },
              bindPort: { type: "number", required: true },
              remoteHost: { type: "string" },
              remotePort: { type: "number" },
              targetHost: { type: "string" },
              targetPort: { type: "number" },
              active: { type: "boolean", required: true }
            } } }
          }
        },
        render(args, value) {
          if (!value.tunnels.length) return [{ type: "text", text: "(no active tunnels)" }];
          return [{ type: "text", text: value.tunnels.map((t) => `${t.kind}: ${t.bindAddr}:${t.bindPort} -> ${t.remoteHost}:${t.remotePort} (${t.tunnelId})`).join("\n") }];
        }
      },
      async execute(args) {
        const result = await service.tunnelList({ connectionId: args.connection_id });
        if (!result.ok) throw new Error(`tunnel_list failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "tunnel_stop",
      description: "Stop an active port forward by tunnel_id (see tunnel_list / tunnel_start).",
      parameters: {
        connection_id: { type: "string", description: "Connection id from ssh_connect; omit to use the current server." },
        tunnel_id: { type: "string", required: true, description: "The tunnel id returned by tunnel_start." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { tunnelId: { type: "string", required: true }, stopped: { type: "boolean", required: true } } },
        render(args, value) { return [{ type: "text", text: `Stopped tunnel ${value.tunnelId}` }]; }
      },
      async execute(args) {
        const result = await service.tunnelStop({ connectionId: args.connection_id, tunnelId: args.tunnel_id });
        if (!result.ok) throw new Error(`tunnel_stop failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "ssh_cluster",
      description: "Run one command concurrently across all open SSH connections (or a filtered subset by connection IDs). Returns per-connection results with exit codes and output. IMPORTANT: Only use this tool when the user EXPLICITLY asks to run a command on multiple servers (e.g. 'check disk space on all servers', 'restart nginx on every machine'). For single-server operations, always use ssh_exec instead — never use ssh_cluster just because multiple connections happen to be open.",
      parameters: {
        command: { type: "string", required: true, description: "The shell command to execute on every target." },
        connection_ids: {
          type: "array",
          description: "Optional list of connection IDs to target. Omit to run on ALL currently open connections.",
          items: { type: "string" }
        },
        timeout_ms: { type: "integer", description: "Per-connection timeout in milliseconds, defaults to 30000." }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              required: true,
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  connectionId: { type: "string", required: true },
                  name: { type: "string" },
                  host: { type: "string", required: true },
                  ok: { type: "boolean", required: true },
                  exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
                  stdout: { type: "string", required: true },
                  stderr: { type: "string", required: true },
                  error: { type: "string" }
                }
              }
            }
          }
        },
        render(args, value) {
          if (!value.results.length) return [{ type: "text", text: "No connections to run against." }];
          return [{ type: "text", text: value.results.map((r) => {
            const tag = r.ok ? "ok" : "fail";
            const tail = r.error ? ` (${r.error})` : "";
            const out = r.stdout ? `\n${r.stdout}` : "";
            return `${r.name ?? r.host} [${tag}] exit=${r.exitCode ?? "?"}${tail}${out}`;
          }).join("\n\n") }];
        }
      },
      async execute(args) {
        const listed = await service.list();
        if (!listed.ok) return { results: [] };
        const all = listed.value.connections;
        const targets = (args.connection_ids && args.connection_ids.length > 0)
          ? all.filter((c) => args.connection_ids.includes(c.connectionId))
          : all;
        if (targets.length === 0) {
          return { results: [] };
        }
        const timeoutMs = args.timeout_ms ?? 30000;
        const results = await Promise.all(targets.map(async (conn) => {
          try {
            const result = await service.execOnConnection(conn.connectionId, args.command, timeoutMs);
            if (!result.ok) {
              return { connectionId: conn.connectionId, name: conn.name, host: conn.host, ok: false, exitCode: null, stdout: "", stderr: "", error: result.error.message };
            }
            return {
              connectionId: conn.connectionId,
              name: conn.name,
              host: conn.host,
              ok: true,
              exitCode: result.value.exitCode,
              stdout: result.value.stdout,
              stderr: result.value.stderr,
              error: undefined
            };
          } catch (error) {
            return { connectionId: conn.connectionId, name: conn.name, host: conn.host, ok: false, exitCode: null, stdout: "", stderr: "", error: error.message };
          }
        }));
        return { results };
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_connect",
      description: "Connect to a database (MySQL, PostgreSQL, Redis, or MongoDB) so the agent can query or run commands in later db_query/db_execute/db_run calls. When an SSH server is connected, a loopback host (127.0.0.1/localhost) is automatically tunneled through the current server (via_ssh=auto), so 'connect to the database on the server' works without an internal connection id; pass via_ssh='no' to force a local connection, or ssh_connection_id to pick a specific server. For cloud-managed databases requiring TLS, set ssl to 'verify' (public-CA certs) or 'preferred' (self-signed certs). Returns a db_connection_id.",
      parameters: {
        type: { type: "string", enum: ["mysql", "postgresql", "redis", "mongodb"], required: true, description: "Database type." },
        host: { type: "string", required: true, description: "Database host. When reached via SSH, this is the address as seen from the SSH server (127.0.0.1 if the DB runs on that server)." },
        port: { type: "integer", required: true, description: "Database port (e.g. 3306 MySQL, 5432 PostgreSQL, 6379 Redis, 27017 MongoDB)." },
        database: { type: "string", description: "Database/schema name (MySQL/PostgreSQL/MongoDB) or numeric DB index (Redis)." },
        username: { type: "string", description: "Database username (not needed for Redis)." },
        password: { type: "string", description: "Database password." },
        ssl: { type: "string", enum: ["disabled", "preferred", "verify"], description: "TLS mode: 'disabled' (default) plain TCP; 'preferred' encrypt without cert verification (self-signed cloud DBs); 'verify' encrypt and verify CA (public-CA cloud DBs)." },
        ssh_connection_id: { type: "string", description: "Optional. An existing SSH connection id to tunnel through, reaching databases on private networks. Takes precedence over via_ssh." },
        via_ssh: { type: "string", enum: ["auto", "yes", "no"], description: "Tunnel routing when ssh_connection_id is omitted: 'auto' (default) tunnels loopback hosts (127.0.0.1/localhost) through the current SSH server; 'yes' always tunnels through the current server; 'no' always connects directly." },
        name: { type: "string", description: "Optional display name." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            dbConnectionId: { type: "string", required: true },
            name: { type: "string", required: true },
            type: { type: "string", required: true }
          }
        },
        render(args, value) {
          return [{ type: "text", text: `Connected ${value.type} ${args.host}:${args.port} (id: ${value.dbConnectionId})` }];
        }
      },
      async execute(args) {
        const routed = pickSshConnectionId({
          sshConnectionId: args.ssh_connection_id,
          viaSsh: args.via_ssh,
          host: args.host,
          resolveActive: () => service.resolveConnection(undefined)
        });
        if (routed.error) throw new Error(`db_connect failed: ${routed.error.message}`);
        const result = await service.dbConnect({
          type: args.type, host: args.host, port: args.port, database: args.database,
          username: args.username, password: args.password, ssl: args.ssl,
          sshConnectionId: routed.sshConnectionId, name: args.name
        });
        if (!result.ok) throw new Error(`db_connect failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_list_connections",
      description: "List currently open database connections (db_connection_id, type, host, port). Use it only when the user asks which databases are connected.",
      parameters: {},
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            connections: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                dbConnectionId: { type: "string", required: true },
                name: { type: "string", required: true },
                type: { type: "string", required: true },
                host: { type: "string", required: true },
                port: { type: "integer", required: true },
                database: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                ssl: { type: "string", required: true },
                sshConnectionId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
                createdAt: { type: "string", required: true }
              }
            }}
          }
        },
        render(_args, value) {
          if (!value.connections.length) return [{ type: "text", text: "No database connection is currently open." }];
          return [{ type: "text", text: value.connections.map((c) => `- ${c.name} (${c.type}): ${c.host}:${c.port}${c.sshConnectionId ? " via SSH" : ""} (id: ${c.dbConnectionId})`).join("\n") }];
        }
      },
      async execute() {
        const result = await service.dbListConnections({});
        if (!result.ok) throw new Error(`db_list_connections failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_query",
      description: "Run a read-only SQL query (SELECT) on a connected MySQL or PostgreSQL database and return columns and rows. For Redis or MongoDB, use db_run instead. Results are capped at 200 rows.",
      parameters: {
        db_connection_id: { type: "string", required: true, description: "A db_connection_id from db_connect." },
        sql: { type: "string", required: true, description: "SELECT statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
        params: { type: "array", description: "Optional parameter values for placeholders." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            columns: { type: "array", required: true, items: { type: "string" } },
            rows: { type: "array", required: true, items: { type: "object", additionalProperties: true } },
            rowCount: { type: "integer", required: true },
            truncated: { type: "boolean", required: true }
          }
        },
        render(args, value) {
          const header = value.columns.join("\t");
          const body = value.rows.map((r) => value.columns.map((c) => r[c] ?? "").join("\t")).join("\n");
          let text = header.length > 0 ? `${header}\n${body}` : "(empty)";
          if (value.truncated) text += "\n[truncated to 200 rows]";
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbQuery({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params });
        if (!result.ok) throw new Error(`db_query failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_execute",
      description: "Run a write SQL statement (INSERT/UPDATE/DELETE/CREATE/ALTER) on a connected MySQL or PostgreSQL database. Destructive statements (DROP DATABASE/SCHEMA/TABLE, TRUNCATE, SHUTDOWN) are blocked and must be run manually. For Redis or MongoDB, use db_run instead.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        sql: { type: "string", required: true, description: "Write statement. MySQL uses ? placeholders, PostgreSQL uses $1 placeholders." },
        params: { type: "array", description: "Optional parameter values." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            affectedRows: { type: "integer", required: true },
            insertId: { oneOf: [{ type: "integer" }, { type: "string" }] },
            truncated: { type: "boolean", required: true }
          }
        },
        render(_args, value) {
          let text = `Affected ${value.affectedRows} row(s).`;
          if (value.insertId !== undefined) text += ` Insert id: ${value.insertId}.`;
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbExecute({ dbConnectionId: args.db_connection_id, sql: args.sql, params: args.params });
        if (!result.ok) throw new Error(`db_execute failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_list_tables",
      description: "List tables in the current schema of a connected MySQL or PostgreSQL database. For MongoDB, use db_run with operation 'countDocuments' on a collection instead.",
      parameters: {
        db_connection_id: { type: "string", required: true }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { tables: { type: "array", required: true, items: { type: "string" } } } },
        render(_args, value) {
          return [{ type: "text", text: value.tables.length ? value.tables.join("\n") : "(no tables)" }];
        }
      },
      async execute(args) {
        const result = await service.dbListTables({ dbConnectionId: args.db_connection_id });
        if (!result.ok) throw new Error(`db_list_tables failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_describe_table",
      description: "Describe the columns of a table in a connected MySQL or PostgreSQL database (name, type, nullable, default).",
      parameters: {
        db_connection_id: { type: "string", required: true },
        table: { type: "string", required: true, description: "Table name." }
      },
      output: {
        schema: {
          type: "object", additionalProperties: false,
          properties: {
            table: { type: "string", required: true },
            columns: { type: "array", required: true, items: {
              type: "object", additionalProperties: false,
              properties: {
                name: { type: "string", required: true },
                type: { type: "string", required: true },
                nullable: { type: "boolean", required: true },
                key: { type: "string" },
                default: { oneOf: [{ type: "string" }, { type: "null" }, { type: "number" }] },
                extra: { oneOf: [{ type: "string" }, { type: "null" }] }
              }
            }}
          }
        },
        render(args, value) {
          const body = value.columns.map((c) => `${c.name}\t${c.type}\t${c.nullable ? "NULL" : "NOT NULL"}${c.default !== undefined && c.default !== null ? `\tDEFAULT ${c.default}` : ""}`).join("\n");
          return [{ type: "text", text: `${args.table}:\n${body}` }];
        }
      },
      async execute(args) {
        const result = await service.dbDescribeTable({ dbConnectionId: args.db_connection_id, table: args.table });
        if (!result.ok) throw new Error(`db_describe_table failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_run",
      description: "Run a command on a connected Redis or MongoDB database. Redis: pass {command, args} (e.g. command='GET', args=['mykey'], or command='KEYS', args=['*']). MongoDB: pass {collection, operation} where operation is 'find'|'findOne'|'insertOne'|'updateOne'|'deleteOne'|'countDocuments', plus filter/document/update as needed. For MySQL/PostgreSQL, use db_query or db_execute instead.",
      parameters: {
        db_connection_id: { type: "string", required: true },
        command: { type: "string", description: "Redis command name (e.g. GET, SET, KEYS, HGETALL)." },
        args: { type: "array", description: "Redis command arguments (as strings)." },
        collection: { type: "string", description: "MongoDB collection name." },
        operation: { type: "string", enum: ["find", "findOne", "insertOne", "updateOne", "deleteOne", "countDocuments"], description: "MongoDB operation." },
        filter: { type: "object", additionalProperties: true, description: "MongoDB query filter (for find/findOne/updateOne/deleteOne/countDocuments)." },
        document: { type: "object", additionalProperties: true, description: "MongoDB document to insert (insertOne)." },
        update: { type: "object", additionalProperties: true, description: "MongoDB update spec (updateOne)." },
        options: { type: "object", additionalProperties: true, description: "MongoDB update options (updateOne)." }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { result: { type: "json" } } },
        render(_args, value) {
          const text = typeof value.result === "string" ? value.result : JSON.stringify(value.result, null, 2);
          return [{ type: "text", text }];
        }
      },
      async execute(args) {
        const result = await service.dbRun({
          dbConnectionId: args.db_connection_id, command: args.command, args: args.args,
          collection: args.collection, operation: args.operation, filter: args.filter,
          document: args.document, update: args.update, options: args.options
        });
        if (!result.ok) throw new Error(`db_run failed: ${result.error.message}`);
        return result.value;
      }
    }));

    ctx.tools.register(defineTool({
      name: "db_disconnect",
      description: "Close a database connection opened with db_connect. Use it when the user is done querying a database.",
      parameters: {
        db_connection_id: { type: "string", required: true }
      },
      output: {
        schema: { type: "object", additionalProperties: false, properties: { dbConnectionId: { type: "string", required: true }, disconnected: { type: "boolean", required: true } } },
        render(args) { return [{ type: "text", text: `Disconnected ${args.db_connection_id}` }]; }
      },
      async execute(args) {
        const result = await service.dbDisconnect({ dbConnectionId: args.db_connection_id });
        if (!result.ok) throw new Error(`db_disconnect failed: ${result.error.message}`);
        return result.value;
      }
    }));

  }

  // ── internals ──────────────────────────────────────────────────────────────

  recordExit(session, exit) {
    if (session.exited !== null) return;
    session.exited = exit;
    this.wakeWaiters(session, exit);
  }

  rememberExit(id, exit) {
    if (this.exitedSessions.size >= 64) {
      const oldest = this.exitedSessions.keys().next().value;
      if (oldest !== void 0) this.exitedSessions.delete(oldest);
    }
    this.exitedSessions.set(id, exit);
  }

  wakeWaiters(session, exit) {
    if (session.waiters.length === 0) return;
    session.waiters.shift().resolve({
      ok: true,
      value: { data: this.drain(session), exit }
    });
    if (exit !== null) {
      for (const rest of session.waiters.splice(0)) {
        rest.resolve({ ok: true, value: { data: "", exit } });
      }
    }
  }

  drain(session) {
    const pending = session.buffer;
    session.buffer = "";
    return encodeData(pending);
  }
}
