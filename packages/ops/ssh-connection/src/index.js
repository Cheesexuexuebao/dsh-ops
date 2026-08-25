/**
 * dsh-ssh-connection host half: a Typert Remote service named `sshConnection`
 * that owns saved SSH resources and live transport metadata. Transport itself
 * is provided by ctx.ssh (dsh-ssh-ssh2); this plugin opens the profile domain
 * and wraps connect / disconnect / list / profileConnect.
 */
import { randomUUID } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { z } from "zod";

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

function fail(code, message) {
  return { code, message };
}

function profileCredentialRefs(profileId) {
  const stem = profileId.replaceAll("-", "").toUpperCase();
  return {
    password: `DSH_SSH_OPS_${stem}_PASSWORD`,
    privateKey: `DSH_SSH_OPS_${stem}_PRIVATE_KEY`,
    passphrase: `DSH_SSH_OPS_${stem}_PASSPHRASE`
  };
}

/**
 * SshConnectionService: one cordis service (and Typert Remote) that owns SSH
 * resource inventory and live-connection metadata for the web profile.
 */
export default class SshConnectionService extends TypertRemoteService {
  static inject = ["storageDomain", "credentials", "ssh"];

  /**
   * Connection-side metadata for live transports owned by ctx.ssh.
   * connectionId -> { host, port, username, name?, profileId? }
   */
  connectionMeta = new Map();
  /** The connection currently marked active on ctx.ssh. */
  activeConnectionId = null;
  profileTable = null;
  groupTable = null;

  constructor(ctx, config = {}) {
    super(ctx, "sshConnection");
    this.config = { ...config };
    // Transport cleanup is owned by the ctx.ssh provider.
    ctx.effect(() => () => {
      this.connectionMeta.clear();
      this.activeConnectionId = null;
    }, "ssh-connection: cleanup");
  }

  async [Service.init]() {
    const domain = await this.ctx.storageDomain.open(profileDomainSpec);
    this.profileTable = domain.table("profiles");
    this.groupTable = domain.table("groups");
    this.ctx.effect(() => () => domain.close(), "ssh-connection: profile domain close");
  }

  // ── Remote methods ─────────────────────────────────────────────────────────

  async list() {
    const { connections: live, activeId } = await this.ctx.ssh.list();
    this.activeConnectionId = activeId;
    const connections = [];
    for (const c of live) {
      const meta = this.connectionMeta.get(c.id) ?? {};
      const connection = {
        connectionId: c.id,
        host: c.host,
        port: c.port,
        username: c.username,
        connected: true,
        sessions: []
      };
      const name = c.name ?? meta.name;
      if (name !== undefined) connection.name = name;
      if (meta.profileId !== undefined) connection.profileId = meta.profileId;
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
    try {
      const id = await this.ctx.ssh.connect({
        host: request.host,
        port: request.port ?? 22,
        username: request.username,
        auth: request.auth,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.readyTimeout !== undefined ? { readyTimeout: request.readyTimeout } : {}),
        ...(request.keepaliveInterval !== undefined ? { keepaliveInterval: request.keepaliveInterval } : {}),
        ...(request.keepaliveCountMax !== undefined ? { keepaliveCountMax: request.keepaliveCountMax } : {}),
        ...(Array.isArray(request.proxyJump) && request.proxyJump.length > 0 ? { proxyJump: request.proxyJump } : {})
      });
      this.connectionMeta.set(id, {
        host: request.host,
        port: request.port ?? 22,
        username: request.username,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(profileId !== undefined ? { profileId } : {})
      });
      this.ctx.ssh.setActive(id);
      this.activeConnectionId = id;
      const value = {
        connectionId: id,
        host: request.host,
        port: request.port ?? 22,
        username: request.username
      };
      if (request.name !== undefined) value.name = request.name;
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: fail("connect-failed", error.message) };
    }
  }

  requireProfileTable() {
    if (this.profileTable === null) throw new Error("SSH resource storage is not ready");
    return this.profileTable;
  }

  requireGroupTable() {
    if (this.groupTable === null) throw new Error("SSH resource storage is not ready");
    return this.groupTable;
  }

  groupPublic(groupId, record) {
    const profileCount = [...this.requireProfileTable().entries()].filter(([, profile]) => profile.groupId === groupId).length;
    return { groupId, name: record.name, profileCount };
  }

  async profilePublic(profileId, record) {
    const refs = profileCredentialRefs(profileId);
    const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
    const [primary, passphrase] = await Promise.all([
      this.ctx.credentials.describe(credentialRef(primaryRef)),
      this.ctx.credentials.describe(credentialRef(refs.passphrase))
    ]);
    let connectionId = null;
    for (const [id, connection] of this.connectionMeta.entries()) {
      if (connection.profileId === profileId) {
        connectionId = id;
        break;
      }
    }
    const group = record.groupId === null ? undefined : this.requireGroupTable().get(record.groupId);
    return {
      profileId,
      name: record.name,
      host: record.host,
      port: record.port,
      username: record.username,
      authKind: record.authKind,
      groupId: group === undefined ? null : record.groupId,
      groupName: group?.name ?? null,
      credentialConfigured: primary.configured,
      passphraseConfigured: passphrase.configured,
      connected: connectionId !== null,
      connectionId
    };
  }

  async profileList() {
    try {
      // Refresh meta against live transports so "已连接" / disconnect stay accurate.
      await this.list();
      const profiles = await Promise.all(
        [...this.requireProfileTable().entries()].map(async ([profileId, record]) => await this.profilePublic(profileId, record))
      );
      profiles.sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { profiles } };
    } catch (error) {
      return { ok: false, error: fail("profile-list-failed", error.message) };
    }
  }

  async profileSave(request) {
    try {
      const table = this.requireProfileTable();
      const profileId = request.profileId ?? randomUUID();
      const previous = table.get(profileId);
      if (request.profileId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-profile", `SSH resource "${profileId}" does not exist`) };
      }
      const now = new Date().toISOString();
      const groupId = request.groupId ?? null;
      if (groupId !== null && this.requireGroupTable().get(groupId) === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const record = {
        name: request.name.trim(),
        host: request.host.trim(),
        port: request.port ?? 22,
        username: request.username.trim(),
        authKind: request.authKind,
        groupId,
        createdAt: previous?.createdAt ?? now,
        updatedAt: now
      };
      await table.put(profileId, record);
      return {
        ok: true,
        value: {
          profile: await this.profilePublic(profileId, record),
          credentialRefs: profileCredentialRefs(profileId)
        }
      };
    } catch (error) {
      return { ok: false, error: fail("profile-save-failed", error.message) };
    }
  }

  async profileDelete(request) {
    try {
      const table = this.requireProfileTable();
      const record = table.get(request.profileId);
      if (record === undefined) return { ok: true, value: { deleted: false } };
      const refs = profileCredentialRefs(request.profileId);
      // Only names derived from this resource id are ever removed. A live SSH
      // transport keeps running; deletion only forgets future quick-connect.
      await Promise.all(Object.values(refs).map(async (ref) => await this.ctx.credentials.unset(credentialRef(ref))));
      await table.delete(request.profileId);
      return { ok: true, value: { deleted: true } };
    } catch (error) {
      return { ok: false, error: fail("profile-delete-failed", error.message) };
    }
  }

  async profileConnect(request) {
    try {
      const record = this.requireProfileTable().get(request.profileId);
      if (record === undefined) return { ok: false, error: fail("no-profile", `SSH resource "${request.profileId}" does not exist`) };

      // Idempotent: reuse the live connection for this profile (and drop stale
      // duplicates left by repeated Connect clicks before this guard).
      const { connections: live } = await this.ctx.ssh.list();
      const liveIds = new Set(live.map((c) => c.id));
      let existingId = null;
      for (const [id, meta] of [...this.connectionMeta.entries()]) {
        if (meta.profileId !== request.profileId) continue;
        if (!liveIds.has(id)) {
          this.connectionMeta.delete(id);
          continue;
        }
        if (existingId === null) {
          existingId = id;
          continue;
        }
        try { await this.ctx.ssh.disconnect(id); } catch { /* ignore */ }
        this.connectionMeta.delete(id);
      }
      if (existingId !== null) {
        this.ctx.ssh.setActive(existingId);
        this.activeConnectionId = existingId;
        const value = {
          connectionId: existingId,
          host: record.host,
          port: record.port,
          username: record.username,
          name: record.name
        };
        return { ok: true, value };
      }

      const refs = profileCredentialRefs(request.profileId);
      const primaryRef = record.authKind === "password" ? refs.password : refs.privateKey;
      const primary = await this.ctx.credentials.resolve(credentialRef(primaryRef));
      if (primary === undefined) {
        return { ok: false, error: fail("credential-missing", `SSH resource "${record.name}" has no saved ${record.authKind === "password" ? "password" : "private key"}`) };
      }
      const passphrase = record.authKind === "key"
        ? await this.ctx.credentials.resolve(credentialRef(refs.passphrase))
        : undefined;
      return await this.connectInternal({
        name: record.name,
        host: record.host,
        port: record.port,
        username: record.username,
        auth: record.authKind === "password"
          ? { kind: "password", password: primary.value }
          : { kind: "key", privateKey: primary.value, ...(passphrase === undefined ? {} : { passphrase: passphrase.value }) }
      }, request.profileId);
    } catch (error) {
      return { ok: false, error: fail("profile-connect-failed", error.message) };
    }
  }

  async groupList() {
    try {
      const groups = [...this.requireGroupTable().entries()]
        .map(([groupId, record]) => this.groupPublic(groupId, record))
        .sort((left, right) => left.name.localeCompare(right.name, "zh-Hans-CN"));
      return { ok: true, value: { groups } };
    } catch (error) {
      return { ok: false, error: fail("group-list-failed", error.message) };
    }
  }

  async groupSave(request) {
    try {
      const table = this.requireGroupTable();
      const groupId = request.groupId ?? randomUUID();
      const previous = table.get(groupId);
      if (request.groupId !== undefined && previous === undefined) {
        return { ok: false, error: fail("no-group", `SSH group "${groupId}" does not exist`) };
      }
      const name = request.name.trim();
      if ([...table.entries()].some(([id, group]) => id !== groupId && group.name.localeCompare(name, "zh-Hans-CN", { sensitivity: "accent" }) === 0)) {
        return { ok: false, error: fail("duplicate-group", `SSH group "${name}" already exists`) };
      }
      const now = new Date().toISOString();
      const record = { name, createdAt: previous?.createdAt ?? now, updatedAt: now };
      await table.put(groupId, record);
      return { ok: true, value: { group: this.groupPublic(groupId, record) } };
    } catch (error) {
      return { ok: false, error: fail("group-save-failed", error.message) };
    }
  }

  async groupDelete(request) {
    try {
      const groups = this.requireGroupTable();
      if (groups.get(request.groupId) === undefined) return { ok: true, value: { deleted: false, movedProfiles: 0 } };
      const profiles = this.requireProfileTable();
      let movedProfiles = 0;
      for (const [profileId, profile] of profiles.entries()) {
        if (profile.groupId !== request.groupId) continue;
        movedProfiles += 1;
        await profiles.put(profileId, { ...profile, groupId: null, updatedAt: new Date().toISOString() });
      }
      await groups.delete(request.groupId);
      return { ok: true, value: { deleted: true, movedProfiles } };
    } catch (error) {
      return { ok: false, error: fail("group-delete-failed", error.message) };
    }
  }

  async setActive(request) {
    try {
      const { connections } = await this.ctx.ssh.list();
      if (!connections.some((c) => c.id === request.connectionId)) {
        return { ok: false, error: fail("no-connection", `connection "${request.connectionId}" does not exist`) };
      }
      this.ctx.ssh.setActive(request.connectionId);
      this.activeConnectionId = request.connectionId;
      return { ok: true, value: { activeConnectionId: request.connectionId } };
    } catch (error) {
      return { ok: false, error: fail("set-active-failed", error.message) };
    }
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
}
